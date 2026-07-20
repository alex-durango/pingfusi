// Motion (motion.dev) transition objects are the CANONICAL semantic-layer vocabulary
// (decision 2026-07-07, see docs/SCHEMA.md): Figma Motion exports React targeting
// motion.dev, Figma Sites animations run on Motion, and Motion's keyframe model descends
// from WAAPI — the same {keyframes, transition} vocabulary spans capture, agent
// consumption, and design tools. The verbatim layer stays WAAPI-shaped; this utility is
// the whole WAAPI→Motion bridge (deliberately small — a conversion, not a schema).

export function cssEasingToMotion(easing) {
  if (!easing) return undefined;
  const s = easing.trim();
  if (s === 'linear') return 'linear';
  if (s === 'ease') return [0.25, 0.1, 0.25, 1]; // CSS 'ease' has no Motion name
  if (s === 'ease-in') return 'easeIn';
  if (s === 'ease-out') return 'easeOut';
  if (s === 'ease-in-out') return 'easeInOut';
  const m = /^cubic-bezier\(([^)]+)\)$/.exec(s);
  if (m) {
    const v = m[1].split(',').map(Number);
    if (v.length === 4 && v.every(Number.isFinite)) return v;
  }
  return s; // steps(...) etc. pass through untranslated
}

// waapi: a captured record's verbatim { timing, keyframes }. Returns a Motion transition.
// JSON convention: Infinity serializes as the string "Infinity" (JSON.stringify would
// silently null it) — consumers map it back.
// authorEasing: pass the type-aware effectiveEasing() result for CSS transitions, where
// the author's curve lives at the effect level and keyframe easing is always 'linear'.
export function waapiToMotionTransition(waapi, { authorEasing = null } = {}) {
  const timing = waapi?.timing || {};
  const kf = waapi?.keyframes || [];
  const durS = typeof timing.duration === 'number' ? timing.duration / 1000 : undefined;
  const t = {};
  if (kf.length > 2) {
    t.type = 'keyframes';
    if (durS != null) t.duration = durS;
    const times = kf
      .map((k) => (typeof k.offset === 'number' ? k.offset : k.computedOffset))
      .filter((v) => typeof v === 'number');
    if (times.length === kf.length) t.times = times;
    // Motion's per-segment ease array: segment i uses keyframe i's easing (last unused)
    const ease = kf.slice(0, -1).map((k) => cssEasingToMotion(k.easing || 'linear'));
    t.ease = ease.length === 1 ? ease[0] : ease;
  } else {
    t.type = 'tween';
    if (durS != null) t.duration = durS;
    // CSS animations carry the author's curve in keyframe[0].easing; CSS transitions in
    // timing.easing (callers pass authorEasing to disambiguate)
    t.ease = cssEasingToMotion(authorEasing || kf[0]?.easing || timing.easing || 'ease');
  }
  if (typeof timing.delay === 'number' && timing.delay > 0) t.delay = timing.delay / 1000;
  if (timing.iterations === 'Infinity') t.repeat = 'Infinity';
  else if (typeof timing.iterations === 'number' && timing.iterations > 1) t.repeat = timing.iterations - 1;
  if (timing.direction === 'alternate' || timing.direction === 'alternate-reverse') t.repeatType = 'mirror';
  else if (timing.direction === 'reverse') t.repeatType = 'reverse';
  return t;
}
