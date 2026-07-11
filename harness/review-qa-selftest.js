// harness/review-qa-selftest.js — guards the review phase tooling (harness/review-qa.js).
// Offline + socket-free: the API is mocked via PPK_PINGHUMANS_URL=file://… (canned
// get_test_results-<ping>.json / request_review.json responses on disk).
// Asserts the contracts that make the review gate trustworthy:
//   - the generated test spec is SCOPE-PINNED, per-leaf from coverage.json, with the
//     behavior step marked informational (stripe lessons encoded, not tribal)
//   - localhost draft urls are refused (a remote reviewer can't open them)
//   - file → records the round; verify → pending/rejected exit 1 (with the reviewer's flag
//     surfaced), approved exit 0; a REFILE makes verify judge the LATEST round only
//   - verify re-fetches every time (a cached approval is never trusted — the state file
//     is updated from the API on each call)
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const KIT = path.resolve(__dirname, "..");
const HQ = path.join(KIT, "harness", "review-qa.js");
let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed++; console.log(`  ✗ ${msg}`); } };

const MOCK = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-hq-"));
const NAME = "hqselftest_" + process.pid;
const dir = path.join(KIT, "targets", NAME);
process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(MOCK, { recursive: true, force: true }); } catch (e) {} });
fs.rmSync(dir, { recursive: true, force: true }); // pre-clean a stale target dir only — MOCK was just created
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "target.json"), JSON.stringify({ name: NAME, url: "https://example.com/", width: 1512 }));
fs.writeFileSync(path.join(dir, "coverage.json"), JSON.stringify(["logo", "nav_product", "nav_pricing", "download_btn", "signin_btn", "locale_caret"]));

const run = (args, env) => { const r = cp.spawnSync(process.execPath, [HQ, ...args], { encoding: "utf8", cwd: KIT, env: { ...process.env, PPK_PINGHUMANS_URL: "file://" + MOCK, ...env } }); return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }; };
// deterministic login state regardless of the machine's real ~/.config credentials:
// "" = behave as if no login exists (the resolveToken opt-out hook)
const runNoLogin = (args) => run(args, { PPK_PINGHUMANS_TOKEN: "" });
const runLoggedIn = (args) => run(args, { PPK_PINGHUMANS_TOKEN: "tok-selftest" });

console.log("review-qa-selftest — the review phase tooling");

// ── template: scope-pinned, coverage-driven, behavior informational ───────────
const t = run(["template", NAME, "--draft", "https://x.trycloudflare.com", "--region", "the top navigation header"]);
ok(t.code === 0, "template generates");
const spec = JSON.parse(t.out);
ok(/ONLY about the top navigation header/.test(spec.steps[0].text), "step 1 scope-pins the comparison region");
ok(spec.steps.some((s) => /logo, nav product/.test(s.text) && s.options), "per-leaf compare steps generated from coverage.json (slugs → words)");
ok(spec.steps.filter((s) => /Compare these elements/.test(s.text)).length === 2, "6 leaves chunk into 2 compare steps (≤5 each)");
ok(spec.steps.some((s) => /INFORMATIONAL/.test(s.text) && /does not affect your verdict/.test(s.text)), "behavior step is informational, never a fail criterion");
ok(spec.verdict_options.length === 3 && spec.approve_verdicts[0] === spec.verdict_options[0], "approve verdict = first verdict option");
ok(spec.require_evidence === "screenshot" && spec.url === "https://example.com/", "screenshot required; original url from target.json");
// 3 of the first 3 real reviewer responses were comment-only (choice:null) — the verdict pick
// must be an explicit REQUIRED final step, or the review gate never passes (astryx round 3)
const lastStep = spec.steps[spec.steps.length - 1];
ok(/FINAL REQUIRED STEP/.test(lastStep.text) && lastStep.text.includes(spec.verdict_options[0]) && /pick a verdict|comment-only/i.test(spec.instructions), "verdict pick is a REQUIRED final step + demanded in instructions (reviewers default to comment-only)");

// documented deviations are surfaced TO THE REVIEWER (astryx round 3 re-flagged an excused cell)
// — but only PRIMARY entries: "See <key> — same phenomenon" cross-references are gate
// bookkeeping, and 14 of them once rendered the whole step as unreadable mush (round 5)
fs.writeFileSync(path.join(dir, "behavior-deviations.json"), JSON.stringify({
  "mutation:div.bento": { reason: "3 cells mount a nested miniature app preview — excluded" },
  "mutation:_r_7q_": { reason: "See mutation:div.bento — same phenomenon" },
  "mutation:_r_94_": { reason: "See mutation:div.bento — same phenomenon" },
}));
const tDev = JSON.parse(run(["template", NAME, "--draft", "https://x.trycloudflare.com", "--region", "the header"]).out);
const devStep = tDev.steps.find((s) => /KNOWN, INTENTIONAL/.test(s.text));
ok(devStep && /nested miniature app preview/.test(devStep.text) && /should NOT flag/.test(tDev.instructions), "behavior-deviations.json entries appear as a do-not-flag step + in instructions");
ok(devStep && !/_r_7q_|_r_94_|See mutation/.test(devStep.text), "cross-reference deviation entries are hidden from the reviewer-facing step (primaries only)");
fs.rmSync(path.join(dir, "behavior-deviations.json"));

// A LARGE number of primary deviation entries (iphone17 round 5 hit 34) must never blow
// `instructions` past pingfusi' hard cap (observed: 1000 chars) — instructions gets a
// short, FIXED-SIZE pointer to the dedicated step regardless of entry count; only the
// step itself (already 300-char-budgeted per entry) scales with count. Before the fix,
// `instructions` duplicated the full per-entry list and grew unboundedly with entry count,
// silently exceeding 1000 chars past ~15 entries and failing the whole filing.
const manyDev = {};
for (let i = 0; i < 40; i++) manyDev[`mutation:item_${i}`] = { reason: `Deviation number ${i} — a reasonably detailed excuse explaining why this one is fine to skip and not worth flagging in the review.` };
fs.writeFileSync(path.join(dir, "behavior-deviations.json"), JSON.stringify(manyDev));
const tManyDev = JSON.parse(run(["template", NAME, "--draft", "https://x.trycloudflare.com", "--region", "the header"]).out);
ok(tManyDev.instructions.length <= 1000, `instructions stays under the 1000-char API cap with 40 deviation entries (got ${tManyDev.instructions.length})`);
ok(/should NOT flag/.test(tManyDev.instructions), "instructions still points the reviewer at the do-not-flag step with 40 deviation entries");
fs.rmSync(path.join(dir, "behavior-deviations.json"));

// --changelog surfaces "what changed since your last review" up front (iphone17 round 10's
// verdict was "did you fix anything?" — the substantive change was invisible untold)
const tChg = JSON.parse(run(["template", NAME, "--draft", "https://x.trycloudflare.com", "--region", "the header", "--changelog", "the camera intro now scrubs with scroll — scroll slowly through it"]).out);
ok(/CHANGED SINCE YOUR LAST REVIEW: the camera intro now scrubs/.test(tChg.instructions) && /check these first/.test(tChg.steps[1].text), "--changelog lands in instructions AND as the second step");
const tNoChg = JSON.parse(run(["template", NAME, "--draft", "https://x.trycloudflare.com", "--region", "the header"]).out);
ok(!/CHANGED SINCE/.test(tNoChg.instructions), "no --changelog → no change note (first rounds stay clean)");
// the changelog STEP must never exceed the 300-char API cap (52-prefix + slice(250) = 302
// failed a live filing — iphone17 round 13)
const tLongChg = JSON.parse(run(["template", NAME, "--draft", "https://x.trycloudflare.com", "--region", "the header", "--changelog", "x".repeat(400)]).out);
const chgStep = tLongChg.steps.find((s) => /check these first/.test(s.text));
ok(chgStep && chgStep.text.length <= 300, `changelog step stays within the 300-char cap (got ${chgStep ? chgStep.text.length : "none"})`);

// localhost drafts refused
ok(run(["template", NAME, "--draft", "http://localhost:8199"]).code === 1, "localhost draft url refused (remote reviewers can't open it)");

// ── file: records a round via the (mocked) API ───────────────────────────────
const PING1 = "00000000-0000-4000-8000-0000000000a1";
fs.writeFileSync(path.join(MOCK, "request_review.json"), JSON.stringify({ ping_id: PING1, status: "pending" }));
const f = run(["file", NAME, "--draft", "https://x.trycloudflare.com", "--region", "the header"]);
ok(f.code === 0 && f.out.includes(PING1), "file records round 1 with the returned ping_id");
const hq1 = JSON.parse(fs.readFileSync(path.join(dir, "review-qa.json"), "utf8"));
ok(hq1.rounds.length === 1 && hq1.rounds[0].ping_id === PING1 && hq1.rounds[0].approve_verdicts.length === 1, "review-qa.json round 1 shape correct");

// ── verify: pending → 1, comment-only → 1, rejected → 1 with flag, approved → 0 ──
// Mocks use the REAL pingfusi response schema (verified empirically 2026-07-02):
// the verdict pick is `choice`, prose is `free_text`. (workflow-selftest's mocks use
// the legacy `verdict`/`notes` keys, covering the fallback mapping.)
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING1}.json`), JSON.stringify({ status: "pending", n_received: 0, n_target: 1, responses: [] }));
ok(run(["verify", NAME]).code === 1, "verify exits 1 while pending");
// comment-only response (choice:null) — approval must NEVER be inferred from prose,
// even prose that contains the approve verdict verbatim (paid for on opendesign round 2)
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING1}.json`), JSON.stringify({ status: "complete", n_received: 1, n_target: 1, responses: [{ choice: null, free_text: "1 comment(s): <div> — Header identical" }] }));
const unpicked = run(["verify", NAME]);
ok(unpicked.code === 1 && /NO verdict pick/.test(unpicked.out) && /Header identical/.test(unpicked.out), "a comment-only response (choice:null) fails the gate even when the prose says the approve verdict");
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING1}.json`), JSON.stringify({ status: "complete", n_received: 1, n_target: 1, responses: [{ choice: "Header clearly different", free_text: "sign in button color off" }] }));
const rej = run(["verify", NAME]);
ok(rej.code === 1 && /sign in button color off/.test(rej.out), "verify exits 1 on rejection and surfaces the reviewer's notes (the fix list)");
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING1}.json`), JSON.stringify({ status: "complete", n_received: 1, n_target: 1, responses: [{ choice: "Header identical", free_text: null }] }));
ok(run(["verify", NAME]).code === 0, "verify exits 0 on approval");
const cached = JSON.parse(fs.readFileSync(path.join(dir, "review-qa.json"), "utf8"));
ok(cached.rounds[0].last.responses[0].verdict === "Header identical" && cached.rounds[0].checked_at, "verify caches the fetched result + timestamp (receipt content)");

// ── refile: verify judges the LATEST round, not a stale approval ─────────────
const PING2 = "00000000-0000-4000-8000-0000000000a2";
fs.writeFileSync(path.join(MOCK, "request_review.json"), JSON.stringify({ ping_id: PING2, status: "pending" }));
ok(run(["file", NAME, "--draft", "https://x.trycloudflare.com", "--region", "the header"]).code === 0, "refile records round 2");
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING2}.json`), JSON.stringify({ status: "pending", n_received: 0, n_target: 1, responses: [] }));
ok(run(["verify", NAME]).code === 1, "after a refile, verify judges round 2 — round 1's approval no longer passes");

// ── record: adopting an externally-filed ping requires the approve verdicts ──
ok(run(["record", NAME, PING2]).code === 2, "record without --approve refused (approval set must be explicit)");
ok(run(["record", NAME, "not-a-uuid", "--approve", "Pass"]).code === 2, "record with a malformed ping_id refused");

// ── expired round is a refile, not a pass ─────────────────────────────────────
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING2}.json`), JSON.stringify({ status: "expired", n_received: 0, n_target: 1, responses: [] }));
const exp = run(["verify", NAME]);
ok(exp.code === 1 && /EXPIRED/.test(exp.out), "an expired unanswered round fails verify with a refile hint");

// ── poll: mid-round micro-checks — advisory, recorded, never a gate input ────
{
  fs.writeFileSync(path.join(MOCK, "quick_poll.json"), JSON.stringify({ ping_id: "00000000-0000-4000-8000-00000000p0ll", status: "complete", n_received: 1, n_target: 1, responses: [{ choice: "Yes", free_text: "tiles look right now" }] }));
  const p1 = run(["poll", NAME, "do the 3 tiles look right now?", "--choices", "Yes,No"]);
  ok(p1.code === 0 && /\[Yes\]/.test(p1.out) && /tiles look right now/.test(p1.out), "poll prints the reviewer's answer and exits 0 when answered");
  const hqAfter = JSON.parse(fs.readFileSync(path.join(dir, "review-qa.json"), "utf8"));
  ok(hqAfter.polls && hqAfter.polls.length === 1 && hqAfter.polls[0].question.startsWith("do the 3 tiles"), "poll recorded in review-qa.json (audit trail), separate from rounds");
  ok(hqAfter.rounds.length === 2, "polls do NOT create rounds — the review gate still judges full rounds only");
  fs.writeFileSync(path.join(MOCK, "quick_poll.json"), JSON.stringify({ ping_id: "00000000-0000-4000-8000-00000000pend", status: "pending", n_received: 0, n_target: 1, responses: [] }));
  const p2 = run(["poll", NAME, "second question"]);
  ok(p2.code === 1 && /0 answers yet/.test(p2.out) && /poll-result/.test(p2.out), "unanswered poll exits 1 with the free re-check command");
  fs.writeFileSync(path.join(MOCK, "get_ping-00000000-0000-4000-8000-00000000pend.json"), JSON.stringify({ status: "complete", n_received: 1, responses: [{ choice: null, free_text: "late answer" }] }));
  const p3 = run(["poll-result", NAME, "00000000-0000-4000-8000-00000000pend"]);
  ok(p3.code === 0 && /late answer/.test(p3.out), "poll-result picks up a late answer and exits 0");

  // comparison-shaped questions are REFUSED from the poll channel (reviewer flagged twice:
  // "does the clone match the real page" needs the side-by-side UI, not a text ping)
  const cmp = run(["poll", NAME, "Do the highlight cards on the clone scroll and auto-advance like the real page?"]);
  ok(cmp.code === 1 && /COMPARISON/.test(cmp.out) && /file --region|--region/.test(cmp.out), "a question naming both the clone and the live page is refused with the file --region hint");
  const oneSided = run(["poll", NAME, "On the real page, does the camera video scrub as you scroll?"]);
  ok(oneSided.code === 0 || /pending|0 answers/.test(oneSided.out), "a one-sided live-observation question still polls fine");
  const overridden = run(["poll", NAME, "Compare our draft against the original page price note — acceptable?", "--allow-comparison"]);
  ok(overridden.code === 0 || /pending|0 answers/.test(overridden.out), "--allow-comparison consciously overrides the refusal");
}

// ── LOCAL review mode is REMOVED (2026-07-10): the independent reviewer on the review
// service is the ONLY path. These lock the removal: the flags refuse loudly (an old doc
// or an agent's stale memory must hit a wall, not a silent no-op), serve.js no longer
// ships the /__review machinery, and a legacy local round can never pass verify.
{
  const fLocal = runLoggedIn(["file", NAME, "--local", "--region", "the header"]);
  ok(fLocal.code === 1 && /local review mode was removed/.test(fLocal.out) && /pingfusi setup/.test(fLocal.out), "file --local refuses: mode removed, points at setup");
  const fAllow = runNoLogin(["file", NAME, "--allow-local", "--region", "the header"]);
  ok(fAllow.code === 1 && /local review mode was removed/.test(fAllow.out), "--allow-local refuses the same way (no backdoor)");
  const serveExports = require("./serve.js");
  ok(!serveExports.applySubmission && !serveExports.renderReviewPage, "serve.js no longer exports the /__review machinery");
  // a legacy provider:"local" round from an old kit version can't sneak through verify
  const hqLegacy = JSON.parse(fs.readFileSync(path.join(dir, "review-qa.json"), "utf8"));
  hqLegacy.rounds.push({ ping_id: "local-deadbeef", provider: "local", approve_verdicts: ["Header identical"], raw_response: { status: "complete", n_received: 1, n_target: 1, responses: [{ choice: "Header identical" }] } });
  fs.writeFileSync(path.join(dir, "review-qa.json"), JSON.stringify(hqLegacy, null, 2));
  const vLegacy = run(["verify", NAME]);
  ok(vLegacy.code === 1 && /LOCAL round from a removed mode/.test(vLegacy.out), "verify refuses a legacy local round by name (never operator-trusted approval)");
  hqLegacy.rounds.pop();
  fs.writeFileSync(path.join(dir, "review-qa.json"), JSON.stringify(hqLegacy, null, 2));
}

// ── filing while pre-review gates are red is refused (astryx round-2 process miss) ──
// A workflow.json whose phases predate `behavior` counts the missing key as PENDING —
// exactly the astryx state when the premature round was filed.
fs.writeFileSync(path.join(dir, "workflow.json"), JSON.stringify({
  name: NAME, phaseOrder: ["target", "assets", "measure", "build", "visual", "coverage", "strict", "review", "done"],
  phases: Object.fromEntries(["target", "assets", "measure", "build", "visual", "coverage", "strict"].map((k) => [k, { status: "pass" }])),
}));
const premature = run(["file", NAME, "--draft", "https://x.trycloudflare.com", "--region", "the header"]);
ok(premature.code === 1 && /behavior/.test(premature.out) && /refusing to file/.test(premature.out), "file refuses while a pre-review phase is pending — names it (missing key = pending, not exempt)");
const anyway = run(["file", NAME, "--draft", "https://x.trycloudflare.com", "--region", "the header", "--anyway"]);
ok(anyway.code === 0 && /--anyway/.test(anyway.out), "--anyway overrides with a printed warning (deliberate out-of-band round)");
fs.rmSync(path.join(dir, "workflow.json")); // standalone usage (no workflow.json) keeps filing freely — proven by every earlier case above

console.log(failed ? `\n❌ review-qa-selftest: ${failed} assertion(s) failed.` : `\n✓ review-qa-selftest: all assertions pass.`);
process.exit(failed ? 1 : 0);
