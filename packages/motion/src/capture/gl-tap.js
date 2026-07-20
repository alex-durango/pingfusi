// GL tap (Tier 3G): behavioral capture for WebGL-rendered motion — the animation class
// that is invisible to BOTH the CDP Animation domain and the mutation-driven DOM sampler
// (canvas pixels never mutate attributes). Instead of reading the site's code, we tap the
// GL command stream at the context boundary and record, per textured draw call, the
// projection + model-view matrices — the browser's own ground truth for where every
// object is. Works for main-thread canvases AND OffscreenCanvas workers (the reason this
// exists: floema.com renders its hero item field in `Images.worker` via
// transferControlToOffscreen, so no main-thread hook can see it).
//
// How identity works without engine cooperation: shader uniform NAMES survive JS
// minification (they live in GLSL strings), so wrapping getUniformLocation lets us tag
// each location object with its name; three.js-family engines all use
// projectionMatrix/modelViewMatrix-style names, and our own fixtures do too. Draw calls
// are then grouped per rAF frame, and objects are re-identified across frames by their
// stable lateral (x, y) view-space position — verified, not assumed: reconstructTracks()
// surfaces a warning when (x, y) drifts and identity becomes unreliable.
//
// Clock discipline: a Web Worker's performance.now() runs on its own timeOrigin; every batch
// carries performance.timeOrigin so samples land on the MAIN page clock, comparable with
// the tier-3 sampler's frames (t, scrollY).
//
// Besides draws, the tap records TEXTURE UPLOADS as summary stats (sumAbs/maxAbs/
// centroid/spread — never raw pixel buffers: size AND third-party-content hygiene) and
// the last-set value of every scalar/vec uniform by name. Together these expose the
// displacement-field family (pointer "pixel distortion" shaders): a static quad whose
// motion lives entirely in per-frame Float32Array texSubImage2D uploads, with the
// amplitude constants (uDisplacement/uAberration) set once at init.

// Core context wrapper, shared verbatim between the worker preamble and the main-thread
// collector (kept as a source string; there is no module system inside an intercepted
// worker preamble).
const TAP_CORE = `
function __mkWrapGl(gl, tap, report) {
  if (gl.__mkWrapped) return gl;
  gl.__mkWrapped = true;
  const progState = new Map();
  let curProg = null;
  let activeUnit = 0;
  let boundTex = {};
  tap.uploads = tap.uploads || [];
  tap.uniforms = tap.uniforms || {};
  var MAX_UPLOADS = 20000; // loud cap, same doctrine as the draw batching: never silent
  var MAX_STAT_TEXELS = 262144; // 512x512 — stats are per-texel CPU work on EVERY upload

  const oGUL = gl.getUniformLocation.bind(gl);
  gl.getUniformLocation = function (p, name) {
    const loc = oGUL(p, name);
    if (loc) loc.__mkName = name;
    return loc;
  };
  const oUse = gl.useProgram.bind(gl);
  gl.useProgram = function (p) {
    curProg = p;
    if (p && !p.__mkId) p.__mkId = ++tap.progN;
    if (p && !progState.has(p)) progState.set(p, { mats: {}, floats: {}, vecs: {} });
    return oUse(p);
  };
  const oM4 = gl.uniformMatrix4fv.bind(gl);
  gl.uniformMatrix4fv = function (loc, tr, v) {
    if (loc && loc.__mkName && curProg) {
      const st = progState.get(curProg);
      st.mats[loc.__mkName] = Array.prototype.slice.call(v, 0, 16);
    }
    return oM4(loc, tr, v);
  };
  // last-set value of every scalar/vec uniform BY NAME (names survive minification —
  // they live in GLSL strings). Init-only constants like uDisplacement/uAberration are
  // set once before any draw; per-draw state tracking would never surface them.
  const remember = (loc, val) => { if (loc && loc.__mkName) tap.uniforms[loc.__mkName] = val; };
  const oF1 = gl.uniform1f.bind(gl);
  gl.uniform1f = function (loc, v) {
    if (loc && loc.__mkName && curProg) progState.get(curProg).floats[loc.__mkName] = v;
    remember(loc, v);
    return oF1(loc, v);
  };
  const wrapVec = (fn) => {
    const orig = gl[fn].bind(gl);
    gl[fn] = function (loc, ...a) {
      const v = a.length === 1 ? Array.prototype.slice.call(a[0], 0, 4).map(Number) : a.slice(0, 4).map(Number);
      if (loc && loc.__mkName && curProg) progState.get(curProg).vecs[loc.__mkName] = v;
      remember(loc, v);
      return orig(loc, ...a);
    };
  };
  wrapVec('uniform3f');
  wrapVec('uniform3fv');
  // remaining scalar/vec setters: remembered by name only (no per-draw state needed)
  for (const fn of ['uniform2f', 'uniform4f', 'uniform1i', 'uniform2i', 'uniform3i', 'uniform4i',
    'uniform1fv', 'uniform2fv', 'uniform4fv', 'uniform1iv', 'uniform2iv', 'uniform3iv', 'uniform4iv']) {
    if (!gl[fn]) continue;
    const orig = gl[fn].bind(gl);
    if (fn === 'uniform1i') {
      gl[fn] = function (loc, v) { remember(loc, v); return orig(loc, v); };
    } else {
      gl[fn] = function (loc, ...a) {
        remember(loc, a.length === 1 && a[0] && a[0].length !== undefined
          ? Array.prototype.slice.call(a[0], 0, 4).map(Number)
          : a.slice(0, 4).map(Number));
        return orig(loc, ...a);
      };
    }
  }
  const oCT = gl.createTexture.bind(gl);
  gl.createTexture = function () {
    const t = oCT();
    if (t) t.__mkId = ++tap.texN;
    return t;
  };
  const oAT = gl.activeTexture.bind(gl);
  gl.activeTexture = function (u) { activeUnit = u - 33984; return oAT(u); };
  const oBT = gl.bindTexture.bind(gl);
  gl.bindTexture = function (target, tex) {
    if (target === 3553) boundTex[activeUnit] = tex ? tex.__mkId : null;
    return oBT(target, tex);
  };
  // Texture uploads: SUMMARY STATS ONLY, never raw buffers (size + third-party-content
  // hygiene — captures of real sites must not embed their pixel data). Stats are
  // computed only for Float32Array uploads (data textures: displacement grids etc.);
  // image/video uploads get identity info alone. Energy = sum of |components| per texel.
  function texStats(view, w, h, srcOffset) {
    const texels = w * h;
    if (!(texels > 0)) return null;
    if (texels > MAX_STAT_TEXELS) return { skipped: 'exceeds-stat-texel-cap' };
    const off = srcOffset || 0;
    const comps = Math.floor((view.length - off) / texels);
    if (comps < 1) return null;
    let sumAbs = 0, maxAbs = 0, sx = 0, sy = 0;
    for (let i = 0; i < texels; i++) {
      let e = 0;
      const base = off + i * comps;
      for (let c = 0; c < comps; c++) {
        const a = Math.abs(view[base + c]);
        e += a;
        if (a > maxAbs) maxAbs = a;
      }
      if (e > 0) { sumAbs += e; sx += e * (i % w); sy += e * ((i / w) | 0); }
    }
    if (!(sumAbs > 0)) return { sumAbs: 0, maxAbs: 0, n: texels, comps, cx: null, cy: null, spread: null };
    const cx = sx / sumAbs;
    const cy = sy / sumAbs;
    let m2 = 0;
    for (let i = 0; i < texels; i++) {
      let e = 0;
      const base = off + i * comps;
      for (let c = 0; c < comps; c++) e += Math.abs(view[base + c]);
      if (e > 0) {
        const dx = (i % w) - cx;
        const dy = ((i / w) | 0) - cy;
        m2 += e * (dx * dx + dy * dy);
      }
    }
    return {
      sumAbs: Number(sumAbs.toPrecision(6)),
      maxAbs: Number(maxAbs.toPrecision(6)),
      n: texels,
      comps,
      cx: Math.round(cx * 1000) / 1000,
      cy: Math.round(cy * 1000) / 1000,
      spread: Math.round(Math.sqrt(m2 / sumAbs) * 1000) / 1000,
    };
  }
  function recUpload(kind, w, h, pixels, srcOffset) {
    if (tap.uploads.length >= MAX_UPLOADS) { tap.uploadsCapped = true; return; }
    const rec = { t: Math.round(performance.now() * 10) / 10, tex: boundTex[activeUnit] ?? null, w: w || 0, h: h || 0, kind };
    if (pixels instanceof Float32Array) {
      const s = texStats(pixels, w, h, srcOffset);
      if (s && s.skipped) rec.statsSkipped = s.skipped;
      else if (s) rec.stats = s;
    }
    tap.uploads.push(rec);
  }
  const oTI = gl.texImage2D.bind(gl);
  gl.texImage2D = function (...a) {
    // long form: (target, level, internalformat, width, height, border, format, type, pixels[, srcOffset])
    // short form: (target, level, internalformat, format, type, source)
    if (a.length >= 9) recUpload('init', a[3], a[4], ArrayBuffer.isView(a[8]) ? a[8] : null, typeof a[9] === 'number' ? a[9] : 0);
    else if (a.length === 6) recUpload('init', (a[5] && (a[5].width || a[5].videoWidth)) || 0, (a[5] && (a[5].height || a[5].videoHeight)) || 0, null, 0);
    return oTI(...a);
  };
  const oTSI = gl.texSubImage2D.bind(gl);
  gl.texSubImage2D = function (...a) {
    // long form: (target, level, xoff, yoff, width, height, format, type, pixels[, srcOffset])
    // short form: (target, level, xoff, yoff, format, type, source)
    if (a.length >= 9) recUpload('update', a[4], a[5], ArrayBuffer.isView(a[8]) ? a[8] : null, typeof a[9] === 'number' ? a[9] : 0);
    else if (a.length === 7) recUpload('update', (a[6] && (a[6].width || a[6].videoWidth)) || 0, (a[6] && (a[6].height || a[6].videoHeight)) || 0, null, 0);
    return oTSI(...a);
  };
  if (gl.texStorage2D) {
    const oTSt = gl.texStorage2D.bind(gl);
    gl.texStorage2D = function (...a) { recUpload('init', a[3], a[4], null, 0); return oTSt(...a); };
  }
  function onDraw() {
    if (!curProg) return;
    const st = progState.get(curProg);
    if (!st) return;
    tap.batch.push({
      f: tap.frame,
      t: Math.round(performance.now() * 10) / 10,
      p: curProg.__mkId,
      tex: boundTex[0] ?? null,
      mats: JSON.parse(JSON.stringify(st.mats)),
      floats: Object.assign({}, st.floats),
      vecs: JSON.parse(JSON.stringify(st.vecs)),
    });
    if (tap.batch.length >= 500) report();
  }
  const oDE = gl.drawElements.bind(gl);
  gl.drawElements = function (...a) { onDraw(); return oDE(...a); };
  const oDA = gl.drawArrays.bind(gl);
  gl.drawArrays = function (...a) { onDraw(); return oDA(...a); };
  const oDEI = gl.drawElementsInstanced ? gl.drawElementsInstanced.bind(gl) : null;
  if (oDEI) gl.drawElementsInstanced = function (...a) { onDraw(); return oDEI(...a); };
  return gl;
}`;

export const CHANNEL_NAME = '__mk_gl';

// Prepended to intercepted worker scripts (legal before module imports too: prepending
// statements ahead of import declarations is valid module JS).
export const GL_TAP_WORKER_SOURCE = `
${TAP_CORE}
(() => {
  if (self.__mkGlTap) return;
  const chan = new BroadcastChannel('${CHANNEL_NAME}');
  const tap = (self.__mkGlTap = { frame: 0, batch: [], texN: 0, progN: 0, uploads: [], uniforms: {}, uploadsCapped: false });
  const RAF = self.requestAnimationFrame ? self.requestAnimationFrame.bind(self) : null;
  if (RAF) self.requestAnimationFrame = (cb) => RAF((ts) => { tap.frame++; cb(ts); });
  function report() {
    if (!tap.batch.length && !tap.uploads.length) return;
    chan.postMessage({
      kind: 'draws', src: 'worker', timeOrigin: performance.timeOrigin,
      draws: tap.batch.splice(0), uploads: tap.uploads.splice(0),
      uploadsCapped: !!tap.uploadsCapped, uniforms: Object.assign({}, tap.uniforms),
    });
  }
  setInterval(report, 250);
  if (self.OffscreenCanvas) {
    const oGC = OffscreenCanvas.prototype.getContext;
    OffscreenCanvas.prototype.getContext = function (type, ...a) {
      const ctx = oGC.call(this, type, ...a);
      if (ctx && (type === 'webgl2' || type === 'webgl')) {
        chan.postMessage({ kind: 'ctx', src: 'worker', type, timeOrigin: performance.timeOrigin });
        return __mkWrapGl(ctx, tap, report);
      }
      return ctx;
    };
  }
})();
`;

// Main-thread collector (addInitScript): accumulates worker batches from the
// BroadcastChannel, taps main-thread canvases with the same core, and records the
// postMessage inputs the page feeds its Web Workers (scroll progress etc. — the animation's
// input signal, kept as provenance and for input-replay during verification).
export const GL_TAP_MAIN_SOURCE = `
${TAP_CORE}
(() => {
  if (window.__mkGl) return;
  const g = (window.__mkGl = {
    mainTimeOrigin: performance.timeOrigin,
    batches: [],
    ctx: [],
    inputs: [],
    canvases: [],
  });
  const chan = new BroadcastChannel('${CHANNEL_NAME}');
  chan.onmessage = (e) => {
    if (!e.data) return;
    if (e.data.kind === 'draws') g.batches.push(e.data);
    else if (e.data.kind === 'ctx') g.ctx.push(e.data);
  };
  // main-thread canvases: same tap, direct accumulation
  const tap = { frame: 0, batch: [], texN: 0, progN: 0, uploads: [], uniforms: {}, uploadsCapped: false };
  const RAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => RAF((ts) => { tap.frame++; cb(ts); });
  function report() {
    if (!tap.batch.length && !tap.uploads.length) return;
    g.batches.push({
      kind: 'draws', src: 'main', timeOrigin: performance.timeOrigin,
      draws: tap.batch.splice(0), uploads: tap.uploads.splice(0),
      uploadsCapped: !!tap.uploadsCapped, uniforms: Object.assign({}, tap.uniforms),
    });
  }
  setInterval(report, 250);
  const oGC = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...a) {
    const ctx = oGC.call(this, type, ...a);
    if (ctx && (type === 'webgl2' || type === 'webgl')) {
      g.ctx.push({ kind: 'ctx', src: 'main', type, timeOrigin: performance.timeOrigin });
      return __mkWrapGl(ctx, tap, report);
    }
    return ctx;
  };
  // record inputs flowing to Web Workers (structured-clone-safe summary only)
  const W = window.Worker;
  if (W) {
    window.Worker = function (url, ...rest) {
      const w = new W(url, ...rest);
      const name = (String(url).match(/([A-Za-z0-9_-]+)\\.worker/) || [null, 'worker'])[1];
      const pm = w.postMessage.bind(w);
      w.postMessage = function (data, ...a) {
        try {
          const brief = JSON.parse(JSON.stringify(data, (k, v) => {
            if (typeof OffscreenCanvas !== 'undefined' && v instanceof OffscreenCanvas) return '[OffscreenCanvas]';
            if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return '[binary]';
            return v;
          }));
          g.inputs.push({ t: Math.round(performance.now() * 10) / 10, worker: name, data: brief });
        } catch {}
        return pm(data, ...a);
      };
      return w;
    };
    window.Worker.prototype = W.prototype;
  }
  // canvas geometry so view-space can be projected to page pixels
  const size = () => {
    g.canvases = Array.from(document.querySelectorAll('canvas')).map((c) => {
      const r = c.getBoundingClientRect();
      return { w: c.width, h: c.height, cssW: r.width, cssH: r.height, top: r.top + scrollY, left: r.left + scrollX };
    });
  };
  addEventListener('DOMContentLoaded', () => setTimeout(size, 500));
})();
`;

// Route interception: prepend the worker tap to any script whose URL looks like a worker
// bundle. The pattern is stored with the trace for reproducibility.
export const DEFAULT_WORKER_PATTERN = 'worker';

export async function installGlTap(page, { workerPattern = DEFAULT_WORKER_PATTERN } = {}) {
  const re = new RegExp(workerPattern, 'i');
  await page.route(
    (url) => re.test(url.pathname) && url.pathname.endsWith('.js'),
    async (route) => {
      const resp = await route.fetch();
      const body = await resp.text();
      await route.fulfill({ response: resp, body: `${GL_TAP_WORKER_SOURCE}\n${body}` });
    },
  );
  await page.addInitScript({ content: GL_TAP_MAIN_SOURCE });
}

export async function collectGlTap(page) {
  return page.evaluate(() => {
    const g = window.__mkGl;
    if (!g) return null;
    return {
      mainTimeOrigin: g.mainTimeOrigin,
      ctx: g.ctx,
      inputs: g.inputs,
      canvases: g.canvases,
      batches: g.batches.splice(0),
    };
  });
}

const norm3 = (a, b, c) => Math.hypot(a, b, c);

// Texture-upload records → per-texture upload-stats series on the MAIN page clock.
// Textures updated repeatedly (≥5 updates) are "dynamic" — the displacement-field
// fitter's candidates. Stats exist only where the upload carried a Float32Array.
export function reconstructUploads(raw) {
  if (!raw || !raw.batches?.length) return { textures: [], capped: false };
  let capped = false;
  const byTex = new Map();
  for (const b of raw.batches) {
    const dt = b.timeOrigin - raw.mainTimeOrigin;
    if (b.uploadsCapped) capped = true;
    for (const u of b.uploads || []) {
      const key = `${b.src}:${u.tex ?? 'null'}`;
      if (!byTex.has(key)) byTex.set(key, { tex: u.tex ?? null, src: b.src, w: 0, h: 0, inits: 0, updates: 0, statsSkipped: null, series: [] });
      const rec = byTex.get(key);
      if (u.kind === 'init') rec.inits++;
      else rec.updates++;
      if (u.w) { rec.w = u.w; rec.h = u.h; }
      if (u.statsSkipped) rec.statsSkipped = u.statsSkipped;
      if (u.stats) rec.series.push({ t: +(u.t + dt).toFixed(1), ...u.stats });
    }
  }
  const textures = [...byTex.values()].map((r) => ({
    tex: r.tex,
    src: r.src,
    w: r.w,
    h: r.h,
    inits: r.inits,
    updates: r.updates,
    dynamic: r.updates >= 5,
    channels: r.series.length ? r.series[r.series.length - 1].comps : null,
    ...(r.statsSkipped ? { statsSkipped: r.statsSkipped } : {}),
    series: r.series.sort((a, b) => a.t - b.t),
  }));
  return { textures, capped };
}

// Last-set scalar/vec uniform values by name, merged across batches in arrival order
// (later batches win — they carry later snapshots of the same last-value map).
export function mergedUniforms(raw) {
  const out = {};
  for (const b of raw?.batches ?? []) {
    if (b.uniforms) Object.assign(out, b.uniforms);
  }
  return out;
}

// Draw records → per-object tracks. Objects are clustered by stable lateral view-space
// position; each cluster verifies its own assumption (xyDrift is reported, never hidden).
// Multi-pass renderers draw each object several times per frame — dedup keeps the last
// draw of a frame (the one that produced visible pixels).
export function reconstructTracks(raw, { xyEps = 0.08, matNames = { projection: /projection/i, modelView: /modelview|worldview/i } } = {}) {
  const uploads = reconstructUploads(raw);
  const uniforms = mergedUniforms(raw);
  const capWarnings = uploads.capped ? ['texture-upload log capped at 20000 records per context — later uploads dropped'] : [];
  if (!raw || !raw.batches?.length) {
    return { tracks: [], projection: null, fog: null, uploads, uniforms, warnings: ['no GL draw records captured'], drawCount: 0, frameCount: 0 };
  }
  const warnings = [...capWarnings];
  const draws = [];
  for (const b of raw.batches) {
    const dt = b.timeOrigin - raw.mainTimeOrigin;
    for (const d of b.draws) draws.push({ ...d, t: d.t + dt, src: b.src });
  }
  draws.sort((a, b) => a.t - b.t);

  // pick uniform names by pattern from what was actually seen
  const seenNames = new Set();
  for (const d of draws) for (const k of Object.keys(d.mats || {})) seenNames.add(k);
  const projName = [...seenNames].find((n) => matNames.projection.test(n));
  const mvName = [...seenNames].find((n) => matNames.modelView.test(n));
  if (!projName || !mvName) {
    return {
      tracks: [], projection: null, fog: null, uploads, uniforms, drawCount: draws.length, frameCount: 0,
      warnings: [...capWarnings, `could not identify projection/modelView uniforms among [${[...seenNames].join(', ')}]`],
    };
  }

  // per (src, frame, cluster) keep the LAST draw
  const items = [];
  for (const d of draws) {
    const mv = d.mats[mvName];
    if (!mv) continue;
    items.push({
      f: `${d.src}:${d.f}`,
      t: d.t,
      x: mv[12], y: mv[13], z: mv[14],
      sx: norm3(mv[0], mv[1], mv[2]),
      sy: norm3(mv[4], mv[5], mv[6]),
      tex: d.tex,
      opacity: d.floats?.opacity ?? null,
      fogNear: d.floats?.fogNear ?? null,
      fogFar: d.floats?.fogFar ?? null,
      fogColor: d.vecs?.fogColor ?? null,
      proj: d.mats[projName],
    });
  }

  // cluster by lateral position
  const clusters = [];
  const find = (x, y) => clusters.find((c) => Math.abs(c.x - x) < xyEps && Math.abs(c.y - y) < xyEps);
  for (const it of items) {
    let c = find(it.x, it.y);
    if (!c) {
      c = { x: it.x, y: it.y, byFrame: new Map() };
      clusters.push(c);
    }
    c.byFrame.set(it.f, it); // last draw of the frame wins
  }

  // representative projection: last seen (post-resize)
  const lastProj = items.length ? items[items.length - 1].proj : null;

  const tracks = clusters
    .map((c, i) => {
      const samples = [...c.byFrame.values()].sort((a, b) => a.t - b.t);
      const xs = samples.map((s) => s.x);
      const ys = samples.map((s) => s.y);
      const xyDrift = Math.max(
        Math.max(...xs) - Math.min(...xs),
        Math.max(...ys) - Math.min(...ys),
      );
      return {
        id: i + 1,
        path: `gl:item${i + 1}`,
        x: c.x,
        y: c.y,
        sx: samples[0].sx,
        sy: samples[0].sy,
        tex: samples[0].tex,
        xyDrift: +xyDrift.toFixed(4),
        samples: samples.map((s) => ({ t: +s.t.toFixed(1), z: +s.z.toFixed(4), sx: +s.sx.toFixed(4), sy: +s.sy.toFixed(4), opacity: s.opacity })),
      };
    })
    .filter((tr) => tr.samples.length > 3);

  const drifty = tracks.filter((t) => t.xyDrift > xyEps * 2);
  if (drifty.length) {
    warnings.push(`${drifty.length}/${tracks.length} tracks drift laterally (max ${Math.max(...drifty.map((t) => t.xyDrift)).toFixed(3)}) — (x,y)-cluster identity is unreliable for them`);
  }

  // fog constants (median over draws that carried them)
  const med = (arr) => {
    const v = arr.filter((n) => n != null && isFinite(n)).sort((a, b) => a - b);
    return v.length ? v[(v.length / 2) | 0] : null;
  };
  const fog = {
    near: med(items.map((i) => i.fogNear)),
    far: med(items.map((i) => i.fogFar)),
    color: items.map((i) => i.fogColor).filter(Boolean).pop() ?? null,
  };

  const frameCount = new Set(items.map((i) => i.f)).size;
  return {
    tracks,
    projection: lastProj,
    fog: fog.near != null || fog.far != null ? fog : null,
    uploads,
    uniforms,
    drawCount: draws.length,
    frameCount,
    warnings,
  };
}

// fov-form projection matrix → CSS perspective in px for a given canvas CSS height.
export function perspectivePx(projection, cssHeight) {
  if (!projection || !cssHeight) return null;
  const p5 = projection[5]; // 1/tan(fovY/2)
  if (!(p5 > 0)) return null;
  return +(p5 * (cssHeight / 2)).toFixed(1);
}
