// GL tunnel fits → a library entry with a dependency-free DOM/CSS-3D runtime.
// Why no WebGL in the export: with `perspective: Ppx` on the container and an item at
// translateZ(P − d·U) (d = view-space depth in world units, U = arbitrary px-per-unit),
// CSS renders lateral offset x·P/d and size w·P/d — exactly the GL projection when
// P = fitted focal length in px. U cancels everywhere, so the replay is projection-exact
// without a canvas. Fog becomes an opacity ramp toward a matching page background.
//
// fidelity: 'fitted' (never verbatim — Tier 3G measures and refits, it does not copy
// code). Third-party imagery is NOT baked in: images are a required caller input; the
// source page's image URLs live in meta.provenance as observed facts.
import { join } from 'node:path';
import { mergeIndex, readJson, writeArtifact, slug } from '../lib/artifacts.js';

function runtimeSource({ name, model, perspectivePx, sourceUrl, confidence }) {
  const L = model.layout;
  const S = model.speed;
  const items = L.items.map((it) => ({ x: it.x, y: it.y, sx: it.sx, sy: it.sy, tex: it.tex }));
  const fogColor = model.fog?.color
    ? `rgb(${model.fog.color.slice(0, 3).map((c) => Math.round(c * 255)).join(', ')})`
    : null;
  const spacingStretch = L.spacingByProgress
    ? { from: L.spacingByProgress[0].spacing, to: L.spacingByProgress[L.spacingByProgress.length - 1].spacing }
    : null;

  return `// captured ${sourceUrl} — Tier 3G FITTED parallax-tunnel (replay confidence ${confidence}), not verbatim
// Motion model, all values measured from the rendered GL stream:
//   idle drift ${S.idle} u/s toward the viewer; wrap past the camera to the back of the pack
//   intro burst: ${S.intro ? `${S.intro.v0} u/s decaying to idle with half-life ${S.intro.halfLifeMs}ms` : 'none observed'}
//   scroll link: ${S.scroll?.form === 'expo-out' ? `v(p) = idle + ${S.scroll.span}·(1 − 2^(−${S.scroll.k}·p)) — a PERSISTENT level, not a decaying boost` : 'none observed'}
//   depth fade: fog ${model.fog ? `${model.fog.near} → ${model.fog.far}` : 'none'} toward the page background
//   ${spacingStretch ? `tunnel stretch: item spacing ${spacingStretch.from} → ${spacingStretch.to} as p goes 0 → 1 (applied via wrap length)` : 'constant item spacing'}

export const model = ${JSON.stringify(
    {
      kind: 'parallax-tunnel',
      perspectivePx,
      itemCount: L.itemCount,
      radius: L.radius,
      spacing: L.spacingByProgress?.[0]?.spacing ?? L.spacing,
      spacingStretch,
      items,
      speed: {
        idle: S.idle,
        intro: S.intro ? { v0: S.intro.v0, halfLifeMs: S.intro.halfLifeMs } : null,
        scroll: S.scroll?.form === 'expo-out' ? { span: S.scroll.span, k: S.scroll.k } : null,
      },
      fog: model.fog ? { near: model.fog.near, far: model.fog.far, color: fogColor } : null,
    },
    null,
    2,
  )};

// createParallaxTunnel(container, { images, ...overrides })
//   container: positioned element that becomes the 3D viewport (its background should
//              match model.fog.color — the fade assumes it)
//   images:    REQUIRED array of image URLs; items cycle through them
//   progress:  optional external progress driver; otherwise call .setProgress(0..1)
// Returns { setProgress, pause, resume, destroy }.
export function createParallaxTunnel(container, opts = {}) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
  const m = { ...model, ...opts.model };
  const images = opts.images;
  if (!images || !images.length) throw new Error('createParallaxTunnel: opts.images is required (the library ships no third-party assets)');

  const U = 60; // px per world unit — cancels out of the projection (see header note);
  // chosen large so elements rasterize near their max rendered size (less upscale blur)
  const P = m.perspectivePx;
  container.style.perspective = P + 'px';
  container.style.overflow = 'hidden';

  // texture ids from the capture are arbitrary; map them onto the caller's images
  const texIds = [...new Set(m.items.map((it) => it.tex))].sort((a, b) => a - b);
  const texToImage = new Map(texIds.map((t, i) => [t, images[i % images.length]]));

  const els = m.items.map((it) => {
    const el = document.createElement('div');
    const w = it.sx * U; // world size → px at U px/unit; rendered size = sx·P/d, U-invariant
    const h = it.sy * U;
    Object.assign(el.style, {
      position: 'absolute',
      left: '50%',
      top: '50%',
      width: w + 'px',
      height: h + 'px',
      marginLeft: -w / 2 + 'px',
      marginTop: -h / 2 + 'px',
      backgroundImage: 'url(' + texToImage.get(it.tex) + ')',
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      willChange: 'transform, opacity',
      pointerEvents: 'none',
    });
    container.appendChild(el);
    return el;
  });

  // depth state: items spread across the tunnel, nearest at ~1 spacing from the camera
  const state = m.items.map((it, i) => ({ d: (i + 1) * m.spacing }));
  let progress = 0;
  let running = true;
  let introT0 = null;
  let last = null;
  let raf = 0;

  const spacingNow = () => {
    if (!m.spacingStretch || !m.speed.scroll) return m.spacing;
    const e = 1 - Math.pow(2, -m.speed.scroll.k * progress);
    return m.spacingStretch.from + (m.spacingStretch.to - m.spacingStretch.from) * e;
  };
  const speedNow = (now) => {
    let v = m.speed.idle;
    if (m.speed.intro && introT0 != null) {
      v += (m.speed.intro.v0 - m.speed.idle) * Math.pow(2, -(now - introT0) / m.speed.intro.halfLifeMs);
    }
    if (m.speed.scroll) v += m.speed.scroll.span * (1 - Math.pow(2, -m.speed.scroll.k * progress));
    return v;
  };

  function tick(now) {
    if (!running) return;
    if (introT0 == null) introT0 = now;
    const dt = last == null ? 16.7 : Math.min(100, now - last);
    last = now;
    const v = speedNow(now);
    const wrapLen = m.itemCount * spacingNow();
    for (let i = 0; i < state.length; i++) {
      const st = state[i];
      st.d -= (v * dt) / 1000; // toward the camera
      if (st.d < 0.01) st.d += wrapLen;
      const it = m.items[i];
      const el = els[i];
      // CSS projection: translateZ(P − d·U) makes size/offset scale as P/d — GL-exact
      el.style.transform =
        'translate3d(' + it.x * U + 'px, ' + -it.y * U + 'px, ' + (P - st.d * U) + 'px)';
      if (m.fog) {
        const f = Math.min(1, Math.max(0, (st.d - m.fog.near) / (m.fog.far - m.fog.near)));
        el.style.opacity = (1 - f).toFixed(3);
      }
    }
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);

  // pause off-screen, like the source (and to spare main-thread time)
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && !running) { running = true; last = null; raf = requestAnimationFrame(tick); }
      else if (!e.isIntersecting && running) { running = false; cancelAnimationFrame(raf); }
    }
  });
  io.observe(container);

  return {
    setProgress(p) { progress = Math.min(1, Math.max(0, p)); },
    pause() { running = false; cancelAnimationFrame(raf); },
    resume() { if (!running) { running = true; last = null; raf = requestAnimationFrame(tick); } },
    destroy() { io.disconnect(); cancelAnimationFrame(raf); els.forEach((el) => el.remove()); },
  };
}
`;
}

export async function runExportTunnel({ traceDir, out = 'library', minConfidence = 0.7 }) {
  const glFits = readJson(join(traceDir, 'gl-fits.json'));
  const entries = [];
  const skipped = [];
  if (!glFits.ok || !glFits.model) {
    return { out, entries, skipped: [{ path: 'gl', reason: 'no valid tunnel fit in gl-fits.json' }] };
  }
  if (glFits.model.kind !== 'parallax-tunnel') {
    return { out, entries, skipped: [{ path: 'gl', reason: `gl-fits.json holds a ${glFits.model.kind} fit — not tunnel material` }] };
  }
  const confidence = glFits.replay?.confidence ?? 0;
  if (confidence < minConfidence) {
    return {
      out,
      entries,
      skipped: [{ path: 'gl', reason: `replay confidence ${confidence} below ${minConfidence} — convergence-loop candidate, not library material` }],
    };
  }
  const host = new URL(glFits.url).hostname.replace(/^www\./, '').split('.')[0];
  const name = slug(`parallax-tunnel-${host}-fitted`);
  const code = runtimeSource({
    name,
    model: glFits.model,
    perspectivePx: glFits.perspectivePx,
    sourceUrl: glFits.url,
    confidence,
  });
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
        engines: ['webgl-worker'],
        semantic: { model: glFits.model, perspectivePx: glFits.perspectivePx, confidence },
        verbatim: null,
        provenance: {
          sourceUrl: glFits.url,
          capturedAt: glFits.capturedAt,
          note: 'model parameters measured from the GL draw stream; runtime is original code; no source assets included',
        },
        reducedMotion: 'disable',
      },
    },
  });
  entries.push({ name, path: 'gl:tunnel', confidence, channels: ['z-flow'] });

  mergeIndex(out, entries, glFits.capturedAt);
  return { out, entries, skipped };
}
