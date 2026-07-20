// Pointer-driven displacement-field fitter: the "pixel distortion / cursor ripple"
// shader family (formal-salmon-595048.framer.app is the reference specimen). The scene
// is a STATIC full-screen quad — no matrices move — and all motion lives in a small
// float data texture: each frame the grid decays by a relaxation factor and the cursor
// injects impulses scaled by its velocity within a radius; the fragment shader samples
// the grid to offset UVs (often with RGB aberration). The GL tap therefore records
// upload SUMMARY STATS (sumAbs/centroid/spread), and this fitter recovers the process
// parameters from that energy series plus the recorded pointer series.
//
// Same doctrine as fit.js / fit-tunnel.js: deterministic (linear regressions in log/
// linear space — no AI anywhere), residual-is-confidence, and the gate scores the
// REGENERATED energy curve (forward-simulate the fitted model from the recorded pointer
// series vs the measured sumAbs series), never parameter distance. Never a fake
// success: no dynamic float texture, no idle decay window, or no pointer correlation
// each return ok:false with a precise warning.

const median = (arr) => {
  const v = [...arr].sort((a, b) => a - b);
  return v.length ? v[(v.length / 2) | 0] : null;
};

export function confidence(nrmse) {
  if (nrmse == null) return 0;
  return +Math.min(1, Math.max(0, 1 - 5 * nrmse)).toFixed(3);
}

// The fitter's candidate input: a texture that received ≥5 stat-carrying Float32Array
// updates. If several qualify, the most-updated one is the animation driver.
export function pickDynamicFloatTexture(uploads) {
  const cands = (uploads?.textures ?? []).filter((tx) => tx.updates >= 5 && tx.series.length >= 5);
  if (!cands.length) return null;
  return [...cands].sort((a, b) => b.series.length - a.series.length)[0];
}

// Pointer path accessors on the main clock. L1 travel (|Δx|+|Δy|), not euclidean: the
// classic implementation injects the velocity VECTOR into the grid's two components,
// so injected |energy| is proportional to |Δx|+|Δy| exactly.
// EVENT-SUM semantics, not interpolation: the page sees the pointer as sample-and-hold
// (the latest mousemove at each frame), and events cannot interrupt a running rAF
// callback — so a movement event belongs entirely to the first upload after it.
function pointerPath(pointer) {
  const ts = [pointer[0].t];
  const cum = [0];
  for (let i = 1; i < pointer.length; i++) {
    ts.push(pointer[i].t);
    cum.push(cum[i - 1] + Math.abs(pointer[i].x - pointer[i - 1].x) + Math.abs(pointer[i].y - pointer[i - 1].y));
  }
  const idxAt = (t) => {
    if (t < ts[0]) return -1;
    if (t >= ts[ts.length - 1]) return ts.length - 1;
    let lo = 0;
    let hi = ts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] <= t) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  return {
    // cumulative travel of all events in (t0, t1]
    travel: (t0, t1) => {
      const a = idxAt(t0);
      const b = idxAt(t1);
      return (b < 0 ? 0 : cum[b]) - (a < 0 ? 0 : cum[a]);
    },
    // sample-and-hold position at t (what the page's own handlers have seen by t)
    posAt: (t) => {
      const i = idxAt(t);
      return i < 0 ? { x: pointer[0].x, y: pointer[0].y } : { x: pointer[i].x, y: pointer[i].y };
    },
  };
}

// Forward-simulate the energy process over the upload pairs and score it against the
// measured series — the regenerated-curve gate. decayOf(dtMs) is the candidate decay;
// dArr is the per-pair injected travel (raw or follower-smoothed).
function replayEnergy(pairs, dArr, E0, decayOf, gain) {
  let e = E0;
  let sum = 0;
  const measured = [E0];
  for (let i = 0; i < pairs.length; i++) {
    e = Math.max(0, e * decayOf(pairs[i].dt) + gain * dArr[i]);
    measured.push(pairs[i].E1);
    sum += (e - pairs[i].E1) ** 2;
  }
  const lo = Math.min(...measured);
  const hi = Math.max(...measured);
  const range = hi - lo || 1;
  return Math.sqrt(sum / pairs.length) / range;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (!(sxx > 0) || !(syy > 0)) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

// End-to-end: upload-stats series (+ pointer series + last-value uniforms map) →
// pointer-displacement model + energy-replay confidence.
export function fitDisplacement({ uploads, pointer = [], uniforms = {} }) {
  const tx = pickDynamicFloatTexture(uploads);
  if (!tx) {
    return { ok: false, warnings: ['no dynamic float data texture (≥5 Float32Array uploads to one texture) — not a displacement-field candidate'] };
  }
  if (tx.statsSkipped) {
    return { ok: false, warnings: [`dynamic float texture ${tx.w}×${tx.h} exceeded the upload-stats texel cap (${tx.statsSkipped}) — grid too large to fit`] };
  }
  if (!pointer || pointer.length < 8) {
    return { ok: false, warnings: [`pointer series too short (${pointer?.length ?? 0} samples) — a displacement fit needs the recorded pointer path`] };
  }
  const warnings = [];
  const S = tx.series;
  const path = pointerPath(pointer);
  const travel = path.travel;

  // upload pairs: consecutive stat samples with a sane gap; d = L1 pointer travel across
  const pairs = [];
  for (let i = 1; i < S.length; i++) {
    const dt = S[i].t - S[i - 1].t;
    if (!(dt > 0) || dt > 500) continue; // renderer pause / capture gap — refuse to bridge
    pairs.push({ t: S[i].t, dt, E0: S[i - 1].sumAbs, E1: S[i].sumAbs, d: travel(S[i - 1].t, S[i].t), spread: S[i].spread });
  }
  if (pairs.length < 12) {
    return { ok: false, warnings: [`only ${pairs.length} usable upload pair(s) — series too sparse to fit`] };
  }
  const maxE = Math.max(...S.map((s) => s.sumAbs));
  if (!(maxE > 0)) {
    return { ok: false, warnings: ['grid energy is zero throughout — nothing was ever injected'] };
  }
  // low floor on purpose: float data decays multiplicatively, so the DEEP tail is the
  // cleanest pure-relaxation signal (and the max can be inflated by one teleport spike);
  // the floor only guards against sites that clamp small values to zero
  const floor = maxE * 1e-4;

  const frameMs = median(pairs.map((p) => p.dt));
  // pointer event cadence: injection can never be attributed finer than this (and live
  // renderers often upload faster than events arrive)
  const pGaps = [];
  for (let i = 1; i < pointer.length; i++) {
    const g = pointer[i].t - pointer[i - 1].t;
    if (g > 0 && g < 200) pGaps.push(g);
  }
  const pointerGapMs = pGaps.length ? median(pGaps) : frameMs;
  const quietMs = Math.max(3 * frameMs, 2 * pointerGapMs);

  // ---- relaxation: exponential decay of sumAbs during QUIET windows — no pointer
  // travel for quietMs before the sample, so mid-sweep zero-travel pairs (upload rate >
  // event rate) can't masquerade as idle. Two decay clocks are fitted, because
  // renderers differ in which one the decay follows when the upload cadence varies:
  // per-UPLOAD (decay applied once per rendered frame == once per upload) and
  // WALL-CLOCK (decay per animation-time ms, uploads merely sampling it). The winner is
  // chosen by the regenerated energy curve, never assumed.
  const idle = pairs.filter((p) => travel(p.t - quietMs, p.t) === 0 && p.E0 > floor && p.E1 > 0 && p.E1 < p.E0 * 1.5);
  if (idle.length < 6) {
    return { ok: false, warnings: [`no usable idle decay window (${idle.length} quiet pair(s) with energy above floor) — relaxation unfittable; capture needs a still-pointer tail while the grid still rings`] };
  }
  const lnr = idle.map((p) => Math.log(p.E1 / p.E0));
  // per-upload decay factor: robust geometric ratio
  const rUpload = Math.exp(median(lnr));
  // wall-clock rate: through-origin regression of ln-ratio on dt
  let num = 0;
  let den = 0;
  for (let i = 0; i < idle.length; i++) {
    num += -lnr[i] * idle[i].dt;
    den += idle[i].dt ** 2;
  }
  const lambda = den > 0 ? num / den : 0; // per-ms
  if (!(rUpload > 0 && rUpload < 1) || !(lambda > 0)) {
    return { ok: false, warnings: [`grid energy does not decay while the pointer rests (per-upload ratio ${rUpload.toFixed(4)}, λ ${lambda.toExponential(2)}/ms) — not a relaxing displacement field`] };
  }
  const idleFrameMs = median(idle.map((p) => p.dt));

  // ---- gain per decay candidate: injected energy (E_end − E_start·decay) against L1
  // pointer travel over WINDOWS of consecutive uploads, not single pairs — real
  // components low-pass the pointer through an internal follower (seen live: energy
  // keeps flowing on zero-travel pairs and the grid centroid lags the pointer), so
  // instantaneous attribution decorrelates a genuinely pointer-driven grid. The window
  // size is measured (event cadence), then widened ×2/×4 if correlation improves —
  // an attribution choice made deterministically; a truly uncorrelated series stays
  // uncorrelated at every window size.
  const k0 = Math.max(2, Math.ceil(quietMs / frameMs));
  const buildWindows = (k, dArr) => {
    const out = [];
    for (let i = 0; i + k <= pairs.length; i += k) {
      const chunk = pairs.slice(i, i + k);
      if (chunk.some((p, j) => j > 0 && chunk[j].t - chunk[j - 1].t - chunk[j].dt > 1)) continue; // non-contiguous
      out.push({
        chunk,
        ds: dArr.slice(i, i + k),
        n: k,
        tEnd: chunk[chunk.length - 1].t,
        dtTotal: chunk.reduce((a, p) => a + p.dt, 0),
        E0: chunk[0].E0,
        E1: chunk[chunk.length - 1].E1,
        d: dArr.slice(i, i + k).reduce((a, b) => a + b, 0),
      });
    }
    return out;
  };
  // Optional pointer FOLLOWER before injection: some components inject raw event
  // velocity; others run the mouse through an internal position pursuit first
  // (f′ = (m − f)/τ — the same dynamic fit.js fits on DOM cursor-followers). Seen live:
  // energy keeps flowing on zero-travel pairs, the grid centroid lags the pointer, and
  // injection dies at direction reversals, where the smoothed VECTOR velocity crosses
  // zero while unsigned travel does not. τ comes from a deterministic grid, chosen by
  // the regenerated energy curve — with a parsimony margin: raw (τ=0) stands unless
  // smoothing improves the replay by >20% relative.
  const FOLLOWER_TAUS = [0, 25, 50, 100, 200, 400];
  const smoothedD = (tauMs) => {
    if (!tauMs) return pairs.map((p) => p.d);
    const out = [];
    let f = null;
    let prevEnd = null;
    for (const p of pairs) {
      const start = p.t - p.dt;
      if (f == null || prevEnd == null || start - prevEnd > 1) f = path.posAt(start); // (re)converged across a gap
      const m = path.posAt(p.t);
      const a = 1 - Math.exp(-p.dt / tauMs);
      const nx = f.x + (m.x - f.x) * a;
      const ny = f.y + (m.y - f.y) * a;
      out.push(Math.abs(nx - f.x) + Math.abs(ny - f.y));
      f = { x: nx, y: ny };
      prevEnd = p.t;
    }
    return out;
  };
  // effective travel: each pair's travel weighted by its remaining decay to the window
  // end — E1 = E0·decay^k + gain·Σ d_j·w_j exactly, so inj/dEff is unbiased at any
  // window size (raw inj/Σd shrinks with the window: early injections decay inside it)
  const dEff = (w, form) =>
    w.chunk.reduce(
      (a, p, j) =>
        a + w.ds[j] * (form === 'per-upload' ? Math.pow(rUpload, w.n - 1 - j) : Math.exp(-lambda * (w.tEnd - p.t))),
      0,
    );
  const fitInjection = (dArr, tauMs) => {
    const candidates = [
      { tauMs, dArr, form: 'per-upload', decayOf: () => rUpload, winDecay: (w) => Math.pow(rUpload, w.n) },
      { tauMs, dArr, form: 'wall-clock', decayOf: (dt) => Math.exp(-lambda * dt), winDecay: (w) => Math.exp(-lambda * w.dtTotal) },
    ];
    for (const c of candidates) {
      c.corr = -1;
      for (const k of [k0, k0 * 2, k0 * 4]) {
        const wins = buildWindows(k, dArr);
        const moving = wins.filter((w) => w.d > 1);
        if (moving.length < 5) continue;
        const injs = wins.map((w) => w.E1 - w.E0 * c.winDecay(w));
        const corr = pearson(wins.map((w) => w.d), injs);
        if (corr > c.corr) {
          c.corr = corr;
          c.windowUploads = k;
          // median of per-window inj/dEff ratios: robust to teleport spikes (one huge
          // injection from an instantaneous pointer jump) that wreck least squares
          c.gain = median(moving.map((w) => (w.E1 - w.E0 * c.winDecay(w)) / dEff(w, c.form)));
          c.movingWindows = moving.length;
        }
      }
      if (c.gain == null || !(c.gain > 0)) { c.nrmse = null; continue; }
      c.nrmse = replayEnergy(pairs, dArr, pairs[0].E0, c.decayOf, c.gain);
    }
    return candidates;
  };
  const all = FOLLOWER_TAUS.flatMap((tauMs) => fitInjection(smoothedD(tauMs), tauMs));
  if (!all.some((c) => c.movingWindows >= 5)) {
    return { ok: false, warnings: ['pointer barely moved during the upload series — no injection signal to fit gain from'] };
  }
  const viable = all.filter((c) => c.gain > 0 && c.nrmse != null).sort((a, b) => a.nrmse - b.nrmse);
  if (!viable.length) {
    return { ok: false, warnings: ['injected energy regresses to a non-positive gain — grid energy is not driven by pointer travel'] };
  }
  const bestRaw = viable.find((c) => c.tauMs === 0);
  let fitted = viable[0];
  if (fitted.tauMs > 0 && bestRaw && fitted.nrmse >= bestRaw.nrmse * 0.8) fitted = bestRaw; // parsimony
  if (fitted.corr < 0.3) {
    return {
      ok: false,
      warnings: [`grid energy injection is uncorrelated with pointer motion (r=${fitted.corr.toFixed(3)} at ${fitted.windowUploads}-upload windows) — the texture animates, but not from the pointer`],
    };
  }
  // the alternative decay clock AT THE SAME τ (the honest apples-to-apples comparison)
  const alt = all.find((c) => c.tauMs === fitted.tauMs && c.form !== fitted.form);

  // ---- radius: median energy spread while the pointer moves (recent travel within
  // the quiet horizon, energy well above zero). spread is the energy-weighted RMS
  // distance from the centroid in grid cells; for a uniform disk of radius R that RMS
  // is R/√2, so radiusCells = spread·√2 is the disk-equivalent radius (falloff shape
  // and the decaying trail behind a moving cursor both bias it — hence the wide gate
  // tolerance, ±40%).
  const spreadFloor = maxE * 0.02;
  const spreads = pairs
    .filter((p) => p.spread != null && p.E1 > spreadFloor && travel(p.t - quietMs, p.t) > 0)
    .map((p) => p.spread);
  if (spreads.length < 3) {
    return { ok: false, warnings: [`too few moving uploads carry a spread (${spreads.length}) — radius unmeasurable`] };
  }
  const spreadCells = +median(spreads).toFixed(3);
  const radiusCells = +(spreadCells * Math.SQRT2).toFixed(3);

  // ---- amplitude constants: passed through from the last-value uniforms map (set once
  // at init on the reference specimen — per-draw tracking would never see them)
  const scalar = (v) => (typeof v === 'number' ? v : Array.isArray(v) && v.length === 1 && typeof v[0] === 'number' ? v[0] : null);
  const matchUniform = (re) => {
    for (const [name, v] of Object.entries(uniforms)) {
      const s = scalar(v);
      if (re.test(name) && s != null) return { name, value: s };
    }
    return null;
  };

  const relaxation = fitted.form === 'per-upload' ? +rUpload.toFixed(4) : +Math.exp(-lambda * frameMs).toFixed(4);
  const halfLifeMs = fitted.form === 'per-upload' ? +((frameMs * Math.LN2) / -Math.log(rUpload)).toFixed(1) : +(Math.LN2 / lambda).toFixed(1);
  if (alt && alt.nrmse != null && Math.abs(alt.nrmse - fitted.nrmse) < 0.01) {
    // steady upload cadence makes the two clocks indistinguishable — that's fine
  } else if (alt && alt.nrmse != null) {
    warnings.push(`decay clock: ${fitted.form} replays at ${(fitted.nrmse * 100).toFixed(2)}% vs ${alt.form} ${(alt.nrmse * 100).toFixed(2)}% — chose ${fitted.form}`);
  }

  const model = {
    kind: 'pointer-displacement',
    grid: { w: tx.w, h: tx.h, channels: tx.channels },
    decay: {
      form: fitted.form,
      relaxation, // per-frame factor at frameMs
      frameMs: +frameMs.toFixed(1),
      idleFrameMs: +idleFrameMs.toFixed(1),
      ...(fitted.form === 'wall-clock' ? { lambdaPerMs: +lambda.toPrecision(4) } : { perUpload: +rUpload.toFixed(4) }),
      halfLifeMs,
      idlePairs: idle.length,
    },
    gain: +fitted.gain.toPrecision(4), // injected Σ|grid| per L1 px of (follower) travel
    // internal mouse pursuit ahead of injection (τ=0 ⇒ raw events); k60 = equivalent
    // per-frame lerp factor at 60fps, same convention as the DOM pointer-follow link
    pointerFollower: fitted.tauMs > 0 ? { tauMs: fitted.tauMs, k60: +(1 - Math.exp(-1000 / 60 / fitted.tauMs)).toFixed(4) } : null,
    radius: { spreadCells, radiusCells },
    amplitude: {
      displacement: matchUniform(/displac/i),
      aberration: matchUniform(/aberr|chromatic/i),
    },
    uniforms, // full last-value map — provenance for constants the patterns missed
  };
  return {
    ok: true,
    model,
    replay: {
      pairs: pairs.length,
      nrmse: +fitted.nrmse.toFixed(4),
      confidence: confidence(fitted.nrmse),
      pointerCorrelation: +fitted.corr.toFixed(3),
      windowUploads: fitted.windowUploads,
      ...(alt && alt.nrmse != null ? { altForm: { form: alt.form, nrmse: +alt.nrmse.toFixed(4) } } : {}),
    },
    warnings,
  };
}
