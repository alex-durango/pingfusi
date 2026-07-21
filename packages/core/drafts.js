// packages/core/drafts.js — the hosted-draft client: the authenticated JSON API call,
// the upload manifest walk, the byte-critical /assets/ rewrite, the served-bytes
// verify, and the service caps. Extracted from harness/draft.js (2026-07-20 core
// extraction) so the rewrite regex, the caps, and the slug contract exist exactly once
// kit-side; harness/draft.js is the CLI consumer.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { fileURLToPath } = require("url");
const { resolveToken, BASE } = require("./wire.js");

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);

// Server-side caps, mirrored so a too-big bundle is a named local failure before any
// bytes move. Keep in sync with the service's lib/drafts.ts.
const MAX_FILES = 300;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
// Service-minted slugs are 9 random bytes base64url (12 chars) — "-" and "_" can LEAD.
// The charset must stay closed (slugs are spliced into /d/<slug>/ urls and the rewrite
// below); the length bounds are loose so a service-side length change is not an outage.
const SLUG_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Walk the clone dir into the upload manifest: [{ path: "assets/css/x.css", bytes }].
// Dotfiles (.DS_Store) are workspace noise, never part of the clone — skipped.
function buildManifest(dir) {
  const files = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), p);
      else files.push({ path: p, bytes: fs.statSync(path.join(d, e.name)).size });
    }
  };
  walk(dir, "");
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// The service serves html/css with the kit's root-absolute self-hosted refs
// (/assets/…) anchored into the draft's path space (/d/<slug>/assets/…). This is that
// transform, byte-for-byte — MUST stay identical to rewriteAssetRefs in the service's
// lib/drafts.ts, or push's byte-verify below reports false mismatches.
function rewriteAssetRefs(text, slug) {
  return text.replace(/(["'(])\/assets\//g, `$1/d/${slug}/assets/`);
}

// Does `url` serve clone/index.html AS THE SERVICE WOULD RENDER IT (the known rewrite
// applied)? Same record-only-verified-facts contract as tunnel.js. file:// urls read
// from disk so the compare logic is testable offline.
async function verifyDraftServes(url, indexPath, slug) {
  const expected = Buffer.from(rewriteAssetRefs(fs.readFileSync(indexPath, "utf8"), slug), "utf8");
  let got;
  try {
    if (url.startsWith("file://")) got = fs.readFileSync(fileURLToPath(url));
    else {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { "cache-control": "no-cache" } });
      if (!r.ok) return { ok: false, reason: `HTTP ${r.status} from ${url}` };
      got = Buffer.from(await r.arrayBuffer());
    }
  } catch (e) {
    return { ok: false, reason: `unreachable: ${url} — ${e.message}` };
  }
  if (!got.equals(expected)) return { ok: false, reason: `${url} responds but the bytes are NOT clone/index.html (after the service's /assets/ rewrite): ${got.length} vs ${expected.length} bytes — stale draft or wrong slug` };
  return { ok: true, reason: `verified: ${url} serves clone/index.html byte-identically (rewrite-aware)`, sha256: sha(expected) };
}

// node's fetch rejects with a bare "fetch failed" and hides the real cause in
// e.cause — surface both plus WHICH request died, or a mid-push failure is
// undiagnosable (the kit's own self-describing-errors contract).
async function fetchOrExplain(what, url, init) {
  try {
    return await fetch(url, init);
  } catch (e) {
    const cause = e.cause ? ` — ${e.cause.code || ""} ${e.cause.message || e.cause}` : "";
    throw new Error(`${what}: ${e.message}${cause} (${url.slice(0, 80)})`);
  }
}

async function api(pathname, opts = {}) {
  const token = resolveToken();
  if (!token) throw new Error("no review login — run `pingfusi setup`, or set PINGFUSI_TOKEN");
  const r = await fetchOrExplain(pathname, `${BASE}${pathname}`, {
    method: opts.method || "GET",
    headers: { authorization: `Bearer ${token}`, ...(opts.body ? { "content-type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  let payload = {};
  try { payload = JSON.parse(await r.text()); } catch (e) {}
  if (!r.ok) throw new Error(`${pathname} → HTTP ${r.status}${payload.error ? `: ${payload.error}` : ""}${payload.missing ? ` missing=${JSON.stringify(payload.missing)}` : ""}${payload.size_mismatch && payload.size_mismatch.length ? ` size_mismatch=${JSON.stringify(payload.size_mismatch)}` : ""}`);
  return payload;
}

module.exports = { api, buildManifest, fetchOrExplain, rewriteAssetRefs, verifyDraftServes, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, SLUG_RE };
