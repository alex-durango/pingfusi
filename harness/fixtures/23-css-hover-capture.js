// fixtures/23-css-hover-capture.js — the CAPTURE half of the inconclusive-hover miss (fixture 22
// is the gate half). Found on aloyoga, where the mega-menu is PRE-MOUNTED and revealed by nothing
// but `visibility: hidden → visible`.
//
// probeHover snapshots the SCOPE's own opacity/transform/filter plus its DESCENDANT COUNT. With
// the default scope (document.body) a pre-mounted panel flipping `visibility` moves NEITHER: the
// body's own style is unchanged and no nodes are added. So the probe wrote `changed: false` — the
// exact row a clone with NO MENU AT ALL produces, and the gate passed it. (The panel measured as
// the scope, it reads hidden → visible and changed: true — the reveal was always there; the probe
// was looking at the wrong element.)
//
// Two fixes, both here: (1) `changed: false` is reported as INCONCLUSIVE, never as a silent pass,
// with a reason that names BOTH causes (unfired mechanism, or a scope that doesn't cover the
// paint); (2) `visibility` is in the snapshot at all, so a visibility-only reveal is visible to
// the probe once scoped correctly. A third fix rides along: a CSS transition mutates no attribute,
// so waitQuiet returned mid-fade and the "end state" opacity landed on a random frame (aloyoga
// read 1, 0.314, 1, 0.315 for four identical panels in one pass) — settleTransition waits it out.
//
// A tiny DOM shim (no deps, no jsdom) is enough to drive probeHover.
let bad = 0; const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

// ── DOM shim ────────────────────────────────────────────────────────────────────────
global.MouseEvent = class { constructor(type) { this.type = type; } };
global.MutationObserver = class { observe() {} disconnect() {} };
const styleOf = (o) => ({ opacity: "1", transform: "none", filter: "none", visibility: "visible", ...o });
global.getComputedStyle = (el) => el.__style || styleOf({});

const mkScope = (descendants, style) => ({
  __style: styleOf(style || {}),
  querySelectorAll: () => ({ length: descendants }),
});
const mkTrigger = (onEvent) => ({ dispatchEvent: (e) => { if (onEvent) onEvent(e); } });

const cap = require("../../tools/behavior-capture.js");

async function main() {
// 1) THE MISS — the probe observed nothing (aloyoga with the default body scope: a pre-mounted
//    panel flips visibility, so the scope's own style and descendant count are both unchanged).
//    It must report INCONCLUSIVE, not a bare changed:false the gate would read as green.
{
  const scope = mkScope(2292, { visibility: "visible" });
  const r = await cap.probeHover(mkTrigger(null), scope, 50);
  check("a hover probe that observed nothing is reported INCONCLUSIVE", r.inconclusive === true);
  check("…and changed is false (it genuinely observed nothing)", r.changed === false);
  check("…and the reason names BOTH causes — unfired mechanism, or a scope that misses the paint",
    typeof r.inconclusiveReason === "string" && /:hover|trusted/.test(r.inconclusiveReason) && /scope/i.test(r.inconclusiveReason));
}

// 2) a hover that DOES fire (JS mounts menu DOM on the synthetic event) → changed, and NOT
//    inconclusive. This is the control that keeps the new flag from painting every hover row
//    inconclusive, which would make the gate unpassable and train everyone to --force past it.
{
  let mounted = 2292;
  const scope = { __style: styleOf({}), querySelectorAll: () => ({ length: mounted }) };
  const trigger = mkTrigger((e) => { if (e.type === "mouseover") mounted = 2400; });
  const r = await cap.probeHover(trigger, scope, 50);
  check("a hover that really fires is changed:true", r.changed === true);
  check("…and is NOT marked inconclusive (no false positive)", !r.inconclusive);
}

// 3) a hover whose reveal is a pure `visibility` flip (no DOM mount, no opacity move) is caught
//    only because visibility is in the snapshot — the other half of the miss.
{
  const scope = { __style: styleOf({ visibility: "hidden" }), querySelectorAll: () => ({ length: 2292 }) };
  const trigger = mkTrigger((e) => { if (e.type === "mouseover") scope.__style = styleOf({ visibility: "visible" }); });
  const r = await cap.probeHover(trigger, scope, 50);
  check("a visibility-only reveal registers as changed", r.changed === true && !r.inconclusive);
}

// 3b) THE TRANSITION TRAP — the reveal carries `opacity .3s`. A CSS transition mutates no
//    attribute, so waitQuiet goes quiet immediately and the "end state" would be sampled MID-FADE
//    (a random frame). The probe must wait the declared duration out and snapshot the SETTLED
//    value — otherwise live and clone each record their own noise and the gate compares nothing.
{
  let opacity = 0;
  const scope = {
    __style: { opacity: "0", transform: "none", filter: "none", visibility: "hidden", transitionDuration: "0.3s", transitionDelay: "0s" },
    querySelectorAll: () => ({ length: 109 }),
  };
  Object.defineProperty(scope.__style, "opacity", { get: () => String(opacity) });
  // the fade completes 300ms after the hover fires
  const trigger = mkTrigger((e) => {
    if (e.type !== "mouseover") return;
    scope.__style.visibility = "visible";
    setTimeout(() => { opacity = 1; }, 300);
  });
  const r = await cap.probeHover(trigger, scope, 2000);
  check("the end state is sampled AFTER the transition settles (opacity 1, not a mid-fade frame)",
    r.after.opacity === 1);
}

// 4) styleSnap records visibility at all, and an open vs closed menu are not the same snapshot.
{
  const open = cap.styleSnap({ __style: styleOf({ visibility: "visible" }) });
  const shut = cap.styleSnap({ __style: styleOf({ visibility: "hidden" }) });
  check("styleSnap records visibility", open.visibility === "visible" && shut.visibility === "hidden");
  check("an open and a closed menu are NOT the same snapshot", !cap.styleSnapEq(open, shut));
}

}

main().then(() => {
  console.log(bad ? `\n❌ ${bad} check(s) failed` : "\n✓ the capture reports an unfirable hover as inconclusive, and records visibility.");
  process.exit(bad ? 1 : 0);
});
