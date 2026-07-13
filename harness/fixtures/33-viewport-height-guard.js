// fixtures/33-viewport-height-guard.js — THE GATE COMPARED TWO PAGES MEASURED IN DIFFERENT VIEWPORTS.
//
// Paid for on chrono24 (2026-07-13). The visual gate has always refused a pair whose viewport
// WIDTHS differ ("x-positions not comparable") — and then compared y-positions across viewports of
// different HEIGHTS without a word.
//
// getBoundingClientRect() is viewport-relative. An in-flow element scrolled to the top reads its
// document y, so height does not matter. But a position:fixed element — a chat bubble, a sticky
// footer bar, a cookie strip — is anchored to the viewport's BOTTOM: its y is `innerHeight - offset`.
// Measure live in a 997px-tall tab and the clone in a 941px-tall one and the gate reports that the
// element "moved" by exactly 56px. It did not move. The KIT moved it (LEARNINGS #23: a measurement
// must be invariant under the instrument's own accidents).
//
// Measured: chrono24's <c24-support-chat> button. Identical markup, identical 5 nodes, identical
// computed styles — and 2 --visual failures (text.top, text.bottom, Δ=56.0) purely because the two
// captures were taken in tabs with different browser chrome.
//
// WHY REFUSE RATHER THAN COMPENSATE: it is tempting to just compare a fixed element's distance from
// the viewport BOTTOM instead. But unequal viewport heights ALSO silently change every vh-based
// layout (a 100vh hero is genuinely a different size), so a pair captured at different heights is
// not comparable in general — patching the one symptom we noticed would leave the rest wrong and
// green. The honest move is to refuse the pair and tell the operator how to fix it: capture live
// and the clone in the SAME tab, where identical browser chrome guarantees identical innerHeight.
"use strict";
let bad = 0;
const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const WF = path.join(ROOT, "harness", "workflow.js");

// A minimal target dir with a live/clone pair that differs ONLY in viewport height.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppk-vh-"));
const dir = path.join(tmp, "targets", "vhtest");
fs.mkdirSync(path.join(dir, "clone"), { recursive: true });

const el = () => ({
  present: true,
  rect: { x: 100, y: 80, w: 180, h: 17, top: 80, right: 280, bottom: 97, fromRight: 200 },
  font: { family: "f", weight: "400", size: 14, line: 18, spacing: "normal", transform: "none",
          color: "rgb(0,0,0)", decoration: "none", smoothing: "antialiased", underline: false },
  box: {}, layout: { display: "block", position: "static" }, parent: { display: "block", gap: 0 },
  text: { x: 100, right: 280, top: 80, bottom: 97, w: 180, h: 17 },
  underline: { present: false }, bg: "rgb(255,255,255)",
});
const snap = (height) => ({ viewport: { width: 1728, height, dpr: 2 }, mode: "CSS1Compat", elements: { t: el() } });

const write = (liveH, cloneH) => {
  fs.writeFileSync(path.join(dir, "target.json"), JSON.stringify({ name: "vhtest", url: "https://x.test/", width: 1728, region: "page" }));
  fs.writeFileSync(path.join(dir, "live.json"), JSON.stringify(snap(liveH)));
  fs.writeFileSync(path.join(dir, "clone.json"), JSON.stringify(snap(cloneH)));
  fs.writeFileSync(path.join(dir, "clone", "index.html"), "<!doctype html><html><body><p>x</p></body></html>");
  // the gate refuses to run at all without a seeded workflow (idempotent — init once, then reuse)
  if (!fs.existsSync(path.join(dir, "workflow.json"))) {
    execFileSync("node", [WF, "init", "vhtest"], { cwd: tmp, stdio: "ignore" });
  }
};
const gate = () => {
  try {
    const out = execFileSync("node", [WF, "gate", "vhtest", "visual"], { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) { return { code: e.status, out: (e.stdout || "") + (e.stderr || "") }; }
};

// ── 1+2. THE DEFECT — identical page, different viewport heights ─────────────────────
// FAILS WITHOUT THE CHANGE: the old gate compared them happily and called it PASS, so a
// viewport-anchored element's invented delta rode through as a real one.
{
  write(997, 941);   // the exact chrono24 numbers
  const r = gate();
  check("the visual gate REFUSES a pair captured at different viewport heights", r.code !== 0);
  check("…and says WHICH heights, so the operator can see the mismatch",
    /997/.test(r.out) && /941/.test(r.out));
  check("…and names the remedy (capture both in the same tab), not just the symptom",
    /same tab/i.test(r.out));
}

// ── 3. CONTROL — equal heights: the gate must still do its job, not refuse ───────────
{
  write(997, 997);
  const r = gate();
  check("CONTROL: equal viewport heights → the gate compares normally (no invented refusal)", r.code === 0);
}

// ── 4. CONTROL — an OLD capture with no height field must not be refused ─────────────
// Snapshots predate this field; a missing height is "unknown", not "mismatched". Refusing them
// would break every target captured before today for no reason.
{
  write(997, 997);
  const live = JSON.parse(fs.readFileSync(path.join(dir, "live.json"), "utf8"));
  delete live.viewport.height;                       // an older snapshot schema
  fs.writeFileSync(path.join(dir, "live.json"), JSON.stringify(live));
  const r = gate();
  check("CONTROL: a snapshot with no viewport.height (older schema) is compared, not refused", r.code === 0);
}

// ── 5. CONTROL — the WIDTH guard still fires (it must not be displaced) ──────────────
{
  write(997, 997);
  const clone = JSON.parse(fs.readFileSync(path.join(dir, "clone.json"), "utf8"));
  clone.viewport.width = 1440;
  fs.writeFileSync(path.join(dir, "clone.json"), JSON.stringify(clone));
  const r = gate();
  check("CONTROL: the pre-existing WIDTH guard still refuses a width mismatch",
    r.code !== 0 && /width/i.test(r.out));
}

// ── 6. THE DEFECT, ONE LAYER DOWN — the TOOL must refuse it, not just the gate ────────
// Paid for a second time on dtf (2026-07-13), which is what makes this class n=2. chrono24
// guarded the GATE (workflow.js). But RUNBOOK Step 4 tells the operator to run pixel-diff.js
// BY HAND, and that tool read viewport.width only — so the hand path still compared a
// height-mismatched pair and returned 231 phantom failures on a clone with nothing wrong with
// it, naming no cause. A guard that lives only in the gate is a guard the operator walks around.
//
// dtf also shows WHY this is not an exotic accident: the automation extension's permission
// infobar renders on the LIVE origin but not on localhost, so the live tab and the
// clone tab differ in innerHeight BY DEFAULT on every capture. Any vh/dvh-sized hero hits it.
const PXD = path.join(ROOT, "tools", "pixel-diff.js");
const diff = () => {
  try {
    execFileSync("node", [PXD, "--visual", "live.json", "clone.json"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out: "" };
  } catch (e) { return { code: e.status, out: (e.stdout || "") + (e.stderr || "") }; }
};
{
  write(997, 941);
  const r = diff();
  // exit 2 = BAD INPUT, deliberately not 1 = diff failure: nothing is wrong with the clone,
  // the pair is unusable. A 1 here would send the operator hunting a bug that does not exist.
  check("pixel-diff REFUSES a height-mismatched pair as bad input (exit 2, not a diff failure)", r.code === 2);
  check("…and names both heights and the remedy", /997/.test(r.out) && /941/.test(r.out) && /same tab/i.test(r.out));
}
{
  write(997, 997);
  check("CONTROL: pixel-diff compares an equal-viewport pair normally (no invented friction)", diff().code === 0);
}
{
  write(997, 997);
  const live = JSON.parse(fs.readFileSync(path.join(dir, "live.json"), "utf8"));
  delete live.viewport.height;
  fs.writeFileSync(path.join(dir, "live.json"), JSON.stringify(live));
  check("CONTROL: pixel-diff compares an older no-height snapshot, not refuses it", diff().code === 0);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad ? `\n✗ ${bad} check(s) failed` : "\n✓ 33-viewport-height-guard: y-positions are only compared across equal viewports — in the gate AND in the tool.");
process.exit(bad ? 1 : 0);
