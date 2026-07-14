// harness/capture-runner.js <name> — the FULL capture (settle → measure → DOM → coverage)
// in a kit-owned Chrome over CDP. PERF.md Idea 1, shipped.
//
// WHY: the interactive capture path drives the agent's browser — which for most setups is
// the DEVELOPER'S OWN Chrome: tabs navigating, windows resizing, a page scrolling itself
// while they work. And that tab is background-throttled, so images crawl in and the agent
// burns ~20 round-trips polling "done yet?" (measured on a heyaristotle run, 2026-07-14).
// This runner does the same capture invisibly (headless, probe-gated) at full speed: the
// settle loop runs IN the page on unthrottled timers, and every artifact returns BY VALUE
// over CDP (tools/browser-capture.js value mode) — no sink, no CSP dance, no tabs anywhere
// the user can see. Same injected source, same settle STOP contract, same artifacts.
//
// WHAT IT DOES NOT REPLACE: the interactive path stays first-class for bot-walled sites —
// the agent's tab rides a real logged-in session, which a launched profile can't fake.
// Every failure here prints that fallback by name; nothing dead-ends.
//
// usage: pingfusi capture-run <name> [--side auto|both|live|clone]
//          [--attach <port|host:port>] [--chrome <path>] [--headful] [--profile]
//          [--live-url <url>] [--clone-url <url>] [--no-dom]
//          [--nav-timeout <ms>] [--capture-timeout <ms>] [--keep-open] [--dry-run]
//
// --side auto (default): live only until targets/<name>/clone exists, then both.
// Artifacts land exactly where the interactive path puts them: targets/<name>/live.json,
// coverage.json, dom.html (live side), clone.json (clone side) — plus capture-run.json,
// the run receipt (kit version, viewport + sources, probe numbers, per-file byte counts).
"use strict";

const fs = require("fs");
const path = require("path");
const cdp = require("./cdp.js");
const chrome = require("./chrome.js");
const { serve } = require("./serve.js");

const VIA_PPK = process.env.PPK_ENTRY === "1";
const CMD = VIA_PPK ? "pingfusi" : "node harness/workflow.js";
const WORK = process.cwd();
const KIT_VERSION = require(path.join(__dirname, "..", "package.json")).version;
const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

// The way out when THIS path can't see the real page — never a dead end (the whole
// point of shipping a second capture path is that either one can carry a run).
const FALLBACK = `fallback: the interactive in-browser capture still works — from your
  browser-automation tab, inject tools/browser-capture.js and run
  await pxCaptureAll('<sink_url>')  (sink via: ${CMD === "pingfusi" ? "pingfusi" : CMD} capture open <name>)
  per tools/RUNBOOK.md "Build by capture". Your agent-driven tab rides a real logged-in
  session, which beats bot walls; expect it to be slower (background-tab throttling).`;

const LADDER = `the live page looks like a bot-challenge wall. The ladder, in order:
  1. re-run with --profile   (persistent kit profile at ~/.pingfusi/chrome-profile — open it
     once with --headful --keep-open, clear the challenge/log in, and it sticks)
  2. re-run with --attach <port>   (a Chrome YOU launched with its own --user-data-dir)
  3. ${FALLBACK}`;

function parseArgs(argv) {
  const a = { side: "auto", navTimeout: 30000, captureTimeout: 300000 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--side") a.side = argv[++i];
    else if (v === "--attach") a.attach = argv[++i];
    else if (v === "--chrome") a.chrome = argv[++i];
    else if (v === "--headful") a.headful = true;
    else if (v === "--headless") a.headless = true; // accepted for symmetry; headless is the default
    else if (v === "--profile") a.profile = true;
    else if (v === "--live-url") a.liveUrl = argv[++i];
    else if (v === "--clone-url") a.cloneUrl = argv[++i];
    else if (v === "--no-dom") a.noDom = true;
    else if (v === "--nav-timeout") a.navTimeout = +argv[++i];
    else if (v === "--capture-timeout") a.captureTimeout = +argv[++i];
    else if (v === "--keep-open") a.keepOpen = true;
    else if (v === "--dry-run") a.dryRun = true;
    else if (v.startsWith("--")) die(`unknown flag ${v} — see the usage block at the top of harness/capture-runner.js`);
    else rest.push(v);
  }
  a.name = rest[0];
  return a;
}

// One side: open tab → prove the environment → normalize the viewport → navigate →
// prove it again → verify the viewport → capture by value → write artifacts.
async function captureSide(side, url, ctx) {
  const { session, targetId } = await cdp.openPage(ctx.acq.port, { host: ctx.acq.host });
  try {
    let probe = await chrome.probeEnvironment(session);
    if (!probe.verdict.ok) throw new Error(`environment refused before any capture (${side}, about:blank): ${probe.verdict.reason}`);
    await chrome.normalizeViewport(session, ctx.viewport);

    console.log(`· ${side}: ${url}`);
    const t0 = Date.now();
    await cdp.navigate(session, url, { timeoutMs: ctx.args.navTimeout, warn: (m) => console.log(`  ⚠ ${m}`) });

    probe = await chrome.probeEnvironment(session);
    if (!probe.verdict.ok) throw new Error(`environment refused on the loaded page (${side}): ${probe.verdict.reason}`);
    const got = await cdp.evaluate(session, chrome.VIEWPORT_READ, { awaitPromise: false });
    const vpMiss = chrome.viewportMismatch(ctx.viewport, got);
    if (vpMiss) throw new Error(`viewport did not normalize on the ${side} page — ${vpMiss}. Measuring at the wrong size is the bug this override exists to prevent (an --attach Chrome's real window can fight emulation — prefer the launched mode).`);
    const sbNote = chrome.viewportScrollbarNote(ctx.viewport, got);
    if (sbNote) console.log(`  ⚠ ${sbNote}`);

    const title = String(await cdp.evaluate(session, "document.title", { awaitPromise: false }) || "");
    const wallTitle = side === "live" && /just a moment|attention required|access denied/i.test(title) ? title : null;

    await cdp.evaluate(session, ctx.captureSource, { awaitPromise: false });
    const shape = await cdp.evaluate(session, "typeof pxCaptureAll", { awaitPromise: false });
    if (shape !== "function") throw new Error(`injection landed but pxCaptureAll is ${shape} — tools/browser-capture.js changed shape?`);

    // Value mode: falsy sink → artifacts come back on report.payloads. The settle loop
    // (sweep, wait for height/images to hold still) runs entirely IN the page — the
    // ~20-round-trip "done yet?" polling of the interactive path becomes zero.
    const report = await cdp.evaluate(session, `pxCaptureAll(null, ${JSON.stringify({ prefix: side === "live" ? "live" : "clone", dom: side === "live" && !ctx.args.noDom })})`, { timeoutMs: ctx.args.captureTimeout });
    if (!report || typeof report !== "object") throw new Error(`pxCaptureAll returned ${JSON.stringify(report).slice(0, 120)} — not a report`);

    if (report.aborted === "settle-not-stable") {
      // The settle STOP contract, enforced here too: a page still growing is a page that
      // never existed. This is the PAGE's condition, not the environment's — the fix is
      // usually waiting or a second run, not the interactive fallback.
      const s = report.settle || {};
      throw new Error(`the ${side} page never settled — heights ${JSON.stringify(s.heights || []).slice(0, 120)}, ${s.imagesPending || 0} image(s) still loading${s.pendingImageSrcs ? ` (e.g. ${String(s.pendingImageSrcs[0] || "").slice(0, 80)})` : ""}. ${report.hint || ""} Re-run capture-run (the page may just be slow), and only then consider the interactive path.`);
    }
    if (!report.payloads || !Object.keys(report.payloads).length) throw new Error(`capture returned no artifacts (leaves=${report.leaves}) — report: ${JSON.stringify({ ok: report.ok, failed: report.failed }).slice(0, 200)}`);

    // Payload names are REMOTE-CONTROLLED: they come from page-context JS, and a hostile
    // page could swap pxCaptureAll between the injection evaluate and the call evaluate.
    // Same rule as capture-remote's safeFileName ("the pulled name is REMOTE-CONTROLLED"):
    // only the artifacts this side is allowed to produce get written — never a path.
    const allowed = side === "live" ? ["live.json", "coverage.json", "dom.html"] : ["clone.json"];
    const written = [], refusedNames = [];
    for (const [file, body] of Object.entries(report.payloads)) {
      if (!allowed.includes(file)) { refusedNames.push(String(file).slice(0, 60)); continue; }
      const outPath = path.join(WORK, "targets", ctx.args.name, file);
      fs.writeFileSync(outPath, body);
      written.push({ file, bytes: Buffer.byteLength(body) });
    }
    if (refusedNames.length) console.log(`  ⚠ refused ${refusedNames.length} unexpected payload name(s) from the page (${refusedNames.map((n) => JSON.stringify(n)).join(", ")}) — only ${allowed.join(" / ")} are written on the ${side} side`);
    if (!written.length) throw new Error(`every payload name was refused (${refusedNames.join(", ")}) — the page is not running the kit's pxCaptureAll`);
    const settle = report.settle && typeof report.settle === "object" ? { stable: report.settle.stable, scrolledTo: report.settle.scrolledTo, imagesPending: report.settle.imagesPending } : report.settle;
    console.log(`  ✓ ${written.map((w) => `${w.file} (${(w.bytes / 1024).toFixed(0)}KB)`).join(", ")} — ${report.leaves} leaves, settle ${JSON.stringify(settle)}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // A wall is an ERROR, not a warning — the docs promise "fall back when capture-run's
    // error says so", and an agent that sees exit 0 builds a clone of the challenge page.
    // The artifacts stay on disk as evidence of the wall (they are data; the exit code is
    // the verdict), and the error itself is the ladder.
    const leafCollapse = side === "live" && ctx.cloneLeaves && report.leaves < ctx.cloneLeaves / 10;
    if (wallTitle || leafCollapse)
      throw new Error(`the live page looks like a bot-challenge wall (${wallTitle ? `title ${JSON.stringify(wallTitle)}` : `only ${report.leaves} leaves vs the clone's ${ctx.cloneLeaves}`}) — artifacts were written as EVIDENCE of the wall, not the site; do not capture-build from them. ${LADDER}`);

    return {
      side, url, leaves: report.leaves, byKind: report.byKind, settle,
      files: written, tookMs: Date.now() - t0, viewportRead: got,
      probe: { rafHz: probe.verdict.rafHz, anim: probe.sample.anim },
    };
  } finally {
    session.close();
    await cdp.closeTab(ctx.acq.port, targetId, { host: ctx.acq.host });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.name) die(`usage: ${VIA_PPK ? "pingfusi capture-run" : "node harness/capture-runner.js"} <name> [--side auto|both|live|clone] [--dry-run] …`);
  if (!["auto", "both", "live", "clone"].includes(args.side)) die(`--side must be auto|both|live|clone, got "${args.side}"`);

  const targetPath = path.join(WORK, "targets", args.name, "target.json");
  let target = {};
  if (fs.existsSync(targetPath)) target = JSON.parse(fs.readFileSync(targetPath, "utf8"));
  else if (!args.liveUrl && args.side !== "clone") die(`targets/${args.name}/target.json missing and no --live-url given — run: ${CMD === "pingfusi" ? "pingfusi" : CMD} new ${args.name} <url>`);
  const liveUrl = args.liveUrl || target.url;

  let liveSnap = null;
  try { liveSnap = JSON.parse(fs.readFileSync(path.join(WORK, "targets", args.name, "live.json"), "utf8")); } catch (e) {}
  const viewport = chrome.resolveViewport({ target, live: liveSnap });

  const cloneDir = path.join(WORK, "targets", args.name, "clone");
  const cloneExists = !!args.cloneUrl || fs.existsSync(path.join(cloneDir, "index.html"));
  // auto: live only until a clone exists — the natural pipeline order (capture live →
  // capture-build → capture clone) without making the agent think about sides.
  const side = args.side === "auto" ? (cloneExists ? "both" : "live") : args.side;
  const wantClone = side !== "live";
  if (wantClone && !cloneExists) die(`no targets/${args.name}/clone/index.html to capture — build it first (${CMD} capture-build ${args.name}) or pass --clone-url`);

  if (args.dryRun) {
    const bin = chrome.resolveChrome({ cliPath: args.chrome });
    console.log(`capture-run ${args.name} — dry run (pingfusi ${KIT_VERSION})`);
    console.log(`  sides: ${side}${args.side === "auto" ? ` (auto: clone ${cloneExists ? "exists" : "missing"})` : ""}${side !== "clone" ? `   live: ${liveUrl}` : ""}${wantClone ? `   clone: ${args.cloneUrl || `self-served from targets/${args.name}/clone`}` : ""}`);
    console.log(`  acquisition: ${args.attach || process.env.PPK_CDP_URL ? `attach to ${args.attach || process.env.PPK_CDP_URL}` : bin.error ? "LAUNCH — but " + bin.error : `launch ${bin.path}${args.headful ? " (headful — a window WILL appear)" : " (headless=new — invisible, probe-gated)"}${args.profile ? " with the persistent kit profile" : " with a temp profile"}`}`);
    console.log(`  viewport: ${viewport.width}×${viewport.height} @${viewport.dpr}x (width: ${viewport.sources.width}, height: ${viewport.sources.height}, dpr: ${viewport.sources.dpr})`);
    process.exit(!args.attach && bin.error ? 1 : 0);
  }

  const acq = await chrome.acquire({
    attach: args.attach, chromePath: args.chrome, headless: !args.headful,
    profileDir: args.profile ? path.join(require("os").homedir(), ".pingfusi", "chrome-profile") : null,
    width: viewport.width, height: 1050,
  }).catch((e) => die(`${e.message}\n  ${FALLBACK}`));
  console.log(`· pingfusi ${KIT_VERSION} capture-run — ${acq.mode} ${acq.chromeVersion}${acq.headless ? " (headless=new)" : ""}${acq.profile === "persistent" ? " (persistent profile)" : ""} on :${acq.port}, viewport ${viewport.width}×${viewport.height} @${viewport.dpr}x`);

  let cloneServer = null, cloneUrl = args.cloneUrl;
  if (wantClone && !cloneUrl) {
    cloneServer = serve(args.name, 0);
    await new Promise((r) => cloneServer.on("listening", r));
    cloneUrl = `http://127.0.0.1:${cloneServer.address().port}/`;
  }

  const captureSource = fs.readFileSync(path.join(__dirname, "..", "tools", "browser-capture.js"), "utf8");
  const ctx = { args, acq, viewport, captureSource };
  const teardown = async () => {
    if (cloneServer) cloneServer.close();
    if (!args.keepOpen) await acq.cleanup();
    else console.log(`· --keep-open: Chrome left running on :${acq.port} (${acq.mode})`);
  };
  process.on("SIGINT", () => { teardown().then(() => process.exit(130)); });

  try {
    const receipts = [];
    // clone first when capturing both — it always works (localhost, no wall) and its
    // leaf count gives the live side's wall heuristic a baseline.
    if (wantClone) { const c = await captureSide("clone", cloneUrl, ctx); ctx.cloneLeaves = c.leaves; receipts.push(c); }
    if (side !== "clone") receipts.push(await captureSide("live", liveUrl, ctx));

    // The run receipt: enough to answer "what measured this, at what size, which version"
    // without reopening a browser.
    const receiptPath = path.join(WORK, "targets", args.name, "capture-run.json");
    fs.writeFileSync(receiptPath, JSON.stringify({
      kitVersion: KIT_VERSION, at: new Date().toISOString(),
      mode: acq.mode, chromeVersion: acq.chromeVersion, headless: acq.headless, profile: acq.profile,
      viewport, sides: receipts,
    }, null, 2));
    console.log(`  ✓ capture-run.json (run receipt)`);
    console.log(`\n✓ capture done — next: ${side === "live" ? `${CMD} capture-build ${args.name}, then capture-run again for the clone side` : `${CMD} gate ${args.name} visual`}`);
  } catch (e) {
    const headfulHint = acq.mode === "cdp-launched" && acq.headless && /environment refused/.test(e.message)
      ? `\n  headless Chrome failed the measurement probe on this machine — re-run with --headful (one visible Chrome window for the duration; the only time this tool interrupts)` : "";
    // A wall or environment refusal must never dead-end: the interactive path is always there.
    const fallbackHint = /environment refused|did not finish loading|viewport did not normalize/.test(e.message) ? `\n  ${FALLBACK}` : "";
    console.error(`✗ ${e.message}${headfulHint}${fallbackHint}`);
    process.exitCode = 1;
  } finally {
    await teardown();
  }
}

if (require.main === module) main();
module.exports = { parseArgs, FALLBACK, LADDER };
