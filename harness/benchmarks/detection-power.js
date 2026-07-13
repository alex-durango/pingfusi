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
const { scoreBehaviorGate } = require("./behavior-battery.js");
const { scoreCaptureGate, loadMeasure } = require("./capture-battery.js");
const { scoreArtifactGate } = require("./artifact-battery.js");
const NEW = require("../../tools/pixel-diff.js");
const NEW_BEHAVIOR = require("../workflow.js");
const NEW_LINT = require("../../tools/clone-lint.js");
const CAPTURE_SRC = path.resolve(__dirname, "..", "..", "tools", "browser-capture.js");

const args = process.argv.slice(2);
const vsIdx = args.indexOf("--vs");
const pad = (s, n) => String(s).padEnd(n);

// Score the synthetic battery, the frozen real-site corpus, AND the behavior battery, summed
// into one scorecard. A gate change must satisfy all three — synthetic keeps it fast and
// deterministic, the corpus keeps it honest against real captures, and the behavior battery
// covers the JS-driven half of the gate (which otherwise had no instrument, so a behavior miss
// could never show a +N/0 A/B and could never be promoted).
// …and the CAPTURE battery. A whole class of miss lives one layer before the diff: the
// comparison is fine, the NUMBER THAT GOT RECORDED is wrong. Nothing here ever called
// `measure()`, so a capture-level fix scored +0 forever and could never be promoted (found
// fixing the prevGap false positive). `captureSrc` is a path so the A/B can score the
// BASELINE's capture, not the current one on both sides.
// …and the ARTIFACT + READINESS batteries. Two layers sit BEFORE every instrument above: whether
// the capture recorded the right page at all (pxScrollSettle), and whether the built clone is
// whole (clone-lint). Nothing scored them, so five correct fixes in one session scored +0 and were
// refused — the scorer, not the fixes, was the defect (#23, applied to the kit's own ruler).
// `lintSrc` is a path for the same reason `captureSrc` is: the A/B must score the BASELINE's own
// clone-lint, or a lint fix reads as a no-op on both sides.
const scoreAll = (fn, compareMeasured, captureSrc, lintHtml) => {
  const b = scoreGate(fn), c = scoreCorpus(fn), h = scoreBehaviorGate(compareMeasured);
  let p = { rows: [], caught: 0, defects: 0, falsePos: 0, controls: 0 };
  try {
    const { measure, restore } = loadMeasure(captureSrc || CAPTURE_SRC);
    try { p = scoreCaptureGate(measure, fn); } finally { restore(); }
  } catch (e) {
    // a baseline that predates browser-capture's pxMeasure shape can't be scored — say so
    // rather than silently scoring the CURRENT capture on both sides (that would invent a gain).
    console.error(`(could not load the capture at ${captureSrc || CAPTURE_SRC} — capture half omitted: ${e.message})`);
  }
  let a = { rows: [], caught: 0, defects: 0, falsePos: 0, controls: 0 };
  try {
    a = scoreArtifactGate(lintHtml || NEW_LINT.lintHtml, captureSrc || CAPTURE_SRC);
  } catch (e) {
    console.error(`(could not score the artifact/readiness battery — half omitted: ${e.message})`);
  }
  return {
    rows: b.rows.concat(c.rows).concat(h.rows).concat(p.rows).concat(a.rows),
    caught: b.caught + c.caught + h.caught + p.caught + a.caught,
    defects: b.defects + c.defects + h.defects + p.defects + a.defects,
    falsePos: b.falsePos + c.falsePos + h.falsePos + p.falsePos + a.falsePos,
    controls: b.controls + c.controls + h.controls + p.controls + a.controls,
    realCases: c.rows.length,
  };
};

if (vsIdx === -1) {
  // ── ABSOLUTE mode ── current gate must catch all defects and flag no controls.
  const r = scoreAll(NEW.diffSnapshots, NEW_BEHAVIOR.compareMeasured, CAPTURE_SRC, NEW_LINT.lintHtml);
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
let baselineBehavior = NEW_BEHAVIOR.compareMeasured;
let baselineCapture = CAPTURE_SRC;
let baselineLint = NEW_LINT.lintHtml;
// A ref is a PATH only if it actually exists on disk. The old test (`!ref.includes("/")`) meant
// any branch-qualified ref — `origin/main`, `feat/x` — was silently treated as a file path and
// blew up with MODULE_NOT_FOUND, so you could only ever A/B against a bare ref like HEAD.
const fsx = require("fs");
const looksLikePath = ref.endsWith(".js") || fsx.existsSync(ref);
if (!looksLikePath) {
  // treat as a git ref → materialise its tools/pixel-diff.js to a temp file we can require
  const { execFileSync } = require("child_process");
  const os = require("os"), fs = require("fs");
  const root = path.resolve(__dirname, "..", "..");
  const src = execFileSync("git", ["show", `${ref}:tools/pixel-diff.js`], { cwd: root });
  baselinePath = path.join(os.tmpdir(), `pixel-diff.${ref.replace(/[^a-z0-9]/gi, "_")}.js`);
  fs.writeFileSync(baselinePath, src);
  // …and its tools/browser-capture.js, so the CAPTURE half of the scorecard is the baseline's
  // too. Same reasoning as the behavior half: scoring the CURRENT capture on both sides would
  // report a capture fix as a no-op (the phantom it removes would never appear on either side),
  // which is exactly why a capture-level improvement used to be unscorable.
  try {
    const csrc = execFileSync("git", ["show", `${ref}:tools/browser-capture.js`], { cwd: root });
    baselineCapture = path.join(os.tmpdir(), `browser-capture.${ref.replace(/[^a-z0-9]/gi, "_")}.js`);
    fs.writeFileSync(baselineCapture, csrc);
  } catch (e) {
    console.error(`(could not materialise ${ref}:tools/browser-capture.js — capture half scores the CURRENT capture on both sides: ${e.message})`);
  }
  // …and its harness/workflow.js, so the BEHAVIOR half of the scorecard is the baseline's too.
  // Without this the A/B would score the old visual gate against the NEW behavior gate and
  // report a behavior gain as though it had always been there.
  try {
    // A baseline from before compareMeasured was exported still HAS the function — it just
    // didn't expose it. Append an export to the materialised copy so the A/B scores the
    // baseline's REAL behavior gate. Scoring it as "catches nothing" instead would inflate the
    // verdict: the old gate genuinely did catch e.g. a frozen hover-mount, and a promotion must
    // not take credit for detection that already existed.
    const wsrc = execFileSync("git", ["show", `${ref}:harness/workflow.js`], { cwd: root }).toString() +
      "\ntry { module.exports.compareMeasured = module.exports.compareMeasured || compareMeasured; } catch (e) {}\n";
    // it must live inside harness/ so its relative requires (../tools/pixel-diff.js) resolve
    const wpath = path.join(root, "harness", `.baseline-workflow.${ref.replace(/[^a-z0-9]/gi, "_")}.tmp.js`);
    fs.writeFileSync(wpath, wsrc);
    try {
      const oldWf = require(wpath);
      if (typeof oldWf.compareMeasured === "function") baselineBehavior = oldWf.compareMeasured;
    } finally { fs.unlinkSync(wpath); }
  } catch (e) {
    console.error(`(could not load ${ref}:harness/workflow.js — behavior half of the A/B scores the CURRENT gate on both sides: ${e.message})`);
  }
  // …and its tools/clone-lint.js, so the ARTIFACT half scores the BASELINE's own conscience.
  // Scoring the CURRENT lint on both sides would report a lint fix (a rule that now catches an
  // empty framework mount, or stops false-positiving on display:none) as a no-op — the same
  // blindness that made the whole layer unpromotable.
  try {
    const lsrc = execFileSync("git", ["show", `${ref}:tools/clone-lint.js`], { cwd: root });
    const lpath = path.join(os.tmpdir(), `clone-lint.${ref.replace(/[^a-z0-9]/gi, "_")}.js`);
    fs.writeFileSync(lpath, lsrc);
    const oldLint = require(lpath);
    if (typeof oldLint.lintHtml === "function") baselineLint = oldLint.lintHtml;
  } catch (e) {
    console.error(`(could not load ${ref}:tools/clone-lint.js — artifact half of the A/B scores the CURRENT lint on both sides: ${e.message})`);
  }
}
const OLD = require(path.resolve(baselinePath));
const a = scoreAll(OLD.diffSnapshots, baselineBehavior, baselineCapture, baselineLint), b = scoreAll(NEW.diffSnapshots, NEW_BEHAVIOR.compareMeasured, CAPTURE_SRC, NEW_LINT.lintHtml);
// The comparison loop pairs rows BY INDEX and runs to a.rows.length. If a half was omitted on one
// side (e.g. the baseline capture failed to load), the sides score different case counts and the
// NEW side's unpaired rows are never compared — a NEW FALSE+ there would print nothing, count no
// regression, and exit 0. An A/B that silently skips cases is not an A/B: refuse it.
if (a.rows.length !== b.rows.length) {
  console.error(`✗ OLD scored ${a.rows.length} case(s) but NEW scored ${b.rows.length} — a half was omitted on one side (see warnings above); this A/B cannot be trusted.`);
  process.exit(1);
}
if (b.realCases) console.log(`(including ${b.realCases} real-site corpus case(s))\n`);

console.log(pad("case", 24) + pad("kind", 9) + pad(`OLD (${ref})`, 16) + pad("NEW (worktree)", 16) + "note");
console.log("─".repeat(92));
// A control that STOPS being flagged is a false positive REMOVED — a real improvement, and until
// now an invisible one. The loop credited a defect that starts being caught (gained) and punished
// a control that starts being flagged (broke), but a control going FALSE+ → pass hit NO branch and
// scored ZERO. Since promote-learning required `gained > 0`, that made an entire class of
// improvement — false-positive fixes — UNPROMOTABLE no matter how correct it was: the gate
// punished you for inventing friction and gave you nothing for removing it. (Found on the prevGap
// fix, which removes a phantom the kit manufactured itself and gains 0 defects by construction.)
// Removing a false positive is now credited symmetrically with introducing one.
let gained = 0, broke = 0, fpFixed = 0;
for (let i = 0; i < a.rows.length; i++) {
  const ra = a.rows[i], rb = b.rows[i];
  const mark = (row) => row.kind === "defect" ? (row.pass ? "MISS" : "caught") : (row.pass ? "pass" : "FALSE+");
  let flag = "";
  if (ra.kind === "defect" && !ra.pass !== !rb.pass) { flag = rb.correct ? "  ← GAINED" : "  ← LOST"; rb.correct ? gained++ : broke++; }
  if (ra.kind === "control" && ra.pass && !rb.pass) { flag = "  ← NEW FALSE+"; broke++; }
  if (ra.kind === "control" && !ra.pass && rb.pass) { flag = "  ← FALSE+ FIXED"; fpFixed++; }
  console.log(pad(ra.name, 24) + pad(ra.kind, 9) + pad(mark(ra), 16) + pad(mark(rb), 16) + ra.note + flag);
}
console.log("─".repeat(92));
console.log(`defects caught:   OLD ${a.caught}/${a.defects}   NEW ${b.caught}/${b.defects}`);
console.log(`false positives:  OLD ${a.falsePos}/${a.controls}   NEW ${b.falsePos}/${b.controls}`);
console.log(`\nverdict: +${gained} defect class(es) gained, +${fpFixed} false positive(s) removed, ${broke} regression(s) (missed defect or new false positive).`);
process.exit(broke ? 1 : 0);
