// harness/setup.js — `npx pingfusi setup` / `pingfusi setup`: the one-command onboarding.
//
// Everything a newcomer needs, in one interactive pass: global install (when run via
// npx; upgrades an old pixel-perfect-kit install), the motion browser runtime, the
// review-service device login + MCP install (the vendored installer — skippable here,
// but review rounds require the login: an independent reviewer answers them, there is
// no offline review path), the optional ditto fast-builder check, and the agent
// skills. Interactive steps CANNOT live in npm postinstall (silenced, breaks CI), which
// is why this is an explicit command. Idempotent: every step probes before acting, so
// re-running it is always safe. `pingfusi doctor` remains the read-only re-check.
//
// USAGE:  npx pingfusi setup [client]      (first contact — nothing else installed;
//                                           client: claude-desktop|claude-code|cursor|codex)
//         pingfusi setup [--force]              (re-run anytime; with [client] it adds
//                                                that client to an existing login; --force
//                                                refreshes locally-edited agent skills)
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");
const { DEFAULT_PACKAGE_DIR, globalMotionPackageDir, installAndProbeMotionBrowser } = require("./motion-browser.js");
const { DISPLAY_RANGE, supportsNode } = require("./node-runtime.js");

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
  let requiredFailure = false;
  let persistentInstall = false;
  io.log("pingfusi setup\n─────────────────────────");

  // 1. node — the only hard requirement for anything at all
  if (!supportsNode(process.versions.node)) {
    io.log(`❌ node ${process.versions.node} — the kit needs ${DISPLAY_RANGE} (https://nodejs.org). Fix that first, then re-run.`);
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
    persistentInstall = true;
  } else if (saidYes(await io.ask("pingfusi isn't installed globally yet — install now? (npm i -g pingfusi) [Y/n] "), io.isTTY)) {
    const installed = io.run("npm", ["i", "-g", "pingfusi"]);
    if (!installed || installed.error || installed.signal || installed.status !== 0) {
      io.log("❌ global pingfusi install failed — retry: npm i -g pingfusi@latest");
      steps.push("global-failed");
      requiredFailure = true;
    } else {
      io.log("✓ installed pingfusi globally");
      steps.push("global-installed");
      persistentInstall = true;
    }
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

  // 4. motion browser runtime — Playwright's JS dependency is installed with the
  // package, but its Chromium + recording FFmpeg binaries are a separate download.
  // Install them during the same first-contact flow so a difficult animation does not
  // fail only after the agent has already chosen the correct specialist utility.
  const resolveGlobal = opts.resolveGlobalMotionPackageDir || globalMotionPackageDir;
  const motionPackageDir = !opts.sourceCheckout && persistentInstall
    ? (resolveGlobal() || DEFAULT_PACKAGE_DIR)
    : DEFAULT_PACKAGE_DIR;
  let motionBrowser = { ok: false, reason: "probe unavailable" };
  const browserProbe = opts.probeMotionBrowser || require("./doctor.js").probeMotionBrowser;
  try {
    motionBrowser = browserProbe(motionPackageDir);
  } catch (e) {
    motionBrowser = { ok: false, reason: e.message };
  }
  if (motionBrowser && motionBrowser.ok) {
    io.log("✓ motion browser runtime (Chromium + recording FFmpeg)");
    steps.push("motion-browser-present");
  } else if (saidYes(await io.ask("motion capture runtime is missing — install Playwright Chromium now? [Y/n] "), io.isTTY)) {
    // The engine's npm dependencies install lazily (no postinstall — non-motion users
    // never pay the download), so a fresh machine may lack the Playwright CLI that
    // fetches Chromium. Install them first, under the same consent.
    let depsOk = true;
    if (!fs.existsSync(path.join(motionPackageDir, "node_modules", "playwright", "cli.js"))) {
      const deps = io.run("npm", ["ci", "--prefix", motionPackageDir, "--ignore-scripts", "--global=false"]);
      depsOk = !!deps && !deps.error && !deps.signal && deps.status === 0;
    }
    const installed = depsOk
      ? installAndProbeMotionBrowser(motionPackageDir, { run: io.run, probe: browserProbe })
      : { ok: false, stage: "install", reason: "the engine's npm dependency install failed (retry: pingfusi motion install)" };
    if (!installed.ok) {
      const detail = installed.stage === "probe" ? ` Chromium downloaded, but motion recording is not usable: ${installed.reason}.` : ` ${installed.reason}.`;
      io.log(`❌ motion browser install failed.${detail} Retry: pingfusi motion install-browser`);
      steps.push("motion-browser-failed");
      requiredFailure = true;
    } else {
      io.log("✓ installed motion browser runtime");
      steps.push("motion-browser-installed");
    }
  } else {
    io.log("⚠ skipped — motion capture/trace/replay will not work. Install later: pingfusi motion install-browser");
    steps.push("motion-browser-skipped");
  }

  // 5. review-service login + MCP install — the vendored installer (device flow, patches
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

  // 6. ditto — optional fast builder. NOT a binary probe: macOS ships /usr/bin/ditto
  // (Apple's file copier — a guaranteed false positive), and ditto.site is reached via
  // its MCP server or REST API (DITTO_API_KEY) anyway, per the fix-with-pingfusi skill.
  if (opts.dittoApiKey) {
    io.log("✓ DITTO_API_KEY found (ditto fast-builder path available)");
    steps.push("ditto-key-present");
  } else {
    io.log("ℹ ditto (optional fast builder): connect its MCP server in your agent or set DITTO_API_KEY — the full pingfusi pipeline works without it");
    steps.push("ditto-unconfigured");
  }

  // 7. teach the coding agent — install every kit skill into the explicitly selected
  // client, or auto-detect existing agent homes when the interactive installer selected
  // one internally. PRESERVE by default: an existing skill file that differs from the
  // kit's copy may be a user edit, and a plain re-run must never clobber it — only
  // `setup --force` refreshes byte-different files (byte-current ones stay untouched).
  const r = require("./agent-setup.js").install(opts.home, !!opts.force, opts.mcpClient, { skipCurrent: true });
  io.log(r.ok
    ? `✓ taught your AI agent (${r.clients.join(", ")}): ${r.installed.join(", ")}`
    : `✓ agent skills current (${r.clients.length ? r.clients.join(", ") : r.message})`);
  steps.push(r.ok ? "skills-installed" : "skills-present");

  if (requiredFailure) {
    io.log(`
─────────────────────────
Setup incomplete. Fix the failed required step above, then re-run: pingfusi setup`);
    return { ok: false, steps };
  }

  io.log(`
─────────────────────────
Done. Open your AI agent and say:

   "Which headline is clearer? Ask a human."
or, when you want a structured verdict on any build or artifact:
   "Review this build with pingfusi."
or, for a pixel-perfect website clone:
   "Clone https://example.com pixel-perfect."
or, from inside any draft/clone project you already have:
   "Fix it with pingfusi."
or, when the page works but still looks machine-made:
   "Beautify this page. Use pingfusi."
or, when you rendered a video no test can judge:
   "Review this video with pingfusi."

Review rounds are answered by an independent reviewer; your agent files them
and iterates on the verdicts. (re-check anytime: pingfusi doctor)`);
  return { ok: true, steps };
}

function main() {
  const { resolveToken } = require("./review-qa.js");
  // optional: which client the MCP installer should patch — accepts both the kit's
  // positional form (`setup cursor`) and the installer's flag form (`setup --client cursor`)
  const argv = process.argv.slice(2);
  const args = argv.filter((a) => a !== "--force");
  const client = ((args[0] === "--client" ? args[1] : args[0]) || "").toLowerCase();
  setup(defaultIO(), {
    home: os.homedir(),
    sourceCheckout: fs.existsSync(path.join(PKG, ".git")),
    resolveToken,
    force: argv.includes("--force"),
    dittoApiKey: !!process.env.DITTO_API_KEY,
    mcpClient: ["claude-desktop", "claude-code", "cursor", "codex"].includes(client) ? client : null,
  }).then((r) => process.exit(r.ok ? 0 : 1));
}

if (require.main === module) main();
module.exports = { setup, saidYes };
