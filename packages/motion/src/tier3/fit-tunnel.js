// Parallax-tunnel fitter: the motion family behind "items fly toward the screen" heroes
// (floema.com's Images.worker is the reference specimen). The scene is a set of planes
// at fixed lateral positions, spread along z, all advancing toward the camera with one
// shared speed signal; planes that pass the camera wrap to the back of the pack, and a
// depth fade (fog) hides both ends. The FIT is therefore one global speed profile plus
// per-item constants — not 40 independent channel fits.
//
// Same doctrine as fit.js: deterministic, residual-is-confidence, and gating happens on
// the REGENERATED TRAJECTORY (replay z(t) under the fitted speed model vs the measured
// track), never on parameter distance.
import { nelderMead } from './nelder-mead.js';

const median = (arr) => {
  const v = [...arr].sort((a, b) => a - b);
  return v.length ? v[(v.length / 2) | 0] : null;
};

// Shared speed signal v(t): per-frame median of dz/dt across all items (items move in
// lockstep; the median is robust to wrap jumps and capture gaps).
export function speedSignal(tracks, { maxGapMs = 120, wrapJump = 20 } = {}) {
  const perT = new Map(); // rounded t -> speeds[]
  for (const tr of tracks) {
    const s = tr.samples;
    for (let i = 1; i < s.length; i++) {
      const dt = s[i].t - s[i - 1].t;
      if (!(dt > 0) || dt > maxGapMs) continue;
      const dz = s[i].z - s[i - 1].z;
      if (Math.abs(dz) > wrapJump) continue; // wrap teleport, not motion
      const key = Math.round(s[i].t / 20) * 20; // 20ms buckets
      if (!perT.has(key)) perT.set(key, []);
      perT.get(key).push((dz / dt) * 1000);
    }
  }
  return [...perT.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, speeds]) => ({ t, v: median(speeds), n: speeds.length }))
    .filter((p) => p.n >= 2);
}

// Idle speed: the mode of the speed histogram over spans untouched by any input.
// Scroll-linked speed HOLDS as long as the scroll position holds (measured on
// floema.com: 13+s at the boosted level, zero decay), so once the first input lands the
// rest of the recording is contaminated — idle comes from before it, minus spans where
// a later input returned progress to 0.
export function fitIdleSpeed(signal, inputs = [], { quietMs = 1500 } = {}) {
  let pool;
  if (inputs.length) {
    const first = inputs[0].t;
    const zeroReturns = inputs.filter((i) => (i.data?.options?.progress ?? i.data?.progress ?? null) === 0);
    pool = signal.filter(
      (p) =>
        p.t < first ||
        zeroReturns.some((z) => {
          const next = inputs.find((i) => i.t > z.t);
          return p.t > z.t + quietMs && (!next || p.t < next.t);
        }),
    );
  } else {
    pool = signal;
  }
  if (pool.length < 10) pool = signal;
  if (!pool.length) return null;
  // histogram mode with 2%-of-range bins (min 0.25 u/s)
  const vs = pool.map((p) => p.v);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const bin = Math.max(0.25, (hi - lo) / 50);
  const counts = new Map();
  for (const v of vs) {
    const k = Math.round(v / bin);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const around = vs.filter((v) => Math.abs(v - best[0] * bin) <= bin);
  return +median(around).toFixed(3);
}

// Intro burst: v(t) = idle + (v0 − idle) · 2^(−(t − t0)/half). Fit (v0, half) on the
// head of the signal where speed decays monotonically toward idle. t0 anchors at the
// first DRAW (start of rendering), not the first speed bucket — a speed sample needs two
// draws, so bucket-anchoring would systematically shift the curve by a frame.
export function fitIntroBurst(signal, idle, { t0: anchor = null } = {}) {
  if (!signal.length || idle == null) return null;
  const t0 = anchor ?? signal[0].t;
  // head = until speed first sits within 15% of idle for 3 consecutive buckets
  let end = signal.length;
  let run = 0;
  const tol = Math.max(1, Math.abs(idle) * 0.15);
  for (let i = 0; i < signal.length; i++) {
    run = Math.abs(signal[i].v - idle) < tol ? run + 1 : 0;
    if (run >= 3) { end = i - 2; break; }
  }
  const head = signal.slice(0, end).filter((p) => p.v > idle);
  if (head.length < 5) return null;
  const vPeak = Math.max(...head.map((p) => p.v));
  const evalParams = ([lv0, lhalf]) => {
    const v0 = Math.exp(lv0);
    const half = Math.exp(lhalf);
    let sum = 0;
    for (const p of head) {
      const pred = idle + (v0 - idle) * Math.pow(2, -(p.t - t0) / half);
      sum += (pred - p.v) ** 2;
    }
    return Math.sqrt(sum / head.length) / (vPeak - idle || 1);
  };
  let best = null;
  for (const init of [[Math.log(vPeak * 1.5), Math.log(200)], [Math.log(vPeak * 3), Math.log(100)], [Math.log(vPeak * 2), Math.log(400)]]) {
    const r = nelderMead(evalParams, init, { maxIterations: 300 });
    if (!best || r.score < best.score) best = r;
  }
  return {
    v0: +Math.exp(best.params[0]).toFixed(1),
    halfLifeMs: +Math.exp(best.params[1]).toFixed(1),
    t0: +t0.toFixed(1),
    nrmse: +best.score.toFixed(4),
  };
}

// Scroll speed law: v(p) = idle + span · (1 − 2^(−k·p)) — a PERSISTENT progress-linked
// speed level, not a decaying burst (measured on floema.com: speed holds at its boosted
// level for 13+ seconds at constant scroll, and the held levels across progress values
// sit exactly on an expo-out curve). Each held-progress span contributes one (p, v)
// point; the law is fitted through them plus the anchor (0, idle). With <2 held levels
// the law is under-determined and the raw points are reported instead — loudly, not
// silently.
export function fitScrollSpeedLaw(signal, inputs, idle) {
  if (!inputs.length || idle == null) return null;
  const progressOf = (i) => {
    const p = i.data?.options?.progress ?? i.data?.progress;
    return typeof p === 'number' && isFinite(p) ? p : null;
  };
  // held spans: from 300ms after each input until the next input (or +6s)
  const points = [];
  for (let i = 0; i < inputs.length; i++) {
    const p = progressOf(inputs[i]);
    if (p == null) continue;
    const from = inputs[i].t + 300;
    const to = Math.min(i + 1 < inputs.length ? inputs[i + 1].t : Infinity, inputs[i].t + 6000);
    const span = signal.filter((s) => s.t >= from && s.t < to);
    if (span.length < 5) continue;
    const vs = span.map((s) => s.v);
    const v = median(vs);
    const spread = Math.sqrt(vs.reduce((a, x) => a + (x - v) ** 2, 0) / vs.length);
    if (spread > Math.max(2, Math.abs(v) * 0.15)) continue; // not settled — transition span
    points.push({ p, v: +v.toFixed(2), n: span.length });
  }
  // dedup by progress level (keep the longest-observed)
  const byP = new Map();
  for (const pt of points) {
    const k = pt.p.toFixed(3);
    if (!byP.has(k) || byP.get(k).n < pt.n) byP.set(k, pt);
  }
  const held = [...byP.values()].sort((a, b) => a.p - b.p);
  if (!held.length) return null;
  const span0 = Math.max(...held.map((h) => h.v)) - idle;
  if (span0 < Math.max(1, Math.abs(idle) * 0.3)) return null; // no meaningful coupling
  if (held.length < 2) {
    return { form: 'held-points', points: held, idle, note: 'single held level — law under-determined' };
  }
  const all = [{ p: 0, v: idle, n: 1 }, ...held];
  const evalParams = ([lspan, lk]) => {
    const span = Math.exp(lspan);
    const k = Math.exp(lk);
    let sum = 0;
    for (const pt of all) {
      const pred = idle + span * (1 - Math.pow(2, -k * pt.p));
      sum += (pred - pt.v) ** 2;
    }
    return Math.sqrt(sum / all.length) / (span0 || 1);
  };
  let best = null;
  for (const init of [[Math.log(span0), Math.log(6)], [Math.log(span0 * 1.5), Math.log(2)], [Math.log(span0), Math.log(12)]]) {
    const r = nelderMead(evalParams, init, { maxIterations: 300 });
    if (!best || r.score < best.score) best = r;
  }
  return {
    form: 'expo-out',
    span: +Math.exp(best.params[0]).toFixed(2),
    k: +Math.exp(best.params[1]).toFixed(3),
    points: held,
    nrmse: +best.score.toFixed(4),
  };
}

// Wraps: teleports opposite to the flow direction. wrapLength should equal the tunnel
// depth (itemCount × spacing) — reported so the gate can cross-check it.
export function detectWraps(tracks, { wrapJump = 20 } = {}) {
  const jumps = [];
  let zAtWrap = [];
  for (const tr of tracks) {
    const s = tr.samples;
    for (let i = 1; i < s.length; i++) {
      const dz = s[i].z - s[i - 1].z;
      if (Math.abs(dz) > wrapJump && s[i].t - s[i - 1].t < 400) {
        jumps.push(Math.abs(dz));
        zAtWrap.push(s[i - 1].z);
      }
    }
  }
  if (!jumps.length) return null;
  return {
    count: jumps.length,
    length: +median(jumps).toFixed(2),
    atZ: +median(zAtWrap).toFixed(2),
  };
}

// z(t) of one track at an instant, interpolated; refuses to bridge wraps or pauses.
function zAtTime(tr, t) {
  const s = tr.samples;
  if (t < s[0].t || t > s[s.length - 1].t) return null;
  for (let i = 1; i < s.length; i++) {
    if (s[i].t >= t) {
      if (Math.abs(s[i].z - s[i - 1].z) > 20) return null; // wrap inside the span
      if (s[i].t - s[i - 1].t > 300) return null; // renderer paused across the span
      const p = (t - s[i - 1].t) / (s[i].t - s[i - 1].t || 1);
      return s[i - 1].z + (s[i].z - s[i - 1].z) * p;
    }
  }
  return null;
}

// neighbour spacing at one instant (median gap of the sorted z snapshot)
export function spacingAt(tracks, t) {
  const zs = tracks.map((tr) => zAtTime(tr, t)).filter((z) => z != null).sort((a, b) => a - b);
  if (zs.length < 3) return null;
  const gaps = zs.slice(1).map((z, i) => z - zs[i]).filter((g) => g > 0.05);
  return gaps.length ? median(gaps) : null;
}

// Layout constants: ring radius (median lateral distance), z spacing (median gap between
// neighbours in one frame), scales.
export function fitLayout(tracks) {
  const radii = tracks.map((tr) => Math.hypot(tr.x, tr.y));
  const radius = median(radii);
  const radiusSpread = Math.max(...radii) - Math.min(...radii);
  // spacing: interpolate every track's z at shared reference instants (samples are
  // draw-timed, so same-bucket samples straddle frames — direct diffs measure frame
  // jitter, not layout). Median across several probe instants.
  const tMin = Math.min(...tracks.map((tr) => tr.samples[0].t));
  const tMax = Math.max(...tracks.map((tr) => tr.samples[tr.samples.length - 1].t));
  const spacings = [];
  for (let k = 1; k <= 5; k++) {
    const s = spacingAt(tracks, tMin + ((tMax - tMin) * k) / 6);
    if (s != null) spacings.push(s);
  }
  const spacing = spacings.length ? +median(spacings).toFixed(3) : null;
  return {
    itemCount: tracks.length,
    radius: radius != null ? +radius.toFixed(3) : null,
    radiusSpread: +radiusSpread.toFixed(3),
    spacing,
    items: tracks.map((tr) => ({
      id: tr.id,
      x: +tr.x.toFixed(3),
      y: +tr.y.toFixed(3),
      sx: +tr.sx.toFixed(3),
      sy: +tr.sy.toFixed(3),
      tex: tr.tex,
      angle: +((Math.atan2(tr.y, tr.x) * 180) / Math.PI).toFixed(1),
    })),
  };
}

// Replay the fitted speed model into z(t) and score it against a measured track —
// the regenerated-curve gate, wrap-aware (each wrap re-anchors the integrator: wraps
// are position resets, and a model scored across one accumulates a constant offset
// that measures nothing). The model claims to reproduce the trajectory GIVEN the same
// inputs, so the recorded input schedule drives the fitted speed law during replay
// (progress is a step function of the inputs; the engine's own smoothing between levels
// is shorter than a couple of frames in every measurement, so steps suffice here).
export function replayNrmse(track, model, { wrapJump = 20, inputs = [] } = {}) {
  const s = track.samples;
  if (s.length < 6) return null;
  const idle = model.speed.idle ?? 0;
  const law = model.speed.scroll;
  const schedule = law
    ? inputs
        .map((i) => ({ t: i.t, p: i.data?.options?.progress ?? i.data?.progress }))
        .filter((i) => typeof i.p === 'number' && isFinite(i.p))
        .sort((a, b) => a.t - b.t)
    : [];
  const lawV = (p) => {
    if (!law) return idle;
    if (law.form === 'expo-out') return idle + law.span * (1 - Math.pow(2, -law.k * p));
    // held-points fallback: nearest known level
    const pt = law.points.reduce((a, b) => (Math.abs(b.p - p) < Math.abs(a.p - p) ? b : a));
    return pt.v;
  };
  const v = (t) => {
    let speed = idle;
    if (model.speed.intro && t - model.speed.intro.t0 >= 0) {
      const { v0, halfLifeMs, t0 } = model.speed.intro;
      speed += (v0 - idle) * Math.pow(2, -(t - t0) / halfLifeMs);
    }
    if (schedule.length) {
      // last input at or before t (lo converges on it; −1 = none yet)
      let lo = -1;
      let hi = schedule.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (schedule[mid].t <= t) lo = mid;
        else hi = mid - 1;
      }
      if (lo >= 0) speed += lawV(schedule[lo].p) - idle;
    }
    return speed;
  };
  let z = s[0].z;
  let sum = 0;
  let n = 0;
  const zRange = Math.max(...s.map((x) => x.z)) - Math.min(...s.map((x) => x.z)) || 1;
  for (let i = 1; i < s.length; i++) {
    const dt = s[i].t - s[i - 1].t;
    if (!(dt > 0) || dt > 200) { z = s[i].z; continue; }
    if (Math.abs(s[i].z - s[i - 1].z) > wrapJump) { z = s[i].z; continue; }
    // integrate with the midpoint speed
    z += (v((s[i].t + s[i - 1].t) / 2) * dt) / 1000;
    sum += (z - s[i].z) ** 2;
    n++;
  }
  if (!n) return null;
  return Math.sqrt(sum / n) / zRange;
}

export function confidence(nrmse) {
  if (nrmse == null) return 0;
  return +Math.min(1, Math.max(0, 1 - 5 * nrmse)).toFixed(3);
}

// End-to-end: tracks (+ optional page→Web Worker inputs) → tunnel model + replay confidence.
export function fitTunnel({ tracks, inputs = [], projection = null, fog = null, canvases = [] }) {
  const warnings = [];
  if (tracks.length < 3) {
    return { ok: false, warnings: [`only ${tracks.length} track(s) — not a tunnel field`] };
  }
  const signal = speedSignal(tracks);
  if (signal.length < 10) {
    return { ok: false, warnings: [`speed signal too sparse (${signal.length} buckets)`] };
  }
  // scroll-shaped inputs only (generic: any input whose data mentions progress/scroll)
  const scrollInputs = inputs.filter((i) => {
    const s = JSON.stringify(i.data ?? {});
    return /scroll|progress/i.test(s);
  });
  const idle = fitIdleSpeed(signal, scrollInputs);
  const tFirstDraw = Math.min(...tracks.map((tr) => tr.samples[0].t));
  const intro = fitIntroBurst(signal, idle, { t0: tFirstDraw });
  const scroll = fitScrollSpeedLaw(signal, scrollInputs, idle);
  if (scroll?.form === 'held-points') {
    warnings.push('scroll coupling detected at a single held progress level — speed law under-determined, replay uses the raw held level');
  }
  const wraps = detectWraps(tracks);
  const layout = fitLayout(tracks);

  // the tunnel's depth spread can itself be scroll-linked (measured on floema.com:
  // spacing 2.0 at p=0 stretching to ~2.42 at p=1) — probe it at rest before any input
  // and at each held-progress span
  if (scrollInputs.length) {
    const probes = [];
    const first = scrollInputs[0].t;
    const preSpan = spacingAt(tracks, Math.min(...tracks.map((tr) => tr.samples[0].t)) + Math.max(0, (first - Math.min(...tracks.map((tr) => tr.samples[0].t))) * 0.7));
    if (preSpan != null) probes.push({ p: 0, spacing: +preSpan.toFixed(3) });
    for (let i = 0; i < scrollInputs.length; i++) {
      const p = scrollInputs[i].data?.options?.progress ?? scrollInputs[i].data?.progress;
      if (typeof p !== 'number') continue;
      const from = scrollInputs[i].t + 500;
      const to = i + 1 < scrollInputs.length ? scrollInputs[i + 1].t : from + 3000;
      if (to - from < 400) continue;
      const s = spacingAt(tracks, (from + to) / 2);
      if (s != null) probes.push({ p, spacing: +s.toFixed(3) });
    }
    if (probes.length >= 2 && Math.max(...probes.map((x) => x.spacing)) - Math.min(...probes.map((x) => x.spacing)) > layout.spacing * 0.05) {
      layout.spacingByProgress = probes;
    }
  }

  if (wraps && layout.spacing) {
    const expected = layout.itemCount * layout.spacing;
    if (Math.abs(wraps.length - expected) / expected > 0.15) {
      warnings.push(`wrap length ${wraps.length} ≠ itemCount×spacing ${expected.toFixed(1)} — layout may be under-sampled`);
    }
  }

  const model = {
    kind: 'parallax-tunnel',
    layout,
    speed: { idle, intro, scroll },
    wrap: wraps,
    fog,
    camera: { projection },
  };

  // replay gate on every track; report the distribution, gate on the median
  const scores = tracks.map((tr) => replayNrmse(tr, model, { inputs: scrollInputs })).filter((x) => x != null);
  const medNrmse = scores.length ? median(scores) : null;
  const worst = scores.length ? Math.max(...scores) : null;
  return {
    ok: idle != null && layout.spacing != null,
    model,
    replay: {
      tracksScored: scores.length,
      medianNrmse: medNrmse != null ? +medNrmse.toFixed(4) : null,
      worstNrmse: worst != null ? +worst.toFixed(4) : null,
      confidence: confidence(medNrmse),
    },
    warnings,
  };
}
