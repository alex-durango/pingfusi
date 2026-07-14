// harness/chrome.js — Chrome acquisition for the CDP capture runner: find a binary, launch
// (or attach to) a debuggable Chrome, and PROVE the tab is a measurement environment before
// anything gets captured in it.
//
// WHY the probe: the whole reason this module exists is that some agent-browser stacks
// report document.hidden === true permanently, freezing the compositor — and the behavior
// gate rightly refuses numbers measured there. Launching our own Chrome is the fix, but
// "we launched it ourselves" is a claim, not a receipt. The probe measures rAF cadence and
// a known-rate CSS animation IN the tab and refuses a throttled environment by name, before
// a single capture — trust-but-verify, pointed at ourselves. (Phase-0 receipts in PERF.md:
// headless=new and unfocused headful both measure ~99 of an expected 100 px/s on Chrome 150;
// a fully-occluded window remains unverified, which is why the probe re-runs on the real page.)
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cdp = require("./cdp.js");

// Discovery order: explicit override first, then real Chromes before Chromium-alikes —
// bot walls treat brand Chrome best (chrono24's wall beats fresh profiles either way; see
// the ladder in behavior-runner.js).
const DARWIN_APPS = [
  ["Google Chrome", "Google Chrome"],
  ["Google Chrome Beta", "Google Chrome Beta"],
  ["Google Chrome Canary", "Google Chrome Canary"],
  ["Chromium", "Chromium"],
  ["Microsoft Edge", "Microsoft Edge"],
  ["Brave Browser", "Brave Browser"],
];
function candidatePaths(platform, home) {
  if (platform === "darwin") {
    const out = [];
    for (const root of ["/Applications", path.join(home, "Applications")])
      for (const [app, bin] of DARWIN_APPS) out.push(path.join(root, `${app}.app`, "Contents", "MacOS", bin));
    return out;
  }
  // linux: bare names resolved via PATH by spawn itself — existence checked with `which`-style lookup
  return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
}

// Pure + injectable so the selftest runs against a fake fs. Returns { path } or { error }.
function resolveChrome({ env = process.env, exists = fs.existsSync, platform = process.platform, home = os.homedir(), cliPath = null } = {}) {
  const searched = [];
  for (const p of [cliPath, env.PPK_CHROME].filter(Boolean)) {
    if (exists(p)) return { path: p };
    searched.push(`${p} (from ${cliPath && p === cliPath ? "--chrome" : "PPK_CHROME"})`);
  }
  for (const p of candidatePaths(platform, home)) {
    if (platform !== "darwin") return { path: p }; // bare PATH name — spawn fails loudly if absent
    if (exists(p)) return { path: p };
    searched.push(p);
  }
  return { error: `no Chrome found — searched:\n  ${searched.join("\n  ")}\npoint at one with --chrome <path> or PPK_CHROME=<path>` };
}

// Pure flag assembly (fixtured): the three --disable-background* flags are the point of
// launching our own Chrome — timers and compositor must run even unfocused/occluded.
function flagsFor({ userDataDir, width = 1440, height = 1050, headless = false }) {
  const flags = [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0", // Chrome picks a free port and writes DevToolsActivePort — no port races
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${width},${height}`,
    // Classic (layout-consuming) scrollbars are an ENVIRONMENT property — Linux Chrome and
    // macOS "Show scroll bars: Always" eat ~15px of clientWidth on every tall page, which is
    // a page the dev's overlay-scrollbar Mac never renders. Hide them (same call puppeteer
    // ships by default), so layout width equals the normalized viewport width.
    "--hide-scrollbars",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];
  if (headless) flags.push("--headless=new");
  return flags;
}

// "62444\n/devtools/browser/<id>" → 62444, or null while Chrome is still writing it.
function parseDevToolsActivePort(content) {
  const first = String(content || "").split("\n")[0].trim();
  const port = +first;
  return Number.isInteger(port) && port > 0 ? port : null;
}

async function launchChrome({ chromePath, width, height, headless, profileDir = null, timeoutMs = 15000 } = {}) {
  // A persistent --profile dir survives runs (bot-wall logins, cleared challenges);
  // the default temp dir is created fresh and removed on teardown.
  const userDataDir = profileDir || fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-chrome-"));
  if (profileDir) fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(chromePath, flagsFor({ userDataDir, width, height, headless }), { stdio: "ignore" });
  const spawnErr = new Promise((_, rej) => child.on("error", (e) => rej(new Error(`could not start ${chromePath}: ${e.message}`))));
  spawnErr.catch(() => {}); // raced below during the poll; this handler keeps a late error from becoming an unhandled rejection

  const portFile = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  let port = null;
  while (!port && Date.now() < deadline) {
    if (fs.existsSync(portFile)) { try { port = parseDevToolsActivePort(fs.readFileSync(portFile, "utf8")); } catch (e) {} }
    if (!port) await Promise.race([new Promise((r) => setTimeout(r, 100)), spawnErr]);
  }
  if (!port) {
    try { child.kill(); } catch (e) {}
    throw new Error(`Chrome started but wrote no DevToolsActivePort within ${timeoutMs / 1000}s — profile dir locked by another Chrome? (${userDataDir})`);
  }

  return {
    port,
    userDataDir,
    child,
    async cleanup() {
      // Teardown races Chrome's shutdown (phase 0: rm throws ENOTEMPTY mid-exit) —
      // await the process, then remove with retries. Persistent profiles are kept.
      const exited = new Promise((r) => { child.on("exit", r); setTimeout(r, 5000); });
      try { child.kill(); } catch (e) {}
      await exited;
      if (!profileDir) { try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) {} }
    },
  };
}

// Acquire a debuggable Chrome: explicit attach (--attach / PPK_CDP_URL), else launch our
// own. There is deliberately NO silent auto-attach to :9222 — the runner must never open
// tabs in a browser it didn't launch (that browser is the USER's; popping tabs into it is
// an interruption, and its frontmost-tab-only visibility makes concurrent runs fight).
// Returns { mode, port, chromeVersion, headless, profile, cleanup }.
async function acquire({ attach = null, chromePath = null, headless = false, profileDir = null, width, height, env = process.env } = {}) {
  const attachTo = attach || env.PPK_CDP_URL || null;
  if (attachTo) {
    if (/^wss?:\/\//.test(String(attachTo))) throw new Error(`--attach wants the HTTP debug port (e.g. 9222 or host:9222), not a ws:// url — the runner opens its own tab via /json/new`);
    const [host, port] = String(attachTo).includes(":") ? String(attachTo).split(":") : ["127.0.0.1", attachTo];
    const v = await cdp.version(+port, { host }).catch((e) => { throw new Error(`--attach ${attachTo}: ${e.message}\n(Chrome 136+ refuses --remote-debugging-port on the DEFAULT profile — launch the Chrome you attach to with its own --user-data-dir)`); });
    return { mode: "cdp-attached", host, port: +port, chromeVersion: v.Browser, headless: false, profile: "attached", cleanup: async () => {} };
  }
  const bin = resolveChrome({ env, cliPath: chromePath });
  if (bin.error) throw new Error(bin.error);
  const launched = await launchChrome({ chromePath: bin.path, width, height, headless, profileDir });
  const v = await cdp.version(launched.port);
  return { mode: "cdp-launched", host: "127.0.0.1", port: launched.port, chromeVersion: v.Browser, headless: !!headless, profile: profileDir ? "persistent" : "temp", cleanup: launched.cleanup };
}

// ── viewport fidelity ────────────────────────────────────────────────────────
// A launched Chrome's viewport is NOT the site the user sees, three ways (measured on
// heyaristotle, 2026-07-14): headless devicePixelRatio is 1 while every dev Mac renders at
// 2 (different srcset images, resolution media queries off), innerHeight loses ~87px of
// phantom browser UI from the asked --window-size, and a width-only conditional override
// never fires when width happens to match — leaving both wrong. The page's own scrollHeight
// changed 6526→6554 under the corrected viewport: the RENDER differs, not just the numbers.
// So the viewport is normalized UNCONDITIONALLY, then verified after load.

// Pure: pick the viewport a capture must render at. Explicit target.json fields win, then
// the viewport an existing live.json was measured at (mode-match: compare like with like),
// then the kit's canonical defaults (1440 wide, 982 viewport-height, dpr 2 — a real Mac).
function resolveViewport({ target = {}, live = null } = {}) {
  const lv = (live && live.viewport) || {};
  const pick = (t, l, d) => (t ? { v: t, from: "target.json" } : l ? { v: l, from: "live.json" } : { v: d, from: "default" });
  const w = pick(target.width, lv.width, 1440), h = pick(target.height, lv.height, 982), d = pick(target.dpr, lv.dpr, 2);
  return { width: w.v, height: h.v, dpr: d.v, sources: { width: w.from, height: h.from, dpr: d.from } };
}

// Apply the viewport as a CDP emulation override — exact width, height, AND deviceScaleFactor
// (never 0: "keep current" keeps headless's wrong dpr=1). Set BEFORE navigation so the first
// render already sees the right media queries and picks the right srcset assets.
function normalizeViewport(session, { width, height, dpr }) {
  return session.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
}

// Read back what the page actually renders at — the override is verified, not trusted.
// innerWidth/innerHeight/dpr mismatches are ENVIRONMENT failures (the override didn't take)
// and fatal; a clientWidth gap is NOT — after --hide-scrollbars it can only mean the SITE
// styles a layout-consuming scrollbar on its root scroller, which is how that site renders
// for real users too. Refusing it would hard-fail legitimate pages on every platform
// (measured: a ::-webkit-scrollbar-styled tall page reads cw 1425 under iw 1440 even on an
// overlay-scrollbar Mac). So: mismatch = refuse, scrollbar note = warn and record.
const VIEWPORT_READ = `({ iw: innerWidth, cw: document.documentElement.clientWidth, ih: innerHeight, dpr: devicePixelRatio })`;
function viewportMismatch(asked, got) {
  if (!got) return "viewport read returned nothing";
  const misses = [];
  if (got.iw !== asked.width) misses.push(`innerWidth ${got.iw} ≠ ${asked.width}`);
  if (got.ih !== asked.height) misses.push(`innerHeight ${got.ih} ≠ ${asked.height}`);
  if (got.dpr !== asked.dpr) misses.push(`devicePixelRatio ${got.dpr} ≠ ${asked.dpr}`);
  return misses.length ? misses.join(", ") : null;
}
function viewportScrollbarNote(asked, got) {
  if (!got || got.cw == null || got.cw === asked.width) return null;
  return `layout clientWidth is ${got.cw} (${asked.width - got.cw}px under the viewport) — the page renders a layout-consuming scrollbar; content lays out at ${got.cw}px for real users of this page too`;
}

// The in-tab environment probe. Self-cleaning (style + element removed before resolving —
// the instrument must not remain on the page it is about to measure). ~1.7s of wall clock.
const PROBE_JS = `(async () => {
  const out = { documentHidden: document.hidden, visibilityState: document.visibilityState, hasFocus: document.hasFocus(), innerWidth: innerWidth, devicePixelRatio: devicePixelRatio };
  out.raf = await new Promise((res) => {
    let ticks = 0; const t0 = performance.now();
    const tick = () => { ticks++; if (performance.now() - t0 < 500) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    setTimeout(() => res({ frames: ticks, ms: Math.round(performance.now() - t0) }), 700);
  });
  const style = document.createElement('style');
  style.textContent = '@keyframes __ppkProbe { from { transform: translateX(0px);} to { transform: translateX(1000px);} }';
  (document.head || document.documentElement).appendChild(style);
  const el = document.createElement('div');
  el.id = '__ppk-env-probe';
  el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;opacity:0.01;animation:__ppkProbe 10s linear infinite;';
  (document.body || document.documentElement).appendChild(el);
  try {
    const read = () => { const m = /matrix\\(([^)]+)\\)/.exec(getComputedStyle(el).transform); return m ? parseFloat(m[1].split(',')[4]) : 0; };
    const t0 = performance.now(); const x0 = read();
    await new Promise(r => setTimeout(r, 1000));
    const t1 = performance.now(); const x1 = read();
    out.anim = { expectedPxPerSec: 100, measuredPxPerSec: +(((x1 - x0) / ((t1 - t0) / 1000))).toFixed(2) };
  } finally { el.remove(); style.remove(); }
  return out;
})()`;

// Pure verdict over the probe sample: visible, rAF alive (≥30Hz), the known 100px/s
// animation within ±20%. Anything else is refused by name BEFORE a capture exists.
function evaluateProbe(sample) {
  if (!sample) return { ok: false, reason: "environment probe returned nothing" };
  const hz = sample.raf && sample.raf.ms ? (sample.raf.frames / (Math.min(sample.raf.ms, 500) / 1000)) : 0;
  const measured = sample.anim ? sample.anim.measuredPxPerSec : 0;
  if (sample.documentHidden === true) return { ok: false, reason: `document.hidden is true in this tab — the compositor is (or will be) frozen; a launched window may be minimized, or attach-mode Chrome lacks the throttling flags` };
  if (hz < 30) return { ok: false, reason: `rAF ran at ${hz.toFixed(1)}Hz (need ≥30) — timers are throttled despite document.hidden=${sample.documentHidden}; the tab is not a measurement environment` };
  if (!(measured > 80 && measured < 120)) return { ok: false, reason: `a known 100px/s CSS animation measured ${measured}px/s — the compositor is not advancing at wall-clock rate` };
  return { ok: true, rafHz: +hz.toFixed(1) };
}

async function probeEnvironment(session) {
  const sample = await cdp.evaluate(session, PROBE_JS);
  return { sample, verdict: evaluateProbe(sample) };
}

module.exports = { DARWIN_APPS, candidatePaths, resolveChrome, flagsFor, parseDevToolsActivePort, launchChrome, acquire, PROBE_JS, evaluateProbe, probeEnvironment, resolveViewport, normalizeViewport, VIEWPORT_READ, viewportMismatch, viewportScrollbarNote };
