// GL pointer-displacement fits → a library entry with a dependency-free WebGL runtime.
// Unlike the tunnel (whose projection collapses into CSS 3D), a displacement field IS a
// fragment-shader effect — there is no CSS equivalent — so the runtime ships a minimal
// WebGL2 implementation of the classic technique, parameterized ENTIRELY by fitted
// values: grid dims, per-frame relaxation, injection gain, impulse radius, optional
// pointer-follower τ, and the shader amplitude constants captured from the source's
// init-time uniforms.
//
// fidelity: 'fitted' (never verbatim — Tier 3G measures and refits, it does not copy
// code). Third-party imagery is NOT baked in: the image is a required caller input; the
// source page's identity lives in meta.provenance as observed facts.
import { join } from 'node:path';
import { mergeIndex, readJson, writeArtifact, slug } from '../lib/artifacts.js';

function runtimeSource({ model, sourceUrl, confidence }) {
  const disp = model.amplitude?.displacement?.value ?? 0.015;
  const aber = model.amplitude?.aberration?.value ?? 0;
  return `// captured ${sourceUrl} — Tier 3G FITTED pointer-displacement field (energy replay confidence ${confidence}), not verbatim
// Motion model, all values measured from the GL texture-upload stream:
//   ${model.grid.w}×${model.grid.h} float grid; per-frame relaxation ${model.decay.relaxation} (at ${model.decay.frameMs}ms — t½ ${model.decay.halfLifeMs}ms)
//   cursor injects its velocity vector within ≈${model.radius.radiusCells} cells (linear falloff)
//   injection gain ${model.gain} Σ|grid| per L1 px of pointer travel${model.pointerFollower ? `, smoothed by a τ=${model.pointerFollower.tauMs}ms pointer follower` : ''}
//   shader amplitudes (source init-time uniforms): displacement ${disp}${aber ? `, RGB aberration ${aber}` : ''}

export const model = ${JSON.stringify(
    {
      kind: 'pointer-displacement',
      grid: model.grid,
      relaxation: model.decay.relaxation,
      frameMs: model.decay.frameMs,
      gain: model.gain,
      radiusCells: model.radius.radiusCells,
      followerTauMs: model.pointerFollower?.tauMs ?? 0,
      displacement: disp,
      aberration: aber,
    },
    null,
    2,
  )};

// createPixelDistortion(container, { image, ...overrides })
//   container: positioned element; a full-size canvas is appended to it
//   image:     REQUIRED image URL (the library ships no third-party assets)
// Returns { pause, resume, destroy } — or null (reduced motion / no WebGL2).
export function createPixelDistortion(container, opts = {}) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
  const m = { ...model, ...opts.model };
  if (!opts.image) throw new Error('createPixelDistortion: opts.image is required');

  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
  container.appendChild(canvas);
  const gl = canvas.getContext('webgl2', { antialias: false });
  if (!gl) { canvas.remove(); return null; }

  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER,
    '#version 300 es\\nin vec2 pos; out vec2 vUv;' +
    'void main(){ vUv = pos * 0.5 + 0.5; gl_Position = vec4(pos, 0.0, 1.0); }'));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER,
    '#version 300 es\\nprecision highp float; in vec2 vUv; out vec4 color;' +
    'uniform sampler2D uImage; uniform sampler2D uGrid;' +
    'uniform float uDisplacement; uniform float uAberration;' +
    'void main(){' +
    // flip V once for BOTH textures: image rows and the pointer-injected grid
    // are top-origin, clip space is bottom-origin — one shared flip keeps the
    // ripple under the cursor AND the image upright
    '  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);' +
    '  vec2 d = texture(uGrid, uv).rg * uDisplacement;' +
    '  float r = texture(uImage, uv - d * (1.0 + uAberration)).r;' +
    '  float g = texture(uImage, uv - d).g;' +
    '  float b = texture(uImage, uv - d * (1.0 - uAberration)).b;' +
    '  color = vec4(r, g, b, 1.0);' +
    '}'));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(prog, 'pos');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  gl.activeTexture(gl.TEXTURE0);
  const imageTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, imageTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, imageTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  };
  img.src = opts.image;

  const W = m.grid.w;
  const H = m.grid.h;
  const grid = new Float32Array(W * H * 2);
  gl.activeTexture(gl.TEXTURE1);
  const gridTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, gridTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, W, H, 0, gl.RG, gl.FLOAT, grid);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.uniform1i(gl.getUniformLocation(prog, 'uImage'), 0);
  gl.uniform1i(gl.getUniformLocation(prog, 'uGrid'), 1);
  gl.uniform1f(gl.getUniformLocation(prog, 'uDisplacement'), m.displacement);
  gl.uniform1f(gl.getUniformLocation(prog, 'uAberration'), m.aberration);

  // fitted gain = Σ|grid| per L1 px = perCellScale · Σf over the falloff disk;
  // for linear falloff Σf ≈ π·R²/3, so the per-cell impulse recovers the total
  const R = m.radiusCells;
  const perCell = m.gain / ((Math.PI * R * R) / 3);

  let mouse = null; // page-space
  let follower = null;
  const onMove = (e) => {
    const r = canvas.getBoundingClientRect();
    mouse = { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  };
  container.addEventListener('mousemove', onMove, { passive: true });

  let running = true;
  let raf = 0;
  let last = null;
  function tick(now) {
    if (!running) return;
    const dt = last == null ? m.frameMs : Math.min(100, now - last);
    last = now;
    const decay = Math.pow(m.relaxation, dt / m.frameMs);
    for (let i = 0; i < grid.length; i++) grid[i] *= decay;
    if (mouse) {
      if (!follower) follower = { x: mouse.x, y: mouse.y };
      const target = m.followerTauMs
        ? (() => {
            const a = 1 - Math.exp(-dt / m.followerTauMs);
            return { x: follower.x + (mouse.x - follower.x) * a, y: follower.y + (mouse.y - follower.y) * a };
          })()
        : { x: mouse.x, y: mouse.y };
      const dx = target.x - follower.x;
      const dy = target.y - follower.y;
      if (dx !== 0 || dy !== 0) {
        const gx = (target.x / mouse.w) * W;
        const gy = (target.y / mouse.h) * H;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const d = Math.hypot(x + 0.5 - gx, y + 0.5 - gy);
            if (d >= R) continue;
            const f = (1 - d / R) * perCell;
            grid[(y * W + x) * 2] += dx * f;
            grid[(y * W + x) * 2 + 1] += dy * f;
          }
        }
      }
      follower = target;
    }
    if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RG, gl.FLOAT, grid);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);

  return {
    pause() { running = false; cancelAnimationFrame(raf); },
    resume() { if (!running) { running = true; last = null; raf = requestAnimationFrame(tick); } },
    destroy() { cancelAnimationFrame(raf); container.removeEventListener('mousemove', onMove); canvas.remove(); },
  };
}
`;
}

export async function runExportDisplacement({ traceDir, out = 'library', minConfidence = 0.7 }) {
  const glFits = readJson(join(traceDir, 'gl-fits.json'));
  const entries = [];
  if (!glFits.ok || !glFits.model) {
    return { out, entries, skipped: [{ path: 'gl', reason: 'no valid GL fit in gl-fits.json' }] };
  }
  if (glFits.model.kind !== 'pointer-displacement') {
    return { out, entries, skipped: [{ path: 'gl', reason: `gl-fits.json holds a ${glFits.model.kind} fit — not displacement material` }] };
  }
  const confidence = glFits.replay?.confidence ?? 0;
  if (confidence < minConfidence) {
    return {
      out,
      entries,
      skipped: [{ path: 'gl', reason: `energy replay confidence ${confidence} below ${minConfidence} — convergence-loop candidate, not library material` }],
    };
  }
  const host = new URL(glFits.url).hostname.replace(/^www\./, '').split('.')[0];
  const name = slug(`pixel-distortion-${host}-fitted`);
  const code = runtimeSource({ model: glFits.model, sourceUrl: glFits.url, confidence });
  writeArtifact(out, `${name}/${name}.js`, code);
  writeArtifact(out, `${name}/registry-item.json`, {
    $schema: 'https://ui.shadcn.com/schema/registry-item.json',
    name,
    type: 'registry:item',
    files: [{ path: `${name}.js`, type: 'registry:file', target: `lib/${name}.js` }],
    meta: {
      animation: {
        trigger: glFits.trigger,
        captureTier: '3G',
        fidelity: 'fitted',
        engines: ['webgl-pointer'],
        semantic: { model: { ...glFits.model, uniforms: undefined }, confidence },
        verbatim: null,
        provenance: {
          sourceUrl: glFits.url,
          capturedAt: glFits.capturedAt,
          note: 'model parameters measured from the GL texture-upload stream; runtime is original code; no source assets included',
        },
        reducedMotion: 'disable',
      },
    },
  });
  entries.push({ name, path: 'gl:displacement', confidence, channels: ['displacement-grid'] });
  mergeIndex(out, entries, glFits.capturedAt);
  return { out, entries, skipped: [] };
}
