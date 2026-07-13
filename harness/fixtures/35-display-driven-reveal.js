// fixtures/35-display-driven-reveal.js — A 543px MENU OPENED, AND THE INSTRUMENT SAW NOTHING.
//
// Paid for on chrono24 (2026-07-13). This is LEARNINGS #22's rule hitting its SECOND instance, on
// a property nobody had added yet.
//
// #22 taught: a pre-mounted panel revealed by `visibility: hidden → visible` moves none of
// opacity/transform/filter, so `visibility` had to join the snapshot or an open menu and a closed
// one read as the same state. chrono24 reveals its header flyouts a third way — by DISPLAY:
//
//     .header-navigation .header-flyout        { display: none; }
//     .header-navigation .header-flyout.active { display: block; }
//
// The panel is PRE-MOUNTED: 103 descendants whether it is open or shut. And while it is SHUT its
// opacity is 1, its transform is none, its filter is none, and its visibility is `visible` — every
// property the snapshot recorded was ALREADY at its open value. Measured on live by toggling the
// site's own `.active` class:
//
//     what actually happened   display: none → block,  height: 0px → 543px
//     what styleSnap recorded  {opacity:1, transform:"none", filter:"none", visibility:"visible"}
//                              …before AND after. Byte-identical. A 543px panel, invisible to the gate.
//
// So the behavior probe could never report anything but `changed:false` for these flyouts — which
// #22's own guard then (correctly) files as INCONCLUSIVE forever. The gate was safe but blind: it
// could refuse the row, never verify it. A clone whose flyout stays display:none is a missing
// menu, and nothing in the kit could tell.
//
// THE DURABLE RULE (the one worth carrying): the snapshot must record EVERY property a reveal can
// move — opacity, transform, filter, visibility, display. A reveal mechanism the instrument does
// not record is a reveal it cannot gate.
//
// NARROW BY CONSTRUCTION: `display` is compared ONLY when both captures recorded it (control 4),
// so no target captured before today retro-fails; and a reproduced reveal still passes (control 3).
"use strict";
let bad = 0;
const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

// ── 1. THE CAPTURE — styleSnap must record `display` ─────────────────────────────────
// FAILS WITHOUT THE CHANGE: the old styleSnap returned only opacity/transform/filter/visibility.
{
  const cap = require("../../tools/behavior-capture.js");
  const el = {
    // the chrono24 shape: shut, but every other property already at its open value
    _cs: { opacity: "1", transform: "none", filter: "none", visibility: "visible", display: "none" },
  };
  global.getComputedStyle = (e) => e._cs;
  const shut = cap.styleSnap(el);
  el._cs = { ...el._cs, display: "block" };          // the site toggles .active
  const open = cap.styleSnap(el);

  check("styleSnap RECORDS `display` (the only property a display-driven reveal moves)",
    shut.display === "none" && open.display === "block");
  check("…so an OPEN panel and a SHUT one are no longer the same snapshot",
    !cap.styleSnapEq(shut, open));
  check("CONTROL: two identical shut panels still compare EQUAL (no invented change)",
    cap.styleSnapEq(shut, { ...shut }));
  // old-schema: a snapshot with no `display` must not read as a mismatch
  const legacy = { opacity: 1, transform: "none", filter: "none", visibility: "visible" };
  check("CONTROL: a legacy snapshot with no `display` is not a mismatch (old-schema skip)",
    cap.styleSnapEq(legacy, { ...legacy, display: "block" }));
}

// ── 2. THE GATE — compareMeasured must FAIL a clone whose panel never opens ──────────
{
  const wf = require("../../harness/workflow.js");
  const open = { opacity: 1, transform: "none", filter: "none", visibility: "visible", display: "block" };
  const shut = { opacity: 1, transform: "none", filter: "none", visibility: "visible", display: "none" };

  const stuck = wf.compareMeasured("reveal:js-header-buy-flyout", "class-toggle-or-style-mutation",
    { before: { ...shut }, after: { ...open } },     // live: the flyout opens
    { before: { ...shut }, after: { ...shut } });    // clone: it never does
  check("the gate FAILS a clone whose display-driven flyout never opens (live block, clone none)",
    !stuck.ok);
  check("…and the miss names `display` explicitly, so the operator knows what to reproduce",
    JSON.stringify(stuck).includes("display"));

  const good = wf.compareMeasured("reveal:js-header-buy-flyout", "class-toggle-or-style-mutation",
    { before: { ...shut }, after: { ...open } },
    { before: { ...shut }, after: { ...open } });
  check("CONTROL: a clone that DOES reproduce the reveal passes", good.ok);

  // old schema: live captured before `display` existed → skip, never invent a miss
  const legacyLive = { before: { opacity: 1, transform: "none", filter: "none", visibility: "visible" },
                       after:  { opacity: 1, transform: "none", filter: "none", visibility: "visible" } };
  const legacy = wf.compareMeasured("reveal:x", "class-toggle-or-style-mutation", legacyLive,
    { before: { ...shut }, after: { ...shut } });
  check("CONTROL: a live capture predating `display` is not retro-failed (old-schema skip)", legacy.ok);

  // #22 HOLDS: the visibility-driven reveal is still caught
  const visLive = { before: { opacity: 1, transform: "none", filter: "none", visibility: "hidden" },
                    after:  { opacity: 1, transform: "none", filter: "none", visibility: "visible" } };
  const visStuck = { before: { opacity: 1, transform: "none", filter: "none", visibility: "hidden" },
                     after:  { opacity: 1, transform: "none", filter: "none", visibility: "hidden" } };
  check("#22 HOLDS: a visibility-driven reveal that never fires is still caught",
    !wf.compareMeasured("reveal:menu", "class-toggle-or-style-mutation", visLive, visStuck).ok);
}

console.log(bad ? `\n✗ ${bad} check(s) failed` : "\n✓ 35-display-driven-reveal: the snapshot records every property a reveal can move.");
process.exit(bad ? 1 : 0);
