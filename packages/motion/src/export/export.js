import { join } from 'node:path';
import { mergeIndex, readJson, writeArtifact, slug } from '../lib/artifacts.js';
import { waapiToMotionTransition } from '../lib/motion-convert.js';

// Turn a capture into local library entries: one directory per animation with usable code
// (CSS or WAAPI JS) plus a registry-item.json carrying the two-layer payload. Hosted
// registry + MCP distribution is deferred (Phase 2) — the format here is intentionally
// shadcn-registry-shaped so it can be served later without rework.

const KEYFRAME_META = new Set(['offset', 'computedOffset', 'easing', 'composite']);

export function camelToKebab(p) {
  if (p === 'cssFloat') return 'float';
  if (p === 'cssOffset') return 'offset';
  return p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

export function synthesizeKeyframesCss(name, keyframes) {
  const stops = (keyframes || []).map((k) => {
    const off = typeof k.offset === 'number' ? k.offset : (k.computedOffset ?? 0);
    const props = [];
    for (const [p, v] of Object.entries(k)) {
      if (KEYFRAME_META.has(p) || v == null) continue;
      props.push(`${camelToKebab(p)}: ${v};`);
    }
    if (k.easing && k.easing !== 'linear') props.push(`animation-timing-function: ${k.easing};`);
    const pct = `${+(off * 100).toFixed(2)}%`;
    return `  ${pct} { ${props.join(' ')} }`;
  });
  return `@keyframes ${name} {\n${stops.join('\n')}\n}`;
}

// Where the author's timing function lives is TYPE-dependent (verified against real
// captures, not just fixtures):
//  - CSS animations: the curve surfaces as per-keyframe easing in getKeyframes();
//    effect-level easing stays 'linear'. timing.easing would discard the author's curve.
//  - CSS transitions: exactly the opposite — getKeyframes() easing is 'linear' and the
//    author's curve (e.g. Linear's cubic-bezier(.25,.46,.45,.94)) IS timing.easing.
export function effectiveEasing(rec) {
  if (rec?.type === 'CSSTransition') {
    const eff = rec?.waapi?.timing?.easing;
    if (eff && eff !== 'linear') return eff;
    return rec?.waapi?.keyframes?.[0]?.easing || eff || 'ease';
  }
  return rec?.waapi?.keyframes?.[0]?.easing || rec?.waapi?.timing?.easing || 'ease';
}

export function animationShorthand(name, timing = {}, easing = null) {
  const dur = typeof timing.duration === 'number' ? `${timing.duration}ms` : '1s';
  const parts = [name, dur, easing || timing.easing || 'ease'];
  if (timing.delay) parts.push(`${timing.delay}ms`);
  if (timing.iterations === 'Infinity') parts.push('infinite');
  else if (typeof timing.iterations === 'number' && timing.iterations !== 1) parts.push(String(timing.iterations));
  if (timing.direction && timing.direction !== 'normal') parts.push(timing.direction);
  if (timing.fill && timing.fill !== 'none') parts.push(timing.fill);
  return parts.join(' ');
}

function rangePart(r) {
  if (!r || r === 'normal') return null;
  if (typeof r === 'string') return r;
  return [r.rangeName, r.offset].filter(Boolean).join(' ');
}

function cssEntry(rec, className, animName) {
  const timing = rec.waapi?.timing || {};
  const lines = [];
  const synthesized = !rec.cssRuleText;
  lines.push(synthesized ? synthesizeKeyframesCss(animName, rec.waapi?.keyframes) : rec.cssRuleText);
  lines.push('');
  const decls = [`animation: ${animationShorthand(animName, timing, effectiveEasing(rec))};`];
  if (rec.scrollDriven && rec.waapi?.timeline) {
    const tl = rec.waapi.timeline;
    decls.push(`animation-timeline: ${tl.kind === 'view' ? 'view()' : 'scroll()'};`);
    const start = rangePart(rec.waapi.rangeStart);
    const end = rangePart(rec.waapi.rangeEnd);
    if (start || end) decls.push(`animation-range: ${[start, end].filter(Boolean).join(' ')};`);
  }
  lines.push(`.${className} {\n  ${decls.join('\n  ')}\n}`);
  lines.push('');
  lines.push(`@media (prefers-reduced-motion: reduce) {\n  .${className} { animation: none; }\n}`);
  return { code: lines.join('\n'), synthesized };
}

function transitionEntry(rec, className) {
  const timing = rec.waapi?.timing || {};
  const prop = rec.name || 'all';
  const dur = typeof timing.duration === 'number' ? timing.duration : 300;
  const kf = rec.waapi?.keyframes || [];
  const from = kf[0]?.[Object.keys(kf[0] || {}).find((k) => !KEYFRAME_META.has(k))];
  const to = kf[kf.length - 1]?.[Object.keys(kf[kf.length - 1] || {}).find((k) => !KEYFRAME_META.has(k))];
  const comment = `/* captured ${rec.name} transition (trigger: see registry-item meta)\n   observed: ${from} → ${to} */`;
  const decl = `transition: ${camelToKebab(prop)} ${dur}ms ${effectiveEasing(rec)}${timing.delay ? ` ${timing.delay}ms` : ''};`;
  return {
    code: `${comment}\n.${className} {\n  ${decl}\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .${className} { transition: none; }\n}`,
    synthesized: false,
  };
}

function waapiEntry(rec, fnName) {
  const timing = rec.waapi?.timing || {};
  const opts = {};
  for (const [k, v] of Object.entries(timing)) {
    if (v == null) continue;
    if (k === 'iterations' && v === 'Infinity') opts[k] = 'Infinity';
    else if (k === 'duration' && typeof v !== 'number') continue;
    else opts[k] = v;
  }
  const optsSrc = JSON.stringify(opts, null, 2).replace('"Infinity"', 'Infinity');
  const kfSrc = JSON.stringify(
    (rec.waapi?.keyframes || []).map((k) => {
      const o = {};
      for (const [p, v] of Object.entries(k)) if (p !== 'computedOffset' && v != null) o[p] = v;
      return o;
    }),
    null,
    2,
  );
  return {
    code: `// captured Web Animations API animation — apply with ${fnName}(element)
export function ${fnName}(el, overrides = {}) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
  return el.animate(${kfSrc}, { ...${optsSrc}, ...overrides });
}
`,
    synthesized: false,
  };
}

export function buildEntry(rec, summary, entryName) {
  const className = `mk-${entryName}`;
  const animName = rec.name && /^[a-zA-Z_][\w-]*$/.test(rec.name) ? rec.name : `mk-${entryName}-kf`;
  let file;
  let generated;
  if (rec.type === 'CSSTransition') {
    generated = transitionEntry(rec, className);
    file = { name: `${entryName}.css`, kind: 'css' };
  } else if (rec.type === 'CSSAnimation') {
    generated = cssEntry(rec, className, animName);
    file = { name: `${entryName}.css`, kind: 'css' };
  } else {
    const fnName = entryName.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
    generated = waapiEntry(rec, `apply${fnName[0].toUpperCase()}${fnName.slice(1)}`);
    file = { name: `${entryName}.js`, kind: 'js' };
  }
  const item = {
    $schema: 'https://ui.shadcn.com/schema/registry-item.json',
    name: entryName,
    type: 'registry:item',
    files: [{ path: file.name, type: 'registry:file', target: `${file.kind === 'css' ? 'styles' : 'lib'}/${file.name}` }],
    meta: {
      animation: {
        trigger: summary.trigger,
        captureTier: rec.tier,
        fidelity: 'verbatim',
        engine: rec.type,
        target: rec.target ?? null,
        verbatim: {
          keyframes: rec.waapi?.keyframes ?? null,
          timing: rec.waapi?.timing ?? null,
          cssRuleText: rec.cssRuleText ?? null,
          synthesizedCss: generated.synthesized,
          timeline: rec.waapi?.timeline ?? null,
          rangeStart: rec.waapi?.rangeStart ?? null,
          rangeEnd: rec.waapi?.rangeEnd ?? null,
          scrollTimeline: rec.cdp?.viewOrScrollTimeline ?? null,
        },
        semantic: {
          trigger: summary.trigger,
          // Motion's transition schema is the canonical semantic vocabulary (docs/SCHEMA.md)
          transition: waapiToMotionTransition(rec.waapi, { authorEasing: effectiveEasing(rec) }),
          scrollDriven: !!rec.scrollDriven,
          confidence: 1, // verbatim tiers: replay-gated, not fitted
        },
        provenance: {
          sourceUrl: summary.url,
          capturedAt: summary.capturedAt,
          referenceVideo: summary.referenceVideo,
        },
        reducedMotion: 'disable',
      },
    },
  };
  return { item, file: { ...file, code: generated.code } };
}

export async function runExport({ captureDir, out = 'library' }) {
  const summary = readJson(join(captureDir, 'capture.json'));
  const entries = [];
  const skipped = [];
  const used = new Set();
  for (const a of summary.animations) {
    const rec = readJson(join(captureDir, a.artifact));
    if (!rec.resolved || !rec.waapi?.keyframes?.length) {
      skipped.push({ key: rec.key, reason: 'no verbatim payload' });
      continue;
    }
    const base = slug(`${rec.name || rec.type}-${new URL(summary.url).hostname.replace(/^www\./, '').split('.')[0]}`);
    let entryName = base;
    for (let i = 2; used.has(entryName); i++) entryName = `${base}-${i}`;
    used.add(entryName);
    const { item, file } = buildEntry(rec, summary, entryName);
    writeArtifact(out, `${entryName}/${file.name}`, file.code);
    writeArtifact(out, `${entryName}/registry-item.json`, item);
    entries.push({ name: entryName, engine: rec.type, tier: rec.tier, files: [file.name] });
  }
  mergeIndex(out, entries, summary.capturedAt);
  return { out, entries, skipped };
}
