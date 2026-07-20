// motion-doc.js — the one canonical motion artifact every capture tier writes into.
//
// The doc is a receipt: introspected CSS/WAAPI/GSAP declarations, sampled traces, and
// engine-fitted models all land as TRACKS in one schema, so downstream consumers (bundle
// builders, replay gates, review rounds) bind to a single shape instead of per-tier
// formats. The artifact lands at targets/<name>/motion-doc.json, written by the capture
// runner ALONGSIDE existing behavior artifacts — additive, never replacing anything, and
// never blocking an ordinary clone (quarantine doctrine: enforcement stays declared-only).
//
// Every converter validates its own output before returning it, so a doc that came out of
// this module is a doc that passes validateMotionDoc — the writer cannot ship a malformed
// receipt.
"use strict";

const crypto = require("crypto");

const SCHEMA_ID = "pingfusi/motion-doc@1";

// The closed tier vocabulary. Unknown tiers are refused: a new acquisition method must
// land here (with its converter) before its tracks can claim a place in the artifact.
const TIERS = new Set([
  "introspected-css",
  "introspected-transition",
  "introspected-waapi",
  "introspected-gsap",
  "sampled",
  "fitted",
]);

const DIRECTIONS = new Set(["normal", "reverse", "alternate", "alternate-reverse"]);
const FILLS = new Set(["none", "forwards", "backwards", "both", "auto"]);
const COMPOSITES = new Set(["replace", "add", "accumulate", "auto"]);
const TIMELINE_TYPES = new Set(["document", "scroll", "view"]);
const ASSET_KINDS = new Set(["lottie", "dotlottie", "riv"]);
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * INPUT SHAPES — the reader streams bind to these exact record shapes.
 *
 * @typedef {Object} IntrospectionRecord
 * One serialized entry of `document.getAnimations()` as the in-page reader emits it:
 * @property {"CSSAnimation"|"CSSTransition"|"Animation"} type   animation constructor name
 * @property {string} [animationName]        CSSAnimation.animationName
 * @property {string} [transitionProperty]   CSSTransition.transitionProperty
 * @property {string} selector               resolved CSS selector for effect.target
 * @property {Array<Object>} keyframes       effect.getKeyframes() output: each frame is
 *   { offset: number|null, computedOffset?: number, easing?: string, composite?: string,
 *     <cssPropertyCamelCase>: string|number, ... } — one frame may carry SEVERAL
 *   properties; the converter splits them into one track per property.
 * @property {Object} timing                 effect.getComputedTiming() subset:
 *   { duration: number(ms), delay?: number(ms), iterations?: number|"Infinity"|"infinite"|null,
 *     direction?: string, fill?: string, playbackRate?: number } — Infinity does not
 *   survive JSON, so readers MUST serialize infinite iterations as "Infinity" or
 *   "infinite" (null is also accepted and means the WAAPI default, 1).
 * @property {Object|null} [timeline]        {type:"document"} | {type:"scroll"|"view",
 *   source?: string, rangeStart?: string, rangeEnd?: string}; null/absent = document.
 *
 * @typedef {Object} GsapRecord
 * One serialized GSAP tween as the in-page reader emits it:
 * @property {string} selector      resolved CSS selector for the tween target
 * @property {Object} vars          the tween's vars object, data-only (functions dropped).
 *   Animated properties keep their GSAP names verbatim (x, y, scale, rotation, opacity…);
 *   consumers interpret them with GSAP semantics — the tier says so. `vars.startAt`
 *   (gsap.fromTo start values) becomes the offset-0 keyframe when present.
 * @property {number} duration_s    tween.duration() in seconds
 * @property {number} [delay_s]     tween.delay() in seconds
 * @property {string} [ease]        the ease name as GSAP reports it (e.g. "power2.out")
 * @property {number} [startTime_s] tween.startTime() on its timeline, seconds. When
 *   present it is the authoritative document-time offset and WINS over delay_s
 *   (GSAP folds delay into startTime; using both would double-count).
 * @property {number} [repeat]      GSAP repeat (ADDITIONAL iterations; -1 = infinite)
 * @property {boolean} [yoyo]
 * @property {Object} [scrollTrigger]  { trigger?: string(selector), start?: string,
 *   end?: string } — presence maps the track onto a scroll timeline.
 *
 * Engine-fit input: the existing fitted-trace artifact (targets/<name>/motion/<id>/trace/
 * fits.json, produced by packages/motion/src/tier3/fit.js): { url, trigger?, fits:
 * [{ elementId, path, channel: "tx"|"ty"|"tz"|"sx"|"sy"|"rot"|"opacity", fit: { kind:
 * "tween"|"spring"|"marquee"|"scroll-linear"|"pointer-follow", transition?, params?,
 * link?, valueFrom?, valueTo?, settleMs?, steadyMs?, steadyStartMs?, delayMs?, nrmse,
 * confidence? } }] }.
 */

// ---------------------------------------------------------------------------------------
// canonical hashing

function sha(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

// Object key insertion order is a construction detail, not evidence: canonicalize before
// hashing so a semantically identical track always yields the same fingerprint.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// Stable identity of a track: WHAT moves (target+property) and HOW (keyframes+timing).
// Provenance, timeline binding, and fit residuals are diagnosis, not identity — the same
// motion re-acquired through a different tier must fingerprint identically.
function trackFingerprint(track) {
  if (!track || typeof track !== "object") throw new Error("motion-doc: trackFingerprint needs a track object");
  return sha(stableJson({
    target: track.target || null,
    property: track.property || null,
    keyframes: track.keyframes || null,
    timing: track.timing || null,
  }));
}

// ---------------------------------------------------------------------------------------
// doc construction

function emptyDoc(meta = {}) {
  const viewport = meta.viewport && typeof meta.viewport === "object"
    ? { width: meta.viewport.width, height: meta.viewport.height, dpr: meta.viewport.dpr }
    : null;
  return {
    schema: SCHEMA_ID,
    url: meta.url || null,
    // Callers that need byte-stable output (converter determinism, regression fixtures)
    // pass capturedAt explicitly; live capture takes the wall clock.
    capturedAt: meta.capturedAt || new Date().toISOString(),
    viewport,
    tracks: [],
    assets: [],
  };
}

// Additive by construction: an identical track (same fingerprint) is deduped, a DIFFERENT
// track under an already-used id is refused instead of silently clobbered. Returns the
// canonical track now present in the doc (with an assigned id when the caller gave none).
function addTrack(doc, track) {
  if (!doc || !Array.isArray(doc.tracks)) throw new Error("motion-doc: addTrack needs a doc with a tracks array");
  const fingerprint = trackFingerprint(track);
  const existing = doc.tracks.find((t) => trackFingerprint(t) === fingerprint);
  if (existing) return existing;
  const withId = track.id ? track : { ...track, id: `t-${fingerprint.slice(0, 12)}` };
  validateTrack(withId, `tracks[${doc.tracks.length}]`);
  if (doc.tracks.some((t) => t.id === withId.id)) {
    throw new Error(`motion-doc: track id "${withId.id}" already present with different content`);
  }
  doc.tracks.push(withId);
  return withId;
}

// ---------------------------------------------------------------------------------------
// validation — throws with the precise reason; a doc that validates is a doc any consumer
// may bind to without re-checking shapes.

function fail(where, reason) {
  throw new Error(`motion-doc: ${where} ${reason}`);
}

function requireString(value, where, what) {
  if (typeof value !== "string" || !value.trim()) fail(where, `${what} must be a non-empty string`);
}

function validateKeyframes(keyframes, where, hasFit) {
  if (!Array.isArray(keyframes)) fail(where, "keyframes must be an array");
  // A link/model-only fitted track (scroll-linear, pointer-follow) carries its entire
  // motion in `fit`; synthesizing keyframes for it would fabricate values the trace never
  // produced. Empty keyframes are legal ONLY under that receipt.
  if (keyframes.length === 0 && !hasFit) fail(where, "keyframes must not be empty on a track without a fit");
  let lastOffset = -Infinity;
  keyframes.forEach((kf, i) => {
    const at = `${where}.keyframes[${i}]`;
    if (!kf || typeof kf !== "object" || Array.isArray(kf)) fail(at, "must be an object");
    // WAAPI legality: a null offset is expressible in ANY position (the spec distributes
    // missing offsets evenly between neighbors) — but the SPECIFIED offsets must be
    // loosely sorted and inside [0,1], exactly the conditions under which
    // KeyframeEffect.setKeyframes would not throw.
    if (kf.offset !== null) {
      if (typeof kf.offset !== "number" || !isFinite(kf.offset)) fail(at, "offset must be null or a finite number");
      if (kf.offset < 0 || kf.offset > 1) fail(at, `offset must be within 0..1 (got ${kf.offset})`);
      if (kf.offset < lastOffset) fail(at, `offsets must be sorted non-decreasing (${kf.offset} after ${lastOffset})`);
      lastOffset = kf.offset;
    }
    if (typeof kf.value !== "string") fail(at, "value must be a string");
    if (kf.easing !== undefined) requireString(kf.easing, at, "easing (when present)");
    if (kf.composite !== undefined && !COMPOSITES.has(kf.composite)) {
      fail(at, `composite must be one of ${[...COMPOSITES].join("|")} (got ${JSON.stringify(kf.composite)})`);
    }
  });
}

function validateTiming(timing, where) {
  if (!timing || typeof timing !== "object") fail(where, "timing must be an object");
  const at = `${where}.timing`;
  if (typeof timing.duration_ms !== "number" || !isFinite(timing.duration_ms) || timing.duration_ms < 0) {
    fail(at, `duration_ms must be a finite number >= 0 (got ${JSON.stringify(timing.duration_ms)})`);
  }
  if (typeof timing.delay_ms !== "number" || !isFinite(timing.delay_ms)) {
    fail(at, `delay_ms must be a finite number (got ${JSON.stringify(timing.delay_ms)})`);
  }
  const iter = timing.iterations;
  if (iter !== "infinite" && (typeof iter !== "number" || !isFinite(iter) || iter < 0)) {
    fail(at, `iterations must be "infinite" or a finite number >= 0 (got ${JSON.stringify(iter)})`);
  }
  if (!DIRECTIONS.has(timing.direction)) fail(at, `direction must be one of ${[...DIRECTIONS].join("|")} (got ${JSON.stringify(timing.direction)})`);
  if (!FILLS.has(timing.fill)) fail(at, `fill must be one of ${[...FILLS].join("|")} (got ${JSON.stringify(timing.fill)})`);
  if (timing.playbackRate !== undefined && (typeof timing.playbackRate !== "number" || !isFinite(timing.playbackRate))) {
    fail(at, "playbackRate (when present) must be a finite number");
  }
}

function validateTimeline(timeline, where) {
  const at = `${where}.timeline`;
  if (!timeline || typeof timeline !== "object") fail(at, "must be an object");
  if (!TIMELINE_TYPES.has(timeline.type)) fail(at, `type must be one of ${[...TIMELINE_TYPES].join("|")} (got ${JSON.stringify(timeline.type)})`);
  if (timeline.type === "document") return;
  for (const key of ["source", "rangeStart", "rangeEnd"]) {
    if (timeline[key] !== undefined) requireString(timeline[key], at, `${key} (when present)`);
  }
}

function validateTrack(track, where) {
  if (!track || typeof track !== "object" || Array.isArray(track)) fail(where, "must be an object");
  requireString(track.id, where, "id");
  if (!track.target || typeof track.target !== "object") fail(where, "target must be an object");
  requireString(track.target.selector, `${where}.target`, "selector");
  requireString(track.property, where, "property");
  const hasFit = track.fit !== undefined;
  if (hasFit) {
    const at = `${where}.fit`;
    if (!track.fit || typeof track.fit !== "object") fail(at, "must be an object");
    requireString(track.fit.kind, at, "kind");
    if (!track.fit.params || typeof track.fit.params !== "object") fail(at, "params must be an object");
    if (typeof track.fit.nrmse !== "number" || !isFinite(track.fit.nrmse) || track.fit.nrmse < 0) {
      fail(at, `nrmse must be a finite number >= 0 (got ${JSON.stringify(track.fit.nrmse)})`);
    }
  }
  validateKeyframes(track.keyframes, where, hasFit);
  validateTiming(track.timing, where);
  validateTimeline(track.timeline, where);
  // ONGOING motion: a sampled series still changing in its final frames observed NO
  // settle — the record is a finite WINDOW onto motion that never ends, not a complete
  // clip of motion that does. The flag is detection evidence (set by the sampler, see
  // harness/motion-sampler.js trackIsOngoing), not identity: trackFingerprint ignores it,
  // because the same keyframes re-acquired are the same motion whether or not they settle.
  if (track.ongoing !== undefined && typeof track.ongoing !== "boolean") {
    fail(where, `ongoing (when present) must be a boolean (got ${JSON.stringify(track.ongoing)})`);
  }
  const prov = track.provenance;
  if (!prov || typeof prov !== "object") fail(where, "provenance must be an object");
  if (!TIERS.has(prov.tier)) fail(`${where}.provenance`, `tier must be one of ${[...TIERS].join("|")} (got ${JSON.stringify(prov.tier)})`);
  if (prov.source !== undefined) requireString(prov.source, `${where}.provenance`, "source (when present)");
  if (prov.confidence !== undefined && (typeof prov.confidence !== "number" || !isFinite(prov.confidence) || prov.confidence < 0 || prov.confidence > 1)) {
    fail(`${where}.provenance`, `confidence (when present) must be a number in 0..1 (got ${JSON.stringify(prov.confidence)})`);
  }
  return track;
}

function validateAsset(asset, where) {
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) fail(where, "must be an object");
  if (!ASSET_KINDS.has(asset.kind)) fail(where, `kind must be one of ${[...ASSET_KINDS].join("|")} (got ${JSON.stringify(asset.kind)})`);
  requireString(asset.url, where, "url");
  if (typeof asset.sha256 !== "string" || !SHA256_HEX.test(asset.sha256)) fail(where, "sha256 must be 64 lowercase hex characters");
  if (!Number.isInteger(asset.bytes) || asset.bytes < 0) fail(where, `bytes must be an integer >= 0 (got ${JSON.stringify(asset.bytes)})`);
  requireString(asset.file, where, "file");
}

function validateMotionDoc(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) fail("doc", "must be an object");
  if (doc.schema !== SCHEMA_ID) fail("doc", `schema must be "${SCHEMA_ID}" (got ${JSON.stringify(doc.schema)})`);
  if (doc.url !== null && (typeof doc.url !== "string" || !doc.url.trim())) fail("doc", "url must be a non-empty string or null");
  if (doc.capturedAt !== null && (typeof doc.capturedAt !== "string" || !doc.capturedAt.trim())) fail("doc", "capturedAt must be a non-empty string or null");
  if (doc.viewport !== null) {
    if (!doc.viewport || typeof doc.viewport !== "object") fail("doc", "viewport must be null or an object");
    for (const key of ["width", "height", "dpr"]) {
      const v = doc.viewport[key];
      if (typeof v !== "number" || !isFinite(v) || v <= 0) fail("doc.viewport", `${key} must be a finite number > 0 (got ${JSON.stringify(v)})`);
    }
  }
  if (!Array.isArray(doc.tracks)) fail("doc", "tracks must be an array");
  const ids = new Set();
  doc.tracks.forEach((track, i) => {
    validateTrack(track, `tracks[${i}]`);
    if (ids.has(track.id)) fail(`tracks[${i}]`, `duplicate track id "${track.id}"`);
    ids.add(track.id);
  });
  if (!Array.isArray(doc.assets)) fail("doc", "assets must be an array");
  doc.assets.forEach((asset, i) => validateAsset(asset, `assets[${i}]`));
  return doc;
}

// ---------------------------------------------------------------------------------------
// converter: getAnimations() introspection records

const INTROSPECTION_TIER = {
  CSSAnimation: "introspected-css",
  CSSTransition: "introspected-transition",
  Animation: "introspected-waapi",
};
const KEYFRAME_META_KEYS = new Set(["offset", "computedOffset", "easing", "composite"]);

function normalizeIterations(raw) {
  if (raw == null) return 1; // WAAPI default; Infinity does not survive JSON (see JSDoc)
  if (raw === Infinity || raw === "Infinity" || raw === "infinite") return "infinite";
  return raw;
}

function normalizeTimeline(raw) {
  if (!raw || typeof raw !== "object" || raw.type == null || raw.type === "document") return { type: "document" };
  const out = { type: raw.type };
  for (const key of ["source", "rangeStart", "rangeEnd"]) if (raw[key] != null) out[key] = String(raw[key]);
  return out;
}

function introspectionTiming(timing = {}) {
  return {
    duration_ms: typeof timing.duration === "number" && isFinite(timing.duration) ? timing.duration : 0,
    delay_ms: typeof timing.delay === "number" && isFinite(timing.delay) ? timing.delay : 0,
    iterations: normalizeIterations(timing.iterations),
    direction: timing.direction || "normal",
    fill: timing.fill || "auto",
    ...(timing.playbackRate != null ? { playbackRate: timing.playbackRate } : {}),
  };
}

function fromIntrospection(records, meta = {}) {
  const doc = emptyDoc(meta);
  for (const record of records || []) {
    const tier = INTROSPECTION_TIER[record && record.type];
    if (!tier) throw new Error(`motion-doc: unknown introspection record type ${JSON.stringify(record && record.type)}`);
    const source = record.type === "CSSAnimation" && record.animationName
      ? `css-animation:${record.animationName}`
      : record.type === "CSSTransition" && record.transitionProperty
        ? `css-transition:${record.transitionProperty}`
        : "waapi";
    // One getKeyframes() frame may carry several properties; the doc is one property per
    // track, so split — each property takes only the frames that mention it.
    const properties = [...new Set((record.keyframes || []).flatMap((kf) =>
      Object.keys(kf || {}).filter((key) => !KEYFRAME_META_KEYS.has(key))))];
    for (const property of properties) {
      const keyframes = (record.keyframes || [])
        .filter((kf) => kf && kf[property] !== undefined)
        .map((kf) => ({
          offset: typeof kf.offset === "number" && isFinite(kf.offset) ? kf.offset
            : typeof kf.computedOffset === "number" && isFinite(kf.computedOffset) ? kf.computedOffset
            : null,
          value: String(kf[property]),
          ...(kf.easing != null ? { easing: kf.easing } : {}),
          ...(kf.composite != null ? { composite: kf.composite } : {}),
        }));
      addTrack(doc, {
        target: { selector: record.selector },
        property,
        keyframes,
        timing: introspectionTiming(record.timing),
        timeline: normalizeTimeline(record.timeline),
        provenance: { tier, source },
      });
    }
  }
  return validateMotionDoc(doc);
}

// ---------------------------------------------------------------------------------------
// converter: serialized GSAP tweens

// GSAP vars keys that are tween CONFIGURATION, never animated properties. startAt is
// consumed separately (fromTo start values).
const GSAP_CONTROL_KEYS = new Set([
  "duration", "delay", "ease", "repeat", "repeatDelay", "repeatRefresh", "yoyo", "yoyoEase",
  "stagger", "paused", "immediateRender", "overwrite", "scrollTrigger", "id", "data",
  "callbackScope", "defaults", "keyframes", "runBackwards", "lazy", "inherit", "startAt",
  "parent", "targets", "onComplete", "onStart", "onUpdate", "onRepeat", "onReverseComplete",
  "onInterrupt",
]);

// Exact CSS equivalents ONLY — an approximate curve under an exact-sounding name would be
// a dishonest receipt. linear is definitionally exact; power1/power2 in/out are quadratic
// and cubic POLYNOMIALS, and a cubic-bezier with x-control-points at 1/3 and 2/3 has
// x(u)=u exactly, so its y-polynomial reproduces t^2 / t^3 (and their reflections)
// exactly (to float precision). The inOut variants are piecewise and NOT one bezier;
// everything else (sine, expo, circ, back, elastic, bounce, power3+) has no exact CSS
// form — those keep the GSAP name, flagged via provenance.source "gsap:<ease>".
const GSAP_EXACT_EASE = {
  "none": "linear",
  "linear": "linear",
  "power0": "linear",
  "power0.none": "linear",
  "power0.in": "linear",
  "power0.out": "linear",
  "power0.inOut": "linear",
  "power1.in": "cubic-bezier(0.333333, 0, 0.666667, 0.333333)",
  "power1.out": "cubic-bezier(0.333333, 0.666667, 0.666667, 1)",
  "power1": "cubic-bezier(0.333333, 0.666667, 0.666667, 1)", // bare name = .out in GSAP
  "power2.in": "cubic-bezier(0.333333, 0, 0.666667, 0)",
  "power2.out": "cubic-bezier(0.333333, 1, 0.666667, 1)",
  "power2": "cubic-bezier(0.333333, 1, 0.666667, 1)",
};
// A GSAP ease string that already IS CSS easing syntax passes through unchanged.
const CSS_EASE_SYNTAX = /^(?:steps\(\s*\d+\s*(?:,\s*(?:start|end|jump-start|jump-end|jump-none|jump-both)\s*)?\)|cubic-bezier\(\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\))$/;

function convertGsapEase(ease) {
  if (ease == null || ease === "") return { easing: null, source: "gsap" };
  const name = String(ease).trim();
  if (GSAP_EXACT_EASE[name]) return { easing: GSAP_EXACT_EASE[name], source: "gsap" };
  if (CSS_EASE_SYNTAX.test(name)) return { easing: name, source: "gsap" };
  return { easing: name, source: `gsap:${name}` }; // no exact CSS equivalent — keep the truth
}

function fromGsap(records, meta = {}) {
  const doc = emptyDoc(meta);
  for (const record of records || []) {
    if (!record || typeof record !== "object") throw new Error("motion-doc: gsap record must be an object");
    const vars = record.vars && typeof record.vars === "object" ? record.vars : {};
    const startAt = vars.startAt && typeof vars.startAt === "object" ? vars.startAt : null;
    const { easing, source } = convertGsapEase(record.ease);
    const repeat = record.repeat == null ? 0 : record.repeat;
    const timing = {
      duration_ms: Math.round((record.duration_s || 0) * 1000),
      // startTime already contains the delay on the GSAP timeline — never add both.
      delay_ms: Math.round((record.startTime_s != null ? record.startTime_s : record.delay_s || 0) * 1000),
      iterations: repeat === -1 ? "infinite" : repeat + 1,
      direction: record.yoyo ? "alternate" : "normal",
      // GSAP tweens render their start values immediately and hold their end values: both.
      fill: "both",
    };
    const timeline = record.scrollTrigger && typeof record.scrollTrigger === "object"
      ? {
          type: "scroll",
          ...(typeof record.scrollTrigger.trigger === "string" && record.scrollTrigger.trigger ? { source: record.scrollTrigger.trigger } : {}),
          ...(typeof record.scrollTrigger.start === "string" && record.scrollTrigger.start ? { rangeStart: record.scrollTrigger.start } : {}),
          ...(typeof record.scrollTrigger.end === "string" && record.scrollTrigger.end ? { rangeEnd: record.scrollTrigger.end } : {}),
        }
      : { type: "document" };
    for (const [property, raw] of Object.entries(vars)) {
      if (GSAP_CONTROL_KEYS.has(property)) continue;
      if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") continue; // data-only records; anything else is not a value
      const from = startAt && startAt[property] !== undefined ? startAt[property] : undefined;
      // gsap.to semantics: vars hold DESTINATION values with an implicit from — a single
      // keyframe at offset 1 (WAAPI computes the start from the underlying value). With a
      // recorded startAt (fromTo) the start is explicit at offset 0. The easing lives on
      // the frame that OPENS the interval; in the implicit-from case that frame does not
      // exist, so the destination frame carries it (documented deviation — GSAP's ease
      // spans the whole tween either way).
      const keyframes = from !== undefined
        ? [
            { offset: 0, value: String(from), ...(easing ? { easing } : {}) },
            { offset: 1, value: String(raw) },
          ]
        : [{ offset: 1, value: String(raw), ...(easing ? { easing } : {}) }];
      addTrack(doc, {
        target: { selector: record.selector },
        property, // GSAP property name verbatim (x, rotation, …) — the tier declares the semantics
        keyframes,
        timing,
        timeline,
        provenance: { tier: "introspected-gsap", source },
      });
    }
  }
  return validateMotionDoc(doc);
}

// ---------------------------------------------------------------------------------------
// converter: engine-fitted trace artifacts (fits.json)

const FIT_CHANNELS = {
  tx: { property: "transform", value: (v) => `translateX(${v}px)` },
  ty: { property: "transform", value: (v) => `translateY(${v}px)` },
  tz: { property: "transform", value: (v) => `translateZ(${v}px)` },
  sx: { property: "transform", value: (v) => `scaleX(${v})` },
  sy: { property: "transform", value: (v) => `scaleY(${v})` },
  rot: { property: "transform", value: (v) => `rotate(${v}deg)` },
  opacity: { property: "opacity", value: (v) => String(v) },
};

function endpointKeyframes(fit, channel, easing) {
  const fmt = FIT_CHANNELS[channel].value;
  return [
    { offset: 0, value: fmt(fit.valueFrom), ...(easing ? { easing } : {}) },
    { offset: 1, value: fmt(fit.valueTo) },
  ];
}

function fittedTrack(row) {
  const fit = row.fit;
  const channel = FIT_CHANNELS[row.channel];
  if (!channel) throw new Error(`motion-doc: unknown fit channel ${JSON.stringify(row.channel)}`);
  const delay = typeof fit.delayMs === "number" && isFinite(fit.delayMs) ? fit.delayMs : 0;
  const base = {
    target: { selector: row.path },
    property: channel.property,
    timeline: { type: "document" },
    provenance: {
      tier: "fitted",
      source: `fit:${fit.kind}`,
      ...(typeof fit.confidence === "number" ? { confidence: Math.min(1, Math.max(0, fit.confidence)) } : {}),
    },
  };
  if (fit.kind === "tween") {
    const t = fit.transition || {};
    const ease = Array.isArray(t.ease) ? `cubic-bezier(${t.ease.join(", ")})` : null;
    return {
      ...base,
      keyframes: endpointKeyframes(fit, row.channel, ease),
      timing: { duration_ms: Math.round((t.duration || 0) * 1000), delay_ms: delay, iterations: 1, direction: "normal", fill: "both" },
      fit: { kind: "tween", params: { ...t, valueFrom: fit.valueFrom, valueTo: fit.valueTo }, nrmse: fit.nrmse },
    };
  }
  if (fit.kind === "spring") {
    // No easing on the keyframes: no CSS easing IS a spring — the fit params are the
    // authoritative curve, the keyframes only pin the endpoints.
    return {
      ...base,
      keyframes: endpointKeyframes(fit, row.channel, null),
      timing: { duration_ms: typeof fit.settleMs === "number" && isFinite(fit.settleMs) ? fit.settleMs : 0, delay_ms: delay, iterations: 1, direction: "normal", fill: "both" },
      fit: { kind: "spring", params: { ...(fit.transition || {}), settleMs: fit.settleMs, valueFrom: fit.valueFrom, valueTo: fit.valueTo }, nrmse: fit.nrmse },
    };
  }
  if (fit.kind === "marquee") {
    const p = fit.params || {};
    const steadyMs = typeof fit.steadyMs === "number" && isFinite(fit.steadyMs) ? fit.steadyMs : 0;
    // v(t) = valueFrom + direction·velocity·t/1000 — the endpoint over one observed
    // steady window, derived from the fitted params (a marquee is exactly linear).
    const travelTo = +(fit.valueFrom + (p.direction || 1) * (p.velocityPxPerSec || 0) * steadyMs / 1000).toFixed(2);
    const fmt = FIT_CHANNELS[row.channel].value;
    return {
      ...base,
      keyframes: [
        { offset: 0, value: fmt(fit.valueFrom), easing: "linear" },
        { offset: 1, value: fmt(travelTo) },
      ],
      timing: { duration_ms: steadyMs, delay_ms: delay, iterations: "infinite", direction: "normal", fill: "both" },
      fit: { kind: "marquee", params: { ...p, valueFrom: fit.valueFrom, steadyMs }, nrmse: fit.nrmse },
    };
  }
  if (fit.kind === "scroll-linear" || fit.kind === "pointer-follow") {
    // Link fits carry no time-domain endpoints; synthesizing keyframes would fabricate
    // values the trace never produced. The model lives whole in `fit` (empty keyframes
    // are legal exactly and only here — see validateKeyframes).
    return {
      ...base,
      keyframes: [],
      timing: { duration_ms: 0, delay_ms: delay, iterations: 1, direction: "normal", fill: "both" },
      timeline: fit.kind === "scroll-linear" ? { type: "scroll" } : { type: "document" },
      fit: { kind: fit.kind, params: { ...(fit.link || {}) }, nrmse: fit.nrmse },
    };
  }
  throw new Error(`motion-doc: unknown fit kind ${JSON.stringify(fit.kind)}`);
}

function fromEngineFit(fitArtifacts, meta = {}) {
  const artifacts = Array.isArray(fitArtifacts) ? fitArtifacts : [fitArtifacts];
  const doc = emptyDoc({ ...meta, url: meta.url || (artifacts[0] && artifacts[0].url) || null });
  for (const artifact of artifacts) {
    if (!artifact || !Array.isArray(artifact.fits)) throw new Error("motion-doc: engine-fit artifact must have a fits array");
    for (const row of artifact.fits) {
      if (!row || !row.fit) continue; // fitChannel() returned null — nothing was fitted for this row
      if (typeof row.path !== "string" || !row.path.trim()) throw new Error("motion-doc: engine-fit row is missing its selector path");
      addTrack(doc, fittedTrack(row));
    }
  }
  return validateMotionDoc(doc);
}

// ---------------------------------------------------------------------------------------
// converter: dense virtual-time samples (pxDenseRecordStop() output)
//
// The SAMPLED tier: when a page declares nothing an introspection reader can see but
// pixels still move, the node-side sampler (harness/motion-sampler.js) steps virtual time
// and the in-page recorder (tools/browser-capture.js pxDenseRecord*) reads computed
// values at each step. This converter turns that record into sampled-tier tracks:
// keyframes at uniform offsets 0..1, values verbatim as the computed CSS strings, and
// timing.duration_ms = frames × stepMs — the DECLARED virtual span, which is the replay
// contract, not wall clock. Frame-rate honesty: a site animating px-per-rAF-frame is
// recorded exactly as it behaves at the declared fps, and that fps rides in
// provenance.source ("virtual-time@<fps>fps"); the WAAPI replay downstream is time-based,
// which NORMALIZES the site's frame-rate dependence — receipted here, never hidden.
//
// Dedupe by honesty: a series with NO value change across all frames is not motion — it
// is dropped, and the drop is counted in the returned doc's `sampling` receipt (the
// caller's receipt data; the sampler keeps it OUT of the merged motion-doc.json, so the
// instrument never bakes itself into the artifact). Style-write records (the recorder's
// MutationObserver evidence of inline-style writes) merge into the matching track's
// provenance.source as "+style-writes:<n>".
function fromSampled(record, meta = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("motion-doc: sampled conversion needs the pxDenseRecordStop() record object");
  }
  if (!Array.isArray(record.elements)) throw new Error("motion-doc: sampled record must carry an elements array");
  const stepMs = typeof record.stepMs === "number" && isFinite(record.stepMs) && record.stepMs > 0 ? record.stepMs : null;
  const fps = typeof meta.fps === "number" && isFinite(meta.fps) && meta.fps > 0
    ? meta.fps
    : stepMs ? Math.round(1000 / stepMs) : null;
  if (!fps) throw new Error("motion-doc: sampled conversion needs meta.fps (the declared rate) or a positive record.stepMs to derive it");
  const frames = typeof record.frames === "number" && isFinite(record.frames) && record.frames >= 0 ? record.frames : 0;
  const duration_ms = Math.round(frames * (stepMs || 0) * 1000) / 1000;

  const writes = Array.isArray(record.writes) ? record.writes : [];
  const writeCounts = new Map();
  for (const w of writes) {
    if (!w || typeof w !== "object" || typeof w.selector !== "string") continue;
    const key = `${w.selector}\u0000${String(w.prop || "").toLowerCase()}`;
    writeCounts.set(key, (writeCounts.get(key) || 0) + 1);
  }

  const doc = emptyDoc(meta);
  let staticDropped = 0;
  let unaddressable = 0;
  let writesMerged = 0;
  for (const el of record.elements) {
    if (!el || typeof el !== "object" || !Array.isArray(el.samples) || !el.samples.length) continue;
    const selector = typeof el.selector === "string" && el.selector.trim() ? el.selector.trim() : null;
    const properties = Object.keys((el.samples[0] && el.samples[0].values) || {});
    for (const property of properties) {
      const values = el.samples.map((sample) => {
        const v = sample && sample.values ? sample.values[property] : null;
        return v == null ? "" : String(v);
      });
      if (values.every((v) => v === values[0])) { staticDropped++; continue; } // no change across all frames → not motion
      if (!selector) { unaddressable++; continue; } // moving, but the recorder resolved no selector — receipted, never guessed
      const n = values.length;
      const merged = writeCounts.get(`${selector}\u0000${property.toLowerCase()}`) || 0;
      writesMerged += merged;
      addTrack(doc, {
        target: { selector },
        property,
        keyframes: values.map((value, i) => ({ offset: n === 1 ? 1 : i / (n - 1), value })),
        timing: { duration_ms, delay_ms: 0, iterations: 1, direction: "normal", fill: "both" },
        timeline: { type: "document" },
        provenance: {
          tier: "sampled",
          source: `virtual-time@${fps}fps${merged ? `+style-writes:${merged}` : ""}`,
        },
      });
    }
  }
  // The conversion receipt — for the CALLER's run receipt, not for the merged artifact.
  doc.sampling = {
    fps, stepMs: stepMs || 0, frames,
    elements: record.elements.length, tracks: doc.tracks.length,
    staticDropped, unaddressable,
    writesTotal: writes.length, writesMerged,
    truncated: !!record.truncated,
  };
  return validateMotionDoc(doc);
}

module.exports = {
  SCHEMA_ID,
  addTrack,
  emptyDoc,
  fromEngineFit,
  fromGsap,
  fromIntrospection,
  fromSampled,
  trackFingerprint,
  validateMotionDoc,
};
