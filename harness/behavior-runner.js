// harness/behavior-runner.js <name> — behavior discovery in a kit-owned Chrome over CDP.
//
// WHY this exists: the behavior gate refuses any capture taken in a hidden tab
// (discovery.documentHidden — Chrome throttles timers and freezes CSS transitions there),
// and some agent-browser automation stacks report document.hidden === true PERMANENTLY,
// for every tab. In that environment in-tab discovery can never pass the gate, and since
// review/done sit behind behavior, the whole run deadlocks. This runner acquires a genuine
// Chrome (launched with throttling disabled, or attached), PROVES the tab measures
// (harness/chrome.js probe — refused by name before any capture), injects the SAME
// tools/behavior-capture.js agents inject (single source of truth, byte-identical), and
// writes behaviors-live.json / behaviors-clone.json directly — no sink round-trip, since
// Runtime.evaluate returns the snapshot by value and is not subject to the page's CSP.
//
// The runner is INVISIBLE by default: headless=new launch, probe-gated (phase 0 measured
// headless at wall-clock rate; the probe re-verifies on every run, so this is not trust).
// The user has an agent cloning in the background precisely so they can keep working — a
// window popping up is an interruption, so one appears ONLY on explicit --headful, and the
// probe-refusal error is what tells you when that's actually needed.
//
// usage: pingfusi behavior-capture <name> [--side both|live|clone]
//          [--attach <port|host:port>] [--chrome <path>] [--headful] [--profile]
//          [--live-url <url>] [--clone-url <url>] [--opts <file>]
//          [--nav-timeout <ms>] [--keep-open] [--dry-run]
//
// opts file (default targets/<name>/behavior-opts.json, all fields optional):
//   { "region": { "sel": "main", "maxY": 4000 },        // pxRegion; default: whole page
//     "scrollSteps": 6, "dwellMs": 250, "settleMs": 1500,
//     "marqueeSelectors": [["ticker_belt", ".ticker-track"]],
//     "hoverTriggers": [["nav_product", "nav a.product", ".mega-menu"]] }
//   String selectors only — the same opts go to BOTH sides mechanically, which turns the
//   RUNBOOK's "capture the clone the SAME way" convention into a guarantee.
"use strict";

const fs = require("fs");
const path = require("path");
const cdp = require("./cdp.js");
const chrome = require("./chrome.js");
const { serve } = require("./serve.js");

// same convention as workflow.js: hints must be RUNNABLE in the invoking context
const VIA_PPK = process.env.PPK_ENTRY === "1";
const CMD = VIA_PPK ? "pingfusi" : "node harness/workflow.js";
const WORK = process.cwd();
const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// If the live side hits a wall, the answer is a ladder, not optimism (phase 0: chrono24's
// wall beats BOTH headless and headful fresh profiles). Printed, never auto-climbed.
const LADDER = `the live page looks like a bot-challenge wall. The ladder, in order:
  1. re-run with --profile   (persistent kit profile at ~/.pingfusi/chrome-profile — open it once
     interactively with --keep-open, clear the challenge/log in, and it sticks for later runs)
  2. re-run with --attach <port>   (a Chrome YOU launched: it must use its own --user-data-dir —
     Chrome 136+ refuses debugging on the default profile)
  3. no way through: the declared inventory + node tools/behavior-worksheet.js <name> routes each
     row to the reviewer as a poll question — the review round becomes the measurement instrument.`;

function parseArgs(argv) {
  const a = { side: "both", navTimeout: 30000 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--side") a.side = argv[++i];
    else if (v === "--attach") a.attach = argv[++i];
    else if (v === "--chrome") a.chrome = argv[++i];
    else if (v === "--headful") a.headful = true;
    else if (v === "--headless") a.headless = true; // accepted for back-compat; headless is the default now
    else if (v === "--profile") a.profile = true;
    else if (v === "--live-url") a.liveUrl = argv[++i];
    else if (v === "--clone-url") a.cloneUrl = argv[++i];
    else if (v === "--opts") a.optsFile = argv[++i];
    else if (v === "--nav-timeout") a.navTimeout = +argv[++i];
    else if (v === "--keep-open") a.keepOpen = true;
    else if (v === "--dry-run") a.dryRun = true;
    else if (v.startsWith("--")) die(`unknown flag ${v} — see the usage block at the top of harness/behavior-runner.js`);
    else rest.push(v);
  }
  a.name = rest[0];
  return a;
}

function loadOpts(name, optsFile) {
  const p = optsFile || path.join(WORK, "targets", name, "behavior-opts.json");
  if (!fs.existsSync(p)) return { path: null, opts: {} };
  let o;
  try { o = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { die(`${p} is not valid JSON: ${e.message}`); }
  for (const k of ["marqueeSelectors", "hoverTriggers"]) {
    for (const row of o[k] || []) {
      if (!Array.isArray(row) || typeof row[0] !== "string" || typeof row[1] !== "string")
        die(`${p}: ${k} rows must be ["name", "css-selector"${k === "hoverTriggers" ? '[, "scope-selector"]' : ""}] string pairs — got ${JSON.stringify(row)}`);
    }
  }
  return { path: p, opts: o };
}

// One side: open tab → prove the environment → navigate → prove it AGAIN on the real page
// (occlusion can differ per window) → match the target viewport → inject → capture → write.
async function captureSide(side, url, ctx) {
  const { session, targetId } = await cdp.openPage(ctx.acq.port, { host: ctx.acq.host });
  try {
    let probe = await chrome.probeEnvironment(session);
    if (!probe.verdict.ok) throw new Error(`environment refused before any capture (${side}, about:blank): ${probe.verdict.reason}`);

    console.log(`· ${side}: ${url}`);
    await cdp.navigate(session, url, { timeoutMs: ctx.args.navTimeout, warn: (m) => console.log(`  ⚠ ${m}`) });
    await sleep(ctx.opts.settleMs != null ? ctx.opts.settleMs : 1500); // let load-time choreography arm before probing/sweeping

    probe = await chrome.probeEnvironment(session);
    if (!probe.verdict.ok) throw new Error(`environment refused on the loaded page (${side}): ${probe.verdict.reason}`);

    // The window is part of the instrument: headful Chrome clamps --window-size to the
    // display (phase 0: asked 1920, got 1512) — the emulation override restores the
    // target width and the compositor keeps advancing under it.
    if (ctx.width && probe.sample.innerWidth !== ctx.width) {
      await session.send("Emulation.setDeviceMetricsOverride", { width: ctx.width, height: 1050, deviceScaleFactor: 0, mobile: false });
      const iw = await cdp.evaluate(session, "innerWidth", { awaitPromise: false });
      if (iw !== ctx.width) console.log(`  ⚠ viewport is ${iw}px, target.json says ${ctx.width}px — even setDeviceMetricsOverride couldn't fix it; captures may disagree with earlier phases`);
      else console.log(`  · viewport ${probe.sample.innerWidth}px → ${iw}px (metrics override; window clamped by the display)`);
    }

    const title = String(await cdp.evaluate(session, "document.title", { awaitPromise: false }) || "");
    if (side === "live" && /just a moment|attention required|access denied|challenge/i.test(title)) console.log(`  ⚠ title is ${JSON.stringify(title)} — ${LADDER}`);

    await cdp.evaluate(session, ctx.captureSource, { awaitPromise: false });
    const shape = await cdp.evaluate(session, "typeof pxBehaviorCapture", { awaitPromise: false });
    if (shape !== "function") throw new Error(`injection landed but pxBehaviorCapture is ${shape} — tools/behavior-capture.js changed shape?`);
    const region = ctx.opts.region ? JSON.stringify(ctx.opts.region) : "{ maxY: (document.scrollingElement || document.documentElement).scrollHeight }";
    await cdp.evaluate(session, `window.pxRegion = ${region}`, { awaitPromise: false });

    const discoverOpts = {};
    for (const k of ["scrollSteps", "dwellMs", "settleMs", "marqueeSelectors", "hoverTriggers"]) if (ctx.opts[k] != null) discoverOpts[k] = ctx.opts[k];
    const raw = await cdp.evaluate(session, `pxBehaviorCapture(${JSON.stringify(discoverOpts)})`, { timeoutMs: 180000 });
    let snap;
    try { snap = JSON.parse(raw); } catch (e) { throw new Error(`pxBehaviorCapture returned non-JSON (${String(raw).slice(0, 120)}…)`); }

    // The attestation: what measured this, and the receipts that it could. Old-schema-safe —
    // the gate ignores unknown discovery fields; when present the pass reason can cite it.
    snap.discovery = snap.discovery || {};
    snap.discovery.runner = {
      mode: ctx.acq.mode, chromeVersion: ctx.acq.chromeVersion, headless: ctx.acq.headless, profile: ctx.acq.profile,
      rafProbe: { ...probe.sample.raf, hz: probe.verdict.rafHz },
      animProbe: probe.sample.anim,
    };

    const outPath = path.join(WORK, "targets", ctx.args.name, `behaviors-${side}.json`);
    if (snap.discovery.documentHidden === true) {
      // Recorded as measured, never touched — but a hidden capture must not overwrite the
      // real artifact. (The probes above make this near-unreachable: a window minimized in
      // the capture window itself.)
      const rej = outPath.replace(/\.json$/, ".rejected.json");
      fs.writeFileSync(rej, JSON.stringify(snap, null, 2));
      throw new Error(`the ${side} tab went HIDDEN during capture — snapshot dumped to ${path.relative(WORK, rej)} as evidence, the real artifact untouched. Was the window minimized mid-run?`);
    }
    fs.writeFileSync(outPath, JSON.stringify(snap, null, 2));

    const nBehaviors = Object.keys(snap.behaviors || {}).length, nDeclared = Object.keys(snap.declared || {}).length;
    console.log(`  ✓ ${path.relative(WORK, outPath)} — ${nBehaviors} behavior(s), ${nDeclared} declared, ${snap.discovery.elementsScanned} elements scanned, documentHidden=${snap.discovery.documentHidden}`);
    if (side === "live" && ctx.cloneScanned && snap.discovery.elementsScanned < ctx.cloneScanned / 10)
      console.log(`  ⚠ live scanned ${snap.discovery.elementsScanned} elements vs the clone's ${ctx.cloneScanned} — ${LADDER}`);
    return snap;
  } finally {
    session.close();
    await cdp.closeTab(ctx.acq.port, targetId, { host: ctx.acq.host });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.name) die(`usage: ${VIA_PPK ? "pingfusi behavior-capture" : "node harness/behavior-runner.js"} <name> [--side both|live|clone] [--dry-run] …`);
  if (!["both", "live", "clone"].includes(args.side)) die(`--side must be both|live|clone, got "${args.side}"`);

  const targetPath = path.join(WORK, "targets", args.name, "target.json");
  let target = {};
  if (fs.existsSync(targetPath)) target = JSON.parse(fs.readFileSync(targetPath, "utf8"));
  else if (!args.liveUrl && args.side !== "clone") die(`targets/${args.name}/target.json missing and no --live-url given — run: pingfusi new ${args.name} <url>`);
  const liveUrl = args.liveUrl || target.url;
  const width = target.width || 1440;
  const { path: optsPath, opts } = loadOpts(args.name, args.optsFile);

  const wantClone = args.side !== "live";
  const cloneDir = path.join(WORK, "targets", args.name, "clone");
  const cloneMissing = wantClone && !args.cloneUrl && !fs.existsSync(path.join(cloneDir, "index.html"));

  if (args.dryRun) {
    // informational — report every decision (including a missing clone) instead of dying on the first
    const bin = chrome.resolveChrome({ cliPath: args.chrome });
    console.log(`behavior-capture ${args.name} — dry run`);
    console.log(`  sides: ${args.side}${args.side !== "clone" ? `   live: ${liveUrl}` : ""}${wantClone ? `   clone: ${args.cloneUrl || `self-served from targets/${args.name}/clone${cloneMissing ? " (MISSING — build it first)" : ""}`}` : ""}`);
    console.log(`  acquisition: ${args.attach || process.env.PPK_CDP_URL ? `attach to ${args.attach || process.env.PPK_CDP_URL}` : bin.error ? "LAUNCH — but " + bin.error : `launch ${bin.path}${args.headful ? " (headful — a window WILL appear)" : " (headless=new — invisible, probe-gated)"}${args.profile ? " with the persistent kit profile" : " with a temp profile"}`}`);
    console.log(`  opts: ${optsPath ? optsPath : "none (defaults; discovery still runs — marquee/hover rows just need behavior-opts.json)"}`);
    console.log(`  viewport: ${width}px (target.json${target.width ? "" : " absent — default"})`);
    process.exit(!args.attach && bin.error ? 1 : 0);
  }

  if (cloneMissing)
    die(`no targets/${args.name}/clone/index.html to capture — build it first (${CMD} capture-build ${args.name}) or pass --clone-url`);

  const acq = await chrome.acquire({
    attach: args.attach, chromePath: args.chrome, headless: !args.headful,
    profileDir: args.profile ? path.join(require("os").homedir(), ".pingfusi", "chrome-profile") : null,
    width, height: 1050,
  }).catch((e) => die(e.message));
  console.log(`· ${acq.mode} ${acq.chromeVersion}${acq.headless ? " (headless=new)" : ""}${acq.profile === "persistent" ? " (persistent profile)" : ""} on :${acq.port}`);

  let cloneServer = null, cloneUrl = args.cloneUrl;
  if (wantClone && !cloneUrl) {
    cloneServer = serve(args.name, 0);
    await new Promise((r) => cloneServer.on("listening", r));
    cloneUrl = `http://127.0.0.1:${cloneServer.address().port}/`;
  }

  const captureSource = fs.readFileSync(path.join(__dirname, "..", "tools", "behavior-capture.js"), "utf8");
  const ctx = { args, acq, opts, width, captureSource };
  const teardown = async () => {
    if (cloneServer) cloneServer.close();
    if (!args.keepOpen) await acq.cleanup();
    else console.log(`· --keep-open: Chrome left running on :${acq.port} (${acq.mode})`);
  };
  process.on("SIGINT", () => { teardown().then(() => process.exit(130)); });

  try {
    // clone first when capturing both: it always works (localhost, no wall), and its
    // elementsScanned gives the live side's wall heuristic a baseline to compare against.
    if (wantClone) { const c = await captureSide("clone", cloneUrl, ctx); ctx.cloneScanned = c.discovery.elementsScanned; }
    if (args.side !== "clone") await captureSide("live", liveUrl, ctx);
    console.log(`\n✓ behavior capture done — next: ${CMD} gate ${args.name} behavior`);
  } catch (e) {
    // The default headless launch is probe-gated, not trusted — if THIS Chrome's headless
    // fails the probe, the one legitimate reason for a visible window exists, and the
    // error is where the user learns it (never a surprise window).
    const headfulHint = acq.mode === "cdp-launched" && acq.headless && /environment refused/.test(e.message)
      ? `\n  headless Chrome failed the measurement probe on this machine — re-run with --headful (one visible Chrome window for the duration of the capture; that is the only time this tool interrupts)` : "";
    console.error(`✗ ${e.message}${headfulHint}`);
    process.exitCode = 1;
  } finally {
    await teardown();
  }
}

if (require.main === module) main();
module.exports = { parseArgs, loadOpts, LADDER };
