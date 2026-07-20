#!/usr/bin/env node
// motion-doc-selftest.js — behavioral contract test for the canonical motion artifact:
// valid docs pass, every named malformation is refused with its reason, converters are
// byte-stable (deterministic fingerprints), and docs round-trip through JSON unchanged.
"use strict";

const {
  SCHEMA_ID,
  addTrack,
  emptyDoc,
  fromEngineFit,
  fromGsap,
  fromIntrospection,
  fromSampled,
  trackFingerprint,
  validateMotionDoc,
} = require("./motion-doc.js");

let failed = 0;
const ok = (condition, message) => {
  if (condition) console.log(`  ✓ ${message}`);
  else { failed++; console.log(`  ✗ ${message}`); }
};
const refuses = (mutate, pattern, message) => {
  const doc = validDoc();
  mutate(doc);
  try { validateMotionDoc(doc); ok(false, `${message} (no error thrown)`); }
  catch (error) { ok(pattern.test(error.message), `${message} — ${error.message.slice(0, 90)}`); }
};

const META = { url: "https://example.test/", capturedAt: "2026-07-18T00:00:00.000Z", viewport: { width: 1280, height: 800, dpr: 2 } };

function validTrack(overrides = {}) {
  return {
    id: "hero-fade",
    target: { selector: ".hero img" },
    property: "opacity",
    keyframes: [
      { offset: 0, value: "0", easing: "ease-out" },
      { offset: null, value: "0.5" },
      { offset: 1, value: "1" },
    ],
    timing: { duration_ms: 750, delay_ms: 0, iterations: 1, direction: "normal", fill: "both" },
    timeline: { type: "document" },
    provenance: { tier: "introspected-css", source: "css-animation:fade-up", confidence: 1 },
    ...overrides,
  };
}

function validDoc() {
  const doc = emptyDoc(META);
  doc.tracks.push(validTrack());
  doc.assets.push({ kind: "lottie", url: "https://example.test/a.json", sha256: "a".repeat(64), bytes: 1234, file: "assets/a.json" });
  return doc;
}

console.log("motion-doc-selftest — canonical motion artifact contract");
ok(SCHEMA_ID === "pingfusi/motion-doc@1", "schema id is the bound contract name");

// -- valid docs pass ---------------------------------------------------------------------
ok(validateMotionDoc(validDoc()) && validateMotionDoc(emptyDoc(META)), "a well-formed doc and an empty doc both validate");
ok(emptyDoc(META).capturedAt === META.capturedAt && emptyDoc(META).viewport.dpr === 2, "emptyDoc preserves the supplied meta verbatim");

// -- each malformation is refused with its reason ----------------------------------------
refuses((d) => { d.schema = "pingfusi/motion-doc@0"; }, /schema/, "a wrong schema id is refused");
refuses((d) => { d.tracks[0].provenance.tier = "guessed"; }, /tier/, "an unknown provenance tier is refused");
refuses((d) => { d.tracks[0].target.selector = "  "; }, /selector/, "an empty selector is refused");
refuses((d) => { d.tracks[0].timing.duration_ms = NaN; }, /duration_ms/, "a non-finite duration_ms is refused");
refuses((d) => { d.tracks[0].timing.duration_ms = -5; }, /duration_ms/, "a negative duration_ms is refused");
refuses((d) => { d.tracks[0].keyframes[0].offset = 1.5; }, /0\.\.1/, "an out-of-range keyframe offset is refused");
refuses((d) => { d.tracks[0].keyframes = [{ offset: 0.9, value: "0" }, { offset: 0.1, value: "1" }]; }, /sorted/, "unsorted specified offsets are refused");
refuses((d) => { d.tracks[0].keyframes[0].offset = "0"; }, /offset/, "a string offset is refused");
refuses((d) => { d.tracks[0].keyframes[0].value = 0; }, /value must be a string/, "a non-string keyframe value is refused");
refuses((d) => { d.tracks[0].keyframes = []; }, /without a fit/, "empty keyframes without a fit are refused");
refuses((d) => { d.tracks[0].timing.iterations = -1; }, /iterations/, "negative iterations are refused");
refuses((d) => { d.tracks[0].timing.direction = "backwards"; }, /direction/, "an unknown direction is refused");
refuses((d) => { d.tracks[0].timing.fill = "sideways"; }, /fill/, "an unknown fill is refused");
refuses((d) => { d.tracks[0].timeline = { type: "pointer" }; }, /timeline.*type|type must be/, "an unknown timeline type is refused");
refuses((d) => { d.tracks[0].keyframes[0].composite = "merge"; }, /composite/, "an unknown composite is refused");
refuses((d) => { d.tracks.push({ ...validTrack() }); }, /duplicate track id/, "a duplicate track id is refused");
refuses((d) => { d.assets[0].kind = "gif"; }, /kind/, "an unknown asset kind is refused");
refuses((d) => { d.assets[0].sha256 = "zz"; }, /sha256/, "a malformed asset sha256 is refused");
refuses((d) => { d.assets[0].bytes = 1.5; }, /bytes/, "non-integer asset bytes are refused");
refuses((d) => { d.viewport = { width: 0, height: 800, dpr: 1 }; }, /width/, "a zero-width viewport is refused");
refuses((d) => { d.tracks[0].provenance.confidence = 2; }, /confidence/, "an out-of-range confidence is refused");

// -- the ongoing flag: no-settle evidence rides the track as a boolean, nothing else ----
const ongoingDoc = validDoc();
ongoingDoc.tracks[0].ongoing = true;
ok(validateMotionDoc(ongoingDoc), "a boolean ongoing flag (no settle observed in the window) is accepted on a track");
refuses((d) => { d.tracks[0].ongoing = "yes"; }, /ongoing/, "a non-boolean ongoing flag is refused");
ok(trackFingerprint(validTrack()) === trackFingerprint({ ...validTrack(), ongoing: true }),
  "fingerprint ignores ongoing — identity is WHAT moves and HOW, not whether the window saw it settle");

// WAAPI-legal nulls: nulls in any position are fine as long as SPECIFIED offsets stay sorted
const nullHeavy = validDoc();
nullHeavy.tracks[0].keyframes = [
  { offset: null, value: "a" }, { offset: 0.5, value: "b" }, { offset: null, value: "c" },
];
ok(validateMotionDoc(nullHeavy), "null offsets around a sorted specified offset are WAAPI-legal and accepted");

// link-model fitted tracks may carry empty keyframes — the fit IS the motion
const linkDoc = validDoc();
linkDoc.tracks[0].keyframes = [];
linkDoc.tracks[0].provenance = { tier: "fitted", source: "fit:scroll-linear" };
linkDoc.tracks[0].timeline = { type: "scroll" };
linkDoc.tracks[0].fit = { kind: "scroll-linear", params: { slope: -0.5, intercept: 10, r2: 0.99 }, nrmse: 0.01 };
ok(validateMotionDoc(linkDoc), "empty keyframes are accepted exactly when a fit carries the model");

// -- addTrack: additive, deduping, collision-safe ----------------------------------------
const addDoc = emptyDoc(META);
const first = addTrack(addDoc, (({ id, ...rest }) => rest)(validTrack()));
ok(/^t-[0-9a-f]{12}$/.test(first.id), "addTrack assigns a deterministic fingerprint-derived id");
const again = addTrack(addDoc, (({ id, ...rest }) => rest)(validTrack()));
ok(again === first && addDoc.tracks.length === 1, "an identical track is deduped by fingerprint, not duplicated");
try {
  addTrack(addDoc, validTrack({ id: first.id, property: "transform", keyframes: [{ offset: 0, value: "none" }, { offset: 1, value: "translateX(10px)" }] }));
  ok(false, "a different track under a taken id is refused");
} catch (error) { ok(/already present/.test(error.message), "a different track under a taken id is refused"); }

// -- trackFingerprint: stable, canonical, sensitive --------------------------------------
const base = validTrack();
const reordered = { provenance: base.provenance, timing: { fill: "both", direction: "normal", iterations: 1, delay_ms: 0, duration_ms: 750 }, keyframes: base.keyframes, property: base.property, target: base.target, timeline: base.timeline, id: "other-id" };
ok(trackFingerprint(base) === trackFingerprint(reordered), "fingerprint canonicalizes key order and ignores id/provenance/timeline");
ok(trackFingerprint(base) !== trackFingerprint(validTrack({ property: "transform" })), "fingerprint changes when the property changes");
ok(trackFingerprint(base) !== trackFingerprint({ ...base, keyframes: [{ offset: 0, value: "0.1" }, { offset: 1, value: "1" }] }), "fingerprint changes when keyframes change");

// -- fromIntrospection -------------------------------------------------------------------
const introRecords = [{
  type: "CSSAnimation",
  animationName: "fade-up",
  selector: ".hero img",
  keyframes: [
    { offset: 0, computedOffset: 0, easing: "ease-out", composite: "replace", opacity: "0", transform: "translateY(24px)" },
    { offset: null, computedOffset: 1, easing: "linear", composite: "replace", opacity: "1", transform: "none" },
  ],
  timing: { duration: 750, delay: 100, iterations: "Infinity", direction: "normal", fill: "both" },
  timeline: null,
}, {
  type: "CSSTransition",
  transitionProperty: "opacity",
  selector: ".card",
  keyframes: [
    { offset: 0, computedOffset: 0, easing: "ease", opacity: "1" },
    { offset: 1, computedOffset: 1, easing: "linear", opacity: "0.4" },
  ],
  timing: { duration: 300, delay: 0, iterations: null, direction: "normal", fill: "backwards" },
  timeline: { type: "view", source: ".card", rangeStart: "entry 0%", rangeEnd: "cover 40%" },
}];
const introDoc = fromIntrospection(introRecords, META);
ok(introDoc.tracks.length === 3, "a two-property CSS animation splits into per-property tracks plus the transition");
const opacityTrack = introDoc.tracks.find((t) => t.property === "opacity" && t.provenance.tier === "introspected-css");
const transformTrack = introDoc.tracks.find((t) => t.property === "transform");
const transitionTrack = introDoc.tracks.find((t) => t.provenance.tier === "introspected-transition");
ok(opacityTrack && transformTrack && opacityTrack.provenance.source === "css-animation:fade-up", "css tracks carry the named-animation provenance source");
ok(opacityTrack.timing.iterations === "infinite" && opacityTrack.timing.delay_ms === 100, "serialized Infinity iterations normalize to \"infinite\"");
ok(opacityTrack.keyframes[1].offset === 1 && opacityTrack.keyframes[1].value === "1", "a null input offset falls back to computedOffset");
ok(transitionTrack && transitionTrack.timing.iterations === 1 && transitionTrack.timeline.type === "view" && transitionTrack.timeline.rangeEnd === "cover 40%", "transition track keeps its view timeline and defaults null iterations to 1");
try {
  fromIntrospection([{ type: "GhostAnimation", selector: "x", keyframes: [], timing: {} }], META);
  ok(false, "an unknown introspection record type is refused");
} catch (error) { ok(/unknown introspection record type/.test(error.message), "an unknown introspection record type is refused"); }

// -- fromGsap ----------------------------------------------------------------------------
const gsapRecords = [{
  selector: ".belt",
  vars: { x: -400, opacity: 1, duration: 12, onComplete: null, startAt: { opacity: 0 } },
  duration_s: 12,
  delay_s: 0.25,
  ease: "none",
  repeat: -1,
  yoyo: false,
}, {
  selector: ".card",
  vars: { y: 0 },
  duration_s: 0.8,
  delay_s: 0,
  startTime_s: 1.5,
  ease: "elastic.out(1,0.3)",
  repeat: 2,
  yoyo: true,
  scrollTrigger: { trigger: "#story", start: "top 80%", end: "bottom top" },
}];
const gsapDoc = fromGsap(gsapRecords, META);
const beltX = gsapDoc.tracks.find((t) => t.property === "x");
const beltOpacity = gsapDoc.tracks.find((t) => t.property === "opacity");
const cardY = gsapDoc.tracks.find((t) => t.property === "y");
ok(gsapDoc.tracks.length === 3 && beltX && cardY, "gsap vars become per-property tracks; control keys and functions never do");
ok(beltX.keyframes.length === 1 && beltX.keyframes[0].offset === 1 && beltX.keyframes[0].value === "-400" && beltX.keyframes[0].easing === "linear", "gsap ease \"none\" converts to the exact CSS \"linear\" on an implicit-from destination keyframe");
ok(beltOpacity.keyframes.length === 2 && beltOpacity.keyframes[0].offset === 0 && beltOpacity.keyframes[0].value === "0", "a recorded startAt becomes the explicit offset-0 keyframe");
ok(beltX.timing.iterations === "infinite" && beltX.timing.delay_ms === 250, "gsap repeat -1 maps to \"infinite\" and delay_s to delay_ms");
ok(cardY.timing.iterations === 3 && cardY.timing.direction === "alternate", "gsap repeat 2 means 3 iterations and yoyo means alternate");
ok(cardY.timing.delay_ms === 1500, "startTime_s wins over delay_s without double-counting");
ok(cardY.keyframes[0].easing === "elastic.out(1,0.3)" && cardY.provenance.source === "gsap:elastic.out(1,0.3)", "an inexact gsap ease keeps its name and flags provenance.source gsap:<ease>");
ok(cardY.timeline.type === "scroll" && cardY.timeline.source === "#story" && cardY.timeline.rangeStart === "top 80%", "a scrollTrigger becomes a scroll timeline with its source and range");
ok(fromGsap([{ selector: ".s", vars: { x: 1 }, duration_s: 1, ease: "power2.out" }], META).tracks[0].keyframes[0].easing === "cubic-bezier(0.333333, 1, 0.666667, 1)", "power2.out converts to its exact cubic-bezier equivalent");
ok(fromGsap([{ selector: ".s", vars: { x: 1 }, duration_s: 1, ease: "steps(5)" }], META).tracks[0].keyframes[0].easing === "steps(5)", "CSS-syntax gsap eases pass through unchanged");

// -- fromEngineFit -----------------------------------------------------------------------
// Mirrors the real fits.json shapes under targets/*/motion/*/trace/ (untracked, so the
// representative rows are embedded here instead of read from disk).
const fitArtifact = {
  url: "https://mindmarket.example/",
  trigger: "scroll-to:#rail-2",
  fits: [
    { elementId: 1, path: "#rail-2 > div", channel: "tx", fit: { kind: "marquee", params: { velocityPxPerSec: 36.26, direction: -1, axis: "x" }, valueFrom: -254.85, steadyStartMs: 4968, steadyMs: 9399, r2: 1, onsetTrimMs: 419, nrmse: 0.00044, delayMs: 421, confidence: 0.998 } },
    { elementId: 2, path: "#img-15", channel: "opacity", fit: { kind: "tween", transition: { type: "tween", duration: 0.3033, ease: [0.5403, 0.0028, 0, 0.9923], delay: 0.055 }, valueFrom: 0, valueTo: 1, nrmse: 0.00768, delayMs: 55, confidence: 0.962 } },
    { elementId: 3, path: "#card", channel: "ty", fit: { kind: "spring", transition: { type: "spring", stiffness: 170, damping: 26, mass: 1, velocity: 0 }, settleMs: 1120, valueFrom: 40, valueTo: 0, nrmse: 0.012, delayMs: null, confidence: 0.94 } },
    { elementId: 4, path: "#parallax", channel: "ty", fit: { kind: "scroll-linear", link: { kind: "scroll-linear", slope: -0.5, intercept: 12.5, r2: 0.999 }, nrmse: 0.004, delayMs: null, confidence: 0.98 } },
    { elementId: 5, path: "#dead", channel: "tx", fit: null },
  ],
};
const fitDoc = fromEngineFit(fitArtifact, { capturedAt: META.capturedAt, viewport: META.viewport });
ok(fitDoc.url === "https://mindmarket.example/" && fitDoc.tracks.length === 4, "engine-fit conversion takes the artifact url and skips unfitted rows");
const marquee = fitDoc.tracks.find((t) => t.fit.kind === "marquee");
const tween = fitDoc.tracks.find((t) => t.fit.kind === "tween");
const spring = fitDoc.tracks.find((t) => t.fit.kind === "spring");
const scrollLinear = fitDoc.tracks.find((t) => t.fit.kind === "scroll-linear");
ok(fitDoc.tracks.every((t) => t.provenance.tier === "fitted" && typeof t.fit.nrmse === "number"), "every converted track is fitted-tier and carries its fit residual");
ok(marquee.property === "transform" && marquee.keyframes[0].value === "translateX(-254.85px)" && marquee.timing.iterations === "infinite" && marquee.keyframes[0].easing === "linear", "a marquee becomes an infinite linear translateX track");
ok(marquee.keyframes[1].value === `translateX(${+(-254.85 - 36.26 * 9399 / 1000).toFixed(2)}px)`, "the marquee endpoint is derived from its fitted velocity over the steady window");
ok(tween.property === "opacity" && tween.timing.duration_ms === 303 && tween.timing.delay_ms === 55 && tween.keyframes[0].easing === "cubic-bezier(0.5403, 0.0028, 0, 0.9923)", "a tween carries its fitted duration, delay, and bezier easing");
ok(spring.keyframes[0].value === "translateY(40px)" && spring.keyframes[0].easing === undefined && spring.timing.duration_ms === 1120 && spring.fit.params.stiffness === 170, "a spring pins endpoints without claiming a CSS easing; params stay authoritative");
ok(scrollLinear.keyframes.length === 0 && scrollLinear.timeline.type === "scroll" && scrollLinear.fit.params.slope === -0.5, "a scroll-linear fit becomes a keyframe-free scroll-timeline track carrying its link model");
ok(typeof marquee.provenance.confidence === "number" && marquee.provenance.source === "fit:marquee", "fit provenance records the model kind and confidence");
try {
  fromEngineFit({ url: "u", fits: [{ path: "#x", channel: "tx", fit: { kind: "teleport", nrmse: 0 } }] }, META);
  ok(false, "an unknown fit kind is refused");
} catch (error) { ok(/unknown fit kind/.test(error.message), "an unknown fit kind is refused"); }
try {
  fromEngineFit({ url: "u", fits: [{ path: "#x", channel: "tw", fit: { kind: "tween", transition: { duration: 1 }, valueFrom: 0, valueTo: 1, nrmse: 0 } }] }, META);
  ok(false, "an unknown fit channel is refused");
} catch (error) { ok(/unknown fit channel/.test(error.message), "an unknown fit channel is refused"); }

// -- fromSampled -------------------------------------------------------------------------
// The exact pxDenseRecordStop() shape (tools/browser-capture.js): 4 uniform virtual-time
// steps at 25ms. `.belt` moves on transform AND opacity (filter static); `.bg` never
// changes; a selectorless element moves but cannot be addressed. Two of the style writes
// hit `.belt transform`; one names a prop no track carries.
const denseRecord = {
  frames: 4,
  stepMs: 25,
  elements: [
    { selector: ".belt", samples: [1, 2, 3, 4].map((i) => ({ t: i * 25, values: {
      transform: `matrix(1, 0, 0, 1, ${i * 12}, 0)`, opacity: String(i / 4), filter: "none" } })) },
    { selector: ".bg", samples: [1, 2, 3, 4].map((i) => ({ t: i * 25, values: { transform: "none", opacity: "0.5" } })) },
    { selector: null, samples: [1, 2, 3, 4].map((i) => ({ t: i * 25, values: { opacity: String(i / 8) } })) },
  ],
  writes: [
    { t: 50, selector: ".belt", prop: "transform", value: "translateX(24px)" },
    { t: 75, selector: ".belt", prop: "transform", value: "translateX(36px)" },
    { t: 75, selector: ".belt", prop: "left", value: "10px" },
  ],
  truncated: false,
  skipped: { agentDom: 1 },
  writesObserved: true,
};
const sampledDoc = fromSampled(denseRecord, META);
ok(validateMotionDoc(sampledDoc) && sampledDoc.tracks.length === 2, "a moving element yields one sampled track per changing property, nothing else");
const sampledTransform = sampledDoc.tracks.find((t) => t.property === "transform");
const sampledOpacity = sampledDoc.tracks.find((t) => t.property === "opacity");
ok(sampledTransform && sampledOpacity && sampledDoc.tracks.every((t) => t.target.selector === ".belt" && t.provenance.tier === "sampled"), "sampled tracks carry the sampled tier and the recorded selector");
ok(sampledTransform.keyframes.map((kf) => kf.offset).join(",") === [0, 1 / 3, 2 / 3, 1].join(","), "keyframes sit at uniform offsets 0..1");
ok(sampledTransform.keyframes[1].value === "matrix(1, 0, 0, 1, 24, 0)" && sampledOpacity.keyframes[3].value === "1", "values are the computed CSS strings verbatim");
ok(sampledTransform.timing.duration_ms === 100 && sampledTransform.timing.delay_ms === 0 && sampledTransform.timing.iterations === 1 && sampledTransform.timeline.type === "document", "timing is frames × stepMs on a document timeline");
ok(sampledOpacity.provenance.source === "virtual-time@40fps", "the sampling rate rides in provenance.source (derived from stepMs when meta carries no fps)");
ok(sampledTransform.provenance.source === "virtual-time@40fps+style-writes:2", "matching style-write records merge into the track's provenance.source as evidence");
ok(fromSampled(denseRecord, { ...META, fps: 60 }).tracks[0].provenance.source.startsWith("virtual-time@60fps"), "an explicit meta.fps is the declared rate and wins over the derived one");
const sampling = sampledDoc.sampling;
ok(sampling && sampling.staticDropped === 3 && sampling.unaddressable === 1, "static series (no value change across all frames) are dropped with a receipt count; unaddressable movers are counted, never guessed");
ok(sampling.writesTotal === 3 && sampling.writesMerged === 2 && sampling.truncated === false && sampling.fps === 40, "the sampling receipt carries write totals, merge count, truncation, and the rate");
const nullProp = fromSampled({ frames: 2, stepMs: 10, elements: [{ selector: ".x", samples: [{ t: 10, values: { opacity: null } }, { t: 20, values: { opacity: null } }] }], writes: [] }, META);
ok(nullProp.tracks.length === 0 && nullProp.sampling.staticDropped === 1, "a prop the host never resolved (all null) is static, not a fabricated track");
try { fromSampled(null, META); ok(false, "a non-object record is refused"); }
catch (error) { ok(/pxDenseRecordStop/.test(error.message), "a non-object record is refused"); }
try { fromSampled({ frames: 1 }, META); ok(false, "a record without elements is refused"); }
catch (error) { ok(/elements array/.test(error.message), "a record without elements is refused"); }
try { fromSampled({ frames: 0, stepMs: 0, elements: [] }, META); ok(false, "no fps and no usable stepMs is refused"); }
catch (error) { ok(/fps/.test(error.message), "no fps and no usable stepMs is refused"); }

// -- determinism + round-trip ------------------------------------------------------------
const clone = (v) => JSON.parse(JSON.stringify(v));
ok(JSON.stringify(fromIntrospection(clone(introRecords), META)) === JSON.stringify(introDoc), "fromIntrospection is byte-stable on identical input");
ok(JSON.stringify(fromGsap(clone(gsapRecords), META)) === JSON.stringify(gsapDoc), "fromGsap is byte-stable on identical input");
ok(JSON.stringify(fromEngineFit(clone(fitArtifact), { capturedAt: META.capturedAt, viewport: META.viewport })) === JSON.stringify(fitDoc), "fromEngineFit is byte-stable on identical input");
ok(JSON.stringify(fromSampled(clone(denseRecord), META)) === JSON.stringify(sampledDoc), "fromSampled is byte-stable on identical input — the determinism the sampler certifies end-to-end");
ok(introDoc.tracks.every((t) => /^t-[0-9a-f]{12}$/.test(t.id)) && clone(introDoc).tracks.every((t, i) => t.id === introDoc.tracks[i].id), "converter track ids are deterministic fingerprints");
for (const [name, doc] of [["introspection", introDoc], ["gsap", gsapDoc], ["engine-fit", fitDoc], ["sampled", sampledDoc], ["hand-built", validDoc()]]) {
  const roundTripped = clone(doc);
  ok(JSON.stringify(roundTripped) === JSON.stringify(doc) && validateMotionDoc(roundTripped), `${name} doc round-trips through JSON identical and still valid`);
}

console.log(failed ? `\n❌ motion-doc-selftest: ${failed} assertion(s) failed.` : "\n✓ motion-doc-selftest: all assertions pass.");
process.exit(failed ? 1 : 0);
