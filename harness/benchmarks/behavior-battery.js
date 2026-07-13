// behavior-battery.js — the labelled corpus for the BEHAVIOR gate, the exact analogue of
// battery.js (which scores only the visual gate's diffSnapshots). Until this existed the
// behavior gate had no instrument: a behavior-class miss could be fixed but never SCORED,
// so promote-learning.js could never see a +N/0 A/B for one. Same contract as battery.js:
//
//   • DEFECT  → a clone that really is wrong; a correct gate must FAIL it.
//   • CONTROL → a clone that is right (or a case out of scope); a correct gate must PASS it.
//
// Cases are `measured` blocks exactly as tools/behavior-capture.js emits them, scored through
// workflow.js's compareMeasured — no DOM, deterministic.

const closed = { opacity: 1, transform: "none", filter: "none", visibility: "hidden", descendants: 2292 };

// live: aloyoga's mega-menu — pre-mounted, visibility:hidden, opened by a JS class-toggle on a
// REAL pointer. The synthetic probe fires nothing, so before === after. Pre-fix this was written
// as a bare `changed:false` — byte-identical to a clone with no menu — and the gate passed it.
// Post-fix the capture admits it could not fire the trigger.
const hoverLive = () => ({ before: { ...closed }, after: { ...closed }, changed: false, inconclusive: true, inconclusiveReason: "synthetic pointer events do not set CSS :hover" });
// the clone with NO mega-menu produces exactly the same row — which is the point: an inconclusive
// probe cannot tell them apart, so it must not be green on either side.
const hoverCloneMissing = () => ({ before: { ...closed }, after: { ...closed }, changed: false, inconclusive: true });

// a JS-driven reveal that a synthetic event CAN fire (mounts DOM): the pre-existing class.
const mountLive = () => ({ before: { ...closed }, after: { ...closed, descendants: 2400 }, changed: true });
const mountCloneOk = () => mountLive();
const mountCloneFrozen = () => ({ before: { ...closed }, after: { ...closed }, changed: false });

// a visibility-driven scroll reveal (no hover involved) — visibility is now a measured prop.
const visLive = () => ({ before: { opacity: 1, transform: "none", filter: "none", visibility: "hidden" }, after: { opacity: 1, transform: "none", filter: "none", visibility: "visible" } });
const visCloneOk = () => visLive();
const visCloneStuck = () => ({ before: { opacity: 1, transform: "none", filter: "none", visibility: "hidden" }, after: { opacity: 1, transform: "none", filter: "none", visibility: "hidden" } });

// a DISPLAY-driven reveal (chrono24's header flyout): the panel is pre-mounted and every other
// property is already at its open value — `display` is the only thing that moves.
const dispOpen = { opacity: 1, transform: "none", filter: "none", visibility: "visible", display: "block" };
const dispShut = { opacity: 1, transform: "none", filter: "none", visibility: "visible", display: "none" };
const dispLive = () => ({ before: { ...dispShut }, after: { ...dispOpen } });
const dispCloneOk = () => dispLive();
const dispCloneStuck = () => ({ before: { ...dispShut }, after: { ...dispShut } });   // never opens

// [name, kind, behaviorKind, liveMeasured, cloneMeasured, note]
const behaviorBattery = [
  // ── DEFECTS ──
  ["hover-probe-inconclusive", "defect", "hover-mount", hoverLive(), hoverCloneMissing(),
    "probe cannot fire the menu; clone has none — must not be green (#22)"],
  ["visibility-reveal-stuck", "defect", "class-toggle-or-style-mutation", visLive(), visCloneStuck(),
    "reveal ends visible; clone stays hidden (#22)"],
  ["hover-mount-frozen", "defect", "hover-mount", mountLive(), mountCloneFrozen(),
    "live mounts menu DOM; clone never toggles"],
  // THE DISPLAY-DRIVEN REVEAL (chrono24). A pre-mounted header flyout toggled by ONE class:
  //   .header-flyout { display:none }  .header-flyout.active { display:block }
  // Opacity, transform, filter AND visibility all sit at their open values while the panel is
  // SHUT — only `display` moves. Measured on live: none/0px → block/543px of painted menu, and
  // the old four-property snapshot recorded byte-identical before/after. A clone whose panel
  // stays display:none is a missing 543px menu, and the gate must FAIL it.
  ["display-reveal-stuck", "defect", "class-toggle-or-style-mutation", dispLive(), dispCloneStuck(),
    "reveal ends display:block (543px panel); clone stays display:none — nothing else moves (#22, 2nd instance)"],

  // ── CONTROLS — a correct clone, and the scope limits of the rule ──
  ["adv-hover-mount-reproduced", "control", "hover-mount", mountLive(), mountCloneOk(),
    "JS-mounted menu reproduced → pass"],
  ["adv-visibility-reproduced", "control", "class-toggle-or-style-mutation", visLive(), visCloneOk(),
    "visibility reveal reproduced → pass"],
  // scope: the inconclusive flag must fire ONLY when the probe observed nothing. A hover that
  // really fired must never be painted inconclusive — otherwise every hover row becomes
  // unpassable and the gate trains everyone to --force past it.
  ["adv-fired-hover-not-inconclusive", "control", "hover-mount", mountLive(), mountCloneOk(),
    "a hover that fired is never inconclusive → pass"],
  // scope: an older capture that predates the visibility/inconclusive fields must not be flagged
  // (same "old schema → skip, don't invent a miss" control as adv-strut-old-schema). Without this
  // the new rule would retro-fail every target captured before today.
  ["adv-behavior-old-schema", "control", "hover-mount",
    { before: { opacity: 1, transform: "none", filter: "none" }, after: { opacity: 1, transform: "none", filter: "none" }, changed: false },
    { before: { opacity: 1, transform: "none", filter: "none" }, after: { opacity: 1, transform: "none", filter: "none" }, changed: false },
    "capture predates visibility/inconclusive → skipped, no flag"],
  // scope: a display reveal the clone DOES reproduce must pass — the new property must not turn
  // every pre-mounted panel into an unpassable row.
  ["adv-display-reveal-reproduced", "control", "class-toggle-or-style-mutation", dispLive(), dispCloneOk(),
    "display reveal reproduced (none→block on both) → pass"],
  // scope: an older capture that predates the `display` field must not be flagged. Every target
  // captured before today has no `display` in its snapshots; comparing it against a fresh capture
  // that HAS one must skip, not invent a miss (same rule as adv-strut-old-schema / adv-mode-old-schema).
  ["adv-display-old-schema", "control", "class-toggle-or-style-mutation",
    { before: { opacity: 1, transform: "none", filter: "none", visibility: "visible" },
      after:  { opacity: 1, transform: "none", filter: "none", visibility: "visible" } },
    { before: { ...dispShut }, after: { ...dispShut } },
    "live capture predates `display`, clone has it → skipped, no flag"],
  // scope: a marquee's numbers must keep passing untouched by any of this.
  ["adv-marquee-same-speed", "control", "marquee",
    { pxPerSec: 42.5, axis: "x", from: 0, to: 42.5, sampledMs: 1000 },
    { pxPerSec: 43.9, axis: "x", from: 0, to: 43.9, sampledMs: 1000 },
    "same belt speed within ±15% → pass"],
];

function scoreBehaviorGate(compareMeasured) {
  let caught = 0, defects = 0, falsePos = 0, controls = 0;
  const rows = behaviorBattery.map(([name, kind, bKind, live, clone, note]) => {
    const pass = compareMeasured(name, bKind, live, clone).ok;
    if (kind === "defect") { defects++; if (!pass) caught++; }
    else { controls++; if (!pass) falsePos++; }
    return { name, kind, pass, note, correct: kind === "defect" ? !pass : pass };
  });
  return { rows, caught, defects, falsePos, controls };
}

module.exports = { behaviorBattery, scoreBehaviorGate };
