// Compact Nelder–Mead simplex minimizer for the curve fitters (2–4 params, smooth-ish
// objectives, multiple restarts handled by callers).
export function nelderMead(objective, start, { maxIterations = 400, tolerance = 1e-7, step = 0.25 } = {}) {
  const n = start.length;
  const alpha = 1;
  const gamma = 2;
  const rho = 0.5;
  const sigma = 0.5;

  let simplex = [start.slice()];
  for (let i = 0; i < n; i++) {
    const p = start.slice();
    p[i] += p[i] !== 0 ? step * Math.abs(p[i]) : step;
    simplex.push(p);
  }
  let scores = simplex.map(objective);

  for (let iter = 0; iter < maxIterations; iter++) {
    const order = scores.map((s, i) => [s, i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
    simplex = order.map((i) => simplex[i]);
    scores = order.map((i) => scores[i]);
    if (Math.abs(scores[0] - scores[n]) < tolerance) break;

    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    }
    const worst = simplex[n];
    const reflected = centroid.map((c, j) => c + alpha * (c - worst[j]));
    const rScore = objective(reflected);

    if (rScore < scores[0]) {
      const expanded = centroid.map((c, j) => c + gamma * (reflected[j] - c));
      const eScore = objective(expanded);
      if (eScore < rScore) {
        simplex[n] = expanded;
        scores[n] = eScore;
      } else {
        simplex[n] = reflected;
        scores[n] = rScore;
      }
    } else if (rScore < scores[n - 1]) {
      simplex[n] = reflected;
      scores[n] = rScore;
    } else {
      const contracted = centroid.map((c, j) => c + rho * (worst[j] - c));
      const cScore = objective(contracted);
      if (cScore < scores[n]) {
        simplex[n] = contracted;
        scores[n] = cScore;
      } else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[0].map((b, j) => b + sigma * (simplex[i][j] - b));
          scores[i] = objective(simplex[i]);
        }
      }
    }
  }

  const best = scores.map((s, i) => [s, i]).sort((a, b) => a[0] - b[0])[0];
  return { params: simplex[best[1]], score: best[0] };
}
