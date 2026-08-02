#!/usr/bin/env node
// pingfusi MCP — bundled stdio↔HTTP proxy for the Claude Desktop Extension.
//
// Claude Desktop's extensions run a LOCAL stdio MCP server; our real server
// is hosted (streamable-HTTP at pingfusi.com/api/mcp). This thin proxy
// bridges the two: it reads newline-delimited JSON-RPC from stdin (what
// Desktop speaks), forwards each message to the hosted endpoint with the
// user's bearer, and writes the response back to stdout.
//
// Zero dependencies — Node built-ins only (global fetch, Node ≥18), so the
// bundle is self-contained and there is no `npx`/version-drift or OAuth-race
// surface (the failure modes of the old `npx mcp-remote` bridge). The token
// is supplied via PINGFUSI_TOKEN, injected from the extension's OS-keychain-
// encrypted `sensitive` config field by the manifest. CPYANY_TOKEN is still
// honoured as a fallback so a config copied from a cpyany-era install (or one
// hand-written against the old manifest) keeps authenticating.
//
// The hosted endpoint is stateless with JSON responses: a request → one
// application/json JSON-RPC response; a notification → HTTP 202 empty. We
// also tolerate an SSE (text/event-stream) response defensively.

import { stdin, stdout, stderr, env, exit } from "node:process";

// PINGHUMANS_MCP_URL keeps its legacy env NAME for compat. The default host is
// the dev-facing brand; both domains dual-serve the same deployment.
const MCP_URL = env.PINGHUMANS_MCP_URL || "https://pingfusi.com/api/mcp";
const TOKEN = (env.PINGFUSI_TOKEN || env.CPYANY_TOKEN || "").trim();
// Where a user MINTS a bearer token. /dashboard only lists and revokes active
// sessions — the one-click "Generate my token" card lives at /connect/token,
// and the manifest + README point there too. Keep all three in agreement.
const TOKEN_PAGE = "https://pingfusi.com/connect/token";

function log(msg) {
  // stderr only — stdout is the JSON-RPC channel and must stay clean.
  stderr.write(`[pingfusi] ${msg}\n`);
}

if (!TOKEN) {
  log(
    "No token configured. Open this extension's settings and paste your " +
      `pingfusi token (get one at ${TOKEN_PAGE}).`
  );
}

function emit(jsonLine) {
  // One write call per message → Node serializes stream writes, so concurrent
  // forwards can't interleave partial lines.
  stdout.write(jsonLine + "\n");
}

function replyError(message, code, msg) {
  // Only requests (with an id) get an error reply; notifications get nothing.
  if (message && message.id !== undefined && message.id !== null) {
    emit(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code, message: msg } }));
  }
}

let warnedAuth = false;

async function forward(message) {
  let res;
  try {
    res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The hosted endpoint requires BOTH (406 otherwise) and answers with
        // application/json.
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(message),
    });
  } catch (err) {
    log(`network error: ${err.message}`);
    return replyError(message, -32001, "pingfusi service unreachable — check your connection.");
  }

  if (res.status === 401) {
    if (!warnedAuth) {
      warnedAuth = true;
      log(
        `Token rejected (invalid or revoked). Update it in this extension's ` +
          `settings — get a fresh token at ${TOKEN_PAGE}.`
      );
    }
    return replyError(
      message,
      -32001,
      "pingfusi token is invalid or revoked. Update it in the extension settings."
    );
  }

  // Notification accepted — nothing to return.
  if (res.status === 202) return;

  const text = await res.text();
  if (!res.ok) {
    log(`HTTP ${res.status}: ${text.slice(0, 160)}`);
    return replyError(message, -32603, `pingfusi error (HTTP ${res.status}).`);
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/event-stream")) {
    // Defensive: extract JSON-RPC payloads from `data:` lines.
    for (const line of text.split(/\r?\n/)) {
      const m = /^data:\s?(.*)$/.exec(line);
      if (m && m[1].trim()) emit(m[1].trim());
    }
  } else if (text.trim()) {
    emit(text.trim());
  }
}

// ── stdin: newline-delimited JSON-RPC. Forwards run concurrently (a long
//    cpyany_poll poll must not block tools/list); each emit is one atomic
//    write so responses never interleave. On stdin end we drain in-flight
//    forwards before exiting — Desktop keeps the pipe open, but a piped/test
//    invocation would otherwise kill pending fetches.
const pending = new Set();
function track(p) {
  pending.add(p);
  p.finally(() => pending.delete(p));
}

let buf = "";
stdin.setEncoding("utf8");
stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`ignoring non-JSON line from client: ${line.slice(0, 80)}`);
      continue;
    }
    track(forward(msg).catch((e) => log(`forward failed: ${e.message}`)));
  }
});
stdin.on("end", async () => {
  await Promise.allSettled([...pending]);
  exit(0);
});
