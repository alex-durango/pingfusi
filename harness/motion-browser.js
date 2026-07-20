// motion-browser.js — one package-relative installer for the browser runtime used by
// motion capture, tracing, replay gates, and video-backed review bundles.
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_PACKAGE_DIR = path.join(__dirname, "..", "packages", "motion");

function installerInvocation(packageDir = DEFAULT_PACKAGE_DIR) {
  const cli = path.join(packageDir, "node_modules", "playwright", "cli.js");
  if (!fs.existsSync(cli)) {
    throw new Error(`Playwright CLI missing at ${cli}; run \`pingfusi motion install\` first`);
  }
  return { command: process.execPath, args: [cli, "install", "chromium"] };
}

function installMotionBrowser(packageDir = DEFAULT_PACKAGE_DIR, run = spawnSync) {
  const invocation = installerInvocation(packageDir);
  return run(invocation.command, invocation.args, {
    cwd: packageDir,
    stdio: "inherit",
    env: { ...process.env, npm_config_global: "false", NPM_CONFIG_GLOBAL: "false" },
  });
}

function installAndProbeMotionBrowser(packageDir = DEFAULT_PACKAGE_DIR, options = {}) {
  const run = options.run || spawnSync;
  const probe = options.probe;
  let installed;
  try {
    installed = installMotionBrowser(packageDir, run);
  } catch (error) {
    return { ok: false, stage: "install", reason: error.message, result: null };
  }
  if (!installed || installed.error || installed.signal || installed.status !== 0) {
    const reason = installed && installed.error ? installed.error.message
      : installed && installed.signal ? `terminated by ${installed.signal}`
      : `installer exited ${installed && installed.status != null ? installed.status : "without a status"}`;
    return { ok: false, stage: "install", reason, result: installed || null };
  }
  if (typeof probe !== "function") return { ok: true, stage: "installed", result: installed };
  let ready;
  try { ready = probe(packageDir); }
  catch (error) { ready = { ok: false, reason: error.message }; }
  if (!ready || !ready.ok) {
    return { ok: false, stage: "probe", reason: (ready && ready.reason) || "post-install recording probe failed", result: installed };
  }
  return { ok: true, stage: "ready", result: installed, probe: ready };
}

function globalMotionPackageDir(run = spawnSync) {
  try {
    const result = run("npm", ["root", "-g"], { encoding: "utf8", stdio: "pipe", timeout: 10_000 });
    if (!result || result.error || result.status !== 0) return null;
    const root = String(result.stdout || "").trim();
    if (!root) return null;
    const dir = path.join(root, "pingfusi", "packages", "motion");
    return fs.existsSync(dir) ? dir : null;
  } catch (_) {
    return null;
  }
}

module.exports = { DEFAULT_PACKAGE_DIR, installerInvocation, installMotionBrowser, installAndProbeMotionBrowser, globalMotionPackageDir };
