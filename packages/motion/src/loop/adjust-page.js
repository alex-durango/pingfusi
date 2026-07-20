// The "adjust" task type uses UI-as-data, never AI-generated UI
// code. The pipeline's agent composes a declarative control schema per task
// (src/loop/compose-controls.js — the panel is a rendering of the AI's uncertainty);
// this file is the FIXED component library that renders it: slider (with axis
// inversion), xy pad, choice. Structural editing stays banned — these controls bind only
// to model parameters.
//
// Prior rules stand: reference always visible, "make it match" framing, escape hatch,
// full interaction trajectory recorded (the search path is fitter training data).
// Adjust-first doctrine (2026-07-18): the reviewer is the product owner — matched
// values are applied directly and the numeric replay gate on the rebuilt bundle
// certifies convergence; "no-match" routes to diagnose/refit; blinded 2AFC is opt-in
// (--mode 2afc), never required. Performance is a hard
// requirement: live re-render on input must stay fluid (laggy controls corrupt reviewer
// tuning data) — the phase4 gate drives an input storm and measures frame gaps.

function esc(json) {
  return JSON.stringify(json).replace(/</g, '\\u003c');
}

export function buildAdjustPage({ look, samples, fits, loopMs, pauseMs = 400, clockShiftMs = 0, controlPanel }) {
  const w = look?.w || 160;
  const h = look?.h || 160;
  const bg = look?.bg && look.bg !== 'rgba(0, 0, 0, 0)' ? look.bg : '#5a6cff';
  const radius = look?.radius && look.radius !== '0px' ? look.radius : '14px';
  const timeFits = fits.filter((f) => f.fit.kind === 'tween' || f.fit.kind === 'spring' || f.fit.kind === 'marquee');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>match the motion</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #101014; color: #e8e8ee; font: 14px/1.4 system-ui, sans-serif; }
  header { text-align: center; padding: 12px 16px 4px; }
  header h1 { margin: 0; font-size: 16px; }
  header p { margin: 4px 0 0; color: #9a9aa8; font-size: 13px; }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 10px 16px; max-width: 1100px; margin: 0 auto; }
  .stage { position: relative; height: 42vh; min-height: 280px; background: #16161c; border-radius: 10px; overflow: hidden; outline: 1px solid #26262e; }
  .stage .tag { position: absolute; top: 8px; left: 10px; font-size: 12px; font-weight: 700; letter-spacing: .06em; color: #b8b8c6; z-index: 2; }
  .standin { position: absolute; left: 20%; top: 30%; width: ${w}px; height: ${h}px; border-radius: ${radius}; background: ${bg}; }
  .panel { display: flex; gap: 22px; justify-content: center; align-items: flex-start; flex-wrap: wrap; max-width: 860px; margin: 8px auto 0; padding: 0 16px; }
  .ctl { display: flex; flex-direction: column; gap: 6px; align-items: center; }
  .ctl > label { color: #c9c9d6; font-size: 13px; font-weight: 600; }
  .ctl output { color: #9a9aa8; font-size: 12px; font-variant-numeric: tabular-nums; }
  .ctl input[type=range] { width: 220px; accent-color: #6a6af0; }
  .xy { position: relative; width: 190px; height: 190px; background: #16161c; border-radius: 10px; outline: 1px solid #33333e; cursor: crosshair; touch-action: none; }
  .xy .dot { position: absolute; width: 14px; height: 14px; border-radius: 50%; background: #6a6af0; transform: translate(-50%, -50%); pointer-events: none; box-shadow: 0 0 0 3px rgba(106,106,240,.25); }
  .xy .ax { position: absolute; font-size: 11px; color: #6a6a78; pointer-events: none; }
  .xy .ax.x { right: 8px; bottom: 6px; }
  .xy .ax.y { left: 8px; top: 6px; }
  .hyp { font-size: 11px; color: #b08a4f; }
  .hint { font-size: 11px; color: #8a8a96; margin-top: 2px; }
  .actions { display: flex; gap: 10px; justify-content: center; padding: 14px 16px 8px; flex-wrap: wrap; }
  button { border: 1px solid #33333e; background: #17171e; color: #e8e8ee; border-radius: 8px; padding: 9px 16px; font: inherit; cursor: pointer; }
  button:hover { background: #20202a; }
  #done { border-color: #2f6b3a; }
  #escape { border-color: #6b4a2f; }
  #verdict { text-align: center; color: #8fe38f; font-weight: 600; min-height: 1.4em; padding: 0 16px 14px; overflow-wrap: anywhere; }
  footer { text-align: center; color: #6a6a78; font-size: 11.5px; padding-bottom: 14px; }
</style>
</head>
<body>
<header>
  <h1>Move the controls until YOURS matches the REFERENCE</h1>
  <p>Match the motion exactly — timing, bounce, distance. Not what looks good: what MATCHES.</p>
</header>
<main>
  <div class="stage"><span class="tag">REFERENCE (match this)</span><div class="standin" id="ref"></div></div>
  <div class="stage"><span class="tag">YOURS</span><div class="standin" id="cand"></div></div>
</main>
<div class="panel" id="panel"></div>
<div class="actions">
  <button id="reset">reset</button>
  <button id="done">✓ It matches now</button>
  <button id="escape"></button>
</div>
<div id="verdict"></div>
<footer>Your final values are applied directly — the rebuilt motion is re-checked numerically against the recording before it counts.</footer>
<script>
  const LOOP = ${loopMs};
  const PAUSE = ${pauseMs};
  const SHIFT = ${clockShiftMs};
  const SAMPLES = ${esc(samples)};
  const FITS = ${esc(timeFits.map((f) => ({ channel: f.channel, ...f.fit })))};
  const PANEL = ${esc(controlPanel)};
  const ref = document.getElementById('ref');
  const cand = document.getElementById('cand');
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
      return f.valueFrom + (f.valueTo - f.valueFrom) * fn(Math.min(1, tt / dur));
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

  function apply(el, v) {
    el.style.transform =
      'translate3d(' + (v.tx - base.tx) + 'px,' + (v.ty - base.ty) + 'px,0)' +
      ' scale(' + v.sx + ',' + v.sy + ') rotate(' + v.rot + 'deg)';
    el.style.opacity = String(v.opacity);
  }

  // ---- fixed component library rendering the composed schema (UI-as-data) ----
  const A = (window.__mkAdjust = { params: {}, trajectory: [], controls: PANEL, startedAt: performance.now() });
  const fitByChannel = {};
  for (const f of FITS) fitByChannel[f.channel] = f;
  let lastLog = -1e9;

  function setParam(id, value) {
    const dotIdx = id.lastIndexOf('.');
    const channel = id.slice(0, dotIdx);
    const key = id.slice(dotIdx + 1);
    const f = fitByChannel[channel];
    if (!f) return;
    if (key === 'delayMs') f.delayMs = value; // hypothesis probes may live outside the transition
    else if (f.params && key in f.params) f.params[key] = value; // marquee-class fits keep params beside transition
    else f.transition[key] = value;
    A.params[id] = value;
    const now = performance.now();
    if (now - lastLog > 100) {
      lastLog = now;
      A.trajectory.push({ t: Math.round(now - A.startedAt), params: { ...A.params } });
    }
    document.body.dataset.params = JSON.stringify(A.params);
  }
  function getParam(id) {
    const dotIdx = id.lastIndexOf('.');
    const f = fitByChannel[id.slice(0, dotIdx)];
    const key = id.slice(dotIdx + 1);
    if (key === 'delayMs') return f.delayMs || 0;
    if (f.params && key in f.params) return f.params[key];
    return f.transition[key];
  }

  const panel = document.getElementById('panel');
  const resetters = [];

  function renderSlider(ctrl) {
    const box = document.createElement('div');
    box.className = 'ctl';
    const label = document.createElement('label');
    label.textContent = ctrl.label + (ctrl.hypothesis ? ' ' : '');
    if (ctrl.hypothesis) {
      const tag = document.createElement('span');
      tag.className = 'hyp';
      tag.textContent = '(experimental)';
      label.appendChild(tag);
    }
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(ctrl.range[0]);
    input.max = String(ctrl.range[1]);
    input.step = String(+(((ctrl.range[1] - ctrl.range[0]) / 100).toPrecision(2)));
    input.value = String(ctrl.initial);
    input.dataset.param = ctrl.param;
    if (ctrl.invert) input.style.direction = 'rtl'; // drag right = intuitive direction
    const out = document.createElement('output');
    const show = (v) => { out.textContent = v + (ctrl.unit ? ' ' + ctrl.unit : ''); };
    show(ctrl.initial);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      setParam(ctrl.param, v);
      show(v);
    });
    input.addEventListener('change', replay); // release → replay from t=0 so the change is SEEN
    resetters.push(() => { input.value = String(ctrl.initial); setParam(ctrl.param, ctrl.initial); show(ctrl.initial); });
    box.append(label, input, out);
    if (ctrl.hint) { const h = document.createElement('div'); h.className = 'hint'; h.textContent = ctrl.hint; box.appendChild(h); }
    panel.appendChild(box);
    A.params[ctrl.param] = ctrl.initial;
  }

  function renderXY(ctrl) {
    const box = document.createElement('div');
    box.className = 'ctl';
    const label = document.createElement('label');
    label.textContent = ctrl.label;
    const pad = document.createElement('div');
    pad.className = 'xy';
    pad.dataset.param = ctrl.param.join(',');
    const dot = document.createElement('div');
    dot.className = 'dot';
    const axX = document.createElement('span'); axX.className = 'ax x'; axX.textContent = ctrl.axes.x.label;
    const axY = document.createElement('span'); axY.className = 'ax y'; axY.textContent = ctrl.axes.y.label;
    pad.append(dot, axX, axY);
    const out = document.createElement('output');
    // normalized position (0..1, up = more) ↔ param value, honoring axis inversion
    const toValue = (axis, n) => {
      const [min, max] = axis.range;
      return +( axis.invert ? max - n * (max - min) : min + n * (max - min) ).toPrecision(5);
    };
    const toN = (axis, v) => {
      const [min, max] = axis.range;
      const n = (v - min) / (max - min || 1);
      return axis.invert ? 1 - n : n;
    };
    const show = () => {
      const nx = toN(ctrl.axes.x, getParam(ctrl.axes.x.param));
      const ny = toN(ctrl.axes.y, getParam(ctrl.axes.y.param));
      dot.style.left = (nx * 100) + '%';
      dot.style.top = ((1 - ny) * 100) + '%';
      out.textContent = '';
    };
    const applyPointer = (e) => {
      const r = pad.getBoundingClientRect();
      const nx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const ny = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
      setParam(ctrl.axes.x.param, toValue(ctrl.axes.x, nx));
      setParam(ctrl.axes.y.param, toValue(ctrl.axes.y, ny));
      show();
    };
    let dragging = false;
    pad.addEventListener('pointerdown', (e) => { dragging = true; pad.setPointerCapture(e.pointerId); applyPointer(e); });
    pad.addEventListener('pointermove', (e) => { if (dragging) applyPointer(e); });
    pad.addEventListener('pointerup', () => { dragging = false; replay(); });
    resetters.push(() => {
      setParam(ctrl.axes.x.param, ctrl.axes.x.initial);
      setParam(ctrl.axes.y.param, ctrl.axes.y.initial);
      show();
    });
    box.append(label, pad, out);
    if (ctrl.hint) { const h = document.createElement('div'); h.className = 'hint'; h.textContent = ctrl.hint; box.appendChild(h); }
    panel.appendChild(box);
    A.params[ctrl.axes.x.param] = ctrl.axes.x.initial;
    A.params[ctrl.axes.y.param] = ctrl.axes.y.initial;
    show();
  }

  function renderChoice(ctrl) {
    const box = document.createElement('div');
    box.className = 'ctl';
    const label = document.createElement('label');
    label.textContent = ctrl.label;
    const row = document.createElement('div');
    for (const opt of ctrl.options) {
      const b = document.createElement('button');
      b.textContent = String(opt.label ?? opt.value);
      b.addEventListener('click', () => { setParam(ctrl.param, opt.value); replay(); });
      row.appendChild(b);
    }
    resetters.push(() => setParam(ctrl.param, ctrl.initial));
    box.append(label, row);
    if (ctrl.hint) { const h = document.createElement('div'); h.className = 'hint'; h.textContent = ctrl.hint; box.appendChild(h); }
    panel.appendChild(box);
    A.params[ctrl.param] = ctrl.initial;
  }

  const RENDERERS = { slider: renderSlider, xy: renderXY, choice: renderChoice, toggle: renderChoice };
  for (const ctrl of PANEL.controls) (RENDERERS[ctrl.type] || (() => {}))(ctrl);
  document.body.dataset.params = JSON.stringify(A.params);

  const verdict = document.getElementById('verdict');
  document.getElementById('reset').addEventListener('click', () => resetters.forEach((r) => r()));
  document.getElementById('done').addEventListener('click', () => {
    A.trajectory.push({ t: Math.round(performance.now() - A.startedAt), params: { ...A.params }, final: true });
    const compact = Object.entries(A.params).map(([k, v]) => k + '=' + v).join(', ');
    const answer = 'matched: ' + compact;
    verdict.textContent = 'Your answer: "' + answer + '" — submit exactly this in the task response.';
    document.body.dataset.answer = answer;
  });
  const escBtn = document.getElementById('escape');
  escBtn.textContent = PANEL.escape.label;
  escBtn.addEventListener('click', () => {
    const answer = 'no-match: ' + PANEL.escape.signal;
    verdict.textContent = 'Your answer: "' + answer + '" — submit exactly this in the task response.';
    document.body.dataset.answer = answer;
  });

  let t0 = null;
  // Restart the loop so a control change is demonstrated from t=0 immediately —
  // catching your own tweak mid-flight is what made the panel feel opaque.
  function replay() { t0 = null; }
  function frame() {
    const now = performance.now();
    if (t0 === null) t0 = now;
    const cyc = (now - t0) % (LOOP + PAUSE);
    const t = Math.min(cyc, LOOP);
    apply(ref, traceAt(t));
    apply(cand, modelAt(t + SHIFT));
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
</script>
</body>
</html>`;
}
