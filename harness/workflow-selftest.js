#!/usr/bin/env node
/**
 * workflow-selftest.js — guards the enforced-workflow state machine (harness/workflow.js).
 *
 * The kit's discipline (docs/DEVELOP.md): a lesson goes into a TOOL + a test, never a reviewer
 * checklist. The workflow engine is now a tool, so it gets its own guard. This asserts the
 * two properties that make enforcement real:
 *   1. a gate BLOCKS while its objective condition is unmet, and
 *   2. it PASSES once the condition is met — and out-of-order / undocumented advances are refused.
 *
 * Runs against uniquely-named scratch targets under the repo's targets/ (workflow.js roots
 * targets/ at cwd, which run() pins to the repo), cleaned up on exit. Exit 0 = green.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const KIT = path.resolve(__dirname, "..");
const WF = path.join(KIT, "harness", "workflow.js");
let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed++; console.log(`  ✗ ${msg}`); } };

// run workflow.js with cwd pinned to KIT, so its cwd-rooted targets/ land under the repo
// (where `dir` below points) regardless of where regression.js was invoked from.
// PPK_PINGHUMANS_URL points the review gate at a file:// mock (below) so no test ever
// touches the network — a socket-blocking sandbox must still run this suite.
const MOCK = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-hqmock-"));
process.on("exit", () => { try { fs.rmSync(MOCK, { recursive: true, force: true }); } catch (e) {} });
const run = (args) => { const r = cp.spawnSync(process.execPath, [WF, ...args], { encoding: "utf8", cwd: KIT, env: { ...process.env, PPK_PINGHUMANS_URL: "file://" + MOCK } }); return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }; };
const HQ = path.join(KIT, "harness", "review-qa.js");
const runHq = (args) => { const r = cp.spawnSync(process.execPath, [HQ, ...args], { encoding: "utf8", cwd: KIT, env: { ...process.env, PPK_PINGHUMANS_URL: "file://" + MOCK } }); return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }; };

// A uniquely-named scratch target under KIT/targets, cleaned up after. workflow.js resolves
// targets/<name> from cwd, which we pin to KIT above.
const NAME = "selftest_scratch_" + process.pid;
const dir = path.join(KIT, "targets", NAME);
const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} };
process.on("exit", cleanup);

const writeJson = (f, o) => fs.writeFileSync(path.join(dir, f), JSON.stringify(o, null, 2));
const snap = (els, width) => ({ viewport: { width }, elements: els });
const el = (present = true, extra = {}) => ({ present, rect: { x: 0, y: 0, w: 10, h: 10, top: 0, right: 10, bottom: 10, fromRight: 0 }, ...extra });

cleanup();
fs.mkdirSync(path.join(dir, "clone", "assets"), { recursive: true });
writeJson("target.json", { name: NAME, url: "https://example.com/", width: 1728 });

console.log("workflow-selftest — enforced-workflow state machine");

// init
ok(run(["init", NAME]).code === 0, "init creates workflow.json");
ok(fs.existsSync(path.join(dir, "workflow.json")), "workflow.json written");

// target gate should pass (target.json is valid)
ok(run(["gate", NAME, "target"]).code === 0, "target gate passes with valid target.json");

// measure gate BLOCKS before live.json exists
ok(run(["gate", NAME, "measure"]).code === 1, "measure gate blocks with no live.json");

// out-of-order advance is refused (can't advance measure before target/assets)
ok(run(["advance", NAME, "measure"]).code === 1, "out-of-order advance (measure before target) refused");

// advance target (machine phase)
ok(run(["advance", NAME, "target"]).code === 0, "advance target succeeds");

// assets: attested phase → refuses without --evidence
ok(run(["advance", NAME, "assets"]).code === 1, "attested phase refuses without --evidence");
// a hand-faked woff2 (wrong magic) must fail the light check even with evidence
fs.writeFileSync(path.join(dir, "clone", "assets", "fake.woff2"), "NOTAWOFF2FILE");
ok(run(["advance", NAME, "assets", "--evidence", "x"]).code === 1, "assets gate rejects a woff2 with bad magic bytes");
fs.rmSync(path.join(dir, "clone", "assets", "fake.woff2"));
ok(run(["advance", NAME, "assets", "--evidence", "icons+logo captured from live"]).code === 0, "assets advances with evidence + clean assets dir");

// measure: width mismatch blocks, correct width passes
writeJson("live.json", snap({ logo: el(), nav_first: el(true, { text: { x: 0, right: 5, top: 0, bottom: 5, w: 5, h: 5 }, font: { weight: "400", size: 14, line: 20, spacing: "normal", transform: "none", color: "rgb(0,0,0)", decoration: "none", smoothing: "auto" } }) }, 1440));
ok(run(["gate", NAME, "measure"]).code === 1, "measure gate blocks on width mismatch (1440 vs 1728)");
writeJson("live.json", snap({ logo: el(), nav_first: el(true, { text: { x: 0, right: 5, top: 0, bottom: 5, w: 5, h: 5 }, font: { weight: "400", size: 14, line: 20, spacing: "normal", transform: "none", color: "rgb(0,0,0)", decoration: "none", smoothing: "auto" } }) }, 1728));
ok(run(["advance", NAME, "measure"]).code === 0, "measure advances at the fixed width");

// build: scaffold TODO blocks; real clone.json passes
fs.writeFileSync(path.join(dir, "clone", "index.html"), "<header><!-- TODO: build to spec --></header>");
ok(run(["gate", NAME, "build"]).code === 1, "build gate blocks while scaffold TODO remains");
fs.writeFileSync(path.join(dir, "clone", "index.html"), "<header><a class=logo></a><a>Shop</a></header>");
writeJson("clone.json", snap({ logo: el(), nav_first: el(true, { text: { x: 0, right: 5, top: 0, bottom: 5, w: 5, h: 5 }, font: { weight: "400", size: 14, line: 20, spacing: "normal", transform: "none", color: "rgb(0,0,0)", decoration: "none", smoothing: "auto" } }) }, 1728));
ok(run(["advance", NAME, "build"]).code === 0, "build advances with a real clone.json");

// visual: identical snapshots → green
ok(run(["advance", NAME, "visual"]).code === 0, "visual gate passes when clone matches live");

// coverage: blocks without coverage.json, blocks on an uncovered leaf, passes when all covered
ok(run(["gate", NAME, "coverage"]).code === 1, "coverage gate blocks with no coverage.json");
writeJson("coverage.json", ["logo", "nav_first", "ghost_leaf"]);
ok(run(["gate", NAME, "coverage"]).code === 1, "coverage gate blocks on an uncovered painted leaf");
writeJson("coverage.json", ["logo", "nav_first"]);
ok(run(["advance", NAME, "coverage"]).code === 0, "coverage advances when every enumerated leaf is targeted");

// strict: identical snapshots → 0 deltas → passes
ok(run(["advance", NAME, "strict"]).code === 0, "strict gate passes with 0 structural deltas");

// ── behavior: blocks with no discovery evidence, passes once discovery ran and found nothing ──
// (behaviorGate itself has a dedicated guard: harness/behavior-selftest.js. Here we only
// prove the phase is correctly WIRED into the ordered advance sequence between strict/reviewer.)
ok(run(["gate", NAME, "behavior"]).code === 1, "behavior gate blocks with no behaviors-live.json");
writeJson("behaviors-live.json", {
  url: "https://example.com/",
  discovery: { elementsScanned: 40, scrollSweep: { from: 0, to: 800, steps: 4 }, observeMs: 1200 },
  behaviors: {},
});
ok(run(["advance", NAME, "behavior"]).code === 0, "behavior advances once discovery ran and found no dynamic behaviors");

// ── reviewer: blocks with no round, blocks while pending, blocks on rejection, passes on approval ──
const PING = "00000000-0000-4000-8000-000000000001";
ok(run(["gate", NAME, "review"]).code === 1, "review gate blocks with no QA round recorded");
ok(run(["advance", NAME, "done"]).code === 1, "done refused while review phase is pending");
ok(runHq(["record", NAME, PING, "--approve", "Region identical"]).code === 0, "review-qa record adopts a filed ping");
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING}.json`), JSON.stringify({ status: "pending", n_received: 0, n_target: 1, responses: [] }));
ok(run(["gate", NAME, "review"]).code === 1, "review gate blocks while the round is pending");
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING}.json`), JSON.stringify({
  status: "complete", n_received: 1, n_target: 1,
  responses: [{ verdict: "Region clearly different", notes: "logo sits low" }],
  comments: [{ step_index: 0, text: "logo sits low", side: "draft", selector: "img.logo", target: "<img> logo" }],
}));
const rej = run(["gate", NAME, "review"]);
ok(rej.code === 1 && /logo sits low/.test(rej.out), "review gate blocks on rejection and surfaces the reviewer's flag");
// The gate reason is the FULL verify output, not just the first line — the reviewer's
// structured ⌖ marks below the verdict line must reach an agent driving via gates.
ok(/⌖ DRAFT · <img> logo \[img\.logo\]/.test(rej.out), "the gate passes verify's per-comment ⌖ blocks through, not only the verdict line");
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING}.json`), JSON.stringify({ status: "complete", n_received: 1, n_target: 1, responses: [{ verdict: "Region identical" }] }));
ok(run(["advance", NAME, "review"]).code === 0, "reviewer advances on an approving verdict");

ok(run(["advance", NAME, "done"]).code === 0, "done advances once every phase passed in order");

// ledger records the run (refusals are receipted too, so count includes them)
const readLedger = () => fs.readFileSync(path.join(dir, "workflow.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
let ledger = readLedger();
ok(ledger.length >= 7, `ledger recorded ${ledger.length} receipts`);
ok(ledger.every((r) => r.runId && r.ts && (r.phase || r.event)), "every ledger receipt has runId + ts + phase/event");
ok(ledger.some((r) => r.gate === "refused"), "refused advances are receipted in the ledger");

// ── done is default-FAIL: a recorded pass must not survive edits to what it certified ──
{
  const clonePath = path.join(dir, "clone.json");
  const original = fs.readFileSync(clonePath, "utf8");
  const tampered = JSON.parse(original);
  tampered.elements.nav_first.font.color = "rgb(255,0,0)"; // paint regression after visual passed
  writeJson("clone.json", tampered);
  ok(run(["gate", NAME, "done"]).code === 1, "done gate FAILS when a certified artifact was edited (stale visual pass)");
  // a PAINT delta can never be documented away in deviations.json
  writeJson("deviations.json", { nav_first: { "font.color": "attempt to excuse a visible mark" } });
  const paintRefusal = run(["gate", NAME, "strict"]);
  ok(paintRefusal.code === 1, "strict gate refuses to let deviations.json excuse a PAINT delta");
  // …and the refusal states BOTH halves of what holds: no deviations channel for paint,
  // but the --blocked receipt is ACCEPTED (agents used to read the message as "--blocked
  // refused" and stall with no legitimate exit)
  ok(/documented away in deviations\.json/.test(paintRefusal.out) && /--blocked/.test(paintRefusal.out) && /IS accepted/.test(paintRefusal.out),
    "the strict paint refusal names the accepted --blocked escape instead of implying it is refused");
  ok(/done stays red until the phase re-earns a passing gate/.test(paintRefusal.out),
    "…and says the receipt keeps done honest rather than passing it");
  fs.rmSync(path.join(dir, "deviations.json"));
  fs.writeFileSync(clonePath, original);
  ok(run(["gate", NAME, "done"]).code === 0, "done gate passes again once the artifact is restored");
}

// ── --force is never silent: any bypassed enforcement is recorded, and done refuses it ──
{
  // assets gate itself passes, but --force bypasses the attestation-evidence requirement:
  ok(run(["advance", NAME, "assets", "--force"]).code === 0, "--force advance with passing gate succeeds");
  ledger = readLedger();
  const last = ledger[ledger.length - 1];
  ok(last.forced === true && Array.isArray(last.overrode) && last.overrode.includes("evidence"),
    "forced advance with a PASSING gate still records forced:true + what it overrode");
  ok(run(["gate", NAME, "done"]).code === 1, "done gate refuses a workflow containing a forced phase");
  ok(run(["advance", NAME, "assets", "--evidence", "re-attested cleanly"]).code === 0, "clean re-advance clears the forced flag");
  ok(run(["gate", NAME, "done"]).code === 0, "done gate passes again once no phase is forced");
}

// ── --evidence must carry a real value, never a flag ──
ok(run(["advance", NAME, "assets", "--evidence", "--force"]).code === 2, "--evidence followed by a flag is rejected (exit 2)");

// ── schema migration: a pre-`reviewer` workflow.json hydrates as pending, never errors ──
// (runs while the workflow is fully green, so restoring the saved state must pass done)
{
  const statePath = path.join(dir, "workflow.json");
  const saved = fs.readFileSync(statePath, "utf8");
  const st = JSON.parse(saved);
  delete st.phases.review; // simulate a workflow seeded before the kit gained the phase
  st.phaseOrder = st.phaseOrder.filter((k) => k !== "review");
  fs.writeFileSync(statePath, JSON.stringify(st, null, 2));
  const s = run(["status", NAME]);
  ok(s.code === 0 && /review/.test(s.out), "old-schema workflow.json hydrates the new phase instead of erroring");
  ok(run(["gate", NAME, "done"]).code === 1, "done gate honestly fails for a migrated workflow until review re-passes");
  fs.writeFileSync(statePath, saved);
  ok(run(["gate", NAME, "done"]).code === 0, "restored state passes done again");
}

// ── first-draft doctrine: motion receipts are informational — they NEVER block done ─────
// (runs while the workflow is fully green; the manifest is removed after so later blocks
// keep their baseline)
{
  const motionPath = path.join(dir, "motion-items.json");
  writeJson("motion-items.json", {
    schema: "pingfusi/motion-items@1",
    items: [{ id: "belt", kind: "raf", status: "pending", declaredBy: "manual" }],
  });
  const withActive = run(["gate", NAME, "done"]);
  ok(withActive.code === 0 && /belt \(pending\)/.test(withActive.out),
    "an open (pending) motion receipt cannot block done — it rides along as an informational line");
  const st = run(["status", NAME]);
  ok(st.code === 0 && /motion advisory/.test(st.out) && /belt \(pending\)/.test(st.out),
    "status surfaces the open motion receipt as an advisory line, not a blocker");
  ok(run(["status", NAME, "--assert-done"]).code === 0,
    "assert-done ignores motion receipts — motion checks are build receipts, never gates");
  writeJson("motion-items.json", {
    schema: "pingfusi/motion-items@1",
    items: [{ id: "belt", kind: "raf", status: "verified-sampled", declaredBy: "manual" }],
  });
  const cited = run(["gate", NAME, "done"]);
  ok(cited.code === 0 && /machine-verified/.test(cited.out),
    "done's terminal receipt cites the machine-verified motion receipts informationally");
  fs.rmSync(motionPath);
  ok(run(["gate", NAME, "done"]).code === 0, "removing the manifest restores the green baseline");
}

// ── init never silently wipes state; resets are receipted; corruption recovers cleanly ──
{
  ok(run(["init", NAME]).code === 1, "re-init on recorded state is refused without --force");
  const statePath = path.join(dir, "workflow.json");
  fs.writeFileSync(statePath, "{ truncated"); // simulate a killed process / manual edit
  const r = run(["status", NAME]);
  ok(r.code === 1 && /corrupt/.test(r.out) && !/at Object\./.test(r.out), "corrupt workflow.json → self-describing error + recovery hint, no raw stack");
  ok(run(["init", NAME, "--force"]).code === 0, "init --force re-seeds corrupt state");
  ledger = readLedger();
  ok(ledger.some((l) => l.event === "reset"), "the forced reset is receipted in the ledger");
  ok(run(["status", NAME]).code === 0, "status works again after recovery");
}

// ── directory receipts pin CONTENTS, not just filenames ──
{
  const { PHASES: P } = require("./workflow.js");
  void P; // (imported to assert the module exports cleanly)
  const sha = require("./workflow.js").sha256OfFile;
  const d = path.join(dir, "clone", "assets");
  fs.writeFileSync(path.join(d, "font.woff2"), "wOF2-original-bytes");
  const before = sha(path.join(dir, "clone"));
  fs.writeFileSync(path.join(d, "font.woff2"), "wOF2-swapped--bytes"); // same name, different bytes
  const after = sha(path.join(dir, "clone"));
  ok(before !== after, "directory sha256 changes when a same-named file's contents change");
  fs.rmSync(path.join(d, "font.woff2"));
}

console.log(failed ? `\n❌ workflow-selftest: ${failed} assertion(s) failed.` : `\n✓ workflow-selftest: all assertions pass — gates block when unmet and pass when met.`);
process.exit(failed ? 1 : 0);
