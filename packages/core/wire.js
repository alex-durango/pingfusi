// packages/core/wire.js — the review service transport: login resolution, the one
// JSON-RPC call, and the service's request caps. Extracted from harness/review-qa.js
// (2026-07-20 core extraction) so every kit surface that talks to the service — review
// rounds, polls, hosted drafts, capture sessions — speaks through exactly one wire.
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

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const BASE = process.env.PPK_PINGHUMANS_URL || process.env.PINGFUSI_APP_URL || process.env.PINGHUMANS_APP_URL || "https://pingfusi.com";
const DEFAULT_REVIEW_RESULTS = 1;
const MAX_REVIEW_RESULTS = 20;
// Mirrors the service's default renewable idle lease for agent-filed work.
// Clients normally omit deadline_seconds so the service remains authoritative.
const DEFAULT_AGENT_LEASE_SECONDS = 60;
// A send operation owns its waiter. After each service-side request reaches
// its hosting ceiling, the same local command opens the next renewable wait.
// Zero means no overall cutoff: interrupting the caller ends the wait.
const DEFAULT_SEND_WAIT_SECONDS = 0;

// The review service's round-filing caps, mirrored kit-side so a too-big filing is a
// named local failure before any bytes move (same doctrine as drafts.js's upload caps).
// Paid for twice before they were budgeted: a round past 20 steps or a step past 300
// chars is rejected WHOLE with a Zod "too_big" — not a graceful degrade (lelabo's 80
// leaves, chrono24's 396; harness/review-qa.js buildSpec packs to these numbers).
const SERVICE_CAPS = { maxSteps: 20, maxStepTextChars: 300, maxOptionChars: 40 };

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
//   get_test_results-<ping_id>.json / wait_for_results-<ping_id>.json /
//   request_review.json
//
// The LIVE api/mcp endpoint's tools/list exposes these under the service's own namespace
// (`cpyany_test`, `cpyany_test_results`), not the generic names this file uses
// internally — confirmed empirically: a live call with the generic name fails with
// "Tool not found" even with a valid token, while `tools/list` on the same endpoint
// returns `cpyany_test`/`cpyany_test_results`/`cpyany_poll`/`cpyany_poll_results`/
// `cpyany_wait`/`cpyany_check_source`. Kept the internal names (and the file:// fixture
// filenames / selftest) unchanged — only the wire method name sent to the LIVE endpoint
// is remapped, right before the fetch.
const LIVE_TOOL_NAME = { request_review: "cpyany_test", get_test_results: "cpyany_test_results", wait_for_results: "cpyany_wait", quick_poll: "cpyany_poll", get_ping: "cpyany_poll_results" };

const sendOwnsWait = (name) => name === "request_review" || name === "quick_poll";
const hasPingNews = (result) => {
  const received = Number(result && result.n_received) || (Array.isArray(result && result.responses) ? result.responses.length : 0);
  return !result || result.status !== "pending" || received > 0;
};

async function finishSendWait(name, initial) {
  if (!sendOwnsWait(name) || hasPingNews(initial) || !initial.ping_id) return initial;
  if (BASE.startsWith("file://")) {
    const fixture = path.join(fileURLToPath(BASE), `wait_for_results-${initial.ping_id}.json`);
    if (!fs.existsSync(fixture)) return initial;
  }
  const configured = Number.parseInt(process.env.PINGFUSI_SEND_WAIT_SECONDS || "", 10);
  const waitSeconds = Number.isFinite(configured) && configured > 0
    ? Math.max(30, Math.min(3600, configured))
    : DEFAULT_SEND_WAIT_SECONDS;
  const deadline = waitSeconds > 0 ? Date.now() + waitSeconds * 1000 : Infinity;
  let latest = initial;
  while (Date.now() < deadline) {
    const remaining = Number.isFinite(deadline)
      ? Math.ceil((deadline - Date.now()) / 1000)
      : 240;
    const maxWaitSeconds = Math.max(10, Math.min(240, remaining));
    const next = await rpc("wait_for_results", {
      ping_id: initial.ping_id,
      max_wait_seconds: maxWaitSeconds,
    });
    latest = { ...next, ping_id: next.ping_id || initial.ping_id };
    if (hasPingNews(latest)) return latest;
    // file:// fixtures are one immutable snapshot; never busy-loop in tests.
    if (BASE.startsWith("file://")) return latest;
  }
  return latest;
}

async function rpc(name, args, timeoutMs) {
  if (BASE.startsWith("file://")) {
    const dir = fileURLToPath(BASE);
    const f = name === "get_test_results" ? `get_test_results-${args.ping_id}.json`
      : name === "wait_for_results" ? `wait_for_results-${args.ping_id}.json`
      : name === "get_ping" ? `get_ping-${args.ping_id}.json`
      : `${name}.json`;
    return finishSendWait(name, readJson(path.join(dir, f)));
  }
  const token = resolveToken();
  if (!token) throw new Error("no review login — run `pingfusi setup`, or set PINGFUSI_TOKEN");
  const wireName = LIVE_TOOL_NAME[name] || name;
  const res = await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: wireName, arguments: args } }),
    // Filing is the first server-side leg of the send-owned wait (issue #24),
    // and explicit recovery waits block by design. Give both route-safe
    // headroom; passive reads stay snappy.
    signal: AbortSignal.timeout(timeoutMs || (name === "request_review" ? 285_000
      : name === "quick_poll" ? 320_000
      : name === "wait_for_results" ? ((Number(args.max_wait_seconds) || 45) + 15) * 1000
      : 20_000)),
  });
  const raw = await res.text();
  const m = raw.match(/data: (.*)/);
  const payload = JSON.parse(m ? m[1] : raw);
  if (payload.error) throw new Error(payload.error.message || "MCP error");
  const r = payload.result || {};
  if (r.isError) throw new Error((r.content && r.content[0] && r.content[0].text) || "the review service returned an error");
  if (r.structuredContent) return finishSendWait(name, r.structuredContent);
  try { return finishSendWait(name, JSON.parse(r.content[0].text)); } catch (e) { throw new Error("unexpected RPC response shape"); }
}

module.exports = { BASE, DEFAULT_REVIEW_RESULTS, MAX_REVIEW_RESULTS, DEFAULT_AGENT_LEASE_SECONDS, DEFAULT_SEND_WAIT_SECONDS, SERVICE_CAPS, LIVE_TOOL_NAME, resolveToken, rpc };
