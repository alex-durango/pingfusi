// harness/tunnel.js <name> [port=8080] [--check] — a public HTTPS tunnel for the clone,
// VERIFIED to be serving it before it is ever handed to a reviewer.
//
// WHY THIS EXISTS. The review phase needs a PUBLIC url (a remote reviewer opens
// it; localhost is unreachable), and a test filed against a dead or wrong tunnel burns a
// whole review round — that was hn's QA round 1 verbatim: "(clone unreachable — tunnel
// died)". So this tool treats "the tunnel serves the clone" as a gate-shaped fact, not an
// assumption: it spawns cloudflared, parses the public url, FETCHES it, and byte-compares
// the response to targets/<name>/clone/index.html. Only a verified tunnel is recorded to
// targets/<name>/tunnel.json — which review-qa.js then uses as the default --draft, and
// re-checks at file time (a tunnel verified once can still die before filing).
//
// USAGE
//   node harness/tunnel.js <name> [port=8080]     spawn + verify + record; stays attached
//                                                 (run it as a background task), Ctrl-C stops it
//   node harness/tunnel.js <name> --check         re-verify the RECORDED tunnel (exit 0/1)
//   node harness/tunnel.js --sink [port=7799]     tunnel the SINK: gives live-page captures a
//                                                 public HTTPS target when the automation
//                                                 environment blocks page→localhost fetch (the
//                                                 ~4s abort, RUNBOOK Step 0) — pxSend/pxSendDom
//                                                 straight through, no stash/chunk fallback.
//                                                 Verified by the sink's own signature (an empty
//                                                 POST provokes its distinctive 400 "empty body"
//                                                 reply); records ./sink-tunnel.json.
//
// If verification fails, do NOT kill + re-run in a retry loop: each run mints a NEW random
// hostname and re-races DNS propagation from zero. The verify probes fall back to pinned
// public DNS (1.1.1.1/8.8.8.8) when the system resolver can't see a fresh name — a run that
// still fails after that is genuinely broken (dead cloudflared, wrong port, blocked network).
//
// Needs `cloudflared` on PATH (brew install cloudflared). Quick tunnels need no account.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dns = require("dns");
const https = require("https");
const { spawn } = require("child_process");

const WORK = process.cwd();
const targetDir = (name) => path.join(WORK, "targets", name);
const tunnelPath = (name) => path.join(targetDir(name), "tunnel.json");
const indexPath = (name) => path.join(targetDir(name), "clone", "index.html");
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);

// The quick-tunnel url is printed to cloudflared's stderr. Pure + exported for the selftest.
function parseTunnelUrl(logText) {
  const m = logText.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return m ? m[0] : null;
}

// System resolvers can lag (or plain fail) on freshly-minted *.trycloudflare.com names
// while the tunnel is already serving — three concurrent live runs each burned ~6–11 min
// exhausting verify budgets on tunnels that answered in <0.5 s via `curl --resolve`, then
// killed the HEALTHY tunnel and re-minted a new hostname, re-racing the same broken
// resolution. The reviewer's browser uses its OWN resolver, so our resolver's lag says
// nothing about reachability: when the normal fetch fails at the network level, resolve
// through pinned public DNS and connect to the IP directly with SNI/Host set.
const PUBLIC_DNS = ["1.1.1.1", "8.8.8.8"];
function fetchViaPinnedDns(rawUrl, { method = "GET", body = null } = {}) {
  const u = new URL(rawUrl);
  if (u.protocol !== "https:") return Promise.reject(new Error("pinned-DNS fallback is https-only"));
  const resolver = new dns.promises.Resolver();
  resolver.setServers(PUBLIC_DNS);
  return resolver.resolve4(u.hostname).then(([ip]) => new Promise((resolve, reject) => {
    const req = https.request(
      { host: ip, servername: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers: { Host: u.hostname, "cache-control": "no-cache" }, timeout: 15_000 },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  }));
}

// One probe, two paths: normal fetch first; on a network-level failure (not an HTTP
// status) retry via pinned DNS. Throws only when BOTH fail — and then says whether the
// whole outbound network looks blocked (sandboxed shell) vs just this hostname.
async function fetchAny(url, opts = {}) {
  try {
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000), method: opts.method || "GET", body: opts.body, headers: { "cache-control": "no-cache" } });
    return { status: r.status, body: Buffer.from(await r.arrayBuffer()), via: "system" };
  } catch (e) {
    if (!/^https:/.test(url)) throw e;
    try {
      const p = await fetchViaPinnedDns(url, opts);
      return { ...p, via: `pinned DNS 1.1.1.1 (system resolver failed: ${e.message})` };
    } catch (e2) {
      throw new Error(`${e.message}; pinned-DNS fallback also failed: ${e2.message} — if ALL outbound requests fail, the shell may be sandboxed: rerun with network access (LAUNCH-PROMPT environment notes)`);
    }
  }
}

// Does `url` serve exactly the bytes of `filePath`? file:// urls read from disk, so the
// compare logic is testable offline (same pattern as capture-build's fetchTo).
// Returns { ok, reason, sha256 }.
async function verifyServes(url, filePath) {
  const expected = fs.readFileSync(filePath);
  let got, via = "system";
  try {
    if (url.startsWith("file://")) got = fs.readFileSync(new URL(url));
    else {
      const r = await fetchAny(url);
      if (r.status < 200 || r.status >= 300) return { ok: false, reason: `HTTP ${r.status} from ${url}` };
      got = r.body; via = r.via;
    }
  } catch (e) {
    return { ok: false, reason: `unreachable: ${url} — ${e.message}` };
  }
  if (!got.equals(expected)) return { ok: false, reason: `${url} responds but the bytes are NOT clone/index.html (${got.length} vs ${expected.length} bytes) — wrong port, stale serve, or another app` };
  return { ok: true, reason: `verified: ${url} serves clone/index.html byte-identically${via === "system" ? "" : ` (via ${via})`}`, sha256: sha(expected) };
}

// Quick-tunnel hostnames take a while to become reachable: cloudflared prints the url
// well before the *.trycloudflare.com DNS record propagates, and the lag is measured in
// tens of seconds, not the ~20s a 10x2s loop allows (found live: the sink-tunnel probe
// exhausted its retries on plain "fetch failed" DNS misses while the tunnel was fine).
// 30 attempts x 3s = 90s budget, with a progress line so a long warm-up isn't silent.
async function warmUp(probe) {
  let v = { ok: false, reason: "unverified" };
  for (let i = 0; i < 30 && !v.ok; i++) {
    v = await probe();
    if (!v.ok) {
      if (i > 0 && i % 5 === 0) console.error(`  … still warming up (attempt ${i}/30): ${v.reason.slice(0, 100)}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return v;
}

// The sink's signature: an empty POST always gets 400 + an "empty body" message
// (tools/sink.js classifyBody). Proving THAT response comes back through a url proves the
// real sink answers there — no filesystem coupling, works for local and tunneled checks.
const looksLikeSink = (status, bodyText) => status === 400 && /empty body/.test(bodyText || "");
async function probeSink(url) {
  try {
    const r = await fetchAny(url, { method: "POST", body: "" });
    const text = r.body.toString("utf8");
    if (looksLikeSink(r.status, text)) return { ok: true, reason: `sink answered at ${url}${r.via === "system" ? "" : ` (via ${r.via})`}` };
    return { ok: false, reason: `${url} answered (HTTP ${r.status}) but NOT like the sink — wrong port or another app: ${text.slice(0, 80)}` };
  } catch (e) {
    return { ok: false, reason: `unreachable: ${url} — ${e.message}` };
  }
}

async function sinkMain(port) {
  const local = await probeSink(`http://localhost:${port}/pxprobe.json`);
  if (!local.ok) { console.error(`❌ no sink on :${port} before tunneling: ${local.reason}\n   start it first: node tools/sink.js  (PPK_SINK_PORT=${port} if non-default)`); process.exit(1); }

  const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
  child.on("error", (e) => {
    console.error(e.code === "ENOENT" ? "cloudflared not found — install it: brew install cloudflared" : `cloudflared failed: ${e.message}`);
    process.exit(1);
  });
  let log = "", url = null;
  const onChunk = (d) => { if (!url) { log += d; url = parseTunnelUrl(log); } };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  const deadline = Date.now() + 30_000;
  while (!url && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 300));
  if (!url) { console.error(`❌ no tunnel url within 30s — cloudflared output:\n${log.slice(-800)}`); child.kill(); process.exit(1); }

  const v = await warmUp(() => probeSink(`${url}/pxprobe.json`));
  if (!v.ok) { console.error(`❌ tunnel came up but the sink never answered through it: ${v.reason}`); child.kill(); process.exit(1); }

  fs.writeFileSync(path.join(WORK, "sink-tunnel.json"), JSON.stringify({ url, port, startedAt: new Date().toISOString() }, null, 2) + "\n");
  console.log(`✓ sink tunnel ready: ${url}\n  ${v.reason}\n  recorded → ./sink-tunnel.json\n  live-page delivery (no stash/chunk fallback needed):\n    await pxSend('${url}/live.json')\n    await pxSendDom('${url}/dom.html')`);

  const stop = () => { child.kill(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => { console.error(`cloudflared exited (${code}) — sink tunnel is DOWN`); process.exit(code || 1); });
}

// Can `url` serve a real page? For a LIVE DEV SERVER (an adopted external build — ditto's
// next dev, vite, etc.) byte-identity against a file is meaningless: the check is
// reachability + a non-trivial HTML body. Weaker than the clone-dir byte check, and the
// record says so (verified:"reachable").
async function probeUrl(url) {
  try {
    const r = await fetchAny(url);
    if (r.status < 200 || r.status >= 300) return { ok: false, reason: `HTTP ${r.status} from ${url}` };
    if (r.body.length < 200) return { ok: false, reason: `${url} answered but the body is ${r.body.length} bytes — not a page (dev server still starting?)` };
    return { ok: true, reason: `reachable: ${url} serves a ${r.body.length}-byte page (byte-identity not checkable for a live dev server)${r.via === "system" ? "" : ` (via ${r.via})`}` };
  } catch (e) {
    return { ok: false, reason: `unreachable: ${url} — ${e.message}` };
  }
}

// Tunnel an arbitrary local server (adopted builds run on their OWN dev server, not the
// kit's static serve). Records targets/<name>/tunnel.json so `pingfusi review <name> file`
// picks the public url up as the default --draft, same as clone-dir tunnels.
async function urlMain(name, localUrl) {
  let parsed;
  try { parsed = new URL(localUrl); } catch (e) { console.error(`--url "${localUrl}" is not a valid url`); process.exit(2); }
  if (!fs.existsSync(targetDir(name))) { console.error(`targets/${name} missing — register the build first: pingfusi adopt ${name} <original-url>`); process.exit(1); }

  const local = await probeUrl(parsed.href);
  if (!local.ok) { console.error(`❌ local server check failed before tunneling: ${local.reason}\n   start your build's dev server first (e.g. npm run dev)`); process.exit(1); }

  const child = spawn("cloudflared", ["tunnel", "--url", parsed.origin, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
  child.on("error", (e) => {
    console.error(e.code === "ENOENT" ? "cloudflared not found — install it: brew install cloudflared" : `cloudflared failed: ${e.message}`);
    process.exit(1);
  });
  let log = "", url = null;
  const onChunk = (d) => { if (!url) { log += d; url = parseTunnelUrl(log); } };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  const deadline = Date.now() + 30_000;
  while (!url && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 300));
  if (!url) { console.error(`❌ no tunnel url within 30s — cloudflared output:\n${log.slice(-800)}`); child.kill(); process.exit(1); }

  const v = await warmUp(() => probeUrl(url));
  if (!v.ok) { console.error(`❌ tunnel came up but never served the page: ${v.reason}`); child.kill(); process.exit(1); }

  fs.writeFileSync(tunnelPath(name), JSON.stringify({ url, localUrl: parsed.href, startedAt: new Date().toISOString(), verified: "reachable" }, null, 2) + "\n");
  console.log(`✓ tunnel ready: ${url}\n  ${v.reason}\n  recorded → targets/${name}/tunnel.json (review-qa uses it as the default --draft)\n  next: node harness/review-qa.js file ${name}`);

  const stop = () => { child.kill(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => { console.error(`cloudflared exited (${code}) — tunnel is DOWN; restart before filing review rounds`); process.exit(code || 1); });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--sink")) {
    const p = args.filter((a) => !a.startsWith("--"))[0];
    return sinkMain(+(p || process.env.PPK_SINK_PORT || 7799));
  }
  const urlIdx = args.indexOf("--url");
  if (urlIdx >= 0) {
    const name = args.filter((a, i) => !a.startsWith("--") && i !== urlIdx + 1)[0];
    if (!name || !args[urlIdx + 1]) { console.error("usage: node harness/tunnel.js <name> --url <http://localhost:3000>"); process.exit(2); }
    return urlMain(name, args[urlIdx + 1]);
  }
  const [name, portArg] = args.filter((a) => !a.startsWith("--"));
  if (!name) { console.error("usage: node harness/tunnel.js <name> [port=8080] [--check]  |  <name> --url <local-dev-url>  |  --sink [port=7799]"); process.exit(2); }

  if (args.includes("--check")) {
    if (!fs.existsSync(tunnelPath(name))) { console.error(`no tunnel recorded — start one: node harness/tunnel.js ${name} [port]`); process.exit(1); }
    const t = JSON.parse(fs.readFileSync(tunnelPath(name), "utf8"));
    // clone-dir tunnels re-verify byte-identity; adopted-build tunnels (live dev servers)
    // re-verify reachability — the strongest check each mode supports.
    const v = fs.existsSync(indexPath(name)) ? await verifyServes(t.url, indexPath(name)) : await probeUrl(t.url);
    console.log(`${v.ok ? "✓" : "❌"} ${v.reason}`);
    process.exit(v.ok ? 0 : 1);
  }

  if (!fs.existsSync(indexPath(name))) { console.error(`targets/${name}/clone/index.html missing — build the clone first (or tunnel an external build's dev server: node harness/tunnel.js ${name} --url <http://localhost:3000>)`); process.exit(1); }

  const port = +(portArg || 8080);
  // Fail fast if the local serve isn't up — a tunnel to a dead port "works" at the DNS
  // level and still burns the review round.
  const local = await verifyServes(`http://localhost:${port}/`, indexPath(name));
  if (!local.ok) { console.error(`❌ local serve check failed before tunneling: ${local.reason}\n   start it: node harness/serve.js ${name} ${port}`); process.exit(1); }

  const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
  child.on("error", (e) => {
    console.error(e.code === "ENOENT" ? "cloudflared not found — install it: brew install cloudflared" : `cloudflared failed: ${e.message}`);
    process.exit(1);
  });

  let log = "", url = null;
  const onChunk = (d) => { if (!url) { log += d; url = parseTunnelUrl(log); } };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  const deadline = Date.now() + 30_000;
  while (!url && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 300));
  if (!url) { console.error(`❌ no tunnel url within 30s — cloudflared output:\n${log.slice(-800)}`); child.kill(); process.exit(1); }

  // DNS/edge warm-up: retry the public fetch before declaring the tunnel usable.
  const v = await warmUp(() => verifyServes(url, indexPath(name)));
  if (!v.ok) { console.error(`❌ tunnel came up but never served the clone: ${v.reason}`); child.kill(); process.exit(1); }

  fs.writeFileSync(tunnelPath(name), JSON.stringify({ url, port, startedAt: new Date().toISOString(), verifiedSha256: v.sha256 }, null, 2) + "\n");
  console.log(`✓ tunnel ready: ${url}\n  ${v.reason}\n  recorded → targets/${name}/tunnel.json (review-qa.js uses it as the default --draft)\n  next: node harness/review-qa.js file ${name}`);

  const stop = () => { child.kill(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => { console.error(`cloudflared exited (${code}) — tunnel is DOWN; restart before filing review rounds`); process.exit(code || 1); });
}

if (require.main === module) main();
module.exports = { parseTunnelUrl, verifyServes, looksLikeSink, probeSink };
