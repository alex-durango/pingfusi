// packages/core/core-selftest.js — guards the extracted core (the four service verbs:
// ping, review, draft, plus the wire underneath them).
// Offline + socket-free via the same file:// transport pattern as
// harness/review-qa-selftest.js: PPK_PINGHUMANS_URL=file://MOCK serves canned
// request_review.json / get_test_results-<ping>.json /
// wait_for_results-<ping>.json / quick_poll.json / get_ping-<ping>.json responses
// from disk. Asserts the contracts the extraction must
// not bend:
//   - the wire remap table (internal verb names → the service's cpyany_* namespace),
//     the file:// fixture-filename contract, and the mirrored service caps
//   - a round file/verify ROUND-TRIP over a caller-provided STATE FILE persists the
//     review-qa.json shape exactly — semantic responses, the VERBATIM comment envelope
//     (annotation points, viewport, rect, other, position), derived alignDeltas,
//     result_sha256 — and the two exact-match verdict fallbacks receipt themselves
//     (verdict_step_answer / free_text_exact_match; paraphrases still fail)
//   - the draft client's manifest walk + /assets/ rewrite stay byte-compatible with
//     the service contract (lib/drafts.ts), and verifyDraftServes is rewrite-aware
//   - the ping verb targets 1 result and its answers re-fetch for free
//   - harness/review-qa.js + harness/draft.js re-export the SAME core functions
//     (the drift tripwire: a fork of either half is a regression, not a refactor)
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const MOCK = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-core-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-core-work-"));
process.on("exit", () => { try { fs.rmSync(MOCK, { recursive: true, force: true }); fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} });

// BASE is read at require time — pin the file:// transport BEFORE loading the core.
process.env.PPK_PINGHUMANS_URL = "file://" + MOCK;
const wire = require("./wire.js");
const rounds = require("./rounds.js");
const drafts = require("./drafts.js");
const core = require("./index.js");

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed++; console.log(`  ✗ ${msg}`); } };
const writeMock = (file, value) => fs.writeFileSync(path.join(MOCK, file), JSON.stringify(value));
const errorOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

console.log("core-selftest — the extracted four-verb core (wire/rounds/drafts/ping)");

(async () => {
  // ── wire: BASE, the live remap table, the mirrored service caps ─────────────
  ok(wire.BASE === "file://" + MOCK, "BASE honours PPK_PINGHUMANS_URL (file:// transport)");
  ok(wire.LIVE_TOOL_NAME.request_review === "cpyany_test"
    && wire.LIVE_TOOL_NAME.get_test_results === "cpyany_test_results"
    && wire.LIVE_TOOL_NAME.wait_for_results === "cpyany_wait"
    && wire.LIVE_TOOL_NAME.quick_poll === "cpyany_poll"
    && wire.LIVE_TOOL_NAME.get_ping === "cpyany_poll_results",
    "the live wire remap maps every internal verb into the service's own namespace");
  ok(wire.SERVICE_CAPS.maxSteps === 20 && wire.SERVICE_CAPS.maxStepTextChars === 300 && wire.SERVICE_CAPS.maxOptionChars === 40,
    "service caps mirrored kit-side: 20 steps / 300-char step text / 40-char options");
  ok(wire.DEFAULT_REVIEW_RESULTS === 1 && wire.MAX_REVIEW_RESULTS === 20,
    "review result depth: default 1, service range up to 20");
  ok(wire.DEFAULT_AGENT_LEASE_SECONDS === 60,
    "agent-filed work mirrors the service's one-minute renewable idle lease");
  ok(wire.DEFAULT_SEND_WAIT_SECONDS === 0,
    "a live send command has no arbitrary overall wait cutoff");

  // ── wire: the file:// fixture-filename contract rpc callers rely on ─────────
  const PING = "00000000-0000-4000-8000-00000000c0de";
  writeMock("request_review.json", { ping_id: PING, status: "pending" });
  writeMock(`wait_for_results-${PING}.json`, { ping_id: PING, status: "complete", n_received: 1, n_target: 1, responses: [{ choice: "Ready" }] });
  const filedRaw = await wire.rpc("request_review", { url: "https://example.com/" });
  ok(filedRaw.ping_id === PING && filedRaw.status === "complete" && filedRaw.n_received === 1,
    "rpc(request_review) turns a pending send into the active wait automatically");
  writeMock(`get_test_results-${PING}.json`, { status: "pending", n_received: 0, n_target: 1, responses: [] });
  const pendingRaw = await wire.rpc("get_test_results", { ping_id: PING });
  ok(pendingRaw.status === "pending", "rpc(get_test_results) reads get_test_results-<ping_id>.json");
  writeMock(`wait_for_results-${PING}.json`, { ping_id: PING, status: "pending", n_received: 0, n_target: 1, responses: [], lease_renewed: true });
  const waitingRaw = await wire.rpc("wait_for_results", { ping_id: PING, max_wait_seconds: 45 });
  ok(waitingRaw.status === "pending" && waitingRaw.lease_renewed === true,
    "rpc(wait_for_results) reads its fixture and maps live calls to the lease-renewing cpyany_wait tool");

  // ── review.file: every documented service cap is local, before transport ───
  const capStateFile = path.join(WORK, "review-cap-boundary.json");
  const capSpec = () => ({
    url: "https://example.com/",
    instructions: "Review this page against the stated criteria.",
    steps: [{ text: "Judge the page polish.", options: ["Polished", "Needs work"] }],
    verdict_options: ["Approve", "Revise"],
    approve_verdicts: ["Approve"],
    n_target: 1,
  });
  const realRpc = wire.rpc;
  let capWireCalls = 0;
  wire.rpc = async (name) => { capWireCalls++; return { ping_id: "00000000-0000-4000-8000-00000000ca9e", name }; };
  try {
    {
      const tooMany = capSpec();
      tooMany.steps = Array.from({ length: wire.SERVICE_CAPS.maxSteps + 1 }, (_, i) => ({ text: `Judge item ${i}.` }));
      const before = capWireCalls;
      const e = await errorOf(() => core.review.file(capStateFile, tooMany));
      ok(e && e.name === "ReviewSpecError" && e.code === "PINGFUSI_REVIEW_SPEC_INVALID"
        && /steps has 21 entries.*at most 20/.test(e.message) && capWireCalls === before,
        "21 steps is a NAMED local refusal and makes no wire call");
    }
    {
      const tooLong = capSpec();
      tooLong.steps[0].text = "x".repeat(wire.SERVICE_CAPS.maxStepTextChars + 1);
      const before = capWireCalls;
      const e = await errorOf(() => core.review.file(capStateFile, tooLong));
      ok(e && /steps\[0\]\.text is 301 chars.*at most 300/.test(e.message) && capWireCalls === before,
        "a 301-char step names its exact field and makes no wire call");
    }
    {
      const tooLong = capSpec();
      tooLong.steps[0].options[0] = "x".repeat(wire.SERVICE_CAPS.maxOptionChars + 1);
      const before = capWireCalls;
      const e = await errorOf(() => core.review.file(capStateFile, tooLong));
      ok(e && /steps\[0\]\.options\[0\] is 41 chars.*at most 40/.test(e.message) && capWireCalls === before,
        "a 41-char inline option names its exact field and makes no wire call");
    }
    {
      const tooLong = capSpec();
      tooLong.verdict_options[1] = "x".repeat(wire.SERVICE_CAPS.maxOptionChars + 1);
      const before = capWireCalls;
      const e = await errorOf(() => core.review.file(capStateFile, tooLong));
      ok(e && /verdict_options\[1\] is 41 chars.*at most 40/.test(e.message) && capWireCalls === before,
        "the same 40-char cap covers verdict options before any wire call");
    }
    for (const invalidTarget of [0, wire.MAX_REVIEW_RESULTS + 1, 1.5, null]) {
      const badTarget = capSpec();
      badTarget.n_target = invalidTarget;
      const before = capWireCalls;
      const e = await errorOf(() => core.review.file(capStateFile, badTarget));
      ok(e && /n_target must be a whole number from 1 to 20/.test(e.message) && capWireCalls === before,
        `n_target=${JSON.stringify(invalidTarget)} is refused locally outside the 1..20 integer range`);
    }
    const boundary = capSpec();
    boundary.steps = Array.from({ length: wire.SERVICE_CAPS.maxSteps }, (_, i) => ({
      text: i === 0 ? "x".repeat(wire.SERVICE_CAPS.maxStepTextChars) : `Judge item ${i}.`,
      options: i === 0 ? ["x".repeat(wire.SERVICE_CAPS.maxOptionChars), "Needs work"] : undefined,
    }));
    boundary.verdict_options = ["x".repeat(wire.SERVICE_CAPS.maxOptionChars), "Revise"];
    boundary.approve_verdicts = [boundary.verdict_options[0]];
    boundary.n_target = wire.MAX_REVIEW_RESULTS;
    const atCap = await core.review.file(capStateFile, boundary);
    ok(atCap.round === 1 && capWireCalls === 1
      && JSON.parse(fs.readFileSync(capStateFile, "utf8")).rounds[0].n_target === wire.MAX_REVIEW_RESULTS,
      "the exact 20-step / 300-char / 40-char / 20-result boundaries pass with one wire call");
  } finally {
    wire.rpc = realRpc;
  }

  // ── review.file → a round recorded in the CALLER's state file ───────────────
  const stateFile = path.join(WORK, "review-qa.json");
  const verdicts = ["Header identical", "Header slightly off", "Header clearly different"];
  const spec = {
    url: "https://example.com/",
    draft_url: "https://x.example/d/abc123DEF456",
    title: "example.com — is the clone identical? (round 1)",
    instructions: "Compare ONLY the header, side by side.",
    steps: [
      { text: "Open both side by side.", check: null },
      { text: "Compare these elements between clone and original: logo, nav.", options: ["Identical", "Slightly off", "Clearly different"] },
      { text: "Squint test.", options: ["Could not tell apart", "Subtle difference", "Obvious difference"] },
      { text: "FINAL REQUIRED STEP — verdict.", options: verdicts, check: null },
    ],
    verdict_options: verdicts,
    approve_verdicts: [verdicts[0]],
    n_target: 1,
    deadline_seconds: 86400,
    require_evidence: "screenshot",
  };
  const filed = await core.review.file(stateFile, spec);
  ok(filed.ping_id === PING && filed.round === 1 && filed.result.status === "pending",
    "review.file files, owns the wait, and returns round 1 with the latest result envelope");
  const hq1 = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  ok(JSON.stringify(Object.keys(hq1.rounds[0])) === JSON.stringify([
    "ping_id", "draft_url", "region", "n_target", "approve_verdicts", "verdict_options",
    "review_contract", "filed_at", "last", "checked_at",
  ]), "the recorded round keeps review-qa.json's EXACT key shape (byte-compat with the kit's own state)");
  ok(hq1.rounds[0].ping_id === PING && hq1.rounds[0].n_target === 1 && hq1.rounds[0].approve_verdicts[0] === verdicts[0]
    && hq1.rounds[0].region === spec.title && hq1.rounds[0].last === null,
    "…and its fields carry the spec's title/target/approve set with last/checked_at unset");

  // ── review.wait: active lease-renewing wait, no state write ────────────────
  const waited = await core.review.wait(PING);
  ok(waited.status === "pending" && !JSON.parse(fs.readFileSync(stateFile, "utf8")).rounds[0].checked_at,
    "review.wait uses the active service wait without touching the state file");

  // ── review.verify: pending → not ok; the state file records the check ───────
  const pend = await core.review.verify(stateFile);
  ok(pend.ok === false && pend.status === "pending", "verify reports a pending round as not-ok");
  ok(JSON.parse(fs.readFileSync(stateFile, "utf8")).rounds[0].checked_at, "…and stamps checked_at (a verify is always re-fetched, never cached)");

  // ── review.verify: approval with the RICH comment envelope, persisted VERBATIM ──
  const ALIGN_PROSE = "Alignment (measured at 1512px-wide viewport; element is 180×48px): this element should move -4px right, 12px down and scale ×1.05 to match the original.";
  const richComments = [
    { step_index: 1, text: "this corner is clipped", side: "original", selector: "img.hero", target: "<img> hero",
      annotation: { shape: "rect", points: [[0.1, 0.05], [0.48, 0.2]] },
      viewport: { w: 1512, h: 982 }, rect: { x: 100, y: 200, w: 300, h: 150 } },
    { step_index: 1, text: ALIGN_PROSE, side: "draft", selector: "div.cta", target: "<div> CTA", op: "move",
      viewport: { w: 1512, h: 982 }, rect: { x: 700, y: 400, w: 180, h: 48 }, position: { dx: -4, dy: 12, ex: 0, ey: 0 } },
    { step_index: 0, text: "match this nav to the original", side: "draft", selector: "nav.main", target: "<nav> Main",
      other: { side: "original", label: "<nav> \"Main navigation\"" } },
    { step_index: 0, text: "legacy text-only comment" },
  ];
  writeMock(`get_test_results-${PING}.json`, {
    status: "complete", n_received: 1, n_target: 1,
    responses: [{ choice: verdicts[0], free_text: "clean", steps_result: [{}, {}, {}, {}] }],
    comments: richComments,
  });
  const approved = await core.review.verify(stateFile);
  ok(approved.ok === true && approved.status === "approved" && approved.verdict === verdicts[0],
    "a picked approve verdict approves the round");
  const hq2 = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const last = hq2.rounds[0].last;
  ok(JSON.stringify(Object.keys(last)) === JSON.stringify(["status", "n_received", "n_target", "result_sha256", "responses", "comments"])
    && /^[0-9a-f]{64}$/.test(last.result_sha256),
    "round.last keeps the exact envelope shape and hashes the whole result");
  ok(last.responses[0].verdict === verdicts[0] && last.responses[0].notes === "clean",
    "responses are persisted semantically (choice→verdict, free_text→notes)");
  const drawn = last.comments.find((c) => c.selector === "img.hero");
  ok(drawn && drawn.side === "original"
    && JSON.stringify(drawn.annotation) === JSON.stringify({ shape: "rect", points: [[0.1, 0.05], [0.48, 0.2]] })
    && JSON.stringify(drawn.rect) === JSON.stringify({ x: 100, y: 200, w: 300, h: 150 })
    && /^[0-9a-f]{64}$/.test(drawn.text_sha256),
    "a drawn mark persists side/annotation points VERBATIM plus rect and text_sha256");
  const alignKept = last.comments.find((c) => c.op === "move");
  ok(alignKept && JSON.stringify(alignKept.alignDeltas) === JSON.stringify({ tx: -4, ty: 12, scale: 1.05, viewportW: 1512 })
    && JSON.stringify(alignKept.position) === JSON.stringify({ dx: -4, dy: 12, ex: 0, ey: 0 }),
    "an align comment persists op/position AND the parsed alignDeltas riding beside the prose");
  const legacy = last.comments.find((c) => c.text === "legacy text-only comment");
  ok(legacy && !("side" in legacy) && !("annotation" in legacy) && !("alignDeltas" in legacy),
    "an old-shape text-only comment persists exactly as before (no invented fields)");

  // ── verdict fallbacks: exact-match only, receipted, never a sentiment read ──
  writeMock(`get_test_results-${PING}.json`, {
    status: "complete", n_received: 1, n_target: 1,
    responses: [{ choice: null, free_text: null, steps_result: [{}, {}, {}, { answer: "Header identical" }] }],
  });
  const tapped = await core.review.verify(stateFile);
  const hq3 = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  ok(tapped.ok === true && hq3.rounds[0].verdict_source === "verdict_step_answer"
    && hq3.rounds[0].last.responses[0].verdict_source === "verdict_step_answer",
    "a TAPPED approve option on the verdict step passes, receipted as verdict_step_answer");
  writeMock(`get_test_results-${PING}.json`, {
    status: "complete", n_received: 1, n_target: 1,
    responses: [{ choice: null, free_text: null, steps_result: [{}, {}, {}, { answer: "Header clearly different" }] }],
  });
  const tappedNo = await core.review.verify(stateFile);
  ok(tappedNo.ok === false && tappedNo.status === "rejected",
    "a TAPPED rejection is a REJECTION — never reported as verdict-less");
  writeMock(`get_test_results-${PING}.json`, {
    status: "complete", n_received: 1, n_target: 1,
    responses: [{ choice: null, free_text: null, steps_result: [{}, {}, {}, {}] }],
    comments: [{ text: "Header identical", step_index: 3 }],
  });
  const bridged = await core.review.verify(stateFile);
  ok(bridged.ok === true && JSON.parse(fs.readFileSync(stateFile, "utf8")).rounds[0].verdict_source === "free_text_exact_match",
    "a verdict-step comment EXACTLY equal to the approve verdict passes, receipted as free_text_exact_match");
  writeMock(`get_test_results-${PING}.json`, {
    status: "complete", n_received: 1, n_target: 1,
    responses: [{ choice: null, free_text: null, steps_result: [{}, {}, {}, { answer: "header looks identical" }] }],
  });
  ok((await core.review.verify(stateFile)).status === "no-verdict",
    "a paraphrase in the tapped-answer field still fails — exact match only");
  writeMock(`get_test_results-${PING}.json`, {
    status: "complete", n_received: 1, n_target: 1,
    responses: [{ choice: null, free_text: null, steps_result: [{}, {}, {}, {}] }],
    comments: [{ text: "Header identical", step_index: 0 }],
  });
  ok((await core.review.verify(stateFile)).status === "no-verdict",
    "the approve verdict as a comment on ANOTHER step still fails (a description of an element is not a verdict)");
  writeMock(`get_test_results-${PING}.json`, { status: "expired", n_received: 0, n_target: 1, responses: [] });
  ok((await core.review.verify(stateFile)).status === "expired", "an expired unanswered round reports expired, never a pass");

  // ── single-page design review: beautification needs no comparison draft ───
  const BEAUTY_PING = "00000000-0000-4000-8000-00000000bea7";
  const beautyStateFile = path.join(WORK, "beautify-review.json");
  const beautyVerdicts = ["Ready to ship", "Needs another polish pass"];
  const beautySpec = {
    url: "https://plain.example.com/",
    title: "Plain landing page — design polish review",
    instructions: "Judge this page on its own for hierarchy, cohesion, and professional polish.",
    steps: [
      { text: "Judge the visual hierarchy and first impression.", options: ["Clear and polished", "Needs hierarchy"] },
      { text: "Check spacing, type, color, and component consistency.", options: ["Cohesive", "Inconsistent"] },
      { text: "FINAL REQUIRED STEP — is this professionally polished?", options: beautyVerdicts },
    ],
    verdict_options: beautyVerdicts,
    approve_verdicts: [beautyVerdicts[0]],
    n_target: 1,
    require_evidence: "none",
  };
  writeMock("request_review.json", { ping_id: BEAUTY_PING, status: "pending" });
  writeMock(`get_test_results-${BEAUTY_PING}.json`, {
    status: "complete", n_received: 1, n_target: 1,
    responses: [{ choice: beautyVerdicts[0], free_text: "The hierarchy now feels intentional.", steps_result: [{}, {}, {}] }],
  });
  const beautyCalls = [];
  const fileRpc = wire.rpc;
  wire.rpc = async (...args) => { beautyCalls.push(args); return fileRpc(...args); };
  let beautyFiled;
  let beautyVerified;
  try {
    beautyFiled = await core.review.file(beautyStateFile, beautySpec);
    beautyVerified = await core.review.verify(beautyStateFile);
  } finally {
    wire.rpc = fileRpc;
  }
  const beautyWireArgs = beautyCalls.find(([name]) => name === "request_review")[1];
  const beautyRound = JSON.parse(fs.readFileSync(beautyStateFile, "utf8")).rounds[0];
  ok(beautyFiled.ping_id === BEAUTY_PING && beautyFiled.round === 1
    && beautyWireArgs.url === beautySpec.url && !("draft_url" in beautyWireArgs)
    && !("approve_verdicts" in beautyWireArgs) && beautyRound.draft_url === null,
    "a beautification-shaped round files one public URL with no draft_url/comparison pane");
  ok(beautyVerified.ok === true && beautyVerified.status === "approved" && beautyVerified.verdict === beautyVerdicts[0],
    "the single-URL beautification round re-fetches and verifies through the normal verdict gate");

  // ── the ⌖ readback binds to whatever dir the CALLER passes (never targets/) ──
  fs.writeFileSync(path.join(WORK, "live.json"), JSON.stringify({
    url: "https://example.com/", viewport: { width: 1512, height: 982, dpr: 2 },
    elements: { hero_image: { present: true, rect: { x: 120, y: 210, w: 100, h: 80 } } },
  }));
  {
    const lines = [];
    rounds.printCommentBlocks(WORK, [richComments[0]], (l) => lines.push(l));
    const out = lines.join("\n");
    ok(/⌖ ORIGINAL · <img> hero \[img\.hero\] — drawn rect — "this corner is clipped"/.test(out)
      && /region: x\[10%–48%\] y\[5%–20%\] of the element \(viewport 1512×982\)/.test(out)
      && /measured elements under the mark: hero_image/.test(out),
      "printCommentBlocks reads snapshots from the caller-provided dir and prints the full block");
  }

  // ── drafts: manifest + rewrite byte-compat with the service contract ────────
  const SLUG = "abc123DEF456";
  ok(drafts.rewriteAssetRefs('<link href="/assets/css/x.css">', SLUG) === `<link href="/d/${SLUG}/assets/css/x.css">`,
    "root-absolute kit refs are anchored into the draft path (byte-identical to the service's lib/drafts.ts)");
  ok(drafts.rewriteAssetRefs("@font-face{src:url(/assets/fonts/f.woff2)}", SLUG) === `@font-face{src:url(/d/${SLUG}/assets/fonts/f.woff2)}`,
    "css url(/assets/…) is anchored too");
  ok(drafts.rewriteAssetRefs('<img src="https://example.com/assets/keep.png">', SLUG) === '<img src="https://example.com/assets/keep.png">',
    "absolutized live-origin urls containing /assets/ are UNTOUCHED");
  const clone = path.join(WORK, "clone");
  fs.mkdirSync(path.join(clone, "assets", "fonts"), { recursive: true });
  fs.writeFileSync(path.join(clone, "index.html"), '<link href="/assets/css/x.css">page');
  fs.writeFileSync(path.join(clone, "assets", "fonts", "f.woff2"), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(clone, ".DS_Store"), "junk");
  {
    const m = drafts.buildManifest(clone);
    ok(m.length === 2 && m[0].path === "assets/fonts/f.woff2" && m[0].bytes === 3 && m[1].path === "index.html",
      "the manifest walks nested dirs with sizes, sorted (what the server verifies uploads against)");
    ok(!m.some((f) => f.path.includes(".DS_Store")), "dotfiles are workspace noise, never uploaded");
  }
  ok(drafts.MAX_FILES === 300 && drafts.MAX_FILE_BYTES === 25 * 1024 * 1024 && drafts.MAX_TOTAL_BYTES === 100 * 1024 * 1024,
    "upload caps mirror the service's lib/drafts.ts");
  ok(drafts.SLUG_RE.test("_ab123DEF456") && drafts.SLUG_RE.test("-ab123DEF456") && !drafts.SLUG_RE.test("bad/slug") && !drafts.SLUG_RE.test("short"),
    "the slug charset stays closed ('-'/'_' can lead; separators refused)");
  {
    const idx = path.join(clone, "index.html");
    const served = path.join(WORK, "served.html");
    fs.writeFileSync(served, drafts.rewriteAssetRefs(fs.readFileSync(idx, "utf8"), SLUG));
    const good = await drafts.verifyDraftServes(pathToFileURL(served).href, idx, SLUG);
    ok(good.ok && /^[0-9a-f]{16}$/.test(good.sha256), "served bytes matching the rewritten clone verify ok (+sha)");
    const good2 = await core.draft.status({ url: pathToFileURL(served).href, slug: SLUG }, idx);
    ok(good2.ok === true, "draft.status re-verifies a recorded draft through the same rewrite-aware compare");
    const stale = path.join(WORK, "stale.html");
    fs.writeFileSync(stale, "<html>old push</html>");
    const bad = await drafts.verifyDraftServes(pathToFileURL(stale).href, idx, SLUG);
    ok(!bad.ok && /rewrite/.test(bad.reason), "stale/wrong bytes → NOT ok, rewrite-aware mismatch named");
    const dead = await drafts.verifyDraftServes(pathToFileURL(path.join(WORK, "gone.html")).href, idx, SLUG);
    ok(!dead.ok && /unreachable/.test(dead.reason), "missing/dead url → NOT ok, reported unreachable");
  }

  // ── ping: the one-question poll verb ────────────────────────────────────────
  const POLL = "00000000-0000-4000-8000-00000000c0ff";
  writeMock("quick_poll.json", { ping_id: POLL, status: "pending", n_received: 0, n_target: 1, responses: [] });
  writeMock(`wait_for_results-${POLL}.json`, { ping_id: POLL, status: "complete", n_received: 1, n_target: 1, responses: [{ choice: "Yes", free_text: "tiles look right now" }] });
  const answered = await core.ping("do the 3 tiles look right now?", { choices: ["Yes", "No"] });
  ok(answered.ping_id === POLL && answered.responses[0].choice === "Yes",
    "ping turns its send into the renewable wait and returns the answer envelope");
  writeMock(`get_ping-${POLL}.json`, { status: "complete", n_received: 1, responses: [{ choice: null, free_text: "late answer" }] });
  const late = await core.pingResult(POLL);
  ok(late.responses[0].free_text === "late answer", "pingResult re-fetches a poll's answers for free (get_ping-<ping_id>.json)");

  // ── the drift tripwire: the harness consumers re-export the SAME functions ──
  const reviewQa = require("../../harness/review-qa.js");
  ok(reviewQa.rpc === wire.rpc && reviewQa.resolveToken === wire.resolveToken && reviewQa.BASE === wire.BASE
    && reviewQa.DEFAULT_REVIEW_RESULTS === wire.DEFAULT_REVIEW_RESULTS && reviewQa.MAX_REVIEW_RESULTS === wire.MAX_REVIEW_RESULTS,
    "harness/review-qa.js re-exports core's wire (same functions, not copies)");
  ok(reviewQa.parseAlignDeltas === rounds.parseAlignDeltas, "…and core's parseAlignDeltas");
  const harnessDraft = require("../../harness/draft.js");
  ok(harnessDraft.api === drafts.api && harnessDraft.buildManifest === drafts.buildManifest
    && harnessDraft.rewriteAssetRefs === drafts.rewriteAssetRefs && harnessDraft.verifyDraftServes === drafts.verifyDraftServes
    && harnessDraft.SLUG_RE === drafts.SLUG_RE,
    "harness/draft.js re-exports core's draft client (same functions, not copies)");

  console.log(failed ? `\n❌ core-selftest: ${failed} assertion(s) failed.` : "\n✓ core-selftest: all assertions pass.");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(`core-selftest crashed: ${e.stack || e.message}`); process.exit(1); });
