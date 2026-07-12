// detection-power.js — score the gate's detection power against the fixed battery.
//
// This is the kit's SCIENTIFIC instrument for gate changes: "did this change catch more
// defects without inventing false positives?" as a number, not a vibe. Two modes:
//
//   node harness/benchmarks/detection-power.js
//       ABSOLUTE (CI guard): score the CURRENT gate. Exit 0 only if every DEFECT is
//       caught and NO control is flagged. Wired into harness/regression.js.
//
//   node harness/benchmarks/detection-power.js --vs HEAD
//   node harness/benchmarks/detection-power.js --vs <path/to/old/pixel-diff.js>
//       A/B: compare a BASELINE gate (a git ref's tools/pixel-diff.js, or a file) to the
//       current working-tree gate, case by case. Use this BEFORE adopting a gate change —
//       it isolates exactly what the change adds (caught) or breaks (false positive). A
//       single-variable diff (one new row of ← DIFFERENCE, zero new FALSE+) is the bar.
//
// Zero deps, deterministic, no DOM. Extend the corpus in battery.js.

const path = require("path");
const { scoreGate } = require("./battery.js");
const { scoreCorpus } = require("./corpus.js");
const NEW = require("../../tools/pixel-diff.js");

const args = process.argv.slice(2);
const vsIdx = args.indexOf("--vs");
const pad = (s, n) => String(s).padEnd(n);

// Score BOTH the synthetic battery and the frozen real-site corpus, summed into one
// scorecard. A gate change must satisfy both — synthetic keeps it fast/deterministic,
// the corpus keeps it honest against real captures.
const scoreAll = (fn) => {
  const b = scoreGate(fn), c = scoreCorpus(fn);
  return {
    rows: b.rows.concat(c.rows),
    caught: b.caught + c.caught, defects: b.defects + c.defects,
    falsePos: b.falsePos + c.falsePos, controls: b.controls + c.controls,
    realCases: c.rows.length,
  };
};

if (vsIdx === -1) {
  // ── ABSOLUTE mode ── current gate must catch all defects and flag no controls.
  const r = scoreAll(NEW.diffSnapshots);
  if (r.realCases) console.log(`(including ${r.realCases} real-site corpus case(s))\n`);
  console.log(pad("case", 24) + pad("kind", 9) + "result");
  console.log("─".repeat(52));
  for (const row of r.rows)
    console.log(pad(row.name, 24) + pad(row.kind, 9) +
      (row.correct ? (row.kind === "defect" ? "caught ✓" : "pass ✓") : (row.kind === "defect" ? "MISS ✗" : "FALSE+ ✗")));
  console.log("─".repeat(52));
  console.log(`defects caught:  ${r.caught}/${r.defects}`);
  console.log(`false positives: ${r.falsePos}/${r.controls}`);
  const ok = r.caught === r.defects && r.falsePos === 0;
  console.log(ok
    ? `\n✓ detection-power: all ${r.defects} defect classes caught, 0 false positives.`
    : `\n❌ detection-power: ${r.defects - r.caught} missed, ${r.falsePos} false positive(s).`);
  process.exit(ok ? 0 : 1);
}

// ── A/B mode ── load a baseline gate and compare it to the current one.
const ref = args[vsIdx + 1];
if (!ref) { console.error("usage: --vs <git-ref | path/to/pixel-diff.js>"); process.exit(2); }
let baselinePath = ref;
if (!ref.includes("/") && !ref.endsWith(".js")) {
  // treat as a git ref → materialise its tools/pixel-diff.js to a temp file we can require
  const { execFileSync } = require("child_process");
  const os = require("os"), fs = require("fs");
  const src = execFileSync("git", ["show", `${ref}:tools/pixel-diff.js`], { cwd: path.resolve(__dirname, "..", "..") });
  baselinePath = path.join(os.tmpdir(), `pixel-diff.${ref.replace(/[^a-z0-9]/gi, "_")}.js`);
  fs.writeFileSync(baselinePath, src);
}
const OLD = require(path.resolve(baselinePath));
const a = scoreAll(OLD.diffSnapshots), b = scoreAll(NEW.diffSnapshots);
if (b.realCases) console.log(`(including ${b.realCases} real-site corpus case(s))\n`);

console.log(pad("case", 24) + pad("kind", 9) + pad(`OLD (${ref})`, 16) + pad("NEW (worktree)", 16) + "note");
console.log("─".repeat(92));
let gained = 0, broke = 0;
for (let i = 0; i < a.rows.length; i++) {
  const ra = a.rows[i], rb = b.rows[i];
  const mark = (row) => row.kind === "defect" ? (row.pass ? "MISS" : "caught") : (row.pass ? "pass" : "FALSE+");
  let flag = "";
  if (ra.kind === "defect" && !ra.pass !== !rb.pass) { flag = rb.correct ? "  ← GAINED" : "  ← LOST"; rb.correct ? gained++ : broke++; }
  if (ra.kind === "control" && ra.pass && !rb.pass) { flag = "  ← NEW FALSE+"; broke++; }
  console.log(pad(ra.name, 24) + pad(ra.kind, 9) + pad(mark(ra), 16) + pad(mark(rb), 16) + ra.note + flag);
}
console.log("─".repeat(92));
console.log(`defects caught:   OLD ${a.caught}/${a.defects}   NEW ${b.caught}/${b.defects}`);
console.log(`false positives:  OLD ${a.falsePos}/${a.controls}   NEW ${b.falsePos}/${b.controls}`);
console.log(`\nverdict: +${gained} defect class(es) gained, ${broke} regression(s) (missed defect or new false positive).`);
process.exit(broke ? 1 : 0);
