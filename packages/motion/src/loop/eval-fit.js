import { springPosition, cubicBezier } from '../tier3/motion-model.js';

// Node-side evaluation of a fitted channel at time t (ms) — the same math the replay and
// adjust pages inline as strings. Shared by the loop's clock-shift and the control
// composer's residual-sensitivity ranking.
export function evalFitAt(fit, t) {
  let tt = Math.max(0, t - (fit.delayMs || 0));
  // periodic motions (tickers/marquees): re-run the model every periodMs
  if (fit.periodMs > 0) tt = tt % fit.periodMs;
  if (fit.kind === 'tween') {
    const dur = fit.transition.duration * 1000;
    const e = fit.transition.ease;
    const fn = Array.isArray(e) ? cubicBezier(...e) : (p) => p;
    return fit.valueFrom + (fit.valueTo - fit.valueFrom) * fn(Math.min(1, tt / dur));
  }
  if (fit.kind === 'spring') {
    return springPosition(tt, { ...fit.transition, origin: fit.valueFrom, target: fit.valueTo });
  }
  if (fit.kind === 'marquee') {
    // constant-velocity translation — trivially replayable
    return (fit.valueFrom || 0) + fit.params.direction * fit.params.velocityPxPerSec * (tt / 1000);
  }
  return null;
}

// Normalized RMSE of a fit against the recorded samples for one channel.
export function residualFor(fit, channel, samples, loopMs) {
  const A = samples.filter((s) => s.t <= loopMs && typeof s[channel] === 'number');
  if (A.length < 4) return null;
  const vals = A.map((s) => s[channel]);
  const range = Math.max(...vals) - Math.min(...vals);
  if (!(range > 0)) return null;
  let sum = 0;
  for (const s of A) {
    const m = evalFitAt(fit, s.t);
    if (m == null) return null;
    sum += (m - s[channel]) ** 2;
  }
  return Math.sqrt(sum / A.length) / range;
}
