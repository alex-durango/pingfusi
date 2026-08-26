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
const { spawnNpmSync, whichSync } = require("./proc.js");
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
    // npm is a batch file on Windows (npm.cmd) — spawnable only through the shell;
    // proc.js owns that split (and the arg quoting that comes with shell:true).
    run: (cmd, args) => (cmd === "npm"
      ? spawnNpmSync(args, { stdio: "inherit" })
      : spawnSync(cmd, args, { stdio: "inherit" })),
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
    which: (cmd) => whichSync(cmd),
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
  // ── external-wrapper API (opts.wrapper) ──────────────────────────────────
  // Another dev-facing brand riding this kit (a thin npm wrapper package) can
  // drive this whole setup. Absent → stock pingfusi behavior, byte-identical.
  // All fields optional:
  //   brand                    the wrapper's npm-package/command name; used by the
  //                            global-install step and command prose (default "pingfusi")
  //   appUrl                   → vendored installer --app-url (service origin)
  //   mcpPath                  → --mcp-path (MCP mount, e.g. "/api/mcp/<brand>")
  //   serverKey                → --server-key (MCP config entry name)
  //   skipInstructionSurfaces  → --skip-instruction-surfaces (the installer's own
  //                            rule/skill surfaces stay untouched; a wrapper brand
  //                            passes it whenever serverKey isn't "pingfusi")
  //   skillRoot                agent-setup installs <skillRoot>/*/SKILL.md instead
  //                            of the kit's own skill/
  //   ruleAsset                { fileBaseName, body } — agent-setup writes the
  //                            wrapper's always-loaded rule (~/.claude/rules/<base>.md;
  //                            ~/.cursor/rules/<base>.mdc with alwaysApply frontmatter)
  // A wrapper brand (brand !== "pingfusi") also skips the kit-only steps —
  // cloudflared, the motion browser runtime, the ditto probe (kitOnlySteps below).
  const wrapper = opts.wrapper || {};
  const BRAND = wrapper.brand || "pingfusi";
  const installerFlags = [
    ...(wrapper.appUrl ? ["--app-url", wrapper.appUrl] : []),
    ...(wrapper.mcpPath ? ["--mcp-path", wrapper.mcpPath] : []),
    ...(wrapper.serverKey ? ["--server-key", wrapper.serverKey] : []),
    ...(wrapper.skipInstructionSurfaces ? ["--skip-instruction-surfaces"] : []),
  ];
  const steps = [];
  let requiredFailure = false;
  let persistentInstall = false;
  io.log(`${BRAND} setup\n─────────────────────────`);

  // 1. node — the only hard requirement for anything at all
  if (!supportsNode(process.versions.node)) {
    io.log(`❌ node ${process.versions.node} — the kit needs ${DISPLAY_RANGE} (https://nodejs.org). Fix that first, then re-run.`);
    return { ok: false, steps: ["node-fail"] };
  }
  io.log(`✓ node ${process.versions.node}`);

  // 2. pingfusi on PATH — when run via npx there is no PERSISTENT install yet (npx's
  // own ephemeral bin must not count, or the prompt never fires in the npx first-run)
  const binPath = io.which(BRAND);
  if (opts.sourceCheckout) {
    io.log("✓ running from a source checkout — using this copy (skipping global install)");
    steps.push("global-skip-checkout");
  } else if (isPersistentInstall(binPath)) {
    io.log(`✓ ${BRAND} already installed globally`);
    steps.push("global-present");
    persistentInstall = true;
  } else if (saidYes(await io.ask(`${BRAND} isn't installed globally yet — install now? (npm i -g ${BRAND}) [Y/n] `), io.isTTY)) {
    const installed = io.run("npm", ["i", "-g", BRAND]);
    if (!installed || installed.error || installed.signal || installed.status !== 0) {
      io.log(`❌ global ${BRAND} install failed — retry: npm i -g ${BRAND}@latest`);
      steps.push("global-failed");
      requiredFailure = true;
    } else {
      io.log(`✓ installed ${BRAND} globally`);
      steps.push("global-installed");
      persistentInstall = true;
    }
  } else {
    io.log(`⚠ skipped — the commands below assume \`${BRAND}\` is on PATH`);
    steps.push("global-skipped");
  }

  // 3, 4 and 6 are pingfusi-pipeline concerns (cloudflared for live-draft
  // tunnels, the motion capture runtime, the ditto fast builder) — a wrapper
  // brand's flow never reaches them, so its setup neither probes nor prompts.
  const kitOnlySteps = BRAND === "pingfusi";
  if (!kitOnlySteps) steps.push("kit-steps-skipped");

  // 3. cloudflared — OPTIONAL, deliberately NOT offered here: the default clone flow is
  // tunnel-free (captures deliver via pxSave/localhost sink; drafts are HOSTED). Only
  // `pingfusi tunnel <name> --url` — reviewing a live dev-server draft — needs it.
  if (kitOnlySteps) {
    if (io.probe("cloudflared", ["--version"])) {
      io.log("✓ cloudflared (optional — only needed to tunnel a live dev-server draft)");
      steps.push("cloudflared-present");
    } else {
      io.log("· cloudflared not installed — fine: the default clone flow is tunnel-free.\n  Reviewing a live dev-server draft (`pingfusi tunnel <name> --url`) needs it:\n  brew install cloudflared  (or developers.cloudflare.com/cloudflared)");
      steps.push("cloudflared-absent");
    }
  }

  // 4. motion browser runtime — Playwright's JS dependency is installed with the
  // package, but its Chromium + recording FFmpeg binaries are a separate download.
  // Install them during the same first-contact flow so a difficult animation does not
  // fail only after the agent has already chosen the correct specialist utility.
  if (kitOnlySteps) {
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
  }

  // 5. review-service login + MCP install — the vendored installer (device flow, patches
  // client configs, writes ~/.config/pingfusi/credentials.json). Skippable.
  // An EXPLICIT client arg always runs the installer, even when a login already
  // exists — the installer reuses the stored login and just patches that client's
  // config. Without this, `pingfusi setup codex` on a logged-in machine was a
  // silent no-op and there was no way to add a second client.
  // Every branch here except "skipped" reaches the installer for the same reason: it is
  // the only thing that refreshes the agent rules/skill it wrote (a fresh login and an
  // explicit client go through `setup`, an existing login through `rules`).
  let token = null;
  try { token = opts.resolveToken(); } catch (e) {}
  // Wrapper brands fail loudly when the installer cannot write their MCP entry.
  // Stock setup keeps its lenient contract (step 5 is skippable and a failed run
  // never blocked the rest), but for a wrapper the MCP entry IS the product —
  // continuing past a failed installer printed a success epilogue and exited 0
  // over a machine with no working config (found by the qaping verifier).
  const installerFailed = (r) =>
    !kitOnlySteps && !!(r && (r.error || (typeof r.status === "number" && r.status !== 0)));
  const installerFailure = () => {
    io.log(`✗ ${BRAND} MCP install failed — the ${BRAND} MCP entry was not written. Re-run: npx ${BRAND} setup`);
    steps.push("login-install-failed");
    return { ok: false, steps };
  };
  if (token && opts.mcpClient) {
    const r = io.run(process.execPath, [path.join(PKG, "vendor", "pingfusi-review.mjs"), "setup", "--client", opts.mcpClient, ...installerFlags]);
    if (installerFailed(r)) return installerFailure();
    steps.push("login-client-added");
  } else if (token) {
    io.log(kitOnlySteps
      ? `✓ review login found  (add another client anytime: ${BRAND} setup <client>)`
      : `✓ login found  (add another client anytime: ${BRAND} setup <client>)`);
    steps.push("login-present");
    if (kitOnlySteps) {
      // …but a login is not the only thing the installer owns: the agent RULES file ships
      // inside it and changes with the package. This branch used to run nothing at all, so
      // a logged-in machine kept the rule text of whatever version first installed it —
      // found live, months of `pingfusi setup` re-runs on guidance naming dead tools. The
      // installer's `rules` command rewrites ONLY an already-installed rule/skill (its own
      // file, or its managed block), so on a machine it never touched this is a no-op.
      io.run(process.execPath, [path.join(PKG, "vendor", "pingfusi-review.mjs"), "rules", ...installerFlags]);
      steps.push("rules-refreshed");
    } else {
      // A wrapper brand cannot stop at `rules`: under --skip-instruction-surfaces
      // that command touches no MCP config, so an existing (shared) pingfusi login
      // used to make a bare wrapper setup a silent no-op — the wrapper's own MCP
      // entry never landed. The vendored `setup` reuses the stored credentials
      // (whoami check, no re-auth) and writes the wrapper's server-key entry;
      // its instruction surfaces stay skipped by the same flags.
      const r = io.run(process.execPath, [path.join(PKG, "vendor", "pingfusi-review.mjs"), "setup", ...installerFlags]);
      if (installerFailed(r)) return installerFailure();
      steps.push("login-mcp-configured");
    }
  } else if (saidYes(await io.ask(kitOnlySteps
      ? "review login + MCP install (remote review rounds, small credits) — log in now? [Y/n] "
      : `${BRAND} login + MCP install (remote rounds, small credits) — log in now? [Y/n] `), io.isTTY)) {
    const r = io.run(process.execPath, [path.join(PKG, "vendor", "pingfusi-review.mjs"), "setup"].concat(opts.mcpClient ? ["--client", opts.mcpClient] : []).concat(installerFlags));
    if (installerFailed(r)) return installerFailure();
    steps.push("login-run");
  } else {
    io.log(kitOnlySteps
      ? `⚠ skipped — review rounds will NOT work without a login (an independent reviewer\n  answers them; there is no offline path). Log in later: ${BRAND} setup`
      : `⚠ skipped — ${BRAND} rounds will NOT work without a login (real people answer\n  them; there is no offline path). Log in later: ${BRAND} setup`);
    steps.push("login-skipped");
  }

  // 6. ditto — optional fast builder. NOT a binary probe: macOS ships /usr/bin/ditto
  // (Apple's file copier — a guaranteed false positive), and ditto.site is reached via
  // its MCP server or REST API (DITTO_API_KEY) anyway, per the fix-with-pingfusi skill.
  if (kitOnlySteps) {
    if (opts.dittoApiKey) {
      io.log("✓ DITTO_API_KEY found (ditto fast-builder path available)");
      steps.push("ditto-key-present");
    } else {
      io.log("ℹ ditto (optional fast builder): connect its MCP server in your agent or set DITTO_API_KEY — the full pingfusi pipeline works without it");
      steps.push("ditto-unconfigured");
    }
  }

  // 7. teach the coding agent — install every kit skill into the explicitly selected
  // client, or auto-detect existing agent homes when the interactive installer selected
  // one internally. PRESERVE by default: an existing skill file that differs from the
  // kit's copy may be a user edit, and a plain re-run must never clobber it — only
  // `setup --force` refreshes byte-different files (byte-current ones stay untouched).
  const r = require("./agent-setup.js").install(opts.home, !!opts.force, opts.mcpClient, {
    skipCurrent: true,
    skillRoot: wrapper.skillRoot,
    ruleAsset: wrapper.ruleAsset,
  });
  io.log(r.ok
    ? `✓ taught your AI agent (${r.clients.join(", ")}): ${r.installed.join(", ")}`
    : `✓ agent skills current (${r.clients.length ? r.clients.join(", ") : r.message})`);
  steps.push(r.ok ? "skills-installed" : "skills-present");

  if (requiredFailure) {
    io.log(`
─────────────────────────
Setup incomplete. Fix the failed required step above, then re-run: ${BRAND} setup`);
    return { ok: false, steps };
  }

  // The handoff prompts below teach the pingfusi review/clone flows; a wrapper
  // brand prints its own handoff after this returns.
  if (BRAND !== "pingfusi") {
    io.log(`
─────────────────────────
Done. Your AI agent loads the installed ${BRAND} guidance on its next session.`);
    return { ok: true, steps };
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
