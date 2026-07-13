// fixtures/28-frozen-reveal-display-none.js — clone-lint called faithfully-hidden content a
// frozen reveal.
//
// Paid for on gorjana (2026-07-13), at region: page where frozen-reveal is BLOCKING. The page
// ships a mobile app-download banner to desktop as `display:none; visibility:hidden; opacity:0`
// — invisible on LIVE, with full JS, at the captured viewport. The capture recorded it
// faithfully; the clone renders exactly what live renders (nothing). clone-lint's frozen-reveal
// rule greps inline `opacity: 0` and flagged it as "invisible without JS — re-capture after
// pxScrollSettle()" — but no amount of scrolling reveals an element live never shows, so the
// operator's only moves were to "fix" a non-defect or --force a lying FAIL. Instrument-invents-
// friction, the #23 class, in clone-lint.
//
// The distinction is mechanical, not judgment: a scroll-reveal frozen at its start state is an
// element WAITING to animate — and a CSS transition can never fire on display:none. An inline
// style that sets BOTH opacity:0 AND display:none is suppression, not a reveal mid-flight.
// visibility:hidden alone must STAY flagged: visibility does transition, and pre-mounted hover
// menus hide exactly that way (LEARNINGS #22) — that's what the controls below hold.
"use strict";
const cp = require("child_process"), fs = require("fs"), os = require("os"), path = require("path");
let bad = 0; const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

const KIT = path.join(__dirname, "..", "..");
const LINT = path.join(KIT, "tools", "clone-lint.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppk-fix28-"));

function lint(tag, body) {
  const dir = path.join(tmp, tag, "clone");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "index.html");
  fs.writeFileSync(f, `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`);
  const r = cp.spawnSync(process.execPath, [LINT, f], { encoding: "utf8", timeout: 30000 });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

// 1) THE FALSE POSITIVE — display:none + opacity:0 in one inline style is suppression live
//    itself ships (gorjana's app banner); it must not fail as a frozen reveal.
{
  const r = lint("suppressed", `<div id="app-banner" style="display: none; visibility: hidden; opacity: 0;">Download our app</div><p>real content</p>`);
  check("display:none + opacity:0 (live-suppressed content) → not a frozen reveal, exit 0",
    r.status === 0 && !/frozen-reveal/.test(r.out));
}

// 2) CONTROL — a REAL frozen reveal (opacity:0 + transition, no display:none) must still FAIL.
//    This is the aloyoga defect the rule exists for; the fix must not blind it.
{
  const r = lint("real-reveal", `<section style="opacity: 0; transition: opacity 0.6s;">This content reveals on scroll</section>`);
  check("CONTROL: opacity:0 + transition (a real frozen reveal) → still FAIL",
    r.status === 1 && /frozen-reveal/.test(r.out));
}

// 3) CONTROL — bare opacity:0 without display:none still fails too (the rule's original scope).
{
  const r = lint("bare", `<div style="opacity: 0;">hidden text</div>`);
  check("CONTROL: bare opacity:0 → still FAIL", r.status === 1 && /frozen-reveal/.test(r.out));
}

// 4) CONTROL — visibility:hidden + opacity:0 (NO display:none) stays flagged: visibility CAN
//    transition, and hover menus pre-mount exactly this way (#22). Only display:none exempts.
{
  const r = lint("vis-hidden", `<nav style="visibility: hidden; opacity: 0;">menu panel</nav>`);
  check("CONTROL: visibility:hidden + opacity:0 (no display:none) → still FAIL",
    r.status === 1 && /frozen-reveal/.test(r.out));
}

// 5) display:none written AFTER opacity in the style attribute exempts the same way — the rule
//    keys on the style's content, not the property order.
{
  const r = lint("order", `<div style="opacity: 0; display: none;">also suppressed</div>`);
  check("property order does not matter (opacity first, display:none after) → exit 0",
    r.status === 0 && !/frozen-reveal/.test(r.out));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad ? `\n❌ 28-frozen-reveal-display-none: ${bad} check(s) failed.` : "\n✓ 28-frozen-reveal-display-none: display:none suppression is not a frozen reveal; real reveals (transition, bare opacity:0, visibility:hidden) all still fail.");
process.exit(bad ? 1 : 0);
