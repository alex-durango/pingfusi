#!/usr/bin/env node
/**
 * assist-selftest.js — guards the stall detector + assist escalation + blocked-gate path
 * (harness/workflow.js stallInfo/--blocked, harness/review-qa.js assist/--diagnostic,
 * harness/score.js STALLED banner).
 *
 * The contract under guard: the kit must tell the agent to ask a reviewer BEFORE burning
 * blind iterations (the streak is derived from the append-only ledger, reset by a FILED
 * assist receipt), and must give it a receipted way to push to review when a gate is
 * environment-blocked — while none of it (assist polls, diagnostic rounds, blocked
 * receipts) can ever satisfy the review gate or count as done.
 *
 * Offline + socket-free: the review API is mocked via PPK_PINGHUMANS_URL=file://…
 * (canned quick_poll.json / get_ping-<id>.json / request_review.json /
 * get_test_results-<id>.json). Exit 0 = green.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const KIT = path.resolve(__dirname, "..");
process.chdir(KIT); // in-process requires below resolve targets/ from cwd, same as the spawns
const WF = path.join(KIT, "harness", "workflow.js");
const HQ = path.join(KIT, "harness", "review-qa.js");
const SCORE = path.join(KIT, "harness", "score.js");
let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed++; console.log(`  ✗ ${msg}`); } };

const MOCK = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-assist-"));
const EMPTY_MOCK = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-assist-empty-"));
const NAME = "assist_selftest_" + process.pid;
const dir = path.join(KIT, "targets", NAME);
const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(MOCK, { recursive: true, force: true }); fs.rmSync(EMPTY_MOCK, { recursive: true, force: true }); } catch (e) {} };
process.on("exit", cleanup);
fs.rmSync(dir, { recursive: true, force: true }); // pre-clean a stale target dir only — the MOCK dirs were just created

const spawn = (script, args, env) => { const r = cp.spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: KIT, env: { ...process.env, PPK_PINGHUMANS_URL: "file://" + MOCK, PPK_PINGHUMANS_TOKEN: "tok-selftest", ...env } }); return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }; };
const runWf = (args, env) => spawn(WF, args, env);
const runHq = (args, env) => spawn(HQ, args, env);
const runScore = (env) => spawn(SCORE, [NAME], env);

const writeJson = (f, o) => fs.writeFileSync(path.join(dir, f), JSON.stringify(o, null, 2));
const mockJson = (f, o) => fs.writeFileSync(path.join(MOCK, f), JSON.stringify(o));
const readLedger = () => fs.readFileSync(path.join(dir, "workflow.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const assistEvents = () => readLedger().filter((r) => r.event === "assist");
const snap = (els, width) => ({ viewport: { width }, elements: els });
const el = (extra = {}) => ({ present: true, rect: { x: 0, y: 0, w: 10, h: 10, top: 0, right: 10, bottom: 10, fromRight: 0 }, ...extra });
const FONT = { weight: "400", size: 14, line: 20, spacing: "normal", transform: "none", color: "rgb(0,0,0)", decoration: "none", smoothing: "auto" };
const nav = (font) => el({ text: { x: 0, right: 5, top: 0, bottom: 5, w: 5, h: 5 }, font: { ...FONT, ...font } });

console.log("assist-selftest — stall detector + assist escalation + blocked gates");

// ── scaffold: a target advanced through build, with a tampered clone so visual FAILS ──
fs.mkdirSync(path.join(dir, "clone", "assets"), { recursive: true });
writeJson("target.json", { name: NAME, url: "https://example.com/", width: 1728 });
runWf(["init", NAME]);
runWf(["advance", NAME, "target"]);
runWf(["advance", NAME, "assets", "--evidence", "no self-hosted fonts"]);
writeJson("live.json", snap({ logo: el(), nav_first: nav() }, 1728));
runWf(["advance", NAME, "measure"]);
fs.writeFileSync(path.join(dir, "clone", "index.html"), "<header><a class=logo></a><a>Shop</a></header>");
const CLONE_GOOD = snap({ logo: el(), nav_first: nav() }, 1728);
const CLONE_BAD = snap({ logo: el(), nav_first: nav({ color: "rgb(255,0,0)" }) }, 1728);
writeJson("clone.json", CLONE_GOOD);
runWf(["advance", NAME, "build"]);
writeJson("clone.json", CLONE_BAD);

// ── the stall streak: derived from gate-failure refusals, surfaced at 3 ──────────
const a1 = runWf(["advance", NAME, "visual"]);
ok(a1.code === 1 && /gate failed for "visual"/.test(a1.out) && !/STALLED/.test(a1.out), "failed advance 1 refused, no STALLED yet");
const a2 = runWf(["advance", NAME, "visual"]);
ok(a2.code === 1 && !/STALLED/.test(a2.out), "failed advance 2 refused, no STALLED yet");
const a3 = runWf(["advance", NAME, "visual"]);
ok(a3.code === 1 && /STALLED/.test(a3.out) && /assist/.test(a3.out), "failed advance 3 prints the STALLED hint with the assist command");
const st1 = runWf(["status", NAME]);
ok(/STALLED — 3 consecutive/.test(st1.out) && /assist/.test(st1.out), "status shows STALLED with the runnable assist command");
const g1 = runWf(["gate", NAME, "visual"]);
ok(g1.code === 1 && /STALLED/.test(g1.out), "a failing gate probe carries the STALLED hint too");
ok(/STALLED — 3 consecutive/.test(runWf(["status", NAME]).out), "gate probes are read-only — the streak stays at 3");
runWf(["advance", NAME, "strict"]); // out-of-order refusal ("cannot advance") — must be neutral
ok(/STALLED — 3 consecutive/.test(runWf(["status", NAME]).out), "an out-of-order refusal on another phase does not touch the streak");

// ── composeAssist: one-sided by construction, refuses what a reviewer can't fix ──
const { composeAssist, comparisonShaped } = require(HQ);
const { stallHint } = require(WF);
const cv = composeAssist(NAME, "visual");
ok(cv.ok && /nav first/.test(cv.question) && /exact color/.test(cv.question), "visual assist names the worst failing leaf (slug→words) with a color-shaped hint for font.color");
ok(!comparisonShaped(cv.question), "the composed question is one-sided (passes the poll comparison guard)");
ok(composeAssist(NAME, "measure").ok === false && /mechanically|cannot supply/.test(composeAssist(NAME, "measure").reason), "mechanical phases refuse — a reviewer cannot supply an artifact");
ok(composeAssist(NAME, "review").ok === false && /wait/.test(composeAssist(NAME, "review").reason), "review phase refuses — the filed round already carries the ask");
const cb = composeAssist(NAME, "behavior"); // no behaviors-live.json → environment-shaped
ok(cb.ok === false && /behavior-capture/.test(cb.reason), "environment-shaped behavior failure steers to behavior-capture, not a reviewer");
const behaviorStall = stallHint(NAME, 3, "behavior");
ok(/\bnext\b/.test(behaviorStall) && /pingfusi motion/.test(behaviorStall) && !/--compare/.test(behaviorStall), "behavior STALLED guidance routes evidence before any specialist review");

// Temporal behavior is a DIFFERENT specialist contract. Both auto-composed and custom
// --ask/--compare paths must refuse before they can spend a layout review credit.
const MOTION_NAME = `${NAME}_motion`;
const motionDir = path.join(KIT, "targets", MOTION_NAME);
fs.mkdirSync(motionDir, { recursive: true });
fs.writeFileSync(path.join(motionDir, "target.json"), JSON.stringify({ name: MOTION_NAME, url: "https://example.com/", width: 1728 }));
const discovery = { elementsScanned: 4, scrollSweep: { from: 0, to: 900, steps: 3 }, observeMs: 1200, documentHidden: false };
fs.writeFileSync(path.join(motionDir, "behaviors-live.json"), JSON.stringify({ discovery, behaviors: {
  "marquee:hero": { kind: "marquee", trigger: "load", measured: { pxPerSec: 120, durationMs: 1000 } },
} }));
fs.writeFileSync(path.join(motionDir, "behaviors-clone.json"), JSON.stringify({ discovery, behaviors: {
  "marquee:hero": { kind: "marquee", trigger: "load", measured: { pxPerSec: 40, durationMs: 2600 } },
} }));
const cm = composeAssist(MOTION_NAME, "behavior");
ok(cm.ok === false && /pingfusi motion/.test(cm.reason) && /machine checks/.test(cm.reason) && !/--mode |motion review/.test(cm.reason), "temporal behavior composition routes to the motion engine's machine checks — no review-round machinery is named");
const customMotion = runHq(["assist", MOTION_NAME, "--phase", "behavior", "--ask", "compare the animation", "--compare"]);
ok(customMotion.code === 1 && /machine checks/.test(customMotion.out) && /pingfusi motion/.test(customMotion.out) && !/--mode |motion review/.test(customMotion.out), "custom temporal --ask cannot bypass the machine-check guard, and the remedy prints no review-round machinery");
fs.rmSync(motionDir, { recursive: true, force: true });

// ── assist files a poll, receipts it, and the receipt resets the streak ──────────
const PING_POLL = "00000000-0000-4000-8000-00000000a011";
mockJson("quick_poll.json", { ping_id: PING_POLL, status: "pending", n_received: 0, responses: [] });
const as1 = runHq(["assist", NAME]);
ok(as1.code === 0 && /assist \(phase visual/.test(as1.out) && /nav first/.test(as1.out), "assist resolves the stuck phase and files the composed question");
const hq1 = JSON.parse(fs.readFileSync(path.join(dir, "review-qa.json"), "utf8"));
ok(hq1.polls.length === 1 && hq1.polls[0].assist && hq1.polls[0].assist.phase === "visual" && hq1.polls[0].ping_id === PING_POLL, "the ask is recorded in hq.polls with assist metadata");
ok(assistEvents().length === 1 && assistEvents()[0].phase === "visual", "a FILED assist appends the ledger receipt");
ok(!/STALLED/.test(runWf(["status", NAME]).out), "the assist receipt resets the stall streak (filed, not answered)");
ok(/assist pending \(phase visual/.test(runWf(["status", NAME]).out), "status surfaces the pending assist with the free re-check command");

// ── one open assist per target; a new one is allowed once the answer lands ──────
const as2 = runHq(["assist", NAME]);
ok(as2.code === 1 && /already open/.test(as2.out) && /poll-result/.test(as2.out), "a second assist while one is pending is refused with the re-check command");
mockJson(`get_ping-${PING_POLL}.json`, { status: "completed", n_received: 1, responses: [{ choice: null, free_text: "the heading is deep red, not black" }] });
ok(runHq(["poll-result", NAME, PING_POLL]).code === 0, "the answer arrives via poll-result (free)");
ok(/assist answered \(phase visual\).*deep red/.test(runWf(["status", NAME]).out), "status surfaces the assist answer");

// ── assist --compare files a scoped DIAGNOSTIC round that can never satisfy review ──
const PING_DIAG = "00000000-0000-4000-8000-00000000a022";
writeJson("draft.json", { url: "https://drafts.example.net/x/abc123" });
mockJson("request_review.json", { ping_id: PING_DIAG });
const as3 = runHq(["assist", NAME, "--compare"]);
ok(as3.code === 0 && /diagnostic round filed/.test(as3.out) && /never the review gate/.test(as3.out), "assist --compare files a diagnostic round and says it is advisory");
const hq2 = JSON.parse(fs.readFileSync(path.join(dir, "review-qa.json"), "utf8"));
ok((hq2.diagnostics || []).length === 1 && hq2.diagnostics[0].assist.phase === "visual" && hq2.diagnostics[0].n_target === 5 && /nav first/.test(hq2.diagnostics[0].region), "the diagnostic is recorded at standard 5-result depth, scoped to the worst failing leaf");
ok(assistEvents().length === 2, "the diagnostic assist is receipted in the ledger too");
ok(runHq(["verify", NAME]).code === 1 && /no review round recorded/.test(runHq(["verify", NAME]).out), "verify ignores diagnostics — the review gate is untouched");
mockJson(`get_test_results-${PING_DIAG}.json`, { status: "pending", n_received: 1, n_target: 5, responses: [{ choice: "Described the differences", free_text: "the nav link is a heavier red weight" }], comments: [] });
const partialAr = runHq(["assist-result", NAME, PING_DIAG]);
ok(partialAr.code === 1 && /diagnostic collecting — 1\/5/.test(partialAr.out), "a partial diagnostic stays collecting until its requested depth resolves");
ok(/assist pending \(phase visual, ping .*1\/5 results/.test(runWf(["status", NAME]).out), "workflow status shows partial diagnostic progress instead of calling it answered early");
ok(runHq(["assist", NAME]).code === 1 && /already open/.test(runHq(["assist", NAME]).out), "a partially answered diagnostic still counts as the one open assist");
mockJson(`get_test_results-${PING_DIAG}.json`, { status: "complete", n_received: 1, n_target: 5, responses: [{ choice: "Described the differences", free_text: "the nav link is a heavier red weight" }], comments: [] });
const ar = runHq(["assist-result", NAME, PING_DIAG]);
ok(ar.code === 0 && /heavier red/.test(ar.out), "a terminal diagnostic returns delivered results even if credit exhaustion ended it below target");

// ── failed filings leave NO receipt (the receipt is what resets the streak) ──────
const asOffline = runHq(["assist", NAME, "--phase", "visual"], { PPK_PINGHUMANS_URL: "https://selftest-invalid.example", PPK_PINGHUMANS_TOKEN: "" });
ok(asOffline.code === 1 && /pingfusi setup/.test(asOffline.out), "logged out: assist refuses naming setup (and the receipted alternatives)");
ok(assistEvents().length === 2, "a logged-out refusal appends no ledger receipt");
const asBroken = runHq(["assist", NAME, "--phase", "visual"], { PPK_PINGHUMANS_URL: "file://" + EMPTY_MOCK });
ok(asBroken.code === 1, "a transport failure exits nonzero");
ok(assistEvents().length === 2, "a failed filing appends no ledger receipt — the streak is untouched");

// ── --blocked: the receipted last rung — push to review despite the environment ──
writeJson("clone.json", CLONE_GOOD);
runWf(["advance", NAME, "visual"]);
writeJson("coverage.json", ["logo", "nav_first"]);
runWf(["advance", NAME, "coverage"]);
runWf(["advance", NAME, "strict"]);
ok(runWf(["advance", NAME, "behavior", "--blocked"]).code === 2, "--blocked with no reason is a usage error (nothing lands in the ledger)");
ok(runWf(["advance", NAME, "behavior", "--blocked", "x", "--force"]).code === 2, "--blocked and --force are mutually exclusive");
const b1 = runWf(["advance", NAME, "behavior", "--blocked", "tabs permanently hidden; behavior-capture tried, no Chrome binary in this env"]);
ok(b1.code === 0 && /⚠ BLOCKED behavior/.test(b1.out) && /push to review/.test(b1.out), "an env-blocked failing gate records blocked + prints the file-now ladder");
const wfState = JSON.parse(fs.readFileSync(path.join(dir, "workflow.json"), "utf8"));
ok(wfState.phases.behavior.blocked === true && wfState.phases.behavior.overrode.includes("blocked-env"), "workflow.json records blocked:true with overrode blocked-env");
const b2 = runWf(["advance", NAME, "target", "--blocked", "not actually blocked"]);
ok(b2.code === 1 && /--blocked refused/.test(b2.out), "--blocked on a PASSING gate is refused — advance it normally");
const st2 = runWf(["status", NAME]);
ok(/⚠ blocked\s+behavior/.test(st2.out) && /file it NOW despite the blocked gate/.test(st2.out), "status renders ⚠ blocked and the file-now breadcrumb before an unfiled review");
const ad = runWf(["status", NAME, "--assert-done"]);
ok(ad.code === 1 && /environment-blocked/.test(ad.out), "assert-done still refuses — a blocked phase is never done");

// ── a blocked phase lets the round FILE (no --anyway), with the gap documented ──
const t1 = runHq(["template", NAME, "--draft", "https://drafts.example.net/x/abc123"]);
ok(/KNOWN GAP/.test(t1.out) && /behavior/.test(t1.out) && /hidden/.test(t1.out), "the round spec carries the KNOWN GAP step naming the blocked phase + reason");
const PING_ROUND = "00000000-0000-4000-8000-00000000a033";
mockJson("request_review.json", { ping_id: PING_ROUND });
fs.rmSync(path.join(dir, "clone", "index.html")); // skip the draft-serving probe (network) — not under test here
const f1 = runHq(["file", NAME, "--draft", "https://drafts.example.net/x/abc123"]);
ok(f1.code === 0 && /filed round 1/.test(f1.out), "review file proceeds past a blocked phase WITHOUT --anyway (the receipt is the permission)");
ok(runHq(["file", NAME, "--diagnostic", "--draft", "https://drafts.example.net/x/abc123"]).code === 2, "file --diagnostic without --region is refused — a diagnostic must be scoped");

// ── done gate: blocked is an override, not a verification ────────────────────────
fs.writeFileSync(path.join(dir, "clone", "index.html"), "<header><a class=logo></a><a>Shop</a></header>"); // restore — done re-runs the build gate
mockJson(`get_test_results-${PING_ROUND}.json`, { status: "complete", n_received: 1, n_target: 1, responses: [{ verdict: "Cloned region identical" }] });
ok(runWf(["advance", NAME, "review"]).code === 0, "review advances on the approving verdict");
const d1 = runWf(["gate", NAME, "done"]);
ok(d1.code === 1 && /environment-BLOCKED/.test(d1.out), "the done gate refuses a blocked phase even after review approval");

// ── ledger renders the new events readably ───────────────────────────────────────
const led = runWf(["ledger", NAME]);
ok(/assist\s+visual/.test(led.out) && /assist poll filed:/.test(led.out), "ledger renders assist events with phase + question");
ok(/BLOCKED behavior/.test(led.out), "ledger renders the blocked advance as BLOCKED, not FORCED");

// ── score.js: the advisory STALLED banner on 3 no-improvement runs ───────────────
fs.rmSync(path.join(dir, "scores.jsonl"), { force: true });
writeJson("clone.json", snap({ logo: el(), nav_first: nav({ color: "rgb(255,0,0)", size: 30 }) }, 1728));
const s1 = runScore();
ok(s1.code === 1 && !/STALLED/.test(s1.out), "score run 1 (2 fails): no banner");
ok(!/STALLED/.test(runScore().out), "score run 2 (no improvement): no banner yet");
const s3 = runScore();
ok(s3.code === 1 && /STALLED/.test(s3.out) && /pingfusi assist/.test(s3.out), "score run 3 (no improvement): STALLED banner with the assist commands");
writeJson("clone.json", snap({ logo: el(), nav_first: nav({ color: "rgb(255,0,0)", size: 30 }) }, 1440));
ok(!/STALLED/.test(runScore().out), "a width-mismatched run never banners — its numbers are not trustworthy");
writeJson("clone.json", snap({ logo: el(), nav_first: nav({ color: "rgb(255,0,0)", size: 30 }) }, 1728));
ok(/STALLED/.test(runScore().out), "the streak survives across the skipped mismatch run");
writeJson("clone.json", snap({ logo: el(), nav_first: nav({ size: 30 }) }, 1728));
ok(!/STALLED/.test(runScore().out), "an improving run (2 fails → 1) clears the banner");

process.exitCode = failed ? 1 : 0;
console.log(failed ? `\n✗ ${failed} assertion(s) failed` : "\n✓ assist-selftest green");
