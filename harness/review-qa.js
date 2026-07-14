// harness/review-qa.js — the REVIEW phase: side-by-side review as a workflow gate.
//
// WHY THIS EXISTS. The gates prove every property the tool measures; they cannot prove
// the two things LEARNINGS reserves for eyes — that the *measured set* is what a viewer
// actually sees, and that techniques rasterise identically (the gate-vs-eyes split). The
// kit's end state is a clone the designer receives after all the review rounds —
// unattended — so the review round must be a PHASE with a machine-checkable gate, not an
// operator ritual. A review verdict IS machine-checkable: this tool files the round,
// polls the verdict over the same authenticated JSON-RPC endpoint the pingfusi CLI uses,
// and exits 0 only when the LATEST round is approved. Receipts pin ping_id+verdict.
//
// The review template encodes the lessons 8 unconverged rounds paid for:
//   - SCOPE-PIN: the reviewer judges ONLY the cloned region (an open-ended side-by-side
//     of a partial clone cannot converge — lesson 1).
//   - Behavior is INFORMATIONAL: a static clone strips JS; hover/animation differences
//     are noted, never failed on (lesson 2 — acceptance criteria for animated/generative
//     content must be agreed up front).
//   - Per-leaf compare steps are generated from coverage.json, so the reviewer is pointed
//     at exactly the marks the gates certified — detection stays visual, scope stays pinned.
//
// USAGE
//   node harness/review-qa.js template <name> --draft <public-url> [--region "the header"]
//       print the review spec JSON (to file manually via the review MCP)
//   node harness/review-qa.js file     <name> --draft <public-url> [--region "…"]
//                                      [--context "one line: what site/page this is"]
//       generate the spec AND file it; records the round in targets/<name>/review-qa.json.
//       --context is the agent's slot for reviewer-facing color (what the page is, where
//       to look) — capped at 200 chars; the site name, url and round number are filled
//       in automatically from receipts.
//   node harness/review-qa.js record   <name> <ping_id> [--approve "Verdict A,Verdict B"]
//       adopt a round filed elsewhere (e.g. via the MCP) as the current round
//   node harness/review-qa.js verify   <name>
//       fetch the LATEST round's verdict; exit 0 = approved (the workflow gate runs this)
//   node harness/review-qa.js poll     <name> "question" [--choices "A,B,C"]
//       a MICRO-CHECK (~$0.05, blocks up to ~300s): put one small question in front of a
//       reviewer MID-ROUND — "do these 3 tiles look right now? <urls>" — before spending a
//       full round on it. With a responsive reviewer this collapses a whole
//       flag→refile→wait cycle into minutes (one run burned 4 rounds on one contested cell
//       treatment). ADVISORY ONLY: polls never satisfy the review gate — the gate still
//       requires an approving verdict on a full scope-pinned round. The draft/original
//       urls are appended automatically when tunnel.json/target.json exist.
//   node harness/review-qa.js poll-result <name> <ping_id>
//       free re-fetch of a pending poll's answers
//   node harness/review-qa.js assist   <name> [--phase <key>] [--ask "…"] [--compare]
//       the STALL escalation (`pingfusi assist`): composes a reviewer question FROM the
//       failing phase's own artifacts (worst failing diff row, uncovered leaf, behavior
//       row) and files it — a ~$0.05 one-sided micro-poll by default, or with --compare a
//       SCOPED DIAGNOSTIC ROUND (side-by-side compare UI; full credit; recorded in
//       hq.diagnostics so it can never satisfy the review gate). At most ONE open assist
//       per target; filing appends an `assist` receipt to workflow.jsonl, which is what
//       resets the stall streak. Refuses phases a reviewer can't help with (mechanical
//       artifacts, environment-shaped behavior failures → pingfusi behavior-capture).
//   node harness/review-qa.js assist-result <name> <ping_id>
//       free re-fetch of a diagnostic round's answers (poll assists use poll-result)
//   node harness/review-qa.js file <name> --diagnostic --region "the …" [--ask "…"]
//       file a diagnostic round directly (what assist --compare does) — exempt from the
//       gates-green guard because its purpose is the UNKNOWN flag, but must be scoped
//
// AUTH: the designer's existing pingfusi login — ~/.config/pingfusi/credentials.json (or
// the legacy ~/.config/pinghumans / ~/.config/cpyany path), else the Bearer header in
// ~/.claude.json's review MCP entry, else PPK_PINGHUMANS_TOKEN / PINGFUSI_TOKEN.
// PPK_PINGHUMANS_URL / PINGFUSI_APP_URL overrides the API base; a file:// value serves
// canned responses from disk (offline selftests; sandboxes that block sockets).
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { fileURLToPath } = require("url");

const WORK = process.cwd();
const targetDir = (name) => path.join(WORK, "targets", name);
const hqPath = (name) => path.join(targetDir(name), "review-qa.json");
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const BASE = process.env.PPK_PINGHUMANS_URL || process.env.PINGFUSI_APP_URL || process.env.PINGHUMANS_APP_URL || "https://pingfusi.com";

function resolveToken() {
  // explicit empty = "behave as if no login exists" (selftests; deliberate opt-out)
  if (process.env.PINGFUSI_TOKEN === "" || process.env.PPK_PINGHUMANS_TOKEN === "") return null;
  if (process.env.PINGFUSI_TOKEN) return process.env.PINGFUSI_TOKEN;
  if (process.env.PPK_PINGHUMANS_TOKEN) return process.env.PPK_PINGHUMANS_TOKEN;
  // login writes {token}; read the current dir first, legacy dirs after (no re-login on upgrade)
  for (const dir of ["pingfusi", "pinghumans", "cpyany"]) {
    try {
      const t = readJson(path.join(os.homedir(), ".config", dir, "credentials.json")).token;
      if (t) return t;
    } catch (e) {}
  }
  try {
    const cfg = readJson(path.join(os.homedir(), ".claude.json"));
    const s = cfg.mcpServers || {};
    const entry = s.pingfusi || s.cpyany || s.pinghumans;
    const m = /Bearer\s+(\S+)/.exec((entry && entry.headers && (entry.headers.Authorization || entry.headers.authorization)) || "");
    if (m) return m[1];
  } catch (e) {}
  return null;
}

// One JSON-RPC tools/call against the review MCP-over-HTTP endpoint (the same transport
// `pingfusi wait` uses). file:// base → canned responses from disk:
//   get_test_results-<ping_id>.json / request_review.json
//
// The LIVE api/mcp endpoint's tools/list exposes these under the service's own namespace
// (`cpyany_test`, `cpyany_test_results`), not the generic names this file uses
// internally — confirmed empirically: a live call with the generic name fails with
// "Tool not found" even with a valid token, while `tools/list` on the same endpoint
// returns `cpyany_test`/`cpyany_test_results`/`cpyany_poll`/`cpyany_poll_results`/
// `cpyany_wait`/`cpyany_check_source`. Kept the internal names (and the file:// fixture
// filenames / selftest) unchanged — only the wire method name sent to the LIVE endpoint
// is remapped, right before the fetch.
const LIVE_TOOL_NAME = { request_review: "cpyany_test", get_test_results: "cpyany_test_results", quick_poll: "cpyany_poll", get_ping: "cpyany_poll_results" };
async function rpc(name, args, timeoutMs) {
  if (BASE.startsWith("file://")) {
    const dir = fileURLToPath(BASE);
    const f = name === "get_test_results" ? `get_test_results-${args.ping_id}.json`
      : name === "get_ping" ? `get_ping-${args.ping_id}.json`
      : `${name}.json`;
    return readJson(path.join(dir, f));
  }
  const token = resolveToken();
  if (!token) throw new Error("no review login — run `pingfusi setup`, or set PINGFUSI_TOKEN");
  const wireName = LIVE_TOOL_NAME[name] || name;
  const res = await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: wireName, arguments: args } }),
    // quick_poll blocks server-side while a reviewer answers (up to ~300s) — callers pass a
    // matching timeout; everything else keeps the snappy default.
    signal: AbortSignal.timeout(timeoutMs || 20_000),
  });
  const raw = await res.text();
  const m = raw.match(/data: (.*)/);
  const payload = JSON.parse(m ? m[1] : raw);
  if (payload.error) throw new Error(payload.error.message || "MCP error");
  const r = payload.result || {};
  if (r.isError) throw new Error((r.content && r.content[0] && r.content[0].text) || "the review service returned an error");
  if (r.structuredContent) return r.structuredContent;
  try { return JSON.parse(r.content[0].text); } catch (e) { throw new Error("unexpected RPC response shape"); }
}

// ── the scope-pinned review template ─────────────────────────────────────────
const slugToWords = (s) => s.replace(/[_-]+/g, " ").trim();

function buildSpec(name, draftUrl, region, changelog, context) {
  const target = readJson(path.join(targetDir(name), "target.json"));
  // The reviewer is a person glancing at a queue: the title and description must say
  // WHAT SITE this is and which round, in plain words — "Compare the cloned region:
  // clone vs original" told them nothing. Site + round are derived from receipts the
  // kit already holds; `--context` is the agent's one sanctioned slot for free-text
  // color (capped + flattened — the CONTRACT parts below stay kit-authored).
  let site = target.url;
  try { site = new URL(target.url).hostname.replace(/^www\./, ""); } catch (e) {}
  let roundNo = 1;
  try { roundNo = (readJson(hqPath(name)).rounds || []).length + 1; } catch (e) {}
  const ctx = context && context.trim() ? " " + context.trim().replace(/\s+/g, " ").slice(0, 200) : "";
  let leaves = [];
  try {
    const cov = readJson(path.join(targetDir(name), "coverage.json"));
    leaves = (Array.isArray(cov) ? cov : cov.leaves || []).map(slugToWords);
  } catch (e) {}
  // THE ROUND MUST NAME THE REGION THE TARGET DECLARED. `region` is persisted in target.json before
  // the first capture precisely so every downstream consumer reads the same scope — and the review
  // round is the one consumer that was still re-deciding it. Left to the generic default, a
  // region:page round told the reviewer to compare "the cloned region" and offered the verdict
  // "Cloned region identical"; the reviewer, looking at an entire homepage, typed "cloned page
  // identical" instead. That is a paraphrase, so the free-text exception below (which demands an
  // EXACT match, and must) refused it — and three rounds burned on a wording mismatch the kit
  // introduced itself. Read the scope the target already declared.
  const REGION_LABEL = { page: "the entire page", header: "the header" };
  const declared = (() => { try { return REGION_LABEL[target.region] || null; } catch (e) { return null; } })();
  const R = region || declared || "the cloned region";
  const stripped = R.replace(/^the\s+/i, "");
  const cap = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  const verdicts = [`${cap} identical`, `${cap} slightly off`, `${cap} clearly different`];
  const steps = [
    { text: `Open the original and the clone side by side at the same window size. You are judging ${R} of ${site}. Everything outside it is out of scope — ignore it for your verdict.`, check: null },
  ];
  // Documented deviations are surfaced TO THE REVIEWER, or the gate's escape hatch and the
  // reviewer's expectations diverge forever: one round re-flagged bento cells that
  // behavior-deviations.json had honestly excused — the reviewer had no way to know.
  let deviationNote = "";
  try {
    const dev = readJson(path.join(targetDir(name), "behavior-deviations.json"));
    // Cross-reference entries ("See <other-key> — same phenomenon") exist for the GATE's
    // key-by-key bookkeeping, not for reviewers: one round surfaced 20 entries of which
    // 14 were "See mutation:… same phenomenon" fragments, and the 300-char budget rendered
    // the whole step as unreadable mush. Only PRIMARY entries face the reviewer.
    const primary = Object.fromEntries(Object.entries(dev).filter(([, v]) => !/^\s*See\s/i.test(String((v && v.reason) || ""))));
    const keys = Object.keys(primary);
    if (keys.length) {
      // The review service caps a step's `text` at 300 chars. As the number of documented
      // deviations grows, joining a per-entry reason snippet can blow past that even after
      // truncating each one — the step silently failed to file (Zod "too_big") instead of
      // degrading. Budget the PREFIX first, then divide what's left evenly across entries so
      // this scales to any count instead of hard-failing past ~2-3 deviations (kit-change
      // candidate — flagged here since review-qa.js is shared kit code, fixed minimally).
      const PREFIX = "KNOWN, INTENTIONAL differences — do NOT flag these (documented exclusions): ";
      const BUDGET = 300 - PREFIX.length;
      const perEntry = Math.max(20, Math.floor((BUDGET - (keys.length - 1) * 3) / keys.length));
      const lines = Object.entries(primary).map(([k, v]) => {
        const label = k.replace(/^[a-z]+:/, "");
        const reason = String((v && v.reason) || "");
        const snippet = `${label} — ${reason}`;
        return snippet.length > perEntry ? snippet.slice(0, Math.max(0, perEntry - 1)) + "…" : snippet;
      });
      steps.push({ text: (PREFIX + lines.join(" | ")).slice(0, 300), check: null });
      // `instructions` is a SEPARATE field with its own hard cap (observed: 1000 chars
      // total, shared with the fixed scope/verdict text below) — it is NOT the same budget
      // as the step's 300-char cap. Duplicating the full per-entry list here (as an earlier
      // version did) silently blew past 1000 once deviation count grew past ~15 (one round:
      // 34 entries -> 1152 chars -> the service rejected the whole filing with a Zod
      // "too_big" error, not a graceful truncation). Fix: `instructions` gets a SHORT,
      // fixed-size pointer to the dedicated step above (which already carries the full,
      // properly-budgeted list) instead of re-deriving its own copy from `keys.length`.
      deviationNote = ` See the "KNOWN, INTENTIONAL differences" step below (${keys.length} documented) — you should NOT flag those; they're already excused.`;
    }
  } catch (e) {}
  // Environment-BLOCKED phases (advance --blocked) are surfaced to the reviewer the same
  // way as documented deviations: the round is filed WITH the gap named, so the reviewer
  // judges the rest of the page on its merits instead of the round bouncing on a gap the
  // builder already receipted. (The mindmarket lesson: a filed round with a named gap
  // ships a fix list; a session that stops at the blocked gate ships nothing.)
  try {
    const st = readJson(path.join(targetDir(name), "workflow.json"));
    const blockedPhases = Object.entries(st.phases || {}).filter(([, v]) => v && v.status === "pass" && v.blocked);
    if (blockedPhases.length) {
      const GAP_PREFIX = "KNOWN GAP — could not be verified in this build environment: ";
      const parts = blockedPhases.map(([k, v]) => `${k} (${String(v.evidence || "environment constraint").replace(/\s+/g, " ").slice(0, 80)})`);
      steps.push({ text: (GAP_PREFIX + parts.join(" | ") + ". Related dynamics may be missing — note what you see missing so the fix list is complete, but judge the rest on its own merits.").slice(0, 300), check: null });
    }
  } catch (e) {}
  // Compare steps naming the certified marks. TWO service caps bind here and they fight each
  // other: a step's `text` caps at 300 chars, and the whole round caps at 20 STEPS. The old
  // fixed "5 leaves per step" satisfied the first and blew the second the moment a target was
  // gated at region:page — lelabo's 80 leaves produced 16 leaf steps + 6 fixed = 22, and the
  // service rejected the entire filing with a Zod "too_big" (not a graceful degrade), so the
  // round could not be filed at all. Pack leaves DENSELY instead (as many per step as 300 chars
  // allows) so the count scales with the region, and reserve room for the fixed steps below.
  // If even dense packing overflows, say so IN the round — a silently dropped leaf reads to the
  // reviewer as "not part of this clone", which is exactly the unverified-territory failure the
  // region rule exists to prevent.
  const FIXED_AFTER = 4; // squint + informational + describe + verdict (pushed below)
  // The changelog step is SPLICED IN below on a refile — it is a step too, and it must be
  // budgeted here or the refile blows the cap that the first filing squeaked under.
  const CHANGE_STEP = changelog && changelog.trim() ? 1 : 0;
  const LEAD = "Compare these elements between clone and original — position, size, color, font, spacing: ";
  const packed = [];
  let cur = [];
  for (const leaf of leaves) {
    const next = cur.concat(leaf);
    if (cur.length && (LEAD + next.join(", ") + ".").length > 300) { packed.push(cur); cur = [leaf]; }
    else cur = next;
  }
  if (cur.length) packed.push(cur);
  // THE OVERFLOW NOTICE IS ITSELF A STEP, and forgetting to budget for it is how the whole
  // filing gets rejected. Measured on chrono24 (396 painted leaves at region:page): dense packing
  // produced more groups than slots, so the "Also scan the REST" step was pushed ON TOP of a
  // already-full budget → 21 steps → the service refused the ENTIRE round with a Zod `too_big`,
  // exactly the not-a-graceful-degrade failure the dense packing was introduced to fix. The
  // reserve has to be made BEFORE we decide how many groups fit, not after.
  let slots = Math.max(1, 20 - steps.length - FIXED_AFTER - CHANGE_STEP);
  if (packed.length > slots) slots = Math.max(1, slots - 1); // one slot back for the notice itself
  const shown = packed.slice(0, slots);
  const dropped = packed.slice(slots).flat();
  for (const group of shown) {
    steps.push({
      text: `${LEAD}${group.join(", ")}.`,
      options: ["Identical", "Slightly off", "Clearly different"],
    });
  }
  if (dropped.length) {
    console.error(`⚠ review round: ${dropped.length} of ${leaves.length} covered leaves could not be listed individually (20-step service cap) — the round says so explicitly rather than dropping them silently.`);
    steps.push({
      text: `Also scan the REST of the region (${dropped.length} further covered elements not listed individually here — e.g. ${dropped.slice(0, 3).join(", ")}). They are part of this clone: flag anything off.`,
      options: ["Identical", "Slightly off", "Clearly different"],
    });
  }
  steps.push(
    { text: `Squint test: at a glance, could you tell which is the clone? Compare overall font weight/sharpness in ${R}.`, options: ["Could not tell apart", "Subtle difference", "Obvious difference"] },
    { text: "INFORMATIONAL (does not affect your verdict): the clone is a static snapshot — hover menus and animations may not run. Note any such difference; do not fail the review for it.", options: ["Same on both", "Different", "Didn't check"] },
    { text: `If anything in ${R} looked off, describe exactly what and where in your notes. Attach a screenshot showing both.`, check: null },
    // THE VERDICT STEP MUST NOT ASK FOR A BUTTON THAT DOES NOT EXIST. The reviewer-facing QA
    // surface renders a picker only for steps carrying an `options` array; this final step is
    // filed with `check: null` and the round-level `verdict_options` is not rendered at all — so
    // the verdict question shows NOTHING to choose from (lelabo rounds 4-5, chrono24 rounds 2-4:
    // six reviewers answered every option-bearing step and then typed something into the only
    // field they had, and every response came back choice:null).
    //
    // While that UI defect stands, telling them to "pick one of the verdict buttons" is an
    // instruction they cannot follow, and it produces exactly the failure we keep paying for: they
    // improvise a paraphrase ("cloned page identical"), and the free-text exception in `verify`
    // — which demands an EXACT match, and must, or it becomes the sentiment read the gate exists
    // to prevent — refuses it. So SAY WHAT ACTUALLY WORKS: if no buttons appear, type the verdict
    // VERBATIM. The wording is the only thing standing between a real approval and a wasted round.
    // The verdict strings ride on the STEP as `options`: option-bearing steps render as
    // pickers in today's reviewer app even though the round-level verdict button does not
    // (app update pending) — so the verdict is TAPPABLE now. The typed-copy fallback text
    // stays for renders where even step options fail.
    { text: `FINAL REQUIRED STEP — verdict. Buttons? Pick one. NO buttons (known bug)? COPY ONE OF THESE LINES EXACTLY as your comment here: "${verdicts[0]}" / "${verdicts[1]}" / "${verdicts[2]}". A paraphrase does not count.`, options: verdicts, check: null }
  );
  // What changed since the reviewer's last round, stated UP FRONT — one round's verdict was
  // literally "did you fix anything?": the round's substantive change was invisible without
  // being told where to look. A refile that doesn't say what changed wastes the pass.
  let changeNote = "";
  if (changelog && changelog.trim()) {
    changeNote = ` CHANGED SINCE YOUR LAST REVIEW: ${changelog.trim().slice(0, 200)}`;
    // step text caps at 300 chars API-side: budget = 300 − prefix, never prefix + 250
    // (52 + 250 = 302 failed a live filing)
    const CHG_PREFIX = "Changed since the last review — check these first: ";
    steps.splice(1, 0, { text: CHG_PREFIX + changelog.trim().slice(0, 300 - CHG_PREFIX.length), check: null });
  }
  return {
    url: target.url,
    draft_url: draftUrl,
    title: `${site} — is the clone identical? (round ${roundNo})`,
    instructions: `You are reviewing a clone of ${site} (${target.url}), round ${roundNo}.${ctx} Compare ONLY ${R}, side by side at the same width — everything outside it is out of scope.${changeNote}${deviationNote} When done, you MUST pick a verdict button — a comment-only review cannot be accepted.`,
    steps,
    verdict_options: verdicts,
    approve_verdicts: [verdicts[0]],
    n_target: 1,
    deadline_seconds: 86400,
    require_evidence: "screenshot",
  };
}

// ── round state ───────────────────────────────────────────────────────────────
const loadHq = (name) => (fs.existsSync(hqPath(name)) ? readJson(hqPath(name)) : { rounds: [] });
const saveHq = (name, hq) => fs.writeFileSync(hqPath(name), JSON.stringify(hq, null, 2) + "\n");

function pushRound(name, ping_id, spec, approve) {
  const hq = loadHq(name);
  hq.rounds.push({ ping_id, draft_url: (spec && spec.draft_url) || null, region: (spec && spec.title) || null, approve_verdicts: approve, verdict_options: (spec && spec.verdict_options) || null, filed_at: new Date().toISOString(), last: null, checked_at: null });
  saveHq(name, hq);
  return hq.rounds.length;
}

// ── diagnostic rounds — a scoped "what differs here?" compare, mid-pipeline ────
// A diagnostic round exists to surface the UNKNOWN flag while gates are still red — the
// opposite of a premature approval round (whose filing the gates-green guard refuses
// because it burns a credit on flags the builder already knows). It NEVER satisfies the
// review gate: recorded in hq.diagnostics, and verify() reads hq.rounds only; none of its
// verdict options is an approval of anything.
function buildDiagnosticSpec(name, draftUrl, region, ask) {
  const target = readJson(path.join(targetDir(name), "target.json"));
  let site = target.url;
  try { site = new URL(target.url).hostname.replace(/^www\./, ""); } catch (e) {}
  const R = region;
  const verdicts = ["Described the differences", "Looks identical here", "Could not compare"];
  const steps = [
    { text: `DIAGNOSTIC — not an approval. Open both pages side by side at the same width and look ONLY at ${R} of ${site}. The builder is stuck on it and needs your eyes, not a pass/fail.`.slice(0, 300), check: null },
  ];
  if (ask && ask.trim()) steps.push({ text: ask.trim().replace(/\s+/g, " ").slice(0, 300), check: null });
  steps.push(
    { text: `Describe exactly what differs in ${R} — and if you can see it, the MECHANISM: does it move on scroll, load late, use a different font or color, sit somewhere else? Attach a zoomed screenshot of both.`.slice(0, 300), check: null },
    // Same tappable-verdict contract as buildSpec: option-bearing steps render as pickers
    // today; the typed-copy fallback covers renders where even step options fail.
    { text: `FINAL REQUIRED STEP — verdict. Buttons? Pick one. NO buttons (known bug)? COPY ONE OF THESE LINES EXACTLY as your comment: "${verdicts[0]}" / "${verdicts[1]}" / "${verdicts[2]}".`, options: verdicts, check: null }
  );
  return {
    url: target.url,
    draft_url: draftUrl,
    title: `${site} — what differs in ${R}? (diagnostic)`,
    instructions: `Diagnostic help request on a clone of ${site} (${target.url}), scoped to ${R}. This is NOT an approval round: describe what differs and how — the builder acts on your description. Everything outside ${R} is out of scope.`,
    steps,
    verdict_options: verdicts,
    approve_verdicts: [], // none — a diagnostic can never approve anything
    n_target: 1,
    deadline_seconds: 86400,
    require_evidence: "screenshot",
  };
}

function pushDiagnostic(name, ping_id, spec, region, assistMeta) {
  const hq = loadHq(name);
  hq.diagnostics = hq.diagnostics || [];
  hq.diagnostics.push({ ping_id, kind: "diagnostic", region, draft_url: (spec && spec.draft_url) || null, filed_at: new Date().toISOString(), deadline_seconds: (spec && spec.deadline_seconds) || 86400, last: null, checked_at: null, ...(assistMeta ? { assist: assistMeta } : {}) });
  saveHq(name, hq);
  return hq.diagnostics.length;
}

// ── assist — compose the reviewer question FROM the failing phase's artifacts ──
// The stall detector (workflow.js) says WHEN to ask; this says WHAT. Every composed
// question is ONE-SIDED by construction (the reviewer looks at the live page only) —
// a side-by-side "what's different?" needs the compare UI of a filed round, which is
// what `assist --compare` files. Returns { ok, question, subject } or { ok:false, reason }.
function composeAssist(name, phaseKey) {
  const dir = targetDir(name);
  const width = (() => { try { return readJson(path.join(dir, "target.json")).width; } catch (e) { return null; } })();
  const at = width ? ` at ${width}px` : "";

  if (["target", "assets", "measure", "build"].includes(phaseKey)) {
    return { ok: false, reason: `the "${phaseKey}" phase fails mechanically (a missing or invalid artifact) — a reviewer cannot supply it. The gate names the fix: node harness/workflow.js gate ${name} ${phaseKey}` };
  }
  if (phaseKey === "review" || phaseKey === "done") {
    return { ok: false, reason: `"${phaseKey}" is the review loop itself — wait on the filed round (pingfusi wait <ping_id>) or refile with --changelog after fixes; an assist adds nothing a round doesn't already carry.` };
  }

  if (phaseKey === "visual" || phaseKey === "strict") {
    let live, clone;
    try { live = readJson(path.join(dir, "live.json")); clone = readJson(path.join(dir, "clone.json")); }
    catch (e) { return { ok: false, reason: `live.json/clone.json unreadable (${e.message}) — capture them first; a reviewer cannot supply a snapshot.` }; }
    const { diffSnapshots } = require("../tools/pixel-diff.js");
    const d = diffSnapshots(live, clone, phaseKey === "visual" ? { visual: true } : {});
    const fails = d.rows.filter((r) => !r.pass);
    if (!fails.length) return { ok: false, reason: `the ${phaseKey} diff has no failing rows right now — re-run the gate; there is nothing to ask about.` };
    // String-prop rows (color and friends) first — numbers describe them worst; then the
    // largest numeric delta. The worst mark is the one the agent has been circling.
    const worst = fails.find((r) => isNaN(parseFloat(r.delta))) ||
      fails.slice().sort((a, b) => (Math.abs(parseFloat(b.delta)) || 0) - (Math.abs(parseFloat(a.delta)) || 0))[0];
    const prop = String(worst.prop || "");
    // color before the generic font.* branch — font.color is a COLOR question, not a weight one
    const hint = /color|background/i.test(prop) ? "what exact color is it? attach a zoomed screenshot."
      : /^font/.test(prop) ? "how does the text read — bold, condensed or regular, and what size does it look?"
      : /underline|decoration|border|outline/i.test(prop) ? "how thick is the line and how far from the text does it sit?"
      : /^(x|y|w|h)$|width|height|gap|pad|margin|top|left|right|bottom/i.test(prop) ? "where exactly does it sit — flush against what, with how much space around it?"
      : "describe exactly what it looks like — size, weight, color, position.";
    return { ok: true, subject: slugToWords(worst.target), question: `On the live page${at}, look at the ${slugToWords(worst.target)} (its ${prop}): ${hint}` };
  }

  if (phaseKey === "coverage") {
    let leaves = [], liveEls = {}, cloneEls = {};
    try {
      const cov = readJson(path.join(dir, "coverage.json"));
      leaves = Array.isArray(cov) ? cov : cov.leaves || [];
      liveEls = readJson(path.join(dir, "live.json")).elements || {};
      cloneEls = readJson(path.join(dir, "clone.json")).elements || {};
    } catch (e) { return { ok: false, reason: `coverage artifacts unreadable (${e.message}) — enumerate the painted leaves first; a reviewer cannot do that for you.` }; }
    const uncovered = leaves.filter((n) => !(liveEls[n] && liveEls[n].present && cloneEls[n] && cloneEls[n].present));
    if (!uncovered.length) return { ok: false, reason: "coverage has no uncovered leaves right now — re-run the gate; there is nothing to ask about." };
    return { ok: true, subject: slugToWords(uncovered[0]), question: `On the live page${at}, find the ${slugToWords(uncovered[0])} — is it actually visible there, and what does it look like (size, color, position)?` };
  }

  if (phaseKey === "behavior") {
    // Environment-shaped failures first: a reviewer cannot fix the capture environment,
    // and the gate's own refusal already names the remedy (LEARNINGS #32) — steering an
    // assist there would spend $0.05 on a question no reviewer can answer.
    const wf = require("./workflow.js");
    const g = wf.safeGate(wf.PHASES.find((p) => p.key === "behavior"), name);
    if (!g.ok && /HIDDEN|behaviors-live\.json missing/.test(g.reason)) {
      return { ok: false, reason: `the behavior failure is environmental, not a judgment call — a reviewer cannot fix it. Do what the gate says: pingfusi behavior-capture ${name} (kit-owned Chrome, both sides).\n   gate said: ${g.reason.replace(/\s+/g, " ").slice(0, 200)}` };
    }
    let live = {}, clone = {};
    try { live = readJson(path.join(dir, "behaviors-live.json")); } catch (e) {}
    try { clone = readJson(path.join(dir, "behaviors-clone.json")); } catch (e) {}
    const descriptorOf = (k) => k.replace(/^[a-z-]+:/i, "");
    const cloneDescs = new Set(Object.keys((clone && clone.behaviors) || {}).map(descriptorOf));
    const rows = [...Object.entries(live.behaviors || {}), ...Object.entries(live.declared || {})];
    const pick = rows.find(([k]) => !cloneDescs.has(descriptorOf(k))) || rows[0];
    if (!pick) return { ok: false, reason: `no behavior rows to ask about — ${g.ok ? "the gate passes; advance it" : g.reason.replace(/\s+/g, " ").slice(0, 160)}` };
    const [key, b] = pick;
    // The proven one-sided worksheet format (tools/behavior-worksheet.js): when the machine
    // can't observe the truth, the reviewer is the measurement instrument.
    const where = b && b.text ? `the element reading "${b.text}"` : descriptorOf(key);
    const evidence = ((b && (b.hints || [b.trigger])) || ["animation"]).filter(Boolean).slice(0, 2).join(", ") || "animation";
    return { ok: true, subject: descriptorOf(key), question: `On the real page, near ${where}: something is supposed to animate there (${evidence}). What happens as you scroll/interact — how fast, which direction, when does it start, does it loop?` };
  }

  return { ok: false, reason: `unknown phase "${phaseKey}"` };
}

// A question naming BOTH the clone and the live page is a comparison — it needs the
// side-by-side compare UI of a filed round, not a text poll (flagged by a reviewer TWICE
// on one run; refusal, not advice — prose rules kept being skipped).
function comparisonShaped(question) {
  const namesTheClone = /\b(clone|draft|replica|copy|ours?|our (page|site|version))\b/i.test(question);
  const namesTheLive = /\b(original|real|live|reference|actual)\b[^.]{0,40}\b(page|site|version|one)\b|\bthe (original|real thing)\b/i.test(question);
  return namesTheClone && namesTheLive;
}

// Context the reviewer needs to answer a visual question: the draft + original urls.
// Draft resolution mirrors `file`'s: the hosted draft first, then the verified tunnel.
function pollContext(name) {
  let ctx = "";
  let draftUrl = null;
  try { draftUrl = readJson(path.join(targetDir(name), "draft.json")).url; } catch (e) {}
  if (!draftUrl) { try { draftUrl = readJson(path.join(targetDir(name), "tunnel.json")).url; } catch (e) {} }
  if (draftUrl) ctx += `\nDraft: ${draftUrl}`;
  try { ctx += `\nOriginal: ${readJson(path.join(targetDir(name), "target.json")).url}`; } catch (e) {}
  return ctx;
}

// Shared printer for poll-style answers: 0 once ≥1 answer exists, 1 while pending/expired.
function pollReport(name, hq, sc, entry) {
  entry.last = { status: sc.status, n_received: sc.n_received, responses: (sc.responses || []).map((r) => ({ choice: r.choice != null ? r.choice : null, text: r.free_text || r.text || null })) };
  entry.checked_at = new Date().toISOString();
  saveHq(name, hq);
  const resp = entry.last.responses;
  if (resp.length) {
    console.log(`poll answered (${resp.length}):` + resp.map((r) => `\n  ${r.choice != null ? `[${r.choice}] ` : ""}${r.text || ""}`).join(""));
    return 0;
  }
  console.error(`poll ${entry.ping_id} ${sc.status || "pending"} — 0 answers yet; re-check (free): node harness/review-qa.js poll-result ${name} ${entry.ping_id}`);
  return 1;
}

// File one micro-poll (shared by `poll` and `assist`): ~$0.05, the server blocks up to
// ~300s while a reviewer answers, so an answer often arrives inside the call.
async function fileMicroPoll(name, hq, question, choices, assistMeta) {
  const args_ = { question: question + pollContext(name), n_target: 1, deadline_seconds: 3600 };
  if (choices && choices.length) args_.choices = choices;
  const sc = await rpc("quick_poll", args_, 320_000);
  const entry = { ping_id: sc.ping_id || null, question, asked_at: new Date().toISOString(), deadline_seconds: 3600, last: null, checked_at: null, ...(assistMeta ? { assist: assistMeta } : {}) };
  hq.polls = hq.polls || [];
  hq.polls.push(entry);
  return { sc, entry };
}

// The latest assist that is still WAITING — filed, unanswered, unexpired. The one-open-ask
// cap reads this: a second unanswered ask multiplies credits without resolving the first
// (astryx superseded its own unpicked round and re-entered the same stalled queue).
function openAssist(hq) {
  const entries = [...(hq.polls || []), ...(hq.diagnostics || [])].filter((e) => e && e.assist && e.ping_id);
  for (const e of entries.reverse()) {
    const answered = e.last && e.last.responses && e.last.responses.length;
    const expired = e.last && e.last.status === "expired";
    const askedAt = e.asked_at || e.filed_at;
    const aged = askedAt ? Date.now() - Date.parse(askedAt) > ((e.deadline_seconds || 3600) * 1000) : false;
    if (!answered && !expired && !aged) return e;
  }
  return null;
}

// ── commands ──────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const opt = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const [cmd, name, extra] = args.filter((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
  if (!cmd || !name) { console.error("usage: review-qa.js template|file|record|verify <name> …  (see file header)"); process.exit(2); }
  if (!fs.existsSync(path.join(targetDir(name), "target.json"))) { console.error(`targets/${name}/target.json missing`); process.exit(1); }

  if (cmd === "template" || cmd === "file") {
    // --diagnostic files a SCOPED "what differs here?" round mid-pipeline. It is exempt
    // from the gates-green guard below because that guard exists to stop premature
    // APPROVAL rounds (which return flags the builder already knows); a diagnostic's
    // whole purpose is the unknown flag. It must be scoped (--region) — an unscoped
    // diagnostic of a half-built page IS a premature review — and it can never satisfy
    // the review gate (recorded in hq.diagnostics; verify reads hq.rounds only).
    const diagnostic = args.includes("--diagnostic");
    if (diagnostic && !(opt("--region") || "").trim()) {
      console.error(`❌ a diagnostic round must be scoped — pass --region "the <section>" so the reviewer describes ONE thing, not a half-built page.`);
      process.exit(2);
    }
    // A round filed while earlier gates are still red reviews an UNFINISHED clone — the
    // reviewer returns flags you already knew about and a credit is burned (paid for once:
    // filed before the behavior phase ran, racing the reviewer's claim). Filing isn't a
    // phase advance, so the state machine can't refuse it — this check is that refusal.
    // Canonical phase list comes from workflow.js (a workflow.json seeded before a phase
    // existed simply lacks its key — that phase is PENDING, not exempt); no workflow.json
    // at all = standalone usage, guard skipped. Blocked phases record status "pass"
    // (receipted overrides), so a --blocked receipt is exactly what lets this guard
    // let the round through — the spec carries the KNOWN GAP step for it.
    if (cmd === "file" && !args.includes("--anyway") && !diagnostic) {
      const wfPath = path.join(targetDir(name), "workflow.json");
      if (fs.existsSync(wfPath)) {
        const { PHASES } = require("./workflow.js");
        const st = readJson(wfPath);
        const beforeReview = PHASES.slice(0, PHASES.findIndex((p) => p.key === "review")).map((p) => p.key);
        const pending = beforeReview.filter((k) => !(st.phases && st.phases[k] && st.phases[k].status === "pass"));
        if (pending.length) {
          console.error(`❌ refusing to file — earlier phase(s) not passed: ${pending.join(", ")}. A review of an unfinished clone returns flags you already know about and burns a credit.\n   finish the gates first (node harness/workflow.js status ${name}), or override with --anyway if this round is deliberately out-of-band.`);
          process.exit(1);
        }
      }
    } else if (cmd === "file" && args.includes("--anyway")) {
      console.error("⚠ --anyway: filing without the pre-review gates all green — deliberate out-of-band round");
    } else if (cmd === "file" && diagnostic) {
      console.error("⚠ --diagnostic: scoped diagnostic round — advisory; it buys a description, never the review gate");
    }
    // Local review mode is GONE (removed 2026-07-10): the independent reviewer on the
    // review service is the only path — an operator-trusted local verdict was a forgeable
    // downgrade and confused the product story. A round is always answered by a reviewer
    // on the other side of the service, never by the operator, never by the agent.
    if (args.includes("--local") || args.includes("--allow-local")) {
      console.error("❌ local review mode was removed — review rounds go through the review service only.\n   no login? run: pingfusi setup");
      process.exit(1);
    }
    let draft = opt("--draft");
    // Default --draft to the HOSTED draft this target RECORDED (harness/draft.js push
    // writes it only after byte-verifying the served bytes), then to a verified tunnel
    // (adopted builds — a live dev server can't be pushed as static files).
    const dp = path.join(targetDir(name), "draft.json");
    const tp = path.join(targetDir(name), "tunnel.json");
    if (!draft && fs.existsSync(dp)) draft = readJson(dp).url;
    if (!draft && fs.existsSync(tp)) draft = readJson(tp).url;
    if (!draft || /localhost|127\.0\.0\.1/.test(draft)) {
      console.error("need a PUBLIC draft url — a remote reviewer opens it. Push the clone as a hosted draft first:\n  node harness/draft.js push " + name + "   (records targets/" + name + "/draft.json, used as the default)\nadopted build on its own dev server? tunnel it instead: node harness/tunnel.js " + name + " --url <dev-url>\nor pass --draft <url> explicitly.");
      process.exit(1);
    }
    const spec = diagnostic
      ? buildDiagnosticSpec(name, draft, opt("--region"), opt("--ask"))
      : buildSpec(name, draft, opt("--region"), opt("--changelog"), opt("--context"));
    if (cmd === "template") { console.log(JSON.stringify(spec, null, 2)); return; }
    // A round filed against a dead/wrong draft url burns the whole review round. Re-verify
    // AT FILE TIME: reachable is required; byte-identical to clone/index.html is expected
    // for a standalone clone (warn-only — a component served by an app dev server
    // legitimately differs). Hosted drafts (/d/<slug>) serve the clone with the service's
    // /assets/ rewrite applied, so they get the rewrite-aware compare.
    const idx = path.join(targetDir(name), "clone", "index.html");
    if (fs.existsSync(idx)) {
      const hosted = /\/d\/([A-Za-z0-9_-]{12})\/?$/.exec(draft || "");
      const v = hosted
        ? await require("./draft.js").verifyDraftServes(draft, idx, hosted[1])
        : await require("./tunnel.js").verifyServes(draft, idx);
      if (!v.ok && /unreachable|HTTP \d+/.test(v.reason)) { console.error(`❌ refusing to file — draft url is not serving: ${v.reason}`); process.exit(1); }
      if (!v.ok) console.error(`⚠ ${v.reason} — filing anyway (expected only when the draft is not the standalone clone)`);
    }
    const { approve_verdicts, ...toolArgs } = spec;
    const r = await rpc("request_review", toolArgs);
    if (!r.ping_id) throw new Error("filing returned no ping_id");
    if (diagnostic) {
      pushDiagnostic(name, r.ping_id, spec, opt("--region"), null);
      console.log(`✓ filed diagnostic round — ping ${r.ping_id} (scoped to ${opt("--region")})\n  advisory: it buys a description, never the review gate.\n  check (free): node harness/review-qa.js assist-result ${name} ${r.ping_id}`);
      return;
    }
    const round = pushRound(name, r.ping_id, spec, approve_verdicts);
    console.log(`✓ filed round ${round} — ping ${r.ping_id}\n  approve verdict: "${approve_verdicts[0]}"\n  gate: node harness/workflow.js gate ${name} review   (or: node harness/review-qa.js verify ${name})\n  wake on result: pingfusi wait ${r.ping_id}`);
    return;
  }

  if (cmd === "record") {
    if (!extra || !/^[0-9a-f-]{36}$/i.test(extra)) { console.error("usage: review-qa.js record <name> <ping_id> [--approve \"Verdict A,Verdict B\"]"); process.exit(2); }
    const approve = (opt("--approve") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!approve.length) { console.error('record needs --approve "…" — the verdict string(s) that count as approval for the round you filed'); process.exit(2); }
    const round = pushRound(name, extra, null, approve);
    console.log(`✓ recorded round ${round} — ping ${extra} (approve: ${approve.join(" | ")})`);
    return;
  }

  if (cmd === "verify") {
    const hq = loadHq(name);
    if (!hq.rounds.length) { console.error(`no review round recorded — file one: node harness/review-qa.js file ${name} --draft <public-url>`); process.exit(1); }
    const round = hq.rounds[hq.rounds.length - 1];
    // Local rounds no longer exist (removed 2026-07-10) — a round recorded by an old kit
    // version can't be verified as an independent verdict; refuse it by name.
    if (round.provider === "local") {
      console.error(`round ${hq.rounds.length} is a LOCAL round from a removed mode — local verdicts are not independent review. File a remote round: node harness/review-qa.js file ${name}`);
      process.exit(1);
    }
    const sc = await rpc("get_test_results", { ping_id: round.ping_id });
    // Real response schema (verified empirically): the verdict pick is `choice`, prose is
    // `free_text`; older/other shapes may use `verdict`/`notes` — accept both.
    round.last = { status: sc.status, n_received: sc.n_received, n_target: sc.n_target, responses: (sc.responses || []).map((r) => ({ verdict: r.choice != null ? r.choice : (r.verdict != null ? r.verdict : null), notes: r.free_text || r.notes || r.comment || null })) };
    round.checked_at = new Date().toISOString();
    saveHq(name, hq);
    const n = hq.rounds.length;
    const resp = round.last.responses;
    if (!resp.length) {
      console.error(sc.status === "expired" ? `round ${n} EXPIRED unanswered (ping ${round.ping_id}) — refile` : `round ${n} pending — ${sc.n_received}/${sc.n_target} responses (ping ${round.ping_id})`);
      process.exit(1);
    }
    // A response with NO verdict pick normally can never pass: INFERRING approval from prose is
    // the exact hole the gates exist to close. There is one narrow, non-inferring exception, and
    // it exists because the reviewer-facing UI can make the pick IMPOSSIBLE.
    //
    // Measured on lelabo (rounds 1-5): every step carrying an `options` array rendered as a
    // picker and was answered ("Identical" x6, "Could not tell apart", "Same on both") — but the
    // FINAL verdict step is built with `check: null` and NO options, and the round-level
    // `verdict_options` is not rendered as a picker by the QA surface. So the verdict question
    // showed the reviewer nothing to choose from. Two consecutive reviewers completed every
    // structured step and then typed the approving verdict verbatim into the only field they
    // had — a comment — and both responses came back `choice: null`. The round was unpassable
    // by construction, for every target, and the missing button was not the reviewer's fault.
    //
    // The exception is therefore an EXACT STRING MATCH against the round's own declared
    // approve_verdicts (case/whitespace-normalised) — not a sentiment read, not a keyword
    // search, not "looks good". It carries exactly the information the button would have
    // carried, entered through the only field the UI offered. Anything short of an exact match
    // still fails. The pass is RECEIPTED as free-text-matched so no one later mistakes it for a
    // real pick — `verdict_source` is written into review-qa.json and printed on stdout.
    // NARROW ON PURPOSE. Matching the approve verdict ANYWHERE in a reviewer's prose is wrong and
    // was already paid for once: on opendesign round 2 a PIN comment on a <div> read "Header
    // identical" — a description of an element, not a verdict — and inferring approval from it
    // would have passed a round nobody approved. So the match must come from the VERDICT STEP
    // ITSELF (the last step, the one that asks for the pick), and equal a declared approve verdict
    // exactly. A comment anywhere else, or prose that merely sounds approving ("looks good"),
    // still fails — as it must.
    const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
    const verdictStepIndex = Math.max(0, ((sc.responses || [])[0]?.steps_result || []).length - 1);
    // A verdict TAPPED on the verdict step: the step carries the verdict strings as
    // `options` precisely because option-bearing STEPS render as pickers in today's app
    // while the round-level button does not (update pending). A tapped option is the
    // verdict through a working control — accepted for approval AND rejection (a tapped
    // "clearly different" is a verdict, not a missing one), matched exactly against the
    // round's own declared list, receipted as verdict_step_answer so it is never mistaken
    // for a round-level pick. Remove with the free-text bridge below once the real button
    // ships.
    const allVerdicts = round.verdict_options || round.approve_verdicts || [];
    let answerMatched = 0;
    (sc.responses || []).forEach((raw, i) => {
      const r = resp[i];
      if (!r || r.verdict != null) return;
      const ans = norm((((raw || {}).steps_result || [])[verdictStepIndex] || {}).answer);
      if (!ans) return;
      const hit = allVerdicts.find((v) => norm(v) === ans);
      if (hit) { r.verdict = hit; r.verdict_source = "verdict_step_answer"; answerMatched++; }
    });
    if (answerMatched) {
      round.verdict_source = "verdict_step_answer";
      saveHq(name, hq);
      console.log(`⚠ round ${n}: ${answerMatched} verdict(s) came from the verdict STEP's option pick — the round-level button still doesn't render (app update pending); receipted as verdict_step_answer, never as a real pick.`);
    }
    const comments = Array.isArray(sc.comments) ? sc.comments : [];
    let freeTextMatched = 0;
    for (const r of resp) {
      if (r.verdict != null) continue;
      const onVerdictStep = comments.filter((c) => c.step_index === verdictStepIndex).map((c) => norm(c.text));
      const hit = (round.approve_verdicts || []).find((v) => onVerdictStep.includes(norm(v)));
      if (hit) { r.verdict = hit; r.verdict_source = "free_text_exact_match"; freeTextMatched++; }
    }
    if (freeTextMatched) {
      round.verdict_source = "free_text_exact_match";
      saveHq(name, hq);
      console.log(`⚠ round ${n}: ${freeTextMatched} response(s) had NO verdict pick, but their free text EXACTLY matches an approving verdict — accepted as approval and RECEIPTED as free_text_exact_match, not as a real pick.`);
      console.log(`  reason: the round's verdict question renders no options (the final step carries no \`options\` array, and \`verdict_options\` is not rendered as a picker), so the reviewer had no button to press.`);
      console.log(`  this is a UI defect, not a review defect — fix the picker and this exception stops firing.`);
    }
    const unpicked = resp.filter((r) => r.verdict == null);
    if (unpicked.length) {
      console.error(`round ${n} has ${unpicked.length} response(s) with NO verdict pick — comments alone can't pass the gate${unpicked[0].notes ? `; reviewer wrote: "${unpicked[0].notes}"` : ""}\nask the reviewer to pick a verdict option, or refile: node harness/review-qa.js file ${name} --draft <url>`);
      process.exit(1);
    }
    const rejected = resp.filter((r) => !round.approve_verdicts.includes(r.verdict));
    if (rejected.length) {
      console.error(`round ${n} NOT approved — ${rejected.map((r) => `"${r.verdict}"${r.notes ? ` — ${r.notes}` : ""}`).join("; ")}\nfix the flags (PLAYBOOK Phase 6: --inspect the flagged marks), redeploy, then refile: node harness/review-qa.js file ${name} --draft <url>`);
      process.exit(1);
    }
    console.log(`round ${n} approved by ${resp.length} reviewer(s): "${resp[0].verdict}" (ping ${round.ping_id})`);
    return;
  }

  if (cmd === "poll" || cmd === "poll-result") {
    const hq = loadHq(name);
    hq.polls = hq.polls || [];
    if (cmd === "poll-result") {
      if (!extra) { console.error("usage: review-qa.js poll-result <name> <ping_id>"); process.exit(2); }
      const entry = hq.polls.find((p) => p.ping_id === extra) || (() => { const e = { ping_id: extra, question: null, asked_at: null }; hq.polls.push(e); return e; })();
      process.exit(pollReport(name, hq, await rpc("get_ping", { ping_id: extra }), entry));
    }
    const question = extra;
    if (!question) { console.error('usage: review-qa.js poll <name> "question" [--choices "A,B,C"]'); process.exit(2); }
    // Comparison guard (see comparisonShaped): polls may reference ONE side; a question
    // naming both sides needs the compare UI of a filed round.
    if (comparisonShaped(question) && !args.includes("--allow-comparison")) {
      console.error(`❌ refusing to poll — this question names BOTH the clone and the live page, which makes it a COMPARISON: the reviewer needs the side-by-side compare UI, not a text question.\n   file a scoped compare round instead: node harness/review-qa.js file ${name} --region "<the section>"\n   (or, if this genuinely isn't a comparison, re-run with --allow-comparison)`);
      process.exit(1);
    }
    const choices = (opt("--choices") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const { sc, entry } = await fileMicroPoll(name, hq, question, choices, null);
    process.exit(pollReport(name, hq, sc, entry));
  }

  if (cmd === "assist-result") {
    if (!extra) { console.error("usage: review-qa.js assist-result <name> <ping_id>"); process.exit(2); }
    const hq = loadHq(name);
    hq.diagnostics = hq.diagnostics || [];
    const entry = hq.diagnostics.find((d) => d.ping_id === extra) || (() => { const e = { ping_id: extra, kind: "diagnostic", filed_at: null }; hq.diagnostics.push(e); return e; })();
    const sc = await rpc("get_test_results", { ping_id: extra });
    entry.last = { status: sc.status, n_received: sc.n_received, responses: (sc.responses || []).map((r) => ({ choice: r.choice != null ? r.choice : (r.verdict != null ? r.verdict : null), text: r.free_text || r.notes || r.comment || null })) };
    entry.checked_at = new Date().toISOString();
    saveHq(name, hq);
    const resp = entry.last.responses;
    if (resp.length) {
      console.log(`diagnostic answered (${resp.length}):` + resp.map((r) => `\n  ${r.choice != null ? `[${r.choice}] ` : ""}${r.text || ""}`).join(""));
      for (const c of (Array.isArray(sc.comments) ? sc.comments : []).slice(0, 6)) console.log(`  pin: ${c.text}${c.selector ? ` (${c.selector})` : ""}`);
      process.exit(0);
    }
    console.error(`diagnostic ${extra} ${sc.status || "pending"} — 0 answers yet; re-check (free): node harness/review-qa.js assist-result ${name} ${extra}`);
    process.exit(1);
  }

  if (cmd === "assist") {
    // The stall escalation: the STALLED banner (workflow.js/score.js) says WHEN, this
    // composes WHAT from the failing phase's own artifacts and files the cheapest channel
    // that answers it — a ~$0.05 one-sided micro-poll by default, a scoped diagnostic
    // round with --compare when the question is inherently two-sided. Advisory only:
    // neither channel ever satisfies the review gate.
    const wf = require("./workflow.js");
    const hq = loadHq(name);
    // ONE open assist per target — the queue-thrash cap.
    const open = openAssist(hq);
    if (open) {
      const check = open.kind === "diagnostic" ? `assist-result ${name} ${open.ping_id}` : `poll-result ${name} ${open.ping_id}`;
      console.error(`❌ an assist is already open (${open.kind === "diagnostic" ? "diagnostic round" : "poll"} ${open.ping_id}, phase ${open.assist.phase}) — never open a second ask while one is pending; it multiplies credits without resolving the first.\n   re-check it (free): node harness/review-qa.js ${check}`);
      process.exit(1);
    }
    // Resolve the stuck phase: --phase wins, else the first non-pass phase in order.
    let phaseKey = opt("--phase");
    if (!phaseKey) {
      try {
        const st = readJson(path.join(targetDir(name), "workflow.json"));
        const next = wf.PHASES.find((p) => !(st.phases[p.key] && st.phases[p.key].status === "pass"));
        phaseKey = next && next.key;
      } catch (e) {}
    }
    if (!phaseKey) { console.error(`assist can't tell which phase is stuck — no workflow.json here; pass --phase <key> (and --ask "…" if artifacts are missing).`); process.exit(2); }

    const ask = opt("--ask");
    const composed = ask
      ? { ok: true, question: ask, subject: "the flagged area" }
      : composeAssist(name, phaseKey);
    if (!composed.ok) { console.error(`❌ assist refused for "${phaseKey}": ${composed.reason}`); process.exit(1); }
    const wantCompare = args.includes("--compare");
    // Safety net for hand-written --ask text (composed questions are one-sided by
    // construction): a two-sided question through the poll channel strips the compare UI.
    if (!wantCompare && comparisonShaped(composed.question)) {
      console.error(`❌ this question names BOTH the clone and the live page — a comparison needs the side-by-side compare UI. Re-run with --compare to file a scoped diagnostic round instead.`);
      process.exit(1);
    }
    // Login check BEFORE any receipt — a failed filing must leave no ledger event (the
    // assist receipt is what resets the stall streak; an unfiled ask must not reset it).
    if (!BASE.startsWith("file://") && !resolveToken()) {
      console.error(`❌ assist needs a review login — run: pingfusi setup\n   continuing without a reviewer is a receipted call, not a silent one: node harness/workflow.js advance ${name} ${phaseKey} --blocked "<what you tried>" (environment constraints only) — or keep iterating.`);
      process.exit(1);
    }
    const assistMeta = { phase: phaseKey, streakAtAsk: wf.stallInfo(name, phaseKey).fails };

    if (wantCompare) {
      // Two-sided question → scoped DIAGNOSTIC round (full credit, review queue — the
      // poll is cheaper and faster; this is for when a one-sided description won't do).
      let draft = null;
      try { draft = readJson(path.join(targetDir(name), "draft.json")).url; } catch (e) {}
      if (!draft) { try { draft = readJson(path.join(targetDir(name), "tunnel.json")).url; } catch (e) {} }
      if (!draft || /localhost|127\.0\.0\.1/.test(draft)) {
        console.error(`❌ assist --compare files a round, and a remote reviewer must open the draft — push one first: node harness/draft.js push ${name}`);
        process.exit(1);
      }
      const region = /^the /i.test(composed.subject) ? composed.subject : `the ${composed.subject}`;
      const spec = buildDiagnosticSpec(name, draft, region, ask || composed.question);
      const { approve_verdicts, ...toolArgs } = spec;
      void approve_verdicts;
      const r = await rpc("request_review", toolArgs);
      if (!r.ping_id) throw new Error("diagnostic filing returned no ping_id");
      pushDiagnostic(name, r.ping_id, spec, region, assistMeta);
      try { wf.appendLedger(name, { ts: new Date().toISOString(), event: "assist", phase: phaseKey, runId: wf.runId(), gate: null, forced: false, ping_id: r.ping_id, reason: `assist diagnostic round filed: ${region}` }); } catch (e) {}
      console.log(`✓ diagnostic round filed — ping ${r.ping_id} (scoped to ${region}; full credit, enters the review queue)\n  advisory: it buys a description, never the review gate.\n  keep iterating; check between iterations (free): node harness/review-qa.js assist-result ${name} ${r.ping_id}`);
      return;
    }

    console.error(`assist (phase ${phaseKey}${assistMeta.streakAtAsk ? `, after ${assistMeta.streakAtAsk} failed advances` : ""}): ${composed.question}`);
    const { sc, entry } = await fileMicroPoll(name, hq, composed.question, null, assistMeta);
    if (entry.ping_id) {
      try { wf.appendLedger(name, { ts: new Date().toISOString(), event: "assist", phase: phaseKey, runId: wf.runId(), gate: null, forced: false, ping_id: entry.ping_id, reason: `assist poll filed: ${composed.question.slice(0, 80)}` }); } catch (e) {}
    }
    const answered = pollReport(name, hq, sc, entry) === 0;
    // Filing IS the success condition — the ask is in front of a reviewer either way.
    // Pending just means: keep iterating, re-check between iterations (free).
    if (!answered) console.error(`assist filed — keep iterating while it waits; the stall streak resets on the FILED receipt, not the answer.`);
    process.exit(entry.ping_id ? 0 : 1);
  }

  console.error(`unknown command "${cmd}" — template | file | record | verify | poll | poll-result | assist | assist-result`);
  process.exit(2);
}

// Exports BEFORE the main() call: main()'s synchronous prefix requires draft.js
// (hosted-draft verify), and draft.js requires this module back — with exports
// assigned last, that circular require captured undefined resolveToken/BASE and
// node printed circular-dependency warnings in the real `pingfusi review file` flow.
module.exports = { buildSpec, buildDiagnosticSpec, composeAssist, comparisonShaped, resolveToken, BASE };
if (require.main === module) main().catch((e) => { console.error(`review-qa: ${e.message}`); process.exit(1); });
