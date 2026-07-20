// Builds the Phase 4 stand-in replay pages. Both pages render the IDENTICAL element in the
// identical context; the only variable is the motion source — mode 'trace' plays the
// recorded samples verbatim (ground truth), mode 'model' plays the fitted Motion params.
// That makes the reviewer 2AFC a pure motion-discrimination task (psychophysics: isolate the
// variable under test). Scroll-linked channels are excluded (no scroll in a stand-in page).

function esc(json) {
  return JSON.stringify(json).replace(/</g, '\\u003c');
}

export function buildReplayPage({ look, samples, fits, mode, loopMs, pauseMs = 400, clockShiftMs = 0 }) {
  const w = look?.w || 160;
  const h = look?.h || 160;
  const bg = look?.bg && look.bg !== 'rgba(0, 0, 0, 0)' ? look.bg : '#5a6cff';
  const radius = look?.radius && look.radius !== '0px' ? look.radius : '14px';
  const timeFits = fits.filter((f) => f.fit.kind === 'tween' || f.fit.kind === 'spring' || f.fit.kind === 'marquee');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; background: #101014; height: 100vh; overflow: hidden; }
  #standin { position: absolute; left: 25%; top: 35%; width: ${w}px; height: ${h}px;
             border-radius: ${radius}; background: ${bg}; }
</style>
</head>
<body>
<div id="standin"></div>
<script>
  const MODE = ${esc(mode)};
  const LOOP = ${loopMs};
  const PAUSE = ${pauseMs};
  // trace recordings can start mid-flight (post-trigger frame hitch); the model clock is
  // shifted so both playbacks begin at the same point on the curve
  const SHIFT = ${clockShiftMs};
  const SAMPLES = ${esc(samples)};
  const FITS = ${esc(timeFits.map((f) => ({ channel: f.channel, ...f.fit })))};
  const el = document.getElementById('standin');
  const base = SAMPLES[0];

  const bezier = (x1, y1, x2, y2) => {
    const cb = (t, a1, a2) => (((1 - 3 * a2 + 3 * a1) * t + (3 * a2 - 6 * a1)) * t + 3 * a1) * t;
    return (x) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let lo = 0, hi = 1, t, c, i = 0;
      do { t = lo + (hi - lo) / 2; c = cb(t, x1, x2) - x; if (c > 0) hi = t; else lo = t; } while (Math.abs(c) > 1e-7 && ++i < 12);
      return cb(t, y1, y2);
    };
  };
  function springPos(t, k, c, from, to, vel, m) {
    m = m > 0 ? m : 1; // Motion's model; the fitter emits mass 1, a mass control adjusts it live
    const d = to - from, z = c / (2 * Math.sqrt(k * m)), w = Math.sqrt(k / m) / 1000, E = Math.exp(-z * w * t);
    const v0 = -(vel || 0) / 1000; // Motion's internal px/ms, sign-flipped
    if (Math.abs(z - 1) < 1e-4) return to - E * (d + (v0 + w * d) * t);
    if (z < 1) {
      const wd = w * Math.sqrt(1 - z * z);
      return to - E * (((v0 + z * w * d) / wd) * Math.sin(wd * t) + d * Math.cos(wd * t));
    }
    const wd = w * Math.sqrt(z * z - 1), f = Math.min(wd * t, 300);
    return to - (E * ((v0 + z * w * d) * Math.sinh(f) + wd * d * Math.cosh(f))) / wd;
  }

  function traceAt(t) {
    if (t <= SAMPLES[0].t) return SAMPLES[0];
    const last = SAMPLES[SAMPLES.length - 1];
    if (t >= last.t) return last;
    let lo = 0, hi = SAMPLES.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (SAMPLES[mid].t <= t) lo = mid; else hi = mid; }
    const a = SAMPLES[lo], b = SAMPLES[hi];
    const p = (t - a.t) / (b.t - a.t || 1);
    const out = {};
    for (const k of ['tx', 'ty', 'sx', 'sy', 'rot', 'opacity']) out[k] = a[k] + (b[k] - a[k]) * p;
    return out;
  }

  function evalFit(f, t) {
    let tt = Math.max(0, t - (f.delayMs || 0));
    if (f.periodMs > 0) tt = tt % f.periodMs; // periodic motions (tickers) re-run each cycle
    if (f.kind === 'tween') {
      const dur = f.transition.duration * 1000;
      const e = f.transition.ease;
      const fn = Array.isArray(e) ? bezier(e[0], e[1], e[2], e[3]) : (p) => p;
      const p = Math.min(1, tt / dur);
      return f.valueFrom + (f.valueTo - f.valueFrom) * fn(p);
    }
    if (f.kind === 'spring') {
      return springPos(tt, f.transition.stiffness, f.transition.damping, f.valueFrom, f.valueTo, f.transition.velocity, f.transition.mass);
    }
    if (f.kind === 'marquee') {
      // constant-velocity translation (ticker rails) — never settles, just runs
      return (f.valueFrom || 0) + f.params.direction * f.params.velocityPxPerSec * (tt / 1000);
    }
    return null;
  }

  function modelAt(t) {
    const out = { tx: base.tx, ty: base.ty, sx: base.sx, sy: base.sy, rot: base.rot, opacity: base.opacity };
    for (const f of FITS) {
      const v = evalFit(f, t);
      if (v != null) out[f.channel] = v;
    }
    return out;
  }

  function apply(v) {
    el.style.transform =
      'translate3d(' + (v.tx - base.tx) + 'px,' + (v.ty - base.ty) + 'px,0)' +
      ' scale(' + v.sx + ',' + v.sy + ') rotate(' + v.rot + 'deg)';
    el.style.opacity = String(v.opacity);
  }

  // The loop must be STARTED via requestAnimationFrame (never called synchronously):
  // a parse-time call would set t0 ~30-40ms before the first painted frame AND write
  // before DOMContentLoaded arms the sampler's observer — playback would skip the head
  // of the recorded motion and the first writes would go unrecorded.
  let t0 = null;
  function frame() {
    const now = performance.now();
    if (t0 === null) t0 = now;
    const cyc = (now - t0) % (LOOP + PAUSE);
    const t = Math.min(cyc, LOOP);
    apply(MODE === 'trace' ? traceAt(t) : modelAt(t + SHIFT));
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
</script>
</body>
</html>`;
}
