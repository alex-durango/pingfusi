import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchSession } from '../capture/session.js';
import { SAMPLER_SOURCE } from '../tier3/sampler.js';
import { buildReplayPage } from './replay-page.js';
import { buildAdjustPage } from './adjust-page.js';
import { composeControls } from './compose-controls.js';
import { evalFitAt } from './eval-fit.js';
import { DIAGNOSIS_VOCABULARY, applyDiagnosis } from './nudge.js';
import { readJson, writeArtifact } from '../lib/artifacts.js';
import { remuxSeekable, transcodeMp4 } from '../lib/video.js';

// Phase 4 convergence loop (docs/PLAN.md):
//   deterministic pass — replay the fitted model in a real browser next to a verbatim
//   trace playback of the SAME stand-in element, re-sample both with the Tier 3 sampler,
//   numeric-diff the traces. Catches emit bugs and bad fits without remote review.
//   review pass — the bundle (player + two videos + review-task.json) is handed to
//   the review service by the agent layer; answers map back via applyRound(). The transport
//   stays out of this file on purpose (thin integration).

const CHANNELS = ['tx', 'ty', 'sx', 'sy', 'rot', 'opacity'];
const MIN_RANGE = { tx: 1, ty: 1, sx: 0.02, sy: 0.02, rot: 0.5, opacity: 0.02 };
// linkage fits are driven by live input (scroll position, pointer), not time — they have
// no standalone replay, so Phase 4 bundles exclude them like scroll-linear always was
const NON_REPLAYABLE = new Set(['scroll-linear', 'pointer-follow']);
export const CONFIDENCE_THRESHOLD = 0.85; // below this, the fit requests a review round (endogenous trigger)

export function rebase(samples) {
  const t0 = samples[0].t;
  return samples.map((s) => ({ ...s, t: +(s.t - t0).toFixed(1) }));
}

// Recorded traces carry the original page's trigger→first-write latency as a leading
// plateau. The bundle compares motion shape with delays zeroed, so trim to onset —
// otherwise the model starts moving ~30ms before the trace does and eats a diff penalty
// that has nothing to do with fit quality.
export function trimToOnset(samples) {
  let onsetIdx = samples.length;
  for (const ch of CHANNELS) {
    const vals = samples.map((s) => s[ch]).filter((v) => typeof v === 'number');
    if (vals.length < 4) continue;
    const range = Math.max(...vals) - Math.min(...vals);
    if (range < MIN_RANGE[ch]) continue;
    const v0 = samples[0][ch];
    const idx = samples.findIndex((s) => Math.abs(s[ch] - v0) > range * 0.01);
    if (idx > 0) onsetIdx = Math.min(onsetIdx, idx);
  }
  if (onsetIdx === samples.length || onsetIdx <= 0) return rebase(samples);
  return rebase(samples.slice(onsetIdx)); // start AT the first moving sample
}

// Real pages hitch (long frame right after the trigger), so recorded motion often starts
// mid-flight: the trace's first sample sits partway along the curve while the model
// starts from rest. Align clocks by solving for the model time whose value matches the
// trace's first sample on the dominant channel — a comparison alignment, not a change to
// the candidate animation itself. (Fitting velocity/shift properly is task #12.)
export function computeClockShift(samples, fits) {
  let dominant = null;
  for (const f of fits) {
    if (f.fit.kind !== 'spring' && f.fit.kind !== 'tween') continue;
    const range = Math.abs(f.fit.valueTo - f.fit.valueFrom);
    if (!dominant || range > dominant.range) dominant = { ...f, range };
  }
  if (!dominant || dominant.range < 1) return 0;
  const v0 = samples[0][dominant.channel];
  if (typeof v0 !== 'number' || Math.abs(v0 - dominant.fit.valueFrom) < dominant.range * 0.02) return 0;
  let bestT = 0;
  let bestErr = Infinity;
  for (let t = 0; t <= 400; t++) {
    const err = Math.abs(evalFitAt(dominant.fit, t) - v0);
    if (err < bestErr) {
      bestErr = err;
      bestT = t;
    }
  }
  return bestT;
}

function lerpAt(series, ch, t) {
  if (t <= series[0].t) return series[0][ch];
  const last = series[series.length - 1];
  if (t >= last.t) return last[ch];
  let lo = 0;
  let hi = series.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = series[lo];
  const b = series[hi];
  const p = (t - a.t) / (b.t - a.t || 1);
  return a[ch] + (b[ch] - a[ch]) * p;
}

// Per-channel diff of the model playback vs the verbatim trace playback, measured over
// the channel's ACTIVE window only — a long settled tail would otherwise dilute the
// error and let a visibly-wrong candidate slide under the threshold.
export function diffSeries(traceS, modelS, loopMs) {
  const channels = {};
  let maxNrmse = 0;
  let maxPeak = 0;
  for (const ch of CHANNELS) {
    const A = traceS.filter((s) => s.t <= loopMs && typeof s[ch] === 'number');
    if (A.length < 4) continue;
    const vals = A.map((s) => s[ch]);
    const range = Math.max(...vals) - Math.min(...vals);
    if (range < MIN_RANGE[ch]) continue; // channel didn't move
    const final = vals[vals.length - 1];
    let lastMove = A[0].t;
    for (const s of A) {
      if (Math.abs(s[ch] - final) > Math.max(range * 0.02, MIN_RANGE[ch] * 0.5)) lastMove = s.t;
    }
    const W = A.filter((s) => s.t <= lastMove + 150);
    if (W.length < 4) continue;
    let sum = 0;
    let peak = 0;
    for (const s of W) {
      const d = Math.abs(lerpAt(modelS, ch, s.t) - s[ch]);
      sum += d * d;
      peak = Math.max(peak, d);
    }
    const nrmse = +(Math.sqrt(sum / W.length) / range).toFixed(4);
    const peakRatio = +(peak / range).toFixed(4);
    channels[ch] = { nrmse, peak: peakRatio, activeMs: Math.round(lastMove) };
    maxNrmse = Math.max(maxNrmse, nrmse);
    maxPeak = Math.max(maxPeak, peakRatio);
  }
  return { channels, maxNrmse, maxPeak };
}

export function pickElement(traceData, fitsData, elementPath) {
  const byPath = new Map();
  for (const f of fitsData.fits) {
    if (!byPath.has(f.path)) byPath.set(f.path, []);
    byPath.get(f.path).push(f);
  }
  let path = elementPath;
  if (!path) {
    // endogenous trigger: the element whose worst fit is least confident
    let best = null;
    for (const [p, fs] of byPath) {
      const timeFits = fs.filter((x) => !NON_REPLAYABLE.has(x.fit.kind));
      if (!timeFits.length) continue;
      const minConf = Math.min(...timeFits.map((x) => x.fit.confidence));
      if (!best || minConf < best.minConf) best = { p, minConf };
    }
    if (!best) throw new Error('no time-based fits to loop on');
    path = best.p;
  }
  const fitsForPath = (byPath.get(path) || []).filter((x) => !NON_REPLAYABLE.has(x.fit.kind));
  if (!fitsForPath.length) throw new Error(`no time-based fits for element ${path}`);
  const element = traceData.elements.find((e) => e.path === path);
  if (!element) throw new Error(`element ${path} not found in trace.json`);
  return {
    element,
    fits: fitsForPath.map((x) => ({ channel: x.channel, fit: x.fit })),
    minConfidence: Math.min(...fitsForPath.map((x) => x.fit.confidence)),
  };
}

async function samplePages(pages, loopMs, headless) {
  const { browser, page } = await launchSession({ headless });
  const series = {};
  try {
    await page.addInitScript({ content: SAMPLER_SOURCE });
    // start sampling at document start, before the page's first animation frame
    await page.addInitScript({ content: 'window.__mkTrace && window.__mkTrace.start(8);' });
    for (const [mode, fileUrl] of Object.entries(pages)) {
      await page.goto(fileUrl);
      await page.waitForTimeout(loopMs + 700);
      const data = await page.evaluate(() => {
        window.__mkTrace.stop();
        return window.__mkTrace.collect();
      });
      const el = data.elements[0];
      if (!el) throw new Error(`no motion sampled on the ${mode} page`);
      series[mode] = rebase(el.samples);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return series;
}

// outBase without extension — writes outBase.webm AND outBase.mp4 (iOS can't decode VP8;
// Playwright's Chromium can't decode H.264; the player offers both as <source>s)
async function recordPage(fileUrl, outBase, ms, headless) {
  const tmp = `${outBase}.videotmp`;
  const { browser, context, page } = await launchSession({ headless, videoDir: tmp });
  try {
    await page.goto(fileUrl);
    await page.waitForTimeout(ms);
    const video = page.video();
    await context.close();
    if (video) {
      await video.saveAs(`${outBase}.webm`);
      await remuxSeekable(`${outBase}.webm`);
      await transcodeMp4(`${outBase}.webm`, `${outBase}.mp4`);
    }
  } finally {
    await browser.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Build (or rebuild, after a nudge) the full round bundle: pages, deterministic diff,
// videos, player, review-task.json, loop-state.json. Every round appends to
// loop-log.jsonl — the flywheel training record.
export async function buildBundle({ dir, look, samples, fits, loopMs, round, headless = true, minConfidence = null }) {
  mkdirSync(dir, { recursive: true });
  const clockShiftMs = computeClockShift(samples, fits);
  const pages = {};
  for (const mode of ['trace', 'model']) {
    const html = buildReplayPage({ look, samples, fits, mode, loopMs, clockShiftMs });
    const p = join(dir, `${mode}.html`);
    writeFileSync(p, html);
    pages[mode] = pathToFileURL(resolve(p)).href;
  }
  // the adjust panel is composed per round from the AI's current uncertainty (+ any
  // stall signal from prior diagnosis rounds in this bundle's log)
  let diagnosisRounds = 0;
  try {
    diagnosisRounds = readFileSync(join(dir, 'loop-log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((l) => l.event === 'review-diagnosis').length;
  } catch {}
  const controlPanel = composeControls({ fits, samples, loopMs, diagnosisRounds });
  writeFileSync(join(dir, 'adjust.html'), buildAdjustPage({ look, samples, fits, loopMs, clockShiftMs, controlPanel }));

  const series = await samplePages(pages, loopMs, headless);
  const { channels: channelDiffs, maxNrmse, maxPeak } = diffSeries(series.trace, series.model, loopMs);

  const videoMs = Math.min(3 * (loopMs + 400), 9000);
  await recordPage(pages.trace, join(dir, 'trace'), videoMs, headless);
  await recordPage(pages.model, join(dir, 'model'), videoMs, headless);
  copyFileSync(fileURLToPath(new URL('../../player/compare.html', import.meta.url)), join(dir, 'player.html'));
  // The existing hosted-draft transport requires a root index.html. Keep it byte-identical
  // to the player so a convergence bundle can be published as immutable static evidence;
  // the typed review still opens the mode-specific player URL from review-task.json.
  copyFileSync(fileURLToPath(new URL('../../player/compare.html', import.meta.url)), join(dir, 'index.html'));

  // deterministic seed → decodable LEFT/RIGHT; diagnose page must NOT swap (its copy
  // says LEFT is the original), so it uses an even seed
  const seed = (round * 7919 + samples.length) % 1000000;
  const swap = seed % 2 === 1;
  const reviewTask = {
    // versioned + extensible on purpose: a future expert tier is a NEW question_type with
    // a richer payload, added without reworking this default anyone-with-eyes-and-30s flow
    schema: 'motion-kit/review-task@1',
    question_type: '2afc',
    round,
    assets: ['trace.mp4', 'trace.webm', 'model.mp4', 'model.webm'],
    response: {
      '2afc': "one of: LEFT | RIGHT | can't tell",
      diagnosis: 'a vocabulary tag, optionally time-anchored: "<tag> @ <seconds>s"',
      adjust:
        '"matched: <param>=<value>, …" (final slider values) or "no-match: …" (wrong model class → route to diagnosis/refit, do NOT widen ranges); slider trajectory in window.__mkAdjust',
    },
    // comma lists = <source> alternatives; mp4 first for iOS, webm for codec-free Chromium
    player: `player.html?a=trace.mp4,trace.webm&b=model.mp4,model.webm&seed=${seed}&mode=2afc`,
    diagnosePlayer: `player.html?a=trace.mp4,trace.webm&b=model.mp4,model.webm&seed=${seed - (seed % 2)}&mode=diagnose`,
    adjustPlayer: 'adjust.html',
    controls: controlPanel, // UI-as-data: the schema the adjust page renders
    vocabulary: DIAGNOSIS_VOCABULARY,
    seed,
    // Everything a native reviewer client needs to render all
    // three task types from data instead of videos: identical stand-in on both sides,
    // trace playback vs live model evaluation, perfect sync, no codec dependencies.
    motion: {
      schema: 'motion-kit/motion@1',
      look,
      samples,
      // flattened per-channel fits — the same shape the replay/adjust pages embed
      fits: fits.map((f) => ({ channel: f.channel, ...f.fit })),
      loopMs,
      pauseMs: 400,
      clockShiftMs,
    },
    // adjust is a 1-3 minute task — price/route it as a heavier tier than the 30s pings
    effort: { '2afc': '~30s', diagnosis: '~30s', adjust: '1-3min (heavier tier)' },
    // adjust-first doctrine (2026-07-18): the reviewer is the product owner — blinded
    // 2AFC stays available (--mode 2afc) but is never routed by default or required
    escalation:
      'adjust is the default round for fitted bundles; diagnosis for single-param errors; 2AFC only on explicit request (--mode 2afc), never routed by default',
    validation:
      'adjustment applies directly: the numeric replay gate on the rebuilt bundle certifies convergence; a "no-match" answer routes to diagnosis/refit instead',
    stopCriteria:
      '"matched" + the rebuilt bundle passing the numeric replay gate → converged (done); "no-match" → diagnose/refit; an optional blinded check via the 2afc player remains available on request',
  };
  writeArtifact(dir, 'review-task.json', reviewTask);
  writeArtifact(dir, 'loop-state.json', {
    round,
    loopMs,
    clockShiftMs,
    look,
    samples,
    fits,
    minConfidence,
    seed,
    // ground truth stays AGENT-side: review-task.json is reviewer-facing and must never
    // reveal which side is the original
    sideMapping: swap ? { LEFT: 'model', RIGHT: 'trace' } : { LEFT: 'trace', RIGHT: 'model' },
    deterministic: { channelDiffs, maxNrmse, maxPeak },
    pingNeeded: minConfidence != null ? minConfidence < CONFIDENCE_THRESHOLD : null,
  });
  appendFileSync(
    join(dir, 'loop-log.jsonl'),
    JSON.stringify({
      event: 'deterministic-pass',
      ts: new Date().toISOString(),
      round,
      fits: fits.map((f) => ({
        channel: f.channel,
        kind: f.fit.kind,
        transition: f.fit.transition,
        ...(f.fit.params ? { params: f.fit.params } : {}), // marquee-class fits log their params
        delayMs: f.fit.delayMs,
      })),
      channelDiffs,
      maxNrmse,
      maxPeak,
    }) + '\n',
  );
  return { dir, channelDiffs, maxNrmse, maxPeak, reviewTask };
}

export async function runLoop({ traceDir, elementPath, out, headless = true }) {
  const traceData = readJson(join(traceDir, 'trace.json'));
  const fitsData = readJson(join(traceDir, 'fits.json'));
  const chosen = pickElement(traceData, fitsData, elementPath);
  // The bundle compares MOTION SHAPE: trace playback is rebased to its first sample, so
  // the model must start at 0 too. The fit's delayMs is original-page trigger latency —
  // meaningful for export/stagger, but inside the bundle it would just lag the candidate.
  const bundleFits = chosen.fits.map(({ channel, fit }) => {
    const f = structuredClone(fit);
    f.delayMs = 0;
    if (f.transition) delete f.transition.delay;
    return { channel, fit: f };
  });
  const rebased = rebase(chosen.element.samples);
  const marqueeFits = chosen.fits.filter((x) => x.fit.kind === 'marquee');
  let samples;
  if (marqueeFits.length && marqueeFits.length === chosen.fits.length) {
    // Marquee bundles compare the STEADY regime: real rails open with a wild init
    // transient (mindmarket: ±18k px inside 400ms) that is an artifact of the rail's
    // init, not motion the constant-velocity model should be judged against. The fit
    // recorded the steady onset in the trace clock; trim the trace playback to it.
    const t0raw = chosen.element.samples[0].t;
    const startAt = Math.max(0, ...marqueeFits.map((x) => (x.fit.steadyStartMs ?? 0) - t0raw));
    const sliced = rebased.filter((s) => s.t >= startAt);
    samples = sliced.length >= 8 ? rebase(sliced) : trimToOnset(rebased);
  } else {
    samples = trimToOnset(rebased);
  }
  const loopMs = Math.min(Math.max(600, Math.round(samples[samples.length - 1].t)), 4500);
  const dir = out || join(traceDir, 'phase4');
  const res = await buildBundle({
    dir,
    look: chosen.element.look,
    samples,
    fits: bundleFits,
    loopMs,
    round: 1,
    headless,
    minConfidence: chosen.minConfidence,
  });
  return { ...res, element: chosen.element.path, loopMs, minConfidence: chosen.minConfidence, pingNeeded: chosen.minConfidence < CONFIDENCE_THRESHOLD };
}

// Apply a review diagnosis answer and rebuild the bundle as the next round.
export async function applyRound({ bundleDir, answer, headless = true }) {
  const state = readJson(join(bundleDir, 'loop-state.json'));
  const nudged = [];
  const notes = [];
  for (const f of state.fits) {
    const { fit, note } = applyDiagnosis(f.fit, answer);
    nudged.push({ channel: f.channel, fit });
    if (note.changed) notes.push({ channel: f.channel, ...note });
  }
  appendFileSync(
    join(bundleDir, 'loop-log.jsonl'),
    JSON.stringify({ event: 'review-diagnosis', ts: new Date().toISOString(), round: state.round, answer, notes }) + '\n',
  );
  const res = await buildBundle({
    dir: bundleDir,
    look: state.look,
    samples: state.samples,
    fits: nudged,
    loopMs: state.loopMs,
    round: state.round + 1,
    headless,
    minConfidence: state.minConfidence,
  });
  return { ...res, round: state.round + 1, notes };
}

// Apply an adjust-round result: set the reviewer's final slider params on the fits and
// rebuild as the next round. Adjust-first doctrine (2026-07-18): the reviewer is the
// product owner — the applied result plus the rebuilt bundle's numeric replay gate
// certifies convergence; a blinded 2AFC remains available only on explicit request.
export async function applyAdjust({ bundleDir, params, trajectory = null, headless = true }) {
  const state = readJson(join(bundleDir, 'loop-state.json'));
  const applied = [];
  for (const [id, value] of Object.entries(params)) {
    const dotIdx = id.lastIndexOf('.');
    const channel = id.slice(0, dotIdx);
    const key = id.slice(dotIdx + 1);
    const f = state.fits.find((x) => x.channel === channel);
    if (!f || typeof value !== 'number') continue;
    if (key === 'delayMs') {
      // hypothesis probe outside the fitted model — flags a possible model-class revision
      f.fit.delayMs = value;
      applied.push({ id, value, hypothesis: true });
    } else if (typeof f.fit.transition?.[key] === 'number') {
      f.fit.transition[key] = value;
      applied.push({ id, value });
    } else if (typeof f.fit.params?.[key] === 'number') {
      // marquee-class fits: params live beside (not inside) transition; the direction
      // toggle is a sign, so anything the wire delivers snaps to ±1
      const v = key === 'direction' ? (value < 0 ? -1 : 1) : value;
      f.fit.params[key] = v;
      applied.push({ id, value: v });
    }
  }
  if (!applied.length) throw new Error('no adjustable params matched the current fits');
  appendFileSync(
    join(bundleDir, 'loop-log.jsonl'),
    JSON.stringify({
      event: 'review-adjust',
      ts: new Date().toISOString(),
      round: state.round,
      applied,
      modelRevisionHint: applied.some((a) => a.hypothesis && a.value !== 0),
      trajectory, // full timestamped search path — flywheel training data
    }) + '\n',
  );
  const res = await buildBundle({
    dir: bundleDir,
    look: state.look,
    samples: state.samples,
    fits: state.fits,
    loopMs: state.loopMs,
    round: state.round + 1,
    headless,
    minConfidence: state.minConfidence,
  });
  return {
    ...res,
    round: state.round + 1,
    applied,
    validation:
      'the numeric replay gate on this rebuilt bundle certifies convergence (check maxNrmse/maxPeak); a blinded 2AFC is opt-in via --mode 2afc, never required',
  };
}

// Record the terminal review verdict (2AFC converged / accepted / gave up) in the log.
export function recordVerdict({ bundleDir, verdict, detail = null }) {
  const state = readJson(join(bundleDir, 'loop-state.json'));
  appendFileSync(
    join(bundleDir, 'loop-log.jsonl'),
    JSON.stringify({ event: 'verdict', ts: new Date().toISOString(), round: state.round, verdict, detail }) + '\n',
  );
}
