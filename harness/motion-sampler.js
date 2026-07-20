#!/usr/bin/env node
// motion-sampler.js — `pingfusi motion sample <name> <motion-id>`: the SAMPLED tier's
// virtual-time runner.
//
// The capture ladder's last honest rung: when a page declares nothing an introspection
// reader can see (no CSS/WAAPI declaration, no GSAP timeline) but pixels still move — a
// hand-rolled rAF loop writing inline styles — the only record that is not a guess is a
// SAMPLED one: computed values read at uniform VIRTUAL-time steps. The clock belongs to
// this runner, never to the page: virtual time is enabled BEFORE navigation, advanced one
// step budget at a time, and the in-page recorder (tools/browser-capture.js
// pxDenseRecord*) only READS at the moments it is told about. Determinism is the whole
// point — two runs must produce identical samples; --verify-determinism runs the entire
// capture twice and diffs, receipted.
//
// Clock modes (feature-detected, receipted — never silent):
//   "virtual-time"  Emulation.setVirtualTimePolicy("pause") before navigation, a bounded
//                   pauseIfNetworkFetchesPending budget to carry the load, then one
//                   {policy:"advance", budget:stepMs} + virtualTimeBudgetExpired wait per
//                   frame ("+begin-frame" when HeadlessExperimental.beginFrame answers).
//   "hooked-clock"  fallback when the target refuses virtual time: performance.now /
//                   Date.now / rAF hooked to a stepped clock via
//                   Page.addScriptToEvaluateOnNewDocument. Script-driven motion follows
//                   this clock; compositor-driven CSS animation does not — the receipt
//                   names the mode so consumers can weigh the record.
//
// Frame-rate honesty: a site animating px-per-rAF-frame is recorded exactly as it behaves
// at the DECLARED fps, and the fps rides in every track's provenance.source
// ("virtual-time@<fps>fps"). The WAAPI replay downstream is time-based, which NORMALIZES
// the site's frame-rate dependence — receipted in the doc, never hidden.
//
// Quarantine: only a DECLARED item may be sampled (isDeclaredItem) — sweep candidates
// stay advisory, and nothing here runs on an ordinary clone. Receipts for every
// intervention: targets/<name>/motion/<id>/sample.json (mode, counts, determinism, fit
// lift) plus a workflow.jsonl entry. Item status becomes "sampled" (NON-terminal): the
// apply/verify halves — `motion apply-sampled`, `motion verify-sampled` — own the walk to
// the terminal "verified-sampled".
//
// LIFT (fit demoted to editability): when the engine's tier-3 fitters resolve
// (packages/motion/src/tier3/fit.js), each sampled numeric series is offered to them over
// a small ESM bridge; a winning fit (nrmse <= 0.1) rides on the track as `track.fit` so a
// consumer can EDIT the motion, while the sampled keyframes stay the authoritative
// record. Fitter absence or failure is a receipted skip, never an error.
//
// usage: pingfusi motion sample <name> <motion-id> [--fps 60] [--frames 240]
//          [--verify-determinism] [--attach <port|host:port>] [--chrome <path>]
//          [--headful] [--nav-timeout <ms>]
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");
const cdp = require("./cdp.js");
const chrome = require("./chrome.js");
const motionDoc = require("./motion-doc.js");
const { isDeclaredItem, readMotionDoc, readMotionItems, updateMotionItem } = require("./motion-items.js");

const WORK = process.cwd();
const PKG = path.resolve(__dirname, "..");
const VIA_PPK = process.env.PPK_ENTRY === "1";
const CMD = VIA_PPK ? "pingfusi" : "node harness/workflow.js";
const KIT_VERSION = require(path.join(PKG, "package.json")).version;

const NAV_TIMEOUT_MS = 30000;
const STEP_TIMEOUT_MS = 10000;   // per virtual-time advance / per-step evaluate — anti-stall
const SETTLE_TIMEOUT_MS = 30000; // per settle/dwell advance — may wait wall-time for a cold fetch to land
// Wall milliseconds to HOLD, clock paused, once document.readyState reaches "complete".
// Page tasks freeze while virtual time is paused, so every wall-side completion the
// virtual clock cannot see — image DECODE threads, browser-side stragglers like the
// favicon — queues during the hold, and the whole backlog then executes inside the FIRST
// post-load advance, at the same virtual instant on every run. Without it the backlog
// lands at wall-dependent virtual instants (seen live: the rails' init task slid ~150-370
// virtual ms between two otherwise-identical runs, skewing every later sample).
// Env-overridable for selftests against a fake Chrome (no wall races to absorb there);
// whatever value actually ran rides in the receipt.
const WALL_BARRIER_MS = envMs("PPK_MOTION_BARRIER_MS", 3000);
// Wall milliseconds to HOLD, clock paused, after EVERY settle advance (the freeze-step).
// A clock-invisible completion whose cause ran at chunk boundary k lands inside this wide
// uniform freeze window and executes at boundary k+1 — on every run. Without it, such
// completions bucket into the ~1ms cracks between CDP roundtrips, i.e. at wall-random
// virtual instants (seen live: the rails' decode-gated init ran MID-LOAD at instants that
// differed by whole belt-recycle steps between two runs). Fetches never need this — the
// network-pausing budgets pin them exactly; the freeze quantizes what the pending-fetch
// counter cannot see (decode threads, compositor round-trips, browser-side tasks). Wider
// windows shrink the residual edge-crossing risk (an event whose wall latency lands
// within its own jitter of a window boundary can still bucket one chunk apart between
// runs — seen live as a single belt-tick 0.35px offset); the determinism gate remains the
// final authority on whether a record stands.
const FREEZE_MS = envMs("PPK_MOTION_FREEZE_MS", 250);
// Fixed virtual frames granted AFTER the wall barrier and BEFORE the trigger: the frozen
// backlog plus the page's own post-load init chains (timers are virtualized) all run in
// here, at pinned instants — so the trigger always fires against an identically-aged page.
// (Used verbatim by the hooked-clock fallback; the cdp path converts to the load-anchored
// PRE_TRIGGER_MS below.)
const PRE_TRIGGER_SETTLE_FRAMES = 120;
// The cdp path's pre-trigger phase is LOAD-ANCHORED, not frame-counted: the load event's
// virtual placement carries a few ms of intra-chunk jitter (rendering-task order inside
// an advance), and a page timer chain anchored on it (seen live: rails init at load+~2s
// with a time-based catch-up target) amplifies any grid-relative slide into whole
// recycle-steps of difference. So after the load event the advance grid is REALIGNED to
// loadEventStart and the trigger fires when the page reaches this exact post-load age —
// identical on every run by construction.
const PRE_TRIGGER_MS = 4000;
const LOAD_BUDGET_MS = 5000;     // virtual ms granted to carry the load so load-time animations arm
// Virtual frames between the trigger and frame 1, always network-pausing, always exactly
// this many — the record start instant must be FIXED (an adaptive count is itself a
// nondeterminism: clock-invisible completions like beacons perturb any quiet heuristic).
// 120 frames = 2s virtual: every discrete load consequence the trigger provoked (lazy
// image lands → belt remeasures) plays out INSIDE the settle window, where the
// network-pausing budgets pin completions to deterministic virtual instants — seen live:
// with a 3-frame settle, two identical runs diverged one belt segment at the frame where
// the wire happened to answer.
const SETTLE_FRAMES = 120;
const DENSE_PROPS = ["transform", "opacity", "filter", "visibility"];
const MAX_FRAMES = 2000;         // the in-page recorder's own cap — asking past it is a caller bug
const FIT_NRMSE_MAX = 0.1;       // a fit above this residual is not attached — samples stay authoritative
const FIT_TIMEOUT_MS = 120000;
// Fixed virtual epoch (seconds): Date.now()-dependent site code must read the SAME clock
// on every run, or determinism dies by wall time.
const VIRTUAL_EPOCH_S = 1700000000;

const die = (msg, code = 1) => { console.error(`✗ ${msg}`); process.exit(code); };
const firstLine = (e) => String((e && e.message) || e).split("\n")[0];
const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = +raw;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// session.send has no timeout of its own; the anti-stall rule is every remote call gets one.
function withTimeout(promise, ms, what) {
  promise.catch(() => {}); // the losing branch must not become an unhandled rejection
  let timer;
  const watchdog = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms); });
  return Promise.race([promise, watchdog]).finally(() => clearTimeout(timer));
}

function parseArgs(argv) {
  const a = { fps: 60, frames: 240, navTimeout: NAV_TIMEOUT_MS };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--fps") a.fps = +argv[++i];
    else if (v === "--frames") a.frames = +argv[++i];
    else if (v === "--verify-determinism") a.verifyDeterminism = true;
    else if (v === "--attach") a.attach = argv[++i];
    else if (v === "--chrome") a.chrome = argv[++i];
    else if (v === "--headful") a.headful = true;
    else if (v === "--nav-timeout") a.navTimeout = +argv[++i];
    else if (v.startsWith("--")) die(`unknown flag ${v} — see the usage block at the top of harness/motion-sampler.js`, 2);
    else rest.push(v);
  }
  a.name = rest[0];
  a.id = rest[1];
  return a;
}

// The samplable trigger vocabulary — a strict subset of the motion trigger DSL. Interactive
// triggers (hover/click/focus/pointer) are wall-clock stimuli a stepped clock cannot
// honestly replay yet; they are refused by name, never silently degraded to "load".
function parseTrigger(raw) {
  const trigger = String(raw == null ? "load" : raw).trim() || "load";
  if (trigger === "load") return { kind: "load" };
  if (trigger === "scroll-sweep") return { kind: "scroll-sweep" };
  let m = /^scroll-to:(.+)$/.exec(trigger);
  if (m) return { kind: "scroll-to", selector: m[1] };
  m = /^scroll-through:(.+)$/.exec(trigger);
  if (m) {
    const parts = m[1].split("/");
    const dwellMs = +parts[parts.length - 1];
    const steps = +parts[parts.length - 2];
    const selector = parts.slice(0, -2).join("/");
    if (parts.length < 3 || !selector || !Number.isInteger(steps) || steps < 1 || !isFinite(dwellMs) || dwellMs < 0) {
      throw new Error(`scroll-through trigger needs <selector>/<steps>/<dwellMs> with numeric steps and dwell (got "${trigger}")`);
    }
    return { kind: "scroll-through", selector, steps, dwellMs };
  }
  throw new Error(`trigger "${trigger}" is not samplable — the virtual-time sampler supports load, scroll-sweep, scroll-to:<selector>, and scroll-through:<selector>/<steps>/<dwellMs>`);
}

// ── the stepped clock ───────────────────────────────────────────────────────────────────

// ── network pinning: the wire's TIMING belongs to the instrument too ────────────────────
// Virtual time pins timers and rAF, but a response landing off the wire lands at a
// WALL-scheduled instant — and everything it gates (parser progress, load events, a
// decode-gated marquee init) then slides between two otherwise identical runs. So every
// request is intercepted at the Request stage and held; between advances, with the clock
// PAUSED (page tasks frozen), the held batch is released and the drain waits until every
// released body has fully arrived. Batch membership is "requests the page issued during
// chunk k" — deterministic — and the batch's consequences all execute inside chunk k+1's
// advance, so round-trip time affects only how long the harness WAITS, never at which
// virtual instant anything runs.
const DRAIN_TIMEOUT_MS = 20000;  // per drain — a response slower than this is excluded as streaming
const DRAIN_POLL_MS = 25;

// Resource types whose bodies change LAYOUT but never execute: held back until the
// document reaches DOMContentLoaded, then released as ONE batch, so their sizing lands in
// one chunk at one virtual instant on every run. Without this the page's one-time layout
// measurements race image sizing (seen live: a belt measuring its pattern strip caught a
// different number of sized logos each run — one logo width of phase, forever).
const LAYOUT_ONLY_TYPES = new Set(["Image", "Font", "Media"]);

function installNetworkPinning(session) {
  const state = {
    paused: new Map(),   // fetch requestId → { networkId, type }, held at the Request stage
    inflight: new Map(), // networkId → true, released and awaiting full delivery
    streaming: new Set(),// networkIds that never finish (streams/long-polls) — excluded, receipted
    holdLayoutOnly: true,// images/fonts/media stay held until the load loop sees DCL
    receipt: { batches: 0, released: 0, streamingExcluded: 0, layoutBatchReleased: 0 },
  };
  session.on("Fetch.requestPaused", (p) => {
    if (p && p.requestId) state.paused.set(p.requestId, { networkId: p.networkId || null, type: p.resourceType || "" });
  });
  session.on("Network.loadingFinished", (p) => { if (p && p.requestId) state.inflight.delete(p.requestId); });
  session.on("Network.loadingFailed", (p) => { if (p && p.requestId) { state.inflight.delete(p.requestId); state.streaming.delete(p.requestId); } });
  return state;
}

// Release held requests (no completion wait) — the concurrent pump for navigation, where
// the intercepted request IS the document and nothing can be awaited page-side. Honors
// the layout-only hold; returns how many were released.
function releaseHeld(session, state) {
  let released = 0;
  for (const [fetchId, meta] of [...state.paused.entries()]) {
    if (state.holdLayoutOnly && LAYOUT_ONLY_TYPES.has(meta.type)) continue;
    state.paused.delete(fetchId);
    if (meta.networkId) state.inflight.set(meta.networkId, true);
    state.receipt.released++;
    if (!state.holdLayoutOnly && LAYOUT_ONLY_TYPES.has(meta.type)) state.receipt.layoutBatchReleased++;
    released++;
    session.send("Fetch.continueRequest", { requestId: fetchId }).catch(() => {}); // the request may already be gone
  }
  if (released) state.receipt.batches++;
  return released;
}

// Release-and-wait until the wire is quiescent: nothing releasable held, nothing released
// still in flight (bodies stream browser-side even while the renderer is frozen).
// Bounded; a response that never finishes is excluded as streaming and receipted, never a
// hang.
async function drainNetwork(session, state) {
  const started = Date.now();
  for (;;) {
    releaseHeld(session, state);
    const stillHeld = [...state.paused.values()].filter((m) => !(state.holdLayoutOnly && LAYOUT_ONLY_TYPES.has(m.type))).length;
    const gating = [...state.inflight.keys()].filter((id) => !state.streaming.has(id));
    if (!stillHeld && !gating.length) return;
    if (Date.now() - started >= DRAIN_TIMEOUT_MS) {
      for (const id of gating) { state.streaming.add(id); state.receipt.streamingExcluded++; }
      return;
    }
    await sleep(DRAIN_POLL_MS);
  }
}

// Installed via Page.addScriptToEvaluateOnNewDocument in hooked-clock mode, BEFORE any
// page script runs. Only script-visible clocks are hooked (performance.now / Date.now /
// rAF); the compositor's clock is out of reach from here — which is exactly why this is
// the receipted fallback and CDP virtual time is the primary.
const HOOK_CLOCK_JS = `(() => {
  if (window.__ppkClockStep) return;
  let vnow = 0;
  let rafQ = [];
  let nextRafId = 1;
  let timers = [];
  let nextTimerId = 1;
  const epoch = ${VIRTUAL_EPOCH_S * 1000};
  try { performance.now = () => vnow; } catch (e) {}
  try { Date.now = () => epoch + vnow; } catch (e) {}
  window.requestAnimationFrame = (cb) => { const id = nextRafId++; rafQ.push({ id, cb }); return id; };
  window.cancelAnimationFrame = (id) => { rafQ = rafQ.filter((e) => e.id !== id); };
  // Stepped timers: due-time queue, fired only inside __ppkClockStep — the page's timer
  // chains advance exactly with the stepped clock, never with the wall.
  window.setTimeout = (cb, delay, ...args) => {
    const id = nextTimerId++;
    if (typeof cb === "function") timers.push({ id, due: vnow + Math.max(0, +delay || 0), cb, args, interval: null });
    return id;
  };
  window.setInterval = (cb, delay, ...args) => {
    const id = nextTimerId++;
    if (typeof cb === "function") timers.push({ id, due: vnow + Math.max(1, +delay || 1), cb, args, interval: Math.max(1, +delay || 1) });
    return id;
  };
  window.clearTimeout = window.clearInterval = (id) => { timers = timers.filter((t) => t.id !== id); };
  // Stepped IntersectionObserver: intersections are computed synchronously from layout at
  // each step, so visibility-armed animations start at exact step boundaries — real IO
  // delivery rides compositor frames, which the stepped clock does not own.
  const ioInstances = [];
  const RealIO = window.IntersectionObserver;
  window.IntersectionObserver = function (cb, opts) {
    const inst = {
      _cb: cb, _targets: new Map(),
      root: (opts && opts.root) || null, rootMargin: (opts && opts.rootMargin) || "0px", thresholds: [0],
      observe(el) { if (el && el.nodeType === 1 && !this._targets.has(el)) this._targets.set(el, null); },
      unobserve(el) { this._targets.delete(el); },
      disconnect() { this._targets.clear(); },
      takeRecords() { return []; },
      _check() {
        const entries = [];
        for (const [el, prev] of this._targets) {
          let inter = false;
          let rect = null;
          try {
            rect = el.getBoundingClientRect();
            inter = rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
          } catch (e) {}
          if (prev === null || prev !== inter) {
            this._targets.set(el, inter);
            entries.push({ target: el, isIntersecting: inter, intersectionRatio: inter ? 1 : 0, time: vnow, boundingClientRect: rect, intersectionRect: inter ? rect : null, rootBounds: null });
          }
        }
        if (entries.length) { try { this._cb(entries, this); } catch (e) {} }
      },
    };
    ioInstances.push(inst);
    return inst;
  };
  if (RealIO) window.IntersectionObserver.prototype = RealIO.prototype;
  window.__ppkClockStep = (stepMs) => {
    vnow += stepMs;
    // one deterministic frame law per step: due timers (in due order, chains included,
    // bounded), then IO checks, then the rAF queue
    for (let fired = 0; fired < 10000; fired++) {
      let best = null;
      for (const t of timers) if (t.due <= vnow && (!best || t.due < best.due || (t.due === best.due && t.id < best.id))) best = t;
      if (!best) break;
      if (best.interval != null) best.due += best.interval;
      else timers = timers.filter((x) => x.id !== best.id);
      try { best.cb(...best.args); } catch (e) {}
    }
    for (const io of ioInstances) io._check();
    const q = rafQ;
    rafQ = [];
    for (const e of q) { try { e.cb(vnow); } catch (err) {} }
    return vnow;
  };
})();`;

// Does CDP virtual time actually DRIVE frames on this Chrome? Emulation virtual time
// always owns timers/performance.now/Date — but headless=new Chrome (measured on 150)
// issues compositor BeginFrames on a WALL schedule regardless, so rAF-counting animations
// tick a wall-raced number of times and no record of them can be reproduced; and
// HeadlessExperimental.beginFrame (explicit frame control) no longer exists there. Probed
// once per browser on a throwaway tab: a rAF loop under a 200 virtual-ms advance either
// ticks (~12 frames — virtual drives frames) or does not (the stepped hook must own the
// clock instead). The verdict rides in the receipt either way.
async function frameDriveProbe(acq) {
  if (acq._ppkFrameDrive) return acq._ppkFrameDrive;
  const { session, targetId } = await cdp.openPage(acq.port, { host: acq.host });
  try {
    try {
      await withTimeout(session.send("Emulation.setVirtualTimePolicy", { policy: "pause", initialVirtualTime: VIRTUAL_EPOCH_S }), STEP_TIMEOUT_MS, "Emulation.setVirtualTimePolicy(pause)");
    } catch (e) {
      acq._ppkFrameDrive = { virtualDrivesFrames: false, reason: firstLine(e) };
      return acq._ppkFrameDrive;
    }
    await cdp.evaluate(session, "window.__ppkN=0;(function l(){requestAnimationFrame(()=>{window.__ppkN++;l()})})()", { awaitPromise: false, timeoutMs: STEP_TIMEOUT_MS });
    const expired = session.waitFor("Emulation.virtualTimeBudgetExpired", { timeoutMs: STEP_TIMEOUT_MS });
    expired.catch(() => {});
    await withTimeout(session.send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: 200 }), STEP_TIMEOUT_MS, "Emulation.setVirtualTimePolicy(advance)");
    await expired;
    const n = await cdp.evaluate(session, "window.__ppkN", { awaitPromise: false, timeoutMs: STEP_TIMEOUT_MS }).catch(() => null);
    const frames = typeof n === "number" && isFinite(n) ? n : 0;
    acq._ppkFrameDrive = {
      virtualDrivesFrames: frames >= 6,
      rafFramesIn200msVirtual: frames,
      ...(frames >= 6 ? {} : { reason: `virtual time does not drive frames on this Chrome (${frames} rAF frame(s) across a 200 virtual-ms advance; headless=new has no begin-frame control)` }),
    };
    return acq._ppkFrameDrive;
  } finally {
    session.close();
    await cdp.closeTab(acq.port, targetId, { host: acq.host });
  }
}

// Set up the clock mode and return the advance primitive. MUST run before navigation — a
// clock taken over after the page started is a clock the page already raced. The receipt
// records which mode actually ran. `drain` runs before every advance, page held — the
// network-pinning drain. `frameDrive` is the per-browser probe verdict: CDP virtual time
// is used only when it actually drives frames.
async function enableVirtualTime(session, drain, frameDrive) {
  let refusal = frameDrive && !frameDrive.virtualDrivesFrames ? frameDrive.reason || "virtual time does not drive frames" : null;
  if (refusal === null) {
    try {
      await withTimeout(session.send("Emulation.setVirtualTimePolicy", { policy: "pause", initialVirtualTime: VIRTUAL_EPOCH_S }), STEP_TIMEOUT_MS, "Emulation.setVirtualTimePolicy(pause)");
    } catch (e) { refusal = firstLine(e); }
  }
  if (refusal === null) {
    // HeadlessExperimental.beginFrame needs --enable-begin-frame-control; absence is the
    // normal case and the budget-advance path alone is fully deterministic.
    let beginFrame = false;
    try { await withTimeout(session.send("HeadlessExperimental.beginFrame", { noDisplayUpdates: true }), 2000, "HeadlessExperimental.beginFrame"); beginFrame = true; } catch (e) {}
    const mode = beginFrame ? "virtual-time+begin-frame" : "virtual-time";
    const step = async (budgetMs, timeoutMs) => {
      const expired = session.waitFor("Emulation.virtualTimeBudgetExpired", { timeoutMs });
      expired.catch(() => {});
      await withTimeout(session.send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: budgetMs }), timeoutMs, "Emulation.setVirtualTimePolicy(advance)");
      await expired;
      if (beginFrame) { try { await withTimeout(session.send("HeadlessExperimental.beginFrame", {}), STEP_TIMEOUT_MS, "HeadlessExperimental.beginFrame"); } catch (e) {} }
    };
    return {
      cdp: true, mode,
      receipt: { mode, initialVirtualTime: VIRTUAL_EPOCH_S, beginFrame, settlePolicy: "drain+advance+freeze", networkPinning: "fetch-batch+layout-batch", cacheDisabled: true, wallBarrierMs: WALL_BARRIER_MS, freezeMs: FREEZE_MS },
      // Recorded frames: drain (clock paused, virtual-invisible), then the tier-3
      // contract's per-step primitive — one plain "advance" stepMs budget, one
      // virtualTimeBudgetExpired.
      advance: async (budgetMs) => { if (drain) await drain(); await step(budgetMs, STEP_TIMEOUT_MS); },
      // Settle/dwell advances (pre-record) additionally HOLD the paused clock for the
      // freeze window after the step, so clock-invisible completions (image decode
      // threads, browser-side stragglers) quantize to the chunk grid (see FREEZE_MS).
      // (A budget split with a rendering-free "task pump" tail was tried against the
      // last ±1-rAF-tick residual and made things WORSE — the vsync landed in the tail
      // and the whole rendering pipeline shifted; keep the budget whole.)
      settle: async (budgetMs) => { if (drain) await drain(); await step(budgetMs, SETTLE_TIMEOUT_MS); await sleep(FREEZE_MS); },
    };
  }
  await withTimeout(session.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK_CLOCK_JS }), STEP_TIMEOUT_MS, "Page.addScriptToEvaluateOnNewDocument");
  const advance = async (budgetMs) => {
    if (drain) await drain();
    await cdp.evaluate(session, `__ppkClockStep(${budgetMs})`, { awaitPromise: false, timeoutMs: STEP_TIMEOUT_MS });
  };
  return {
    cdp: false, mode: "hooked-clock",
    receipt: {
      mode: "hooked-clock", fallbackReason: refusal, epochMs: VIRTUAL_EPOCH_S * 1000,
      hookedSurface: "performance.now+Date.now+rAF+setTimeout/Interval+IntersectionObserver",
      settlePolicy: "drain+step+freeze", networkPinning: "fetch-batch+layout-batch",
      cacheDisabled: true, wallBarrierMs: WALL_BARRIER_MS, freezeMs: FREEZE_MS,
    },
    advance,
    // Between steps the page CANNOT move (rAF, timers, and IO are all stepped); the
    // freeze only decides where clock-invisible wall completions bucket, same as cdp mode.
    settle: async (budgetMs) => { await advance(budgetMs); await sleep(FREEZE_MS); },
  };
}

// ── trigger execution — instant scrolls, virtual dwells ─────────────────────────────────
async function runTrigger(session, vt, ctx) {
  const t = ctx.trigger;
  if (t.kind === "load") return;
  if (t.kind === "scroll-to") {
    await cdp.evaluate(session, `(() => {
      const el = document.querySelector(${JSON.stringify(t.selector)});
      if (!el) throw new Error("scroll-to: no element matches " + ${JSON.stringify(t.selector)});
      const top = Math.max(0, (window.scrollY || 0) + el.getBoundingClientRect().top);
      window.scrollTo({ top, left: 0, behavior: "instant" });
      return top;
    })()`, { awaitPromise: false, timeoutMs: STEP_TIMEOUT_MS });
    return;
  }
  if (t.kind === "scroll-through") {
    const rect = await cdp.evaluate(session, `(() => {
      const el = document.querySelector(${JSON.stringify(t.selector)});
      if (!el) throw new Error("scroll-through: no element matches " + ${JSON.stringify(t.selector)});
      const r = el.getBoundingClientRect();
      return { top: Math.max(0, (window.scrollY || 0) + r.top), height: r.height };
    })()`, { awaitPromise: false, timeoutMs: STEP_TIMEOUT_MS });
    const top = rect && isFinite(rect.top) ? rect.top : 0;
    const height = rect && isFinite(rect.height) ? rect.height : 0;
    for (let i = 0; i < t.steps; i++) {
      const pos = Math.round(top + (t.steps === 1 ? 0 : (i / (t.steps - 1)) * height));
      await cdp.evaluate(session, `window.scrollTo({ top: ${pos}, left: 0, behavior: "instant" })`, { awaitPromise: false, timeoutMs: STEP_TIMEOUT_MS });
      if (t.dwellMs > 0) await vt.settle(t.dwellMs); // network-pausing: lazy fetches the scroll provoked land deterministically
    }
    return;
  }
  if (t.kind === "scroll-sweep") {
    const max = await cdp.evaluate(session, "Math.max((document.documentElement.scrollHeight || 0) - innerHeight, 0)", { awaitPromise: false, timeoutMs: STEP_TIMEOUT_MS });
    const span = typeof max === "number" && isFinite(max) ? max : 0;
    const step = Math.max(200, Math.floor(ctx.viewport.height * 0.8));
    for (let y = 0; y <= span; y += step) {
      await cdp.evaluate(session, `window.scrollTo({ top: ${y}, left: 0, behavior: "instant" })`, { awaitPromise: false, timeoutMs: STEP_TIMEOUT_MS });
      await vt.settle(ctx.stepMs);
    }
    await cdp.evaluate(session, `window.scrollTo({ top: 0, left: 0, behavior: "instant" })`, { awaitPromise: false, timeoutMs: STEP_TIMEOUT_MS });
    return;
  }
  throw new Error(`unsupported trigger kind "${t.kind}"`); // parseTrigger already refused — defense in depth
}

// ── one full capture: probe → clock → navigate → trigger → Start → steps → Stop ─────────
async function captureOnce(ctx) {
  const { session, targetId } = await cdp.openPage(ctx.acq.port, { host: ctx.acq.host });
  try {
    // The environment probe runs on about:blank BEFORE the clock is taken over: under a
    // stepped clock rAF cannot free-run, so the loaded page can never re-prove itself —
    // the receipt says where the environment was proven instead of pretending.
    const probe = await chrome.probeEnvironment(session);
    if (!probe.verdict.ok) throw new Error(`environment refused before sampling (about:blank): ${probe.verdict.reason}${ctx.args.headful ? "" : " — re-run with --headful"}`);
    await chrome.normalizeViewport(session, ctx.viewport);

    // Cache OFF for every run: a warm-cache run's resource loads never PEND, so they slip
    // past the network-pausing budgets and land at wall-dependent virtual instants — the
    // exact cache asymmetry that made run A and run B of the same capture diverge. Cold on
    // every run, every fetch pends, every completion lands at a deterministic instant.
    await withTimeout(session.send("Network.enable", {}), STEP_TIMEOUT_MS, "Network.enable");
    await withTimeout(session.send("Network.setCacheDisabled", { cacheDisabled: true }), STEP_TIMEOUT_MS, "Network.setCacheDisabled");
    // The settle phase reads performance resource entries as its network-quiet probe; the
    // default 250-entry buffer would clamp the count on a heavy page and fake quiescence.
    await withTimeout(session.send("Page.addScriptToEvaluateOnNewDocument", { source: "try { performance.setResourceTimingBufferSize(20000); } catch (e) {}" }), STEP_TIMEOUT_MS, "Page.addScriptToEvaluateOnNewDocument(resource buffer)");

    const net = installNetworkPinning(session);
    const frameDrive = await frameDriveProbe(ctx.acq); // throwaway tab, cached per browser
    const vt = await enableVirtualTime(session, () => drainNetwork(session, net), frameDrive); // BEFORE navigation — the contract
    console.log(`· sample: ${ctx.url} (${vt.mode})`);
    let loadFrames = 0;
    let preTriggerFrames = 0;
    let driftMs = null;
    // Every request is held at the Request stage from here on — the network-pinning
    // contract (see installNetworkPinning): batches release between advances only. The
    // document request itself is intercepted, so a release pump runs alongside the
    // commit wait.
    await withTimeout(session.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }), STEP_TIMEOUT_MS, "Fetch.enable");
    const navP = withTimeout(session.send("Page.navigate", { url: ctx.url }), ctx.args.navTimeout, "Page.navigate(commit)");
    let navSettled = false;
    const navDone = navP.then((r) => { navSettled = true; return r; }, (e) => { navSettled = true; throw e; });
    while (!navSettled) { releaseHeld(session, net); await sleep(DRAIN_POLL_MS); }
    await navDone;
    const LOAD_PROBE = `(() => { const nav = performance.getEntriesByType("navigation")[0]; return { now: performance.now(), load: nav && nav.loadEventStart ? nav.loadEventStart : 0, dcl: nav && nav.domContentLoadedEventStart ? nav.domContentLoadedEventStart : 0, readyState: document.readyState }; })()`;
    if (vt.cdp) {
      // Virtual time PAUSED at the epoch through the navigation: no virtual instant
      // passes during the document fetch, so the load always begins at the same virtual
      // time. The load then rides CHUNKED frame-grid advances, one stepMs settle at a
      // time, ONLY until the load event has fired. Parser progress, subresource arrival,
      // and the load event are all batch-pinned by the drains, so the chunk count is
      // virtual-deterministic — and stopping there leaves the page's post-load init
      // chains UNRUN, to be executed at pinned load-relative instants after the barrier.
      const maxLoadFrames = Math.ceil(LOAD_BUDGET_MS / ctx.stepMs);
      let loadInfo = null;
      while (loadFrames < maxLoadFrames) {
        loadInfo = await cdp.evaluate(session, LOAD_PROBE, { awaitPromise: false }).catch(() => null);
        // DCL reached → the layout-only hold lifts and the NEXT drain releases every held
        // image/font/media response as one batch, at one chunk boundary (see
        // LAYOUT_ONLY_TYPES). The load event, which waits on them, then lands pinned too.
        if (loadInfo && loadInfo.dcl > 0 && net.holdLayoutOnly) net.holdLayoutOnly = false;
        if (loadInfo && loadInfo.load > 0) break;
        await vt.settle(ctx.stepMs);
        loadFrames++;
      }
      if (!loadInfo || !(loadInfo.load > 0)) {
        throw new Error(`the load event did not fire within ${maxLoadFrames} load frame(s) (${LOAD_BUDGET_MS} virtual ms; readyState=${JSON.stringify(loadInfo && loadInfo.readyState)}) — this load needs more virtual time than the budget grants (LOAD_BUDGET_MS in harness/motion-sampler.js)`);
      }
      // Realign the advance grid to the load event, so every later boundary sits at
      // loadEventStart + k*stepMs regardless of where inside a chunk the event landed.
      driftMs = +((loadInfo.now - loadInfo.load) % ctx.stepMs).toFixed(3);
      const realign = driftMs > 0.01 && ctx.stepMs - driftMs > 0.05 ? ctx.stepMs - driftMs : 0;
      if (realign) await vt.settle(realign);
      await sleep(WALL_BARRIER_MS); // the wall barrier — see WALL_BARRIER_MS
      // Load-anchored pre-trigger: advance until the page is exactly PRE_TRIGGER_MS past
      // its own load event — a fixed AGE, not a fixed frame count, so a run whose load
      // event landed a chunk later still triggers at the identical page age.
      const loadTarget = loadInfo.load + PRE_TRIGGER_MS;
      const maxPreFrames = Math.ceil(PRE_TRIGGER_MS / ctx.stepMs) + 20;
      while (preTriggerFrames < maxPreFrames) {
        const t = await cdp.evaluate(session, "performance.now()", { awaitPromise: false }).catch(() => null);
        if (typeof t === "number" && t >= loadTarget - 0.5) break;
        await vt.settle(ctx.stepMs);
        preTriggerFrames++;
      }
    } else {
      // Hooked-clock mode: the page's rAF, timers, and IO are STEPPED, so nothing
      // page-side can run ahead while the load proceeds at wall speed — the page is
      // frozen-by-construction between our steps. The load loop polls at wall pace,
      // releasing request batches and lifting the layout-only hold at DCL; every
      // animation-relevant consequence then executes on the stepped grid below.
      const deadline = Date.now() + ctx.args.navTimeout;
      let loadInfo = null;
      for (;;) {
        loadInfo = await cdp.evaluate(session, LOAD_PROBE, { awaitPromise: false }).catch(() => null);
        if (loadInfo && loadInfo.dcl > 0 && net.holdLayoutOnly) net.holdLayoutOnly = false;
        releaseHeld(session, net);
        if (loadInfo && loadInfo.load > 0) break;
        if (Date.now() > deadline) {
          throw new Error(`the load event did not fire within ${ctx.args.navTimeout}ms wall (readyState=${JSON.stringify(loadInfo && loadInfo.readyState)}) — slow site? raise --nav-timeout`);
        }
        await sleep(DRAIN_POLL_MS);
      }
      await sleep(WALL_BARRIER_MS); // decode/sizing stragglers land while the stepped page cannot move
      // Fixed pre-trigger frame count: under the stepped clock the page's init chains run
      // HERE, on the grid — the wall placement of the load event cannot reach them.
      for (let i = 0; i < PRE_TRIGGER_SETTLE_FRAMES; i++) { await vt.settle(ctx.stepMs); preTriggerFrames++; }
    }

    const got = await cdp.evaluate(session, chrome.VIEWPORT_READ, { awaitPromise: false });
    const vpMiss = chrome.viewportMismatch(ctx.viewport, got);
    if (vpMiss) throw new Error(`viewport did not normalize on the sampled page — ${vpMiss}`);

    await runTrigger(session, vt, ctx);
    // Post-trigger settle: fixed-count (see SETTLE_FRAMES). Overridable per capture —
    // the clone-side verify re-sample (motion-verify.js) needs the record to begin AT the
    // replay's own trigger-armed start, not a live-page settle later; the clone is a
    // deterministic local page with none of the wall races the live settle absorbs.
    const settleFrames = Number.isInteger(ctx.settleFrames) && ctx.settleFrames >= 0 ? ctx.settleFrames : SETTLE_FRAMES;
    for (let i = 0; i < settleFrames; i++) await vt.settle(ctx.stepMs);
    // Telemetry only (never a control input): how many resources had completed when the
    // record started — a run-to-run mismatch here names the leak if determinism fails.
    const resourcesAtRecord = await cdp.evaluate(session, "performance.getEntriesByType('resource').length", { awaitPromise: false, timeoutMs: STEP_TIMEOUT_MS });

    await cdp.evaluate(session, ctx.captureSource, { awaitPromise: false });
    const shape = await cdp.evaluate(session, "typeof pxDenseRecordStart", { awaitPromise: false });
    if (shape !== "function") throw new Error(`injection landed but pxDenseRecordStart is ${shape} — tools/browser-capture.js changed shape?`);
    const startInfo = await cdp.evaluate(session, `pxDenseRecordStart(${JSON.stringify({ scopes: ctx.scopes, props: ctx.props })})`, { awaitPromise: false, timeoutMs: STEP_TIMEOUT_MS });
    if (!startInfo || typeof startInfo !== "object") throw new Error(`pxDenseRecordStart returned ${JSON.stringify(startInfo)} — recorder shape drift?`);
    if (!startInfo.tracking) throw new Error(`scope ${JSON.stringify(ctx.scopes)} matched no recordable element on the page — fix the item's scope in motion-items.json before sampling`);

    for (let i = 1; i <= ctx.args.frames; i++) {
      await vt.advance(ctx.stepMs);
      if (ctx.driveWaapi) {
        // Clone-side verify drive: the generated replay is WAAPI, and WAAPI plays on the
        // compositor's clock, which neither clock mode owns — so each frame is POSED
        // exactly, through the animation's own public control surface, before it is read.
        await cdp.evaluate(session, `(() => { for (const a of document.getAnimations()) { try { a.currentTime = ${i * ctx.stepMs}; } catch (e) {} } })()`, { awaitPromise: false, timeoutMs: STEP_TIMEOUT_MS });
      }
      await cdp.evaluate(session, `pxDenseRecordStep(${i * ctx.stepMs})`, { awaitPromise: false, timeoutMs: STEP_TIMEOUT_MS });
    }
    const record = await cdp.evaluate(session, "pxDenseRecordStop()", { awaitPromise: false, timeoutMs: STEP_TIMEOUT_MS });
    if (!record || typeof record !== "object" || !Array.isArray(record.elements)) throw new Error("pxDenseRecordStop returned no record — recorder shape drift?");
    if (record.truncated) console.log("  ⚠ the recorder hit a cap (200 elements / 2000 frames / 5000 writes) — the record is explicitly truncated");
    return {
      record, startInfo, vtReceipt: vt.receipt, probe: { rafHz: probe.verdict.rafHz },
      settle: {
        loadFrames, preTriggerFrames, loadDriftMs: driftMs, preTriggerMs: vt.cdp ? PRE_TRIGGER_MS : null, frames: settleFrames,
        policy: vt.cdp ? "drain+advance+freeze" : "hooked-clock-step",
        resourcesAtRecord,
        network: { ...net.receipt, heldAtStop: net.paused.size },
      },
    };
  } finally {
    session.close();
    await cdp.closeTab(ctx.acq.port, targetId, { host: ctx.acq.host });
  }
}

// ── determinism diff — the first differing path, by name ────────────────────────────────
function firstDiff(a, b, at = "record") {
  if (a === b) return null;
  if (a == null || b == null || typeof a !== typeof b || typeof a !== "object") {
    return `${at}: ${JSON.stringify(a === undefined ? null : a).slice(0, 80)} != ${JSON.stringify(b === undefined ? null : b).slice(0, 80)}`;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = firstDiff(a[key], b[key], `${at}.${key}`);
    if (d) return d;
  }
  return null;
}

// ── the fit LIFT — numeric series out of the raw record, tier-3 fitters over a bridge ───

// matrix(a,b,c,d,e,f) / matrix3d(16) / "none" → decomposed channels. Computed transform is
// always matrix form; anything else is not a fittable series (null = skip, never guess).
function parseTransformChannels(value) {
  const v = String(value == null ? "" : value).trim();
  if (!v || v === "none") return { tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 };
  let m = /^matrix\(([^)]*)\)$/.exec(v);
  if (m) {
    const n = m[1].split(",").map((x) => parseFloat(x));
    if (n.length !== 6 || !n.every(isFinite)) return null;
    return { tx: n[4], ty: n[5], sx: Math.hypot(n[0], n[1]), sy: Math.hypot(n[2], n[3]), rot: +(Math.atan2(n[1], n[0]) * 180 / Math.PI).toFixed(4) };
  }
  m = /^matrix3d\(([^)]*)\)$/.exec(v);
  if (m) {
    const n = m[1].split(",").map((x) => parseFloat(x));
    if (n.length !== 16 || !n.every(isFinite)) return null;
    return { tx: n[12], ty: n[13], sx: Math.hypot(n[0], n[1]), sy: Math.hypot(n[4], n[5]), rot: +(Math.atan2(n[1], n[0]) * 180 / Math.PI).toFixed(4) };
  }
  return null;
}

const TRANSFORM_CHANNELS = ["tx", "ty", "sx", "sy", "rot"];

// ── ONGOING-MOTION DETECTION — no settle observed means the clip has no ending ──────────
// A sampled series still changing in its final frames is ONGOING motion: nothing in the
// record proves the motion ever ends, so the record is a finite WINDOW onto it, not a
// complete clip of it. The distinction is load-bearing downstream — apply-sampled refuses
// to ship a one-shot clip for an ongoing track (a clip that stops is a fabricated
// ending), and verify-sampled's post-window check demands the clone keep moving past the
// clip end. Detection: any consecutive-frame delta above the noise floor inside the last
// ~10% of the window (min 2 frames). The floors sit well above sub-pixel float spelling
// between renders of the same matrix and well below one real motion step (a slow belt at
// 36px/s sampled at 60fps still moves 0.6px/frame).
const ONGOING_TAIL_FRACTION = 0.1;
const ONGOING_NOISE = { translatePx: 0.1, scale: 0.004, rotateDeg: 0.1, opacity: 0.004, numeric: 0.004 };
const ONGOING_NUM_RE = /-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi;

// Largest noise-normalized channel delta between two consecutive sampled values: > 1
// means real motion. Discrete values (visibility, non-numeric strings): inequality IS
// motion. Never guesses — an unparsable pair that differs counts as motion.
function sampledValueDelta(property, a, b) {
  const sa = String(a == null ? "" : a), sb = String(b == null ? "" : b);
  if (sa === sb) return 0;
  if (property === "transform") {
    const ca = parseTransformChannels(sa), cb = parseTransformChannels(sb);
    if (ca && cb) {
      return Math.max(
        Math.abs(ca.tx - cb.tx) / ONGOING_NOISE.translatePx,
        Math.abs(ca.ty - cb.ty) / ONGOING_NOISE.translatePx,
        Math.abs(ca.sx - cb.sx) / ONGOING_NOISE.scale,
        Math.abs(ca.sy - cb.sy) / ONGOING_NOISE.scale,
        Math.abs(ca.rot - cb.rot) / ONGOING_NOISE.rotateDeg,
      );
    }
  }
  if (property === "opacity") {
    const na = parseFloat(sa), nb = parseFloat(sb);
    if (isFinite(na) && isFinite(nb)) return Math.abs(na - nb) / ONGOING_NOISE.opacity;
  }
  const skel = (v) => v.replace(ONGOING_NUM_RE, "#");
  if (skel(sa) === skel(sb)) {
    const na = sa.match(ONGOING_NUM_RE) || [], nb = sb.match(ONGOING_NUM_RE) || [];
    if (na.length === nb.length) {
      let max = 0;
      for (let i = 0; i < na.length; i++) max = Math.max(max, Math.abs(+na[i] - +nb[i]) / ONGOING_NOISE.numeric);
      return max;
    }
  }
  return Infinity; // structure changed — discrete motion
}

// Pure over one sampled track's keyframes. Consumers re-derive rather than trusting the
// stored flag alone (apply/verify both call this) — the evidence IS the keyframes.
function trackIsOngoing(track) {
  const kf = (track && track.keyframes) || [];
  if (kf.length < 3) return false;
  const tail = Math.max(2, Math.ceil(kf.length * ONGOING_TAIL_FRACTION));
  for (let i = kf.length - tail; i < kf.length; i++) {
    if (sampledValueDelta(track.property, kf[i - 1].value, kf[i].value) > 1) return true;
  }
  return false;
}

// Stamp ongoing:true on every sampled-tier track whose series never settled. Returns the
// count for the receipt. Only true is ever recorded — absence means "settled", and the
// fingerprint ignores the flag either way (identity is what moves, not whether it stops).
function markOngoing(doc) {
  let marked = 0;
  for (const track of (doc && doc.tracks) || []) {
    if (track && track.provenance && track.provenance.tier === "sampled" && trackIsOngoing(track)) {
      track.ongoing = true;
      marked++;
    }
  }
  return marked;
}

// ── the marquee tie-break: ONGOING BEATS FINITE ─────────────────────────────────────────
// The engine's fitters compete on residual alone, and on a short window a full-window
// linear tween fits an ongoing constant-velocity belt exactly as well as a marquee does —
// seen live: a 4s window on a forever belt came back "tween", and the tween's finite form
// then shipped a clip that froze. But ongoing:true settles the question the engine's
// duration heuristics only estimate: the motion NEVER settled in the window, so a finite
// class cannot be the truth of it. When an ongoing track's winning fit is not periodic,
// the marquee class gets a direct shot at the series: an exact linear fit (a marquee is
// definitionally constant-velocity) within the same residual gate, at a real velocity,
// re-classifies the track — ongoing beats finite when ongoing:true.
const MARQUEE_MIN_VELOCITY_PX_S = 5; // matches the engine's own floor — below is drift
const MARQUEE_TIEBREAK_CHANNELS = new Set(["tx", "ty"]); // the loop form is translation

function marqueeFromSeries(s) {
  if (!s || !MARQUEE_TIEBREAK_CHANNELS.has(s.channel)) return null;
  const pts = s.samples || [];
  if (pts.length < 3) return null;
  const n = pts.length;
  const mt = pts.reduce((a, p) => a + p.t, 0) / n;
  const mv = pts.reduce((a, p) => a + p.v, 0) / n;
  let stt = 0, stv = 0;
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) {
    stt += (p.t - mt) * (p.t - mt);
    stv += (p.t - mt) * (p.v - mv);
    if (p.v < lo) lo = p.v;
    if (p.v > hi) hi = p.v;
  }
  const range = hi - lo;
  if (!(stt > 0) || !(range > 0)) return null;
  const slope = stv / stt; // px per ms
  const intercept = mv - slope * mt;
  let sum = 0;
  for (const p of pts) { const d = intercept + slope * p.t - p.v; sum += d * d; }
  const nrmse = Math.sqrt(sum / n) / range;
  if (!isFinite(nrmse) || nrmse > FIT_NRMSE_MAX) return null;
  const velocityPxPerSec = Math.abs(slope) * 1000;
  if (velocityPxPerSec < MARQUEE_MIN_VELOCITY_PX_S) return null;
  return {
    kind: "marquee",
    params: {
      channel: s.channel,
      axis: s.channel === "ty" ? "y" : "x",
      velocityPxPerSec: +velocityPxPerSec.toFixed(4),
      direction: slope < 0 ? -1 : 1,
      valueFrom: +pts[0].v.toFixed(4),
      steadyMs: Math.round(pts[n - 1].t - pts[0].t),
    },
    nrmse: +nrmse.toFixed(6),
  };
}

// Numeric per-channel series from the RAW record (true sample times). The same "no change
// across all frames" rule fromSampled applies, so the lift and the doc always describe
// the same set of tracks.
function sampledSeries(record) {
  const out = [];
  for (const el of (record && record.elements) || []) {
    if (!el || !Array.isArray(el.samples) || el.samples.length < 2) continue;
    const selector = typeof el.selector === "string" && el.selector.trim() ? el.selector.trim() : null;
    if (!selector) continue;
    const properties = Object.keys((el.samples[0] && el.samples[0].values) || {});
    for (const property of properties) {
      const raw = el.samples.map((s) => ({ t: s.t, v: s && s.values ? s.values[property] : null }));
      if (raw.every((s) => s.v === raw[0].v)) continue; // static — fromSampled drops it too
      if (property === "opacity") {
        const samples = raw.map((s) => ({ t: s.t, v: parseFloat(s.v) }));
        if (samples.every((s) => isFinite(s.v))) out.push({ selector, property, channel: "opacity", samples });
      } else if (property === "transform") {
        const decomposed = raw.map((s) => parseTransformChannels(s.v));
        if (!decomposed.every(Boolean)) continue;
        for (const channel of TRANSFORM_CHANNELS) {
          const samples = raw.map((s, i) => ({ t: s.t, v: decomposed[i][channel] }));
          const vals = samples.map((s) => s.v);
          if (Math.max(...vals) - Math.min(...vals) > 0) out.push({ selector, property, channel, samples });
        }
      }
      // filter/visibility: no numeric channel — the sampled keyframes stay the record
    }
  }
  return out;
}

// track.fit shape (validateTrack: kind + params object + nrmse) from a fitChannel() result.
function fitParams(fit, channel) {
  const params = { channel };
  for (const src of [fit.transition, fit.params, fit.link]) {
    if (src && typeof src === "object") Object.assign(params, src);
  }
  for (const key of ["valueFrom", "valueTo", "settleMs", "steadyMs", "steadyStartMs", "delayMs", "headMs"]) {
    if (fit[key] !== undefined && fit[key] !== null) params[key] = fit[key];
  }
  return params;
}

// The engine boundary is ESM; the harness is CJS. A one-shot `node --input-type=module -e`
// bridge keeps the boundary intact without adding files to the engine package: series in
// on stdin, fits out on stdout, everything data.
function runFitBridge(fitPath, seriesList) {
  const script = [
    'import { readFileSync } from "node:fs";',
    `import { fitChannel } from ${JSON.stringify(pathToFileURL(fitPath).href)};`,
    'const list = JSON.parse(readFileSync(0, "utf8"));',
    "const out = list.map((s) => { try { return fitChannel(s.samples, null, { channel: s.channel }); } catch (e) { return { bridgeError: String((e && e.message) || e) }; } });",
    "process.stdout.write(JSON.stringify(out));",
  ].join("\n");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    input: JSON.stringify(seriesList), encoding: "utf8", timeout: FIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) throw new Error(`fit bridge did not run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`fit bridge exited ${r.status}: ${String(r.stderr || "").split("\n").find((l) => l.trim()) || "no stderr"}`);
  const parsed = JSON.parse(r.stdout);
  if (!Array.isArray(parsed) || parsed.length !== seriesList.length) throw new Error("fit bridge returned a mismatched result list");
  return parsed;
}

// Never throws, never blocks the sample: fitter absence or failure is a receipted skip.
function liftTier3Fits(doc, record) {
  const log = [];
  const receipt = { attempted: 0, attached: [], rejected: 0, reclassified: [] };
  try {
    const fitPath = path.join(PKG, "packages", "motion", "src", "tier3", "fit.js");
    if (!fs.existsSync(fitPath)) {
      receipt.skipped = "engine fitters absent (packages/motion/src/tier3/fit.js) — sampled keyframes stay authoritative";
      log.push(`· fit lift skipped: ${receipt.skipped}`);
      return { receipt, log };
    }
    const series = sampledSeries(record);
    receipt.attempted = series.length;
    if (!series.length) {
      receipt.skipped = "no numeric series to fit";
      log.push("· fit lift: no numeric series to fit");
      return { receipt, log };
    }
    const results = runFitBridge(fitPath, series);
    for (let i = 0; i < series.length; i++) {
      const fit = results[i];
      const s = series[i];
      const track = doc.tracks.find((t) => t.target && t.target.selector === s.selector && t.property === s.property);
      let candidate = null;
      if (fit && fit.bridgeError) receipt.rejected++;
      else if (fit && fit.kind && typeof fit.nrmse === "number" && isFinite(fit.nrmse) && fit.nrmse <= FIT_NRMSE_MAX) {
        candidate = { kind: String(fit.kind), params: fitParams(fit, s.channel), nrmse: fit.nrmse };
      } else if (fit && fit.kind) receipt.rejected++;
      // THE TIE-BREAK — ongoing beats finite when ongoing:true (see marqueeFromSeries):
      // an ongoing track whose winning fit is not periodic gets the marquee class's
      // direct shot at the series; a finite class cannot be the truth of motion that
      // never settled in the window.
      if (track && track.ongoing === true && (!candidate || candidate.kind !== "marquee")) {
        const marquee = marqueeFromSeries(s);
        if (marquee) {
          receipt.reclassified.push({
            selector: s.selector, property: s.property, channel: s.channel,
            from: candidate ? candidate.kind : "(no fit)", to: "marquee",
            velocityPxPerSec: marquee.params.velocityPxPerSec,
          });
          candidate = marquee;
        }
      }
      if (!track || !candidate) continue;
      // A fit rides along additively, except the tie-break itself: a periodic form on an
      // ongoing track beats any finite fit already attached, regardless of residual.
      const marqueeWins = candidate.kind === "marquee" && track.ongoing === true &&
        track.fit && track.fit.kind !== "marquee";
      if (!track.fit || candidate.nrmse < track.fit.nrmse || marqueeWins) track.fit = candidate;
      receipt.attached.push({ selector: s.selector, property: s.property, channel: s.channel, kind: candidate.kind, nrmse: +candidate.nrmse.toFixed(5) });
    }
    if (receipt.attached.length) log.push(`✓ fit lift: ${receipt.attached.length}/${series.length} series fitted (nrmse <= ${FIT_NRMSE_MAX}) — attached as track.fit for editability; the sampled keyframes stay authoritative`);
    else log.push(`· fit lift: no series fitted within nrmse <= ${FIT_NRMSE_MAX} (${series.length} attempted) — sampled keyframes stay authoritative`);
    if (receipt.reclassified.length) log.push(`· ongoing tie-break: ${receipt.reclassified.length} series re-classified marquee — ongoing beats finite (the motion never settled in the window, so a finite class cannot be its truth)`);
  } catch (e) {
    receipt.skipped = `fit lift failed (sampling unaffected): ${firstLine(e)}`;
    log.push(`⚠ ${receipt.skipped}`);
  }
  return { receipt, log };
}

// ── main ────────────────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.name || !args.id) die(`usage: ${VIA_PPK ? "pingfusi motion sample" : "node harness/motion-sampler.js"} <name> <motion-id> [--fps 60] [--frames 240] [--verify-determinism] [--attach <port>] [--chrome <path>] [--headful]`, 2);
  if (!Number.isFinite(args.fps) || args.fps <= 0 || args.fps > 240) die(`--fps must be a number in 1..240 (got ${args.fps})`, 2);
  if (!Number.isInteger(args.frames) || args.frames < 1 || args.frames > MAX_FRAMES) die(`--frames must be an integer in 1..${MAX_FRAMES} — the in-page recorder caps there (got ${args.frames})`, 2);

  const dir = path.join(WORK, "targets", args.name);
  let manifest;
  try { manifest = readMotionItems(dir); }
  catch (e) { die(`targets/${args.name}/motion-items.json: ${e.message}`, 2); }
  const item = manifest.items.find((candidate) => candidate.id === args.id);
  if (!manifest.exists || !item) die(`targets/${args.name}/motion-items.json has no item "${args.id}"`, 2);
  if (!isDeclaredItem(item)) {
    // The quarantine line: sampling is enforcement work, and enforcement is opt-in by
    // declaration. A sweep-manufactured row must be adopted first.
    die(`motion item ${args.id} was never operator-declared — sampling only runs on owned receipts; adopt it by recording owner provenance on the item in targets/${args.name}/motion-items.json (e.g. \"declaredBy\": \"manual\")`, 2);
  }

  let target = {};
  try { target = JSON.parse(fs.readFileSync(path.join(dir, "target.json"), "utf8")); } catch (e) {}
  const url = item.url || target.url;
  if (!url) die(`motion item ${args.id} has no declared source URL and targets/${args.name}/target.json supplies none — record one on the item in targets/${args.name}/motion-items.json (\"url\": \"<url>\")`);
  let trigger;
  try { trigger = parseTrigger(item.trigger); } catch (e) { die(firstLine(e)); }

  let liveSnap = null;
  try { liveSnap = JSON.parse(fs.readFileSync(path.join(dir, "live.json"), "utf8")); } catch (e) {}
  const viewport = chrome.resolveViewport({ target, live: liveSnap });
  const stepMs = 1000 / args.fps;
  const scopes = typeof item.scope === "string" && item.scope.trim() ? [item.scope.trim()] : ["body"];

  const acq = await chrome.acquire({
    attach: args.attach, chromePath: args.chrome, headless: !args.headful,
    width: viewport.width, height: 1050,
  }).catch((e) => die(e.message));
  console.log(`· pingfusi ${KIT_VERSION} motion sample — ${acq.mode} ${acq.chromeVersion}${acq.headless ? " (headless=new)" : ""} on :${acq.port}, ${args.fps}fps x ${args.frames} frame(s) (${(args.frames * stepMs / 1000).toFixed(2)}s virtual), viewport ${viewport.width}x${viewport.height} @${viewport.dpr}x`);

  const ctx = {
    args, acq, viewport, url, trigger, scopes, stepMs, props: DENSE_PROPS,
    captureSource: fs.readFileSync(path.join(PKG, "tools", "browser-capture.js"), "utf8"),
  };
  process.on("SIGINT", () => { acq.cleanup().then(() => process.exit(130)); });

  let code = 0;
  try {
    const runA = await captureOnce(ctx);
    console.log(`  ✓ sampled ${runA.record.frames} frame(s) — ${runA.startInfo.tracking} element(s) tracked, mode ${runA.vtReceipt.mode}${runA.startInfo.skipped && runA.startInfo.skipped.agentDom ? `, ${runA.startInfo.skipped.agentDom} agent-overlay element(s) skipped (the instrument must not record itself)` : ""}`);

    let determinism = { runs: 1 };
    if (args.verifyDeterminism) {
      // Same browser, fresh tab: under the stepped clock two tabs of one browser
      // reproduce byte-identically (measured), while two freshly-launched browsers can
      // settle into different — each internally stable — phase states of a wrapping
      // animation. The gate verifies the pair either way; the receipt records both runs.
      const runB = await captureOnce(ctx);
      const view = (r) => JSON.stringify({ frames: r.record.frames, stepMs: r.record.stepMs, elements: r.record.elements, writes: r.record.writes });
      if (runA.settle.resourcesAtRecord !== runB.settle.resourcesAtRecord) {
        console.log(`  ⚠ resource count at record start differed between runs (${runA.settle.resourcesAtRecord} vs ${runB.settle.resourcesAtRecord}) — a network completion leaked past the settle window`);
      }
      if (runA.settle.loadFrames !== runB.settle.loadFrames) {
        console.log(`  ⚠ load frame count differed between runs (${runA.settle.loadFrames} vs ${runB.settle.loadFrames}) — readyState progression was not virtual-deterministic`);
      }
      const identical = view(runA) === view(runB);
      determinism = { runs: 2, identical, resourcesAtRecord: [runA.settle.resourcesAtRecord, runB.settle.resourcesAtRecord], loadFrames: [runA.settle.loadFrames, runB.settle.loadFrames], ...(identical ? {} : { firstDifference: firstDiff(runA.record, runB.record) }) };
      console.log(identical ? "  ✓ determinism verified — two full runs produced identical samples" : `  ✗ determinism FAILED — ${determinism.firstDifference}`);
    }

    const sampledDoc = motionDoc.fromSampled(runA.record, { url, viewport, fps: args.fps });
    const sampling = sampledDoc.sampling;
    // ONGOING detection runs BEFORE the fit lift — the marquee tie-break reads the flag.
    sampling.ongoing = markOngoing(sampledDoc);
    if (sampling.staticDropped) console.log(`  · ${sampling.staticDropped} static series dropped (no value change across ${runA.record.frames} frame(s)) — receipted, not recorded`);
    if (sampling.ongoing) console.log(`  · ${sampling.ongoing} track(s) marked ongoing — still moving in the final frames, no settle observed; a one-shot clip cannot implement these (see motion apply-sampled)`);
    if (sampling.writesMerged) console.log(`  · ${sampling.writesMerged} inline-style write(s) merged as evidence into provenance.source`);

    const lift = liftTier3Fits(sampledDoc, runA.record);
    for (const line of lift.log) console.log(`  ${line}`);

    const receiptFile = path.join(dir, "motion", args.id, "sample.json");
    const receiptBase = {
      schema: "pingfusi/motion-sample@1",
      at: new Date().toISOString(),
      target: args.name, item: args.id, url, viewport,
      fps: args.fps, frames: args.frames, stepMs,
      trigger: item.trigger || "load", scopes, props: DENSE_PROPS,
      virtualTime: runA.vtReceipt,
      settle: runA.settle,
      probe: { where: "about:blank (a stepped clock cannot re-prove rAF on the loaded page)", rafHz: runA.probe.rafHz },
      recorder: {
        tracking: runA.startInfo.tracking, skipped: runA.startInfo.skipped,
        writesObserved: !!runA.record.writesObserved, truncated: !!runA.record.truncated,
        writes: (runA.record.writes || []).length,
      },
      sampling, determinism, fit: lift.receipt,
    };
    const failWithReceipt = (reason) => {
      fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
      fs.writeFileSync(receiptFile, JSON.stringify({ ...receiptBase, ok: false, reason }, null, 2) + "\n");
      console.error(`✗ ${reason}`);
      console.error(`  receipt: ${path.relative(WORK, receiptFile)}`);
      return 1;
    };

    if (determinism.runs === 2 && !determinism.identical) {
      code = failWithReceipt(`two virtual-time runs did not produce identical samples — first difference: ${determinism.firstDifference}. A sampled record that cannot be reproduced cannot be verified; nothing was merged and the item was not advanced.`);
    } else if (!sampledDoc.tracks.length) {
      code = failWithReceipt(`every sampled series was static under trigger "${item.trigger || "load"}" (${sampling.staticDropped} series unchanged across ${runA.record.frames} frame(s)) — nothing animates in scope ${JSON.stringify(scopes)} at ${args.fps}fps; the item was not advanced.`);
    } else {
      // Merge into the canonical doc — additive, fingerprint-deduped (addTrack). A fit
      // rides along only where no prior fit exists: additive, never a clobber.
      const existing = readMotionDoc(dir);
      const doc = existing.doc || motionDoc.emptyDoc({ url, viewport });
      const sampledTrackIds = [];
      for (const track of sampledDoc.tracks) {
        const canonical = motionDoc.addTrack(doc, track);
        // Additive, except the tie-break: a marquee on an ongoing track beats a finite
        // fit a previous sample attached (ongoing beats finite when ongoing:true).
        const marqueeWins = track.fit && track.fit.kind === "marquee" && track.ongoing === true &&
          canonical.fit && canonical.fit.kind !== "marquee";
        if (track.fit && (!canonical.fit || marqueeWins)) canonical.fit = track.fit;
        if (track.ongoing === true && canonical.ongoing !== true) canonical.ongoing = true;
        sampledTrackIds.push(canonical.id);
      }
      motionDoc.validateMotionDoc(doc);
      fs.writeFileSync(path.join(dir, "motion-doc.json"), JSON.stringify(doc, null, 2));

      fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
      fs.writeFileSync(receiptFile, JSON.stringify({
        ...receiptBase, ok: true, sampledTrackIds,
        doc: { file: `targets/${args.name}/motion-doc.json`, tracks: doc.tracks.length },
      }, null, 2) + "\n");

      const now = new Date().toISOString();
      updateMotionItem(dir, args.id, {
        status: "sampled", // NON-terminal by design: apply-sampled/verify-sampled own the walk to verified-sampled
        sampledTrackIds,
        sampledAt: now,
        sampleReceipt: path.relative(WORK, receiptFile),
      });
      try {
        const wf = require("./workflow.js");
        wf.appendLedger(args.name, {
          ts: now, event: "motion-sample", phase: null, runId: wf.runId(), gate: null, forced: false,
          item: args.id,
          reason: `sampled ${sampledTrackIds.length} track(s) via ${runA.vtReceipt.mode} @ ${args.fps}fps x ${args.frames} frame(s) (${sampling.staticDropped} static dropped${determinism.runs === 2 ? ", determinism verified" : ""}${lift.receipt.attached.length ? `, ${lift.receipt.attached.length} fit(s) attached` : ""})`,
        });
      } catch (e) { console.log(`  ⚠ workflow.jsonl receipt failed (sampling unaffected): ${firstLine(e)}`); }

      console.log(`✓ sampled — ${sampledTrackIds.length} track(s) merged into targets/${args.name}/motion-doc.json (tier "sampled", virtual-time@${args.fps}fps)`);
      console.log(`  receipt: ${path.relative(WORK, receiptFile)}`);
      console.log(`  item ${args.id} → status "sampled" (non-terminal) — next: ${CMD} motion apply-sampled ${args.name} ${args.id}, then ${CMD} motion verify-sampled ${args.name} ${args.id}`);
    }
  } catch (e) {
    console.error(`✗ ${firstLine(e)}`);
    code = 1;
  } finally {
    await acq.cleanup();
  }
  process.exit(code);
}

if (require.main === module) main();
module.exports = {
  DENSE_PROPS,
  HOOK_CLOCK_JS,
  SETTLE_FRAMES,
  VIRTUAL_EPOCH_S,
  // The one virtual-time capture core. `motion verify-sampled` (harness/motion-verify.js)
  // re-runs the IDENTICAL stimulus against the served clone through this export — never a
  // duplicate implementation, so live and clone can only ever be sampled the same way.
  captureOnce,
  drainNetwork,
  firstDiff,
  fitParams,
  frameDriveProbe,
  installNetworkPinning,
  liftTier3Fits,
  markOngoing,
  marqueeFromSeries,
  ONGOING_NOISE,
  parseArgs,
  parseTransformChannels,
  parseTrigger,
  releaseHeld,
  runFitBridge,
  sampledSeries,
  sampledValueDelta,
  trackIsOngoing,
};
