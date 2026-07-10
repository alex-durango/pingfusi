// harness/draft.js <push|status|delete> <name> — the HOSTED draft: the clone bundle
// uploaded to the review service and served at a stable public /d/<slug> url.
//
// WHY THIS EXISTS. The review phase needs a PUBLIC draft url. Quick tunnels provided it
// at the cost of ~6–11 min of bring-up/verify per run, a link that dies the moment this
// machine sleeps (a dead draft link burns a whole review round), and a fresh random
// hostname on every retry. A hosted draft is uploaded once, integrity-verified
// server-side against a declared manifest, and served independently of this machine
// until it expires (~7 days). This is the DEFAULT draft path; tunnels remain for
// adopted builds (a live dev server can't be uploaded as static files) and for the
// capture sink.
//
// USAGE
//   node harness/draft.js push   <name>   upload targets/<name>/clone/ → verify the
//                                         served bytes → record targets/<name>/draft.json
//   node harness/draft.js status <name>   re-verify the RECORDED draft (exit 0/1)
//   node harness/draft.js delete <name>   delete the hosted draft + remove draft.json
//
// Each push mints a NEW immutable url. The PREVIOUS draft is left to its TTL on
// purpose: an in-flight review round may still have a reviewer on the old url —
// deleting it would reproduce the dead-tunnel failure this tool exists to end.
//
// AUTH: the same login review-qa.js uses (pingfusi setup / PINGFUSI_TOKEN).
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { fileURLToPath } = require("url");
const { resolveToken, BASE } = require("./review-qa.js");

const WORK = process.cwd();
const targetDir = (name) => path.join(WORK, "targets", name);
const cloneDir = (name) => path.join(targetDir(name), "clone");
const draftPath = (name) => path.join(targetDir(name), "draft.json");
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);

// Server-side caps, mirrored so a too-big bundle is a named local failure before any
// bytes move. Keep in sync with the service's lib/drafts.ts.
const MAX_FILES = 300;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

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

async function push(name) {
  const dir = cloneDir(name);
  const idx = path.join(dir, "index.html");
  if (!fs.existsSync(idx)) { console.error(`targets/${name}/clone/index.html missing — build the clone first (pingfusi capture-build ${name}). Adopted builds (live dev servers) can't be pushed as static drafts — tunnel those: node harness/tunnel.js ${name} --url <dev-url>`); process.exit(1); }

  const files = buildManifest(dir);
  const total = files.reduce((n, f) => n + f.bytes, 0);
  if (files.length > MAX_FILES) { console.error(`clone/ has ${files.length} files (> ${MAX_FILES} cap) — that's not a captured clone bundle`); process.exit(1); }
  const big = files.find((f) => f.bytes > MAX_FILE_BYTES);
  if (big) { console.error(`${big.path} is ${big.bytes} bytes (> ${MAX_FILE_BYTES} per-file cap)`); process.exit(1); }
  if (total > MAX_TOTAL_BYTES) { console.error(`clone/ is ${total} bytes (> ${MAX_TOTAL_BYTES} total cap)`); process.exit(1); }

  console.log(`pushing ${files.length} file(s), ${total} bytes …`);
  const created = await api("/api/draft", { method: "POST", body: { name, files } });
  const slug = created.slug;
  if (!slug || !Array.isArray(created.uploads)) throw new Error("draft create returned no slug/uploads");

  for (const u of created.uploads) {
    const buf = fs.readFileSync(path.join(dir, u.path));
    const r = await fetchOrExplain(`upload ${u.path}`, u.url, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: buf, signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`upload ${u.path} → HTTP ${r.status}`);
  }
  await api(`/api/draft/${slug}/finalize`, { method: "POST" });

  // Serve urls are built from OUR base, not the server's echo — a BASE override
  // (staging, file:// selftests) must stay consistent end-to-end.
  const url = `${BASE}/d/${slug}`;
  const v = await verifyDraftServes(url, idx, slug);
  if (!v.ok) { console.error(`❌ draft finalized but the served bytes don't verify: ${v.reason}\n   NOT recording draft.json — re-push, and if it repeats the rewrite tables have drifted (kit vs service)`); process.exit(1); }

  fs.writeFileSync(draftPath(name), JSON.stringify({ url, slug, expires_at: created.expires_at || null, files: files.length, bytes: total, verifiedSha256: v.sha256, pushedAt: new Date().toISOString() }, null, 2) + "\n");
  console.log(`✓ hosted draft ready: ${url}\n  ${v.reason}\n  expires: ${created.expires_at || "~7 days"}\n  recorded → targets/${name}/draft.json (review-qa.js uses it as the default --draft)\n  next: node harness/review-qa.js file ${name}`);
}

async function status(name) {
  if (!fs.existsSync(draftPath(name))) { console.error(`no draft recorded — push one: node harness/draft.js push ${name}`); process.exit(1); }
  const d = JSON.parse(fs.readFileSync(draftPath(name), "utf8"));
  const v = await verifyDraftServes(d.url, path.join(cloneDir(name), "index.html"), d.slug);
  console.log(`${v.ok ? "✓" : "❌"} ${v.reason}`);
  if (!v.ok) console.error(`  the clone changed since the push, or the draft expired — re-push: node harness/draft.js push ${name}`);
  process.exit(v.ok ? 0 : 1);
}

async function del(name) {
  if (!fs.existsSync(draftPath(name))) { console.error(`no draft recorded for ${name}`); process.exit(1); }
  const d = JSON.parse(fs.readFileSync(draftPath(name), "utf8"));
  await api(`/api/draft/${d.slug}`, { method: "DELETE" });
  fs.unlinkSync(draftPath(name));
  console.log(`✓ deleted hosted draft ${d.slug} + targets/${name}/draft.json`);
}

async function main() {
  const [cmd, name] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!cmd || !name) { console.error("usage: node harness/draft.js push|status|delete <name>"); process.exit(2); }
  if (!fs.existsSync(targetDir(name))) { console.error(`targets/${name} missing — create it first: pingfusi new ${name} <url>`); process.exit(1); }
  if (cmd === "push") return push(name);
  if (cmd === "status") return status(name);
  if (cmd === "delete") return del(name);
  console.error(`unknown draft command "${cmd}" — push|status|delete`);
  process.exit(2);
}

if (require.main === module) main().catch((e) => { console.error(`draft: ${e.message}`); process.exit(1); });
module.exports = { buildManifest, rewriteAssetRefs, verifyDraftServes };
