#!/usr/bin/env node
// motion-verify.js — the capture ladder's provenance-aware verification gates:
//   `pingfusi motion verify-introspected <name> <motion-id>`  (INTROSPECTED tracks)
//   `pingfusi motion verify-sampled     <name> <motion-id>`  (SAMPLED tracks;
//                                        dispatched here as `--sampled <name> <id>`)
//
// The capture ladder's top rung: a track whose provenance.tier is "introspected-*" was
// READ from the page's own engine declaration (document.getAnimations() for CSS/WAAPI,
// the public timeline API for GSAP), not reconstructed from pixels. Two such declarations
// either match or they do not, so the check is a KEYFRAME DIFF — never a trajectory
// re-fit, and never a review round: machine-verifiable is machine-verified, and a green
// check is a command that exits 0. Sampled tracks are reconstructions, so equality is
// not demanded of them — they get the deterministic per-frame replay diff below
// (verify-sampled); fitted tracks stay receipt-only engine-bundle machinery (see
// docs/WORKFLOW.md, "the capture ladder"). Both commands are machine receipts on the
// draft — warnings and routing, never blocking gates (first-draft doctrine).
//
// What one run does:
//   1. loads targets/<name>/motion-doc.json (LIVE side, written by capture-run) and
//      derives the item's introspected binding from its declared scope — exact selector
//      match only — recording it on the item (docTrackId + trackFingerprint, provenance
//      "introspected");
//   2. acquires the CLONE side's own introspected declarations the same way (kit-owned
//      headless Chrome over CDP running the same in-page readers) into
//      targets/<name>/motion-doc-clone.json — skipped when that file already exists;
//      --recapture forces a fresh read, --clone-doc <file> supplies one directly;
//   3. diffs live vs clone per bound track: keyframes (offset/value/easing normalized),
//      timing, timeline type — exact within the DOCUMENTED tolerance
//      (duration/delay ±1ms, numeric values ±0.01);
//   4. receipts the diff at targets/<name>/motion/<id>/verify-introspected.json.
//      Exit 0: every bound track matches → the item is terminal "verified-introspected".
//      Exit 1: the first differing keyframe is named.
//
// Provenance safety (machine-chain, never gating): only OWNED items may be verified
// (bindings only ever attach to owned items), raw sweep rows never reach this check, and
// nothing here runs on an ordinary clone that has no motion receipts to verify.
//
// ── verify-sampled: the SAMPLED tier's machine gate ─────────────────────────────────────
// A sampled track is a reconstruction, so exact keyframe equality cannot be demanded —
// but the sampled tier is DETERMINISTIC by construction (virtual time owns the clock on
// both sides), which makes a per-frame diff honest: re-run the IDENTICAL virtual-time
// sampling against the served clone (same fps/frames/trigger/scopes, read from the
// item's sample.json receipt, through motion-sampler.js's exported captureOnce — one
// capture core, never a duplicate), then compare every live sampled track's series
// frame-by-frame against the clone's.
//
// The documented sampled tolerance (TOLERANCE_SAMPLED): transform translate components
// ±1px per frame (sub-pixel compositing/rounding differs across renders of the same
// matrix; a real trajectory miss is tens of pixels), scale ±0.02 and rotation ±0.5deg
// (the same spelling noise on the other decomposed channels), opacity ±0.02 (computed
// opacity rounds to ~2 decimals), and ±0.02 on the numbers of any other sampled string
// value with an identical non-numeric skeleton. Discrete values (visibility) must match
// exactly. Coverage is part of the gate: every live sampled track must have a clone
// counterpart at the same selector (or the item's candidateSelector mapping) — a clone
// that does not animate there fails by name, it is not skipped.
//
// THE POST-WINDOW CHECK: the in-window diff certifies the window; the window's EDGE is
// where the observed miss lived (a 4s clip of a forever belt passed in-window, then the
// served clone froze one frame later — the gate only ever looked INSIDE the clip). So
// after the in-window diff passes, the clone capture runs W extra frames (default 30,
// --post-window) PAST the clip end under the same virtual clock. The live side's edge
// evidence is the record itself: an ONGOING track (no settle in its final frames — the
// sampler's detection, re-derived here from the keyframes) is motion that continues past
// the clip. live ongoing + clone static → exit 1 named "unterminated motion"; both
// settled at matching values → pass; a looping player must show the clone STILL MOVING
// at the fitted velocity (±tolerance); a clone that keeps animating where live settled
// fails too. In-window, an ongoing track is compared by its MOTION LAW (median per-frame
// velocity per decomposed channel, direction) rather than absolute phase — the looping
// form measures its wrap distance from the clone's own element at runtime, so absolute
// positions legitimately differ while the law must not.
//
// Exit 0 → the item is terminal "verified-sampled" (no review round — a green check is
// a command that exits 0). Mismatch → exit 1 naming the first offending track+frame;
// the item stays (or reopens to) "applied-sampled". Every run receipts the diff at
// targets/<name>/motion/<id>/verify-sampled.json, including which clock mode ran.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const cdp = require("./cdp.js");
const chrome = require("./chrome.js");
const motionDoc = require("./motion-doc.js");
const { serve } = require("./serve.js");
const {
  introspectedBindingFor,
  introspectedTracksForScope,
  isDeclaredItem,
  isTerminalMotionItem,
  readMotionDoc,
  readMotionItems,
  sampledTracksForItem,
  updateMotionItem,
} = require("./motion-items.js");
const sampler = require("./motion-sampler.js");

const WORK = process.cwd();
const VIA_PPK = process.env.PPK_ENTRY === "1";
const CMD = VIA_PPK ? "pingfusi" : "node harness/workflow.js";
const NAV_TIMEOUT_MS = 30000;
const READER_TIMEOUT_MS = 15000;
const SWEEP_TIMEOUT_MS = 60000;

// ── the documented tolerance ────────────────────────────────────────────────────────────
// duration/delay ±1ms: getComputedTiming() returns authored milliseconds, but a reader on
// either side may surface sub-ms float spelling (750 vs 750.0000001); anything past 1ms is
// an authored difference, not spelling. numeric ±0.01: keyframe values and offsets are
// authored numbers round-tripped through float formatting (translateX(-2125px) vs
// -2125.0000004px); 0.01 absorbs the spelling while any real edit (a different px, a
// different opacity stop) still fails by orders of magnitude.
const TOLERANCE = { durationMs: 1, delayMs: 1, numeric: 0.01 };

const NUM_RE = /-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi;

function canonicalText(value, fallback = "") {
  return String(value == null ? fallback : value).trim().replace(/\s+/g, " ").toLowerCase();
}

// A value matches when its NON-numeric skeleton is identical and every number is within
// ±TOLERANCE.numeric — "translateX(-2125px)" vs "translateX(-2125.004px)" passes,
// "translateX(-1000px)" or "translateY(-2125px)" fails.
function valueSkeleton(value) {
  return canonicalText(value).replace(NUM_RE, "#");
}

function valueNumbers(value) {
  return (canonicalText(value).match(NUM_RE) || []).map(Number);
}

function numbersWithin(a, b, tol) {
  return a.length === b.length && a.every((n, i) => Math.abs(n - b[i]) <= tol);
}

function valuesMatch(live, clone) {
  return valueSkeleton(live) === valueSkeleton(clone) &&
    numbersWithin(valueNumbers(live), valueNumbers(clone), TOLERANCE.numeric);
}

// Easing normalization: the CSS keywords are DEFINED as exact beziers (css-easing-1), so
// canonicalizing a keyword to its bezier before comparing is spec-exact, not
// approximation — "linear" vs "cubic-bezier(0, 0, 1, 1)" is the same curve. An absent
// easing is the WAAPI default, "linear". Everything without a bezier form (steps(),
// spring names a GSAP track kept verbatim) must match as a string.
const EASE_KEYWORD_BEZIER = {
  "linear": [0, 0, 1, 1],
  "ease": [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

function easingBezier(canonical) {
  if (EASE_KEYWORD_BEZIER[canonical]) return EASE_KEYWORD_BEZIER[canonical];
  if (canonical.startsWith("cubic-bezier(")) {
    const nums = valueNumbers(canonical);
    return nums.length === 4 ? nums : null;
  }
  return null;
}

function easingsMatch(live, clone) {
  const a = canonicalText(live, "linear"), b = canonicalText(clone, "linear");
  if (a === b) return true;
  const ba = easingBezier(a), bb = easingBezier(b);
  return !!(ba && bb) && numbersWithin(ba, bb, TOLERANCE.numeric);
}

// WAAPI's missing-offset distribution, applied identically to both sides so `null`
// spelled by one reader and a computed number spelled by the other compare as the same
// position: specified offsets are authoritative; a single all-null frame is the to-frame
// (offset 1); otherwise null edges pin to 0/1 and interior nulls spread evenly between
// the nearest specified anchors.
function normalizedOffsets(keyframes) {
  const n = keyframes.length;
  const out = keyframes.map((kf) => (typeof kf.offset === "number" && isFinite(kf.offset) ? kf.offset : null));
  if (!n) return out;
  if (n === 1) { if (out[0] == null) out[0] = 1; return out; }
  if (out[0] == null) out[0] = 0;
  if (out[n - 1] == null) out[n - 1] = 1;
  let i = 1;
  while (i < n - 1) {
    if (out[i] != null) { i++; continue; }
    let j = i;
    while (out[j] == null) j++;
    const lo = out[i - 1], hi = out[j], span = j - (i - 1);
    for (let k = i; k < j; k++) out[k] = lo + ((k - (i - 1)) / span) * (hi - lo);
    i = j;
  }
  return out;
}

// One live introspected track vs one clone candidate. Returns miss strings, each naming
// the exact field and both values so a failure is actionable — the FIRST keyframe miss is
// what the exit-1 message carries.
function diffIntrospectedTrack(live, clone) {
  const misses = [];
  const lk = live.keyframes || [], ck = clone.keyframes || [];
  if (lk.length !== ck.length) {
    misses.push(`keyframes.length live=${lk.length} clone=${ck.length}`);
    return misses;
  }
  const lo = normalizedOffsets(lk), co = normalizedOffsets(ck);
  for (let i = 0; i < lk.length; i++) {
    if (Math.abs(lo[i] - co[i]) > TOLERANCE.numeric) {
      misses.push(`keyframes[${i}].offset live=${lo[i]} clone=${co[i]} (outside ±${TOLERANCE.numeric})`);
    }
    if (!valuesMatch(lk[i].value, ck[i].value)) {
      misses.push(`keyframes[${i}].value live=${JSON.stringify(lk[i].value)} clone=${JSON.stringify(ck[i].value)} (numbers ±${TOLERANCE.numeric}, structure exact)`);
    }
    if (!easingsMatch(lk[i].easing, ck[i].easing)) {
      misses.push(`keyframes[${i}].easing live=${JSON.stringify(lk[i].easing || "linear")} clone=${JSON.stringify(ck[i].easing || "linear")}`);
    }
    // composite defaults to "auto" on both readers; only an explicit disagreement is real.
    const lcomp = lk[i].composite || "auto", ccomp = ck[i].composite || "auto";
    if (lcomp !== ccomp) misses.push(`keyframes[${i}].composite live="${lcomp}" clone="${ccomp}"`);
  }

  const lt = live.timing || {}, ct = clone.timing || {};
  if (Math.abs((lt.duration_ms || 0) - (ct.duration_ms || 0)) > TOLERANCE.durationMs) {
    misses.push(`timing.duration_ms live=${lt.duration_ms} clone=${ct.duration_ms} (outside ±${TOLERANCE.durationMs}ms)`);
  }
  if (Math.abs((lt.delay_ms || 0) - (ct.delay_ms || 0)) > TOLERANCE.delayMs) {
    misses.push(`timing.delay_ms live=${lt.delay_ms} clone=${ct.delay_ms} (outside ±${TOLERANCE.delayMs}ms)`);
  }
  if (lt.iterations !== ct.iterations) misses.push(`timing.iterations live=${JSON.stringify(lt.iterations)} clone=${JSON.stringify(ct.iterations)}`);
  if ((lt.direction || "normal") !== (ct.direction || "normal")) misses.push(`timing.direction live="${lt.direction}" clone="${ct.direction}"`);
  if ((lt.fill || "auto") !== (ct.fill || "auto")) misses.push(`timing.fill live="${lt.fill}" clone="${ct.fill}"`);
  const lrate = lt.playbackRate == null ? 1 : lt.playbackRate; // WAAPI default
  const crate = ct.playbackRate == null ? 1 : ct.playbackRate;
  if (Math.abs(lrate - crate) > TOLERANCE.numeric) misses.push(`timing.playbackRate live=${lrate} clone=${crate} (outside ±${TOLERANCE.numeric})`);

  const ltl = live.timeline || { type: "document" }, ctl = clone.timeline || { type: "document" };
  if (ltl.type !== ctl.type) misses.push(`timeline.type live="${ltl.type}" clone="${ctl.type}"`);
  else if (ltl.type !== "document") {
    // Live is authoritative for the scroll/view binding it recorded: every field the live
    // reader saw must be reproduced (source/range compare exact — they are authored refs).
    for (const key of ["source", "rangeStart", "rangeEnd"]) {
      if (ltl[key] !== undefined && ltl[key] !== ctl[key]) {
        misses.push(`timeline.${key} live=${JSON.stringify(ltl[key])} clone=${JSON.stringify(ctl[key])}`);
      }
    }
  }
  return misses;
}

// The scope-level verdict, pure over two docs. Every live introspected track under the
// scope must have an exactly matching clone counterpart (same selector + property, any
// introspected tier — the clone may legitimately declare the same curve through a
// different engine; the keyframes/timing are the contract, the tier is the acquisition
// receipt). Extra clone tracks are recorded in the receipt, never a failure — the gate
// certifies the declared motion, not the clone's whole animation inventory.
function verifyIntrospectedScope(liveDoc, cloneDoc, scope) {
  const liveTracks = introspectedTracksForScope(liveDoc, scope);
  const results = [];
  for (const live of liveTracks) {
    const wanted = String(live.target.selector).trim();
    const candidates = ((cloneDoc && cloneDoc.tracks) || []).filter((track) => track && track.provenance &&
      /^introspected-/.test(String(track.provenance.tier || "")) &&
      track.target && String(track.target.selector || "").trim() === wanted &&
      track.property === live.property);
    let best = null;
    if (!candidates.length) {
      best = {
        ok: false,
        misses: [`no introspected "${live.property}" track on the clone for selector ${wanted} — the clone must DECLARE the same animation (CSS/WAAPI/GSAP), not approximate it`],
      };
    } else {
      for (const candidate of candidates) {
        const misses = diffIntrospectedTrack(live, candidate);
        if (!best || misses.length < best.misses.length) best = { ok: misses.length === 0, misses, cloneTrackId: candidate.id };
        if (!misses.length) break;
      }
    }
    results.push({
      docTrackId: live.id,
      selector: wanted,
      property: live.property,
      tier: live.provenance.tier,
      fingerprint: motionDoc.trackFingerprint(live),
      ...best,
    });
  }
  const failing = results.find((r) => !r.ok) || null;
  return {
    ok: results.length > 0 && !failing,
    tracks: results,
    firstMismatch: failing ? `${failing.selector} ${failing.property}: ${failing.misses[0]}` : null,
  };
}

// ── clone-side acquisition ──────────────────────────────────────────────────────────────
// The same in-page readers the live runner uses (tools/browser-capture.js
// pxIntrospectAnimations / pxProbeGsap), in a kit-owned invisible Chrome, against the
// self-served clone (or --clone-url). The sweep is the minimal form of the discovery
// stimulus so scroll-armed declarations are running when the readers look.
const SWEEP_JS = `(async () => {
  const step = Math.max(200, Math.floor(innerHeight * 0.8));
  const max = Math.max((document.documentElement.scrollHeight || 0) - innerHeight, 0);
  for (let y = 0; y <= max; y += step) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
  scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 300));
  return true;
})()`;

// Compact form of capture-runner's reader-envelope unwrap: bare array or {records} pass,
// "engine absent" is an empty read, anything else is a named refusal.
function readerRecords(fn, ret, warnings) {
  if (Array.isArray(ret)) return ret;
  if (ret && typeof ret === "object") {
    if (ret.supported === false) { warnings.push(`${fn}: document.getAnimations is not supported on the clone page`); return null; }
    if (ret.present === false) return [];
    if (ret.unsupported) { warnings.push(`${fn}: engine version ${String(ret.unsupported).slice(0, 40)} is not supported`); return null; }
    if (Array.isArray(ret.records)) return ret.records;
  }
  warnings.push(`${fn} returned ${ret == null ? String(ret) : typeof ret} without a records array`);
  return null;
}

async function captureCloneMotionDoc(name, opts = {}) {
  const dir = path.join(WORK, "targets", name);
  let target = {};
  try { target = JSON.parse(fs.readFileSync(path.join(dir, "target.json"), "utf8")); } catch (_) {}
  let liveSnap = null;
  try { liveSnap = JSON.parse(fs.readFileSync(path.join(dir, "live.json"), "utf8")); } catch (_) {}
  const viewport = chrome.resolveViewport({ target, live: liveSnap });

  let server = null;
  let url = opts.cloneUrl || null;
  if (!url) {
    if (!fs.existsSync(path.join(dir, "clone", "index.html"))) {
      throw new Error(`no targets/${name}/clone/index.html to read the clone's declarations from — build it first (${CMD} capture-build ${name}) or pass --clone-url <url>`);
    }
    server = serve(name, 0);
    await new Promise((resolve) => server.on("listening", resolve));
    url = `http://127.0.0.1:${server.address().port}/`;
  }

  const acq = await chrome.acquire({
    attach: opts.attach, chromePath: opts.chrome, headless: !opts.headful,
    width: viewport.width, height: 1050,
  });
  try {
    const { session, targetId } = await cdp.openPage(acq.port, { host: acq.host });
    try {
      await chrome.normalizeViewport(session, viewport);
      await cdp.navigate(session, url, { timeoutMs: NAV_TIMEOUT_MS, warn: () => {} });
      const probe = await chrome.probeEnvironment(session);
      if (!probe.verdict.ok) {
        throw new Error(`environment refused on the clone page: ${probe.verdict.reason}${opts.headful ? "" : " — re-run with --headful"}`);
      }
      const captureSource = fs.readFileSync(path.join(__dirname, "..", "tools", "browser-capture.js"), "utf8");
      await cdp.evaluate(session, captureSource, { awaitPromise: false });
      await cdp.evaluate(session, SWEEP_JS, { timeoutMs: SWEEP_TIMEOUT_MS });

      const warnings = [];
      const doc = motionDoc.emptyDoc({ url, viewport });
      const readers = [
        { fn: "pxIntrospectAnimations", convert: motionDoc.fromIntrospection },
        { fn: "pxProbeGsap", convert: motionDoc.fromGsap },
      ];
      for (const reader of readers) {
        let ret;
        try { ret = await cdp.evaluate(session, `${reader.fn}()`, { timeoutMs: READER_TIMEOUT_MS }); }
        catch (e) { warnings.push(`${reader.fn} failed: ${String((e && e.message) || e).split("\n")[0]}`); continue; }
        const records = readerRecords(reader.fn, ret, warnings);
        if (!records) continue;
        // one record at a time, same as the live runner — a malformed record costs itself
        for (const record of records) {
          try { for (const track of reader.convert([record], { url, viewport }).tracks) motionDoc.addTrack(doc, track); }
          catch (e) { warnings.push(`${reader.fn} record refused: ${String((e && e.message) || e).split("\n")[0]}`); }
        }
      }
      motionDoc.validateMotionDoc(doc);
      const file = path.join(dir, "motion-doc-clone.json");
      fs.writeFileSync(file, JSON.stringify(doc, null, 2));
      for (const w of warnings) console.log(`  ⚠ ${w}`);
      console.log(`  ✓ motion-doc-clone.json (${doc.tracks.length} track(s))`);
      return doc;
    } finally {
      session.close();
      await cdp.closeTab(acq.port, targetId, { host: acq.host });
    }
  } finally {
    if (server) server.close();
    await acq.cleanup();
  }
}

// ── the SAMPLED tier's gate ─────────────────────────────────────────────────────────────
// The documented sampled tolerance — see the module header for why each number is what
// it is. Per-frame, per-channel; a real trajectory miss fails by orders of magnitude.
const TOLERANCE_SAMPLED = {
  translatePx: 1,   // decomposed tx/ty per frame
  scale: 0.02,      // decomposed sx/sy per frame
  rotateDeg: 0.5,   // decomposed rotation per frame
  opacity: 0.02,    // computed opacity rounds to ~2 decimals
  numeric: 0.02,    // numbers inside any other sampled string value (identical skeleton)
};

// Post-window width: frames sampled PAST the clip end (same virtual clock) so the gate
// sees the edge it used to be blind to. 30 frames = half a second at 60fps — enough for
// a frozen clone to be unmistakably static and a looping clone to show its velocity.
const POST_WINDOW_FRAMES = 30;

// Per-channel tolerance/noise for the motion-law comparisons: tolerance is the documented
// sampled tolerance per frame; noise is the sampler's ongoing-detection floor (below it,
// "movement" is sub-pixel spelling, not motion).
function channelTolerance(property, channel) {
  if (property === "transform") {
    if (channel === "tx" || channel === "ty") return TOLERANCE_SAMPLED.translatePx;
    if (channel === "rot") return TOLERANCE_SAMPLED.rotateDeg;
    return TOLERANCE_SAMPLED.scale;
  }
  return property === "opacity" ? TOLERANCE_SAMPLED.opacity : TOLERANCE_SAMPLED.numeric;
}
function channelNoise(property, channel) {
  const N = sampler.ONGOING_NOISE;
  if (property === "transform") {
    if (channel === "tx" || channel === "ty") return N.translatePx;
    if (channel === "rot") return N.rotateDeg;
    return N.scale;
  }
  return property === "opacity" ? N.opacity : N.numeric;
}

// Consecutive-frame deltas per decomposed channel; null when the property carries no
// numeric law (discrete values — visibility).
function perFrameDeltas(property, values) {
  if (property === "transform") {
    const dec = values.map((v) => sampler.parseTransformChannels(v));
    if (!dec.every(Boolean)) return null;
    const out = { tx: [], ty: [], sx: [], sy: [], rot: [] };
    for (let i = 1; i < dec.length; i++) for (const c of Object.keys(out)) out[c].push(dec[i][c] - dec[i - 1][c]);
    return out;
  }
  const nums = values.map((v) => parseFloat(v));
  if (!nums.every((n) => isFinite(n))) return null;
  const out = { value: [] };
  for (let i = 1; i < nums.length; i++) out.value.push(nums[i] - nums[i - 1]);
  return out;
}

// The median per-frame delta is the robust velocity read: a belt's wrap tick (the loop
// recycling — one opposite-sign jump of ~a full period) is a single spike the median
// ignores, on the live and the clone side alike.
function medianOf(list) {
  if (!list || !list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// One live sampled keyframe value vs the clone's, by property. Returns null on a match
// or the miss detail (without the frame prefix — the caller names the frame).
function sampledValueMiss(property, live, clone) {
  if (property === "transform") {
    const a = sampler.parseTransformChannels(live);
    const b = sampler.parseTransformChannels(clone);
    if (a && b) {
      if (Math.abs(a.tx - b.tx) > TOLERANCE_SAMPLED.translatePx || Math.abs(a.ty - b.ty) > TOLERANCE_SAMPLED.translatePx) {
        return `translate live=(${a.tx}, ${a.ty}) clone=(${b.tx}, ${b.ty}) (outside ±${TOLERANCE_SAMPLED.translatePx}px)`;
      }
      if (Math.abs(a.sx - b.sx) > TOLERANCE_SAMPLED.scale || Math.abs(a.sy - b.sy) > TOLERANCE_SAMPLED.scale) {
        return `scale live=(${a.sx}, ${a.sy}) clone=(${b.sx}, ${b.sy}) (outside ±${TOLERANCE_SAMPLED.scale})`;
      }
      if (Math.abs(a.rot - b.rot) > TOLERANCE_SAMPLED.rotateDeg) {
        return `rotation live=${a.rot}deg clone=${b.rot}deg (outside ±${TOLERANCE_SAMPLED.rotateDeg}deg)`;
      }
      return null;
    }
    // Non-matrix transform spelling (computed transform is matrix form; anything else is
    // unexpected) — fall through to the skeleton+numbers comparison below.
  }
  if (property === "opacity") {
    const a = parseFloat(live), b = parseFloat(clone);
    if (isFinite(a) && isFinite(b)) {
      return Math.abs(a - b) <= TOLERANCE_SAMPLED.opacity ? null : `value live=${a} clone=${b} (outside ±${TOLERANCE_SAMPLED.opacity})`;
    }
  }
  if (property === "visibility") {
    // discrete — a tolerance would invent states the screen never showed
    return canonicalText(live) === canonicalText(clone) ? null : `value live=${JSON.stringify(live)} clone=${JSON.stringify(clone)} (discrete — must match exactly)`;
  }
  if (valueSkeleton(live) === valueSkeleton(clone) && numbersWithin(valueNumbers(live), valueNumbers(clone), TOLERANCE_SAMPLED.numeric)) return null;
  return `value live=${JSON.stringify(live)} clone=${JSON.stringify(clone)} (numbers ±${TOLERANCE_SAMPLED.numeric}, structure exact)`;
}

// One live sampled track vs one clone candidate: same frame count (both sides sampled
// the same declared frames), then every frame's value within the sampled tolerance. The
// FIRST offending frame is what the exit-1 message carries.
function diffSampledTrack(live, clone) {
  const misses = [];
  const lk = live.keyframes || [], ck = clone.keyframes || [];
  if (lk.length !== ck.length) {
    misses.push(`keyframes.length live=${lk.length} clone=${ck.length} — both sides sample the same declared frame count; a shorter clone series means its sampling was cut or its motion collapsed to static`);
    return misses;
  }
  for (let i = 0; i < lk.length; i++) {
    const miss = sampledValueMiss(live.property, lk[i].value, ck[i].value);
    if (miss) misses.push(`frame ${i} ${miss}`);
  }
  const ld = (live.timing && live.timing.duration_ms) || 0;
  const cd = (clone.timing && clone.timing.duration_ms) || 0;
  if (Math.abs(ld - cd) > TOLERANCE.durationMs) {
    misses.push(`timing.duration_ms live=${ld} clone=${cd} — the virtual spans differ, so the series are not comparable frame-by-frame`);
  }
  return misses;
}

// An ONGOING live track cannot owe the clone absolute phase: the clone's looping form
// measures its wrap distance from its own element at runtime, so positions legitimately
// differ while the MOTION LAW must not. Compared per decomposed channel: median per-frame
// velocity within the documented tolerance, and matching direction wherever the live side
// really moves. Discrete properties fall back to the exact per-frame diff — there is no
// law to compare, only states.
function diffOngoingSampledTrack(live, clone) {
  const lk = live.keyframes || [], ck = clone.keyframes || [];
  if (lk.length !== ck.length) {
    return [`keyframes.length live=${lk.length} clone=${ck.length} — both sides sample the same declared frame count; a shorter clone series means its sampling was cut or its motion collapsed to static`];
  }
  const ld = perFrameDeltas(live.property, lk.map((kf) => kf.value));
  const cd = perFrameDeltas(clone.property, ck.map((kf) => kf.value));
  if (!ld || !cd) return diffSampledTrack(live, clone);
  const misses = [];
  for (const channel of Object.keys(ld)) {
    const lm = medianOf(ld[channel]);
    const cm = medianOf(cd[channel] || []);
    const tol = channelTolerance(live.property, channel);
    const noise = channelNoise(live.property, channel);
    if (Math.abs(lm - cm) > tol) {
      misses.push(`ongoing ${channel} velocity live=${lm.toFixed(3)}/frame clone=${cm.toFixed(3)}/frame (outside ±${tol}/frame — an ongoing track owes the motion LAW, not the phase)`);
    } else if (Math.abs(lm) > noise && Math.sign(cm) !== Math.sign(lm)) {
      misses.push(`ongoing ${channel} direction live=${lm.toFixed(3)}/frame clone=${cm.toFixed(3)}/frame — the clone moves the wrong way`);
    }
  }
  const ldur = (live.timing && live.timing.duration_ms) || 0;
  const cdur = (clone.timing && clone.timing.duration_ms) || 0;
  if (Math.abs(ldur - cdur) > TOLERANCE.durationMs) {
    misses.push(`timing.duration_ms live=${ldur} clone=${cdur} — the virtual spans differ, so the series are not comparable frame-by-frame`);
  }
  return misses;
}

// The item's live→clone selector mapping (candidateSelectors {live: clone} per selector,
// or one candidateSelector string for a single-scope item), shared by the in-window and
// post-window halves so they can never bind to different clone elements.
function cloneSelectorFor(item, liveSelector) {
  const map = item && item.candidateSelectors && typeof item.candidateSelectors === "object" ? item.candidateSelectors : {};
  const single = item && typeof item.candidateSelector === "string" && item.candidateSelector.trim() ? item.candidateSelector.trim() : null;
  return (typeof map[liveSelector] === "string" && map[liveSelector].trim()) || single || liveSelector;
}

// The item-level verdict, pure over the live tracks and the clone's sampled doc. Every
// live sampled track must have a clone counterpart at the same selector (or the item's
// candidateSelector mapping) — coverage IS part of the gate. An ongoing live track is
// compared by its motion law (diffOngoingSampledTrack), a finite one frame-by-frame.
function verifySampledTracks(liveTracks, cloneDoc, item = {}) {
  const results = [];
  for (const live of liveTracks) {
    const liveSelector = String(live.target.selector).trim();
    const cloneSelector = cloneSelectorFor(item, liveSelector);
    const ongoing = live.ongoing === true || sampler.trackIsOngoing(live);
    const candidates = ((cloneDoc && cloneDoc.tracks) || []).filter((track) => track && track.provenance &&
      String(track.provenance.tier || "") === "sampled" &&
      track.target && String(track.target.selector || "").trim() === cloneSelector &&
      track.property === live.property);
    let best = null;
    if (!candidates.length) {
      best = {
        ok: false,
        misses: [`no sampled "${live.property}" track on the clone for selector ${cloneSelector} — nothing animated there under the identical virtual-time stimulus (is the replay applied and served? pingfusi motion apply-sampled, then re-run)`],
      };
    } else {
      for (const candidate of candidates) {
        const misses = ongoing ? diffOngoingSampledTrack(live, candidate) : diffSampledTrack(live, candidate);
        if (!best || misses.length < best.misses.length) best = { ok: misses.length === 0, misses, cloneTrackId: candidate.id };
        if (!misses.length) break;
      }
    }
    results.push({
      docTrackId: live.id,
      selector: liveSelector,
      cloneSelector,
      property: live.property,
      ongoing,
      frames: (live.keyframes || []).length,
      fingerprint: motionDoc.trackFingerprint(live),
      ...best,
      // the receipt stays readable: the first few misses, plus the count
      misses: best.misses.slice(0, 5),
      missCount: best.misses.length,
    });
  }
  const failing = results.find((r) => !r.ok) || null;
  return {
    ok: results.length > 0 && !failing,
    tracks: results,
    firstMismatch: failing ? `${failing.selector} ${failing.property}: ${failing.misses[0]}` : null,
  };
}

// ── the post-window split + verdict ─────────────────────────────────────────────────────
// The clone record runs `frames + W` steps on one virtual clock; the first `frames` are
// the in-window doc (identical span to the live record), the tail is the edge evidence.
// The boundary sample rides with the tail so the first post-window delta crosses the
// clip edge itself.
function splitCloneRecord(record, frames) {
  const inWindow = {
    ...record,
    frames: Math.min(frames, typeof record.frames === "number" && isFinite(record.frames) ? record.frames : frames),
    elements: (record.elements || []).map((el) => ({ ...el, samples: Array.isArray(el.samples) ? el.samples.slice(0, frames) : [] })),
  };
  const post = {};
  for (const el of record.elements || []) {
    const selector = typeof el.selector === "string" && el.selector.trim() ? el.selector.trim() : null;
    if (!selector || !Array.isArray(el.samples)) continue;
    const tail = el.samples.slice(Math.max(0, frames - 1));
    if (tail.length < 2) continue;
    const props = {};
    for (const key of Object.keys((tail[0] && tail[0].values) || {})) {
      props[key] = tail.map((s) => {
        const v = s && s.values ? s.values[key] : null;
        return v == null ? "" : String(v);
      });
    }
    post[selector] = props;
  }
  return { inWindow, post };
}

// Pure over the live tracks and the clone's post-window samples. Four quadrants, all
// named: live ongoing + clone static is the encoded miss ("unterminated motion"); live
// ongoing + clone moving must move at the fitted velocity (marquee fit) or live's own
// law; live settled + clone moving is a clone that never releases; both settled must
// agree on the settle value.
function verifyPostWindow(liveTracks, post, item = {}, opts = {}) {
  const stepMs = typeof opts.stepMs === "number" && isFinite(opts.stepMs) ? opts.stepMs : 0;
  const results = [];
  for (const live of liveTracks) {
    const liveSelector = String(live.target.selector).trim();
    const cloneSelector = cloneSelectorFor(item, liveSelector);
    const ongoing = live.ongoing === true || sampler.trackIsOngoing(live);
    const values = post[cloneSelector] && post[cloneSelector][live.property];
    const row = { docTrackId: live.id, selector: liveSelector, cloneSelector, property: live.property, ongoing };
    let miss = null;
    if (!values || values.length < 2) {
      miss = `no post-window samples for ${cloneSelector} ${live.property} — the clone capture must extend past the clip end, and this record does not`;
    } else {
      const deltas = perFrameDeltas(live.property, values);
      if (!deltas) {
        // discrete property: moving = any state change in the tail
        const moving = values.some((v, i) => i > 0 && v !== values[i - 1]);
        row.cloneMoving = moving;
        if (ongoing && !moving) miss = `unterminated motion: live continues past the clip, clone froze — ${cloneSelector} ${live.property} static across ${values.length - 1} post-window frame(s)`;
        else if (!ongoing && moving) miss = `the clone keeps animating past the clip while live settled — ${cloneSelector} ${live.property} still changing in the post window`;
        else if (!ongoing) {
          const settle = live.keyframes.length ? live.keyframes[live.keyframes.length - 1].value : null;
          const vm = settle == null ? null : sampledValueMiss(live.property, settle, values[values.length - 1]);
          if (vm) miss = `the clone settled past the clip at the wrong value — ${cloneSelector} ${live.property} ${vm}`;
        }
      } else {
        const medians = {};
        let moving = false;
        for (const channel of Object.keys(deltas)) {
          medians[channel] = +medianOf(deltas[channel]).toFixed(4);
          if (Math.abs(medians[channel]) > channelNoise(live.property, channel)) moving = true;
        }
        row.cloneMoving = moving;
        row.medianPerFrame = medians;
        if (ongoing && !moving) {
          miss = `unterminated motion: live continues past the clip, clone froze — ${cloneSelector} ${live.property} static across ${values.length - 1} post-window frame(s)`;
        } else if (ongoing && moving) {
          const fit = live.fit && live.fit.kind === "marquee" && live.fit.params && typeof live.fit.params === "object" ? live.fit.params : null;
          if (fit && typeof fit.velocityPxPerSec === "number" && isFinite(fit.velocityPxPerSec) && live.property === "transform") {
            const channel = fit.channel === "ty" || fit.axis === "y" ? "ty" : "tx";
            const expected = (fit.direction === -1 ? -1 : 1) * fit.velocityPxPerSec * stepMs / 1000;
            row.expectedPerFrame = { channel, value: +expected.toFixed(4) };
            const got = medians[channel] || 0;
            if (Math.abs(got - expected) > TOLERANCE_SAMPLED.translatePx) {
              miss = `the clone keeps moving past the clip but at the wrong velocity — ${cloneSelector} ${live.property} ${channel} ${got.toFixed(3)}px/frame vs fitted ${expected.toFixed(3)}px/frame (outside ±${TOLERANCE_SAMPLED.translatePx}px/frame)`;
            }
          } else {
            const liveDeltas = perFrameDeltas(live.property, (live.keyframes || []).map((kf) => kf.value));
            if (liveDeltas) {
              for (const channel of Object.keys(liveDeltas)) {
                const lm = medianOf(liveDeltas[channel]);
                const cm = medians[channel] || 0;
                const tol = channelTolerance(live.property, channel);
                if (Math.abs(lm - cm) > tol) {
                  miss = `the clone keeps moving past the clip but off the live law — ${cloneSelector} ${live.property} ${channel} ${cm.toFixed(3)}/frame vs live ${lm.toFixed(3)}/frame (outside ±${tol}/frame)`;
                  break;
                }
              }
            }
          }
        } else if (!ongoing && moving) {
          miss = `the clone keeps animating past the clip while live settled — ${cloneSelector} ${live.property} still changing in the post window (a finished clip must release, not replay)`;
        } else {
          const settle = live.keyframes.length ? live.keyframes[live.keyframes.length - 1].value : null;
          const vm = settle == null ? null : sampledValueMiss(live.property, settle, values[values.length - 1]);
          if (vm) miss = `the clone settled past the clip at the wrong value — ${cloneSelector} ${live.property} ${vm}`;
        }
      }
    }
    row.ok = !miss;
    if (miss) row.miss = miss;
    results.push(row);
  }
  const failing = results.find((r) => !r.ok) || null;
  return {
    ok: results.length > 0 && !failing,
    tracks: results,
    firstMismatch: failing ? failing.miss : null,
  };
}

// ── clone-side sampled acquisition — the sampler's own capture core, re-aimed ───────────
async function captureCloneSampled(name, spec, opts = {}) {
  const dir = path.join(WORK, "targets", name);
  let server = null;
  let url = opts.cloneUrl || null;
  if (!url) {
    if (!fs.existsSync(path.join(dir, "clone", "index.html"))) {
      throw new Error(`no targets/${name}/clone/index.html to re-sample — build it first (${CMD} capture-build ${name}) or pass --clone-url <url>`);
    }
    server = serve(name, 0);
    await new Promise((resolve) => server.on("listening", resolve));
    url = `http://127.0.0.1:${server.address().port}/`;
  }
  const acq = await chrome.acquire({
    attach: opts.attach, chromePath: opts.chrome, headless: !opts.headful,
    width: spec.viewport.width, height: 1050,
  });
  try {
    const ctx = {
      args: { headful: opts.headful, navTimeout: opts.navTimeout || NAV_TIMEOUT_MS, frames: spec.frames },
      acq,
      viewport: spec.viewport,
      url,
      trigger: spec.trigger,
      scopes: spec.scopes,
      stepMs: spec.stepMs,
      props: spec.props,
      // The clone is a deterministic local page: the generated replay arms AT the trigger,
      // so the record must begin there too — the live side's long settle (which absorbs
      // wall races a real site carries) would instead skip the replay's first seconds.
      settleFrames: 3,
      // WAAPI plays on the compositor's clock, which neither clock mode owns: every
      // recorded frame is POSED via animation.currentTime before it is read.
      driveWaapi: true,
      captureSource: fs.readFileSync(path.join(__dirname, "..", "tools", "browser-capture.js"), "utf8"),
    };
    const run = await sampler.captureOnce(ctx);
    run.vtReceipt = { ...run.vtReceipt, waapiDrive: "currentTime-per-step" };
    return { url, ...run };
  } finally {
    if (server) server.close();
    await acq.cleanup();
  }
}

function parseSampledArgs(argv) {
  const a = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--clone-url") a.cloneUrl = argv[++i];
    else if (v === "--attach") a.attach = argv[++i];
    else if (v === "--chrome") a.chrome = argv[++i];
    else if (v === "--headful") a.headful = true;
    else if (v === "--nav-timeout") a.navTimeout = +argv[++i];
    else if (v === "--post-window") a.postWindow = +argv[++i];
    else if (v.startsWith("--")) { console.error(`✗ unknown flag ${v}`); process.exit(2); }
    else rest.push(v);
  }
  a.name = rest[0];
  a.id = rest[1];
  return a;
}

async function mainSampled(argv) {
  const args = parseSampledArgs(argv);
  if (!args.name || !args.id) {
    console.error(`usage: ${CMD} motion verify-sampled <name> <motion-id> [--clone-url <url>] [--attach <port>] [--chrome <path>] [--headful] [--post-window <frames>]`);
    return 2;
  }
  if (args.postWindow !== undefined && (!Number.isInteger(args.postWindow) || args.postWindow < 1 || args.postWindow > 500)) {
    console.error(`✗ --post-window must be an integer in 1..500 (got ${args.postWindow}) — it is the frame count sampled PAST the clip end`);
    return 2;
  }
  const dir = path.join(WORK, "targets", args.name);

  let manifest;
  try { manifest = readMotionItems(dir); }
  catch (error) { console.error(`✗ targets/${args.name}/motion-items.json: ${error.message}`); return 2; }
  const item = manifest.items.find((candidate) => candidate.id === args.id);
  if (!item) { console.error(`✗ targets/${args.name}/motion-items.json has no item "${args.id}"`); return 2; }
  if (!isDeclaredItem(item)) {
    // The quarantine line, same as every gate here: enforcement is opt-in by declaration.
    console.error(`✗ motion item ${args.id} was never operator-declared — machine verification only runs on owned receipts; adopt it by recording owner provenance on the item in targets/${args.name}/motion-items.json (e.g. \"declaredBy\": \"manual\")`);
    return 2;
  }

  const liveRead = readMotionDoc(dir);
  if (!liveRead.doc) {
    console.error(`✗ targets/${args.name}/motion-doc.json ${liveRead.exists ? "is unreadable" : "is missing"} — the sampled record lives there; acquire it: ${CMD} motion sample ${args.name} ${args.id}`);
    return 1;
  }
  const liveTracks = sampledTracksForItem(item, liveRead.doc);
  if (!liveTracks.length) {
    console.error(`✗ motion item ${args.id} has no sampled tracks in targets/${args.name}/motion-doc.json — sample the live page first: ${CMD} motion sample ${args.name} ${args.id}`);
    return 1;
  }

  // The sample receipt IS the stimulus contract: the clone must be re-sampled under the
  // identical fps/frames/trigger/scopes/viewport or the two series are not comparable.
  const sampleReceiptFile = path.join(dir, "motion", args.id, "sample.json");
  let sampleReceipt;
  try { sampleReceipt = JSON.parse(fs.readFileSync(sampleReceiptFile, "utf8")); }
  catch (error) {
    console.error(`✗ targets/${args.name}/motion/${args.id}/sample.json is ${fs.existsSync(sampleReceiptFile) ? "unreadable" : "missing"} — it records the fps/frames/trigger the clone must be re-sampled under; re-run: ${CMD} motion sample ${args.name} ${args.id}`);
    return 1;
  }
  if (sampleReceipt.ok !== true) {
    console.error(`✗ the last sample run was refused (${sampleReceipt.reason || "no reason recorded"}) — a failed record cannot gate the clone; re-run: ${CMD} motion sample ${args.name} ${args.id}`);
    return 1;
  }
  const fps = sampleReceipt.fps;
  const frames = sampleReceipt.frames;
  const stepMs = sampleReceipt.stepMs || (fps ? 1000 / fps : null);
  const viewport = sampleReceipt.viewport;
  if (!fps || !frames || !stepMs || !viewport || !viewport.width) {
    console.error(`✗ the sample receipt is missing its fps/frames/viewport contract — re-run: ${CMD} motion sample ${args.name} ${args.id}`);
    return 1;
  }
  let trigger;
  try { trigger = sampler.parseTrigger(sampleReceipt.trigger); }
  catch (error) { console.error(`✗ ${String((error && error.message) || error).split("\n")[0]}`); return 1; }
  const scopes = Array.isArray(sampleReceipt.scopes) && sampleReceipt.scopes.length ? sampleReceipt.scopes : ["body"];
  const props = Array.isArray(sampleReceipt.props) && sampleReceipt.props.length ? sampleReceipt.props : sampler.DENSE_PROPS;

  // The clone capture extends past the clip end — same virtual clock, W extra frames —
  // so the post-window check can see the edge (the recorder caps at 2000 frames total).
  const postFrames = Math.max(1, Math.min(args.postWindow != null ? args.postWindow : POST_WINDOW_FRAMES, 2000 - frames));
  let run;
  try {
    run = await captureCloneSampled(args.name, { viewport, frames: frames + postFrames, stepMs, trigger, scopes, props }, args);
  } catch (error) {
    let msg = String((error && error.message) || error).split("\n")[0];
    if (/matched no recordable element/.test(msg)) {
      msg = `scope ${JSON.stringify(scopes)} matches no element on the CLONE — the replay cannot animate what the clone does not render; check clone/index.html, then re-run ${CMD} motion apply-sampled ${args.name} ${args.id}`;
    }
    console.error(`✗ clone-side sampling failed: ${msg}`);
    return 1;
  }
  const { inWindow, post } = splitCloneRecord(run.record, frames);
  const cloneDoc = motionDoc.fromSampled(inWindow, { url: run.url, viewport, fps });
  const cloneDocFile = path.join(dir, "motion-doc-clone-sampled.json");
  fs.writeFileSync(cloneDocFile, JSON.stringify(cloneDoc, null, 2));
  const liveMode = sampleReceipt.virtualTime && sampleReceipt.virtualTime.mode;
  if (liveMode && run.vtReceipt.mode !== liveMode) {
    console.log(`  ⚠ clock modes differ: live sampled under ${liveMode}, clone under ${run.vtReceipt.mode} — both deterministic, receipted either way`);
  }

  const verdict = verifySampledTracks(liveTracks, cloneDoc, item);
  // THE POST-WINDOW CHECK — runs only once the in-window diff passes (its misses would
  // drown the edge signal); the combined verdict is what terminates the item.
  const postVerdict = verdict.ok ? verifyPostWindow(liveTracks, post, item, { stepMs, frames: postFrames }) : null;
  const ok = verdict.ok && !!postVerdict && postVerdict.ok;
  const firstMismatch = verdict.firstMismatch || (postVerdict && postVerdict.firstMismatch) || null;
  const now = new Date().toISOString();
  const receipt = {
    schema: "pingfusi/verify-sampled@1",
    at: now,
    target: args.name,
    item: args.id,
    scope: item.scope || null,
    trigger: sampleReceipt.trigger || "load",
    fps, frames, stepMs, scopes, props,
    tolerance: TOLERANCE_SAMPLED,
    virtualTime: { live: sampleReceipt.virtualTime || null, clone: run.vtReceipt },
    liveDoc: { file: `targets/${args.name}/motion-doc.json`, sha256_16: sha16(JSON.stringify(liveRead.doc)) },
    cloneDoc: { file: path.relative(WORK, cloneDocFile), sha256_16: sha16(JSON.stringify(cloneDoc)) },
    ok,
    tracks: verdict.tracks,
    postWindow: postVerdict
      ? { frames: postFrames, ok: postVerdict.ok, tracks: postVerdict.tracks, firstMismatch: postVerdict.firstMismatch }
      : { frames: postFrames, skipped: "in-window diff failed first" },
    firstMismatch,
  };
  const receiptFile = path.join(dir, "motion", args.id, "verify-sampled.json");
  fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
  fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n");

  if (ok) {
    updateMotionItem(dir, args.id, {
      status: "verified-sampled",
      verifiedSampledAt: now,
      verifySampledReceipt: path.relative(WORK, receiptFile),
    });
    try {
      const wf = require("./workflow.js");
      wf.appendLedger(args.name, {
        ts: now, event: "motion-verify-sampled", phase: null, runId: wf.runId(), gate: null, forced: false,
        item: args.id,
        reason: `${verdict.tracks.length} sampled track(s) matched frame-by-frame under ${run.vtReceipt.mode} @ ${fps}fps x ${frames} frame(s) (±${TOLERANCE_SAMPLED.translatePx}px translate, ±${TOLERANCE_SAMPLED.opacity} opacity) and held their motion past the clip end (${postFrames} post-window frame(s))`,
      });
    } catch (error) { console.log(`  ⚠ workflow.jsonl receipt failed (verification unaffected): ${String((error && error.message) || error).split("\n")[0]}`); }
    console.log(`✓ verified-sampled — ${verdict.tracks.length} sampled track(s) match frame-by-frame (±${TOLERANCE_SAMPLED.translatePx}px translate, ±${TOLERANCE_SAMPLED.opacity} opacity, ${frames} frame(s) @ ${fps}fps)`);
    console.log(`  post-window: the clone holds its motion past the clip end (${postFrames} extra frame(s) — ongoing tracks still moving, settled tracks settled at the recorded values)`);
    console.log(`  receipt: ${path.relative(WORK, receiptFile)}`);
    console.log(`  no review round is needed for a deterministically matching sampled replay — next: ${CMD} next ${args.name}`);
    return 0;
  }
  updateMotionItem(dir, args.id, {
    // a previously green verified-sampled that no longer holds reopens to the apply
    // checkpoint, never stays green; a not-yet-terminal item keeps its current status.
    ...(isTerminalMotionItem(item) ? { status: "applied-sampled" } : {}),
    lastVerifySampled: { at: now, ok: false, firstMismatch, receipt: path.relative(WORK, receiptFile) },
  });
  console.error(`✗ sampled diff FAILED — ${firstMismatch}`);
  if (!verdict.ok) {
    console.error(`  ${verdict.tracks.filter((t) => !t.ok).length}/${verdict.tracks.length} track(s) differ in-window; full diff receipted at ${path.relative(WORK, receiptFile)}`);
  } else {
    console.error(`  ${postVerdict.tracks.filter((t) => !t.ok).length}/${postVerdict.tracks.length} track(s) fail PAST the clip end (${postFrames} post-window frame(s)); receipted at ${path.relative(WORK, receiptFile)}`);
  }
  console.error(`  fix the clone (or re-apply: ${CMD} motion apply-sampled ${args.name} ${args.id}), then re-run: ${CMD} motion verify-sampled ${args.name} ${args.id}`);
  return 1;
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--clone-doc") a.cloneDoc = argv[++i];
    else if (v === "--clone-url") a.cloneUrl = argv[++i];
    else if (v === "--recapture") a.recapture = true;
    else if (v === "--attach") a.attach = argv[++i];
    else if (v === "--chrome") a.chrome = argv[++i];
    else if (v === "--headful") a.headful = true;
    else if (v.startsWith("--")) { console.error(`✗ unknown flag ${v}`); process.exit(2); }
    else rest.push(v);
  }
  a.name = rest[0];
  a.id = rest[1];
  return a;
}

function sha16(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function main(argv = process.argv.slice(2)) {
  // `pingfusi motion verify-sampled` dispatches here as `--sampled <name> <id>` — one
  // file owns both provenance gates so their doctrine (quarantine, receipts, exit codes)
  // cannot drift apart.
  if (argv[0] === "--sampled") return mainSampled(argv.slice(1));
  const args = parseArgs(argv);
  if (!args.name || !args.id) {
    console.error(`usage: ${CMD} motion verify-introspected <name> <motion-id> [--clone-doc <file>] [--clone-url <url>] [--recapture] [--attach <port>] [--headful]`);
    return 2;
  }
  const dir = path.join(WORK, "targets", args.name);

  let manifest;
  try { manifest = readMotionItems(dir); }
  catch (error) { console.error(`✗ targets/${args.name}/motion-items.json: ${error.message}`); return 2; }
  const item = manifest.items.find((candidate) => candidate.id === args.id);
  if (!item) { console.error(`✗ targets/${args.name}/motion-items.json has no item "${args.id}"`); return 2; }
  if (!isDeclaredItem(item)) {
    // The quarantine line: verification is enforcement work, and enforcement is opt-in by
    // declaration. A sweep-manufactured row must be adopted first.
    console.error(`✗ motion item ${args.id} was never operator-declared — machine verification only runs on owned receipts; adopt it by recording owner provenance on the item in targets/${args.name}/motion-items.json (e.g. \"declaredBy\": \"manual\")`);
    return 2;
  }

  const liveRead = readMotionDoc(dir);
  if (!liveRead.doc) {
    console.error(`✗ targets/${args.name}/motion-doc.json ${liveRead.exists ? "is unreadable" : "is missing"} — the LIVE capture writes it: ${CMD} capture-run ${args.name}`);
    return 1;
  }

  const binding = introspectedBindingFor(item, liveRead.doc);
  if (!binding) {
    if (typeof item.scope !== "string" || !item.scope.trim()) {
      console.error(`✗ motion item ${args.id} has no scope selector — the introspected binding is an exact scope↔track selector match; record one on the item in targets/${args.name}/motion-items.json (\"scope\": \"<selector>\")`);
    } else {
      console.error(`✗ scope ${JSON.stringify(item.scope)} matches no introspected-* track in targets/${args.name}/motion-doc.json — the live capture read no engine declaration there; sampled/fitted evidence keeps the review path (${CMD} next ${args.name})`);
    }
    return 1;
  }
  // Record the binding whether or not the diff passes — the provenance claim is evidence
  // about the LIVE capture and belongs on the item as soon as it is established.
  updateMotionItem(dir, args.id, { introspectedBinding: binding });

  let cloneDoc = null;
  let cloneDocFile = args.cloneDoc ? path.resolve(WORK, args.cloneDoc) : path.join(dir, "motion-doc-clone.json");
  if (args.cloneDoc) {
    try { cloneDoc = JSON.parse(fs.readFileSync(cloneDocFile, "utf8")); }
    catch (error) { console.error(`✗ --clone-doc ${args.cloneDoc}: ${error.message}`); return 1; }
  } else if (!args.recapture && fs.existsSync(cloneDocFile)) {
    try { cloneDoc = JSON.parse(fs.readFileSync(cloneDocFile, "utf8")); }
    catch (error) { console.error(`✗ targets/${args.name}/motion-doc-clone.json is unreadable (${error.message}) — re-run with --recapture`); return 1; }
  } else {
    try { cloneDoc = await captureCloneMotionDoc(args.name, args); }
    catch (error) {
      console.error(`✗ clone-side introspection failed: ${String((error && error.message) || error).split("\n")[0]}`);
      console.error(`  supply the clone doc directly (--clone-doc <file>) or point at a running build (--clone-url <url>)`);
      return 1;
    }
  }
  if (!cloneDoc || typeof cloneDoc !== "object" || !Array.isArray(cloneDoc.tracks)) {
    console.error(`✗ the clone motion doc has no tracks array — not a ${motionDoc.SCHEMA_ID} document`);
    return 1;
  }

  const verdict = verifyIntrospectedScope(liveRead.doc, cloneDoc, item.scope);
  const now = new Date().toISOString();
  const receipt = {
    schema: "pingfusi/verify-introspected@1",
    at: now,
    target: args.name,
    item: args.id,
    scope: item.scope,
    binding,
    tolerance: TOLERANCE,
    liveDoc: { file: `targets/${args.name}/motion-doc.json`, sha256_16: sha16(JSON.stringify(liveRead.doc)) },
    cloneDoc: { file: path.relative(WORK, cloneDocFile), sha256_16: sha16(JSON.stringify(cloneDoc)) },
    ok: verdict.ok,
    tracks: verdict.tracks,
    firstMismatch: verdict.firstMismatch,
  };
  const receiptFile = path.join(dir, "motion", args.id, "verify-introspected.json");
  fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
  fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n");

  if (verdict.ok) {
    updateMotionItem(dir, args.id, {
      status: "verified-introspected",
      introspectedBinding: binding,
      verifiedIntrospectedAt: now,
      verifyReceipt: path.relative(WORK, receiptFile),
    });
    console.log(`✓ verified-introspected — ${verdict.tracks.length} introspected track(s) match exactly (±${TOLERANCE.durationMs}ms timing, ±${TOLERANCE.numeric} numeric)`);
    console.log(`  receipt: ${path.relative(WORK, receiptFile)}`);
    console.log(`  no review round is needed for an exactly-matching introspected track — next: ${CMD} next ${args.name}`);
    return 0;
  }
  updateMotionItem(dir, args.id, {
    // a previously green verification that no longer holds is reopened, never left green
    ...(isTerminalMotionItem(item) ? { status: "pending" } : {}),
    introspectedBinding: binding,
    lastVerifyIntrospected: { at: now, ok: false, firstMismatch: verdict.firstMismatch, receipt: path.relative(WORK, receiptFile) },
  });
  console.error(`✗ introspected diff FAILED — ${verdict.firstMismatch}`);
  console.error(`  ${verdict.tracks.filter((t) => !t.ok).length}/${verdict.tracks.length} track(s) differ; full diff receipted at ${path.relative(WORK, receiptFile)}`);
  console.error(`  fix the clone's declaration to match, then re-run: ${CMD} motion verify-introspected ${args.name} ${args.id}`);
  return 1;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; })
    .catch((error) => { console.error(`✗ ${(error && error.message) || error}`); process.exitCode = 1; });
}

module.exports = {
  POST_WINDOW_FRAMES,
  TOLERANCE,
  TOLERANCE_SAMPLED,
  diffIntrospectedTrack,
  diffOngoingSampledTrack,
  diffSampledTrack,
  easingsMatch,
  main,
  mainSampled,
  normalizedOffsets,
  sampledValueMiss,
  splitCloneRecord,
  valuesMatch,
  verifyIntrospectedScope,
  verifyPostWindow,
  verifySampledTracks,
};
