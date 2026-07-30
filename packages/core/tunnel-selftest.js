// packages/core/tunnel-selftest.js — guards the tunnel TRANSPORT preference order.
//
// The lesson it locks in (2026-07-08, measured while driving motion rounds): anonymous
// quick tunnels are rate-limited and 429 under real use, so a review round must ride on
// the most stable transport available — named cloudflared tunnel, then ngrok, and only
// then (opt-in, loudly) a quick tunnel. The motion loop already knew this; the clone
// workflow's tunnel.js did not, and shipped quick-tunnel-only for 24 days. Both now run
// this one resolver, and this file is why they cannot drift apart again.
//
// Fully offline: cloudflared/ngrok are faked with EventEmitter children, so nothing here
// spawns a process, opens a socket, or reads the real ~/.cloudflared.
// Run: node packages/core/tunnel-selftest.js   (regression.js runs it too)
"use strict";

const { EventEmitter } = require("events");
const { startPublicTunnel, namedTunnelConfig, parseQuickTunnelUrl, QUICK_WARNING } = require("./tunnel.js");

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
};

// A fake child process: emits the scripted chunks on the next tick, then idles.
function fakeChild(chunks = [], { exitCode = null, spawnError = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.killed = true;
  };
  setImmediate(() => {
    if (spawnError) return child.emit("error", spawnError);
    for (const c of chunks) child.stderr.emit("data", c);
    if (exitCode !== null) child.emit("exit", exitCode);
  });
  return child;
}

// spawn stub: `script` maps a command to what that binary does on this machine.
function fakeSpawn(script) {
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args });
    const make = script[command];
    if (!make) {
      const err = new Error("spawn ENOENT");
      err.code = "ENOENT";
      throw err;
    }
    return make(args);
  };
  return { spawn, calls };
}

const QUICK_LOG = `2026-07-02T20:00:02Z INF |  Your quick Tunnel has been created! Visit it at:             |
2026-07-02T20:00:02Z INF |  https://engines-pad-firewire-investing.trycloudflare.com     |`;
const REGISTERED = "2026-07-08T10:00:03Z INF Registered tunnel connection connIndex=0";
const NAMED_CFG = { name: "pingfusi", hostname: "review.example.com" };
const readNamed = (file) => {
  if (file.endsWith("pingfusi-tunnel.json")) return JSON.stringify(NAMED_CFG);
  throw new Error("ENOENT");
};
const noNamed = () => {
  throw new Error("ENOENT");
};
const ngrokApi = (publicUrl) => async () => ({
  json: async () => ({ tunnels: [{ proto: "https", public_url: publicUrl }] }),
});
const noNgrokApi = async () => {
  throw new Error("connection refused");
};
const idle = () => fakeChild([]);
const silent = () => {};

(async () => {
  // ── 1. a configured named tunnel wins, and is RUN (never minted) ──────────────
  {
    const { spawn, calls } = fakeSpawn({ cloudflared: () => fakeChild([REGISTERED]) });
    const t = await startPublicTunnel({
      port: 8080,
      allowQuick: true,
      timeoutMs: 500,
      log: silent,
      deps: { spawn, fetch: noNgrokApi, readFileSync: readNamed, home: "/home/op", env: {} },
    });
    check("named tunnel is preferred over ngrok and quick", t.kind === "named", `got ${t.kind}`);
    check("named tunnel serves the operator's stable hostname", t.url === "https://review.example.com", t.url);
    check(
      "cloudflared RUNS the existing tunnel, never mints one",
      calls.length === 1 && calls[0].args.join(" ") === "tunnel run --url http://127.0.0.1:8080 pingfusi",
      JSON.stringify(calls[0] && calls[0].args)
    );
  }

  // ── 2. no named config → ngrok, before any quick tunnel ───────────────────────
  {
    const { spawn, calls } = fakeSpawn({ cloudflared: () => fakeChild([QUICK_LOG]), ngrok: idle });
    const t = await startPublicTunnel({
      origin: "http://localhost:3000",
      allowQuick: true,
      timeoutMs: 800,
      log: silent,
      deps: { spawn, fetch: ngrokApi("https://steady-otter.ngrok.app"), readFileSync: noNamed, home: "/home/op", env: {} },
    });
    check("with no named tunnel configured, ngrok comes next", t.kind === "ngrok", `got ${t.kind}`);
    check("ngrok's public url is used verbatim", t.url === "https://steady-otter.ngrok.app", t.url);
    check("ngrok is asked for the ORIGIN's port", calls.some((c) => c.command === "ngrok" && c.args[1] === "3000"), JSON.stringify(calls));
    check("no quick tunnel was spawned while a better transport existed", !calls.some((c) => c.command === "cloudflared"), JSON.stringify(calls));
  }

  // ── 3. nothing else available + allowQuick → quick tunnel, announced ──────────
  {
    const { spawn } = fakeSpawn({ cloudflared: () => fakeChild([QUICK_LOG]) });
    const warnings = [];
    const t = await startPublicTunnel({
      port: 8080,
      allowQuick: true,
      timeoutMs: 800,
      log: (m) => warnings.push(m),
      deps: { spawn, fetch: noNgrokApi, readFileSync: noNamed, home: "/home/op", env: {} },
    });
    check("quick tunnel is the last resort, not the first choice", t.kind === "quick", `got ${t.kind}`);
    check("quick-tunnel url is parsed out of cloudflared's log noise", t.url === "https://engines-pad-firewire-investing.trycloudflare.com", t.url);
    check("falling back to a quick tunnel WARNS about the 429 risk", warnings.length === 1 && /rate-limits these/.test(warnings[0]), JSON.stringify(warnings));
    check("the warning teaches the one-time named-tunnel fix", /cloudflared tunnel create/.test(QUICK_WARNING));
  }

  // ── 4. allowQuick:false refuses rather than riding a throttled hostname ───────
  {
    const { spawn, calls } = fakeSpawn({ cloudflared: () => fakeChild([QUICK_LOG]) });
    let err = null;
    try {
      await startPublicTunnel({
        port: 8080,
        timeoutMs: 400,
        log: silent,
        hint: "publish the bundle as a hosted draft instead",
        deps: { spawn, fetch: noNgrokApi, readFileSync: noNamed, home: "/home/op", env: {} },
      });
    } catch (e) {
      err = e;
    }
    check("without allowQuick, no anonymous tunnel is minted at all", !calls.some((c) => c.command === "cloudflared"), JSON.stringify(calls));
    check("the refusal names every transport it tried", err && /named tunnel: .+; ngrok: /.test(err.message), err && err.message);
    check("the refusal carries the caller's way out", err && /hosted draft/.test(err.message), err && err.message);
  }

  // ── 5. a dead provider falls through instead of failing the whole call ────────
  {
    const { spawn } = fakeSpawn({
      cloudflared: (args) => (args[1] === "run" ? fakeChild([], { exitCode: 1 }) : fakeChild([QUICK_LOG])),
    });
    const t = await startPublicTunnel({
      port: 8080,
      allowQuick: true,
      timeoutMs: 800,
      log: silent,
      deps: { spawn, fetch: noNgrokApi, readFileSync: readNamed, home: "/home/op", env: {} },
    });
    check("a named tunnel that dies on start falls through to the next transport", t.kind === "quick", `got ${t.kind}`);
  }

  // ── 6. config discovery ──────────────────────────────────────────────────────
  {
    const fromEnv = namedTunnelConfig({
      env: { PINGFUSI_TUNNEL_NAME: "envtun", PINGFUSI_TUNNEL_HOSTNAME: "env.example.com" },
      home: "/home/op",
      readFileSync: readNamed,
    });
    check("env vars override the config file", fromEnv && fromEnv.name === "envtun" && fromEnv.hostname === "env.example.com");
    const legacy = namedTunnelConfig({
      env: {},
      home: "/home/op",
      readFileSync: (file) => {
        if (file.endsWith("motion-kit-tunnel.json")) return JSON.stringify({ name: "motion-kit", hostname: "motionkit.pinghumans.com" });
        throw new Error("ENOENT");
      },
    });
    check("motion's existing ~/.cloudflared/motion-kit-tunnel.json still counts", legacy && legacy.name === "motion-kit", JSON.stringify(legacy));
    const half = namedTunnelConfig({
      env: {},
      home: "/home/op",
      readFileSync: () => JSON.stringify({ name: "no-hostname" }),
    });
    check("a config missing its hostname is not a named tunnel", half === null, JSON.stringify(half));
    check("no config anywhere → null (callers fall through)", namedTunnelConfig({ env: {}, home: "/home/op", readFileSync: noNamed }) === null);
  }

  // ── 7. the url parser (shared with harness/tunnel.js) ────────────────────────
  check("parses the quick-tunnel url out of log noise", parseQuickTunnelUrl(QUICK_LOG) === "https://engines-pad-firewire-investing.trycloudflare.com");
  check("no url in the log → null (keep waiting, no garbage match)", parseQuickTunnelUrl("INF Starting tunnel connection...") === null);

  console.log(failed === 0 ? "\nALL PASS — tunnel transport order guarded" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
