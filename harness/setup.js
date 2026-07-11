// harness/setup.js — `npx pingfusi setup` / `pingfusi setup`: the one-command onboarding.
//
// Everything a newcomer needs, in one interactive pass: global install (when run via
// npx; upgrades an old pixel-perfect-kit install), the
// review-service device login + MCP install (the vendored installer — skippable, LOCAL
// review mode needs no account), the optional ditto fast-builder check, and the agent
// skills. Interactive steps CANNOT live in npm postinstall (silenced, breaks CI), which
// is why this is an explicit command. Idempotent: every step probes before acting, so
// re-running it is always safe. `pingfusi doctor` remains the read-only re-check.
//
// USAGE:  npx pingfusi setup [client]      (first contact — nothing else installed;
//                                           client: claude-desktop|claude-code|cursor|codex)
//         pingfusi setup                        (re-run anytime; with [client] it adds
//                                                that client to an existing login)
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");

const PKG = path.resolve(__dirname, "..");

// io is injectable so the selftest can drive every prompt path offline:
//   probe(cmd,args) -> bool   run(cmd,args) -> void (stdio inherit)
//   ask(q) -> Promise<string> (lowercased answer; "" = Enter)   isTTY, log
function defaultIO() {
  return {
    isTTY: !!process.stdin.isTTY,
    log: (...a) => console.log(...a),
    run: (cmd, args) => spawnSync(cmd, args, { stdio: "inherit" }),
    probe: (cmd, args) => {
      try {
        const r = spawnSync(cmd, args, { stdio: "pipe", timeout: 10_000 });
        return !r.error && (r.status === 0 || !!((r.stdout && r.stdout.length) || (r.stderr && r.stderr.length)));
      } catch (e) { return false; }
    },
    // Resolve WHERE a command lives, not just whether something answers — found live in
    // the fresh-machine test: npx injects the ephemeral package's own bin into PATH, so a
    // bare probe says "pingfusi already installed" during the one run where the global install
    // matters most (the npx cache evicts and pingfusi vanishes).
    which: (cmd) => {
      try {
        const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "pipe", timeout: 10_000 });
        const p = String(r.stdout || "").trim();
        return r.status === 0 && p ? p : null;
      } catch (e) { return null; }
    },
    ask: (q) =>
      new Promise((res) => {
        if (!process.stdin.isTTY) return res("");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(q, (a) => { rl.close(); res(a.trim().toLowerCase()); });
      }),
  };
}

// An npx-provided bin is EPHEMERAL, not an install (lives in the npx cache).
const isPersistentInstall = (binPath) => !!binPath && !/[\\/]_npx[\\/]/.test(binPath);

// "yes" = explicit y, or Enter on a real terminal (the [Y/n] default). A non-TTY ""
// is NOT consent — unattended runs must never install or open logins on their own.
const saidYes = (answer, isTTY) => answer === "y" || answer === "yes" || (answer === "" && isTTY);

async function setup(io, opts) {
  const steps = [];
  io.log("pingfusi setup\n─────────────────────────");

  // 1. node — the only hard requirement for anything at all
  const major = parseInt(process.versions.node, 10);
  if (major < 18) {
    io.log(`❌ node ${process.versions.node} — the kit needs Node 18+ (https://nodejs.org). Fix that first, then re-run.`);
    return { ok: false, steps: ["node-fail"] };
  }
  io.log(`✓ node ${process.versions.node}`);

  // 2. pingfusi on PATH — when run via npx there is no PERSISTENT install yet (npx's
  // own ephemeral bin must not count, or the prompt never fires in the npx first-run)
  const binPath = io.which("pingfusi");
  if (opts.sourceCheckout) {
    io.log("✓ running from a source checkout — using this copy (skipping global install)");
    steps.push("global-skip-checkout");
  } else if (isPersistentInstall(binPath)) {
    io.log("✓ pingfusi already installed globally");
    steps.push("global-present");
  } else if (saidYes(await io.ask("pingfusi isn't installed globally yet — install now? (npm i -g pingfusi) [Y/n] "), io.isTTY)) {
    io.run("npm", ["i", "-g", "pingfusi"]);
    io.log("✓ installed pingfusi globally");
    steps.push("global-installed");
  } else {
    io.log("⚠ skipped — the commands below assume `pingfusi` is on PATH");
    steps.push("global-skipped");
  }

  // 3. cloudflared — OPTIONAL, deliberately NOT offered here: the default clone flow is
  // tunnel-free (captures deliver via pxSave/localhost sink; drafts are HOSTED). Only
  // `pingfusi tunnel <name> --url` — reviewing a live dev-server draft — needs it.
  if (io.probe("cloudflared", ["--version"])) {
    io.log("✓ cloudflared (optional — only needed to tunnel a live dev-server draft)");
    steps.push("cloudflared-present");
  } else {
    io.log("· cloudflared not installed — fine: the default clone flow is tunnel-free.\n  Reviewing a live dev-server draft (`pingfusi tunnel <name> --url`) needs it:\n  brew install cloudflared  (or developers.cloudflare.com/cloudflared)");
    steps.push("cloudflared-absent");
  }

  // 4. review-service login + MCP install — the vendored installer (device flow, patches
  // client configs, writes ~/.config/pingfusi/credentials.json). Skippable.
  // An EXPLICIT client arg always runs the installer, even when a login already
  // exists — the installer reuses the stored login and just patches that client's
  // config. Without this, `pingfusi setup codex` on a logged-in machine was a
  // silent no-op and there was no way to add a second client.
  let token = null;
  try { token = opts.resolveToken(); } catch (e) {}
  if (token && opts.mcpClient) {
    io.run(process.execPath, [path.join(PKG, "vendor", "pingfusi-review.mjs"), "setup", "--client", opts.mcpClient]);
    steps.push("login-client-added");
  } else if (token) {
    io.log("✓ review login found  (add another client anytime: pingfusi setup <client>)");
    steps.push("login-present");
  } else if (saidYes(await io.ask("review login + MCP install (remote review rounds, small credits) — log in now? [Y/n] "), io.isTTY)) {
    io.run(process.execPath, [path.join(PKG, "vendor", "pingfusi-review.mjs"), "setup"].concat(opts.mcpClient ? ["--client", opts.mcpClient] : []));
    steps.push("login-run");
  } else {
    io.log("⚠ skipped — review rounds will NOT work without a login (an independent reviewer\n  answers them; there is no offline path). Log in later: pingfusi setup");
    steps.push("login-skipped");
  }

  // 5. ditto — optional fast builder. NOT a binary probe: macOS ships /usr/bin/ditto
  // (Apple's file copier — a guaranteed false positive), and ditto.site is reached via
  // its MCP server or REST API (DITTO_API_KEY) anyway, per the fix-with-pingfusi skill.
  if (opts.dittoApiKey) {
    io.log("✓ DITTO_API_KEY found (ditto fast-builder path available)");
    steps.push("ditto-key-present");
  } else {
    io.log("ℹ ditto (optional fast builder): connect its MCP server in your agent or set DITTO_API_KEY — the full pingfusi pipeline works without it");
    steps.push("ditto-unconfigured");
  }

  // 6. teach the agent — install every skill the kit ships
  const r = require("./agent-setup.js").install(opts.home, false);
  io.log(r.ok ? `✓ taught your AI agent: ${r.installed.join(", ")}` : `✓ agent skills already installed (${r.message.split("\n")[0].replace(/^already installed \(|\).*$/g, "")})`);
  steps.push(r.ok ? "skills-installed" : "skills-present");

  io.log(`
─────────────────────────
Done. Open your AI agent and say:

   "Clone https://example.com pixel-perfect."
or, from inside any draft/clone project you already have:
   "Fix it with pingfusi."

You'll review the results: pin what looks wrong, pick a verdict button.
(re-check anytime: pingfusi doctor)`);
  return { ok: true, steps };
}

function main() {
  const { resolveToken } = require("./review-qa.js");
  // optional: which client the MCP installer should patch — accepts both the kit's
  // positional form (`setup cursor`) and the installer's flag form (`setup --client cursor`)
  const argv = process.argv.slice(2);
  const client = ((argv[0] === "--client" ? argv[1] : argv[0]) || "").toLowerCase();
  setup(defaultIO(), {
    home: os.homedir(),
    sourceCheckout: fs.existsSync(path.join(PKG, ".git")),
    resolveToken,
    dittoApiKey: !!process.env.DITTO_API_KEY,
    mcpClient: ["claude-desktop", "claude-code", "cursor", "codex"].includes(client) ? client : null,
  }).then((r) => process.exit(r.ok ? 0 : 1));
}

if (require.main === module) main();
module.exports = { setup, saidYes };
