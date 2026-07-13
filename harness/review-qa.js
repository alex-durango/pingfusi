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
  const R = region || "the cloned region";
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
  const slots = Math.max(1, 20 - steps.length - FIXED_AFTER);
  const LEAD = "Compare these elements between clone and original — position, size, color, font, spacing: ";
  const packed = [];
  let cur = [];
  for (const leaf of leaves) {
    const next = cur.concat(leaf);
    if (cur.length && (LEAD + next.join(", ") + ".").length > 300) { packed.push(cur); cur = [leaf]; }
    else cur = next;
  }
  if (cur.length) packed.push(cur);
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
    // Reviewers use the comment-pin flow and skip the verdict buttons unless told — the
    // first 3 real responses were comment-only (choice:null), which the gate rightly refuses
    // but which stalls the loop. The pick is therefore an explicit, REQUIRED final step.
    { text: `FINAL REQUIRED STEP: pick one of the verdict buttons ("${verdicts[0]}" / "${verdicts[1]}" / "${verdicts[2]}"). A review without a verdict pick cannot be accepted — comments alone don't count.`, check: null }
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
  hq.rounds.push({ ping_id, draft_url: (spec && spec.draft_url) || null, region: (spec && spec.title) || null, approve_verdicts: approve, filed_at: new Date().toISOString(), last: null, checked_at: null });
  saveHq(name, hq);
  return hq.rounds.length;
}

// ── commands ──────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const opt = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const [cmd, name, extra] = args.filter((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
  if (!cmd || !name) { console.error("usage: review-qa.js template|file|record|verify <name> …  (see file header)"); process.exit(2); }
  if (!fs.existsSync(path.join(targetDir(name), "target.json"))) { console.error(`targets/${name}/target.json missing`); process.exit(1); }

  if (cmd === "template" || cmd === "file") {
    // A round filed while earlier gates are still red reviews an UNFINISHED clone — the
    // reviewer returns flags you already knew about and a credit is burned (paid for once:
    // filed before the behavior phase ran, racing the reviewer's claim). Filing isn't a
    // phase advance, so the state machine can't refuse it — this check is that refusal.
    // Canonical phase list comes from workflow.js (a workflow.json seeded before a phase
    // existed simply lacks its key — that phase is PENDING, not exempt); no workflow.json
    // at all = standalone usage, guard skipped.
    if (cmd === "file" && !args.includes("--anyway")) {
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
    const spec = buildSpec(name, draft, opt("--region"), opt("--changelog"), opt("--context"));
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
    // shared printer: exit 0 once ≥1 answer exists, 1 while pending/expired
    const report = (sc, entry) => {
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
    };
    if (cmd === "poll-result") {
      if (!extra) { console.error("usage: review-qa.js poll-result <name> <ping_id>"); process.exit(2); }
      const entry = hq.polls.find((p) => p.ping_id === extra) || (() => { const e = { ping_id: extra, question: null, asked_at: null }; hq.polls.push(e); return e; })();
      process.exit(report(await rpc("get_ping", { ping_id: extra }), entry));
    }
    const question = extra;
    if (!question) { console.error('usage: review-qa.js poll <name> "question" [--choices "A,B,C"]'); process.exit(2); }
    // A comparison-shaped question ("does the clone match the real page?") through the
    // text-poll channel strips the reviewer of the side-by-side compare UI — flagged by a
    // reviewer TWICE on one run. Polls may reference ONE side; a question naming both sides
    // is a comparison and belongs in a filed round (file --region "…" scopes a quick compare
    // round). Refusal, not advice — prose rules kept being skipped.
    const namesTheClone = /\b(clone|draft|replica|copy|ours?|our (page|site|version))\b/i.test(question);
    const namesTheLive = /\b(original|real|live|reference|actual)\b[^.]{0,40}\b(page|site|version|one)\b|\bthe (original|real thing)\b/i.test(question);
    if (namesTheClone && namesTheLive && !args.includes("--allow-comparison")) {
      console.error(`❌ refusing to poll — this question names BOTH the clone and the live page, which makes it a COMPARISON: the reviewer needs the side-by-side compare UI, not a text question.\n   file a scoped compare round instead: node harness/review-qa.js file ${name} --region "<the section>"\n   (or, if this genuinely isn't a comparison, re-run with --allow-comparison)`);
      process.exit(1);
    }
    // context the reviewer needs to answer a visual question: the verified draft + original
    let ctx = "";
    try { ctx += `\nDraft: ${readJson(path.join(targetDir(name), "tunnel.json")).url}`; } catch (e) {}
    try { ctx += `\nOriginal: ${readJson(path.join(targetDir(name), "target.json")).url}`; } catch (e) {}
    const choices = (opt("--choices") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const args_ = { question: question + ctx, n_target: 1, deadline_seconds: 3600 };
    if (choices.length) args_.choices = choices;
    const sc = await rpc("quick_poll", args_, 320_000); // server blocks up to ~300s while a reviewer answers
    const entry = { ping_id: sc.ping_id || null, question, asked_at: new Date().toISOString(), last: null, checked_at: null };
    hq.polls.push(entry);
    process.exit(report(sc, entry));
  }

  console.error(`unknown command "${cmd}" — template | file | record | verify | poll | poll-result`);
  process.exit(2);
}

// Exports BEFORE the main() call: main()'s synchronous prefix requires draft.js
// (hosted-draft verify), and draft.js requires this module back — with exports
// assigned last, that circular require captured undefined resolveToken/BASE and
// node printed circular-dependency warnings in the real `pingfusi review file` flow.
module.exports = { buildSpec, resolveToken, BASE };
if (require.main === module) main().catch((e) => { console.error(`review-qa: ${e.message}`); process.exit(1); });
