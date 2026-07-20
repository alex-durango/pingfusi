import { capture } from './capture/capture.js';
import { runGate } from './replay/gate.js';
import { runExport } from './export/export.js';
import { runExportFits } from './export/export-fits.js';
import { runExportTunnel } from './export/export-tunnel.js';
import { runExportDisplacement } from './export/export-displacement.js';
import { existsSync } from 'node:fs';
import { trace, refit } from './tier3/trace.js';
import { runLoop, applyRound, applyAdjust } from './loop/loop.js';
import { serveDir, startTunnel } from './loop/serve.js';
import { readJson } from './lib/artifacts.js';
import { resolve } from 'node:path';
import { buildLinkedComparison } from './linked/builder.js';

const COMMAND = process.env.PPK_ENTRY === '1' ? 'pingfusi motion' : 'motion-kit';

const USAGE = `${COMMAND} — copy animations from live sites into a reusable library

Usage:
  ${COMMAND} capture <url> [--trigger <spec>] [--out <dir>] [--observe <ms>] [--headed] [--all]
  ${COMMAND} gate <captureDir> [--headed]
  ${COMMAND} export <captureDir|traceDir> [--out <libraryDir>] [--min-confidence <0..1>]
      capture dirs export verbatim entries; trace dirs export Tier 3 fitted entries
      (Motion values+transition per channel; low-confidence channels skipped loudly)
  ${COMMAND} trace <url> [--trigger <spec>] [--scope <selector>] [--out <dir>] [--observe <ms>] [--headed]
      Tier 3: sample rAF/JS-driven motion (invisible to CDP) and fit motion models
      [--scope <selector>] reserve the trace budget for one element/section; use this
      on mutation-heavy pages so unrelated motion cannot crowd out the requested effect
      [--gl] also tap WebGL draw calls (main-thread canvases AND
      OffscreenCanvas workers) and fit canvas-rendered motion — writes
      gl-trace.json + gl-fits.json
      [--block <sub1,sub2>] abort requests whose URL contains a substring
      (consent banners, trackers); stored in trace.json for reproducibility
      [--trigger-delay <ms>] wait after load before firing the trigger, so a
      load intro finishes before interaction motion starts
  ${COMMAND} refit <traceDir>
      re-run fitting on an existing trace (fitters evolve; captures are expensive);
      rewrites fits.json / gl-fits.json in place, receipted
  ${COMMAND} loop <traceDir> [--element <path>] [--out <dir>]
      Phase 4: build a convergence-round bundle (deterministic diff + reviewer 2AFC task)
  ${COMMAND} compare-build <traceDir> --candidate <url> [--out <dir>] [--candidate-scope <selector>] [--candidate-selector <selector>] [--headed]
      Build a blinded synchronized frame bundle for a scroll-through DOM trace.
      Both pages start at their own trigger section, then receive the source trace's
      exact pixel deltas. Pointer/canvas/WebGL adapters are not supported yet.
      --candidate-scope overrides the source scope only when clone markup differs.
      --candidate-selector overrides the clone's trigger section anchor; it does not
      change or normalize the source trace's pixel schedule.
  ${COMMAND} nudge <bundleDir> --answer "<diagnosis>"
      apply a review diagnosis answer and rebuild the bundle as the next round
  ${COMMAND} tune <bundleDir> --params '{"tx.stiffness":210,"tx.damping":11}' [--trajectory <file|url>]
      apply an adjust-round result; requires a fresh 2AFC after. --trajectory also
      accepts the native app's adjust-trajectory@1 payload or a signed review-result
      media URL — final params are read from it when --params is omitted
  ${COMMAND} serve <dir> [--tunnel]
      serve a bundle (Range-enabled); --tunnel exposes it publicly via cloudflared

Trigger specs (stored with the capture; gates replay them verbatim):
  load                page load, no interaction
  hover:<selector>    hover an element (pointer stays there)
  click:<selector>    click an element
  focus:<selector>    focus an element
  scroll-to:<selector> scroll an element into view
  scroll-sweep        scroll to the bottom and back in steps
  scroll-through:<selector>/<steps>/<dwellMs>
                      traverse one section's sticky range at fine resolution (best for
                      expanding/pinned scroll effects on long, mutation-heavy pages)
  pointer:<x1>,<y1>-><x2>,<y2>[->…]/<ms>  drive the mouse along a path (pursuit capture)
  pointer:<selector>/<ms>                 drive the mouse from (0,0) to an element center

Exit codes: 0 = ok, 1 = nothing captured / gate failed, 2 = bad usage or crash.
`;

const BOOLEAN_FLAGS = new Set(['headed', 'all', 'tunnel', 'gl']);

function parseFlags(args) {
  const opts = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--') && BOOLEAN_FLAGS.has(a.slice(2))) opts[a.slice(2)] = true;
    else if (a.startsWith('--')) opts[a.slice(2)] = args[++i];
    else opts._.push(a);
  }
  return opts;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return 0;
  }
  const opts = parseFlags(rest);

  switch (cmd) {
    case 'capture': {
      const url = opts._[0];
      if (!url) break;
      const res = await capture({
        url,
        trigger: opts.trigger || 'load',
        out: opts.out,
        observeMs: opts.observe ? Number(opts.observe) : undefined,
        headless: !opts.headed,
        all: !!opts.all,
      });
      console.log(`captured ${res.records.length} animation(s) → ${res.dir}`);
      for (const r of res.records) {
        const fired = r.firedCount > 1 ? ` ×${r.firedCount}` : '';
        console.log(`  [tier ${r.tier}] ${r.type} "${r.name}"${fired} on ${r.target?.path ?? '?'}${r.resolved ? '' : ' (CDP↔page join failed)'}`);
      }
      if (res.crossCheck.truncated) {
        console.log(`  note: capture capped at ${res.crossCheck.truncated.kept} records (${res.crossCheck.truncated.dropped} dropped)`);
      }
      if (res.crossCheck.pageOnly.length) {
        console.log(`  note: ${res.crossCheck.pageOnly.length} animation(s) seen in-page but not by CDP`);
      }
      return res.records.length ? 0 : 1;
    }
    case 'trace': {
      const url = opts._[0];
      if (!url) break;
      const res = await trace({
        url,
        trigger: opts.trigger || 'load',
        out: opts.out,
        observeMs: opts.observe ? Number(opts.observe) : undefined,
        headless: !opts.headed,
        gl: !!opts.gl,
        block: opts.block,
        triggerDelayMs: opts['trigger-delay'] ? Number(opts['trigger-delay']) : 0,
        scope: opts.scope || null,
      });
      if (res.engines.engines.length) console.log(`engines: ${res.engines.engines.join(', ')}`);
      for (const f of res.fits) {
        const t = f.fit.transition;
        const desc =
          f.fit.kind === 'spring'
            ? `spring{stiffness:${t.stiffness}, damping:${t.damping}}`
            : f.fit.kind === 'tween'
              ? `tween ${t.duration}s ease[${t.ease}]`
              : f.fit.kind === 'pointer-follow'
                ? `pointer-follow ${f.fit.link.axis} τ=${f.fit.link.tau}ms (k60=${f.fit.link.k60})`
                : f.fit.kind === 'marquee'
                  ? `marquee ${f.fit.params.velocityPxPerSec}px/s dir=${f.fit.params.direction > 0 ? '+' : '-'}${f.fit.params.axis} (r²=${f.fit.r2})`
                  : `scroll-linear slope ${f.fit.link.slope} (r²=${f.fit.link.r2})`;
        console.log(`  ${f.path} ${f.channel}: ${desc} conf=${f.fit.confidence}`);
      }
      for (const s of res.staggers) console.log(`  stagger ${s.group}: ${s.offsetMs}ms × ${s.elements.length} elements`);
      if (res.gl) {
        const g = res.gl;
        console.log(`  gl: ${g.drawCount} draws / ${g.frameCount} frames → ${g.trackCount} tracks`);
        if (g.tunnel?.ok) {
          const m = g.tunnel.model;
          console.log(
            `  gl fit: parallax-tunnel ${m.layout.itemCount} items, spacing ${m.layout.spacing}, idle ${m.speed.idle} u/s` +
              (m.speed.intro ? `, intro ${m.speed.intro.v0}→idle (t½ ${m.speed.intro.halfLifeMs}ms)` : '') +
              (m.speed.scroll
                ? m.speed.scroll.form === 'expo-out'
                  ? `, scroll law idle+${m.speed.scroll.span}·(1−2^(−${m.speed.scroll.k}p))`
                  : `, scroll held @${m.speed.scroll.points.map((p) => `${p.p}→${p.v}`).join(' ')}`
                : '') +
              ` | replay nRMSE ${(g.tunnel.replay.medianNrmse * 100).toFixed(2)}% conf=${g.tunnel.replay.confidence}`,
          );
        }
        if (g.displacement?.ok) {
          const m = g.displacement.model;
          console.log(
            `  gl fit: pointer-displacement ${m.grid.w}×${m.grid.h}×${m.grid.channels} grid, relaxation ${m.decay.relaxation}/frame (${m.decay.form}, t½ ${m.decay.halfLifeMs}ms), gain ${m.gain}/px, radius ≈${m.radius.radiusCells} cells` +
              (m.pointerFollower ? `, follower τ=${m.pointerFollower.tauMs}ms` : '') +
              (m.amplitude.displacement ? `, ${m.amplitude.displacement.name}=${m.amplitude.displacement.value}` : '') +
              (m.amplitude.aberration ? `, ${m.amplitude.aberration.name}=${m.amplitude.aberration.value}` : '') +
              ` | energy replay nRMSE ${(g.displacement.replay.nrmse * 100).toFixed(2)}% conf=${g.displacement.replay.confidence}`,
          );
        }
        for (const w of g.warnings) console.log(`  gl warning: ${w}`);
      }
      console.log(`traced ${res.fits.length} channel(s) → ${res.dir}`);
      return res.fits.length || res.gl?.trackCount || res.gl?.displacement?.ok ? 0 : 1;
    }
    case 'refit': {
      const dir = opts._[0];
      if (!dir) break;
      const res = refit({ dir: resolve(dir) });
      if (res.fits) console.log(`  refit ${res.fits.length} DOM channel(s)`);
      if (res.gl) {
        const m = res.gl.model;
        if (res.gl.ok && m && m.kind === 'parallax-tunnel') {
          console.log(
            `  gl refit: ${m.kind} ${m.layout.itemCount} items, spacing ${m.layout.spacing}, idle ${m.speed.idle} u/s` +
              (m.speed.intro ? `, intro ${m.speed.intro.v0}→idle (t½ ${m.speed.intro.halfLifeMs}ms)` : '') +
              (m.speed.scroll?.form === 'expo-out' ? `, scroll law idle+${m.speed.scroll.span}·(1−2^(−${m.speed.scroll.k}p))` : '') +
              ` | replay nRMSE ${(res.gl.replay.medianNrmse * 100).toFixed(2)}% conf=${res.gl.replay.confidence}`,
          );
        } else if (res.gl.ok && m && m.kind === 'pointer-displacement') {
          console.log(
            `  gl refit: ${m.kind} ${m.grid.w}×${m.grid.h}×${m.grid.channels} grid, relaxation ${m.decay.relaxation}/frame (${m.decay.form}), gain ${m.gain}/px, radius ≈${m.radius.radiusCells} cells` +
              ` | energy replay nRMSE ${(res.gl.replay.nrmse * 100).toFixed(2)}% conf=${res.gl.replay.confidence}`,
          );
        } else {
          console.log(`  gl refit: no valid GL fit`);
        }
        for (const w of res.gl.warnings ?? []) console.log(`  gl warning: ${w}`);
      }
      return 0;
    }
    case 'loop': {
      const dir = opts._[0];
      if (!dir) break;
      const res = await runLoop({ traceDir: dir, elementPath: opts.element, out: opts.out, headless: !opts.headed });
      console.log(`element: ${res.element} (min fit confidence ${res.minConfidence})`);
      for (const [ch, v] of Object.entries(res.channelDiffs)) {
        console.log(`  ${ch}: model-vs-trace nRMSE ${(v.nrmse * 100).toFixed(2)}% (peak ${(v.peak * 100).toFixed(1)}%)`);
      }
      console.log(`deterministic max nRMSE ${(res.maxNrmse * 100).toFixed(2)}% | ping needed: ${res.pingNeeded}`);
      console.log(`bundle → ${res.dir}`);
      console.log(`next: ${COMMAND} serve ${res.dir} --tunnel, then open ${res.reviewTask.player}`);
      return 0;
    }
    case 'compare-build': {
      const dir = opts._[0];
      if (!dir || !opts.candidate) break;
      const res = await buildLinkedComparison({
        traceDir: dir,
        candidateUrl: opts.candidate,
        out: opts.out,
        headless: !opts.headed,
        maxFrames: opts['max-frames'] ? Number(opts['max-frames']) : undefined,
        candidateScope: opts['candidate-scope'] || undefined,
        candidateSelector: opts['candidate-selector'] || undefined,
      });
      console.log(`linked scroll comparison: ${res.frameCount} synchronized frame(s)`);
      console.log(`  source schedule: ${res.scheduleHash}`);
      console.log(`  preflight: source ${res.preflight.sourceTargetStates} states, candidate ${res.preflight.candidateTargetStates} states`);
      console.log(`bundle → ${res.dir}`);
      return 0;
    }
    case 'nudge': {
      const dir = opts._[0];
      if (!dir || !opts.answer) break;
      const res = await applyRound({ bundleDir: dir, answer: opts.answer, headless: !opts.headed });
      for (const n of res.notes) console.log(`  ${n.channel}: ${n.changed}`);
      console.log(`round ${res.round}: deterministic max nRMSE ${(res.maxNrmse * 100).toFixed(2)}% — bundle rebuilt`);
      return 0;
    }
    case 'tune': {
      const dir = opts._[0];
      if (!dir) break;
      // --trajectory takes a bare [{t, params}] array (web bundles), the
      // motion-kit/adjust-trajectory@1 wrapper the native reviewer app uploads
      // (carries outcome + final params too), or an https URL to either —
      // the signed media URL returned with a review result.
      let trajectory = null;
      let params = opts.params ? JSON.parse(opts.params) : null;
      if (opts.trajectory) {
        const raw = /^https?:\/\//i.test(opts.trajectory)
          ? await (await fetch(opts.trajectory)).json()
          : readJson(resolve(opts.trajectory));
        if (Array.isArray(raw)) {
          trajectory = raw;
        } else if (raw && Array.isArray(raw.trajectory)) {
          trajectory = raw.trajectory;
          if (raw.outcome === 'no-match') {
            console.error(
              'tune: the reviewer\'s answer escaped the model class ("no-match"). Route to diagnosis/refit; params were NOT applied.',
            );
            return 1;
          }
          if (!params && raw.params) params = raw.params;
        }
      }
      if (!params) break;
      const res = await applyAdjust({
        bundleDir: dir,
        params,
        trajectory,
        headless: !opts.headed,
      });
      for (const a of res.applied) console.log(`  ${a.id} = ${a.value}`);
      console.log(`round ${res.round}: deterministic max nRMSE ${(res.maxNrmse * 100).toFixed(2)}% — bundle rebuilt`);
      console.log(`NOTE: ${res.validation}`);
      return 0;
    }
    case 'serve': {
      const dir = opts._[0];
      if (!dir) break;
      const { port } = await serveDir(resolve(dir));
      let base = `http://127.0.0.1:${port}`;
      console.log(`serving ${dir} at ${base}/`);
      if (opts.tunnel) {
        const t = await startTunnel(port);
        base = t.url;
        console.log(`public: ${t.url}`);
      }
      try {
        const task = readJson(resolve(dir, 'review-task.json'));
        console.log(`2afc player:     ${base}/${task.player}`);
        console.log(`diagnose player: ${base}/${task.diagnosePlayer}`);
      } catch {}
      await new Promise(() => {}); // serve until killed
      return 0;
    }
    case 'export': {
      const dir = opts._[0];
      if (!dir) break;
      // a capture dir holds capture.json (Tier 1-2 verbatim); a trace dir holds fits.json
      // (Tier 3 fitted) and/or gl-fits.json (Tier 3G fitted GL motion)
      const isTrace = existsSync(resolve(dir, 'fits.json')) || existsSync(resolve(dir, 'gl-fits.json'));
      if (isTrace) {
        let count = 0;
        if (existsSync(resolve(dir, 'fits.json'))) {
          const res = await runExportFits({
            traceDir: dir,
            out: opts.out || 'library',
            minConfidence: opts['min-confidence'] ? Number(opts['min-confidence']) : undefined,
          });
          for (const e of res.entries) console.log(`  ${e.name} (tier 3 fitted, conf ${e.confidence}, ${e.channels.join('+')}) → ${res.out}/${e.name}/`);
          for (const s of res.skipped) console.log(`  skipped ${s.path}: ${s.reason}`);
          count += res.entries.length;
        }
        if (existsSync(resolve(dir, 'gl-fits.json'))) {
          // dispatch by fitted model kind (tunnel → CSS-3D runtime, displacement → WebGL runtime)
          const kind = readJson(resolve(dir, 'gl-fits.json')).model?.kind;
          const exportGl = kind === 'pointer-displacement' ? runExportDisplacement : runExportTunnel;
          const res = await exportGl({
            traceDir: dir,
            out: opts.out || 'library',
            minConfidence: opts['min-confidence'] ? Number(opts['min-confidence']) : undefined,
          });
          for (const e of res.entries) console.log(`  ${e.name} (tier 3G fitted, conf ${e.confidence}) → ${res.out}/${e.name}/`);
          for (const s of res.skipped) console.log(`  skipped ${s.path}: ${s.reason}`);
          count += res.entries.length;
        }
        console.log(`exported ${count} entr${count === 1 ? 'y' : 'ies'} → ${opts.out || 'library'}/index.json`);
        return count ? 0 : 1;
      }
      const res = await runExport({ captureDir: dir, out: opts.out || 'library' });
      for (const e of res.entries) console.log(`  ${e.name} (${e.engine}, tier ${e.tier}) → ${res.out}/${e.name}/`);
      for (const s of res.skipped) console.log(`  skipped ${s.key}: ${s.reason}`);
      console.log(`exported ${res.entries.length} entr${res.entries.length === 1 ? 'y' : 'ies'} → ${res.out}/index.json`);
      return res.entries.length ? 0 : 1;
    }
    case 'gate': {
      const dir = opts._[0];
      if (!dir) break;
      const res = await runGate({ captureDir: dir, headless: !opts.headed });
      for (const r of res.records) {
        const worst = Math.max(0, ...r.fractions.map((f) => f.ratio));
        console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.type} "${r.name}" worst-frame diff ${(worst * 100).toFixed(2)}%${r.reason ? ` — ${r.reason}` : ''}`);
      }
      console.log(`gate: ${res.summary.passed}/${res.summary.total} replayed faithfully`);
      return res.ok ? 0 : 1;
    }
  }
  console.log(USAGE);
  return 2;
}
