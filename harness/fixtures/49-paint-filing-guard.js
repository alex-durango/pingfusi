// fixtures/49-paint-filing-guard.js — NEVER BURN A REVIEWER ROUND ON A BLACK PAGE.
//
// The BLACK-PAGE GREEN miss (bizar.ro, LEARNINGS #37): every gate passed, the published
// draft rendered solid black, and the filed round's one answer was "cannot see any
// draft" — a whole review round spent confirming what the kit could have known from one
// screenshot. capture-run's paint probe now receipts that knowledge (capture-run.json →
// paint.warning), and `review-qa.js file` REFUSES to file while the receipt stands.
// This fixture fails without that guard and pins:
//   • the refusal: clear message, exit 1, nothing filed, nothing recorded
//   • it covers diagnostic rounds too (a reviewer who sees nothing describes nothing)
//   • --anyway overrides WITH a receipt (paint_override lands on the round record)
//   • CONTROLS: a clean receipt files normally; a missing capture-run.json (adopted /
//     interactive builds) is nothing to guard on — the guard must never invent a verdict
"use strict";
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
let bad = 0; const check = (n, c, d) => { console.log(`${c ? "✓" : "✗"} ${n}${c || !d ? "" : ` — ${d}`}`); if (!c) bad++; };

const HQ = path.join(__dirname, "..", "review-qa.js");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-paintguard-"));
const MOCK = path.join(WORK, "mock");
const NAME = "pg";
const dir = path.join(WORK, "targets", NAME);
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(MOCK, { recursive: true });
fs.writeFileSync(path.join(dir, "target.json"), JSON.stringify({ name: NAME, url: "https://example.com/", width: 1440 }));
fs.writeFileSync(path.join(dir, "coverage.json"), JSON.stringify(["logo"]));
fs.writeFileSync(path.join(MOCK, "request_review.json"), JSON.stringify({ ping_id: "0f0f0f0f-0000-4000-8000-00000000paint".slice(0, 36), status: "pending" }));

const run = (args) => {
  const r = cp.spawnSync(process.execPath, [HQ, ...args], {
    encoding: "utf8", cwd: WORK,
    env: { ...process.env, PPK_PINGHUMANS_URL: "file://" + MOCK, PPK_PINGHUMANS_TOKEN: "" },
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
};
const hq = () => JSON.parse(fs.readFileSync(path.join(dir, "review-qa.json"), "utf8"));

// the receipt capture-run writes when the clone is near-blank under a rich live page
const BLANK_RECEIPT = {
  kitVersion: "0.0.0-fixture", at: new Date().toISOString(), viewport: { width: 1440, height: 982, dpr: 2 },
  sides: [
    { side: "clone", paint: { stat: { nonUniformRatio: 0.0006, nearBlank: true } } },
    { side: "live", paint: { stat: { nonUniformRatio: 0.31, nearBlank: false } }, canvas: { schema: "pingfusi/canvas-dominant@1", dominant: true, bestCoverage: 0.97, marksInFront: 2 } },
  ],
  paint: { warning: "the clone paints almost nothing (nonUniformRatio 0.0006 vs live 0.31) — the DOM skeleton can match while the pixels never arrive; do not file a review round on this draft. The live page's visible painting is script-driven canvas (97% of the viewport, 2 painted DOM mark(s) in front) — a static DOM clone CANNOT reproduce it." },
};

// ── 1. the refusal ────────────────────────────────────────────────────────────
fs.writeFileSync(path.join(dir, "capture-run.json"), JSON.stringify(BLANK_RECEIPT, null, 2));
{
  const r = run(["file", NAME, "--draft", "https://pg-draft.example.com/"]);
  check("file REFUSES while the paint receipt says the clone is near-blank", r.code === 1 && /refusing to file/.test(r.out) && /paints almost nothing/.test(r.out), r.out.slice(0, 300));
  check("  …the refusal is actionable: re-run capture-run + the --anyway escape are both named", /capture-run pg/.test(r.out) && /--anyway/.test(r.out));
  check("  …nothing was filed or recorded", !fs.existsSync(path.join(dir, "review-qa.json")));
}
// diagnostic rounds burn a reviewer exactly the same way
{
  const r = run(["file", NAME, "--diagnostic", "--region", "the header", "--draft", "https://pg-draft.example.com/"]);
  check("the guard covers --diagnostic too (a reviewer who sees nothing describes nothing)", r.code === 1 && /refusing to file/.test(r.out));
}

// ── 2. --anyway overrides WITH a receipt ──────────────────────────────────────
{
  const r = run(["file", NAME, "--draft", "https://pg-draft.example.com/", "--anyway"]);
  check("--anyway files the round with a printed warning", r.code === 0 && /filing over the paint probe/.test(r.out), r.out.slice(0, 300));
  const round = hq().rounds[0];
  check("  …and the override is RECEIPTED on the round (paint_override: warning + timestamp)",
    !!round.paint_override && /paints almost nothing/.test(round.paint_override.warning) && !!round.paint_override.at);
}
{
  const r = run(["file", NAME, "--diagnostic", "--region", "the header", "--draft", "https://pg-draft.example.com/", "--anyway"]);
  check("--anyway on a diagnostic receipts the override on the diagnostic record", r.code === 0 && !!hq().diagnostics[0].paint_override);
}

// ── 3. CONTROLS — the guard never fires without its receipt ──────────────────
{
  const clean = { ...BLANK_RECEIPT };
  delete clean.paint;
  clean.sides = [
    { side: "clone", paint: { stat: { nonUniformRatio: 0.29, nearBlank: false } } },
    { side: "live", paint: { stat: { nonUniformRatio: 0.31, nearBlank: false } } },
  ];
  fs.writeFileSync(path.join(dir, "capture-run.json"), JSON.stringify(clean, null, 2));
  const r = run(["file", NAME, "--draft", "https://pg-draft.example.com/"]);
  check("CONTROL — a receipt without a paint warning files normally", r.code === 0 && !/refusing to file/.test(r.out), r.out.slice(0, 300));
  check("  …and records no paint_override", !hq().rounds[hq().rounds.length - 1].paint_override);
}
{
  fs.rmSync(path.join(dir, "capture-run.json"));
  const r = run(["file", NAME, "--draft", "https://pg-draft.example.com/"]);
  check("CONTROL — no capture-run.json (adopted/interactive build) is nothing to guard on", r.code === 0 && !/refusing to file/.test(r.out));
}

fs.rmSync(WORK, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
