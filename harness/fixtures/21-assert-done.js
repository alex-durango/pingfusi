// fixtures/21-assert-done.js — an iteration may not CLAIM success unless the ledger says so.
//
// Paid for on aloyoga: workflow.js refused `advance done` (behavior + review pending) and
// said "pending" the entire time. It was right. But nothing READ it before the iteration
// reported "green, converged, pixel-perfect" — the gates never lied, the SUMMARY did.
// workflow.js is a ledger, not a driver: it can refuse a bad advance, it cannot compel an
// agent to finish. So the claim now needs an exit code behind it (the kit's own rule:
// never claim "pixel-perfect" from anything but a command that exits 0).
//
// Second class, same shape: `--force` is a legitimate override, but a forced gate and an
// earned one must never read the same in a final report.
const { execFileSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
let bad = 0; const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

const KIT = path.join(__dirname, "..", "..");
const WF = path.join(KIT, "harness", "workflow.js");

// run `status <name> [flags]` in a throwaway kit-cwd, return {code, out}
const status = (cwd, name, flags = []) => {
  try {
    const out = execFileSync("node", [WF, "status", name, ...flags], { cwd, stdio: "pipe" }).toString();
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || "").toString() + (e.stderr || "").toString() };
  }
};

// build a scratch target whose workflow.json we can dictate phase-by-phase
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppk-assert-done-"));
const dir = path.join(tmp, "targets", "t");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "target.json"), JSON.stringify({ name: "t", url: "https://x.test/", width: 1728 }));

const PHASES = ["target", "assets", "measure", "build", "visual", "coverage", "strict", "behavior", "review", "done"];
const writeState = (passUpTo, { forced = [] } = {}) => {
  const phases = {};
  for (const k of PHASES) {
    const passed = PHASES.indexOf(k) <= PHASES.indexOf(passUpTo);
    phases[k] = passed
      ? { status: "pass", kind: "machine", runId: "x", sha256: "x", evidence: null, ts: "2026-07-11T00:00:00Z", forced: forced.includes(k), overrode: [] }
      : { status: "pending", kind: "machine", runId: null, sha256: null, evidence: null, ts: null, forced: false, overrode: [] };
  }
  fs.writeFileSync(path.join(dir, "workflow.json"), JSON.stringify({ name: "t", url: "https://x.test/", width: 1728, createdAt: "2026-07-11T00:00:00Z", phaseOrder: PHASES, phases }));
};

// ---------- 1. THE ALOYOGA CASE: green through `strict`, behavior/review never ran ----------
{
  writeState("strict");
  const r = status(tmp, "t", ["--assert-done"]);
  check("assert-done FAILS an iteration that stopped at strict (the aloyoga bug)", r.code === 1);
  check("  …and names the phases that never ran", /behavior/.test(r.out) && /review/.test(r.out));
  check("  …and forbids the success claim in words", /NOT a finished iteration|Do not report/.test(r.out));
}

// ---------- 2. FORCED phases are an override, not a verification ----------
{
  writeState("done", { forced: ["review"] });
  const r = status(tmp, "t", ["--assert-done"]);
  check("assert-done FAILS when a phase was --force'd, even with all phases 'pass'", r.code === 1);
  check("  …and names the forced phase", /review/.test(r.out) && /FORCE/i.test(r.out));
  // the plain report must not call a forced run 'pixel-perfect' either
  const plain = status(tmp, "t");
  check("  …and plain status refuses to call a forced clone pixel-perfect", !/verified pixel-perfect/.test(plain.out) && /FORCED/i.test(plain.out));
  // --allow-forced is the deliberate, visible opt-in
  check("  …but --allow-forced is an explicit opt-out (exits 0)", status(tmp, "t", ["--assert-done", "--allow-forced"]).code === 0);
}

// ---------- 3. CONTROL: a genuinely finished iteration passes ----------
{
  writeState("done");
  const r = status(tmp, "t", ["--assert-done"]);
  check("CONTROL — a fully earned iteration PASSES assert-done (exit 0)", r.code === 0);
  check("  …and says every phase was earned", /every phase earned/.test(r.out));
}

// ---------- 4. CONTROL: without the flag, status stays a REPORT, never a gate ----------
{
  writeState("strict");
  check("CONTROL — plain `status` still exits 0 (it is a report, not a gate)", status(tmp, "t").code === 0);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad ? `\n✗ ${bad} check(s) failed` : "\n✓ assert-done: an unfinished or forced iteration cannot be reported as green");
process.exit(bad ? 1 : 0);
