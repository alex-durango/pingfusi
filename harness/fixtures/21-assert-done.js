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

// ---------- 5. FIRST-DRAFT DOCTRINE: motion receipts are informational, never a done blocker ----------
// (owner decision 2026-07-19) motion-items.json is machine BOOKKEEPING — receipts of what
// the build's motion pass did. An open item — even a legacy @1 row still carrying a
// review-era status — degrades to an ADVISORY line: assert-done stays green and the plain
// report keeps the earned verified claim, with the open receipt named beside it.
{
  writeState("done");
  fs.writeFileSync(path.join(dir, "motion-items.json"), JSON.stringify({
    schema: "pingfusi/motion-items@1",
    items: [{ id: "hero-intro", kind: "spring", status: "needs-2afc" }],
  }));
  const asserted = status(tmp, "t", ["--assert-done"]);
  check("assert-done PASSES with an open motion receipt (motion never blocks done)", asserted.code === 0);
  check("  …and the advisory names the open item as informational", /hero-intro/.test(asserted.out) && /informational/.test(asserted.out));
  const plain = status(tmp, "t");
  check("  …and plain status keeps the earned verified claim beside the advisory", /verified pixel-perfect/.test(plain.out) && /motion advisory/.test(plain.out));
  fs.rmSync(path.join(dir, "motion-items.json"));
}

// ---------- 6. Sweep-derived temporal candidates are advisory lines routed to the machine chain ----------
// A strong temporal candidate the behavior sweep found surfaces as a warning that routes
// `next` (capture → introspected diff / sample → apply → verify). There is no declare
// ceremony and no review-round machinery in the motion path — the side-by-side compare
// round is the one reviewer channel, and it is not motion's to offer here.
{
  writeState("done");
  fs.writeFileSync(path.join(dir, "behaviors-live.json"), JSON.stringify({
    url: "https://x.test/",
    discovery: { elementsScanned: 40, scrollSweep: { from: 0, to: 800, steps: 4 }, observeMs: 1200, documentHidden: false },
    behaviors: { "marquee:ticker": { trigger: "load", kind: "marquee", measured: { pxPerSec: 80 } } },
  }));
  const r = status(tmp, "t", ["--assert-done"]);
  check("assert-done PASSES with an unreceipted sweep-derived motion candidate", r.code === 0);
  check("  …and the advisory names the candidate and routes to `next`", /marquee:ticker/.test(r.out) && /next t\b/.test(r.out));
  check("  …and offers no removed declare ceremony", !/motion declare/.test(r.out));
  // a sweep-manufactured bookkeeping row is advisory the same way — receipts, never gates
  fs.writeFileSync(path.join(dir, "motion-items.json"), JSON.stringify({
    schema: "pingfusi/motion-items@1",
    items: [{ id: "swept-marquee", kind: "marquee", status: "pending", source: "behavior-capture", sourceBehaviorKeys: ["marquee:ticker"] }],
  }));
  const r2 = status(tmp, "t", ["--assert-done"]);
  check("  …and a sweep-manufactured bookkeeping row stays advisory too", r2.code === 0 && /swept-marquee/.test(r2.out));
  fs.rmSync(path.join(dir, "motion-items.json"));
  fs.rmSync(path.join(dir, "behaviors-live.json"));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad ? `\n✗ ${bad} check(s) failed` : "\n✓ assert-done: an unfinished or forced iteration cannot be reported as green");
process.exit(bad ? 1 : 0);
