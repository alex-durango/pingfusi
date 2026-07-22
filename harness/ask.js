#!/usr/bin/env node
// harness/ask.js — `pingfusi ask`: ONE question to a reviewer, from anywhere.
//
// The workspace-free generic verb, and the proof that packages/core is generic: filing
// a question uses the same wire every kit surface speaks (packages/core/ping.js) and
// ZERO cloning code — no target directory, nothing here reads or writes targets/.
// An agent picking between taglines, sanity-checking copy, or asking "which of these
// three looks best?" runs this from any directory, with only a review login.
//
// State is per-ask, under the kit's own home dir: ~/.pingfusi/asks/<ping_id>.json —
// the same record shape as a target's poll entries (question, n_target, asked_at,
// last {status, n_received, responses}, checked_at), so a later `ask result` from any
// session collects the answer.
//
// ADVISORY ONLY by doctrine: an ask buys an answer, never an approval — it satisfies
// no gate anywhere. The full round with a verdict is `pingfusi review` (clone targets)
// or core.review.file (any caller with its own state file).
//
// USAGE
//   pingfusi ask "<question>" [--options "A,B,C"] [--context "…"]
//       file the question (1 result, up to 1 credit). The server blocks up to ~300s
//       while a reviewer answers, then the same send operation continues the renewable
//       wait. No second command is required. --options renders tappable
//       choices (each capped at 40 chars — the service's option cap, refused locally
//       by name before any bytes move); --context is extra reviewer-facing color
//       appended after the question.
//   pingfusi ask result <ping_id>
//       collect the answer + notes (free re-fetch; exit 0 once ≥1 answer exists,
//       1 while pending/expired).
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { ping, pingResult } = require("../packages/core/ping.js");
const { SERVICE_CAPS, DEFAULT_AGENT_LEASE_SECONDS } = require("../packages/core/wire.js");

const CMD = process.env.PPK_ENTRY === "1" ? "pingfusi ask" : "node harness/ask.js";
const USAGE = `usage: ${CMD} "<question>" [--options "A,B,C"] [--context "…"]   |   ${CMD} result <ping_id>`;

// ── ask records: ~/.pingfusi/asks/<ping_id>.json ─────────────────────────────
// The id doubles as the filename, so it must be the service's uuid shape — anything
// else is refused rather than spliced into a path.
const PING_ID_RE = /^[0-9a-f-]{36}$/i;
const asksDir = () => path.join(os.homedir(), ".pingfusi", "asks");
const askPath = (pingId) => path.join(asksDir(), `${pingId}.json`);
const loadAsk = (pingId) => { try { return JSON.parse(fs.readFileSync(askPath(pingId), "utf8")); } catch (e) { return null; } };
function saveAsk(record) {
  fs.mkdirSync(asksDir(), { recursive: true });
  fs.writeFileSync(askPath(record.ping_id), JSON.stringify(record, null, 2) + "\n");
}

// Same semantic mapping as a target's poll records: the pick is `choice`, prose is
// `free_text` (older shapes may say `text`) — persisted as {choice, text}.
const semanticAnswers = (sc) => (sc.responses || []).map((r) => ({ choice: r.choice != null ? r.choice : null, text: r.free_text || r.text || null }));

function printAnswers(resp) {
  console.log(`ask answered (${resp.length}):` + resp.map((r) => `\n  ${r.choice != null ? `[${r.choice}] ` : ""}${r.text || ""}`).join(""));
}

// ── file the ask ──────────────────────────────────────────────────────────────
async function fileAsk(question, options, context) {
  // The service caps a choice's length; a too-long option is a named local failure
  // BEFORE any bytes move (same doctrine as the draft client's upload caps).
  const tooLong = options.find((o) => o.length > SERVICE_CAPS.maxOptionChars);
  if (tooLong) { console.error(`❌ option "${tooLong}" is ${tooLong.length} chars — the service caps options at ${SERVICE_CAPS.maxOptionChars}; shorten it.`); return 2; }
  const composed = context && context.trim() ? `${question}\nContext: ${context.trim().replace(/\s+/g, " ")}` : question;
  const sc = await ping(composed, { choices: options });
  if (!sc.ping_id || !PING_ID_RE.test(String(sc.ping_id))) {
    throw new Error(`the service returned no usable ping id (got ${JSON.stringify(sc.ping_id || null)}) — the ask was not recorded`);
  }
  const record = {
    ping_id: sc.ping_id,
    question,
    options: options.length ? options : null,
    context: context && context.trim() ? context.trim() : null,
    n_target: 1,
    asked_at: new Date().toISOString(),
    deadline_seconds: DEFAULT_AGENT_LEASE_SECONDS,
    last: { status: sc.status || "pending", n_received: Number(sc.n_received) || 0, responses: semanticAnswers(sc) },
    checked_at: new Date().toISOString(),
  };
  saveAsk(record);
  console.log(`✓ ask filed — ping ${sc.ping_id} (1 result, advisory; recorded: ~/.pingfusi/asks/${sc.ping_id}.json)`);
  if (record.last.responses.length) { printAnswers(record.last.responses); return 0; }
  console.log(`  no answer arrived before the send-and-wait budget ended; the idle ping will expire automatically`);
  return 0;
}

// ── collect the answer ────────────────────────────────────────────────────────
async function collectAsk(pingId) {
  const sc = await pingResult(pingId);
  // An ask filed on another machine/session still collects — a minimal record is created.
  const record = loadAsk(pingId) || { ping_id: pingId, question: null, options: null, context: null, n_target: 1, asked_at: null, deadline_seconds: DEFAULT_AGENT_LEASE_SECONDS, last: null, checked_at: null };
  record.last = { status: sc.status || "pending", n_received: Number(sc.n_received) || 0, responses: semanticAnswers(sc) };
  record.checked_at = new Date().toISOString();
  saveAsk(record);
  if (record.last.responses.length) { printAnswers(record.last.responses); return 0; }
  console.error(`ask ${pingId} ${sc.status || "pending"} — 0 answers yet; this passive snapshot did not renew the lease`);
  return 1;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  if (args[0] === "result") {
    const pingId = args[1];
    if (!pingId || !PING_ID_RE.test(pingId)) { console.error(`${USAGE}\n(<ping_id> is the 36-char id \`ask\` printed)`); process.exit(2); }
    process.exit(await collectAsk(pingId));
  }
  const question = (args[0] || "").trim();
  if (!question || question.startsWith("--")) { console.error(USAGE); process.exit(2); }
  const options = (opt("--options") || "").split(",").map((s) => s.trim()).filter(Boolean);
  process.exit(await fileAsk(question, options, opt("--context")));
}

module.exports = { asksDir, askPath, PING_ID_RE, semanticAnswers, fileAsk, collectAsk };
if (require.main === module) main().catch((e) => { console.error(`ask: ${e.message}`); process.exit(1); });
