#!/usr/bin/env node
// promote-learning.js — the guard against OVER-LEARNING. A miss surfaced on one target
// is a *candidate*, not yet a LEARNINGS.md entry. This refuses to promote a candidate to
// an enforced 🔒 lesson unless it has earned its place across ALL of these, so tuning the
// gate for one site can't silently regress another (see docs/DEVELOP.md → miss protocol,
// and the over-learning discipline in .claude/commands/develop-loop.md):
//
//   1. CONTROL REQUIRED  — the battery has ≥1 DEFECT *and* ≥1 CONTROL case for the class.
//      A defect with no control is how an overfit rule sneaks in; the control is the
//      false-positive hunter that proves the rule is scoped, not greedy.
//   2. FIXTURE LOCKED     — harness/fixtures/<file> exists (fails without the tool change).
//   3. CLEAN A/B          — detection-power.js --vs HEAD shows +N gained, 0 regressions
//      (0 missed defects, 0 NEW false positives). The battery, not the target, justifies it.
//   4. GENERALISES        — seen on ≥2 distinct targets, OR explicitly declared narrow with
//      a written justification (narrow-by-construction). Never enshrine from n=1 wide.
//
// A REFUSE is a real result, not a failure — it means "keep this a 👁 candidate and let a
// second site corroborate it." Candidates live in targets/<name>/candidate-misses.jsonl:
//   {"class":"slug","seen_on":["siteA"],"battery_defects":["case"],"battery_controls":["case"],
//    "fixture":"NN-slug.js","narrow":false,"narrow_justification":"","note":"..."}
//
// Usage:  node harness/promote-learning.js <class-slug>
//         node harness/promote-learning.js --list        (show all pending candidates)

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TARGETS = path.join(ROOT, "targets");
const FIXTURES = path.join(ROOT, "harness", "fixtures");

function readCandidates() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(TARGETS, { withFileTypes: true }).filter((d) => d.isDirectory()); }
  catch { return out; } // targets/ is git-ignored and may not exist — no candidates yet
  for (const d of dirs) {
    const f = path.join(TARGETS, d.name, "candidate-misses.jsonl");
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try { out.push({ ...JSON.parse(s), _target: d.name }); }
      catch { console.error(`⚠ skipping unparseable candidate in ${f}: ${s.slice(0, 80)}`); }
    }
  }
  return out;
}

const arg = process.argv[2];

if (arg === "--list" || !arg) {
  const cands = readCandidates();
  if (!cands.length) { console.log("no pending candidates (targets/*/candidate-misses.jsonl empty or absent)"); process.exit(0); }
  const byClass = new Map();
  for (const c of cands) {
    if (!byClass.has(c.class)) byClass.set(c.class, new Set());
    byClass.get(c.class).add(c._target);
  }
  console.log("pending learning candidates:\n");
  for (const [cls, targets] of byClass) console.log(`  ${cls}   (seen on: ${[...targets].join(", ")})`);
  console.log(`\npromote one with:  node harness/promote-learning.js <class-slug>`);
  process.exit(arg ? 0 : 2); // no-arg is a usage nudge → nonzero
}

const cls = arg;
const matches = readCandidates().filter((c) => c.class === cls);
if (!matches.length) {
  console.error(`✗ no candidate with class "${cls}". Run --list to see pending candidates.`);
  process.exit(2);
}

// union the declarations across every target that reported this class
const seenOn = [...new Set(matches.map((c) => c._target))];
const defects = [...new Set(matches.flatMap((c) => c.battery_defects || []))];
const controls = [...new Set(matches.flatMap((c) => c.battery_controls || []))];
const fixture = matches.map((c) => c.fixture).find(Boolean);
const narrow = matches.some((c) => c.narrow === true);
const narrowWhy = matches.map((c) => c.narrow_justification).find(Boolean) || "";

let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fail++;
};

console.log(`\nPromotion check for class "${cls}" (seen on: ${seenOn.join(", ")})\n`);

// 1. CONTROL REQUIRED — battery has ≥1 defect and ≥1 control for this class
let battery = [];
try { battery = require("./benchmarks/battery.js").battery; }
catch (e) { console.error(`✗ cannot load battery.js: ${e.message}`); process.exit(2); }
const byName = new Map(battery.map((row) => [row[0], row[1]])); // name → kind
const haveDefect = defects.filter((n) => byName.get(n) === "defect");
const haveControl = controls.filter((n) => byName.get(n) === "control");
check("battery has a DEFECT case for this class", haveDefect.length >= 1,
  defects.length ? `declared: ${defects.join(", ")}` : "none declared in candidate");
check("battery has a CONTROL case (false-positive hunter)", haveControl.length >= 1,
  controls.length ? `declared: ${controls.join(", ")}` : "none declared — an unscoped rule risks over-learning");

// 2. FIXTURE LOCKED
check("fixture exists (fails without the tool change)",
  !!fixture && fs.existsSync(path.join(FIXTURES, fixture)),
  fixture ? `harness/fixtures/${fixture}` : "no fixture declared in candidate");

// 3. GENERALISES — ≥2 targets, or narrow-by-construction with a written reason
check("generalises (≥2 targets) or narrow-by-construction",
  seenOn.length >= 2 || (narrow && narrowWhy.length > 0),
  seenOn.length >= 2 ? `${seenOn.length} targets`
    : narrow ? (narrowWhy ? `narrow: ${narrowWhy}` : "narrow declared but no justification")
    : "only 1 target and not declared narrow — let a second site corroborate first");

// 4. CLEAN A/B — the battery, not the target, justifies the gate change
console.log("\nrunning detection-power A/B vs HEAD …\n");
let abClean = false, abOut = "";
try {
  abOut = execFileSync("node", ["harness/benchmarks/detection-power.js", "--vs", "HEAD"],
    { cwd: ROOT, encoding: "utf8" });
  abClean = true; // exit 0 ⇒ 0 regressions
} catch (e) {
  abOut = (e.stdout || "") + (e.stderr || "");
  abClean = false; // nonzero ⇒ a missed defect or a new false positive
}
process.stdout.write(abOut);
const gained = (abOut.match(/\+(\d+) defect class/) || [])[1];
check("A/B is +N gained, 0 regressions", abClean && Number(gained) > 0,
  abClean ? `gained ${gained || 0}` : "detection-power reported a regression (missed defect or new FALSE+)");

console.log("\n" + "─".repeat(60));
if (fail) {
  console.log(`REFUSE — ${fail} check(s) failed. Keep "${cls}" a 👁 candidate; do NOT add it to`);
  console.log(`docs/LEARNINGS.md yet. Record the refusal reason so it isn't re-proposed blindly.`);
  process.exit(1);
}
console.log(`PROMOTE OK — "${cls}" has earned a 🔒 LEARNINGS.md entry. Append it as the next`);
console.log(`## N. entry (house style: story + **Lesson:** + 🔒), then clear the candidate line(s).`);
process.exit(0);
