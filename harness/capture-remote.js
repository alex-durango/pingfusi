// harness/capture-remote.js — hosted capture delivery: a REMOTE SINK on the
// review service.
//
// WHY. The three local delivery paths all have environment failure modes:
// page→localhost fetch is blackholed by agent-browser extensions (a 45s hang,
// no error), quick tunnels are slow/flaky (and no longer installed by setup),
// and the browser-download path (pxSave) is silently rationed — Chrome allows
// ONE programmatic download per tab, and every later save no-ops while
// returning success-shaped {bytes, sha256} (found live 2026-07-12). A hosted
// session gives every capture the same one-call delivery as the local sink,
// with the same integrity contract, from any page, with loud failures.
//
// USAGE
//   node harness/capture-remote.js open <target>
//       open a 24h session → targets/<target>/capture-session.json; prints the
//       sink_url. On any page the kit's senders then work unchanged:
//         await pxSendDom('<sink_url>/dom.html')
//         await pxSend('<sink_url>/live.json')
//   node harness/capture-remote.js pull <target> <name> [--dest <path>]
//       download one delivered capture, verify bytes+sha256 against the
//       service's recorded values, write into targets/<target>/<name>
//   node harness/capture-remote.js pull <target> --all
//       pull every file the session has received
//
// AUTH: the same login + base-url resolution as review-qa.js (bearer token;
// PPK_PINGHUMANS_URL / PINGFUSI_APP_URL overrides the base; a file:// base
// serves canned responses from disk for the offline selftest).
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { fileURLToPath } = require("url");
const { resolveToken, BASE } = require("./review-qa.js");

const WORK = process.cwd();
const targetDir = (name) => path.join(WORK, "targets", name);
const sessionPath = (name) => path.join(targetDir(name), "capture-session.json");
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Pure: verify pulled bytes against the service-recorded facts. Exported for
// the selftest — this check is the whole point of the pull command.
function verifyPulled(buf, meta) {
  if (meta.bytes != null && buf.length !== Number(meta.bytes))
    return { ok: false, reason: `pulled ${buf.length} bytes but the service recorded ${meta.bytes} — transfer truncated; re-pull` };
  const got = sha256(buf);
  if (meta.sha256 && got !== meta.sha256)
    return { ok: false, reason: `sha256 mismatch (recorded ${String(meta.sha256).slice(0, 12)}…, pulled ${got.slice(0, 12)}…) — transfer corrupted; re-pull` };
  return { ok: true, reason: `verified ${buf.length} bytes, sha256 ${got.slice(0, 16)}…` };
}

// One service call. file:// base → canned responses from disk:
//   open → capture-open.json ; list → capture-list.json ;
//   file bytes → capture-file-<name> (meta from capture-list.json)
async function api(kind, { name, ticket, file } = {}) {
  if (BASE.startsWith("file://")) {
    const dir = fileURLToPath(BASE);
    if (kind === "open") return { json: readJson(path.join(dir, "capture-open.json")) };
    if (kind === "list") return { json: readJson(path.join(dir, "capture-list.json")) };
    const list = readJson(path.join(dir, "capture-list.json"));
    const meta = (list.files || []).find((f) => f.name === file);
    if (!meta) return { status: 404 };
    return { bytes: fs.readFileSync(path.join(dir, `capture-file-${file}`)), meta };
  }
  const token = resolveToken();
  if (!token) throw new Error("no review login — hosted capture sessions need it: run `pingfusi setup`");
  const headers = { authorization: `Bearer ${token}` };
  if (kind === "open") {
    const r = await fetch(`${BASE}/api/capture`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status !== 201) throw new Error(`could not open a capture session (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}`);
    return { json: await r.json() };
  }
  if (kind === "list") {
    const r = await fetch(`${BASE}/api/capture/${ticket}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (r.status !== 200) throw new Error(`could not list the session (HTTP ${r.status}) — expired? open a fresh one: pingfusi capture open <target>`);
    return { json: await r.json() };
  }
  const r = await fetch(`${BASE}/api/capture/${ticket}/${file}`, { headers, signal: AbortSignal.timeout(60_000) });
  if (r.status === 404) return { status: 404 };
  if (r.status !== 200) throw new Error(`pull failed (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}`);
  return {
    bytes: Buffer.from(await r.arrayBuffer()),
    meta: { bytes: r.headers.get("x-capture-bytes"), sha256: r.headers.get("x-capture-sha256") },
  };
}

async function cmdOpen(name) {
  if (!fs.existsSync(targetDir(name))) { console.error(`no targets/${name} — create it first: pingfusi new ${name} <url>`); process.exit(1); }
  const { json } = await api("open", { name });
  if (!json.ticket || !json.sink_url) throw new Error("service returned no ticket/sink_url");
  fs.writeFileSync(sessionPath(name), JSON.stringify(json, null, 2) + "\n");
  console.log(`✓ capture session open — expires ${json.expires_at}\n  sink_url: ${json.sink_url}\n  deliver from ANY page (integrity-verified, unlimited calls):\n    await pxSendDom('${json.sink_url}/dom.html')\n    await pxSend('${json.sink_url}/live.json', pxTargets)\n  then: pingfusi capture pull ${name} --all`);
}

async function pullOne(name, ticket, file, destDir) {
  const r = await api("file", { ticket, file });
  if (r.status === 404) { console.error(`✗ ${file}: not delivered to this session yet`); return false; }
  const v = verifyPulled(r.bytes, r.meta || {});
  if (!v.ok) { console.error(`✗ ${file}: ${v.reason}`); return false; }
  const dest = path.join(destDir, file);
  fs.writeFileSync(dest, r.bytes);
  console.log(`✓ ${path.relative(WORK, dest)} — ${v.reason}`);
  return true;
}

async function cmdPull(name, fileArg, destOverride) {
  if (!fs.existsSync(sessionPath(name))) { console.error(`no capture session for ${name} — open one: pingfusi capture open ${name}`); process.exit(1); }
  const session = readJson(sessionPath(name));
  if (session.expires_at && Date.parse(session.expires_at) < Date.now()) {
    console.error(`capture session expired ${session.expires_at} — open a fresh one: pingfusi capture open ${name}`);
    process.exit(1);
  }
  const destDir = destOverride || targetDir(name);
  fs.mkdirSync(destDir, { recursive: true });
  let files = [fileArg];
  if (fileArg === "--all") {
    const { json } = await api("list", { ticket: session.ticket });
    files = (json.files || []).map((f) => f.name);
    if (!files.length) { console.error("session has received no captures yet — deliver first (pxSend/pxSendDom to the sink_url)"); process.exit(1); }
  }
  let ok = true;
  for (const f of files) ok = (await pullOne(name, session.ticket, f, destDir)) && ok;
  process.exit(ok ? 0 : 1);
}

async function main() {
  const [cmd, name, extra] = process.argv.slice(2).filter((a) => a !== "--dest");
  const destIdx = process.argv.indexOf("--dest");
  const dest = destIdx > -1 ? process.argv[destIdx + 1] : null;
  if (cmd === "open" && name) return cmdOpen(name);
  if (cmd === "pull" && name && extra) return cmdPull(name, extra, dest);
  console.error("usage: pingfusi capture open <target> | pingfusi capture pull <target> <name>|--all [--dest <dir>]");
  process.exit(2);
}

module.exports = { verifyPulled, sessionPath };
if (require.main === module) main().catch((e) => { console.error(`capture: ${e.message}`); process.exit(1); });
