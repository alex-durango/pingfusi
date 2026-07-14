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
  check("classic scrollbars hidden (layout width must equal the normalized viewport)", flags.includes("--hide-scrollbars"));
  check("user-data-dir + window-size carried", flags.includes("--user-data-dir=/tmp/prof") && flags.includes("--window-size=1512,1000"));
  check("no first-run noise", flags.includes("--no-first-run") && flags.includes("--no-default-browser-check"));
  check("flagsFor omits --headless unless asked (the runner's DEFAULT is headless — policy lives there)", !flags.some((f) => f.startsWith("--headless")));
  check("headless uses headless=new", flagsFor({ userDataDir: "/x", headless: true }).includes("--headless=new"));
}

// ── parseDevToolsActivePort ────────────────────────────────────────────────────
check("port file parses", parseDevToolsActivePort("62444\n/devtools/browser/abc-def") === 62444);
check("partial write → null (keep polling)", parseDevToolsActivePort("") === null && parseDevToolsActivePort("garbage\n/x") === null);
check("zero/negative → null", parseDevToolsActivePort("0\n/x") === null && parseDevToolsActivePort("-5") === null);

// ── resolveViewport + viewportMismatch: the "rendered size ≠ window size" fix ──
// (measured on heyaristotle: headless dpr 1 vs the dev's real 2, innerHeight 963 from a
// 1050 window, and a width-only conditional that never fired — scrollHeight changed
// 6526→6554 under the corrected viewport, i.e. the RENDER differed, not just numbers)
{
  const { resolveViewport, viewportMismatch } = require("./chrome.js");
  const d = resolveViewport({});
  check("defaults are a real Mac: 1440×982 @2x, sources say so", d.width === 1440 && d.height === 982 && d.dpr === 2 && d.sources.dpr === "default");
  const t = resolveViewport({ target: { width: 1512, height: 900, dpr: 1 } });
  check("explicit target.json fields win (even dpr 1)", t.width === 1512 && t.height === 900 && t.dpr === 1 && t.sources.height === "target.json");
  const l = resolveViewport({ target: { width: 1512 }, live: { viewport: { width: 1512, height: 862, dpr: 2 } } });
  check("an existing live.json's viewport fills the gaps (mode-match: compare like with like)", l.width === 1512 && l.height === 862 && l.sources.height === "live.json" && l.sources.width === "target.json");
  const asked = { width: 1512, height: 982, dpr: 2 };
  check("matching read → no mismatch", viewportMismatch(asked, { iw: 1512, cw: 1512, ih: 982, dpr: 2 }) === null);
  check("dpr drift named", /devicePixelRatio 1/.test(viewportMismatch(asked, { iw: 1512, cw: 1512, ih: 982, dpr: 1 })));
  check("short viewport named", /innerHeight 963/.test(viewportMismatch(asked, { iw: 1512, cw: 1512, ih: 963, dpr: 2 })));
  check("empty read refused", typeof viewportMismatch(asked, null) === "string");
  // a clientWidth gap is a NOTE, never fatal: after --hide-scrollbars it can only mean the
  // SITE styles a layout-consuming root scrollbar — which is how that page renders for real
  // users too (measured: a ::-webkit-scrollbar-styled page reads cw 1497 under iw 1512 even
  // on an overlay-scrollbar Mac; refusing it would hard-fail a legitimate page everywhere)
  const { viewportScrollbarNote } = require("./chrome.js");
  check("clientWidth gap is NOT a mismatch (site-authored scrollbars are the page)", viewportMismatch(asked, { iw: 1512, cw: 1497, ih: 982, dpr: 2 }) === null);
  check("…but it IS a note, naming the gap", /15px under/.test(viewportScrollbarNote(asked, { iw: 1512, cw: 1497, ih: 982, dpr: 2 })) && viewportScrollbarNote(asked, { iw: 1512, cw: 1512, ih: 982, dpr: 2 }) === null);
}

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
