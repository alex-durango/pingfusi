// GL-tap gate: trace the OffscreenCanvas worker tunnel fixture (closed-form ground
// truth in fixtures/pages/gl-tunnel.worker.js) and score the fitted parallax-tunnel
// model against the truth; then trace the pointer-displacement fixture
// (fixtures/pages/displacement.html) and score the fitted displacement-field model.
// Layout/constants gate on parameter tolerance; motion gates on the REGENERATED
// trajectory/energy curve (replay nRMSE), matching phase-3 doctrine.
// Exit code is the verdict.
import { rmSync } from 'node:fs';
import { startFixtureServer } from '../fixtures/serve.js';
import { trace } from '../src/tier3/trace.js';
import { writeArtifact } from '../src/lib/artifacts.js';

const OUT = 'captures/gl-gate';
const D_OUT = 'captures/gl-gate-displacement';

const TRUTH = {
  itemCount: 12,
  radius: 5,
  spacing: 3,
  idle: 20,
  introV0: 200,
  introHalfMs: 150,
  introCurveNrmseMax: 0.1, // fitted-vs-truth speed curve over the intro window
  scrollSpan: 60, // v(p) = idle + span·(1 − 2^(−k·p)), persistent while p holds
  scrollK: 6,
  scrollLawNrmseMax: 0.1, // fitted-vs-truth v(p) curve over p ∈ [0, 1]
  wrapLength: 36,
  fogNear: 2,
  fogFar: 40,
  fovYdeg: 45,
  replayNrmseMax: 0.05,
};

// fixtures/pages/displacement.html ground truth. Parameter tolerances per the fitter's
// honest error sources: relaxation is a clean log-space regression (±10%); the radius
// is recovered from the energy spread, which the falloff shape and the moving-cursor
// trail both bias (±40%); init-only uniform constants pass through EXACTLY.
const DTRUTH = {
  gridW: 32,
  gridH: 32,
  channels: 2,
  relaxation: 0.9,
  radiusCells: 3.5,
  uDisplacement: 0.015,
  uAberration: 0.15,
  // measured across runs: 4.5–5.2% (the residual is real — sub-cell falloff
  // discretization makes the injected energy per px, Σf, vary as the cursor crosses
  // cells, and the fitted gain is its average). 8% = honest headroom above the
  // observed band, not a curve-hugging bar.
  energyReplayNrmseMax: 0.08,
};

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
}
const within = (v, truth, tol) => v != null && Math.abs(v - truth) <= truth * tol;

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  const server = await startFixtureServer();
  try {
    const res = await trace({
      url: `http://127.0.0.1:${server.port}/pages/gl-tunnel.html`,
      // stepped scroll WITH dwell: the speed law fits from held-progress spans, so each
      // quantized progress level must be observed at rest (page quantizes to 0.2 steps)
      trigger: 'scroll-steps:2400/6/900',
      out: OUT,
      observeMs: 9000,
      headless: true,
      gl: true,
      triggerDelayMs: 1500, // let the intro burst (t½ 150ms) fully decay before the steps
    });
    const g = res.gl;
    if (!g || !g.tunnel?.ok) {
      console.log(`FAIL: no tunnel fit (tracks=${g?.trackCount ?? 0}, warnings=${JSON.stringify(g?.warnings)})`);
      process.exit(1);
    }
    const m = g.tunnel.model;
    const r = g.tunnel.replay;

    check('tracks', g.trackCount === TRUTH.itemCount, `${g.trackCount} tracks (truth ${TRUTH.itemCount})`);
    check('radius', within(m.layout.radius, TRUTH.radius, 0.05), `${m.layout.radius} (truth ${TRUTH.radius} ±5%)`);
    check('spacing', within(m.layout.spacing, TRUTH.spacing, 0.1), `${m.layout.spacing} (truth ${TRUTH.spacing} ±10%)`);
    check('idle speed', within(m.speed.idle, TRUTH.idle, 0.1), `${m.speed.idle} u/s (truth ${TRUTH.idle} ±10%)`);
    // intro gates on the regenerated speed CURVE against the truth curve, both anchored
    // at the fitted t0 (phase-3 doctrine: params like (v0, t½) trade off against the
    // anchor; the curve is what the viewer sees)
    let introDetail = 'not detected';
    let introOk = false;
    if (m.speed.intro) {
      const { v0, halfLifeMs, t0 } = m.speed.intro;
      let sum = 0;
      const N = 60;
      for (let i = 0; i < N; i++) {
        const t = (i / (N - 1)) * 900; // ms since intro start
        const fitted = m.speed.idle + (v0 - m.speed.idle) * Math.pow(2, -t / halfLifeMs);
        const truth = TRUTH.idle + (TRUTH.introV0 - TRUTH.idle) * Math.pow(2, -t / TRUTH.introHalfMs);
        sum += (fitted - truth) ** 2;
      }
      const nrmse = Math.sqrt(sum / N) / (TRUTH.introV0 - TRUTH.idle);
      introOk = nrmse <= TRUTH.introCurveNrmseMax;
      introDetail = `curve nRMSE ${(nrmse * 100).toFixed(2)}% vs truth (max ${TRUTH.introCurveNrmseMax * 100}%) — fitted v0 ${v0}, t½ ${halfLifeMs}ms @ t0 ${t0}ms`;
    }
    check('intro burst', introOk, introDetail);
    // scroll law gates on the regenerated v(p) curve, same doctrine as the intro
    let lawOk = false;
    let lawDetail = 'not detected';
    if (m.speed.scroll?.form === 'expo-out') {
      const { span, k } = m.speed.scroll;
      let sum = 0;
      const N = 50;
      for (let i = 0; i < N; i++) {
        const p = i / (N - 1);
        const fitted = m.speed.idle + span * (1 - Math.pow(2, -k * p));
        const truth = TRUTH.idle + TRUTH.scrollSpan * (1 - Math.pow(2, -TRUTH.scrollK * p));
        sum += (fitted - truth) ** 2;
      }
      const nrmse = Math.sqrt(sum / N) / TRUTH.scrollSpan;
      lawOk = nrmse <= TRUTH.scrollLawNrmseMax;
      lawDetail = `v(p) curve nRMSE ${(nrmse * 100).toFixed(2)}% vs truth (max ${TRUTH.scrollLawNrmseMax * 100}%) — fitted span ${span}, k ${k}, ${m.speed.scroll.points.length} held level(s)`;
    } else if (m.speed.scroll) {
      lawDetail = `form ${m.speed.scroll.form} (law under-determined)`;
    }
    check('scroll speed law', lawOk, lawDetail);
    check('wrap length', m.wrap != null && within(m.wrap.length, TRUTH.wrapLength, 0.1), m.wrap ? `${m.wrap.length} (truth ${TRUTH.wrapLength} ±10%)` : 'no wraps seen');
    check('fog', m.fog != null && within(m.fog.near, TRUTH.fogNear, 0.05) && within(m.fog.far, TRUTH.fogFar, 0.05), m.fog ? `near ${m.fog.near} far ${m.fog.far} (truth ${TRUTH.fogNear}/${TRUTH.fogFar})` : 'not captured');
    const fovOk =
      m.camera.projection && within(Math.atan(1 / m.camera.projection[5]) * 2 * (180 / Math.PI), TRUTH.fovYdeg, 0.03);
    check('camera fov', fovOk, m.camera.projection ? `${(Math.atan(1 / m.camera.projection[5]) * 2 * (180 / Math.PI)).toFixed(1)}° (truth ${TRUTH.fovYdeg}° ±3%)` : 'no projection');
    check('replay trajectory', r.medianNrmse != null && r.medianNrmse <= TRUTH.replayNrmseMax, `median nRMSE ${(r.medianNrmse * 100).toFixed(2)}% (max ${TRUTH.replayNrmseMax * 100}%), worst ${(r.worstNrmse * 100).toFixed(2)}%`);

    // ---- pointer-displacement section (fixtures/pages/displacement.html) ----
    // Sweep with direction changes (exercises the L1-travel injection model), then a
    // long still tail — the idle decay windows relaxation is fitted from.
    rmSync(D_OUT, { recursive: true, force: true });
    const dres = await trace({
      url: `http://127.0.0.1:${server.port}/pages/displacement.html`,
      trigger: 'pointer:200,360->1080,360->640,180->640,540->260,260/2600',
      out: D_OUT,
      observeMs: 4500,
      headless: true,
      gl: true,
    });
    const d = dres.gl?.displacement;
    if (!d?.ok) {
      console.log(`FAIL: no displacement fit (warnings=${JSON.stringify(dres.gl?.warnings)})`);
      process.exit(1);
    }
    const dm = d.model;
    check(
      'displacement grid',
      dm.grid.w === DTRUTH.gridW && dm.grid.h === DTRUTH.gridH && dm.grid.channels === DTRUTH.channels,
      `${dm.grid.w}×${dm.grid.h}×${dm.grid.channels} (truth ${DTRUTH.gridW}×${DTRUTH.gridH}×${DTRUTH.channels}, exact)`,
    );
    check(
      'relaxation',
      within(dm.decay.relaxation, DTRUTH.relaxation, 0.1),
      `${dm.decay.relaxation}/frame via ${dm.decay.form}, ${dm.decay.idlePairs} idle pairs (truth ${DTRUTH.relaxation} ±10%)`,
    );
    check(
      'impulse radius',
      within(dm.radius.radiusCells, DTRUTH.radiusCells, 0.4),
      `≈${dm.radius.radiusCells} cells (spread ${dm.radius.spreadCells}) (truth ${DTRUTH.radiusCells} ±40%)`,
    );
    check(
      'uDisplacement passthrough',
      dm.amplitude.displacement?.name === 'uDisplacement' && dm.amplitude.displacement?.value === DTRUTH.uDisplacement,
      `${dm.amplitude.displacement?.name}=${dm.amplitude.displacement?.value} (truth uDisplacement=${DTRUTH.uDisplacement}, exact)`,
    );
    check(
      'uAberration passthrough',
      dm.amplitude.aberration?.name === 'uAberration' && dm.amplitude.aberration?.value === DTRUTH.uAberration,
      `${dm.amplitude.aberration?.name}=${dm.amplitude.aberration?.value} (truth uAberration=${DTRUTH.uAberration}, exact)`,
    );
    check(
      'energy replay',
      d.replay.nrmse <= DTRUTH.energyReplayNrmseMax,
      `nRMSE ${(d.replay.nrmse * 100).toFixed(2)}% over ${d.replay.pairs} pairs (max ${DTRUTH.energyReplayNrmseMax * 100}%), pointer corr ${d.replay.pointerCorrelation}, gain ${dm.gain}/px`,
    );

    const passed = checks.filter((c) => c.ok).length;
    writeArtifact(OUT, 'gl-gate.json', { truth: TRUTH, displacementTruth: DTRUTH, checks, passed, total: checks.length });
    console.log(`gl gate: ${passed}/${checks.length}`);
    process.exit(passed === checks.length ? 0 : 1);
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(2);
});
