import { springPosition, springSettleDuration, cubicBezier } from './motion-model.js';
import { nelderMead } from './nelder-mead.js';

// Deterministic curve fitting: no AI anywhere. Each animated channel (tx, ty, opacity…)
// is a time series [{t, v}]; we fit candidate motion models, and the model with the
// lowest normalized residual wins. The residual IS the confidence signal — a bad fit is
// the pipeline detecting its own ignorance (and, later, the review-round trigger).

const clamp = (lo, hi, v) => Math.min(hi, Math.max(lo, v));

// relEps is deliberately tight (0.5%): computed-style samples are numerically exact, and
// a loose threshold trims the slow head/tail of ease-like curves, re-parameterizing time
// and biasing the fit.
export function segment(samples, { relEps = 0.005 } = {}) {
  if (!samples || samples.length < 4) return null;
  const values = samples.map((s) => s.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (!(range > 0) || !isFinite(range)) return null;
  const eps = range * relEps;
  const first = values[0];
  const last = values[values.length - 1];
  let start = samples.findIndex((s) => Math.abs(s.v - first) > eps);
  if (start === -1) return null;
  start = Math.max(0, start - 2);
  let end = values.length - 1;
  while (end > start && Math.abs(values[end] - last) <= eps) end--;
  end = Math.min(values.length - 1, end + 2);
  if (end - start < 3) return null;
  return { start, end, t0: samples[start].t, t1: samples[end].t, range };
}

function rmse(pred, actual) {
  let sum = 0;
  for (let i = 0; i < actual.length; i++) {
    const d = pred[i] - actual[i];
    sum += d * d;
  }
  return Math.sqrt(sum / actual.length);
}

// Head-jump detection: the first movement arriving as one large step means the engine's
// clock ran ahead of its first paint — the recording starts mid-flight. A jump is
// anomalous relative to the steps that FOLLOW it (a skip is ~skipMs/frameMs times the
// per-frame step) — never relative to range alone: a clean stiff spring's first sampled
// step can exceed any range fraction simply because it accelerates hard, but then its
// next steps are even bigger, not smaller.
export function detectHeadJump(samples, { relEps = 0.01, ratio = 3, minFrac = 0.03 } = {}) {
  const vals = samples.map((s) => s.v);
  const range = Math.max(...vals) - Math.min(...vals);
  if (!(range > 0)) return null;
  const idx = samples.findIndex((s) => Math.abs(s.v - samples[0].v) > range * relEps);
  if (idx <= 0 || idx + 3 >= samples.length) return null;
  const step = Math.abs(samples[idx].v - samples[idx - 1].v);
  if (step <= range * minFrac) return null;
  let maxNext = 0;
  for (let i = idx + 1; i <= Math.min(idx + 3, samples.length - 1); i++) {
    maxNext = Math.max(maxNext, Math.abs(samples[i].v - samples[i - 1].v));
  }
  if (step <= ratio * maxNext) return null;
  return { postIdx: idx, preValue: samples[idx - 1].v, tJump: samples[idx].t };
}

// active: samples of just the movement segment (t0..t1). For jump-headed recordings the
// tween's initial condition is a TIME SHIFT (the spring's is velocity): fit a virtual
// head tHead so the curve spans [tJump − tHead, tEnd] with the true (pre-jump) origin —
// fitted control points stay directly comparable to the author's curve.
export function fitBezierTween(active, { jump = null } = {}) {
  const post = jump ? active.slice(jump.postIdx) : active;
  if (post.length < 4) return null;
  const v0 = jump ? jump.preValue : post[0].v;
  const v1 = post[post.length - 1].v;
  const tEnd = post[post.length - 1].t;
  const tStart = jump ? jump.tJump : post[0].t;
  if (v0 === v1 || !(tEnd > tStart)) return null;
  const ss = post.map((s) => (s.v - v0) / (v1 - v0));

  const evalParams = (params) => {
    const [x1, y1, x2, y2] = params;
    const tHead = jump ? clamp(0, 250, params[4]) : 0;
    const t0v = tStart - tHead;
    const dur = tEnd - t0v;
    const fn = cubicBezier(clamp(0, 1, x1), y1, clamp(0, 1, x2), y2);
    return rmse(post.map((s) => fn(clamp(0, 1, (s.t - t0v) / dur))), ss);
  };
  const CURVES = [
    [0.25, 0.1, 0.25, 1],
    [0.42, 0, 0.58, 1],
    [0, 0, 1, 1],
    [0.16, 1, 0.3, 1],
    [0.34, 1.56, 0.64, 1], // back-out overshoot
    [0.68, -0.6, 0.32, 1.6], // back-in-out
  ];
  const RESTARTS = jump ? CURVES.flatMap((c) => [[...c, 40], [...c, 90]]) : CURVES;
  let best = null;
  for (const start of RESTARTS) {
    const r = nelderMead(evalParams, start, { maxIterations: jump ? 500 : 300 });
    if (!best || r.score < best.score) best = r;
  }
  const [x1, y1, x2, y2] = best.params;
  const tHead = jump ? clamp(0, 250, best.params[4]) : 0;
  const dur = tEnd - (tStart - tHead);
  return {
    kind: 'tween',
    // Motion's exact transition schema (canonical semantic vocabulary, docs/SCHEMA.md);
    // durations in seconds per Motion convention
    transition: {
      type: 'tween',
      duration: +(dur / 1000).toFixed(4),
      ease: [+clamp(0, 1, x1).toFixed(4), +y1.toFixed(4), +clamp(0, 1, x2).toFixed(4), +y2.toFixed(4)],
    },
    valueFrom: v0,
    valueTo: v1,
    ...(jump ? { virtualStartT: tStart - tHead, headMs: Math.round(tHead) } : {}),
    nrmse: best.score, // ss is normalized, so rmse is already relative
  };
}

// tail: samples from onset through settle (spring needs the tail to see the rest state).
// Real engines set their clock at play() but first-paint lands frames later, so traces
// often hold a value then JUMP mid-flight. A spring's state is (position, velocity) —
// Motion's velocity field is exactly the second initial condition — so trimming to the
// first MOVING sample and fitting (stiffness, damping, velocity) makes jumped starts fit
// exactly instead of approximately.
export function fitSpringModel(tail, { jump = null } = {}) {
  // Velocity is strictly a JUMP-case parameter: on a hitch-started recording the trace's
  // initial slope IS the physical v0, so (k, c, v0) fits it exactly. On clean traces the
  // initial velocity is 0 by construction — fitting it anyway is degenerate (a stiff
  // spring's early SLOPE is large while its v0 is zero) — so no jump → 2-param fit.
  const sub = jump ? tail.slice(jump.postIdx) : tail;
  if (sub.length < 6) return null;
  const t0 = sub[0].t;
  const origin = sub[0].v;
  const settle = sub.slice(-3).reduce((a, s) => a + s.v, 0) / Math.min(3, sub.length);
  if (origin === settle) return null;
  const range = Math.abs(settle - origin);
  const ts = sub.map((s) => s.t - t0);
  const vs = sub.map((s) => s.v);

  // post-jump slope = physical initial velocity (px/s); only meaningful in the jump case
  const v0est = jump ? ((vs[2] - vs[0]) / (ts[2] - ts[0] || 1)) * 1000 : 0;

  // heuristic initialization from oscillation shape (log-decrement), if any
  const baseInits = [
    [Math.log(100), Math.log(10)],
    [Math.log(500), Math.log(25)],
    [Math.log(170), Math.log(26)],
    [Math.log(300), Math.log(60)],
  ];
  const extrema = [];
  for (let i = 1; i < sub.length - 1; i++) {
    const a = vs[i] - settle;
    if ((vs[i] - vs[i - 1]) * (vs[i + 1] - vs[i]) < 0 && Math.abs(a) > range * 0.02) {
      extrema.push({ t: ts[i], a: Math.abs(a) });
    }
  }
  if (extrema.length >= 2) {
    const periodMs = 2 * (extrema[1].t - extrema[0].t);
    const omegaD = (2 * Math.PI) / (periodMs / 1000); // rad/s
    const delta = Math.log(extrema[0].a / extrema[1].a);
    const zeta = delta / Math.sqrt(4 * Math.PI * Math.PI + delta * delta);
    const omega = omegaD / Math.sqrt(Math.max(1e-6, 1 - zeta * zeta));
    const k = omega * omega; // mass 1
    const c = 2 * zeta * Math.sqrt(k);
    if (isFinite(k) && k > 0 && isFinite(c) && c > 0) baseInits.unshift([Math.log(k), Math.log(c)]);
  }
  const inits = jump ? baseInits.map((p) => [...p, v0est]) : baseInits;

  const evalParams = (params) => {
    const [lk, lc] = params;
    const vel = jump ? params[2] : 0;
    const p = { stiffness: Math.exp(lk), damping: Math.exp(lc), mass: 1, velocity: vel, origin, target: settle };
    let sum = 0;
    for (let i = 0; i < ts.length; i++) {
      const d = springPosition(ts[i], p) - vs[i];
      sum += d * d;
    }
    return Math.sqrt(sum / ts.length) / range;
  };
  let best = null;
  for (const startParams of inits) {
    const r = nelderMead(evalParams, startParams, { maxIterations: jump ? 400 : 300 });
    if (!best || r.score < best.score) best = r;
  }
  const stiffness = +Math.exp(best.params[0]).toFixed(2);
  const damping = +Math.exp(best.params[1]).toFixed(2);
  const velocity = jump ? +best.params[2].toFixed(1) : 0; // px/s, Motion convention
  // fitted against Motion's own spring generator, so these ARE Motion params — no mapping
  const transition = { type: 'spring', stiffness, damping, mass: 1, velocity };
  return {
    kind: 'spring',
    transition,
    settleMs: springSettleDuration({ stiffness, damping, mass: 1, velocity, origin, target: settle }),
    valueFrom: origin,
    valueTo: settle,
    ...(jump ? { onsetTrimMs: Math.round(t0 - tail[0].t) } : {}),
    nrmse: best.score,
  };
}

// scroll linkage: regress the channel against scrollY. Samples are mutation-timed and
// frames are rAF-timed, so scrollY is interpolated at each sample's timestamp.
export function fitScrollLinear(samples, frames) {
  if (!frames || frames.length < 4) return null;
  const scrollAt = (t) => {
    if (t <= frames[0].t) return frames[0].scrollY;
    const last = frames[frames.length - 1];
    if (t >= last.t) return last.scrollY;
    let lo = 0;
    let hi = frames.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = frames[lo];
    const b = frames[hi];
    const p = (t - a.t) / (b.t - a.t || 1);
    return a.scrollY + (b.scrollY - a.scrollY) * p;
  };
  const pairs = samples.map((s) => ({ x: scrollAt(s.t), y: s.v }));
  if (pairs.length < 8) return null;
  const xs = pairs.map((p) => p.x);
  const scrollRange = Math.max(...xs) - Math.min(...xs);
  if (scrollRange < 50) return null; // no meaningful scroll happened
  const n = pairs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = pairs.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const p of pairs) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
  }
  if (!(sxx > 0) || !(syy > 0)) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = (sxy * sxy) / (sxx * syy);
  const yRange = Math.sqrt(syy / n) * 2 || 1;
  let sum = 0;
  for (const p of pairs) {
    const d = slope * p.x + intercept - p.y;
    sum += d * d;
  }
  return {
    kind: 'scroll-linear',
    // motion-kit extension: Motion has no declarative scroll-linear transition shape,
    // so the linkage lives beside (not inside) `transition` — see docs/SCHEMA.md
    link: { kind: 'scroll-linear', slope: +slope.toFixed(5), intercept: +intercept.toFixed(2), r2: +r2.toFixed(4) },
    nrmse: Math.sqrt(sum / n) / yRange,
  };
}

// Pointer pursuit: x'(t) = (target(t) − x(t))/τ — the continuous form of the per-frame
// lerp `pos += (target − pos) * k` (τ = −h/ln(1−k) at frame interval h ms). target(t) is
// the RECORDED pointer axis (what the page saw) plus a constant offset (the element's
// base position under the cursor). Competes only when a pointer series exists.
const POINTER_AXIS = { tx: 'x', ty: 'y' };

// Regenerate the pursuit trajectory over the active samples: exact exponential update
// per ≤4ms sub-step against the piecewise-linear pointer series, starting from the first
// recorded value. The fitter's objective and the gate's scoring both call THIS — the
// gate scores the regenerated curve, not param distance, by construction.
export function pursuitTrajectory(active, pointer, { tau, offset = 0, axis = 'x' }) {
  const targetAt = (t) => {
    if (t <= pointer[0].t) return pointer[0][axis];
    const last = pointer[pointer.length - 1];
    if (t >= last.t) return last[axis];
    let lo = 0;
    let hi = pointer.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pointer[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = pointer[lo];
    const b = pointer[hi];
    const p = (t - a.t) / (b.t - a.t || 1);
    return a[axis] + (b[axis] - a[axis]) * p;
  };
  let x = active[0].v;
  const pred = [x];
  for (let i = 1; i < active.length; i++) {
    let t = active[i - 1].t;
    const tEnd = active[i].t;
    while (t < tEnd) {
      const dt = Math.min(4, tEnd - t);
      const T = targetAt(t + dt / 2) + offset;
      x = T + (x - T) * Math.exp(-dt / tau);
      t += dt;
    }
    pred.push(x);
  }
  return pred;
}

export function fitPointerFollow(active, pointer, { axis }) {
  if (!pointer || pointer.length < 8 || !active || active.length < 8) return null;
  const ps = pointer.map((p) => p[axis]);
  if (Math.max(...ps) - Math.min(...ps) < 20) return null; // pointer barely moved on this axis
  const vs = active.map((s) => s.v);
  const range = Math.max(...vs) - Math.min(...vs);
  if (!(range > 0)) return null;
  // steady state after the pointer rests: x → target + offset, so seed from the tails
  const offset0 = vs[vs.length - 1] - pointer[pointer.length - 1][axis];
  const LTAU = [Math.log(4), Math.log(4000)];
  const evalParams = (params) => {
    const tau = Math.exp(clamp(LTAU[0], LTAU[1], params[0]));
    return rmse(pursuitTrajectory(active, pointer, { tau, offset: params[1], axis }), vs) / range;
  };
  let best = null;
  for (const tau0 of [40, 120, 350]) {
    const r = nelderMead(evalParams, [Math.log(tau0), offset0], { maxIterations: 300 });
    if (!best || r.score < best.score) best = r;
  }
  const tau = +Math.exp(clamp(LTAU[0], LTAU[1], best.params[0])).toFixed(1);
  return {
    kind: 'pointer-follow',
    // motion-kit extension (like scroll-linear): pursuit is a linkage to live pointer
    // input, not a Motion transition, so it lives beside `transition` — docs/SCHEMA.md.
    // k60 = the equivalent per-frame lerp factor at 60fps, for authors.
    link: {
      kind: 'pointer-follow',
      axis,
      tau,
      offset: +best.params[1].toFixed(2),
      k60: +(1 - Math.exp(-1000 / 60 / tau)).toFixed(4),
    },
    nrmse: best.score,
  };
}

// Marquee/ticker rails: constant-velocity translation that never settles. Real rails
// (mindmarket's Astro Rail, targets/mindmarket/benchmark/motion/16-…-FINDING.txt) OPEN
// with a wild init transient (+483px per ~10ms sample up to +17874, sweep back to
// −1188) before settling to clean constant velocity (~61.65 px/s, r2 ~1) — so the fit
// is a robust linear regression on the LONGEST steady constant-velocity run, never the
// whole active window. Params are the marquee contract every stream binds to:
// { velocityPxPerSec, direction: 1|-1, axis: 'x'|'y' }.
const MARQUEE_AXIS = { tx: 'x', ty: 'y' };
const MARQUEE_MIN_STEADY_MS = 1200; // tween/spring scales live well below this
const MARQUEE_MIN_TRAVEL = 100; // px over the steady run
const MARQUEE_MIN_VELOCITY = 5; // px/s — below this it's drift, not a marquee
const MARQUEE_MIN_R2 = 0.98;

function linearFit(pts) {
  const n = pts.length;
  const mt = pts.reduce((a, s) => a + s.t, 0) / n;
  const mv = pts.reduce((a, s) => a + s.v, 0) / n;
  let stt = 0;
  let stv = 0;
  let svv = 0;
  for (const s of pts) {
    stt += (s.t - mt) ** 2;
    stv += (s.t - mt) * (s.v - mv);
    svv += (s.v - mv) ** 2;
  }
  if (!(stt > 0) || !(svv > 0)) return null;
  const slope = stv / stt; // px/ms
  return { slope, intercept: mv - slope * mt, r2: (stv * stv) / (stt * svv) };
}

// A looping belt periodically snaps its translate back by ~one belt width in a single
// sample interval — the loop reset of the marquee MECHANISM, not a change in velocity.
// Left in the series, every reset caps the longest steady run (mindmarket rail-3 under
// scroll-through: wraps every ~1.5kpx cut the 20s steady tail into pieces that can never
// dominate the active window — targets/mindmarket/benchmark/motion/34-retrace-rail-3-
// marquee.txt). Unwrap ONLY the against-the-flow, ≳period jumps into a continuous line
// for scanning/regression; each sample keeps its cumulative offset so the caller can
// re-anchor valueFrom to the RAW position at the steady onset. Init transients stay
// untouched: their staircase runs WITH the flow, and their sweep-back happens while the
// observed range is transient-inflated, far above the 0.35·range wrap threshold.
function unwrapLoopResets(active) {
  const deltas = [];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < active.length; i++) {
    const s = active[i];
    if (s.v < lo) lo = s.v;
    if (s.v > hi) hi = s.v;
    if (i) deltas.push(s.v - active[i - 1].v);
  }
  const sorted = [...deltas].sort((a, b) => a - b);
  const medDelta = sorted[sorted.length >> 1] || 0;
  const dir = Math.sign(medDelta); // dominant flow from the median inter-sample delta (robust to spikes)
  if (!dir) return { work: active, wraps: 0 };
  const absSorted = deltas.map(Math.abs).sort((a, b) => a - b);
  const medAbs = absSorted[absSorted.length >> 1] || 0;
  // ≥35% of the observed range in ONE interval (a wrap is ~a full period), never below
  // 40px or 8× the typical step — sub-period jitter and spring overshoots stay untouched
  const threshold = Math.max((hi - lo) * 0.35, medAbs * 8, 40);
  let cum = 0;
  let wraps = 0;
  const work = new Array(active.length);
  work[0] = { t: active[0].t, v: active[0].v, off: 0 };
  for (let i = 1; i < active.length; i++) {
    const dv = active[i].v - active[i - 1].v;
    if (Math.sign(dv) === -dir && Math.abs(dv) >= threshold) {
      cum -= dv;
      wraps++;
    }
    work[i] = { t: active[i].t, v: active[i].v + cum, off: cum };
  }
  return wraps ? { work, wraps } : { work: active, wraps: 0 };
}

export function fitMarquee(active, { axis = 'x' } = {}) {
  if (!active || active.length < 12) return null;
  const tSpan = active[active.length - 1].t - active[0].t;
  if (!(tSpan >= MARQUEE_MIN_STEADY_MS)) return null;
  // Scan and regress on the reset-bridged series; raw positions stay reachable via .off.
  const { work, wraps } = unwrapLoopResets(active);
  // Smoothed velocities over a ~120ms spanning window: per-interval velocity at ~10ms
  // sampling turns sub-pixel sensor noise into ±50px/s spikes, swamping a 60px/s rail.
  const vel = [];
  let j = 0;
  for (let i = 0; i < work.length; i++) {
    while (j < work.length && work[j].t - work[i].t < 120) j++;
    if (j >= work.length) break;
    vel.push({ i, j, v: ((work[j].v - work[i].v) / (work[j].t - work[i].t)) * 1000 });
  }
  if (vel.length < 8) return null;
  // The median velocity is a robust anchor: init transients are huge but brief, so the
  // median lands inside the steady regime (the FINDING transient runs at ±48,000 px/s).
  const sorted = vel.map((x) => x.v).sort((a, b) => a - b);
  const vMed = sorted[sorted.length >> 1];
  if (Math.abs(vMed) < MARQUEE_MIN_VELOCITY) return null;
  const tol = Math.max(Math.abs(vMed) * 0.35, 12);
  let best = null;
  let runStart = -1;
  for (let k = 0; k <= vel.length; k++) {
    const steady = k < vel.length && Math.abs(vel[k].v - vMed) <= tol;
    if (steady && runStart === -1) runStart = k;
    if (!steady && runStart !== -1) {
      const cand = { a: vel[runStart].i, b: vel[k - 1].j };
      if (!best || work[cand.b].t - work[cand.a].t > work[best.b].t - work[best.a].t) best = cand;
      runStart = -1;
    }
  }
  if (!best) return null;
  const run = work.slice(best.a, best.b + 1);
  const runMs = run[run.length - 1].t - run[0].t;
  // A marquee never stops: the steady run must be long, dominate the active window, and
  // reach the end of the recording — genuine tweens/springs/scroll sweeps fail here.
  if (runMs < MARQUEE_MIN_STEADY_MS) return null;
  if (active[active.length - 1].t - run[run.length - 1].t > 250) return null;
  if (runMs / tSpan < 0.55) return null;
  let line = linearFit(run);
  if (!line) return null;
  // one robustness pass: drop >3σ outliers (partial transient bleed at the run head)
  const resid = run.map((s) => s.v - (line.intercept + line.slope * s.t));
  const sigma = Math.sqrt(resid.reduce((a, d) => a + d * d, 0) / run.length);
  if (sigma > 0) {
    const kept = run.filter((_, i) => Math.abs(resid[i]) <= 3 * sigma);
    if (kept.length >= 8 && kept.length < run.length) line = linearFit(kept) || line;
  }
  if (line.r2 < MARQUEE_MIN_R2) return null;
  const velocityPxPerSec = Math.abs(line.slope) * 1000;
  const travel = Math.abs(line.slope) * runMs;
  if (velocityPxPerSec < MARQUEE_MIN_VELOCITY || travel < MARQUEE_MIN_TRAVEL) return null;
  let sum = 0;
  for (const s of run) {
    const d = line.intercept + line.slope * s.t - s.v;
    sum += d * d;
  }
  const t0 = run[0].t;
  return {
    kind: 'marquee',
    // motion-kit extension (like scroll-linear/pointer-follow, but time-replayable):
    // v(t) = valueFrom + direction · velocityPxPerSec · t/1000 from the steady onset
    params: {
      velocityPxPerSec: +velocityPxPerSec.toFixed(2),
      direction: line.slope >= 0 ? 1 : -1,
      axis,
    },
    // re-anchor to the RAW position at the steady onset: regression ran on the
    // reset-bridged line, but replay must start where the element actually was
    valueFrom: +(line.intercept + line.slope * t0 - (run[0].off || 0)).toFixed(2),
    steadyStartMs: Math.round(t0), // trace-clock steady onset — the loop trims to it
    steadyMs: Math.round(runMs),
    r2: +line.r2.toFixed(4),
    ...(wraps ? { loopResets: wraps } : {}), // bridged belt wraps inside the active window
    // fold the transient into delay accounting like a trimmed spring onset
    ...(t0 - active[0].t > 0 ? { onsetTrimMs: Math.round(t0 - active[0].t) } : {}),
    nrmse: Math.sqrt(sum / run.length) / travel,
  };
}

export function confidence(nrmse) {
  return +clamp(0, 1, 1 - 5 * nrmse).toFixed(3);
}

// Absolute per-channel motion floors: below these the "motion" is numeric noise from
// matrix decomposition (seen live: gsap.com svg with sx range 6e-7 fit as a spring at
// confidence 0, triggering a pointless review round). segment()'s range>0 alone lets
// float dust through.
const MIN_MOTION = { tx: 2, ty: 2, tz: 2, sx: 0.02, sy: 0.02, rot: 1, opacity: 0.03 };

// One channel end-to-end: segment, fit all candidate models, lowest residual wins.
export function fitChannel(samples, frames, { triggerAt = null, channel = null, pointer = null } = {}) {
  const seg = segment(samples);
  if (!seg) return null;
  if (channel && MIN_MOTION[channel] != null && seg.range < MIN_MOTION[channel]) return null;
  const active = samples.slice(seg.start, seg.end + 1);
  const candidates = [];
  const jump = detectHeadJump(active); // same jump info for both fitters — fair competition
  const bez = fitBezierTween(active, { jump });
  if (bez) candidates.push(bez);
  const spr = fitSpringModel(samples.slice(seg.start), { jump });
  if (spr) candidates.push(spr);
  const scr = fitScrollLinear(samples, frames);
  if (scr) candidates.push(scr);
  // marquee competes only on translate channels (constant-velocity translation);
  // channel-less calls default to axis 'x' per the contract
  if (!channel || MARQUEE_AXIS[channel]) {
    const mq = fitMarquee(active, { axis: channel ? MARQUEE_AXIS[channel] : 'x' });
    if (mq) candidates.push(mq);
  }
  // pursuit competes only when a pointer series was recorded, per translate channel
  const axis = channel ? POINTER_AXIS[channel] : null;
  if (pointer && axis) {
    const pf = fitPointerFollow(active, pointer, { axis });
    if (pf) candidates.push(pf);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.nrmse - b.nrmse);
  const bestFit = candidates[0];
  let delayMs = triggerAt != null ? Math.max(0, Math.round(seg.t0 - triggerAt)) : null;
  // jump-headed fits re-anchor their own clock: a trimmed spring starts at the jump, a
  // head-fitted tween starts at its virtual origin — fold either into the delay so
  // replay stays time-aligned
  if (bestFit.onsetTrimMs > 0) delayMs = (delayMs ?? 0) + bestFit.onsetTrimMs;
  else if (bestFit.virtualStartT != null && triggerAt != null) {
    delayMs = Math.max(0, Math.round(bestFit.virtualStartT - triggerAt));
  }
  if (bestFit.transition && delayMs != null && delayMs > 5) {
    bestFit.transition.delay = +(delayMs / 1000).toFixed(3); // Motion delay: seconds
  }
  return {
    ...bestFit,
    delayMs,
    confidence: confidence(bestFit.nrmse),
    alternatives: candidates.slice(1).map((c) => ({ kind: c.kind, nrmse: +c.nrmse.toFixed(4) })),
  };
}

// Stagger: same channel fitted on several elements with near-constant onset offsets.
export function detectStagger(fits) {
  const groups = new Map();
  for (const f of fits) {
    if (f.fit?.delayMs == null) continue;
    const g = `${f.channel}:${f.fit.kind}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(f);
  }
  const staggers = [];
  for (const [g, members] of groups) {
    if (members.length < 3) continue;
    const delays = members.map((m) => m.fit.delayMs).sort((a, b) => a - b);
    const diffs = delays.slice(1).map((d, i) => d - delays[i]);
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    if (mean < 20) continue;
    const sd = Math.sqrt(diffs.reduce((a, d) => a + (d - mean) ** 2, 0) / diffs.length);
    if (sd / mean < 0.25) {
      staggers.push({
        group: g,
        elements: members.map((m) => m.path),
        offsetMs: Math.round(mean),
      });
    }
  }
  return staggers;
}
