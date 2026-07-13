// harness/score.js <name> — score targets/<name>/{live,clone}.json and compare to the
// previous run, so "is this iteration better?" is a number, not a vibe.
//
// Emits a scorecard, appends it to targets/<name>/scores.jsonl, and prints the delta
// vs the last recorded run (visual fails ↓ = better). Also lists the current failing
// --visual rows (the fix list) and the strict structural count (document or fix).
const fs = require("fs"), path = require("path");
const { diffSnapshots } = require("../tools/pixel-diff.js");

const name = process.argv[2];
if (!name) { console.error("usage: pingfusi score <target-name>"); process.exit(1); }
// targets/ live in the user's current directory (WORK), not inside the installed kit.
const dir = path.join(process.cwd(), "targets", name);
const readJson = (f) => {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) { console.error(`missing ${name}/${f} — capture it first (RUNBOOK)`); process.exit(1); }
  const txt = fs.readFileSync(p, "utf8");
  if (/^\s*\[BLOCKED/.test(txt)) { console.error(`${name}/${f} holds a "[BLOCKED…]" automation sentinel, not a snapshot — re-capture via the sink/stash path (RUNBOOK).`); process.exit(1); }
  try { return JSON.parse(txt); } catch (e) { console.error(`${name}/${f} is not valid JSON: ${e.message}. Re-capture it (a truncated/partial paste is the usual cause).`); process.exit(1); }
};

const live = readJson("live.json"), clone = readJson("clone.json");
const v = diffSnapshots(live, clone, { visual: true });
const s = diffSnapshots(live, clone, {});
const targets = Object.keys(live.elements || {}).length;

const widthMismatch = live.viewport && clone.viewport && live.viewport.width !== clone.viewport.width;
// A viewport-anchored (position:fixed) element's y is `innerHeight - offset`, so two captures taken
// in tabs of different heights disagree about where it is — a delta the kit invents on a page where
// nothing moved (chrono24: 997 vs 941, the chat button "moved" 56px). Surfaced here for the same
// reason as the width mismatch: the number below is not trustworthy until both are re-captured.
const heightMismatch = live.viewport && clone.viewport && live.viewport.height && clone.viewport.height &&
  live.viewport.height !== clone.viewport.height;
const score = {
  ts: new Date().toISOString(),
  targets,
  visualComparisons: v.summary.comparisons, visualFails: v.summary.failures, visualOk: v.ok,
  strictComparisons: s.summary.comparisons, strictFails: s.summary.failures,
  widthMismatch: !!widthMismatch,
  heightMismatch: !!heightMismatch,
};

// previous run (last non-empty line of scores.jsonl)
const logPath = path.join(dir, "scores.jsonl");
const prevLines = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean) : [];
const prev = prevLines.length ? JSON.parse(prevLines[prevLines.length - 1]) : null;

const arrow = (cur, was) => was == null ? "" : cur < was ? `  ↓ ${was}→${cur}  better` : cur > was ? `  ↑ ${was}→${cur}  WORSE` : `  = ${cur}  same`;

console.log(`\nscorecard — ${name}  (${targets} targets, width ${clone.viewport && clone.viewport.width})`);
if (widthMismatch) console.log(`⚠  viewport widths differ (${live.viewport.width} vs ${clone.viewport.width}) — x-positions not comparable. Re-measure both at the same width.`);
if (heightMismatch) console.log(`⚠  viewport heights differ (${live.viewport.height} vs ${clone.viewport.height}) — y-positions of viewport-anchored (position:fixed) elements are not comparable; the gate will report deltas nothing moved. Capture live and the clone in the SAME tab, then re-capture both.`);
console.log(`  --visual   ${v.ok ? "PASS" : "FAIL"}   fails ${score.visualFails}/${score.visualComparisons}${arrow(score.visualFails, prev && prev.visualFails)}`);
console.log(`  strict     fails ${score.strictFails}/${score.strictComparisons}${arrow(score.strictFails, prev && prev.strictFails)}   (structural → fix or document)`);

// the fix list — current --visual failures
const vFails = v.rows.filter((r) => !r.pass);
if (vFails.length) {
  console.log(`\n  --visual fix list:`);
  for (const r of vFails) console.log(`    ${r.target.padEnd(14)} ${String(r.prop).padEnd(20)} live=${r.live}  clone=${r.clone}  Δ=${r.delta}`);
}

fs.appendFileSync(logPath, JSON.stringify(score) + "\n");
console.log(`\nrecorded to targets/${name}/scores.jsonl  (${prevLines.length + 1} runs)`);
if (v.ok) console.log(`✓ --visual green. Next: close coverage (every painted leaf has a target), then read the strict table for colour/underline rows.`);
process.exit(v.ok ? 0 : 1);
