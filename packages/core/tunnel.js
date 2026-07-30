// packages/core/tunnel.js — a PUBLIC url for a LOCAL server, in preference order.
//
// WHY THIS EXISTS. Cloudflare's anonymous quick tunnels (`cloudflared tunnel --url …`,
// the random *.trycloudflare.com names) are rate-limited: they 429 under real use
// (measured 2026-07-08 while driving motion review rounds). A throttled url mid-round
// burns a paid review round exactly like a dead one does — the failure class hosted
// drafts were built to end. So a tunnel, when one is genuinely needed, comes from the
// most stable transport available:
//
//   1. a NAMED cloudflared tunnel the operator provisioned — stable hostname on a
//      domain they control, no mint limits (the tunnel already exists; we only run it),
//   2. ngrok, if installed and authenticated,
//   3. an anonymous quick tunnel — LAST resort, only when the caller opts in
//      (`allowQuick`), and it says out loud what it is instead of pretending.
//
// Transport only: this spawns a process and hands back a url. Whether that url actually
// serves the right bytes is the caller's gate (harness/tunnel.js byte-compares; the
// motion loop probes its player). It lives in core because both consumers need the same
// preference order — the 429 lesson must exist in exactly one place, which is the point
// of this file: motion learned it, the clone workflow didn't, and the two drifted.
//
// A tunnel is never the first answer for STATIC output — that is `core.draft.push`
// (`pingfusi publish`), which needs no local process at all. Tunnels are for builds that
// genuinely require a live server, and for the capture sink.
"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// cloudflared prints the quick-tunnel url into its log noise (stderr, usually).
// Pure + exported: the selftests read real captured cloudflared output.
function parseQuickTunnelUrl(logText) {
  const m = String(logText).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return m ? m[0] : null;
}

// A named tunnel is operator-provisioned, never minted here:
//   cloudflared tunnel create pingfusi
//   cloudflared tunnel route dns pingfusi review.example.com
//   echo '{"name":"pingfusi","hostname":"review.example.com"}' > ~/.cloudflared/pingfusi-tunnel.json
// motion-kit-tunnel.json is read too so operators who provisioned one for the motion
// loop before this module existed keep working without re-provisioning.
const NAMED_CONFIG_FILES = ["pingfusi-tunnel.json", "motion-kit-tunnel.json"];

function namedTunnelConfig({ env = process.env, home = os.homedir(), readFileSync = fs.readFileSync } = {}) {
  if (env.PINGFUSI_TUNNEL_NAME && env.PINGFUSI_TUNNEL_HOSTNAME) {
    return { name: env.PINGFUSI_TUNNEL_NAME, hostname: env.PINGFUSI_TUNNEL_HOSTNAME, from: "PINGFUSI_TUNNEL_NAME/HOSTNAME" };
  }
  for (const file of NAMED_CONFIG_FILES) {
    const full = path.join(home, ".cloudflared", file);
    let cfg;
    try {
      cfg = JSON.parse(readFileSync(full, "utf8"));
    } catch {
      continue; // absent or unreadable — try the next stash
    }
    if (cfg && typeof cfg.name === "string" && typeof cfg.hostname === "string" && cfg.name && cfg.hostname) {
      return { name: cfg.name, hostname: cfg.hostname, from: `~/.cloudflared/${file}` };
    }
  }
  return null;
}

// Both forms are accepted because the two consumers hold different halves: the clone
// workflow knows an origin (it may be an adopted dev server on any port), the motion
// loop knows the port it just bound. ngrok needs the port; cloudflared needs the origin.
// The port form resolves to 127.0.0.1, not "localhost": a caller that hands us a bare port
// bound its server itself, and a server listening only on 127.0.0.1 is unreachable via a
// "localhost" that resolves to ::1 first. Callers who mean localhost pass an origin.
function normalizeTarget({ origin, port }) {
  if (origin) {
    const u = new URL(origin);
    return { origin: u.origin, port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80 };
  }
  if (port) return { origin: `http://127.0.0.1:${port}`, port: Number(port) };
  throw new Error("startPublicTunnel needs { origin } or { port }");
}

// One shape for all three providers: `start(ctx)` wires up however that provider reports
// its url (parse stdout, or poll a local API) and returns a chunk handler; the first
// ctx.ok(url) wins. Spawn error, child exit, and the timeout all reject — and no provider
// ever leaves a stray child or a live interval behind.
function spawnProvider({ command, args, spawn, timeoutMs, timeoutMessage, notInstalled, exited, start }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(new Error(e && e.code === "ENOENT" ? notInstalled : `${command} failed: ${e.message}`));
    }
    let settled = false;
    const intervals = [];
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const i of intervals) clearInterval(i);
      fn(value);
    };
    const ok = (url) => done(resolve, { url, child });
    const fail = (err) => {
      done(reject, err);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => fail(new Error(timeoutMessage())), timeoutMs);
    const onChunk = start({
      ok,
      fail,
      every: (ms, fn) => intervals.push(setInterval(fn, ms)),
    });
    child.stdout?.on("data", (c) => onChunk(String(c)));
    child.stderr?.on("data", (c) => onChunk(String(c)));
    child.on("error", (e) => fail(new Error(e && e.code === "ENOENT" ? notInstalled : `${command} failed: ${e.message}`)));
    child.on("exit", (code) => fail(new Error(exited(code))));
  });
}

const CLOUDFLARED_MISSING = "cloudflared is not installed (brew install cloudflared)";

function startNamedTunnel({ origin, spawn, timeoutMs, config }) {
  if (!config) return Promise.reject(new Error("no named tunnel configured"));
  return spawnProvider({
    command: "cloudflared",
    args: ["tunnel", "run", "--url", origin, config.name],
    spawn,
    timeoutMs,
    timeoutMessage: () => `named tunnel "${config.name}" did not connect within ${Math.round(timeoutMs / 1000)}s`,
    notInstalled: CLOUDFLARED_MISSING,
    exited: (code) => `named tunnel "${config.name}" exited (${code}) — is it provisioned on this account? (cloudflared tunnel list)`,
    // The hostname is fixed by the operator's DNS route, so the only thing to wait for is
    // cloudflared reporting that the edge accepted the connection.
    start: (ctx) => (text) => {
      if (/Registered tunnel connection/.test(text)) ctx.ok(`https://${config.hostname}`);
    },
  }).then((r) => ({ ...r, kind: "named", detail: `named tunnel "${config.name}" → ${config.hostname} (${config.from})` }));
}

function startNgrok({ port, spawn, timeoutMs, fetchFn }) {
  let authError = null;
  return spawnProvider({
    command: "ngrok",
    args: ["http", String(port), "--log", "stdout", "--log-format", "json"],
    spawn,
    timeoutMs,
    timeoutMessage: () => authError || `ngrok did not come up within ${Math.round(timeoutMs / 1000)}s`,
    notInstalled: "ngrok is not installed",
    exited: (code) => authError || `ngrok exited (${code}) before providing a url`,
    // ngrok publishes the public url on its local API, not on stdout — stdout is only
    // useful for surfacing an auth failure before the timer runs out.
    start: (ctx) => {
      ctx.every(300, async () => {
        try {
          const res = await fetchFn("http://127.0.0.1:4040/api/tunnels");
          const tunnels = (await res.json()).tunnels || [];
          const t = tunnels.find((x) => x.proto === "https") || tunnels[0];
          if (t && t.public_url) ctx.ok(t.public_url);
        } catch {
          /* API not up yet */
        }
      });
      return (text) => {
        if (/ERR_NGROK|authtoken|authentication failed/i.test(text)) {
          authError = "ngrok is not authenticated (ngrok config add-authtoken <token>)";
          ctx.fail(new Error(authError));
        }
      };
    },
  }).then((r) => ({ ...r, kind: "ngrok", detail: "ngrok" }));
}

function startQuickTunnel({ origin, spawn, timeoutMs }) {
  let log = "";
  return spawnProvider({
    command: "cloudflared",
    args: ["tunnel", "--url", origin, "--no-autoupdate"],
    spawn,
    timeoutMs,
    timeoutMessage: () => `no quick-tunnel url within ${Math.round(timeoutMs / 1000)}s — cloudflared output:\n${log.slice(-800)}`,
    notInstalled: CLOUDFLARED_MISSING,
    exited: (code) => `cloudflared exited (${code}) before printing a url`,
    start: (ctx) => (text) => {
      log += text;
      const url = parseQuickTunnelUrl(log);
      if (url) ctx.ok(url);
    },
  }).then((r) => ({ ...r, kind: "quick", detail: "anonymous quick tunnel" }));
}

const QUICK_WARNING =
  "⚠ anonymous quick tunnel (*.trycloudflare.com) — Cloudflare rate-limits these; they 429 under real use,\n" +
  "  and a throttled url mid-round burns the round just like a dead one. Provision a named tunnel once:\n" +
  "    cloudflared tunnel create pingfusi && cloudflared tunnel route dns pingfusi <your-hostname>\n" +
  "    echo '{\"name\":\"pingfusi\",\"hostname\":\"<your-hostname>\"}' > ~/.cloudflared/pingfusi-tunnel.json\n" +
  "  (or authenticate ngrok: ngrok config add-authtoken <token>)";

/**
 * Open a public tunnel to a local server, best transport first.
 *
 * @param {object}   opts
 * @param {string}  [opts.origin]      local origin, e.g. "http://localhost:8080"
 * @param {number}  [opts.port]        alternative to origin
 * @param {boolean} [opts.allowQuick]  permit the anonymous quick-tunnel last resort
 * @param {number}  [opts.timeoutMs]   per-provider budget (default 25s)
 * @param {string}  [opts.hint]        appended to the all-providers-failed error
 * @param {Function}[opts.log]         warning sink (default console.error)
 * @returns {Promise<{url: string, kind: "named"|"ngrok"|"quick", detail: string,
 *                    stop: () => void, onExit: (cb: (code: number|null) => void) => void}>}
 */
async function startPublicTunnel(opts = {}) {
  const { allowQuick = false, timeoutMs = 25_000, hint = "", log = console.error, deps = {} } = opts;
  const spawn = deps.spawn || childProcess.spawn;
  const fetchFn = deps.fetch || ((...a) => fetch(...a));
  const { origin, port } = normalizeTarget(opts);
  const config = namedTunnelConfig(deps);

  const attempts = [
    { label: "named tunnel", run: () => startNamedTunnel({ origin, spawn, timeoutMs, config }) },
    { label: "ngrok", run: () => startNgrok({ port, spawn, timeoutMs, fetchFn }) },
  ];
  if (allowQuick) {
    attempts.push({ label: "quick tunnel", run: () => startQuickTunnel({ origin, spawn, timeoutMs }) });
  }

  const failures = [];
  for (const attempt of attempts) {
    let opened;
    try {
      opened = await attempt.run();
    } catch (err) {
      failures.push(`${attempt.label}: ${err.message}`);
      continue;
    }
    if (opened.kind === "quick") log(QUICK_WARNING);
    return {
      url: opened.url,
      kind: opened.kind,
      detail: opened.detail,
      stop: () => {
        try {
          opened.child.kill();
        } catch {
          /* already gone */
        }
      },
      onExit: (cb) => opened.child.on("exit", cb),
    };
  }
  throw new Error(`no public tunnel available (${failures.join("; ")})${hint ? ` — ${hint}` : ""}`);
}

module.exports = {
  startPublicTunnel,
  namedTunnelConfig,
  parseQuickTunnelUrl,
  NAMED_CONFIG_FILES,
  QUICK_WARNING,
};
