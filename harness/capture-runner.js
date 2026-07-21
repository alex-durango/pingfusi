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
//          [--live-url <url>] [--clone-url <url>] [--no-dom] [--no-motion]
//          [--nav-timeout <ms>] [--capture-timeout <ms>] [--keep-open] [--dry-run]
//
// --side auto (default): live only until targets/<name>/clone exists, then both.
// Artifacts land exactly where the interactive path puts them: targets/<name>/live.json,
// coverage.json, dom.html (live side), clone.json (clone side) — plus capture-run.json,
// the run receipt (kit version, viewport + sources, probe numbers, per-file byte counts).
//
// Motion (DEFAULT-ON, first-draft doctrine 2026-07-19): after the live capture succeeds,
// the injected source's animation readers (pxIntrospectAnimations / pxProbeGsap) are asked
// for their records, folded — together with any engine-fitted trace artifacts under
// targets/<name>/motion/*/trace/fits.json — into targets/<name>/motion-doc.json
// (harness/motion-doc.js, pingfusi/motion-doc@1), and animation bodies seen on the wire
// (Lottie JSON, .lottie zips, RIVE binaries) are ripped into targets/<name>/motion-assets/
// under sha-DERIVED names. Then the capture LOOKS for what no reader could explain: a
// dense-recorder sweep probes every scroll depth for elements still moving on their own
// (a hand-rolled rAF belt is invisible to introspection, and viewport-gated motion is
// invisible at y=0 — LEARNINGS #32), and any unexplained ongoing mover is SAMPLED under
// the stepped clock (harness/motion-sampler.js captureOnce, scroll-to trigger) so the
// draft build's motion pass can replay it. Every motion problem is a receipted WARNING on
// the run — never a capture failure (--no-motion switches the whole phase off).
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const cdp = require("./cdp.js");
const chrome = require("./chrome.js");
const motionDoc = require("./motion-doc.js");
const sampler = require("./motion-sampler.js");
const { serve } = require("./serve.js");

const VIA_PPK = process.env.PPK_ENTRY === "1";
const CMD = VIA_PPK ? "pingfusi" : "node harness/workflow.js";
const WORK = process.cwd();
const KIT_VERSION = require(path.join(__dirname, "..", "package.json")).version;
const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const firstLine = (e) => String((e && e.message) || e).split("\n")[0];

// The way out when THIS path can't see the real page — never a dead end (the whole
// point of shipping a second capture path is that either one can carry a run).
const FALLBACK = `fallback: the interactive in-browser capture still works — from your
  browser-automation tab, inject tools/browser-capture.js and run
  await pxCaptureAllPhased('<sink_url>')  (sink via: ${CMD === "pingfusi" ? "pingfusi" : CMD} capture open <name>)
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
    else if (v === "--no-motion") a.noMotion = true;
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

    // Motion setup must precede navigation so the asset rip sees every response the page
    // loads. A refusal here is a receipted warning — quarantine, never a capture failure.
    const motionWanted = side === "live" && !ctx.args.noMotion;
    const motionWarnings = [];
    let networkLog = null;
    if (motionWanted) {
      try { networkLog = watchNetwork(session); await session.send("Network.enable"); }
      catch (e) { networkLog = null; motionWarnings.push(`Network.enable refused — asset rip skipped: ${firstLine(e)}`); }
    }

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
    const shape = await cdp.evaluate(session, "typeof pxCaptureAllPhased", { awaitPromise: false });
    if (shape !== "function") throw new Error(`injection landed but pxCaptureAllPhased is ${shape} — tools/browser-capture.js changed shape?`);

    // Value mode: falsy sink → artifacts come back on report.payloads. The settle loop
    // (sweep, wait for height/images to hold still) runs entirely IN the page — the
    // ~20-round-trip "done yet?" polling of the interactive path becomes zero.
    //
    // PHASED (LEARNINGS #38): measurement must happen at a FIXED ANIMATION PHASE on both
    // sides — a never-settling animation lands at a load-time-dependent phase and a
    // CORRECT clone fails visual/strict with hundreds of constant-offset deltas
    // (mindmarket belts: 334–336 deltas, twice). So the one-call is settle → freeze
    // (pause every declared animation at progress 0 of its iteration; kit players freeze
    // themselves through their hook) → measure. Movers no pause can reach (rAF-driven —
    // the ongoing sweep's territory) ride in as known-unfreezable from earlier receipts,
    // and the snapshot's `freeze` field excludes marks inside their subtrees from the
    // pixel gates — receipted per mark, LISTED by the gates, never silently dropped.
    const knownUnfreezable = sweepUnfreezableSelectors(ctx.args.name);
    const report = await cdp.evaluate(session, `pxCaptureAllPhased(null, ${JSON.stringify({ prefix: side === "live" ? "live" : "clone", dom: side === "live" && !ctx.args.noDom, unfreezable: knownUnfreezable })})`, { timeoutMs: ctx.args.captureTimeout });
    if (!report || typeof report !== "object") throw new Error(`pxCaptureAllPhased returned ${JSON.stringify(report).slice(0, 120)} — not a report`);

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
    const settle = report.settle && typeof report.settle === "object" ? { stable: report.settle.stable, scrolledTo: report.settle.scrolledTo, imagesPending: report.settle.imagesPending, ...(report.settle.lazyPromoted ? { lazyPromoted: report.settle.lazyPromoted, lazyPromotedSrcs: report.settle.lazyPromotedSrcs } : {}) } : report.settle;
    console.log(`  ✓ ${written.map((w) => `${w.file} (${(w.bytes / 1024).toFixed(0)}KB)`).join(", ")} — ${report.leaves} leaves, settle ${JSON.stringify(settle)}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (report.freeze && typeof report.freeze === "object") {
      const fz = report.freeze;
      const unf = Array.isArray(fz.unfreezable) ? fz.unfreezable.length : 0;
      const excl = fz.excludedMarks && typeof fz.excludedMarks === "object" ? Object.keys(fz.excludedMarks).length : 0;
      console.log(`  · phase-freeze: ${fz.frozen} animation(s) paused at phase 0${fz.alreadyPaused ? `, ${fz.alreadyPaused} already paused (page-authored, left alone)` : ""}${unf ? `, ${unf} UNFREEZABLE mover(s) (rAF-driven) — ${excl} mark(s) in their subtrees excluded from pixel gates, receipted per mark` : ""}`);
    }

    // A wall is an ERROR, not a warning — the docs promise "fall back when capture-run's
    // error says so", and an agent that sees exit 0 builds a clone of the challenge page.
    // The artifacts stay on disk as evidence of the wall (they are data; the exit code is
    // the verdict), and the error itself is the ladder.
    const leafCollapse = side === "live" && ctx.cloneLeaves && report.leaves < ctx.cloneLeaves / 10;
    if (wallTitle || leafCollapse)
      throw new Error(`the live page looks like a bot-challenge wall (${wallTitle ? `title ${JSON.stringify(wallTitle)}` : `only ${report.leaves} leaves vs the clone's ${ctx.cloneLeaves}`}) — artifacts were written as EVIDENCE of the wall, not the site; do not capture-build from them. ${LADDER}`);

    // Paint probe + canvas dominance (LEARNINGS #37) — receipts and warnings, never
    // failures. The screenshot is the only witness that this side actually PAINTED:
    // both snapshots come from the same instrument, so a script-painted (canvas/WebGL)
    // page can measure identical on both sides while the clone renders a blank sheet.
    const paint = await capturePaint(session, ctx);
    if (paint.error) console.log(`  ⚠ paint: ${paint.error}`);
    else console.log(`  · paint: nonUniformRatio ${paint.stat.nonUniformRatio}${paint.stat.nearBlank ? " — NEAR-BLANK (this side paints almost nothing)" : ""}`);
    const canvas = side === "live" ? await captureCanvas(session) : null;
    if (canvas && canvas.dominant) console.log(`  ⚠ canvas-dominant: script-driven canvas covers ${Math.round((canvas.bestCoverage || 0) * 100)}% of the viewport with ${canvas.marksInFront} painted DOM mark(s) in front — a static DOM clone CANNOT reproduce this painting`);

    // Motion doc + asset rip — strictly AFTER this side's capture fully succeeded (a wall
    // or settle failure above never reaches this line), and unable to fail it:
    // captureMotion never throws, every problem lands in the warnings it receipts.
    const motion = motionWanted ? await captureMotion(session, ctx, { url, networkLog, warnings: motionWarnings }) : null;

    // PHASE-FREEZE, second half (LEARNINGS #38): the sweep just ran, so the ongoing
    // movers it found (the rAF belts no pause can reach) are now on disk — movers the
    // in-page freeze could not have known when live.json was measured moments ago.
    // Note them INTO live.json's freeze field (unfreezable + excluded marks) so the
    // pixel gates exclude their subtrees on this very run, not the next one. A failure
    // here is a receipted warning — the capture that succeeded stays succeeded.
    let freezePatch = null;
    if (motion && report.freeze && side === "live") {
      try { freezePatch = await noteSweepUnfreezables(session, ctx, report.freeze); }
      catch (e) { console.log(`  ⚠ phase-freeze: sweep-mover note failed (capture unaffected): ${firstLine(e)}`); }
    }

    return {
      side, url, leaves: report.leaves, byKind: report.byKind, settle,
      files: written, tookMs: Date.now() - t0, viewportRead: got,
      probe: { rafHz: probe.verdict.rafHz, anim: probe.sample.anim },
      paint,
      ...(canvas ? { canvas } : {}),
      ...(report.freeze ? { freeze: freezeReceipt(report.freeze) } : {}),
      ...(freezePatch ? { freezePatch } : {}),
      ...(motion ? { motion } : {}),
    };
  } finally {
    session.close();
    await cdp.closeTab(ctx.acq.port, targetId, { host: ctx.acq.host });
  }
}

// ── motion (additive, quarantine-scoped) ────────────────────────────────────────────────
// Everything below feeds targets/<name>/motion-doc.json + motion-assets/ AFTER a live
// capture already succeeded. Doctrine: a motion failure is a receipted WARNING on the run,
// never a capture failure — an ordinary clone must be able to ignore this entire phase.

const READER_TIMEOUT_MS = 15000;         // per-reader evaluate bound (Node-side watchdog in cdp.evaluate)
const BODY_TIMEOUT_MS = 5000;            // per-body Network.getResponseBody bound
const MAX_READER_RECORDS = 500;          // page-controlled arrays get a ceiling, receipted
const MAX_ASSETS = 20;                   // saved assets per run, receipted beyond
const MAX_ASSET_BYTES = 5 * 1024 * 1024; // per-asset size cap, receipted skips beyond
const MAX_SNIFF_FETCHES = 32;            // candidate bodies pulled for sniffing per run

// Passive response log for the asset rip. CdpSession has no persistent event subscription
// (waitFor is one-shot, and re-arming loses events that burst in one chunk), so wrap the
// socket's message hook: the original dispatch runs first, then Network events are parsed
// here. The includes() pre-filter keeps the multi-MB capture-result message from being
// JSON-parsed a second time.
function watchNetwork(session) {
  const responses = new Map(); // requestId → { url, mimeType, finished, encodedDataLength }
  const prev = session.ws.onMessage;
  session.ws.onMessage = (text) => {
    prev(text);
    if (!text.includes('"Network.responseReceived"') && !text.includes('"Network.loadingFinished"')) return;
    let msg; try { msg = JSON.parse(text); } catch (e) { return; }
    if (!msg.params || !msg.params.requestId) return;
    if (msg.method === "Network.responseReceived") {
      const r = msg.params.response || {};
      responses.set(String(msg.params.requestId), { url: String(r.url || ""), mimeType: String(r.mimeType || ""), finished: false, encodedDataLength: 0 });
    } else if (msg.method === "Network.loadingFinished") {
      const entry = responses.get(String(msg.params.requestId));
      if (entry) { entry.finished = true; entry.encodedDataLength = +msg.params.encodedDataLength || 0; }
    }
  };
  return responses;
}

// session.send has no timeout of its own; the anti-stall rule is every remote call gets one.
function withTimeout(promise, ms, what) {
  promise.catch(() => {}); // the losing branch must not become an unhandled rejection
  let timer;
  const watchdog = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms); });
  return Promise.race([promise, watchdog]).finally(() => clearTimeout(timer));
}

function urlExt(url) {
  try { const m = /\.([a-z0-9]{1,8})$/i.exec(new URL(url).pathname); return m ? m[1].toLowerCase() : ""; } catch (e) { return ""; }
}

// Cheap pre-filter for which responses are worth pulling a body for; sniffing decides truth.
function isAssetCandidate(ext, mimeType) {
  return ext === "json" || ext === "lottie" || ext === "riv" || /json|lottie|riv/i.test(mimeType || "");
}

// Content sniffing — the BYTES decide what a body is, never the remote name or mime alone:
// RIVE magic, zip magic under a .lottie hint (a dotLottie is a zip), or Lottie JSON
// ("v" + "layers"). Returns { kind, ext } with the FIXED extension the on-disk name carries.
function sniffAsset(bytes, ext, mimeType) {
  if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x56 && bytes[3] === 0x45) return { kind: "riv", ext: "riv" }; // "RIVE"
  const zipMagic = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04; // PK\x03\x04
  if (zipMagic && (ext === "lottie" || /lottie/i.test(mimeType || ""))) return { kind: "dotlottie", ext: "lottie" };
  if (bytes.length && /^\s*\{/.test(bytes.toString("utf8", 0, Math.min(bytes.length, 16)))) {
    try {
      const o = JSON.parse(bytes.toString("utf8"));
      if (o && typeof o === "object" && !Array.isArray(o) && o.v !== undefined && Array.isArray(o.layers)) return { kind: "lottie", ext: "json" };
    } catch (e) {}
  }
  return null;
}

// Pull candidate bodies, sniff, save the real animation assets. Caps are receipted, never
// silent: MAX_ASSETS saved per run, MAX_ASSET_BYTES each, MAX_SNIFF_FETCHES bodies inspected.
async function ripAssets(session, responses, targetDir, warnings) {
  const assets = [], seen = new Set();
  let fetched = 0, capSkipped = 0;
  for (const [requestId, r] of responses) {
    if (!r.finished) continue;
    const ext = urlExt(r.url);
    if (!isAssetCandidate(ext, r.mimeType)) continue;
    if (assets.length >= MAX_ASSETS) { capSkipped++; continue; }
    if (r.encodedDataLength > MAX_ASSET_BYTES) {
      warnings.push(`asset skipped (over the ${MAX_ASSET_BYTES / 1048576}MB cap): ${r.url.slice(0, 120)} — ${(r.encodedDataLength / 1048576).toFixed(1)}MB on the wire`);
      continue;
    }
    if (fetched >= MAX_SNIFF_FETCHES) { warnings.push(`asset sniffing stopped after ${MAX_SNIFF_FETCHES} candidate bodies — later candidates were not inspected`); break; }
    fetched++;
    let body;
    try { body = await withTimeout(session.send("Network.getResponseBody", { requestId }), BODY_TIMEOUT_MS, "Network.getResponseBody"); }
    catch (e) { continue; } // body evicted from Chrome's buffer, or slow — nothing rippable
    const bytes = Buffer.from(String((body && body.body) || ""), body && body.base64Encoded ? "base64" : "utf8");
    if (bytes.length > MAX_ASSET_BYTES) {
      warnings.push(`asset skipped (over the ${MAX_ASSET_BYTES / 1048576}MB cap): ${r.url.slice(0, 120)} — ${(bytes.length / 1048576).toFixed(1)}MB decoded`);
      continue;
    }
    const sniffed = sniffAsset(bytes, ext, r.mimeType);
    if (!sniffed) continue;
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (seen.has(sha256)) continue;
    seen.add(sha256);
    // The remote name is REMOTE-CONTROLLED (same rule as payload names, 296b59f): the
    // on-disk name is DERIVED — sha prefix + the fixed extension for the sniffed kind.
    // The real source URL lives in the doc's assets array, as data.
    const file = `motion-assets/${sha256.slice(0, 16)}.${sniffed.ext}`;
    fs.mkdirSync(path.join(targetDir, "motion-assets"), { recursive: true });
    fs.writeFileSync(path.join(targetDir, file), bytes);
    assets.push({ kind: sniffed.kind, url: r.url, sha256, bytes: bytes.length, file });
  }
  if (capSkipped) warnings.push(`asset cap reached (${MAX_ASSETS} saved) — ${capSkipped} further candidate(s) not ripped`);
  return assets;
}

// The readers return an envelope around the CONTRACT record shapes (motion-doc.js JSDoc).
// Unwrap it without binding to reader internals: a bare array also passes, "no engine on
// this page" is an empty result (not a warning), everything else unexpected is receipted.
function readerRecords(fn, ret, warnings) {
  if (ret == null) { warnings.push(`${fn} returned ${ret === null ? "null" : "undefined"} — reader missing from the injected capture source?`); return null; }
  if (Array.isArray(ret)) return ret;
  if (typeof ret === "object") {
    if (ret.supported === false) { warnings.push(`${fn}: document.getAnimations is not supported on this page`); return null; }
    if (ret.present === false) return []; // the engine is simply not on the page — nothing to record
    if (ret.unsupported) { warnings.push(`${fn}: engine version ${String(ret.unsupported).slice(0, 40)} is not supported — records not read`); return null; }
    if (Array.isArray(ret.records)) {
      if (ret.truncated) warnings.push(`${fn}: reader truncated its record list (total ${ret.total != null ? ret.total : ret.tweens})`);
      return ret.records;
    }
  }
  warnings.push(`${fn} returned ${typeof ret} without a records array — reader shape drift?`);
  return null;
}

const MOTION_READERS = [
  { fn: "pxIntrospectAnimations", convert: motionDoc.fromIntrospection },
  { fn: "pxProbeGsap", convert: motionDoc.fromGsap },
];

// ── the AUTO-SAMPLE stage: unexplained ongoing motion becomes sampled tracks ────────────
// The readers above only see DECLARED animation (CSS/WAAPI objects, GSAP timelines). A
// hand-rolled rAF loop writing inline styles declares nothing — and on real pages it is
// often viewport-gated (an IntersectionObserver pauses the belt offscreen; at y=0 it
// samples 0 px/s — LEARNINGS #32). So detection SWEEPS: at each scroll depth the in-page
// dense recorder (pxDenseRecordStart, body-wide) takes a few wall-time samples, and an
// element whose transform/opacity moved in EVERY interval — motion that never pauses,
// not a transition finishing — is an ongoing mover. Movers no reader explained are then
// sampled for real: one virtual-time capture per viewport group (the sampler's own
// captureOnce, scroll-to trigger anchored on the group's topmost mover), sampled tracks +
// tier-3 fits folded into the same doc the readers built. Warnings, never failures.
const DETECT_INTERVAL_MS = 350;  // per-interval wall dwell; 3 intervals ≈ 1s per depth
const DETECT_INTERVALS = 3;      // ALL intervals must move — a reveal transition settles out
const DETECT_MAX_DEPTHS = 24;    // sweep cap, receipted (24 × ~1s ≈ 25s worst case)
const AUTO_SAMPLE_MAX_RUNS = 3;  // sampled captures per capture-run, receipted beyond
const AUTO_SAMPLE_FPS = 60;      // the WAAPI replay is time-based; 60fps is the record's grid
const AUTO_SAMPLE_FRAMES = 240;  // 4s virtual — long enough for the marquee class to win

function detectProbeExpr(scrollY) {
  return `(async () => {
    if (typeof pxDenseRecordStart !== "function") return { unsupported: true };
    window.scrollTo({ top: ${scrollY}, left: 0, behavior: "instant" });
    await new Promise((r) => requestAnimationFrame(() => r()));
    pxDenseRecordStart({ scopes: ["body"], props: ["transform", "opacity"] });
    pxDenseRecordStep(0);
    for (let i = 1; i <= ${DETECT_INTERVALS}; i++) {
      await new Promise((r) => setTimeout(r, ${DETECT_INTERVAL_MS}));
      pxDenseRecordStep(i * ${DETECT_INTERVAL_MS});
    }
    return { record: pxDenseRecordStop() };
  })()`;
}

// Pure classifier over one depth's probe record: a mover is an element whose transform or
// opacity moved in EVERY interval (sampler.sampledValueDelta > 1 — the same noise floors
// the ongoing gate uses). Elements a reader already explained (covered selectors) are the
// readers' business, not this stage's.
function moversFromDetectRecord(record, coveredSelectors) {
  const movers = [];
  for (const el of (record && record.elements) || []) {
    if (!el || typeof el.selector !== "string" || !el.selector.trim()) continue;
    if (!Array.isArray(el.samples) || el.samples.length < DETECT_INTERVALS + 1) continue;
    if (coveredSelectors.has(el.selector)) continue;
    for (const property of ["transform", "opacity"]) {
      const values = el.samples.map((s) => (s && s.values ? s.values[property] : null));
      let moving = true;
      for (let i = 1; i < values.length; i++) {
        if (!(sampler.sampledValueDelta(property, values[i - 1], values[i]) > 1)) { moving = false; break; }
      }
      if (moving) { movers.push({ selector: el.selector, property }); break; }
    }
  }
  return movers;
}

async function detectOngoingMotion(session, ctx, coveredSelectors, warnings) {
  const scrollMax = await cdp.evaluate(session, "Math.max((document.documentElement.scrollHeight || 0) - innerHeight, 0)", { awaitPromise: false, timeoutMs: READER_TIMEOUT_MS });
  if (typeof scrollMax !== "number" || !isFinite(scrollMax)) return { movers: [], note: "scroll extent unreadable — ongoing-motion detection skipped" };
  const step = Math.max(200, Math.floor(ctx.viewport.height * 0.8));
  const depths = [];
  for (let y = 0; y <= scrollMax && depths.length < DETECT_MAX_DEPTHS; y += step) depths.push(y);
  const truncatedSweep = scrollMax > (depths[depths.length - 1] || 0) + step;
  const movers = new Map(); // selector → { selector, property, depth } (first depth seen wins)
  let truncatedRecord = false;
  for (const y of depths) {
    const ret = await cdp.evaluate(session, detectProbeExpr(y), { timeoutMs: READER_TIMEOUT_MS + (DETECT_INTERVALS + 2) * DETECT_INTERVAL_MS });
    if (!ret || typeof ret !== "object" || ret.unsupported || !ret.record || !Array.isArray(ret.record.elements)) {
      return { movers: [], note: "in-page dense recorder unavailable on this page — ongoing-motion detection skipped" };
    }
    if (ret.record.truncated && !truncatedRecord) {
      truncatedRecord = true;
      warnings.push(`ongoing-motion detect hit the recorder's 200-element cap at depth ${y}px — movers past the cap were not probed`);
    }
    for (const mover of moversFromDetectRecord(ret.record, coveredSelectors)) {
      if (!movers.has(mover.selector)) movers.set(mover.selector, { ...mover, depth: y });
    }
  }
  return { movers: [...movers.values()], depthsProbed: depths.length, ...(truncatedSweep ? { truncatedSweep } : {}) };
}

// Group movers into viewports: sorted by document top, a group spans at most 0.8×viewport
// from its topmost member (every member provably in view when the topmost sits at the
// viewport's top edge — the scroll-to trigger's anchor).
function groupMoversByViewport(movers, tops, viewportHeight) {
  const positioned = movers
    .map((m) => ({ ...m, top: typeof tops[m.selector] === "number" ? tops[m.selector] : null }))
    .filter((m) => m.top !== null)
    .sort((a, b) => a.top - b.top);
  const dropped = movers.length - positioned.length;
  const groups = [];
  for (const mover of positioned) {
    const group = groups[groups.length - 1];
    if (group && mover.top - group.anchorTop <= viewportHeight * 0.8) group.movers.push(mover);
    else groups.push({ anchorTop: mover.top, anchor: mover.selector, movers: [mover] });
  }
  return { groups, dropped };
}

// One sampled capture per group, the sampler's own core (never a duplicate implementation).
// Returns the per-run receipt entry; merged tracks land in `doc` (addTrack-deduped).
async function autoSampleGroup(ctx, url, group, doc, warnings) {
  const scopes = [...new Set(group.movers.map((m) => m.selector))];
  const trigger = group.anchorTop > 0 ? `scroll-to:${group.anchor}` : "load";
  const sctx = {
    args: { fps: AUTO_SAMPLE_FPS, frames: AUTO_SAMPLE_FRAMES, navTimeout: Math.max(ctx.args.navTimeout, 60000), headful: !!ctx.args.headful },
    acq: ctx.acq, viewport: ctx.viewport, url,
    trigger: sampler.parseTrigger(trigger), scopes,
    stepMs: 1000 / AUTO_SAMPLE_FPS, props: sampler.DENSE_PROPS,
    captureSource: ctx.captureSource,
  };
  const run = await sampler.captureOnce(sctx);
  const sampledDoc = motionDoc.fromSampled(run.record, { url, viewport: ctx.viewport, fps: AUTO_SAMPLE_FPS });
  const sampling = sampledDoc.sampling;
  sampling.ongoing = sampler.markOngoing(sampledDoc);
  const lift = sampler.liftTier3Fits(sampledDoc, run.record);
  for (const line of lift.log) console.log(`    ${line}`);
  const sampledTrackIds = [];
  for (const track of sampledDoc.tracks) {
    const canonical = motionDoc.addTrack(doc, track);
    // Additive, except the tie-break: a marquee on an ongoing track beats a finite fit
    // (ongoing beats finite when ongoing:true — same rule as the sampler CLI).
    const marqueeWins = track.fit && track.fit.kind === "marquee" && track.ongoing === true &&
      canonical.fit && canonical.fit.kind !== "marquee";
    if (track.fit && (!canonical.fit || marqueeWins)) canonical.fit = track.fit;
    if (track.ongoing === true && canonical.ongoing !== true) canonical.ongoing = true;
    sampledTrackIds.push(canonical.id);
  }
  console.log(`    ✓ sampled ${run.record.frames} frame(s) (${run.vtReceipt.mode}) — ${sampledTrackIds.length} track(s) merged, ${sampling.ongoing} ongoing${lift.receipt.reclassified.length ? `, ${lift.receipt.reclassified.length} re-classified marquee` : ""}`);
  if (run.record.truncated) warnings.push(`auto-sample ${trigger}: the recorder hit a cap (200 elements / 2000 frames / 5000 writes) — the record is explicitly truncated`);
  return {
    trigger, scopes, fps: AUTO_SAMPLE_FPS, frames: run.record.frames, stepMs: sctx.stepMs,
    virtualTime: run.vtReceipt, settle: run.settle,
    recorder: { tracking: run.startInfo.tracking, truncated: !!run.record.truncated, writes: (run.record.writes || []).length },
    sampling, determinism: { runs: 1 }, fit: lift.receipt, sampledTrackIds,
  };
}

async function autoSampleOngoing(session, ctx, doc, warnings) {
  const covered = new Set(doc.tracks.map((t) => t.target && t.target.selector).filter(Boolean));
  const detect = await detectOngoingMotion(session, ctx, covered, warnings);
  if (detect.note) { console.log(`  · ongoing-motion detect: ${detect.note}`); return { note: detect.note }; }
  if (!detect.movers.length) {
    console.log(`  · no unexplained ongoing motion (${detect.depthsProbed} scroll depth(s) probed)`);
    return { detected: 0, depthsProbed: detect.depthsProbed };
  }
  if (detect.truncatedSweep) warnings.push(`ongoing-motion sweep stopped at ${DETECT_MAX_DEPTHS} depth(s) — deeper page regions were not probed`);
  const selectors = detect.movers.map((m) => m.selector);
  const tops = await cdp.evaluate(session, `(() => { const out = {}; for (const sel of ${JSON.stringify(selectors)}) { try { const el = document.querySelector(sel); if (el) out[sel] = Math.round(el.getBoundingClientRect().top + (window.scrollY || 0)); } catch (e) {} } return out; })()`, { awaitPromise: false, timeoutMs: READER_TIMEOUT_MS }) || {};
  const { groups, dropped } = groupMoversByViewport(detect.movers, tops, ctx.viewport.height);
  if (dropped) warnings.push(`${dropped} ongoing mover(s) vanished between detect and position read — not sampled`);
  console.log(`  · ongoing motion no reader explains: ${detect.movers.length} element(s) in ${groups.length} viewport group(s) — sampling under the stepped clock (this adds minutes, receipted)`);
  const runs = [];
  const summary = { detected: detect.movers.length, depthsProbed: detect.depthsProbed, groups: groups.length, runs };
  for (const group of groups.slice(0, AUTO_SAMPLE_MAX_RUNS)) {
    try { runs.push(await autoSampleGroup(ctx, doc.url, group, doc, warnings)); }
    catch (e) { warnings.push(`auto-sample of ${group.movers.length} mover(s) at ~${group.anchorTop}px failed (capture unaffected): ${firstLine(e)}`); }
  }
  if (groups.length > AUTO_SAMPLE_MAX_RUNS) warnings.push(`auto-sample capped at ${AUTO_SAMPLE_MAX_RUNS} run(s) — ${groups.length - AUTO_SAMPLE_MAX_RUNS} viewport group(s) not sampled this run`);
  const receiptFile = path.join(WORK, "targets", ctx.args.name, "motion", "auto-sample.json");
  fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
  fs.writeFileSync(receiptFile, JSON.stringify({
    schema: "pingfusi/motion-sample@1", at: new Date().toISOString(),
    target: ctx.args.name, item: "auto (capture-run)", url: doc.url, viewport: ctx.viewport,
    detected: detect.movers, depthsProbed: detect.depthsProbed, runs,
  }, null, 2) + "\n");
  summary.receipt = `targets/${ctx.args.name}/motion/auto-sample.json`;
  summary.tracks = runs.reduce((n, r) => n + r.sampledTrackIds.length, 0);
  return summary;
}

// The whole motion phase. NEVER throws: any failure lands in `warnings` (receipted on the
// side's entry in capture-run.json and printed), and the capture that already succeeded
// stays succeeded. The doc itself is BUILT node-side from evaluated returns — page-supplied
// strings only ever become JSON data, never filenames.
async function captureMotion(session, ctx, { url, networkLog, warnings }) {
  const summary = { warnings };
  try {
    const meta = { url, viewport: ctx.viewport };
    const doc = motionDoc.emptyDoc(meta);

    for (const reader of MOTION_READERS) {
      let ret;
      try { ret = await cdp.evaluate(session, `${reader.fn}()`, { timeoutMs: READER_TIMEOUT_MS }); }
      catch (e) { warnings.push(`${reader.fn} failed (capture unaffected): ${firstLine(e)}`); continue; }
      let records = readerRecords(reader.fn, ret, warnings);
      if (!records) continue;
      if (records.length > MAX_READER_RECORDS) {
        warnings.push(`${reader.fn}: ${records.length} records capped at ${MAX_READER_RECORDS}`);
        records = records.slice(0, MAX_READER_RECORDS);
      }
      // Records are page-derived data: converted one at a time so a single malformed
      // record costs itself, not the whole source — refusals are receipted, never fatal.
      let refused = 0, lastReason = "";
      for (const record of records) {
        try { for (const track of reader.convert([record], meta).tracks) motionDoc.addTrack(doc, track); }
        catch (e) { refused++; lastReason = firstLine(e); }
      }
      if (refused) warnings.push(`${reader.fn}: ${refused}/${records.length} record(s) refused — last: ${lastReason}`);
    }

    // Engine-fitted traces, when a motion run already produced them: folded in as "fitted".
    const motionRoot = path.join(WORK, "targets", ctx.args.name, "motion");
    if (fs.existsSync(motionRoot)) {
      for (const entry of fs.readdirSync(motionRoot).sort()) {
        const fitsPath = path.join(motionRoot, entry, "trace", "fits.json");
        if (!fs.existsSync(fitsPath)) continue;
        try {
          for (const track of motionDoc.fromEngineFit(JSON.parse(fs.readFileSync(fitsPath, "utf8")), meta).tracks) motionDoc.addTrack(doc, track);
        } catch (e) { warnings.push(`engine-fit motion/${entry}/trace/fits.json refused: ${firstLine(e)}`); }
      }
    }

    if (networkLog) doc.assets.push(...await ripAssets(session, networkLog, path.join(WORK, "targets", ctx.args.name), warnings));

    // Unexplained ongoing motion → sampled tracks, in the same doc (its own try: a
    // sampling failure costs the sampled tier, never the readers' tracks or the assets).
    try { summary.sampled = await autoSampleOngoing(session, ctx, doc, warnings); }
    catch (e) { warnings.push(`ongoing-motion auto-sample failed (capture unaffected): ${firstLine(e)}`); }

    motionDoc.validateMotionDoc(doc); // belt over braces: converters + addTrack pre-validate
    fs.writeFileSync(path.join(WORK, "targets", ctx.args.name, "motion-doc.json"), JSON.stringify(doc, null, 2));
    summary.file = "motion-doc.json";
    summary.tracks = doc.tracks.length;
    summary.assets = doc.assets.length;
    console.log(`  ✓ motion-doc.json (${doc.tracks.length} track(s), ${doc.assets.length} asset(s))`);
  } catch (e) {
    warnings.push(`motion capture failed — motion-doc.json not written: ${firstLine(e)}`);
  }
  for (const w of warnings) console.log(`  ⚠ motion: ${w}`);
  return summary;
}

// ── phase-freeze (PHASE POISON — LEARNINGS #38) ──────────────────────────────────────────
// The in-page halves live in tools/browser-capture.js (pxFreezeAnimations /
// pxMarksInSubtrees / pxCaptureAllPhased); these node-side halves feed them what the kit
// already knows and write back what the sweep learns.

// The ongoing sampler already knows the movers no declared-animation pause can reach:
// sampled-ongoing tracks in motion-doc.json, plus the sweep's detect list in
// motion/auto-sample.json (a mover that vanished before sampling was still a mover).
// Read fresh from disk each side — the live side's sweep writes them for the clone side
// of the SAME run. Absent files mean an empty list, never an error.
function sweepUnfreezableSelectors(name) {
  const dir = path.join(WORK, "targets", name);
  const out = new Set();
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, "motion-doc.json"), "utf8"));
    for (const track of doc.tracks || []) {
      if (track && track.ongoing === true && track.provenance && track.provenance.tier === "sampled" &&
          track.target && typeof track.target.selector === "string" && track.target.selector) out.add(track.target.selector);
    }
  } catch (e) {}
  try {
    const auto = JSON.parse(fs.readFileSync(path.join(dir, "motion", "auto-sample.json"), "utf8"));
    for (const m of auto.detected || []) if (m && typeof m.selector === "string" && m.selector) out.add(m.selector);
  } catch (e) {}
  return [...out].sort();
}

// The freeze receipt for capture-run.json: everything except the per-mark map (that
// lives in the snapshot itself, where the diff reads it) — the receipt records its size.
function freezeReceipt(freeze) {
  const { excludedMarks, ...rest } = freeze;
  return { ...rest, excludedMarkCount: excludedMarks && typeof excludedMarks === "object" ? Object.keys(excludedMarks).length : 0 };
}

// After the motion phase: fold the sweep's ongoing movers into live.json's freeze field.
// The marks map is re-derived IN the page (pxMarksInSubtrees — enumeration is
// deterministic on the frozen DOM, so the names match the snapshot's), and the page's
// answer is treated as REMOTE-CONTROLLED data: only entries whose value is a selector
// this side actually sent become exclusions.
async function noteSweepUnfreezables(session, ctx, freeze) {
  const known = new Set(Array.isArray(freeze.unfreezable) ? freeze.unfreezable : []);
  const fresh = sweepUnfreezableSelectors(ctx.args.name).filter((s) => !known.has(s));
  if (!fresh.length) return null;
  const raw = await cdp.evaluate(session, `pxMarksInSubtrees(${JSON.stringify(fresh)})`, { awaitPromise: false, timeoutMs: READER_TIMEOUT_MS });
  const marks = {};
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(raw)) {
      if (fresh.includes(raw[key])) marks[String(key).slice(0, 80)] = raw[key];
    }
  }
  const livePath = path.join(WORK, "targets", ctx.args.name, "live.json");
  const snap = JSON.parse(fs.readFileSync(livePath, "utf8"));
  const fz = snap.freeze && typeof snap.freeze === "object" ? snap.freeze
    : (snap.freeze = { frozen: 0, ids: [], players: [], alreadyPaused: 0, skipped: {}, unfreezable: [], excludedMarks: {} });
  fz.unfreezable = [...new Set([...(Array.isArray(fz.unfreezable) ? fz.unfreezable : []), ...fresh])];
  fz.excludedMarks = Object.assign({}, fz.excludedMarks, marks);
  fs.writeFileSync(livePath, JSON.stringify(snap));
  freeze.unfreezable = fz.unfreezable; // mirror into this run's receipt
  console.log(`  · phase-freeze: ${fresh.length} sweep-detected ongoing mover(s) noted as unfreezable in live.json — ${Object.keys(marks).length} mark(s) in their subtrees excluded from pixel gates (the gates LIST each one)`);
  return { selectors: fresh, marks: Object.keys(marks).length };
}

// ── the paint probe (BLACK-PAGE GREEN — LEARNINGS #37) ──────────────────────────────────
// live.json and clone.json are BOTH produced by tools/browser-capture.js, so a property the
// capture cannot see is a property the two sides AGREE about — and a page that paints its
// pixels in script-driven canvas/WebGL is invisible to DOM measurement end to end: bizar.ro
// passed visual 1236/1236 while the published draft rendered SOLID BLACK. Pixels are the
// only witness that painting happened. After each side's capture the runner takes ONE
// Page.captureScreenshot (the CDP session is already open) and computes a cheap paint
// statistic from the PNG bytes themselves — a dependency-honest scanline reader (zlib is a
// Node built-in; no image library enters the core kit). The stat is receipted per side in
// capture-run.json; a near-uniform clone under a rich live page becomes a WARNING on the
// run (first-draft doctrine: receipts + warnings, never a capture failure) — and that
// receipt is what `review file` refuses on, so a blank draft never burns a reviewer round.
const PAINT_TIMEOUT_MS = 20000;             // screenshot + decode bound (anti-stall: no silent stall)
const PAINT_MAX_DECODED = 64 * 1024 * 1024; // inflate ceiling — a 2880×1964 RGBA frame is ~23MB
const PAINT_GRID = 400;                     // sample ≤ ~PAINT_GRID² pixels on an even grid
// The documented floors. nonUniformRatio = share of sampled pixels OUTSIDE the dominant
// 4-bit-quantized RGB tone. Under NEAR_BLANK the side "paints almost nothing" (solid
// black/white with at most compression noise); at or above RICH the side visibly paints.
// The verdict fires only on the PAIRING (clone near-blank while live rich): a genuinely
// minimal live page keeps a minimal clone honest — no false alarm on sparse-but-correct.
const PAINT_NEAR_BLANK_RATIO = 0.02;
const PAINT_RICH_RATIO = 0.05;

// Decode a PNG (Chrome's own screenshots: 8-bit, RGB/RGBA, non-interlaced) scanline by
// scanline and return the paint statistic. Throws on anything else — the caller receipts
// the refusal as a note, never a failure. CRCs are not verified: the bytes come from the
// kit's own Chrome over CDP, and the stat is advisory.
function paintStatFromPng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a)
    throw new Error("not a PNG");
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  for (let off = 8; off + 12 <= buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (type === "IHDR") { width = buf.readUInt32BE(off + 8); height = buf.readUInt32BE(off + 12); bitDepth = buf[off + 16]; colorType = buf[off + 17]; interlace = buf[off + 20]; }
    else if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (!width || !height) throw new Error("PNG carries no IHDR");
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0)
    throw new Error(`unsupported PNG shape (bit depth ${bitDepth}, color type ${colorType}, interlace ${interlace}) — the probe reads Chrome's own 8-bit RGB(A) non-interlaced screenshots`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = require("zlib").inflateSync(Buffer.concat(idat), { maxOutputLength: PAINT_MAX_DECODED });
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new Error(`PNG pixel data truncated (${raw.length} bytes for ${width}×${height})`);
  // Unfilter row by row (PNG filters 0–4; each row's predictors need only the previous
  // decoded row), sampling an even grid as rows decode — memory stays at two scanlines.
  const stepX = Math.max(1, Math.floor(width / PAINT_GRID));
  const stepY = Math.max(1, Math.floor(height / PAINT_GRID));
  const hist = new Uint32Array(4096); // 4-bit-per-channel RGB buckets
  let sampled = 0, lumaSum = 0, lumaSq = 0;
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const rowOff = y * (stride + 1);
    const filter = raw[rowOff];
    raw.copy(cur, 0, rowOff + 1, rowOff + 1 + stride);
    if (filter === 1) { for (let i = bpp; i < stride; i++) cur[i] = (cur[i] + cur[i - bpp]) & 255; }
    else if (filter === 2) { for (let i = 0; i < stride; i++) cur[i] = (cur[i] + prev[i]) & 255; }
    else if (filter === 3) { for (let i = 0; i < stride; i++) cur[i] = (cur[i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1)) & 255; }
    else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    } else if (filter !== 0) throw new Error(`PNG filter type ${filter} is not in the spec`);
    cur.copy(prev, 0);
    if (y % stepY) continue;
    for (let x = 0; x < width; x += stepX) {
      const i = x * bpp;
      const r = cur[i], g = cur[i + 1], b = cur[i + 2];
      hist[((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)]++;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumaSum += luma; lumaSq += luma * luma;
      sampled++;
    }
  }
  let dominant = 0;
  for (let i = 0; i < hist.length; i++) if (hist[i] > dominant) dominant = hist[i];
  const nonUniformRatio = +(sampled ? 1 - dominant / sampled : 0).toFixed(4);
  const lumaMean = sampled ? lumaSum / sampled : 0;
  const lumaVariance = sampled ? Math.max(0, lumaSq / sampled - lumaMean * lumaMean) : 0;
  return {
    width, height, sampled, nonUniformRatio,
    lumaMean: +lumaMean.toFixed(1), lumaStdev: +Math.sqrt(lumaVariance).toFixed(1),
    nearBlank: nonUniformRatio < PAINT_NEAR_BLANK_RATIO,
  };
}

// Pure verdict over the two sides' paint stats (exported; fixtured). Null = no warning.
function paintVerdict(liveStat, cloneStat, liveCanvas) {
  if (!liveStat || !cloneStat) return null; // a probe that could not run proves nothing
  if (!(cloneStat.nonUniformRatio < PAINT_NEAR_BLANK_RATIO)) return null;
  if (!(liveStat.nonUniformRatio >= PAINT_RICH_RATIO)) return null;
  const canvasNote = liveCanvas && liveCanvas.dominant
    ? ` The live page's visible painting is script-driven canvas (${Math.round((liveCanvas.bestCoverage || 0) * 100)}% of the viewport, ${liveCanvas.marksInFront} painted DOM mark(s) in front) — a static DOM clone CANNOT reproduce it.`
    : "";
  return `the clone paints almost nothing (nonUniformRatio ${cloneStat.nonUniformRatio} vs live ${liveStat.nonUniformRatio}) — the DOM skeleton can match while the pixels never arrive; do not file a review round on this draft.${canvasNote}`;
}

// One screenshot for this side, decoded to a paint stat. NEVER throws: a paint problem is
// a receipted note ({ error }) on the side, and the capture that already succeeded stays
// succeeded.
async function capturePaint(session, ctx) {
  try {
    // The reviewer's first paint is the top of the page — measure from there, not from
    // wherever the settle sweep parked the scroll.
    await cdp.evaluate(session, "window.scrollTo(0, 0)", { awaitPromise: false, timeoutMs: PAINT_TIMEOUT_MS }).catch(() => {});
    const shot = await withTimeout(session.send("Page.captureScreenshot", { format: "png" }), Math.min(PAINT_TIMEOUT_MS, ctx.args.captureTimeout), "Page.captureScreenshot");
    if (!shot || !shot.data) throw new Error("Page.captureScreenshot returned no data");
    return { stat: paintStatFromPng(Buffer.from(String(shot.data), "base64")) };
  } catch (e) {
    return { error: `paint probe unavailable: ${firstLine(e)}` };
  }
}

// The live-side capability statement: is this site's visible painting a script-driven
// canvas? Read via the injected pxCanvasDominant (tools/browser-capture.js). An old
// injected source or an in-page refusal is a receipted null, never a failure.
async function captureCanvas(session) {
  try {
    const ret = await cdp.evaluate(session, 'typeof pxCanvasDominant === "function" ? pxCanvasDominant() : { unsupported: true }', { awaitPromise: false, timeoutMs: PAINT_TIMEOUT_MS });
    return ret && typeof ret === "object" && !ret.unsupported ? ret : null;
  } catch (e) { return null; }
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
    // The paint verdict compares the two sides. A clone-only re-run still deserves the
    // warning: fall back to the PREVIOUS receipt's live side (clearly labeled — a stale
    // live measurement is context, not this run's evidence).
    let prevLive = null;
    try { prevLive = (JSON.parse(fs.readFileSync(receiptPath, "utf8")).sides || []).find((s) => s && s.side === "live"); } catch (e) {}
    const liveR = receipts.find((r) => r.side === "live") || prevLive;
    const cloneR = receipts.find((r) => r.side === "clone");
    const usedPrevLive = liveR === prevLive && !!prevLive && !receipts.some((r) => r.side === "live");
    let paintWarning = paintVerdict(liveR && liveR.paint && liveR.paint.stat, cloneR && cloneR.paint && cloneR.paint.stat, liveR && liveR.canvas);
    if (paintWarning && usedPrevLive) paintWarning += " (live side measured on a previous run)";
    fs.writeFileSync(receiptPath, JSON.stringify({
      kitVersion: KIT_VERSION, at: new Date().toISOString(),
      mode: acq.mode, chromeVersion: acq.chromeVersion, headless: acq.headless, profile: acq.profile,
      viewport, sides: receipts,
      ...(paintWarning ? { paint: { warning: paintWarning } } : {}),
    }, null, 2));
    if (paintWarning) console.log(`  ⚠ paint: ${paintWarning}`);
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
module.exports = { parseArgs, FALLBACK, LADDER, moversFromDetectRecord, groupMoversByViewport, paintStatFromPng, paintVerdict, PAINT_NEAR_BLANK_RATIO, PAINT_RICH_RATIO, sweepUnfreezableSelectors, freezeReceipt };
