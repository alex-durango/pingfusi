// harness/regression.js — the kit's guardrail. Runs the gate-guard (tools/selftest.js)
// plus every harness/fixtures/*.js. Each class of miss found while cloning a real site
// becomes a fixture here, so it can never silently come back (that's the whole point:
// a lesson goes into the TOOL + a fixture, not into a manual checklist). Exit nonzero if
// any fail — wire this into CI or run it before shipping a pixel-diff.js change.
const { execFileSync } = require("child_process");
const fs = require("fs"), path = require("path");
const KIT = path.resolve(__dirname, "..");

const tests = [path.join(KIT, "tools", "selftest.js"), path.join(KIT, "tools", "cli-selftest.js"), path.join(KIT, "harness", "workflow-selftest.js"), path.join(KIT, "harness", "capture-build-selftest.js"), path.join(KIT, "harness", "review-qa-selftest.js"), path.join(KIT, "harness", "tunnel-selftest.js"), path.join(KIT, "harness", "behavior-selftest.js"), path.join(KIT, "harness", "merge-snapshot-selftest.js"), path.join(KIT, "harness", "doctor-selftest.js"), path.join(KIT, "harness", "setup-selftest.js"), path.join(KIT, "harness", "bin-dispatch-selftest.js")];
const fixDir = path.join(__dirname, "fixtures");
if (fs.existsSync(fixDir))
  for (const f of fs.readdirSync(fixDir).filter((f) => f.endsWith(".js")).sort()) tests.push(path.join(fixDir, f));
// the detection-power battery (absolute mode) — asserts the current gate catches every
// known defect class and flags no control. A broader guard than the per-class fixtures.
const bench = path.join(__dirname, "benchmarks", "detection-power.js");
if (fs.existsSync(bench)) tests.push(bench);

let failed = 0;

// SYNTAX GUARD — a kit script that doesn't parse is a broken kit even when no test
// imports it. Paid for: a template-literal typo in new-target.js shipped while this
// suite was green, because the scaffold is only ever run by users, never by a test
// (caught by an agent mid-clone when `pingfusi new` wouldn't start). `node --check` every
// kit script so the whole surface at least parses.
const syntaxFiles = [path.join(KIT, "bin", "pingfusi")];
for (const root of ["tools", "harness"].map((d) => path.join(KIT, d))) {
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.name.endsWith(".js")) syntaxFiles.push(fp);
    }
  };
  if (fs.existsSync(root)) walk(root);
}
let syntaxFailed = 0;
for (const f of syntaxFiles) {
  try { execFileSync("node", ["--check", f], { stdio: "pipe" }); }
  catch (e) { syntaxFailed++; failed++; console.log(`✗ syntax ${path.relative(KIT, f)}`); process.stdout.write((e.stderr || "").toString()); }
}
if (!syntaxFailed) console.log(`✓ syntax — all ${syntaxFiles.length} kit scripts parse (node --check)`);

for (const t of tests) {
  const label = path.relative(KIT, t);
  try { execFileSync("node", [t], { stdio: "pipe" }); console.log(`✓ ${label}`); }
  catch (e) { failed++; console.log(`✗ ${label}`); process.stdout.write((e.stdout || "").toString() + (e.stderr || "").toString()); }
}
console.log(failed ? `\n❌ regression: ${failed} of ${tests.length} file(s) failed.` : `\n✓ regression: all ${tests.length} file(s) pass — the gate still catches every known class of miss.`);
process.exit(failed ? 1 : 0);
