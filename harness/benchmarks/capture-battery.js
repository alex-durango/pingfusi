// capture-battery.js — the detection instrument for the CAPTURE half.
//
// WHY THIS EXISTS. battery.js scores a proposed change by feeding PRE-BUILT snapshot pairs to
// `diffSnapshots` — it scores the DIFF. But a whole class of miss lives one layer earlier, in the
// CAPTURE: the comparison is fine, it is the NUMBER THAT GOT RECORDED that is wrong. Those changes
// are structurally invisible to battery.js (nothing there ever calls `measure()`), so
// detection-power could neither credit nor punish them — a capture fix scored +0 forever, and
// `promote-learning` refused it no matter how correct it was. (Found while fixing the `prevGap`
// false positive: lelabo, 2026-07-12.)
//
// This battery drives the REAL `measure()` over a tiny DOM shim and then scores the resulting
// snapshot pair with the STRICT diff — strict, not visual, because a capture-level defect like
// prevGap is a structural property the visual gate does not compare at all.
//
//   • DEFECT  → the two DOMs genuinely differ in a way that must show up. A correct capture+diff
//     FAILS the pair (catches it).
//   • CONTROL → the two DOMs render identically; only something NON-RENDERED differs (e.g. a
//     <script> the build strips). A correct capture+diff PASSES. A flag here is a FALSE POSITIVE
//     — and it is one the kit manufactured itself.
//
// Loading a BASELINE capture works because browser-capture.js ends with `root.pxMeasure = measure`
// against `typeof window !== "undefined" ? window : globalThis` — so defining a shim `window`
// before requiring it hands us that version's own `measure`, with no export needed. That is what
// lets detection-power A/B the capture against an arbitrary git ref.
"use strict";
const path = require("path");

// ── DOM shim (no deps, no jsdom) ──────────────────────────────────────────────────────────────
const STYLE = {
  fontFamily: "proxima-nova", fontWeight: "600", fontSize: "14px", lineHeight: "18.2px",
  letterSpacing: "0.7px", textTransform: "uppercase", color: "rgb(0, 0, 0)",
  textDecorationLine: "none", textDecorationThickness: "auto", webkitFontSmoothing: "antialiased",
  paddingTop: "0px", paddingRight: "0px", paddingBottom: "0px", paddingLeft: "0px",
  marginTop: "0px", marginRight: "0px", marginBottom: "0px", marginLeft: "0px",
  borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px",
  borderBottomStyle: "none", boxSizing: "border-box",
  display: "block", position: "static", top: "auto", left: "auto", verticalAlign: "baseline",
  gap: "0px", backgroundColor: "rgb(255, 255, 255)", backgroundImage: "none",
  opacity: "1", // the default every real getComputedStyle reports; the opacity cases override it
  getPropertyValue() { return ""; },
};

// rect: [x, right] on a fixed y band — prevGap only reads left/right edges.
function el(tagName, { x = 0, right = 0, text = null, style = {} } = {}) {
  const rect = { x, y: 80, width: right - x, height: 17, top: 80, right, bottom: 97, left: x };
  const node = {
    tagName,
    nodeType: 1, // a real Element's nodeType; the ancestor walks (effectiveOpacity) test for it
    __style: { ...STYLE, ...style },
    getBoundingClientRect: () => rect,
    parentElement: null,
    previousElementSibling: null,
    childNodes: text != null ? [{ nodeType: 3, textContent: text }] : [],
    querySelectorAll: () => [],
    closest: () => null,
    __rect: rect,
  };
  return node;
}

// One element nested under a styled parent, and the CHILD is what gets measured. The opacity
// cases need this: a scroll-reveal hides the CONTAINER, and the container's leaves each still
// compute `opacity: 1` of their own — so a capture that recorded only own-opacity would read 1 on
// every leaf of an invisible section. The parent is what carries the 0.
function under(parentStyle, child) {
  const parent = el("DIV", { x: 0, right: 1728, style: parentStyle });
  child.parentElement = parent;
  return child;
}

// left→right siblings under one parent
function row(...nodes) {
  const parent = el("DIV");
  nodes.forEach((n, i) => {
    n.parentElement = parent;
    n.previousElementSibling = i ? nodes[i - 1] : null;
  });
  return nodes;
}

// A zero-box <script>: what previousElementSibling sees on live, and what capture-build strips.
const script = () => el("SCRIPT", { x: 0, right: 0, style: { display: "block" } });

// ── the cases ─────────────────────────────────────────────────────────────────────────────────
// Each builder returns the ELEMENT TO MEASURE (its siblings/parent hang off it).
// [name, kind, buildLive, buildClone, note]
const captureBattery = [
  // ── CONTROL: the false positive the kit manufactured itself (the whole reason this file exists)
  // live : <header>…</header> <script>headerInitialize()</script> <h1>Le Labo</h1>
  // clone: <header>…</header>                                    <h1>Le Labo</h1>   (script stripped, #19)
  // Nothing rendered moved. A capture that measures prevGap against previousElementSibling reads
  // the script on live (right edge 0 → prevGap -1) and the <header> in the clone (right edge 1728
  // → prevGap -1729): a 1728px phantom delta on a page where --visual is green.
  ["adv-prevgap-script-stripped", "control",
    () => { const [, , h1] = row(el("HEADER", { x: 0, right: 1728 }), script(), el("H1", { x: -1, right: 0, text: "Le Labo" })); return h1; },
    () => { const [, h1] = row(el("HEADER", { x: 0, right: 1728 }), el("H1", { x: -1, right: 0, text: "Le Labo" })); return h1; },
    "a <script> sibling the build strips must not invent a prevGap delta (#19)"],

  // ── CONTROL: a display:none sibling renders nothing either — same rule, same must-not-flag.
  ["adv-prevgap-display-none", "control",
    () => { const [, , s] = row(el("DIV", { x: 0, right: 100 }), el("DIV", { x: 0, right: 0, style: { display: "none" } }), el("SPAN", { x: 108, right: 288, text: "hi" })); return s; },
    () => { const [, s] = row(el("DIV", { x: 0, right: 100 }), el("SPAN", { x: 108, right: 288, text: "hi" })); return s; },
    "a display:none sibling has no box — no phantom delta"],

  // ── DEFECT: a REAL prevGap change must still be caught. This is the over-fix guard: skipping
  // non-rendered siblings must not degrade into "stop measuring prevGap".
  // The measured element's own rect is IDENTICAL on both sides — only the gap to its rendered
  // neighbour changed (the neighbour's right edge moved 100 → 60), so this can ONLY be caught via
  // prevGap. A capture that dropped prevGap entirely would MISS it.
  ["prevgap-real-shift", "defect",
    () => { const [, s] = row(el("DIV", { x: 0, right: 100 }), el("SPAN", { x: 108, right: 288, text: "hi" })); return s; },
    () => { const [, s] = row(el("DIV", { x: 0, right: 60 }), el("SPAN", { x: 108, right: 288, text: "hi" })); return s; },
    "gap to the rendered neighbour: 8px vs 48px — still caught"],

  // ── CONTROL: identical DOMs → nothing to say.
  ["adv-prevgap-identical", "control",
    () => { const [, s] = row(el("DIV", { x: 0, right: 100 }), el("SPAN", { x: 108, right: 288, text: "hi" })); return s; },
    () => { const [, s] = row(el("DIV", { x: 0, right: 100 }), el("SPAN", { x: 108, right: 288, text: "hi" })); return s; },
    "same DOM on both sides → pass"],

  // ── OPACITY (harness/fixtures/38-opacity-painted-property.js) ─────────────────────────────────────────────────────────────────
  // THE DEFECT the schema could not see. dtf's authored hidden state is a CSS class on the
  // CONTAINER — `.AnimateContainer { opacity: 0.0001 }` — and GSAP writes an inline `opacity: 1`
  // when it scrolls into view. A DOM serialized before the reveal bakes no inline opacity, so the
  // static clone renders that section at 0.0001: invisible forever. dtf shipped 10 such sections,
  // INCLUDING THE ENTIRE FOOTER, and every gate was green — because opacity was not a field.
  //
  // Note the leaf's OWN opacity is 1 on both sides. Only the container's differs. This case
  // therefore fails unless the capture records the EFFECTIVE (composited) opacity — which is the
  // whole design of the fix, and an own-opacity implementation would score a silent 0 here.
  ["capture-stealth-zero-opacity", "defect",
    () => under({ opacity: "1" }, el("P", { x: 0, right: 200, text: "footer" })),
    () => under({ opacity: "0.0001" }, el("P", { x: 0, right: 200, text: "footer" })),
    "a scroll-reveal container left at its authored stealth-zero (0.0001) — the section is invisible in the clone; identical in every other recorded property"],

  // The plain, unsubtle version: a hidden container at a true 0. Must also be caught — the rule is
  // "the effective opacity differs", not "the string 0.0001 appears".
  ["capture-zero-opacity-container", "defect",
    () => under({ opacity: "1" }, el("SPAN", { x: 0, right: 90, text: "hi" })),
    () => under({ opacity: "0" }, el("SPAN", { x: 0, right: 90, text: "hi" })),
    "a container at opacity 0 → its leaf paints nothing, while rect/font/box/bg are all identical"],

  // ── CONTROL, and the one dtf explicitly flagged as the false-positive risk of this whole fix:
  // a LEGITIMATELY translucent mark. dtf's own hero scrim sits at --overlay-opacity: 0.2 on BOTH
  // sides and is a faithful reproduction. The rule catches DIVERGENCE, never translucency itself.
  // If this ever flags, the gate has started calling correct clones broken (#23).
  ["adv-opacity-matching-translucent", "control",
    () => under({ opacity: "0.2" }, el("DIV", { x: 0, right: 1728, text: "scrim" })),
    () => under({ opacity: "0.2" }, el("DIV", { x: 0, right: 1728, text: "scrim" })),
    "a translucent hero scrim at 0.2 on BOTH sides — faithful, must never flag (dtf's own)"],

  // CONTROL: sub-tolerance compositor/float noise must not fail. 0.999 vs 1 is not a visible mark.
  ["adv-opacity-float-noise", "control",
    () => under({ opacity: "1" }, el("SPAN", { x: 0, right: 90, text: "hi" })),
    () => under({ opacity: "0.999" }, el("SPAN", { x: 0, right: 90, text: "hi" })),
    "0.999 vs 1.0 — below OPACITY_TOL; float noise is not a defect"],
];

// ── scoring ───────────────────────────────────────────────────────────────────────────────────
// Load a capture module's `measure` by requiring it under a shim `window` (it self-assigns
// root.pxMeasure). Works for the worktree copy AND for a materialised baseline.
function loadMeasure(captureSrcPath) {
  const prevWindow = global.window, prevGCS = global.getComputedStyle, prevDoc = global.document;
  const shimWindow = { innerWidth: 1728, innerHeight: 900, devicePixelRatio: 2 };
  global.window = shimWindow;
  global.getComputedStyle = (node) => (node && node.__style) || STYLE;
  global.document = {
    compatMode: "CSS1Compat",
    createRange: () => ({
      __el: null,
      selectNodeContents(tn) { this.__tn = tn; },
      // the text box of a leaf: the shim's text fills its element's box
      getBoundingClientRect() { return this.__owner || { x: 0, y: 80, width: 0, height: 17, top: 80, right: 0, bottom: 97, left: 0 }; },
    }),
  };
  try {
    delete require.cache[require.resolve(captureSrcPath)];
    require(captureSrcPath);
    const measure = shimWindow.pxMeasure;
    if (typeof measure !== "function") throw new Error(`${captureSrcPath} did not expose pxMeasure`);
    return { measure, restore: () => { global.window = prevWindow; global.getComputedStyle = prevGCS; global.document = prevDoc; } };
  } catch (e) {
    global.window = prevWindow; global.getComputedStyle = prevGCS; global.document = prevDoc;
    throw e;
  }
}

const snapOf = (measured) => ({ url: "https://example.com/", viewport: { width: 1728, height: 900, dpr: 2 }, mode: "CSS1Compat", elements: { t: measured } });

// Score a CAPTURE (a measure fn) against the STRICT diff. Strict, not visual: prevGap is a
// structural property the visual gate never compares, so scoring it in visual mode would report
// "no difference" for every case and quietly measure nothing.
function scoreCaptureGate(measure, diffSnapshots) {
  let caught = 0, defects = 0, falsePos = 0, controls = 0;
  const rows = captureBattery.map(([name, kind, buildLive, buildClone, note]) => {
    const L = snapOf(measure(buildLive(), { text: true }));
    const C = snapOf(measure(buildClone(), { text: true }));
    const pass = diffSnapshots(L, C, {}).ok; // strict
    if (kind === "defect") { defects++; if (!pass) caught++; }
    else { controls++; if (!pass) falsePos++; }
    return { name, kind, pass, note, correct: kind === "defect" ? !pass : pass };
  });
  return { rows, caught, defects, falsePos, controls };
}

module.exports = { captureBattery, scoreCaptureGate, loadMeasure };
