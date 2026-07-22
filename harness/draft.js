// harness/draft.js <push|status|delete> <name> — the HOSTED draft: the clone bundle
// uploaded to the review service and served at a stable public /d/<slug> url.
//
// WHY THIS EXISTS. The review phase needs a PUBLIC draft url. Quick tunnels provided it
// at the cost of ~6–11 min of bring-up/verify per run, a link that dies the moment this
// machine sleeps (a dead draft link burns a whole review round), and a fresh random
// hostname on every retry. A hosted draft is uploaded once, integrity-verified
// server-side against a declared manifest, and served independently of this machine
// until it expires (~7 days). This is the DEFAULT draft path; tunnels remain for
// adopted builds that genuinely require a live server and for the capture sink.
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
// The hosted-draft CLIENT (api/buildManifest/rewriteAssetRefs/verifyDraftServes + the
// service caps and slug contract) moved verbatim to packages/core/drafts.js (2026-07-20
// core extraction) so the byte-critical rewrite regex exists exactly once kit-side;
// this file is the kit CLI over it — and re-exports the client so existing importers
// stay put. BASE comes from core's wire (the same login review-qa.js uses).
const { BASE } = require("../packages/core/wire.js");
const { api, buildManifest, fetchOrExplain, rewriteAssetRefs, verifyDraftServes, verifyDraftRecord, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, SLUG_RE } = require("../packages/core/drafts.js");

const WORK = process.cwd();
const targetDir = (name) => path.join(WORK, "targets", name);
const cloneDir = (name) => path.join(targetDir(name), "clone");
const draftPath = (name) => path.join(targetDir(name), "draft.json");

async function push(name) {
  const dir = cloneDir(name);
  const idx = path.join(dir, "index.html");
  if (!fs.existsSync(idx)) { console.error(`targets/${name}/clone/index.html missing — build the clone first (pingfusi capture-build ${name}). For an adopted build, publish its production output instead: pingfusi publish <built-dir> --target ${name}. Tunnel only if it truly requires a live server.`); process.exit(1); }

  const files = buildManifest(dir);
  const total = files.reduce((n, f) => n + f.bytes, 0);
  if (files.length > MAX_FILES) { console.error(`clone/ has ${files.length} files (> ${MAX_FILES} cap) — that's not a captured clone bundle`); process.exit(1); }
  const big = files.find((f) => f.bytes > MAX_FILE_BYTES);
  if (big) { console.error(`${big.path} is ${big.bytes} bytes (> ${MAX_FILE_BYTES} per-file cap)`); process.exit(1); }
  if (total > MAX_TOTAL_BYTES) { console.error(`clone/ is ${total} bytes (> ${MAX_TOTAL_BYTES} total cap)`); process.exit(1); }

  console.log(`pushing ${files.length} file(s), ${total} bytes …`);
  const created = await api("/api/draft", { method: "POST", body: { name, files } });
  const slug = created.slug;
  if (!SLUG_RE.test(String(slug || "")) || !Array.isArray(created.uploads)) throw new Error("draft create returned no valid slug/uploads");

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
  const idx = path.join(cloneDir(name), "index.html");
  const v = fs.existsSync(idx)
    ? await verifyDraftServes(d.url, idx, d.slug)
    : await verifyDraftRecord(d);
  console.log(`${v.ok ? "✓" : "❌"} ${v.reason}`);
  if (!v.ok) console.error(fs.existsSync(idx)
    ? `  the clone changed since the push, or the draft expired — re-push: node harness/draft.js push ${name}`
    : `  the hosted build changed or expired — publish it again: pingfusi publish <built-dir> --target ${name}`);
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
// Other publishers can reuse this same client so the byte-critical
// rewrite regex, the service caps, and the slug contract exist exactly once kit-side
// (the client itself lives in packages/core/drafts.js; re-exported here unchanged).
module.exports = { api, buildManifest, fetchOrExplain, rewriteAssetRefs, verifyDraftServes, verifyDraftRecord, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, SLUG_RE };
