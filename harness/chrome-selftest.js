// harness/chrome-selftest.js — guards Chrome acquisition, offline.
//
// The lesson it locks in: "we launched Chrome ourselves" is a claim, not a receipt — the
// probe verdict (evaluateProbe) is what admits an environment, and its refusals must be
// by-name for each failure direction: hidden tab, throttled timers despite a visible flag
// (the lying document.hidden=false case), and a compositor not advancing at wall-clock
// rate. Plus the pure plumbing: binary discovery order, flag assembly (the three
// --disable-background* flags ARE the point), and DevToolsActivePort parsing.
"use strict";

const { candidatePaths, resolveChrome, flagsFor, parseDevToolsActivePort, evaluateProbe } = require("./chrome.js");

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
};

// ── resolveChrome: order, overrides, and the not-found error ──────────────────
{
  const HOME = "/Users/t";
  const only = (p) => ({ env: {}, exists: (x) => x === p, platform: "darwin", home: HOME });
  check("system Chrome wins when present", resolveChrome(only("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")).path === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  check("falls through to Chromium when no brand Chrome", resolveChrome(only("/Applications/Chromium.app/Contents/MacOS/Chromium")).path === "/Applications/Chromium.app/Contents/MacOS/Chromium");
  check("~/Applications is searched too", resolveChrome(only("/Users/t/Applications/Brave Browser.app/Contents/MacOS/Brave Browser")).path === "/Users/t/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
  check("--chrome beats everything", resolveChrome({ env: {}, exists: () => true, platform: "darwin", home: HOME, cliPath: "/opt/my-chrome" }).path === "/opt/my-chrome");
  check("PPK_CHROME beats discovery", resolveChrome({ env: { PPK_CHROME: "/opt/env-chrome" }, exists: (x) => x !== "/nope", platform: "darwin", home: HOME }).path === "/opt/env-chrome");
  const miss = resolveChrome({ env: { PPK_CHROME: "/gone" }, exists: () => false, platform: "darwin", home: HOME });
  check("not-found error lists every path searched", !!miss.error && /\/gone \(from PPK_CHROME\)/.test(miss.error) && /Google Chrome\.app/.test(miss.error) && /Brave Browser\.app/.test(miss.error));
  check("not-found error names both overrides", /--chrome <path>/.test(miss.error) && /PPK_CHROME=/.test(miss.error));
  check("linux trusts PATH (spawn fails loudly if absent)", resolveChrome({ env: {}, exists: () => false, platform: "linux", home: "/home/t" }).path === "google-chrome");
  check("darwin candidate list covers both roots", candidatePaths("darwin", HOME).length === 12);
}

// ── flagsFor: the flags that make a launched Chrome a measurement environment ──
{
  const flags = flagsFor({ userDataDir: "/tmp/prof", width: 1512, height: 1000 });
  for (const f of ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"])
    check(`throttle-defeating flag present: ${f}`, flags.includes(f));
  check("port 0 → Chrome picks and writes DevToolsActivePort", flags.includes("--remote-debugging-port=0"));
  check("user-data-dir + window-size carried", flags.includes("--user-data-dir=/tmp/prof") && flags.includes("--window-size=1512,1000"));
  check("no first-run noise", flags.includes("--no-first-run") && flags.includes("--no-default-browser-check"));
  check("flagsFor omits --headless unless asked (the runner's DEFAULT is headless — policy lives there)", !flags.some((f) => f.startsWith("--headless")));
  check("headless uses headless=new", flagsFor({ userDataDir: "/x", headless: true }).includes("--headless=new"));
}

// ── parseDevToolsActivePort ────────────────────────────────────────────────────
check("port file parses", parseDevToolsActivePort("62444\n/devtools/browser/abc-def") === 62444);
check("partial write → null (keep polling)", parseDevToolsActivePort("") === null && parseDevToolsActivePort("garbage\n/x") === null);
check("zero/negative → null", parseDevToolsActivePort("0\n/x") === null && parseDevToolsActivePort("-5") === null);

// ── evaluateProbe: the admissibility verdict, refusals by name ─────────────────
{
  const good = { documentHidden: false, raf: { frames: 33, ms: 702 }, anim: { expectedPxPerSec: 100, measuredPxPerSec: 99.7 } };
  const v = evaluateProbe(good);
  check("phase-0 headless sample admits (66Hz, 99.7px/s)", v.ok && v.rafHz > 60);
  check("hidden tab refused by name", (() => { const r = evaluateProbe({ ...good, documentHidden: true }); return !r.ok && /document\.hidden/.test(r.reason); })());
  check("lying visible flag: dead rAF refused despite hidden=false", (() => { const r = evaluateProbe({ ...good, raf: { frames: 2, ms: 1000 } }); return !r.ok && /rAF/.test(r.reason) && /document\.hidden=false/.test(r.reason); })());
  check("frozen compositor refused despite live rAF", (() => { const r = evaluateProbe({ ...good, anim: { expectedPxPerSec: 100, measuredPxPerSec: 0 } }); return !r.ok && /compositor/.test(r.reason); })());
  check("half-rate compositor refused (throttled, not frozen)", !evaluateProbe({ ...good, anim: { expectedPxPerSec: 100, measuredPxPerSec: 55 } }).ok);
  check("boundary: 81px/s admits, 120px/s refuses", evaluateProbe({ ...good, anim: { expectedPxPerSec: 100, measuredPxPerSec: 81 } }).ok && !evaluateProbe({ ...good, anim: { expectedPxPerSec: 100, measuredPxPerSec: 120 } }).ok);
  check("clamped hidden-tab setTimeout (1s window, few frames) refused", !evaluateProbe({ documentHidden: false, raf: { frames: 1, ms: 1004 }, anim: { expectedPxPerSec: 100, measuredPxPerSec: 0 } }).ok);
  check("empty sample refused", !evaluateProbe(null).ok);
}

console.log(failed ? `\n❌ chrome-selftest: ${failed} check(s) failed.` : "\n✓ chrome-selftest: all checks pass.");
process.exit(failed ? 1 : 0);
