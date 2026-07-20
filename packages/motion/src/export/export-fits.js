import { join } from 'node:path';
import { mergeIndex, readJson, writeArtifact, slug } from '../lib/artifacts.js';
import { springPosition, cubicBezier } from '../tier3/motion-model.js';

// Tier 3 fits → library entries. One entry per element; the semantic layer is Motion's
// idiomatic per-value shape: keyframes {x: [0, 200], opacity: [0, 1]} + transition
// {x: {type:'spring',…}, opacity: {type:'tween',…}} (docs/SCHEMA.md). fidelity: 'fitted'
// — NEVER claim verbatim for Tier 3. Low-confidence channels are dropped loudly;
// scroll-linear / pointer-follow links ride along as a motion-kit extension, not as values.

const CHANNEL_TO_MOTION = { tx: 'x', ty: 'y', tz: 'z', sx: 'scaleX', sy: 'scaleY', rot: 'rotate', opacity: 'opacity' };
const RELATIVE = new Set(['tx', 'ty', 'tz']); // translate deltas are reusable; absolutes aren't
const TRANSFORM_CHANNELS = ['tx', 'ty', 'tz', 'rot', 'sx', 'sy'];

// Motion's own WAAPI emit approach: pre-sample the spring into a CSS linear() easing.
export function springLinearEasing(transition, valueFrom, valueTo, settleMs, steps = 32) {
  const stops = [];
  for (let i = 0; i < steps; i++) {
    const frac = i / (steps - 1);
    const v = springPosition(frac * settleMs, { ...transition, origin: valueFrom, target: valueTo });
    const p = (v - valueFrom) / (valueTo - valueFrom || 1);
    stops.push(`${+p.toFixed(4)} ${+(frac * 100).toFixed(1)}%`);
  }
  return `linear(${stops.join(', ')})`;
}

function easeToCss(ease) {
  if (Array.isArray(ease)) return `cubic-bezier(${ease.join(', ')})`;
  if (ease === 'linear') return 'linear';
  return 'ease';
}

export function buildFitEntry({ path, fits, engines, sourceUrl, capturedAt, trigger }) {
  const values = {};
  const transition = {};
  const channels = {};
  for (const f of fits) {
    const key = CHANNEL_TO_MOTION[f.channel];
    if (!key) continue;
    const from = RELATIVE.has(f.channel) ? 0 : +f.fit.valueFrom.toFixed(3);
    const to = RELATIVE.has(f.channel)
      ? +(f.fit.valueTo - f.fit.valueFrom).toFixed(3)
      : +f.fit.valueTo.toFixed(3);
    values[key] = [from, to];
    transition[key] = f.fit.transition;
    channels[f.channel] = { key, from, to, fit: f.fit };
  }
  if (!Object.keys(values).length) return null;
  const confidence = Math.min(...fits.map((f) => f.fit.confidence));

  // WAAPI fallback: transform channels combine into one animation driven by the dominant
  // channel's timing (per-key precision lives in the Motion-canonical exports above it)
  const transformChs = Object.values(channels).filter((c) => c.key !== 'opacity');
  const opacityCh = channels.opacity;
  const dominant =
    transformChs.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))[0] || opacityCh;
  const timingOf = (c) => {
    const t = c.fit.transition;
    if (t.type === 'spring') {
      const ms = c.fit.settleMs || 1000;
      return { duration: ms, easing: springLinearEasing(t, c.fit.valueFrom, c.fit.valueTo, ms) };
    }
    return { duration: Math.round((t.duration || 0.3) * 1000), easing: easeToCss(t.ease) };
  };
  const transformStr = (which) =>
    transformChs
      .map((c) => {
        const v = which === 'from' ? c.from : c.to;
        if (c.key === 'x') return `translateX(${v}px)`;
        if (c.key === 'y') return `translateY(${v}px)`;
        if (c.key === 'z') return `translateZ(${v}px)`;
        if (c.key === 'scaleX') return `scaleX(${v})`;
        if (c.key === 'scaleY') return `scaleY(${v})`;
        if (c.key === 'rotate') return `rotate(${v}deg)`;
        return '';
      })
      .filter(Boolean)
      .join(' ');
  const kfFrom = {};
  const kfTo = {};
  if (transformChs.length) {
    kfFrom.transform = transformStr('from');
    kfTo.transform = transformStr('to');
  }
  if (opacityCh) {
    kfFrom.opacity = opacityCh.from;
    kfTo.opacity = opacityCh.to;
  }
  const timing = timingOf(dominant);

  const code = `// captured ${sourceUrl} — Tier 3 FITTED (confidence ${confidence}), not verbatim
// Motion (motion.dev) — canonical semantic layer:
export const keyframes = ${JSON.stringify(values, null, 2)};
export const transition = ${JSON.stringify(transition, null, 2)};
// usage: <motion.div animate={{ ${Object.entries(values).map(([k, v]) => `${k}: ${JSON.stringify(v[1])}`).join(', ')} }}
//          transition={{ ${Object.keys(transition).map((k) => `${k}: transition.${k}`).join(', ')} }} />

// WAAPI fallback — springs pre-sampled into linear() easing (Motion's own approach);
// transform channels share the dominant channel's timing here, per-key precision is in
// the Motion exports above.
export function apply(el, overrides = {}) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
  return el.animate(
    [${JSON.stringify(kfFrom)}, ${JSON.stringify(kfTo)}],
    { duration: ${timing.duration}, easing: ${JSON.stringify(timing.easing)}, fill: 'both', ...overrides },
  );
}
`;
  return {
    values,
    transition,
    confidence,
    code,
    meta: {
      trigger,
      captureTier: 3,
      fidelity: 'fitted', // load-bearing distinction: never claim verbatim for Tier 3
      engines: engines?.engines ?? [],
      target: { path },
      semantic: { trigger, values, transition, translateRelative: true, confidence },
      verbatim: null,
      provenance: { sourceUrl, capturedAt },
      reducedMotion: 'disable',
    },
  };
}

// A scroll linkage is a runtime relationship, not a time-based keyframe transition. Keep
// it out of buildFitEntry so that the established tween/spring export remains unchanged.
// The generated entry is dependency-free: apply() samples the fitted linear relationship
// on scroll, writes one decomposed transform, and returns a cleanup function.
export function buildScrollLinkedEntry({
  path,
  fits,
  engines,
  sourceUrl,
  capturedAt,
  trigger,
  baseline = null,
  scrollRange = null,
}) {
  const links = fits
    .map((f) => {
      const key = CHANNEL_TO_MOTION[f.channel];
      if (!key || f.fit.kind !== 'scroll-linear') return null;
      return { channel: f.channel, key, ...f.fit.link };
    })
    .filter(Boolean);
  if (!links.length) return null;

  const confidence = Math.min(...fits.map((f) => f.fit.confidence));
  const baseValues = {};
  if (baseline) {
    for (const channel of TRANSFORM_CHANNELS) {
      const value = baseline[channel];
      if (Number.isFinite(value)) baseValues[CHANNEL_TO_MOTION[channel]] = value;
    }
  }
  const range =
    Array.isArray(scrollRange) &&
    scrollRange.length === 2 &&
    Number.isFinite(scrollRange[0]) &&
    Number.isFinite(scrollRange[1])
      ? [Math.min(...scrollRange), Math.max(...scrollRange)]
      : null;
  const hasTransform =
    Object.keys(baseValues).length > 0 || links.some((link) => link.key !== 'opacity');

  const code = `// captured ${sourceUrl} — Tier 3 FITTED scroll linkage (confidence ${confidence}), not verbatim
// Each channel is value = slope * scrollY + intercept. Motion users can feed the same
// scrollLinks into useTransform(useScroll().scrollY, ...); apply() is a dependency-free fallback.
export const scrollLinks = ${JSON.stringify(links, null, 2)};
export const scrollRange = ${JSON.stringify(range)};
export const baseValues = ${JSON.stringify(baseValues, null, 2)};

export function valuesAtScroll(scrollY, { clamp = true } = {}) {
  let y = Number(scrollY) || 0;
  if (clamp && scrollRange) y = Math.max(scrollRange[0], Math.min(scrollRange[1], y));
  const values = { ...baseValues };
  for (const link of scrollLinks) values[link.key] = link.slope * y + link.intercept;
  return values;
}

export function apply(el, { source = window, clamp = true } = {}) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
  let frame = 0;
  const render = () => {
    frame = 0;
    const scrollY = source === window ? window.scrollY : source.scrollTop;
    const values = valuesAtScroll(scrollY, { clamp });
    ${hasTransform ? `const x = Number.isFinite(values.x) ? values.x : 0;
    const y = Number.isFinite(values.y) ? values.y : 0;
    const z = Number.isFinite(values.z) ? values.z : 0;
    const rotate = Number.isFinite(values.rotate) ? values.rotate : 0;
    const scaleX = Number.isFinite(values.scaleX) ? values.scaleX : 1;
    const scaleY = Number.isFinite(values.scaleY) ? values.scaleY : 1;
    el.style.transform = \`translate3d(\${x}px, \${y}px, \${z}px) rotate(\${rotate}deg) scale(\${scaleX}, \${scaleY})\`;` : ''}
    if (Number.isFinite(values.opacity)) el.style.opacity = String(values.opacity);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(render);
  };
  source.addEventListener('scroll', schedule, { passive: true });
  render();
  return () => {
    source.removeEventListener('scroll', schedule);
    if (frame) cancelAnimationFrame(frame);
  };
}
`;

  const semanticLinks = links.map(({ key, ...link }) => link);
  return {
    values: {},
    transition: {},
    channels: links.map((link) => link.key),
    confidence,
    code,
    meta: {
      trigger,
      captureTier: 3,
      fidelity: 'fitted',
      engines: engines?.engines ?? [],
      target: { path },
      semantic: { trigger, scrollLinks: semanticLinks, scrollRange: range, confidence },
      scrollLinks: semanticLinks,
      verbatim: null,
      provenance: { sourceUrl, capturedAt },
      reducedMotion: 'disable',
    },
  };
}

export async function runExportFits({ traceDir, out = 'library', minConfidence = 0.85 }) {
  const fitsData = readJson(join(traceDir, 'fits.json'));
  const traceData = readJson(join(traceDir, 'trace.json'));
  const byPath = new Map();
  for (const f of fitsData.fits) {
    if (!byPath.has(f.path)) byPath.set(f.path, []);
    byPath.get(f.path).push(f);
  }
  const entries = [];
  const skipped = [];
  const used = new Set();
  const host = new URL(fitsData.url).hostname.replace(/^www\./, '').split('.')[0];
  const scrollYs = (traceData.frames ?? []).map((frame) => frame.scrollY).filter(Number.isFinite);
  const scrollRange = scrollYs.length ? [Math.min(...scrollYs), Math.max(...scrollYs)] : null;
  for (const [path, fits] of byPath) {
    const time = fits.filter((f) => f.fit.kind === 'tween' || f.fit.kind === 'spring');
    const confident = time.filter((f) => f.fit.confidence >= minConfidence);
    const dropped = time.length - confident.length;
    const scrollLinks = fits.filter((f) => f.fit.kind === 'scroll-linear' && f.fit.confidence >= minConfidence);
    const pointerLinks = fits.filter((f) => f.fit.kind === 'pointer-follow' && f.fit.confidence >= minConfidence);
    if (!confident.length && !scrollLinks.length) {
      skipped.push({
        path,
        reason: time.length
          ? `all ${time.length} time-based fit(s) below confidence ${minConfidence} — convergence-loop candidates, not library material`
          : 'no time-based fits (scroll/pointer-linked or unfitted)',
      });
      continue;
    }
    const tailBit = path.split('>').pop().trim().replace(/[#.]/g, '');
    const base = slug(`${tailBit || 'motion'}-${host}-fitted`);
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
    used.add(name);
    const traceElement = (traceData.elements ?? []).find((element) => element.path === path);
    const entry = confident.length
      ? buildFitEntry({
          path,
          fits: confident,
          engines: fitsData.engines,
          sourceUrl: fitsData.url,
          capturedAt: traceData.capturedAt,
          trigger: fitsData.trigger,
        })
      : buildScrollLinkedEntry({
          path,
          fits: scrollLinks,
          engines: fitsData.engines,
          sourceUrl: fitsData.url,
          capturedAt: traceData.capturedAt,
          trigger: fitsData.trigger,
          baseline: traceElement?.samples?.[0] ?? null,
          scrollRange,
        });
    if (!entry) continue;
    if (dropped) entry.meta.droppedChannels = dropped; // no silent trimming
    if (scrollLinks.length) {
      entry.meta.scrollLinks = scrollLinks.map((f) => ({ channel: f.channel, ...f.fit.link })); // motion-kit extension
    }
    if (pointerLinks.length) {
      entry.meta.pointerLinks = pointerLinks.map((f) => ({ channel: f.channel, ...f.fit.link })); // motion-kit extension
    }
    writeArtifact(out, `${name}/${name}.js`, entry.code);
    writeArtifact(out, `${name}/registry-item.json`, {
      $schema: 'https://ui.shadcn.com/schema/registry-item.json',
      name,
      type: 'registry:item',
      files: [{ path: `${name}.js`, type: 'registry:file', target: `lib/${name}.js` }],
      meta: { animation: entry.meta },
    });
    entries.push({
      name,
      path,
      confidence: entry.confidence,
      channels: entry.channels ?? Object.keys(entry.values),
    });
  }
  mergeIndex(out, entries, traceData.capturedAt);
  return { out, entries, skipped };
}
