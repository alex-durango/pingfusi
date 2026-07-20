// Phase 3 gate: trace every tier3 fixture (rAF/inline-style animators with closed-form
// ground truth), fit, and score fitted models against the truth. Gating is on the
// REGENERATED CURVE, not raw param distance — (stiffness, damping) is ill-conditioned.
// Pass = ≥70% of expectations met (per docs/PLAN.md). Exit code is the verdict.
import { rmSync } from 'node:fs';
import { startFixtureServer } from '../fixtures/serve.js';
import { trace } from '../src/tier3/trace.js';
import { springPosition, cubicBezier } from '../src/tier3/motion-model.js';
import { segment, pursuitTrajectory } from '../src/tier3/fit.js';
import { writeArtifact } from '../src/lib/artifacts.js';

const OUT = 'captures/phase3';
const PASS_FRACTION = 0.7;

const FIXTURES = [
  {
    page: 'tier3/tweens.html',
    trigger: 'click:#go',
    observe: 1600,
    expect: [
      { sel: '#b1', channel: 'tx', kind: 'bezier', truth: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1, dur: 600 } },
      { sel: '#b2', channel: 'opacity', kind: 'bezier', truth: { x1: 0.42, y1: 0, x2: 0.58, y2: 1, dur: 800 } },
      { sel: '#b3', channel: 'ty', kind: 'bezier', truth: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1, dur: 700 } },
    ],
  },
  {
    page: 'tier3/springs.html',
    trigger: 'click:#go',
    observe: 3600,
    expect: [
      { sel: '#s1', channel: 'tx', kind: 'spring', truth: { stiffness: 200, damping: 10, from: 0, to: 200 } },
      { sel: '#s2', channel: 'tx', kind: 'spring', truth: { stiffness: 500, damping: 25, from: 0, to: 240 } },
      { sel: '#s3', channel: 'tx', kind: 'spring', truth: { stiffness: 120, damping: 22, from: 0, to: 180 } },
    ],
  },
  {
    page: 'tier3/springs-jumped.html',
    trigger: 'click:#go',
    observe: 3600,
    expect: [
      { sel: '#j1', channel: 'tx', kind: 'spring-jumped', truth: { stiffness: 200, damping: 10, minVelocity: 200 } },
      { sel: '#j2', channel: 'tx', kind: 'spring-jumped', truth: { stiffness: 500, damping: 25, minVelocity: 200 } },
    ],
  },
  {
    page: 'tier3/scroll-parallax.html',
    trigger: 'scroll-sweep',
    observe: 2500,
    expect: [
      { sel: '#hero', channel: 'ty', kind: 'scroll', truth: { slope: -0.3 } },
      { sel: '#fader', channel: 'opacity', kind: 'scroll', truth: { slope: -0.0005 } },
    ],
  },
  {
    page: 'tier3/scoped-overflow.html',
    trigger: 'scroll-through:#stage/60/0',
    scope: '#stage',
    observe: 2500,
    expect: [
      { sel: '#circle', channel: 'sx', kind: 'scroll', truth: { slope: 0.0005 } },
      { sel: '#circle', channel: 'opacity', kind: 'scroll', truth: { slope: 0.0004 } },
      { kind: 'scope', truth: { selector: '#stage' } },
    ],
  },
  {
    page: 'tier3/pointer-follow.html',
    // waypoint turns on BOTH axes — a monotone path would let an ease tween impersonate
    // the follower; direction changes only a pursuit model can track
    trigger: 'pointer:200,500->1000,200->400,620/1500',
    observe: 2200,
    expect: [
      // fixture k=0.12 / 0.25 per 60fps frame → τ = −16.667/ln(1−k)
      { sel: '#f1', channel: 'tx', kind: 'pointer-follow', truth: { tau: 130.4 } },
      { sel: '#f1', channel: 'ty', kind: 'pointer-follow', truth: { tau: 130.4 } },
      { sel: '#f2', channel: 'tx', kind: 'pointer-follow', truth: { tau: 57.9 } },
    ],
  },
  {
    page: 'tier3/magnet.html',
    // start ON the pre-attracted button, exit downward → mouseleave fires the release
    trigger: 'pointer:640,360->640,650/300',
    observe: 3600,
    expect: [
      { sel: '#m1', channel: 'tx', kind: 'spring', truth: { stiffness: 280, damping: 16, from: 24, to: 0 } },
    ],
  },
  {
    page: 'tier3/stagger.html',
    trigger: 'click:#go',
    observe: 1800,
    expect: [
      { kind: 'stagger', truth: { offsetMs: 120, count: 3, channel: 'ty' } },
      { kind: 'engine', truth: { engine: 'gsap' } },
    ],
  },
];

function findFit(fits, sel, channel) {
  return fits.find((f) => f.path?.includes(sel) && f.channel === channel)?.fit ?? null;
}

function checkBezier(fit, truth) {
  if (!fit) return { ok: false, detail: 'no fit found' };
  if (fit.kind !== 'tween') return { ok: false, detail: `kind ${fit.kind}` };
  const truthFn = cubicBezier(truth.x1, truth.y1, truth.x2, truth.y2);
  const fitFn = cubicBezier(...fit.transition.ease);
  let worst = 0;
  for (let i = 0; i <= 100; i++) worst = Math.max(worst, Math.abs(fitFn(i / 100) - truthFn(i / 100)));
  const durMs = fit.transition.duration * 1000;
  const durOk = Math.abs(durMs - truth.dur) <= 90;
  return {
    ok: worst <= 0.08 && durOk,
    detail: `curveErr ${worst.toFixed(3)}, dur ${Math.round(durMs)} vs ${truth.dur}`,
  };
}

// Springs are gated on PARAMETER recovery: (k, c) is the spring's identity, and fits may
// legitimately re-anchor their time origin (jump trim + velocity) when the capture
// environment hitches — a time-aligned curve comparison would punish correct fits.
function checkSpring(fit, truth) {
  if (!fit) return { ok: false, detail: 'no fit found' };
  if (fit.kind !== 'spring') return { ok: false, detail: `kind ${fit.kind}` };
  const kErr = Math.abs(fit.transition.stiffness - truth.stiffness) / truth.stiffness;
  const cErr = Math.abs(fit.transition.damping - truth.damping) / truth.damping;
  return {
    ok: kErr <= 0.15 && cErr <= 0.2 && fit.confidence >= 0.9,
    detail: `k=${fit.transition.stiffness} (${(kErr * 100).toFixed(0)}% off), c=${fit.transition.damping} (${(cErr * 100).toFixed(0)}% off), velocity=${fit.transition.velocity}px/s, conf=${fit.confidence}`,
  };
}

// Jumped start: the sub-trimmed trace is an exact spring with the true (k, c) but
// non-rest initial conditions — so k/c must recover tightly AND the fitted velocity must
// be substantially nonzero (the jump detected as Motion's canonical velocity field).
function checkSpringJumped(fit, truth) {
  if (!fit) return { ok: false, detail: 'no fit found' };
  if (fit.kind !== 'spring') return { ok: false, detail: `kind ${fit.kind}` };
  const kErr = Math.abs(fit.transition.stiffness - truth.stiffness) / truth.stiffness;
  const cErr = Math.abs(fit.transition.damping - truth.damping) / truth.damping;
  const vel = Math.abs(fit.transition.velocity || 0);
  return {
    ok: kErr <= 0.2 && cErr <= 0.25 && vel >= truth.minVelocity && fit.confidence >= 0.85,
    detail: `k=${fit.transition.stiffness} (${(kErr * 100).toFixed(0)}% off), c=${fit.transition.damping} (${(cErr * 100).toFixed(0)}% off), velocity=${fit.transition.velocity}px/s, conf=${fit.confidence}`,
  };
}

// Pursuit is gated on the REGENERATED TRAJECTORY: re-simulate the fitted (τ, offset)
// against the RECORDED pointer series and score nRMSE vs the recorded element samples —
// plus a τ tolerance (±15%, in line with springs).
function checkPointerFollow(fit, truth, data, e) {
  if (!fit) return { ok: false, detail: 'no fit found' };
  if (fit.kind !== 'pointer-follow') return { ok: false, detail: `kind ${fit.kind}` };
  const tauErr = Math.abs(fit.link.tau - truth.tau) / truth.tau;
  const el = data.elements.find((x) => x.path?.includes(e.sel));
  const chSamples = el
    ? el.samples.map((s) => ({ t: s.t, v: s[e.channel] })).filter((s) => isFinite(s.v))
    : [];
  const seg = segment(chSamples);
  let nrmse = Infinity;
  if (seg) {
    const active = chSamples.slice(seg.start, seg.end + 1);
    const pred = pursuitTrajectory(active, data.pointer, { tau: fit.link.tau, offset: fit.link.offset, axis: fit.link.axis });
    const vals = active.map((s) => s.v);
    const range = Math.max(...vals) - Math.min(...vals);
    let sum = 0;
    for (let i = 0; i < vals.length; i++) sum += (pred[i] - vals[i]) ** 2;
    nrmse = Math.sqrt(sum / vals.length) / range;
  }
  return {
    ok: tauErr <= 0.15 && nrmse <= 0.06,
    detail: `τ=${fit.link.tau}ms vs ${truth.tau} (${(tauErr * 100).toFixed(0)}% off), offset=${fit.link.offset}, regen nRMSE ${(nrmse * 100).toFixed(2)}%`,
  };
}

function checkScroll(fit, truth) {
  if (!fit) return { ok: false, detail: 'no fit found' };
  if (fit.kind !== 'scroll-linear') return { ok: false, detail: `kind ${fit.kind}` };
  const rel = Math.abs((fit.link.slope - truth.slope) / truth.slope);
  return {
    ok: rel <= 0.1 && fit.link.r2 >= 0.95,
    detail: `slope ${fit.link.slope} vs ${truth.slope} (${(rel * 100).toFixed(1)}% off), r²=${fit.link.r2}`,
  };
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  const { port, close } = await startFixtureServer();
  const results = [];
  let total = 0;
  let passed = 0;
  try {
    for (const fx of FIXTURES) {
      const url = `http://127.0.0.1:${port}/${fx.page}`;
      const dir = `${OUT}/${fx.page.split('/').pop().replace('.html', '')}`;
      let res;
      try {
        res = await trace({ url, trigger: fx.trigger, scope: fx.scope, out: dir, observeMs: fx.observe });
      } catch (err) {
        results.push({ fixture: fx.page, error: String(err?.stack || err) });
        total += fx.expect.length;
        console.log(`${fx.page}: ERROR ${String(err).split('\n')[0]}`);
        continue;
      }
      for (const e of fx.expect) {
        total++;
        let verdict;
        if (e.kind === 'bezier') verdict = checkBezier(findFit(res.fits, e.sel, e.channel), e.truth);
        else if (e.kind === 'spring') verdict = checkSpring(findFit(res.fits, e.sel, e.channel), e.truth);
        else if (e.kind === 'spring-jumped') verdict = checkSpringJumped(findFit(res.fits, e.sel, e.channel), e.truth);
        else if (e.kind === 'scroll') verdict = checkScroll(findFit(res.fits, e.sel, e.channel), e.truth);
        else if (e.kind === 'pointer-follow') verdict = checkPointerFollow(findFit(res.fits, e.sel, e.channel), e.truth, res.data, e);
        else if (e.kind === 'scope') {
          const noise = res.data.elements.filter((x) => x.path?.includes('#noise'));
          verdict = {
            ok: res.data.scope?.selector === e.truth.selector && res.data.scope?.matchedAtStart === 1 && noise.length === 0 && res.data.dropped === 0,
            detail: `scope=${res.data.scope?.selector || 'none'} matched=${res.data.scope?.matchedAtStart || 0}, noise=${noise.length}, dropped=${res.data.dropped}`,
          };
        }
        else if (e.kind === 'stagger') {
          const s = res.staggers.find((x) => x.group.startsWith(`${e.truth.channel}:`));
          verdict = s
            ? { ok: s.elements.length >= e.truth.count && Math.abs(s.offsetMs - e.truth.offsetMs) <= 30, detail: `offset ${s.offsetMs}ms × ${s.elements.length}` }
            : { ok: false, detail: 'no stagger detected' };
        } else if (e.kind === 'engine') {
          verdict = { ok: res.engines.engines.includes(e.truth.engine), detail: `engines: ${res.engines.engines.join(',') || 'none'}` };
        }
        if (verdict.ok) passed++;
        results.push({ fixture: fx.page, expect: e, ...verdict });
        console.log(`  ${verdict.ok ? 'ok  ' : 'FAIL'} ${fx.page} ${e.sel ?? e.kind}${e.channel ? '.' + e.channel : ''} — ${verdict.detail}`);
      }
    }
  } finally {
    await close();
  }
  const fraction = total ? passed / total : 0;
  const ok = fraction >= PASS_FRACTION;
  writeArtifact(OUT, 'phase3-gate.json', {
    ranAt: new Date().toISOString(),
    results,
    totals: { total, passed, fraction },
    thresholds: { passFraction: PASS_FRACTION },
    ok,
  });
  console.log(`\nphase3 gate: ${passed}/${total} (${(fraction * 100).toFixed(0)}%) → ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(2);
});
