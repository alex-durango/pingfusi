// battery.js — the fixed set of known visual DEFECTS + negative CONTROLS the gate is
// scored against. This is the kit's detection-power *instrument*: a labelled corpus,
// separate from any one target, so a proposed gate change can be measured objectively
// (see detection-power.js). Each case is a pair of snapshots differing by exactly one
// thing:
//   • DEFECT  → a visibly wrong clone; a correct gate must FAIL it (catch it). A miss is
//     a defect that would slip a green run and cost a review round.
//   • CONTROL → visually identical; a correct gate must PASS it. A flag here is a FALSE
//     POSITIVE — friction the gate invented, which can regress a previously-green clone.
// Add a case whenever a new class of miss (or a new false-positive risk) is found — the
// battery is how "did this change improve detection without adding noise?" becomes a
// number instead of a vibe. Zero deps, no DOM, fully deterministic.

const textEl = (over = {}) => ({
  present: true,
  rect: { x: 100, y: 80, w: 180, h: 17, top: 80, right: 280, bottom: 97, fromRight: 200 },
  font: { family: "proxima-nova", weight: "600", size: 14, line: 18.2, spacing: 0.7,
          transform: "uppercase", color: "rgb(0,0,0)", decoration: "none", smoothing: "antialiased",
          underline: false, ...(over.font || {}) },
  box: { padT: 0, padB: 0 }, layout: { display: "flex", position: "static" }, parent: { display: "flex", gap: 8 },
  text: { x: 100, right: 280, top: 80, bottom: 97, w: 180, h: 17, ...(over.text || {}) },
  underline: over.underline !== undefined ? over.underline : { present: false },
  bg: over.bg !== undefined ? over.bg : "rgb(255,255,255)",
});
const gfxEl = (over = {}) => ({
  present: true,
  rect: { x: 100, y: 79, w: 20, h: 20, top: 79, right: 120, bottom: 99, fromRight: 200 },
  font: {}, box: {}, layout: { display: "inline-block", position: "static" }, parent: { display: "flex", gap: 8 },
  glyph: { cx: 110, cy: 89, w: 20, h: 20, bgPos: "0% 0%", ...(over.glyph || {}) },
  bg: over.bg !== undefined ? over.bg : "rgb(255,255,255)",
});
const snap = (el) => ({ viewport: { width: 1728 }, elements: { t: el } });

const UL = { present: true, thickness: 2, x: 90, right: 280, w: 190, top: 99, bottom: 101 };

// [name, kind, liveEl, cloneEl, note, mods?].  Each name should trace to a LEARNINGS entry.
// mods = optional snapshot-level overrides for page-level props: { liveMode, cloneMode }.
const battery = [
  // ── DEFECTS — a correct gate FAILS each ──
  ["backdrop-color",     "defect", textEl({ bg: "rgb(113,198,235)" }), textEl({ bg: "rgb(255,0,0)" }), "blue bar vs red bar (#16)"],
  ["text-color",         "defect", textEl(), textEl({ font: { color: "rgb(255,255,255)" } }), "black vs white text (#10)"],
  ["underline-missing",  "defect", textEl({ underline: UL, font: { underline: true } }), textEl({ underline: { present: false }, font: { underline: false } }), "underline present vs gone (#11)"],
  ["underline-thin",     "defect", textEl({ underline: UL }), textEl({ underline: { ...UL, thickness: 1 } }), "2px vs 1px (#12)"],
  ["underline-short",    "defect", textEl({ underline: UL }), textEl({ underline: { ...UL, w: 150, right: 240 } }), "190 vs 150 wide (#12)"],
  ["underline-y",        "defect", textEl({ underline: UL }), textEl({ underline: { ...UL, top: 103, bottom: 105 } }), "shifted 4px down (#12)"],
  ["smoothing",          "defect", textEl(), textEl({ font: { smoothing: "auto" } }), "antialiased vs auto (#13)"],
  ["glyph-cy",           "defect", gfxEl(), gfxEl({ glyph: { cy: 92 } }), "icon 3px low (#9)"],
  ["glyph-cx",           "defect", gfxEl(), gfxEl({ glyph: { cx: 114 } }), "icon 4px right (#1/#9)"],
  ["line-height",        "defect", textEl(), textEl({ font: { line: 14 } }), "18.2 vs 14 (#2)"],
  ["line-strut",         "defect", textEl({ font: { strut: 16 } }), textEl({ font: { strut: "normal" } }), "container 16px vs normal, leaf matches (#17)"],
  ["line-strut-numeric", "defect", textEl({ font: { strut: 16 } }), textEl({ font: { strut: 18 } }), "container 16 vs 18 (#17)"],
  ["compat-mode",        "defect", textEl(), textEl(), "quirks vs standards doc mode (#18)", { liveMode: "BackCompat", cloneMode: "CSS1Compat" }],
  ["letter-spacing",     "defect", textEl(), textEl({ font: { spacing: 2 } }), "0.7 vs 2 (#2)"],
  ["font-size",          "defect", textEl(), textEl({ font: { size: 16 } }), "14 vs 16 (#3)"],
  // A LOST ISLAND — live paints the leaf, the clone has nothing there. On chrono24 the capture's
  // own cloneNode(true) destroyed <c24-main-search-app>'s subtree (an upgraded custom element
  // re-runs its constructor when cloned), so the main search bar was captured as an empty mount
  // point. Whatever the cause (dropped subtree, unmounted island, stripped section), a painted
  // live leaf with no clone counterpart is a hole and the gate must FAIL it
  // (harness/fixtures/31-custom-element-subtree.js).
  ["lost-island",        "defect", textEl(), { present: false }, "live paints it, clone has nothing (fixtures/31-custom-element-subtree.js)"],
  // THE BOX IS NOT THE IMAGE. A 404'd <img> sized by CSS has EXACTLY the box the real photo has —
  // same rect, same glyph cx/cy/w/h, same bg, still `present`. chrono24 shipped 10 grey holes where
  // the "most popular models" watch photos belong and the sweep passed 0/6002; the reviewer's first
  // words were "the images are not rendered". `complete && naturalWidth > 0` is the whole test.
  ["image-not-painted",  "defect", gfxEl({ glyph: { painted: true } }), gfxEl({ glyph: { painted: false } }), "live's image paints, the clone's is a grey hole (fixtures/36-image-not-painted.js)"],
  // ── CONTROLS — a correct gate PASSES each (no false positive) ──
  ["identical-text",     "control", textEl(), textEl(), "same in every paint prop"],
  ["identical-gfx",      "control", gfxEl(), gfxEl(), "same glyph"],
  ["structural-only",    "control", textEl(), textEl({ box: { padT: 24, padB: 24 }, layout: { display: "block", position: "relative" }, parent: { display: "block", gap: 0 }, font: { family: "proxima" } }), "flex/pad/alias differ, pixels same (#6)"],
  ["backdrop-transparent","control", textEl({ bg: "rgba(0, 0, 0, 0)" }), textEl({ bg: "rgba(0, 0, 0, 0)" }), "both transparent → skipped"],
  // adversarial controls — false-positive hunters for the backdrop gate (#16)
  ["adv-same-translucent","control", textEl({ bg: "rgba(0, 0, 0, 0.5)" }), textEl({ bg: "rgba(0, 0, 0, 0.5)" }), "same translucent → pass"],
  ["adv-translucent-vs-solid","control", textEl({ bg: "rgba(0, 0, 0, 0.5)" }), textEl({ bg: "rgb(128,128,128)" }), "translucent vs solid — out of scope, no flag"],
  ["adv-whitespace",     "control", textEl({ bg: "rgb(113,198,235)" }), textEl({ bg: "rgb(113, 198, 235)" }), "same colour, different spacing"],
  // adversarial controls — false-positive hunters for the strut gate (#17)
  ["adv-strut-same-normal","control", textEl({ font: { strut: "normal" } }), textEl({ font: { strut: "normal" } }), "same technique on both → pass"],
  ["adv-strut-old-schema","control", textEl(), textEl({ font: { strut: 16 } }), "one capture predates strut → skipped, no flag"],
  // adversarial control — the false-positive hunter for the lost-island defect. chrono24
  // ships TWO Vue mounts marked identically (`data-v-app`): <c24-main-search-app> (22 nodes) and
  // <c24-toasts-app> — and the toasts app is FAITHFULLY EMPTY on live too (no toast to show). A
  // gate that flags "declares a mount, paints nothing" would fail the clone for reproducing live
  // exactly (#25). Absent on BOTH sides is a match, not a hole — only live-vs-clone can tell the
  // two apart, which is why this stayed a capture fix and never became a single-artifact lint rule.
  ["adv-absent-both",    "control", { present: false }, { present: false }, "faithfully-empty mount on both → pass (#25)"],
  // adversarial controls — the false-positive hunters for the image-painted gate. A gate that
  // flagged any of these would fail clones that are CORRECT.
  ["adv-image-painted-both","control", gfxEl({ glyph: { painted: true } }), gfxEl({ glyph: { painted: true } }), "both images paint → pass"],
  // live's own image is broken (a 404 on the SITE). The clone reproduces the broken image
  // faithfully — that zero box IS the site's rendering, and calling it a hole is #25's mistake.
  ["adv-image-broken-both","control", gfxEl({ glyph: { painted: false } }), gfxEl({ glyph: { painted: false } }), "broken on BOTH → faithful, not a hole (#25)"],
  // live picks the 2x srcset candidate, the clone the 1x: both PAINT, natural sizes differ. Gating
  // naturalW/H (instead of the boolean) would fail a clone that renders identically.
  ["adv-image-srcset-candidate","control", gfxEl({ glyph: { painted: true, naturalW: 544, naturalH: 664 } }), gfxEl({ glyph: { painted: true, naturalW: 272, naturalH: 332 } }), "2x vs 1x candidate, both paint → pass"],
  ["adv-image-old-schema","control", gfxEl(), gfxEl({ glyph: { painted: true } }), "one capture predates `painted` → skipped, no flag"],
  // adversarial controls — false-positive hunters for the compat-mode gate (#18)
  ["adv-mode-same",      "control", textEl(), textEl(), "both quirks → pass", { liveMode: "BackCompat", cloneMode: "BackCompat" }],
  ["adv-mode-old-schema","control", textEl(), textEl(), "one capture predates mode → skipped, no flag", { liveMode: "BackCompat" }],
];

// Score a gate (a diffSnapshots fn) over the battery. Returns per-case rows + totals.
function scoreGate(diffSnapshots) {
  let caught = 0, defects = 0, falsePos = 0, controls = 0;
  const rows = battery.map(([name, kind, live, clone, note, mods]) => {
    const L = snap(live), C = snap(clone);
    if (mods) { if (mods.liveMode) L.mode = mods.liveMode; if (mods.cloneMode) C.mode = mods.cloneMode; }
    const pass = diffSnapshots(L, C, { visual: true }).ok;
    if (kind === "defect") { defects++; if (!pass) caught++; }
    else { controls++; if (!pass) falsePos++; }
    return { name, kind, pass, note, correct: kind === "defect" ? !pass : pass };
  });
  return { rows, caught, defects, falsePos, controls };
}

module.exports = { battery, scoreGate, snap };
