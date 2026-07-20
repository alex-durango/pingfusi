// harness/doctor.js — `pingfusi doctor`: the one-command preflight for new installs.
//
// WHY: the kit's failure surface for a NEWCOMER is spread across four tools that fail at
// the worst possible moments — wrong node errors on the first fetch, missing cloudflared
// only at tunnel time (an hour into a run), a missing review login only at the review
// phase (hours in). Each failure is self-describing WHEN HIT; doctor moves all of them to
// minute one, with the fix command per miss. Run it right after install, and have agents
// run it before starting a clone (LAUNCH-PROMPT / the clone-site skill both say to).
//
// USAGE:  pingfusi doctor      (exit 0 = ready for the full pipeline, 1 = something missing)
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { DISPLAY_RANGE, supportsNode } = require("./node-runtime.js");

// Each check: { name, ok, detail, fix?, required } — pure data so the selftest can drive
// the report logic without real binaries. Exported builders take injectable probes.
function checkNode(versionString) {
  return {
    name: DISPLAY_RANGE.toLowerCase(),
    ok: supportsNode(versionString),
    detail: `found ${versionString}`,
    fix: `install ${DISPLAY_RANGE} (https://nodejs.org)`,
    required: true,
  };
}

function probeMotionBrowser(packageDir, run = spawnSync) {
  // Merely finding Chrome is a false positive for motion capture: Playwright records
  // video through its own cached FFmpeg binary, which is not supplied by a system Chrome
  // install. Exercise the same launchSession({ videoDir }) path as capture/trace/loop and
  // require it to close a real webm before declaring the integrated engine ready.
  const sessionUrl = pathToFileURL(path.join(packageDir, "src", "capture", "session.js")).href;
  const script = `
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchSession } from ${JSON.stringify(sessionUrl)};

const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-motion-doctor-"));
let browser;
let context;
try {
  const session = await launchSession({ headless: true, videoDir });
  browser = session.browser;
  context = session.context;
  await session.page.setContent("<!doctype html><style>body{background:#fff}i{display:block;width:8px;height:8px;background:#000}</style><i></i>");
  await session.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await context.close();
  context = null;
  await browser.close();
  browser = null;
  if (!fs.readdirSync(videoDir).some((name) => name.endsWith(".webm"))) {
    throw new Error("recordVideo completed without producing a webm file");
  }
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  fs.rmSync(videoDir, { recursive: true, force: true });
}`;

  try {
    const result = run(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: packageDir,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 20_000,
    });
    if (result && result.status === 0) return { ok: true, source: "recordVideo probe" };

    const output = [result && result.error && result.error.message, result && result.stderr, result && result.stdout]
      .filter(Boolean)
      .join("\n");
    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const reason = lines.find((line) => /ffmpeg|executable doesn't exist|browser(?:type|context)|recordvideo|timed out/i.test(line))
      || lines[0]
      || `video probe exited ${result && result.status != null ? result.status : "without a status"}`;
    return { ok: false, reason: reason.slice(0, 300) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Warning-only (required:false, like the version-skew row): motion is quarantined to
// explicitly declared items, so a missing engine must not fail the read-only preflight
// for non-motion users. The Chromium video probe launches ONLY once the npm dependencies
// resolve — with a lazy install absent, doctor stays a pure filesystem check.
function checkMotionEngine(versionString, packageDir, browserProbe = probeMotionBrowser) {
  const nodeOk = supportsNode(versionString);
  const entry = path.join(packageDir, "bin", "motion-kit.js");
  let deps = true;
  for (const name of ["playwright", "pixelmatch", "pngjs"]) {
    try { require.resolve(name, { paths: [packageDir] }); } catch (e) { deps = false; }
  }
  const bundled = fs.existsSync(entry);
  const browser = bundled && deps && nodeOk
    ? browserProbe(packageDir)
    : { ok: false, reason: !nodeOk ? `${DISPLAY_RANGE} required` : "npm dependencies not installed (lazy — no postinstall)" };
  return {
    name: "integrated motion engine",
    ok: bundled && deps && browser.ok && nodeOk,
    detail: !bundled ? "package missing"
      : !nodeOk ? `package found; ${versionString} cannot run it`
      : !deps ? "package found; npm dependencies not installed (motion commands need them; the rest of the kit does not)"
      : !browser.ok ? `runtime installed; ${browser.reason || "no launchable browser"}`
      : `ready (${browser.source || "browser"}; CSS/WAAPI/JS/canvas/WebGL)`,
    fix: !nodeOk ? `install/use ${DISPLAY_RANGE}, then reinstall: npm i -g pingfusi@latest`
      : !bundled ? "reinstall the complete package: npm i -g pingfusi@latest"
      : !deps ? "run: pingfusi motion install   (downloads the motion engine's npm dependencies)"
      : !browser.ok ? "run: pingfusi motion install-browser (video recording requires Playwright Chromium + FFmpeg)"
      : null,
    required: false,
  };
}

function checkBinary(name, args, why, fix, required) {
  let ok = false, detail = "not found on PATH";
  try {
    const r = spawnSync(name, args, { stdio: "pipe", timeout: 10_000 });
    if (r.status === 0 || (r.stdout && r.stdout.length) || (r.stderr && r.stderr.length && !r.error)) {
      ok = !r.error;
      detail = ok ? String(r.stdout || r.stderr).split("\n")[0].trim().slice(0, 60) : detail;
    }
  } catch (e) { /* not found */ }
  return { name: `${name} (${why})`, ok, detail, fix, required };
}

// Optional: the behavior-capture runner needs a launchable Chrome. Not required — a
// foregroundable interactive tab still works — but agents whose automation reports
// document.hidden=true permanently NEED this path, so surface it at minute one.
function checkChrome(resolveChrome) {
  let r = { error: "resolver unavailable" };
  try { r = resolveChrome({}); } catch (e) {}
  return {
    name: "Chrome (capture runners)",
    ok: !r.error,
    detail: r.path || "none of the known install paths",
    fix: "install Google Chrome, or point at one with PPK_CHROME=<path> — needed for `pingfusi capture-run` and `pingfusi behavior-capture` (the invisible capture paths; also required when your agent's browser tabs are permanently hidden)",
    required: false,
  };
}

// Version skew is invisible until it bites: two developers ran "the same kit", one on a
// stale global whose runner still popped a window, and nothing in any output said which
// version was acting. Best-effort npm check — the registry being unreachable must never
// fail doctor (offline is a place people work).
function checkKitVersion(installed, latest) {
  if (!latest) return { name: `pingfusi ${installed}`, ok: true, detail: "npm registry unreachable — up-to-date check skipped", required: false };
  const ok = installed === latest;
  return {
    name: `pingfusi ${installed}`,
    ok,
    detail: ok ? "latest" : `npm has ${latest} — a stale install keeps OLD behavior (a fixed bug stays unfixed on this machine)`,
    fix: "npm i -g pingfusi@latest",
    required: false,
  };
}

function npmLatestVersion() {
  try {
    const r = spawnSync("npm", ["view", "pingfusi", "version"], { stdio: "pipe", timeout: 5_000 });
    const v = String(r.stdout || "").trim();
    return /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch (e) { return null; }
}

function checkReviewToken(resolveToken) {
  let token = null;
  try { token = resolveToken(); } catch (e) {}
  return {
    name: "review login (remote review rounds)",
    ok: !!token,
    detail: token ? "token found" : "no token found",
    fix: "run: pingfusi setup — review rounds require the login (an independent reviewer answers them; there is no offline review path)",
    required: true,
  };
}

function report(checks) {
  let failedRequired = 0;
  for (const c of checks) {
    const mark = c.ok ? "✓" : c.required ? "❌" : "⚠";
    console.log(`${mark} ${c.name} — ${c.detail}`);
    if (!c.ok && c.fix) console.log(`    fix: ${c.fix}`);
    if (!c.ok && c.required) failedRequired++;
  }
  console.log(`
ℹ your AI agent needs BROWSER AUTOMATION to drive live-site captures (e.g. Claude Code
  with the Chrome extension / claude-in-chrome MCP) — doctor can't verify that from here;
  make sure your agent can open and script a browser tab.`);
  if (failedRequired) {
    console.log(`\n❌ ${failedRequired} required check(s) failed — fix the lines above, then re-run: pingfusi doctor`);
    return 1;
  }
  console.log(`\n✓ ready. Teach your agent next (once): pingfusi agent-setup
  then just ask it: "Clone https://example.com pixel-perfect."`);
  return 0;
}

function main() {
  const { resolveToken } = require("./review-qa.js");
  const checks = [
    checkNode(process.versions.node),
    checkMotionEngine(process.versions.node, require("path").join(__dirname, "..", "packages", "motion")),
    checkKitVersion(require(require("path").join(__dirname, "..", "package.json")).version, npmLatestVersion()),
    checkBinary("cloudflared", ["--version"], "OPTIONAL — only `pingfusi tunnel --url` (live dev-server drafts) needs it; the default clone flow is tunnel-free", "brew install cloudflared   (or https://developers.cloudflare.com/cloudflared)", false),
    checkReviewToken(resolveToken),
    checkChrome(require("./chrome.js").resolveChrome),
    checkBinary("ffmpeg", ["-version"], "optional — frame-level video verification", "brew install ffmpeg", false),
  ];
  process.exit(report(checks));
}

if (require.main === module) main();
module.exports = { checkNode, checkMotionEngine, probeMotionBrowser, checkBinary, checkChrome, checkKitVersion, checkReviewToken, report };
