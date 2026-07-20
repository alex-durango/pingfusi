// Browserless fitter verification: generate traces from the forward models (+ sensor
// noise), fit them back, and gate on the regenerated curve, not raw param distance —
// (stiffness, damping) is ill-conditioned, near-identical curves have different params.
import assert from 'node:assert/strict';
import { springPosition, cubicBezier } from '../src/tier3/motion-model.js';
import { fitChannel, fitBezierTween, fitSpringModel, fitMarquee, detectStagger, pursuitTrajectory } from '../src/tier3/fit.js';
import { fitDisplacement, pickDynamicFloatTexture } from '../src/tier3/fit-displacement.js';
import { evalFitAt } from '../src/loop/eval-fit.js';

let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n  ${err.message}`);
  }
};

// deterministic pseudo-noise
let seed = 42;
const noise = (amp) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return ((seed / 0x7fffffff) * 2 - 1) * amp;
};

function bezierTrace({ x1, y1, x2, y2, dur, from, to, dt = 16.7, noiseAmp = 0 }) {
  const fn = cubicBezier(x1, y1, x2, y2);
  const samples = [];
  for (let t = 0; t <= dur + dt; t += dt) {
    const p = Math.min(1, t / dur);
    samples.push({ t: 1000 + t, v: from + (to - from) * fn(p) + noise(noiseAmp) });
  }
  return samples;
}

function springTrace({ stiffness, damping, from, to, ms = 2000, dt = 16.7, noiseAmp = 0 }) {
  const samples = [];
  for (let t = 0; t <= ms; t += dt) {
    samples.push({
      t: 1000 + t,
      v: springPosition(t, { stiffness, damping, origin: from, target: to }) + noise(noiseAmp),
    });
  }
  return samples;
}

function maxCurveError(fit, truthFn, dur) {
  // compare normalized progress curves on a dense grid
  let worst = 0;
  for (let i = 0; i <= 100; i++) {
    const p = i / 100;
    let fitted;
    if (fit.kind === 'tween') {
      fitted = cubicBezier(...fit.transition.ease)(p);
    } else {
      fitted =
        (springPosition(p * dur, { ...fit.transition, origin: fit.valueFrom, target: fit.valueTo }) - fit.valueFrom) /
        (fit.valueTo - fit.valueFrom);
    }
    worst = Math.max(worst, Math.abs(fitted - truthFn(p)));
  }
  return worst;
}

test('recovers a standard ease bezier from a noisy trace', () => {
  const truth = { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 };
  const samples = bezierTrace({ ...truth, dur: 600, from: 0, to: 240, noiseAmp: 0.5 });
  const fit = fitChannel(samples, null, { triggerAt: 990 });
  assert.equal(fit.kind, 'tween');
  assert.equal(fit.transition.type, 'tween'); // Motion-canonical shape
  assert.ok(fit.confidence > 0.85, `confidence ${fit.confidence}`);
  const err = maxCurveError(fit, cubicBezier(truth.x1, truth.y1, truth.x2, truth.y2), 600);
  assert.ok(err < 0.05, `max curve error ${err.toFixed(4)}`);
  assert.ok(Math.abs(fit.transition.duration * 1000 - 600) < 60, `duration ${fit.transition.duration}s`);
  assert.ok(fit.delayMs < 40, `delay ${fit.delayMs}`);
});

test('recovers an overshooting back-out bezier', () => {
  const truth = { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 };
  const samples = bezierTrace({ ...truth, dur: 700, from: 0, to: 160, noiseAmp: 0.4 });
  const fit = fitBezierTween(samples);
  const err = maxCurveError(fit, cubicBezier(truth.x1, truth.y1, truth.x2, truth.y2), 700);
  assert.ok(err < 0.05, `max curve error ${err.toFixed(4)}`);
});

test('recovers a bouncy underdamped spring and classifies it as spring', () => {
  const truth = { stiffness: 200, damping: 10 };
  const samples = springTrace({ ...truth, from: 0, to: 200, ms: 2500, noiseAmp: 0.5 });
  const fit = fitChannel(samples, null, { triggerAt: 995 });
  assert.equal(fit.kind, 'spring', `chose ${fit.kind} (nrmse ${fit.nrmse?.toFixed(4)})`);
  assert.equal(fit.transition.type, 'spring'); // Motion-canonical shape
  assert.ok(fit.confidence > 0.85, `confidence ${fit.confidence}`);
  // regenerated curve agreement over the settle window
  let worst = 0;
  for (let t = 0; t <= 2000; t += 20) {
    const a = springPosition(t, { ...truth, origin: 0, target: 200 });
    const b = springPosition(t, { ...fit.transition, origin: fit.valueFrom, target: fit.valueTo });
    worst = Math.max(worst, Math.abs(a - b));
  }
  assert.ok(worst < 10, `worst position error ${worst.toFixed(2)}px of 200px`);
});

test('recovers a stiff barely-damped spring (Motion transform default)', () => {
  const truth = { stiffness: 500, damping: 25 };
  const samples = springTrace({ ...truth, from: 100, to: 340, ms: 1500, noiseAmp: 0.4 });
  const fit = fitChannel(samples, null, {});
  assert.equal(fit.kind, 'spring');
  let worst = 0;
  for (let t = 0; t <= 1200; t += 20) {
    const a = springPosition(t, { ...truth, origin: 100, target: 340 });
    const b = springPosition(t, { ...fit.transition, origin: fit.valueFrom, target: fit.valueTo });
    worst = Math.max(worst, Math.abs(a - b));
  }
  assert.ok(worst < 12, `worst position error ${worst.toFixed(2)}px of 240px`);
});

test('recovers a hitch-started spring via Motion velocity (jumped onset)', () => {
  // recorded shape: hold at 0 for 60ms, then springPos(t + 60) — the engine clock ran
  // 60ms ahead of the first paint
  const truth = { stiffness: 200, damping: 10 };
  const samples = [];
  for (let t = 0; t <= 50; t += 8.3) samples.push({ t: 1000 + t, v: 0 });
  for (let t = 60; t <= 2400; t += 8.3) {
    samples.push({ t: 1000 + t, v: springPosition(t, { ...truth, origin: 0, target: 200 }) + noise(0.3) });
  }
  const fit = fitChannel(samples, null, { triggerAt: 995 });
  assert.equal(fit.kind, 'spring', `chose ${fit.kind}`);
  assert.ok(fit.confidence > 0.85, `confidence ${fit.confidence}`);
  const kErr = Math.abs(fit.transition.stiffness - truth.stiffness) / truth.stiffness;
  const cErr = Math.abs(fit.transition.damping - truth.damping) / truth.damping;
  assert.ok(kErr < 0.2, `stiffness ${fit.transition.stiffness} (${(kErr * 100).toFixed(0)}% off)`);
  assert.ok(cErr < 0.25, `damping ${fit.transition.damping} (${(cErr * 100).toFixed(0)}% off)`);
  // true velocity at the 60ms jump point ≈ numeric derivative there
  const vTrue = ((springPosition(64, { ...truth, origin: 0, target: 200 }) - springPosition(56, { ...truth, origin: 0, target: 200 })) / 8) * 1000;
  assert.ok(
    Math.abs(fit.transition.velocity - vTrue) / vTrue < 0.3,
    `velocity ${fit.transition.velocity} vs true ≈${vTrue.toFixed(0)}px/s`,
  );
});

// pointer path with direction changes; follower advanced by the exact per-frame lerp
// `pos += (target − pos) * k` — the discrete process the continuous model must recover
function pursuitTrace({ k, offset = -20, dt = 16.7, frames = 150, noiseAmp = 0 }) {
  const pointer = [];
  const samples = [];
  let x = 0;
  for (let i = 0; i <= frames; i++) {
    const t = 1000 + i * dt;
    const px = i < 50 ? 100 + i * 14 : i < 100 ? 800 - (i - 50) * 8 : 400 + (i - 100) * 3;
    pointer.push({ t, x: px, y: 300 });
    x += (px + offset - x) * k;
    samples.push({ t, v: x + noise(noiseAmp) });
  }
  return { pointer, samples };
}

test('recovers pointer-pursuit τ and offset from a noisy follower trace', () => {
  const k = 0.12;
  const tauTrue = -16.7 / Math.log(1 - k); // ≈ 130.6ms
  const { pointer, samples } = pursuitTrace({ k, offset: -20, noiseAmp: 0.4 });
  const fit = fitChannel(samples, null, { channel: 'tx', pointer });
  assert.equal(fit.kind, 'pointer-follow', `chose ${fit.kind}`);
  assert.ok(fit.confidence > 0.85, `confidence ${fit.confidence}`);
  const tauErr = Math.abs(fit.link.tau - tauTrue) / tauTrue;
  assert.ok(tauErr < 0.1, `τ ${fit.link.tau} vs true ${tauTrue.toFixed(1)} (${(tauErr * 100).toFixed(0)}% off)`);
  assert.ok(Math.abs(fit.link.offset - -20) < 3, `offset ${fit.link.offset} vs true -20`);
  // regenerated-curve gate: re-simulate the fitted params against the pointer series
  const pred = pursuitTrajectory(samples, pointer, { tau: fit.link.tau, offset: fit.link.offset, axis: 'x' });
  const vals = samples.map((s) => s.v);
  const range = Math.max(...vals) - Math.min(...vals);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) sum += (pred[i] - vals[i]) ** 2;
  const nrmse = Math.sqrt(sum / vals.length) / range;
  assert.ok(nrmse < 0.05, `regenerated nRMSE ${nrmse.toFixed(4)}`);
});

test('pursuit is NOT chosen when motion ignores the pointer', () => {
  const samples = bezierTrace({ x1: 0.42, y1: 0, x2: 0.58, y2: 1, dur: 800, from: 0, to: 150, noiseAmp: 0.2 });
  const pointer = [];
  for (let i = 0; i <= 100; i++) {
    pointer.push({ t: 1000 + i * 16.7, x: i < 50 ? 100 + i * 10 : 600 - (i - 50) * 6, y: 300 });
  }
  const fit = fitChannel(samples, null, { channel: 'tx', pointer });
  assert.equal(fit.kind, 'tween', `chose ${fit.kind}`);
});

test('scroll-linear beats time models when the channel tracks scrollY', () => {
  const frames = [];
  const samples = [];
  for (let i = 0; i < 120; i++) {
    const t = 1000 + i * 16.7;
    const scrollY = i < 60 ? i * 20 : (120 - i) * 20; // sweep down then up
    frames.push({ t, scrollY });
    samples.push({ t, v: -0.3 * scrollY + 5 + noise(0.3) });
  }
  const fit = fitChannel(samples, frames, {});
  assert.equal(fit.kind, 'scroll-linear', `chose ${fit.kind}`);
  assert.ok(Math.abs(fit.link.slope - -0.3) < 0.02, `slope ${fit.link.slope}`);
  assert.ok(fit.link.r2 > 0.98, `r2 ${fit.link.r2}`);
});

test('spring is NOT chosen for a plain ease tween (model discrimination)', () => {
  const samples = bezierTrace({ x1: 0.42, y1: 0, x2: 0.58, y2: 1, dur: 800, from: 0, to: 100, noiseAmp: 0.2 });
  const fit = fitChannel(samples, null, {});
  assert.equal(fit.kind, 'tween', `chose ${fit.kind}`);
});

test('float-dust channels are not fit (gsap.com sx noise)', () => {
  // ±6e-7 wobble around 1.0 — matrix-decomposition noise, must not produce a fit
  const samples = [];
  for (let t = 0; t <= 2000; t += 16) {
    samples.push({ t, v: 1 + Math.sin(t) * 6e-7 });
  }
  assert.equal(fitChannel(samples, null, { channel: 'sx' }), null);
});

// Displacement-field refit: synthesize an upload-stats series from the forward model
// E_t = E_{t−1}·relax + gain·(L1 pointer travel)_t (+ sensor noise), refit, and check
// the recovered params — the browserless mirror of the harness/gl-gate.js fixture run.
function displacementUploads({ relax = 0.9, gain = 0.1, radius = 3.5, frames = 500, dt = 16.7, noiseAmp = 0.01, energyOf = null }) {
  const pointer = [];
  const series = [];
  let E = 0;
  let px = 200;
  let py = 300;
  for (let i = 0; i < frames; i++) {
    const t = 1000 + i * dt;
    let step = 0;
    if (i > 5 && i < 260) {
      const dx = 9;
      const dy = i % 40 < 20 ? 4 : -4;
      px += dx;
      py += dy;
      step = Math.abs(dx) + Math.abs(dy);
    }
    pointer.push({ t, x: px, y: py });
    E = energyOf ? energyOf(i, E) : E * relax + gain * step;
    const noisy = Math.max(0, E * (1 + noise(noiseAmp)));
    series.push({
      t,
      sumAbs: noisy,
      maxAbs: noisy / 30,
      n: 1024,
      comps: 2,
      cx: 16,
      cy: 16,
      spread: E > 0 ? +((radius / Math.SQRT2) * (1 + noise(0.05))).toFixed(3) : null,
    });
  }
  return {
    uploads: { textures: [{ tex: 2, src: 'main', w: 32, h: 32, inits: 1, updates: frames, dynamic: true, channels: 2, series }], capped: false },
    pointer,
  };
}

test('recovers displacement relaxation/gain/radius from a noisy upload-stats series', () => {
  const { uploads, pointer } = displacementUploads({ relax: 0.9, gain: 0.1, radius: 3.5 });
  const fit = fitDisplacement({ uploads, pointer, uniforms: { uImage: 0, uDisplacement: 0.015, uAberration: 0.15 } });
  assert.equal(fit.ok, true, `warnings: ${JSON.stringify(fit.warnings)}`);
  assert.equal(fit.model.kind, 'pointer-displacement');
  assert.deepEqual({ w: fit.model.grid.w, h: fit.model.grid.h }, { w: 32, h: 32 });
  const rErr = Math.abs(fit.model.decay.relaxation - 0.9) / 0.9;
  assert.ok(rErr < 0.03, `relaxation ${fit.model.decay.relaxation} (${(rErr * 100).toFixed(1)}% off)`);
  const gErr = Math.abs(fit.model.gain - 0.1) / 0.1;
  assert.ok(gErr < 0.1, `gain ${fit.model.gain} (${(gErr * 100).toFixed(1)}% off)`);
  const radErr = Math.abs(fit.model.radius.radiusCells - 3.5) / 3.5;
  assert.ok(radErr < 0.1, `radius ${fit.model.radius.radiusCells} (${(radErr * 100).toFixed(1)}% off)`);
  assert.equal(fit.model.amplitude.displacement.value, 0.015);
  assert.equal(fit.model.amplitude.aberration.value, 0.15);
  assert.ok(fit.replay.nrmse < 0.05, `energy replay nRMSE ${fit.replay.nrmse}`);
  assert.ok(fit.replay.confidence > 0.75, `confidence ${fit.replay.confidence}`);
});

test('recovers the pointer-follower τ when injection is smoothed (live-site shape)', () => {
  // injection driven by a τ=100ms position follower of the pointer, like the framer
  // pixel-distortion component — raw-travel attribution over-injects at reversals
  const relax = 0.93;
  const gain = 4;
  const tau = 100;
  const dt = 16.7;
  const frames = 500;
  const pointer = [];
  const series = [];
  let E = 0;
  let px = 200;
  let py = 300;
  let fx = px;
  let fy = py;
  for (let i = 0; i < frames; i++) {
    const t = 1000 + i * dt;
    if (i > 5 && i < 260) {
      px += i % 80 < 40 ? 12 : -12; // hard reversals — where raw travel fails
      py += 3;
    }
    pointer.push({ t, x: px, y: py });
    const a = 1 - Math.exp(-dt / tau);
    const nfx = fx + (px - fx) * a;
    const nfy = fy + (py - fy) * a;
    const dS = Math.abs(nfx - fx) + Math.abs(nfy - fy);
    fx = nfx;
    fy = nfy;
    E = E * relax + gain * dS;
    const noisy = Math.max(0, E * (1 + noise(0.01)));
    series.push({ t, sumAbs: noisy, maxAbs: noisy / 30, n: 720, comps: 4, cx: 18, cy: 10, spread: E > 0 ? 3.2 : null });
  }
  const uploads = { textures: [{ tex: 6, src: 'main', w: 36, h: 20, inits: 1, updates: frames, dynamic: true, channels: 4, series }], capped: false };
  const fit = fitDisplacement({ uploads, pointer, uniforms: {} });
  assert.equal(fit.ok, true, `warnings: ${JSON.stringify(fit.warnings)}`);
  assert.ok(fit.model.pointerFollower, 'follower not detected');
  assert.equal(fit.model.pointerFollower.tauMs, 100, `τ ${fit.model.pointerFollower.tauMs}`);
  const rErr = Math.abs(fit.model.decay.relaxation - relax) / relax;
  assert.ok(rErr < 0.03, `relaxation ${fit.model.decay.relaxation}`);
  const gErr = Math.abs(fit.model.gain - gain) / gain;
  assert.ok(gErr < 0.15, `gain ${fit.model.gain} (${(gErr * 100).toFixed(0)}% off)`);
  assert.ok(fit.replay.nrmse < 0.05, `energy replay nRMSE ${fit.replay.nrmse}`);
});

test('displacement refuses a non-decaying grid (constant energy)', () => {
  const { uploads, pointer } = displacementUploads({ energyOf: () => 5, noiseAmp: 0 });
  const fit = fitDisplacement({ uploads, pointer, uniforms: {} });
  assert.equal(fit.ok, false);
  assert.ok(fit.warnings.some((w) => /decay/i.test(w)), `warnings: ${JSON.stringify(fit.warnings)}`);
});

test('displacement refuses energy uncorrelated with the pointer', () => {
  // injections land while the pointer RESTS (i 300–350); nothing while it moves
  const { uploads, pointer } = displacementUploads({
    frames: 600,
    noiseAmp: 0.005,
    energyOf: (i, E) => E * 0.9 + (i >= 300 && i < 350 ? 2 : 0),
  });
  const fit = fitDisplacement({ uploads, pointer, uniforms: {} });
  assert.equal(fit.ok, false);
  assert.ok(
    fit.warnings.some((w) => /uncorrelated|non-positive gain/i.test(w)),
    `warnings: ${JSON.stringify(fit.warnings)}`,
  );
});

test('displacement refuses when no dynamic float texture exists', () => {
  const uploads = { textures: [{ tex: 1, src: 'main', w: 256, h: 256, inits: 1, updates: 0, dynamic: false, channels: null, series: [] }], capped: false };
  assert.equal(pickDynamicFloatTexture(uploads), null);
  const fit = fitDisplacement({ uploads, pointer: [], uniforms: {} });
  assert.equal(fit.ok, false);
  assert.ok(fit.warnings.some((w) => /no dynamic float data texture/i.test(w)), `warnings: ${JSON.stringify(fit.warnings)}`);
});

test('pickDynamicFloatTexture prefers the most-updated stats-carrying texture', () => {
  const mk = (tex, updates) => ({
    tex, src: 'main', w: 32, h: 32, inits: 1, updates, dynamic: updates >= 5, channels: 2,
    series: Array.from({ length: updates }, (_, i) => ({ t: 1000 + i * 16, sumAbs: 1, maxAbs: 0.1, n: 1024, comps: 2, cx: 16, cy: 16, spread: 2 })),
  });
  const picked = pickDynamicFloatTexture({ textures: [mk(1, 8), mk(2, 300), mk(3, 4)], capped: false });
  assert.equal(picked.tex, 2);
});

// mindmarket rail shape (targets/mindmarket/benchmark/motion/16-rail3-blocked-loop-path-
// FINDING.txt): an optional init transient — +483px per ~10ms sample up to +17874, hard
// sweep back to −1188 — then clean constant velocity. `velocity` is SIGNED px/s.
function railTrace({ velocity = 61.65, dt = 10, steadyMs = 5000, transient = true, noiseAmp = 0.3, base = 0 }) {
  const samples = [];
  let t = 1000;
  let v0 = base;
  if (transient) {
    for (let v = base; v <= 17874; v += 483) { samples.push({ t, v }); t += dt; }
    for (let v = 17874 - 2400; v >= -1188; v -= 2400) { samples.push({ t, v }); t += dt; }
    v0 = -1188;
  }
  for (let tt = 0; tt <= steadyMs; tt += dt) {
    samples.push({ t: t + tt, v: v0 + velocity * (tt / 1000) + noise(noiseAmp) });
  }
  return samples;
}

test('marquee: fits the steady rail ignoring the init transient (mindmarket rail shape)', () => {
  const samples = railTrace({ transient: true });
  const fit = fitChannel(samples, null, { channel: 'tx', triggerAt: 995 });
  assert.equal(fit.kind, 'marquee', `chose ${fit.kind} (nrmse ${fit.nrmse?.toFixed(4)})`);
  const vErr = Math.abs(fit.params.velocityPxPerSec - 61.65) / 61.65;
  assert.ok(vErr < 0.05, `velocity ${fit.params.velocityPxPerSec} (${(vErr * 100).toFixed(1)}% off)`);
  assert.equal(fit.params.direction, 1);
  assert.equal(fit.params.axis, 'x');
  assert.ok(fit.confidence > 0.85, `confidence ${fit.confidence}`);
  // the fit anchored PAST the ~440ms transient, on the steady segment
  assert.ok(fit.steadyStartMs >= 1400, `steadyStartMs ${fit.steadyStartMs} inside the transient`);
  // tween/spring must lose by a wide margin on rail-shaped traces
  for (const alt of fit.alternatives.filter((a) => a.kind === 'tween' || a.kind === 'spring')) {
    assert.ok(alt.nrmse > 10 * fit.nrmse, `${alt.kind} nrmse ${alt.nrmse} too close to marquee ${fit.nrmse.toFixed(4)}`);
  }
});

test('marquee: clean negative rail on ty maps to axis y, direction −1', () => {
  const samples = railTrace({ velocity: -36.5, transient: false, steadyMs: 6000 });
  const fit = fitChannel(samples, null, { channel: 'ty' });
  assert.equal(fit.kind, 'marquee', `chose ${fit.kind}`);
  assert.equal(fit.params.direction, -1);
  assert.equal(fit.params.axis, 'y');
  const vErr = Math.abs(fit.params.velocityPxPerSec - 36.5) / 36.5;
  assert.ok(vErr < 0.05, `velocity ${fit.params.velocityPxPerSec} (${(vErr * 100).toFixed(1)}% off)`);
});

// Wrapping belt (mindmarket rail-3 under scroll-through, targets/mindmarket/benchmark/
// motion/34-retrace-rail-3-marquee.txt): the translate snaps back by ~one belt width
// (period) each time the loop resets. Optionally opens with a scroll-BOOSTED prefix
// (~3x intrinsic velocity while the page scrolls) before settling.
function wrappingRailTrace({ velocity = 61.65, period = 400, dt = 10, steadyMs = 20000, boostMs = 0, boostFactor = 3.1, noiseAmp = 0.3, base = 0 }) {
  const samples = [];
  let v = base;
  let t = 1000;
  const step = (ms, pxPerSec) => {
    for (let tt = 0; tt < ms; tt += dt) {
      v += pxPerSec * (dt / 1000);
      if (v - base >= period) v -= period; // loop reset: snap back one belt width
      samples.push({ t, v: v + noise(noiseAmp) });
      t += dt;
    }
  };
  if (boostMs > 0) step(boostMs, velocity * boostFactor);
  step(steadyMs, velocity);
  return samples;
}

test('marquee: bridges loop resets — wraps must not cap the steady run', () => {
  const samples = wrappingRailTrace({ velocity: 61.65, period: 400, steadyMs: 20000 });
  const fit = fitMarquee(samples, { axis: 'x' });
  assert.ok(fit, 'wrapping belt did not fit marquee');
  const vErr = Math.abs(fit.params.velocityPxPerSec - 61.65) / 61.65;
  assert.ok(vErr < 0.05, `velocity ${fit.params.velocityPxPerSec} (${(vErr * 100).toFixed(1)}% off)`);
  assert.equal(fit.params.direction, 1);
  assert.ok(fit.loopResets >= 2, `expected >=2 bridged resets, saw ${fit.loopResets || 0}`);
  // steadyMs must span across the wraps, not stop at the first one
  assert.ok(fit.steadyMs > 15000, `steady run ${fit.steadyMs}ms stopped at a wrap`);
  // replay starts at the RAW position of the steady onset, not the unwrapped extrapolation
  assert.ok(fit.valueFrom < 400 + 5, `valueFrom ${fit.valueFrom} escaped the belt period`);
});

test('marquee: scroll-boosted prefix + wrapping steady tail anchors on the intrinsic velocity', () => {
  // rail-3 shape: ~10s at ~3x velocity while the scroll-through traverses, then the
  // intrinsic constant-velocity tail. Period 900 puts wraps in BOTH regimes and splits
  // the 20s tail so that without reset-bridging no piece can dominate the window.
  const samples = wrappingRailTrace({ velocity: 61.65, period: 900, steadyMs: 20000, boostMs: 10000, boostFactor: 3.1 });
  const fit = fitMarquee(samples, { axis: 'x' });
  assert.ok(fit, 'boosted+wrapping rail did not fit marquee');
  const vErr = Math.abs(fit.params.velocityPxPerSec - 61.65) / 61.65;
  assert.ok(vErr < 0.05, `velocity ${fit.params.velocityPxPerSec} anchored off the intrinsic regime (${(vErr * 100).toFixed(1)}% off)`);
  assert.ok(fit.steadyStartMs >= 10500, `steadyStartMs ${fit.steadyStartMs} includes the boosted prefix`);
});

test('marquee does NOT fire on genuine tweens, springs, or short linear moves', () => {
  const ease = bezierTrace({ x1: 0.42, y1: 0, x2: 0.58, y2: 1, dur: 800, from: 0, to: 150, noiseAmp: 0.2 });
  assert.equal(fitChannel(ease, null, { channel: 'tx' }).kind, 'tween');
  assert.equal(fitMarquee(ease), null);
  const spr = springTrace({ stiffness: 200, damping: 10, from: 0, to: 200, ms: 2500, noiseAmp: 0.5 });
  assert.equal(fitMarquee(spr), null);
  // a LINEAR tween is constant velocity too — but it stops; the steady run is too short
  const lin = bezierTrace({ x1: 0, y1: 0, x2: 1, y2: 1, dur: 600, from: 0, to: 300, noiseAmp: 0.2 });
  assert.equal(fitChannel(lin, null, { channel: 'tx' }).kind, 'tween');
  assert.equal(fitMarquee(lin), null);
});

test('marquee replay is constant velocity; adjusted params change it', () => {
  const fit = fitChannel(railTrace({ transient: true }), null, { channel: 'tx' });
  assert.equal(fit.kind, 'marquee', `chose ${fit.kind}`);
  const f = structuredClone(fit);
  f.delayMs = 0; // bundle fits are delay-zeroed
  assert.ok(Math.abs(evalFitAt(f, 0) - f.valueFrom) < 1e-9, 'replay starts at valueFrom');
  const v1 = evalFitAt(f, 1000) - evalFitAt(f, 0);
  const v2 = evalFitAt(f, 3000) - evalFitAt(f, 2000);
  assert.ok(Math.abs(v1 - f.params.direction * f.params.velocityPxPerSec) < 1e-6, `replay slope ${v1} px/s`);
  assert.ok(Math.abs(v1 - v2) < 1e-9, `velocity not constant: ${v1} vs ${v2}`);
  // the adjust/tune path writes params — the replay must follow them
  f.params.velocityPxPerSec = 100;
  f.params.direction = -1;
  const w = evalFitAt(f, 1500) - evalFitAt(f, 500);
  assert.ok(Math.abs(w - -100) < 1e-6, `adjusted replay slope ${w} px/s`);
});

test('detectStagger finds constant offsets', () => {
  const mk = (delay) => ({ channel: 'tx', path: `#c${delay}`, fit: { kind: 'tween', delayMs: delay } });
  const staggers = detectStagger([mk(10), mk(130), mk(250)]);
  assert.equal(staggers.length, 1);
  assert.ok(Math.abs(staggers[0].offsetMs - 120) <= 1, `offset ${staggers[0].offsetMs}`);
  assert.deepEqual(detectStagger([mk(10), mk(400), mk(450)]), []);
});

process.exit(failed ? 1 : 0);
