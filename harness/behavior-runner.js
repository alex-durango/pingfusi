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
const { syncMotionItemsFromBehaviors } = require("./motion-items.js");

// same convention as workflow.js: hints must be RUNNABLE in the invoking context
const VIA_PPK = process.env.PPK_ENTRY === "1";
const CMD = VIA_PPK ? "pingfusi" : "node harness/workflow.js";
const WORK = process.cwd();
// Printed at startup and recorded in the attestation — "which version popped this window"
// must be answerable from the run output alone (two developers, one on a stale global,
// spent a round of confusion on exactly that).
const KIT_VERSION = require(path.join(__dirname, "..", "package.json")).version;
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

// Injected BEFORE navigation, so load-time JS/rAF motion that finishes during the normal
// settle/probe window is still evidence. It watches only repeated inline style changes to
// temporal paint properties; a one-off class/state toggle remains interaction evidence.
// The bounded recorder is deliberately tiny and dependency-free because it runs on the
// original site before any kit capture code exists there.
const EARLY_MOTION_RECORDER = [
  "(() => {",
  "  const rows = new Map();",
  "  const startedAt = performance.now();",
  "  const escapeCss = (value) => { try { return CSS.escape(value); } catch (_) { return String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\\\' + c); } };",
  "  const selectorOf = (el) => {",
  "    if (!el || el.nodeType !== 1) return null;",
  "    if (el.id) return '#' + escapeCss(el.id);",
  "    const parts = []; let cur = el;",
  "    while (cur && cur.nodeType === 1 && parts.length < 5) {",
  "      let part = cur.tagName.toLowerCase();",
  "      const parent = cur.parentElement;",
  "      if (parent) { const peers = Array.from(parent.children).filter((x) => x.tagName === cur.tagName); if (peers.length > 1) part += ':nth-of-type(' + (peers.indexOf(cur) + 1) + ')'; }",
  "      parts.unshift(part); cur = parent;",
  "    }",
  "    return parts.join('>');",
  "  };",
  "  const snapshot = (el) => { const s = getComputedStyle(el); return { opacity: s.opacity, transform: s.transform, filter: s.filter }; };",
  "  const same = (a, b) => !!a && !!b && a.opacity === b.opacity && a.transform === b.transform && a.filter === b.filter;",
  "  const record = (el) => {",
  "    if (!el || !el.isConnected) return;",
  "    const selector = selectorOf(el); if (!selector) return;",
  "    let row = rows.get(selector);",
  "    if (!row) { if (rows.size >= 128) return; row = { selector, samples: [] }; rows.set(selector, row); }",
  "    const style = snapshot(el); const last = row.samples[row.samples.length - 1];",
  "    if (last && same(last.style, style)) return;",
  "    row.samples.push({ t: Math.round((performance.now() - startedAt) * 10) / 10, style });",
  "    if (row.samples.length > 80) row.samples.shift();",
  "  };",
  "  const observer = new MutationObserver((records) => { for (const r of records) if (r.attributeName === 'style') record(r.target); });",
  "  observer.observe(document, { subtree: true, attributes: true, attributeFilter: ['style'] });",
  "  window.__pingfusiEarlyMotion = { collect() { observer.disconnect(); return { durationMs: Math.round((performance.now() - startedAt) * 10) / 10, rows: Array.from(rows.values()) }; } };",
  "})();",
].join("\n");

const temporalStyleDelta = (a, b) => ["opacity", "transform", "filter"].reduce((n, key) => n + (String(a && a[key]) !== String(b && b[key]) ? 1 : 0), 0);

function mergeEarlyMotion(snapshot, early) {
  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
  snap.behaviors = snap.behaviors && typeof snap.behaviors === "object" ? snap.behaviors : {};
  snap.discovery = snap.discovery && typeof snap.discovery === "object" ? snap.discovery : {};
  let accepted = 0;
  for (const row of early && Array.isArray(early.rows) ? early.rows : []) {
    const samples = Array.isArray(row.samples) ? row.samples.filter((s) => s && s.style) : [];
    if (samples.length < 3) continue;
    const first = samples[0], last = samples[samples.length - 1];
    const durationMs = Number(last.t) - Number(first.t);
    const distinct = new Set(samples.map((s) => JSON.stringify(s.style))).size;
    if (!Number.isFinite(durationMs) || durationMs < 32 || distinct < 2) continue;
    let representative = first;
    for (const sample of samples) if (temporalStyleDelta(first.style, sample.style) > temporalStyleDelta(first.style, representative.style)) representative = sample;
    if (!temporalStyleDelta(first.style, representative.style)) continue;
    const selector = typeof row.selector === "string" && row.selector ? row.selector : null;
    if (!selector) continue;
    const key = `startup:${selector}`;
    if (snap.behaviors[key]) continue;
    snap.behaviors[key] = {
      trigger: "load",
      kind: "animation",
      selector,
      temporal: {
        candidate: "strong",
        kind: "raf-animation",
        trigger: "load",
        durationMs: Math.round(durationMs),
        reason: "repeated temporal style changes were recorded from document start before the capture settle window",
      },
      measured: {
        before: first.style,
        after: last.style,
        during: representative.style,
        sampleCount: samples.length,
        durationMs: Math.round(durationMs),
        returnedToStart: temporalStyleDelta(first.style, last.style) === 0,
      },
    };
    accepted++;
  }
  snap.discovery.earlyMotionRecorder = {
    ran: !!early,
    durationMs: early && Number.isFinite(Number(early.durationMs)) ? Number(early.durationMs) : null,
    rowsObserved: early && Array.isArray(early.rows) ? early.rows.length : 0,
    strongRows: accepted,
  };
  return snap;
}

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

    // Normalize the viewport UNCONDITIONALLY, before navigation — headless renders at dpr 1
    // with a short innerHeight otherwise, which is a genuinely DIFFERENT page (wrong srcset
    // images, wrong fold). Setting it first means the initial render is already right.
    await chrome.normalizeViewport(session, ctx.viewport);

    // Must land before Page.navigate: capture code injected after the normal settle delay
    // cannot reconstruct a startup animation that has already completed.
    await session.send("Page.addScriptToEvaluateOnNewDocument", { source: EARLY_MOTION_RECORDER });

    console.log(`· ${side}: ${url}`);
    await cdp.navigate(session, url, { timeoutMs: ctx.args.navTimeout, warn: (m) => console.log(`  ⚠ ${m}`) });
    await sleep(ctx.opts.settleMs != null ? ctx.opts.settleMs : 1500); // let load-time choreography arm before probing/sweeping

    probe = await chrome.probeEnvironment(session);
    if (!probe.verdict.ok) throw new Error(`environment refused on the loaded page (${side}): ${probe.verdict.reason}`);

    // Verified, not trusted: read back what the page actually renders at.
    const got = await cdp.evaluate(session, chrome.VIEWPORT_READ, { awaitPromise: false });
    const vpMiss = chrome.viewportMismatch(ctx.viewport, got);
    if (vpMiss) throw new Error(`viewport did not normalize on the ${side} page — ${vpMiss}. Measuring at the wrong size is the exact bug this override exists to prevent (an --attach Chrome's real window can fight emulation — prefer the launched mode).`);
    const sbNote = chrome.viewportScrollbarNote(ctx.viewport, got);
    if (sbNote) console.log(`  ⚠ ${sbNote}`);

    const title = String(await cdp.evaluate(session, "document.title", { awaitPromise: false }) || "");
    const wallTitle = side === "live" && /just a moment|attention required|access denied/i.test(title) ? title : null;

    const earlyMotion = await cdp.evaluate(
      session,
      "window.__pingfusiEarlyMotion ? window.__pingfusiEarlyMotion.collect() : null",
      { awaitPromise: false }
    ).catch(() => null);

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
    mergeEarlyMotion(snap, earlyMotion);

    // The attestation: what measured this, and the receipts that it could. Old-schema-safe —
    // the gate ignores unknown discovery fields; when present the pass reason can cite it.
    snap.discovery = snap.discovery || {};
    snap.discovery.runner = {
      kitVersion: KIT_VERSION,
      mode: ctx.acq.mode, chromeVersion: ctx.acq.chromeVersion, headless: ctx.acq.headless, profile: ctx.acq.profile,
      viewport: { width: ctx.viewport.width, height: ctx.viewport.height, dpr: ctx.viewport.dpr, sources: ctx.viewport.sources },
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

    // A wall is an ERROR, not a warning — a challenge page's "behaviors" are junk the gate
    // would then compare in earnest. The snapshot stays on disk as evidence; the exit code
    // is the verdict, and the error is the ladder.
    const leafCollapse = side === "live" && ctx.cloneScanned && snap.discovery.elementsScanned < ctx.cloneScanned / 10;
    if (wallTitle || leafCollapse)
      throw new Error(`the live page looks like a bot-challenge wall (${wallTitle ? `title ${JSON.stringify(wallTitle)}` : `scanned only ${snap.discovery.elementsScanned} elements vs the clone's ${ctx.cloneScanned}`}) — ${path.relative(WORK, outPath)} was written as EVIDENCE of the wall, not the site. ${LADDER}`);
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
  // The full viewport (width AND height AND dpr), matched to what the pipeline already
  // measured against when a live.json exists — never just width (see chrome.js: a
  // width-only override leaves headless at dpr 1 with a short viewport, a different page).
  let liveSnap = null;
  try { liveSnap = JSON.parse(fs.readFileSync(path.join(WORK, "targets", args.name, "live.json"), "utf8")); } catch (e) {}
  const viewport = chrome.resolveViewport({ target, live: liveSnap });
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
    console.log(`  viewport: ${viewport.width}×${viewport.height} @${viewport.dpr}x (width: ${viewport.sources.width}, height: ${viewport.sources.height}, dpr: ${viewport.sources.dpr})`);
    process.exit(!args.attach && bin.error ? 1 : 0);
  }

  if (cloneMissing)
    die(`no targets/${args.name}/clone/index.html to capture — build it first (${CMD} capture-build ${args.name}) or pass --clone-url`);

  const acq = await chrome.acquire({
    attach: args.attach, chromePath: args.chrome, headless: !args.headful,
    profileDir: args.profile ? path.join(require("os").homedir(), ".pingfusi", "chrome-profile") : null,
    width: viewport.width, height: 1050,
  }).catch((e) => die(e.message));
  console.log(`· pingfusi ${KIT_VERSION} behavior-capture — ${acq.mode} ${acq.chromeVersion}${acq.headless ? " (headless=new)" : ""}${acq.profile === "persistent" ? " (persistent profile)" : ""} on :${acq.port}, viewport ${viewport.width}×${viewport.height} @${viewport.dpr}x`);

  let cloneServer = null, cloneUrl = args.cloneUrl;
  if (wantClone && !cloneUrl) {
    cloneServer = serve(args.name, 0);
    await new Promise((r) => cloneServer.on("listening", r));
    cloneUrl = `http://127.0.0.1:${cloneServer.address().port}/`;
  }

  const captureSource = fs.readFileSync(path.join(__dirname, "..", "tools", "behavior-capture.js"), "utf8");
  const ctx = { args, acq, opts, viewport, captureSource };
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
    if (args.side !== "clone") {
      const liveBehavior = await captureSide("live", liveUrl, ctx);
      const motion = syncMotionItemsFromBehaviors(path.join(WORK, "targets", args.name), liveBehavior, { name: args.name, url: liveUrl });
      if (motion.created.length || motion.updated.length) {
        console.log(`  ✓ motion ownership reconciled — ${motion.created.length} created, ${motion.updated.length} updated: ${motion.created.concat(motion.updated).join(", ")}`);
        console.log(`    next specialist action: ${CMD} next ${args.name}`);
      }
    }
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
module.exports = { EARLY_MOTION_RECORDER, temporalStyleDelta, mergeEarlyMotion, parseArgs, loadOpts, LADDER };
