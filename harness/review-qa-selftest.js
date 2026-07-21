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
const BIN = path.join(KIT, "bin", "pingfusi");
let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed++; console.log(`  ✗ ${msg}`); } };

const MOCK = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-hq-"));
const NAME = "hqselftest_" + process.pid;
const dir = path.join(KIT, "targets", NAME);
const MOTION_NAME = "hqmotion_" + process.pid;
const motionDir = path.join(KIT, "targets", MOTION_NAME);
process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(motionDir, { recursive: true, force: true }); fs.rmSync(MOCK, { recursive: true, force: true }); } catch (e) {} });
fs.rmSync(dir, { recursive: true, force: true }); // pre-clean a stale target dir only — MOCK was just created
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "target.json"), JSON.stringify({ name: NAME, url: "https://example.com/", width: 1512 }));
fs.writeFileSync(path.join(dir, "coverage.json"), JSON.stringify(["logo", "nav_product", "nav_pricing", "download_btn", "signin_btn", "locale_caret"]));

const run = (args, env) => { const r = cp.spawnSync(process.execPath, [HQ, ...args], { encoding: "utf8", cwd: KIT, env: { ...process.env, PPK_PINGHUMANS_URL: "file://" + MOCK, ...env } }); return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }; };
const runPing = (args) => { const r = cp.spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", cwd: KIT, env: { ...process.env, PPK_PINGHUMANS_URL: "file://" + MOCK } }); return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }; };
// deterministic login state regardless of the machine's real ~/.config credentials:
// "" = behave as if no login exists (the resolveToken opt-out hook)
const runNoLogin = (args) => run(args, { PPK_PINGHUMANS_TOKEN: "" });
const runLoggedIn = (args) => run(args, { PPK_PINGHUMANS_TOKEN: "tok-selftest" });

console.log("review-qa-selftest — the review phase tooling");

// ── template: scope-pinned, coverage-driven, structured motion handoff ────────
const t = run(["template", NAME, "--draft", "https://x.trycloudflare.com", "--region", "the top navigation header"]);
ok(t.code === 0, "template generates");
const spec = JSON.parse(t.out);
ok(/judging the top navigation header of /.test(spec.steps[0].text) && /out of scope/.test(spec.steps[0].text), "step 1 scope-pins the comparison region (names it + rules everything else out of scope)");
ok(spec.steps.some((s) => /logo, nav product/.test(s.text) && s.options), "per-leaf compare steps generated from coverage.json (slugs → words)");
// Leaves are packed DENSELY (as many per step as the 300-char text cap allows), not at a fixed
// 5-per-step: the fixed rule blew the service's 20-STEP cap the first time a target was gated at
// region:page (lelabo, 80 leaves → 16 leaf steps + 6 fixed = 22 → the whole filing was rejected
// with a Zod "too_big", so the round could not be filed at all). 6 short leaves now fit one step.
ok(spec.steps.filter((s) => /Compare these elements/.test(s.text)).length === 1, "6 short leaves pack into 1 dense compare step (300-char cap, not a fixed 5)");
ok(spec.steps.every((s) => s.text.length <= 300), "every step honours the 300-char text cap");
// First-draft doctrine: the motion routing probe is gone — motion is machine-checked in
// the build; the reviewer notes motion issues like any other observation.
ok(!spec.review_contract && !spec.steps.some((s) => /ROUTING ONLY|Temporal difference observed/.test(s.text || "")), "the page round carries no motion routing probe and no review contract");
ok(spec.steps.some((s) => /including motion that is missing, different, or mistimed/.test(s.text || "")), "the describe step invites motion observations as ordinary notes");
ok(spec.n_target === 1, "full review templates default to one reviewer");
{
  const quick = JSON.parse(run(["template", NAME, "--draft", "https://x.trycloudflare.com", "--results", "1"]).out);
  const deep = JSON.parse(run(["template", NAME, "--draft", "https://x.trycloudflare.com", "--results", "20"]).out);
  const diagnostic = JSON.parse(run(["template", NAME, "--diagnostic", "--draft", "https://x.trycloudflare.com", "--region", "the header", "--results", "15"]).out);
  ok(quick.n_target === 1 && deep.n_target === 20 && diagnostic.n_target === 15,
    "--results selects quick, deep, and diagnostic result targets within the 1..20 service range");
  for (const bad of ["0", "21", "1.5", "five"]) {
    const invalid = run(["template", NAME, "--draft", "https://x.trycloudflare.com", "--results", bad]);
    ok(invalid.code === 2 && /--results must/.test(invalid.out), `--results ${bad} is a usage error`);
  }
  const pollDepth = run(["poll", NAME, "question", "--results", "5"]);
  ok(pollDepth.code === 2 && /polls always target 1 result/.test(pollDepth.out), "polls reject --results because their depth is fixed at 1");
}

// A region:page target has HUNDREDS of painted leaves, not a dozen. The review service caps a
// round at 20 STEPS, and the old fixed "5 leaves per step" walked straight into it (lelabo: 80
// leaves → 16 leaf steps + 6 fixed = 22 → the service rejected the ENTIRE filing with a Zod
// "too_big"; the round could not be filed at all, which is a hard stop on the review phase for
// every full-page clone). Lock both halves of the contract: the round must FIT, and it must not
// quietly forget leaves it was told to cover — an unlisted leaf reads to the reviewer as "not
// part of this clone", the exact unverified-territory failure the region rule exists to prevent.
{
  const big = Array.from({ length: 80 }, (_, i) => `painted_leaf_number_${i}`);
  fs.writeFileSync(path.join(dir, "coverage.json"), JSON.stringify(big));
  const t2 = run(["template", NAME, "--draft", "https://x.trycloudflare.com", "--region", "the entire page"]);
  const spec2 = JSON.parse(t2.out.slice(t2.out.indexOf("{")));
  ok(spec2.steps.length <= 20, `region:page (80 leaves) fits the 20-step service cap (got ${spec2.steps.length})`);
  ok(spec2.steps.every((s) => s.text.length <= 300), "every step still honours the 300-char cap at 80 leaves");
  const listed = spec2.steps.filter((s) => /Compare these elements/.test(s.text)).map((s) => s.text).join(" ");
  // review-qa renders coverage slugs as words (nav_product → "nav product") — compare that form
  const unlisted = big.filter((l) => !listed.includes(l.replace(/_/g, " ")));
  const disclosed = spec2.steps.some((s) => /Also scan the REST of the region/.test(s.text));
  ok(unlisted.length === 0 || disclosed, "no covered leaf is silently dropped — either listed, or the round says how many were not");
  fs.writeFileSync(path.join(dir, "coverage.json"), JSON.stringify(["logo", "nav_product", "nav_pricing", "download_btn", "signin_btn", "locale_caret"]));
}

// …and at a scale where the leaves CANNOT all be listed. 80 leaves happened to overflow by so
// little that the budget bug hid: the "Also scan the REST" notice is ITSELF a step, and it was
// pushed on top of an already-full 20 without being reserved for. chrono24 (396 painted leaves at
// region:page) made it visible — 21 steps, and the service rejected the ENTIRE filing with a Zod
// `too_big`, which is a hard stop on the review phase for any large full-page clone. The notice
// must be budgeted BEFORE deciding how many leaf groups fit, and the same goes for the changelog
// step spliced in on a refile.
{
  const huge = Array.from({ length: 396 }, (_, i) => `painted_leaf_number_${i}`);
  fs.writeFileSync(path.join(dir, "coverage.json"), JSON.stringify(huge));

  // the ⚠ overflow notice shares the stream — slice the JSON object precisely, not "from the first {"
  const jsonOf = (out) => JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  const t3 = run(["template", NAME, "--draft", "https://x.trycloudflare.com", "--region", "the entire page"]);
  const spec3 = jsonOf(t3.out);
  ok(spec3.steps.length <= 20, `region:page (396 leaves) FITS the 20-step cap including the overflow notice (got ${spec3.steps.length})`);
  ok(spec3.steps.every((s) => s.text.length <= 300), "every step still honours the 300-char cap at 396 leaves");
  ok(spec3.steps.some((s) => /Also scan the REST of the region/.test(s.text)),
    "the round still DISCLOSES the leaves it could not list (never a silent drop)");
  const last3 = spec3.steps[spec3.steps.length - 1];
  ok(/FINAL REQUIRED STEP/.test(last3.text), "the verdict step survives the squeeze (it is never the one dropped)");

  // a REFILE at the same scale: the changelog step is spliced in, so it must be budgeted too
  const t4 = run(["template", NAME, "--draft", "https://x.trycloudflare.com", "--region", "the entire page",
    "--changelog", "rebuilt the capture so the search bar is no longer an empty mount point"]);
  const spec4 = jsonOf(t4.out);
  ok(spec4.steps.length <= 20, `a REFILE (changelog step spliced in) still fits the cap at 396 leaves (got ${spec4.steps.length})`);
  ok(spec4.steps.some((s) => /Changed since the last review/.test(s.text)), "the refile still tells the reviewer what changed");

  fs.writeFileSync(path.join(dir, "coverage.json"), JSON.stringify(["logo", "nav_product", "nav_pricing", "download_btn", "signin_btn", "locale_caret"]));
}
ok(spec.verdict_options.length === 3 && spec.approve_verdicts[0] === spec.verdict_options[0], "approve verdict = first verdict option");
ok(spec.require_evidence === "screenshot" && spec.url === "https://example.com/", "screenshot required; original url from target.json");
// 3 of the first 3 real reviewer responses were comment-only (choice:null) — the verdict pick
// must be an explicit REQUIRED final step, or the review gate never passes (astryx round 3)
const lastStep = spec.steps[spec.steps.length - 1];
ok(/FINAL REQUIRED STEP/.test(lastStep.text) && lastStep.text.includes(spec.verdict_options[0]) && /pick a verdict|comment-only/i.test(spec.instructions), "verdict pick is a REQUIRED final step + demanded in instructions (reviewers default to comment-only)");
// …and while the picker is BROKEN (no options render on the verdict step), the step must tell the
// reviewer what actually works: type the verdict VERBATIM. Six reviewers across lelabo and chrono24
// answered every option-bearing step, found no buttons on the verdict question, improvised a
// paraphrase ("cloned page identical" for "Cloned region identical") — and `verify`'s exact-match
// exception rightly refused it. An instruction the reviewer cannot follow costs a whole paid round.
ok(/COPY ONE OF THESE LINES EXACTLY|EXACTLY into the comment/i.test(lastStep.text) && /paraphrase/i.test(lastStep.text),
  "the verdict step tells the reviewer to TYPE the verdict verbatim when no buttons render (and that a paraphrase does not count)");

// THE ROUND MUST NAME THE REGION THE TARGET DECLARED. target.json persists `region` before the
// first capture so every consumer reads the same scope; the review round was the last one still
// re-deciding it, and a region:page target was being shown a round about "the cloned region" whose
// verdict read "Cloned region identical" — which is what pushed a reviewer into paraphrasing.
{
  const tj = path.join(dir, "target.json");
  const saved = fs.readFileSync(tj, "utf8");
  fs.writeFileSync(tj, JSON.stringify({ name: NAME, url: "https://example.com/", width: 1512, region: "page" }));
  const tp = run(["template", NAME, "--draft", "https://x.trycloudflare.com"]);   // NO --region flag
  const sp = JSON.parse(tp.out.slice(tp.out.indexOf("{"), tp.out.lastIndexOf("}") + 1));
  ok(/entire page/i.test(sp.instructions), "region:page in target.json → the round says 'the entire page' (not the generic 'cloned region')");
  ok(sp.verdict_options[0] === "Entire page identical",
    `…and the verdict options follow the declared region (got "${sp.verdict_options[0]}")`);
  fs.writeFileSync(tj, saved);
}

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
const PING_DIAGNOSTIC = "00000000-0000-4000-8000-0000000000d1";
fs.writeFileSync(path.join(MOCK, "request_review.json"), JSON.stringify({ ping_id: PING_DIAGNOSTIC, status: "pending" }));
// The temporal word list is LEXICAL, so it may only warn: "the hero heading moved 4px
// left" is a legitimate static filing that matches it. It must never exit 1.
const temporalDiagnostic = run(["file", NAME, "--draft", "https://x.trycloudflare.com", "--diagnostic", "--region", "the expanding hero circle", "--ask", "Does its scroll animation match?"]);
ok(temporalDiagnostic.code === 0 && /⚠/.test(temporalDiagnostic.out) && /pingfusi next/.test(temporalDiagnostic.out) && /filed diagnostic round/.test(temporalDiagnostic.out),
  "temporal wording warns (with the motion routing hint) but no longer blocks the filing — lexical grounds never exit 1");
const staticMovedFiling = run(["file", NAME, "--draft", "https://x.trycloudflare.com", "--diagnostic", "--region", "the hero", "--ask", "The hero heading moved 4px left - confirm?"]);
ok(staticMovedFiling.code === 0 && /filed diagnostic round/.test(staticMovedFiling.out),
  "a static ask that merely uses a movement word ('moved 4px left') files fine");
const layoutDiagnostic = run(["file", NAME, "--draft", "https://x.trycloudflare.com", "--diagnostic", "--region", "the header grid", "--ask", "Are the margins and column alignment correct?"]);
ok(layoutDiagnostic.code === 0 && /filed diagnostic round/.test(layoutDiagnostic.out) && !/⚠ the requested/.test(layoutDiagnostic.out), "a layout-only scoped diagnostic files without any temporal warning");
fs.writeFileSync(path.join(MOCK, "request_review.json"), JSON.stringify({ ping_id: PING1, status: "pending" }));
const f = run(["file", NAME, "--draft", "https://x.trycloudflare.com", "--region", "the header", "--results", "5"]);
ok(f.code === 0 && f.out.includes(PING1), "file records round 1 with the returned ping_id");
const hq1 = JSON.parse(fs.readFileSync(path.join(dir, "review-qa.json"), "utf8"));
ok(hq1.rounds.length === 1 && hq1.rounds[0].ping_id === PING1 && hq1.rounds[0].n_target === 5 && hq1.rounds[0].approve_verdicts.length === 1, "review-qa.json round 1 persists its explicit 5-result target");

// ── verify: pending → 1, comment-only → 1, rejected → 1 with flag, approved → 0 ──
// Mocks use the REAL pingfusi response schema (verified empirically 2026-07-02):
// the verdict pick is `choice`, prose is `free_text`. (workflow-selftest's mocks use
// the legacy `verdict`/`notes` keys, covering the fallback mapping.)
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING1}.json`), JSON.stringify({ status: "pending", n_received: 0, n_target: 1, responses: [] }));
ok(run(["verify", NAME]).code === 1, "verify exits 1 while pending");
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING1}.json`), JSON.stringify({ status: "pending", n_received: 1, n_target: 5, responses: [{ choice: "Header identical", free_text: null }] }));
{
  const partial = run(["verify", NAME]);
  ok(partial.code === 1 && /1\/5 responses/.test(partial.out) && /requested result depth/.test(partial.out),
    "one early approval cannot pass a standard round while the other requested results are still collecting");
}
// comment-only response (choice:null) — approval must NEVER be inferred from prose,
// even prose that contains the approve verdict verbatim (paid for on opendesign round 2)
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING1}.json`), JSON.stringify({ status: "complete", n_received: 1, n_target: 1, responses: [{ choice: null, free_text: "1 comment(s): <div> — Header identical" }] }));
const unpicked = run(["verify", NAME]);
ok(unpicked.code === 1 && /NO verdict pick/.test(unpicked.out) && /Header identical/.test(unpicked.out), "a comment-only response (choice:null) fails the gate even when the prose says the approve verdict");

// …with ONE narrow exception, added 2026-07-12 and TEMPORARY — see below. The reviewer-facing UI
// can make the pick IMPOSSIBLE: the final verdict step is filed with no `options` array, and the
// round-level `verdict_options` is not rendered as a picker, so the verdict question shows nothing
// to choose from. Measured on lelabo rounds 4-5: two reviewers answered every option-bearing step
// ("Identical" x6, "Could not tell apart", "Same on both") and then typed the approving verdict
// verbatim into the only field they had — a comment ON THE VERDICT STEP — and both responses came
// back choice:null. The round was unpassable for every target, and the missing button was not the
// reviewer's fault.
//
// The exception accepts ONLY a comment on the VERDICT STEP whose text exactly equals a declared
// approve verdict, and receipts it as `free_text_exact_match` so it can never be mistaken for a
// real pick. It deliberately does NOT match prose elsewhere — the assertion above (a pin comment
// on a <div> reading "Header identical", paid for on opendesign round 2) must keep failing, and
// does.
//
// REMOVE THIS EXCEPTION once the pinghumans verdict picker renders `verdict_options`. It is a
// workaround for a UI defect, not a rule we want.
const VSTEP = 3; // last step index in the mock's steps_result below
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING1}.json`), JSON.stringify({
  status: "complete", n_received: 1, n_target: 1,
  responses: [{ choice: null, free_text: "4 comment(s): ? — ok | ? — Header identical", steps_result: [{}, {}, {}, {}] }],
  comments: [{ text: "ok", step_index: 0 }, { text: "Header identical", step_index: VSTEP }],
}));
const matched = run(["verify", NAME]);
ok(matched.code === 0 && /free_text_exact_match/.test(matched.out), "a verdict-step comment that EXACTLY equals the approve verdict is accepted (the picker renders no options) and receipted as free_text_exact_match");

// the same exception must NOT fire for approving-sounding prose that is not the verdict string
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING1}.json`), JSON.stringify({
  status: "complete", n_received: 1, n_target: 1,
  responses: [{ choice: null, free_text: "1 comment(s): ? — looks good to me", steps_result: [{}, {}, {}, {}] }],
  comments: [{ text: "looks good to me", step_index: VSTEP }],
}));
ok(run(["verify", NAME]).code === 1, "approving-sounding prose on the verdict step ('looks good to me') still fails — the exception is an exact match, not a sentiment read");

// The verdict strings now RIDE ON THE STEP as `options` — option-bearing steps render as
// pickers in today's reviewer app even while the round-level button is missing — so a
// TAPPED option arrives as the verdict step's steps_result `answer` and must count as the
// verdict, for approval AND rejection, receipted as verdict_step_answer. Paraphrases in
// the same field still fail: this is the button's information through a working control,
// never a sentiment read.
ok(Array.isArray(lastStep.options) && lastStep.options.join("|") === spec.verdict_options.join("|"), "the verdict step carries the round's verdict strings as tappable options");
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING1}.json`), JSON.stringify({
  status: "complete", n_received: 1, n_target: 1,
  responses: [{ choice: null, free_text: null, steps_result: [{}, {}, {}, { answer: "Header identical" }] }],
}));
{ const r = run(["verify", NAME]); ok(r.code === 0 && /verdict_step_answer/.test(r.out), "a TAPPED approve option on the verdict step passes and is receipted as verdict_step_answer"); }
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING1}.json`), JSON.stringify({
  status: "complete", n_received: 1, n_target: 1,
  responses: [{ choice: null, free_text: null, steps_result: [{}, {}, {}, { answer: "Header clearly different" }] }],
}));
{ const r = run(["verify", NAME]); ok(r.code === 1 && /NOT approved/.test(r.out) && !/NO verdict pick/.test(r.out), "a TAPPED rejection is a REJECTION — the round fails as not-approved, never as verdict-less"); }
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING1}.json`), JSON.stringify({
  status: "complete", n_received: 1, n_target: 1,
  responses: [{ choice: null, free_text: null, steps_result: [{}, {}, {}, { answer: "header looks identical" }] }],
}));
ok(run(["verify", NAME]).code === 1, "a paraphrase in the tapped-answer field still fails — exact match only");

// and it must NOT fire when the exact verdict string appears on some OTHER step (the opendesign trap)
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING1}.json`), JSON.stringify({
  status: "complete", n_received: 1, n_target: 1,
  responses: [{ choice: null, free_text: "1 comment(s): <div> — Header identical", steps_result: [{}, {}, {}, {}] }],
  comments: [{ text: "Header identical", step_index: 0 }],
}));
ok(run(["verify", NAME]).code === 1, "the approve verdict as a PIN comment on another step still fails (opendesign round 2: it described an element, it was not a verdict)");
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING1}.json`), JSON.stringify({ status: "complete", n_received: 1, n_target: 1, responses: [{ choice: "Header clearly different", free_text: "sign in button color off" }] }));
const rej = run(["verify", NAME]);
ok(rej.code === 1 && /sign in button color off/.test(rej.out), "verify exits 1 on rejection and surfaces the reviewer's notes (the fix list)");
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING1}.json`), JSON.stringify({
  status: "complete", n_received: 1, n_target: 1,
  responses: [{ choice: "Header clearly different", free_text: "startup animation missing", steps_result: [{}, {}, {}, {}] }],
}));
const proseOnlyMotion = run(["verify", NAME]);
ok(proseOnlyMotion.code === 1 && /startup animation missing/.test(proseOnlyMotion.out) && !fs.existsSync(path.join(dir, "motion-items.json")), "motion-shaped reviewer prose never manufactures motion bookkeeping — it is ordinary rejection notes");
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING1}.json`), JSON.stringify({ status: "complete", n_received: 1, n_target: 1, responses: [{ choice: "Header identical", free_text: null }] }));
ok(run(["verify", NAME]).code === 0, "verify exits 0 on approval");
const cached = JSON.parse(fs.readFileSync(path.join(dir, "review-qa.json"), "utf8"));
ok(cached.rounds[0].last.responses[0].verdict === "Header identical" && cached.rounds[0].checked_at, "verify caches the fetched result + timestamp (receipt content)");

// ── the structured comment envelope: persisted VERBATIM, printed as ⌖ blocks ──
// The compare tools post rich marks (side, selector, target, op, drawn annotation with
// 0..1 points, viewport, rect, dual-anchor other, position); verify used to keep only
// {step_index, text, text_sha256} and print NONE of it — the agent saw a one-line
// verdict while the reviewer's actual marks died in the wire response.
{
  // snapshots for the element cross-check (pure read): viewport width 1512 matches the
  // mark-time viewport of the comments below; the mobile-width comment must NOT match.
  fs.writeFileSync(path.join(dir, "live.json"), JSON.stringify({
    url: "https://example.com/", viewport: { width: 1512, height: 982, dpr: 2 },
    elements: {
      hero_image: { present: true, rect: { x: 120, y: 210, w: 100, h: 80 } },
      hero_heading: { present: true, rect: { x: 90, y: 190, w: 400, h: 200 } },
      far_away_leaf: { present: true, rect: { x: 1000, y: 900, w: 50, h: 50 } },
    },
  }));
  fs.writeFileSync(path.join(dir, "clone.json"), JSON.stringify({
    url: "http://localhost/", viewport: { width: 1512, height: 982, dpr: 2 },
    elements: { cta_button: { present: true, rect: { x: 700, y: 400, w: 180, h: 48 } } },
  }));
  const ALIGN_PROSE = "Alignment (measured at 1512px-wide viewport; element is 180×48px): this element should move -4px right, 12px down and scale ×1.05 to match the original.";
  const richComments = [
    // sticky note: side + selector + target, no annotation
    { step_index: 2, text: "font looks lighter here", side: "draft", selector: "header > h1", target: "<h1> \"Welcome\"" },
    // drawn mark on the ORIGINAL: points are 0..1 fractions of the element box (verbatim)
    { step_index: 1, text: "this corner is clipped", side: "original", selector: "img.hero", target: "<img> hero",
      annotation: { shape: "rect", points: [[0.1, 0.05], [0.48, 0.2]] },
      viewport: { w: 1512, h: 982 }, rect: { x: 100, y: 200, w: 300, h: 150 } },
    // align move: the tx/ty/scale numbers live ONLY in the prose — parsed, never guessed
    { step_index: 1, text: ALIGN_PROSE, side: "draft", selector: "div.cta", target: "<div> CTA", op: "move",
      viewport: { w: 1512, h: 982 }, rect: { x: 700, y: 400, w: 180, h: 48 }, position: { dx: -4, dy: 12, ex: 0, ey: 0 } },
    // dual-anchor: the same tap named the matching element on the OTHER side
    { step_index: 0, text: "match this nav to the original", side: "draft", selector: "nav.main", target: "<nav> Main",
      other: { side: "original", label: "<nav> \"Main navigation\"" } },
    // mark taken at a DIFFERENT viewport width — element match must be skipped, said out loud
    { step_index: 0, text: "mobile-width note", side: "draft", selector: "footer", target: "<footer>",
      viewport: { w: 390, h: 844 }, rect: { x: 0, y: 0, w: 390, h: 100 } },
    // old-shape comment (text-only) from an older round — must keep working untouched
    { step_index: 0, text: "legacy text-only comment" },
  ];
  fs.writeFileSync(path.join(MOCK, `get_test_results-${PING1}.json`), JSON.stringify({
    status: "complete", n_received: 1, n_target: 1,
    responses: [{ choice: "Header identical", free_text: null, steps_result: [{}, {}, {}, {}] }],
    comments: richComments,
  }));
  const approvedRich = run(["verify", NAME]);
  ok(approvedRich.code === 0, "an approved round with rich comments still passes");
  ok(/⌖ DRAFT · <h1> "Welcome" \[header > h1\] — note — "font looks lighter here" \(step 2\)/.test(approvedRich.out),
    "APPROVAL still prints the ⌖ blocks — approved rounds carry notes worth reading");
  ok(/⌖ ORIGINAL · <img> hero \[img\.hero\] — drawn rect — "this corner is clipped"/.test(approvedRich.out),
    "a drawn mark names its side, target, selector and shape");
  ok(/region: x\[10%–48%\] y\[5%–20%\] of the element \(viewport 1512×982\)/.test(approvedRich.out),
    "the annotation points bbox prints as a sub-region of the element");
  ok(/align: move 4px left, 12px down, scale ×1\.05 \(measured at 1512px\)/.test(approvedRich.out),
    "align prose deltas are parsed and printed as actionable numbers");
  ok(/other side: <nav> "Main navigation"/.test(approvedRich.out),
    "a dual-anchor comment prints the matching element on the other side");
  ok(/measured elements under the mark: hero_image, hero_heading/.test(approvedRich.out),
    "the ORIGINAL-side mark is cross-checked against live.json leaves that intersect its rect (most-covered first)");
  ok(/measured elements under the mark: cta_button/.test(approvedRich.out),
    "the DRAFT-side mark is cross-checked against clone.json");
  ok(/\(viewport differs from capture width — skipping element match\)/.test(approvedRich.out),
    "a mark measured at a different viewport width skips the element match and says so");

  // persistence: the full envelope survives into review-qa.json, absent-tolerant
  const hqRich = JSON.parse(fs.readFileSync(path.join(dir, "review-qa.json"), "utf8"));
  const kept = hqRich.rounds[0].last.comments;
  ok(kept.length === richComments.length && /^[0-9a-f]{64}$/.test(hqRich.rounds[0].last.result_sha256),
    "every comment is persisted and result_sha256 still hashes the full envelope");
  const drawn = kept.find((c) => c.selector === "img.hero");
  ok(drawn && drawn.side === "original" && drawn.target === "<img> hero" &&
    JSON.stringify(drawn.annotation) === JSON.stringify({ shape: "rect", points: [[0.1, 0.05], [0.48, 0.2]] }) &&
    JSON.stringify(drawn.rect) === JSON.stringify({ x: 100, y: 200, w: 300, h: 150 }) &&
    JSON.stringify(drawn.viewport) === JSON.stringify({ w: 1512, h: 982 }),
    "the drawn mark persists side/target/annotation points VERBATIM plus viewport and rect");
  const alignKept = kept.find((c) => c.op === "move");
  ok(alignKept && JSON.stringify(alignKept.position) === JSON.stringify({ dx: -4, dy: 12, ex: 0, ey: 0 }) &&
    JSON.stringify(alignKept.alignDeltas) === JSON.stringify({ tx: -4, ty: 12, scale: 1.05, viewportW: 1512 }),
    "an align comment persists op/position AND the parsed alignDeltas riding beside the prose");
  const dual = kept.find((c) => c.selector === "nav.main");
  ok(dual && dual.other && dual.other.label === "<nav> \"Main navigation\"", "the dual-anchor other element persists");
  const legacy = kept.find((c) => c.text === "legacy text-only comment");
  ok(legacy && legacy.text_sha256 && !("side" in legacy) && !("annotation" in legacy) && !("alignDeltas" in legacy),
    "an old-shape text-only comment persists exactly as before (no invented fields)");

  // the same blocks print on REJECTION — that is where the fix list lives
  fs.writeFileSync(path.join(MOCK, `get_test_results-${PING1}.json`), JSON.stringify({
    status: "complete", n_received: 1, n_target: 1,
    responses: [{ choice: "Header clearly different", free_text: "cta is misaligned" }],
    comments: richComments,
  }));
  const rejectedRich = run(["verify", NAME]);
  ok(rejectedRich.code === 1 && /NOT approved/.test(rejectedRich.out) &&
    /⌖ DRAFT · <div> CTA \[div\.cta\] — move — "Alignment/.test(rejectedRich.out) &&
    /align: move 4px left, 12px down, scale ×1\.05 \(measured at 1512px\)/.test(rejectedRich.out),
    "REJECTION prints the same ⌖ blocks after the verdict line (the marks ARE the fix list)");

  // …and on the NO-VERDICT-PICK path — the third response outcome. Observed live: a
  // reviewer left 7 rich structured comments and no choice, and verify exited BEFORE
  // printCommentBlocks, so the agent got only the one-line prose digest while the
  // actual marks died in review-qa.json. The comments are the ONLY feedback that
  // state has; the blocks must print there too (still exit 1 — no verdict is never
  // a pass). None of richComments sits on the verdict step (index 3 here), so
  // neither exact-match exception can fire and the round stays genuinely pick-less.
  fs.writeFileSync(path.join(MOCK, `get_test_results-${PING1}.json`), JSON.stringify({
    status: "complete", n_received: 1, n_target: 1,
    responses: [{ choice: null, free_text: "left marks on everything that differs", steps_result: [{}, {}, {}, {}] }],
    comments: richComments,
  }));
  const noPickRich = run(["verify", NAME]);
  ok(noPickRich.code === 1 && /NO verdict pick/.test(noPickRich.out) && /left marks on everything that differs/.test(noPickRich.out),
    "a no-pick response with rich comments still fails the gate (comments alone never pass)");
  ok(/⌖ DRAFT · <h1> "Welcome" \[header > h1\] — note — "font looks lighter here" \(step 2\)/.test(noPickRich.out) &&
    /⌖ ORIGINAL · <img> hero \[img\.hero\] — drawn rect — "this corner is clipped"/.test(noPickRich.out) &&
    /align: move 4px left, 12px down, scale ×1\.05 \(measured at 1512px\)/.test(noPickRich.out) &&
    /measured elements under the mark: cta_button/.test(noPickRich.out),
    "NO-PICK prints the full ⌖ blocks too — the reviewer's marks reach the agent even without a verdict");

  // restore the approved state the sections below build on
  fs.writeFileSync(path.join(MOCK, `get_test_results-${PING1}.json`), JSON.stringify({ status: "complete", n_received: 1, n_target: 1, responses: [{ choice: "Header identical", free_text: null }] }));
  ok(run(["verify", NAME]).code === 0, "verify re-approves after the rich-comment round (state restored)");
  fs.rmSync(path.join(dir, "live.json"));
  fs.rmSync(path.join(dir, "clone.json"));
}

// ── parseAlignDeltas: tolerant, direction-aware, never guessing ──────────────
{
  const { parseAlignDeltas } = require("./review-qa.js");
  const canonical = parseAlignDeltas("Alignment (measured at 1512px-wide viewport; element is 180×48px): this element should move -4px right, 12px down and scale ×1.05 to match the original.");
  ok(JSON.stringify(canonical) === JSON.stringify({ tx: -4, ty: 12, scale: 1.05, viewportW: 1512 }),
    "canonical alignText prose parses to signed tx/ty + scale + viewport width");
  const leftUp = parseAlignDeltas("this element should move 30px left, 5px up to match the original");
  ok(leftUp && leftUp.tx === -30 && leftUp.ty === -5 && leftUp.scale === null && leftUp.viewportW === null,
    "left/up wording negates onto the canonical right/down axes; absent scale/viewport stay null");
  const noScale = parseAlignDeltas("Alignment (measured at 900px-wide viewport): this element should move 2px right, 0px down to match the original.");
  ok(noScale && noScale.tx === 2 && noScale.ty === 0 && noScale.scale === null && noScale.viewportW === 900,
    "a no-scale move parses (0px down is a real 0, not a missing field)");
  ok(parseAlignDeltas("make it pop more") === null, "garbage prose parses to null — never guessed");
  ok(parseAlignDeltas("Alignment (measured at 1512px-wide viewport): this element should be nudged to match the original.") === null,
    "the app's delta-less 'be nudged' prose parses to null (a viewport alone is not a delta)");
}

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
// The temporal word check on assist --compare is lexical too → warn-and-proceed; the
// only failure left here is the genuinely missing draft, never the wording.
const crossPhaseTemporalAssist = runLoggedIn(["assist", NAME, "--phase", "visual", "--ask", "Compare the expanding circle animation as the page scrolls", "--compare"]);
ok(crossPhaseTemporalAssist.code === 1 && !/refused/.test(crossPhaseTemporalAssist.out) && /⚠/.test(crossPhaseTemporalAssist.out) &&
  /pingfusi next/.test(crossPhaseTemporalAssist.out) && /push one first/.test(crossPhaseTemporalAssist.out),
  "a temporal-sounding assist --compare warns and proceeds — it then fails only on the missing draft, never on lexical grounds");
const anyway = run(["file", NAME, "--draft", "https://x.trycloudflare.com", "--region", "the header", "--anyway"]);
ok(anyway.code === 0 && /--anyway/.test(anyway.out), "--anyway overrides with a printed warning (deliberate out-of-band round)");
fs.rmSync(path.join(dir, "workflow.json")); // standalone usage (no workflow.json) keeps filing freely — proven by every earlier case above

// ── first-draft doctrine: motion state is informational — the page round always files ──
fs.mkdirSync(motionDir, { recursive: true });
fs.writeFileSync(path.join(motionDir, "target.json"), JSON.stringify({ name: MOTION_NAME, url: "https://motion.example/", width: 1512 }));
fs.writeFileSync(path.join(motionDir, "coverage.json"), JSON.stringify(["hero"]));
const beforeReview = ["target", "assets", "measure", "build", "visual", "coverage", "strict", "behavior"];
fs.writeFileSync(path.join(motionDir, "workflow.json"), JSON.stringify({
  name: MOTION_NAME,
  url: "https://motion.example/",
  phaseOrder: [...beforeReview, "review", "done"],
  phases: Object.fromEntries([...beforeReview.map((key) => [key, { status: "pass" }]), ["review", { status: "pending" }], ["done", { status: "pending" }]]),
}));
fs.writeFileSync(path.join(motionDir, "behaviors-live.json"), JSON.stringify({
  discovery: { elementsScanned: 9, scrollSweep: { from: 0, to: 900, steps: 6 }, observeMs: 1200, documentHidden: false },
  behaviors: {},
  declared: { "declared:img.intro": { hints: ["animation-name:intro-up"], startState: { opacity: 1, transform: "none" } } },
}));
const PING_UNOWNED = "00000000-0000-4000-8000-0000000000b0";
fs.writeFileSync(path.join(MOCK, "request_review.json"), JSON.stringify({ ping_id: PING_UNOWNED, status: "pending" }));
const unownedFile = run(["file", MOTION_NAME, "--draft", "https://motion.trycloudflare.com", "--region", "the page"]);
ok(unownedFile.code === 0 && /no motion receipt/.test(unownedFile.out) && /pingfusi next/.test(unownedFile.out) && !/refusing generic page review/.test(unownedFile.out),
  "receipt-less captured motion WARNS and files — motion state never blocks the page round");
// An ACTIVE motion item cannot block a page round either: motion is receipts + warnings.
fs.writeFileSync(path.join(motionDir, "motion-items.json"), JSON.stringify({
  schema: "pingfusi/motion-items@1",
  items: [{ id: "intro-up", kind: "css-animation", status: "pending", declaredBy: "manual", sourceBehaviorKeys: ["declared:img.intro"] }],
}, null, 2));
const PING_MOTION = "00000000-0000-4000-8000-0000000000b1";
fs.writeFileSync(path.join(MOCK, "request_review.json"), JSON.stringify({ ping_id: PING_MOTION, status: "pending" }));
const activeMotionFile = run(["file", MOTION_NAME, "--draft", "https://motion.trycloudflare.com", "--region", "the page"]);
ok(activeMotionFile.code === 0 && /no green machine receipt/.test(activeMotionFile.out) && !/refusing/.test(activeMotionFile.out),
  "an active motion item warns informationally and the round still files — never a refusal, no --anyway needed");
// Reviewer prose about motion is ordinary notes: no supersede, no bookkeeping writes.
fs.writeFileSync(path.join(MOCK, `get_test_results-${PING_MOTION}.json`), JSON.stringify({
  status: "complete", n_received: 1, n_target: 1,
  responses: [{ choice: "Page identical", free_text: "the opening circle still expands late", steps_result: [{}, {}, {}, {}] }],
  comments: [{ step_index: 1, text: "expanding circle on scroll" }],
}));
const motionProse = run(["verify", MOTION_NAME]);
let motionManifest = JSON.parse(fs.readFileSync(path.join(motionDir, "motion-items.json"), "utf8"));
ok(motionProse.code === 0 && motionManifest.items.length === 1 && !motionManifest.items.some((item) => /^review-\d+-temporal$/.test(item.id)),
  "an approving verdict passes even with motion prose in the notes — no supersede, no manufactured motion bookkeeping");
const motionLedgerEvents = fs.existsSync(path.join(motionDir, "workflow.jsonl"))
  ? fs.readFileSync(path.join(motionDir, "workflow.jsonl"), "utf8").trim().split("\n").filter((line) => /review-motion-routed/.test(line)).length
  : 0;
ok(motionLedgerEvents === 0, "no review-motion-routed ledger event exists anymore — the probe routing was removed with the review machinery");
// Legacy superseded receipts (written by earlier kit versions) still refuse verdict reuse.
let motionHq = JSON.parse(fs.readFileSync(path.join(motionDir, "review-qa.json"), "utf8"));
motionHq.rounds[motionHq.rounds.length - 1].superseded = { reason: "legacy structured temporal supersede", at: new Date().toISOString() };
fs.writeFileSync(path.join(motionDir, "review-qa.json"), JSON.stringify(motionHq, null, 2));
const legacySuperseded = run(["verify", MOTION_NAME]);
ok(legacySuperseded.code === 1 && /superseded/.test(legacySuperseded.out) && /file a fresh page review/.test(legacySuperseded.out),
  "a legacy superseded round stays unusable as a verdict — file a fresh round instead");

console.log(failed ? `\n❌ review-qa-selftest: ${failed} assertion(s) failed.` : `\n✓ review-qa-selftest: all assertions pass.`);
process.exit(failed ? 1 : 0);
