// Shared runtime probe for the integrated motion package. Kept CommonJS so both the
// root doctor (CJS) and the temporal engine (ESM) use the exact same browser decision.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function browserCandidates({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const explicit = [env.PPK_MOTION_CHROME, env.PPK_CHROME, env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH].filter(Boolean);
  if (platform === "darwin") return [
    ...explicit,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  if (platform === "win32") return [
    ...explicit,
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    env["PROGRAMFILES(X86)"] && path.join(env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  return [
    ...explicit,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
}

function resolveChromium({ playwrightExecutable = null, env, platform, home, exists = fs.existsSync } = {}) {
  // An explicit override is intentional and wins even when Playwright has a cached build.
  const explicit = [env || process.env].flatMap((e) => [e.PPK_MOTION_CHROME, e.PPK_CHROME, e.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH]).filter(Boolean);
  for (const candidate of explicit) if (exists(candidate)) return { ok: true, source: "configured", executablePath: candidate };
  if (playwrightExecutable && exists(playwrightExecutable)) return { ok: true, source: "playwright", executablePath: null };
  for (const candidate of browserCandidates({ env, platform, home })) {
    if (!explicit.includes(candidate) && exists(candidate)) return { ok: true, source: "system", executablePath: candidate };
  }
  return {
    ok: false,
    source: null,
    executablePath: null,
    reason: "no Playwright Chromium or system Chrome executable found",
  };
}

module.exports = { browserCandidates, resolveChromium };
