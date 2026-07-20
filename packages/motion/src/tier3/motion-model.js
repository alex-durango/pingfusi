// Forward motion models ported EXACTLY from motiondivision/motion v12.42.2 (see
// docs/prior-art/motion-spring.md). The fitter inverts these; because candidates are
// regenerated with the same math, fitted params round-trip through Motion unchanged.

// t in ms; velocity in px/s (positive = value increasing); returns the value at t.
export function springPosition(
  t,
  { stiffness = 100, damping = 10, mass = 1, velocity = 0, origin = 0, target = 1 },
) {
  const delta = target - origin;
  const v0 = -velocity / 1000; // Motion's internal px/ms, sign-flipped
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const omega = Math.sqrt(stiffness / mass) / 1000; // rad/ms
  const E = Math.exp(-zeta * omega * t);
  if (Math.abs(zeta - 1) < 1e-4) {
    // critically damped (also used as the numerically safe limit of both branches)
    return target - E * (delta + (v0 + omega * delta) * t);
  }
  if (zeta < 1) {
    const omegaD = omega * Math.sqrt(1 - zeta * zeta);
    const A = (v0 + zeta * omega * delta) / omegaD;
    return target - E * (A * Math.sin(omegaD * t) + delta * Math.cos(omegaD * t));
  }
  const omegaD = omega * Math.sqrt(zeta * zeta - 1);
  const f = Math.min(omegaD * t, 300);
  return (
    target - (E * ((v0 + zeta * omega * delta) * Math.sinh(f) + omegaD * delta * Math.cosh(f))) / omegaD
  );
}

// Motion's rest detection: |v| ≤ restSpeed (px/s) and |target − x| ≤ restDelta (px).
// Duration is discovered by stepping (Motion steps 50ms; we step 8ms for tighter bounds).
export function springSettleDuration(params, { restSpeed = 2, restDelta = 0.5, maxMs = 20000 } = {}) {
  let prev = springPosition(0, params);
  for (let t = 8; t <= maxMs; t += 8) {
    const x = springPosition(t, params);
    const v = ((x - prev) / 8) * 1000; // px/s
    if (Math.abs(v) <= restSpeed && Math.abs(params.target - x) <= restDelta) return t;
    prev = x;
  }
  return maxMs;
}

// Cubic bezier easing — Motion's solver (binary subdivision, 12 iters, 1e-7).
const SUBDIV_PRECISION = 1e-7;
const SUBDIV_ITERS = 12;

function calcBezier(t, a1, a2) {
  return (((1.0 - 3.0 * a2 + 3.0 * a1) * t + (3.0 * a2 - 6.0 * a1)) * t + 3.0 * a1) * t;
}

export function cubicBezier(x1, y1, x2, y2) {
  if (x1 === y1 && x2 === y2) return (t) => t;
  const getTForX = (x) => {
    let lower = 0;
    let upper = 1;
    let currentT;
    let currentX;
    let i = 0;
    do {
      currentT = lower + (upper - lower) / 2;
      currentX = calcBezier(currentT, x1, x2) - x;
      if (currentX > 0) upper = currentT;
      else lower = currentT;
    } while (Math.abs(currentX) > SUBDIV_PRECISION && ++i < SUBDIV_ITERS);
    return currentT;
  };
  return (t) => (t === 0 || t === 1 ? t : calcBezier(getTForX(t), y1, y2));
}
