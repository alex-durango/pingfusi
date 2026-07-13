// fixtures/22-css-hover-reveal.js — the GATE half of the inconclusive-hover miss (fixture 23 is
// the capture half). Found on aloyoga: the mega-menu is pre-mounted, `visibility: hidden`, and
// opened by a JS class-toggle (`navOpenOnHoverChild`) on a REAL pointer. A synthetic MouseEvent
// sets neither the CSS `:hover` pseudo-class nor a trusted-event flag, so the hover probe saw
// nothing move and recorded `changed: false` — the byte-identical row a clone with NO MENU AT
// ALL produces. The behavior gate passed it.
//
// The fix does not pretend to fire a hover it cannot fire. It refuses to launder the failure:
// a named trigger that the probe could not fire is INCONCLUSIVE, and an inconclusive row must
// be disposed (verified in a review round + documented), never silently green.
//
// Second, independent half: `visibility` is now part of the snapshot at all — the open and the
// closed menu differ ONLY in visibility (opacity stays 1), so without it even a real hover would
// have snapshotted both states as identical.
const { compareMeasured } = require("../workflow.js");
let bad = 0; const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

const closed = { opacity: 1, transform: "none", filter: "none", visibility: "hidden", descendants: 2292 };

// 1) THE MISS — the probe could not fire the trigger; the row must NOT pass as green.
{
  const live = { before: { ...closed }, after: { ...closed }, changed: false, inconclusive: true, inconclusiveReason: "synthetic pointer events do not set CSS :hover" };
  const cloneMissingMenu = { before: { ...closed }, after: { ...closed }, changed: false, inconclusive: true };
  const r = compareMeasured("hover:nav_women", "hover-mount", live, cloneMissingMenu);
  check("an INCONCLUSIVE live hover probe does not pass silently", !r.ok && /INCONCLUSIVE/.test(r.detail));
  check("…and the failure says absence of evidence ≠ evidence of absence", /absence of evidence/.test(r.detail));
}
// 2) a hover the probe COULD fire (JS mounts DOM) and the clone reproduces → PASS.
{
  const live = { before: { ...closed }, after: { ...closed, descendants: 2400 }, changed: true };
  const r = compareMeasured("hover:nav_women", "hover-mount", live, { ...live });
  check("a hover that really fired and is reproduced passes (no false positive)", r.ok);
}
// 3) a hover the probe could fire but the clone froze → FAIL (the pre-existing class still works).
{
  const live = { before: { ...closed }, after: { ...closed, descendants: 2400 }, changed: true };
  const frozen = { before: { ...closed }, after: { ...closed }, changed: false, inconclusive: true };
  const r = compareMeasured("hover:nav_women", "hover-mount", live, frozen);
  check("a live hover the clone never reproduces still fails", !r.ok && /changed/.test(r.detail));
}
// 4) visibility is a MEASURED end-state: a reveal that ends `visible` but is stuck `hidden` in
//    the clone must FAIL even though opacity/transform/filter are identical on both sides.
{
  const l = { before: { opacity: 1, transform: "none", filter: "none", visibility: "hidden" }, after: { opacity: 1, transform: "none", filter: "none", visibility: "visible" } };
  const c = { before: { opacity: 1, transform: "none", filter: "none", visibility: "hidden" }, after: { opacity: 1, transform: "none", filter: "none", visibility: "hidden" } };
  const r = compareMeasured("reveal:panel", "class-toggle-or-style-mutation", l, c);
  check("gate catches a visibility reveal stuck hidden in the clone", !r.ok && /visibility/.test(r.detail));
}
// 5) SCOPE — a capture predating the new fields (no visibility, no inconclusive) must be
//    SKIPPED, not flagged (same contract as the strut/compat-mode old-schema controls). This is
//    what stops the new rule retro-failing every target captured before today.
{
  const old = { before: { opacity: 1, transform: "none", filter: "none" }, after: { opacity: 1, transform: "none", filter: "none" }, changed: false };
  const r = compareMeasured("hover:nav_women", "hover-mount", old, { ...old });
  check("a capture predating visibility/inconclusive is skipped, not flagged", r.ok);
}

console.log(bad ? `\n❌ ${bad} check(s) failed` : "\n✓ an unfirable hover is inconclusive, not green; visibility is measured.");
process.exit(bad ? 1 : 0);
