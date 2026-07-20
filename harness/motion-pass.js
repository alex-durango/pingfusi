#!/usr/bin/env node
// motion-pass.js — the DEFAULT-ON build motion pass (first-draft doctrine, owner
// decision 2026-07-19).
//
// The product is the best machine-made FIRST DRAFT of any site, animations included.
// After capture-build writes the clone, this pass runs automatically and reproduces
// what the live capture recorded in targets/<name>/motion-doc.json — no declare
// ceremony, no review rounds, no gates. Everything it does or refuses is a RECEIPT
// (targets/<name>/motion-pass.json + a workflow.jsonl line + motion-items.json@2
// bookkeeping) and every problem is a WARNING: the build NEVER fails because of motion.
// `pingfusi capture-build <name> --no-motion` skips the pass; `pingfusi motion pass
// <name>` re-runs it standalone (hand-built clones, re-captures).
//
// What each provenance tier gets:
//   - introspected-css / introspected-transition → CSS-INHERITED. The capture-built
//     clone self-hosts the very stylesheets that declare these animations, so the
//     reproduction already shipped BY CONSTRUCTION. The pass verifies statically that
//     the clone's CSS still carries the declaration (@keyframes name / transition
//     property — a stripped or failed stylesheet download would silently de-animate the
//     clone) and receipts pass/warn. The deep engine-level check stays an operator
//     utility: `pingfusi motion verify-introspected` (exact keyframe/timing diff).
//   - introspected-gsap / introspected-waapi → PLAYER-APPLIED. The clone has no GSAP
//     runtime and no page scripts (capture-build strips them), so the page's own engine
//     declarations are replayed as a WAAPI player (clone/motion-replay.js — the same
//     player machinery as apply-sampled) with EXACT parameters: keyframes, duration,
//     delay, iterations (incl. infinite), direction, easing verbatim from the doc. GSAP
//     property channels (x/y/rotation/scale/…) are mapped to their CSS transform forms;
//     a channel with no CSS form is skipped BY NAME.
//   - sampled → PLAYER-APPLIED via the recorded evidence: finite tracks replay as
//     release-on-finish clips, ongoing tracks loop by their fitted marquee law, and an
//     ongoing track with no periodic fit is SKIPPED with a warning (a clip that stops
//     is a fabricated ending — same rule as apply-sampled, demoted from refusal to
//     warning). If the capture didn't sample (no sampled tracks in the doc), that is a
//     receipted skip — the pass never launches a live-side sampler from the build.
//   - fitted → receipt only (model reconstructions stay engine-bundle machinery).
//   - assets (lottie/riv) → receipt only (what was ripped; auto-embed is a future item).
//
// ONE OWNER still guards the players: before writing, the owner probe from
// harness/motion-apply.js watches the target elements in the served clone; a selector
// another implementation writes is SKIPPED with a warning naming it. A probe that
// cannot run here (no Chrome, sandbox) is receipted as unavailable and the players
// still apply — a motionless draft would be the silent failure; the receipt is the
// honest one. PPK_MOTION_PASS_NO_PROBE=1 / --no-probe skip the probe by choice
// (receipted; selftests use it).
//
// usage: node harness/motion-pass.js <name> [--no-probe] [--attach <port>] [--chrome <path>] [--headful]
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const motionApply = require("./motion-apply.js");
const { SCHEMA: ITEMS_SCHEMA, readMotionDoc, readMotionItems, updateMotionItem } = require("./motion-items.js");

const WORK = process.cwd();
const VIA_PPK = process.env.PPK_ENTRY === "1";
const CMD = VIA_PPK ? "pingfusi" : "node harness/workflow.js";
const RECEIPT_SCHEMA = "pingfusi/motion-pass@1";

const sha = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const firstLine = (e) => String((e && e.message) || e).split("\n")[0];
const slug = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "motion";
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── GSAP channel → CSS transform form (exact parameters, mapped names) ──────────────────
// GSAP applies transforms in a fixed order: translation, rotation, skew, scale. A bare
// number takes GSAP's default unit for the channel.
const GSAP_ORDER = ["xPercent", "yPercent", "x", "y", "z", "rotation", "rotationX", "rotationY", "skewX", "skewY", "scale", "scaleX", "scaleY"];
const withUnit = (v, unit) => (/^-?\d*\.?\d+$/.test(String(v).trim()) ? `${String(v).trim()}${unit}` : String(v));
const GSAP_TRANSFORM_FN = {
  x: (v) => `translateX(${withUnit(v, "px")})`,
  y: (v) => `translateY(${withUnit(v, "px")})`,
  z: (v) => `translateZ(${withUnit(v, "px")})`,
  xPercent: (v) => `translateX(${withUnit(v, "%")})`,
  yPercent: (v) => `translateY(${withUnit(v, "%")})`,
  rotation: (v) => `rotate(${withUnit(v, "deg")})`,
  rotationX: (v) => `rotateX(${withUnit(v, "deg")})`,
  rotationY: (v) => `rotateY(${withUnit(v, "deg")})`,
  skewX: (v) => `skewX(${withUnit(v, "deg")})`,
  skewY: (v) => `skewY(${withUnit(v, "deg")})`,
  scale: (v) => `scale(${v})`,
  scaleX: (v) => `scaleX(${v})`,
  scaleY: (v) => `scaleY(${v})`,
};
// GSAP writes bare numbers as px for length-taking CSS properties; these take none.
const UNITLESS_CSS = new Set(["opacity", "zindex", "fontweight", "flexgrow", "flexshrink", "order", "lineheight"]);

// timing → the player's clip fields. iterations stays "infinite" verbatim (the runtime
// maps it to Infinity); 1/normal are omitted so sampled clips keep their exact shape.
function clipTiming(timing) {
  const out = { duration: timing.duration_ms, delay: timing.delay_ms || 0 };
  if (timing.iterations === "infinite" || (typeof timing.iterations === "number" && timing.iterations !== 1)) out.iterations = timing.iterations;
  if (timing.direction && timing.direction !== "normal") out.direction = timing.direction;
  return out;
}

function keyframesPayload(keyframes) {
  return keyframes.map((kf) => ({ offset: kf.offset, value: kf.value, ...(kf.easing ? { easing: kf.easing } : {}) }));
}

// One gsap/waapi track → one clip payload. GSAP transform channels are converted; other
// properties pass through with GSAP's bare-number-means-px semantics. Returns null (with
// a warning pushed) for a channel that has no CSS form.
function engineClipPayload(track, warnings) {
  const property = track.property;
  const tier = track.provenance.tier;
  if (tier === "introspected-gsap" && GSAP_TRANSFORM_FN[property]) {
    const fn = GSAP_TRANSFORM_FN[property];
    return {
      selector: track.target.selector,
      property: "transform",
      mode: "clip",
      keyframes: keyframesPayload(track.keyframes).map((kf) => ({ ...kf, value: fn(kf.value) })),
      ...clipTiming(track.timing),
    };
  }
  if (tier === "introspected-gsap" && /^(?:transformOrigin|transformPerspective)$/.test(property)) {
    warnings.push(`gsap ${property} on ${track.target.selector} has no standalone player form — skipped (receipted)`);
    return null;
  }
  const waapiProp = motionApply.waapiProperty(property);
  const numeric = track.keyframes.every((kf) => /^-?\d*\.?\d+$/.test(String(kf.value).trim()));
  const needsPx = tier === "introspected-gsap" && numeric && !UNITLESS_CSS.has(waapiProp.toLowerCase());
  return {
    selector: track.target.selector,
    property: waapiProp,
    mode: "clip",
    keyframes: keyframesPayload(track.keyframes).map((kf) => (needsPx ? { ...kf, value: `${kf.value}px` } : kf)),
    ...clipTiming(track.timing),
  };
}

// GSAP splits one tween into one track per channel; the player must recombine transform
// channels into ONE animation (two el.animate calls on `transform` would override each
// other). Merge tracks sharing selector + timing + keyframe shape into a single clip in
// GSAP's application order; mismatched shapes keep the first channel and skip the rest
// BY NAME (honest, bounded — never a guessed interpolation).
function mergeGsapTransforms(tracks, warnings) {
  const groups = new Map();
  const rest = [];
  for (const track of tracks) {
    if (track.provenance.tier === "introspected-gsap" && GSAP_TRANSFORM_FN[track.property]) {
      const shape = JSON.stringify(track.keyframes.map((kf) => [kf.offset, kf.easing || null]));
      const key = JSON.stringify([track.target.selector, track.timing, track.timeline, shape]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(track);
    } else {
      rest.push(track);
    }
  }
  const merged = [];
  for (const group of groups.values()) {
    if (group.length === 1) { rest.push(group[0]); continue; }
    const bySelector = new Map(group.map((t) => [t.property, t]));
    const ordered = GSAP_ORDER.filter((ch) => bySelector.has(ch));
    const extras = group.filter((t) => !ordered.includes(t.property));
    for (const extra of extras) rest.push(extra); // unknown channel order — keep separate
    const parts = ordered.map((ch) => bySelector.get(ch));
    if (parts.length <= 1) { for (const p of parts) rest.push(p); continue; }
    const first = parts[0];
    merged.push({
      ids: parts.map((t) => t.id),
      selector: first.target.selector,
      property: "transform",
      mode: "clip",
      keyframes: first.keyframes.map((kf, i) => ({
        offset: kf.offset,
        value: parts.map((t) => GSAP_TRANSFORM_FN[t.property](t.keyframes[i].value)).join(" "),
        ...(kf.easing ? { easing: kf.easing } : {}),
      })),
      ...clipTiming(first.timing),
      sources: parts,
    });
  }
  void warnings;
  return { merged, rest };
}

// ── static CSS verification for the css-inherited tier ──────────────────────────────────
// The deep check (clone-side introspection diff) is `pingfusi motion verify-introspected`;
// the pass verifies the cheap, load-bearing half offline: the clone's own CSS must still
// DECLARE the animation the live page ran (a failed stylesheet download or an over-eager
// strip silently de-animates a clone while every pixel gate stays green).
function cloneCssText(dir) {
  let text = "";
  const cssDir = path.join(dir, "clone", "assets", "css");
  if (fs.existsSync(cssDir)) {
    for (const f of fs.readdirSync(cssDir).sort()) {
      if (f.endsWith(".css")) { try { text += fs.readFileSync(path.join(cssDir, f), "utf8") + "\n"; } catch (_) {} }
    }
  }
  const indexFile = path.join(dir, "clone", "index.html");
  if (fs.existsSync(indexFile)) {
    try {
      const html = fs.readFileSync(indexFile, "utf8");
      for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) text += m[1] + "\n";
    } catch (_) {}
  }
  return text;
}

function verifyCssTrack(track, cssText) {
  const source = String((track.provenance && track.provenance.source) || "");
  let m = /^css-animation:(.+)$/.exec(source);
  if (m) {
    const name = m[1].trim();
    return new RegExp(`@keyframes\\s+${escRe(name)}\\b`).test(cssText)
      ? { verify: "pass", note: `@keyframes ${name} present in the clone's CSS` }
      : { verify: "warn", note: `@keyframes ${name} NOT found in the clone's CSS — the animation the live page declared is missing (stylesheet download failed, or stripped?)` };
  }
  m = /^css-transition:(.+)$/.exec(source);
  if (m) {
    const prop = m[1].trim();
    return new RegExp(`transition[^;{}]*(?:\\ball\\b|${escRe(prop)})`).test(cssText)
      ? { verify: "pass", note: `a transition covering "${prop}" is declared in the clone's CSS` }
      : { verify: "warn", note: `no transition covering "${prop}" found in the clone's CSS` };
  }
  return { verify: "skipped", note: `no static check for source "${source || "(none)"}"` };
}

// ── bookkeeping (motion-items.json@2) ────────────────────────────────────────────────────
// One item per (selector, tier) group the pass acted on. status mirrors verify — "pass"
// is terminal, anything else stays "pending" so `pingfusi next` routes the deep machine
// check from the item's scope binding. It gates NOTHING.
function passItemId(selector, tier) {
  return `pass-${slug(tier.replace(/^introspected-/, ""))}-${sha(`${selector} ${tier}`).slice(0, 8)}`;
}
function writeItem(dir, entry) {
  const id = passItemId(entry.selector, entry.tier);
  updateMotionItem(dir, id, {
    selector: entry.selector,
    scope: entry.selector,
    tier: entry.tier,
    action: entry.action,
    verify: entry.verify,
    receipt: entry.receipt,
    source: "motion-pass",
    status: entry.verify === "pass" ? "pass" : entry.verify === "skipped" ? "skipped" : "pending",
  });
  return id;
}

// verify lattice: warn dominates (a named problem), pass dominates skipped (something
// WAS checked), skipped is the identity (receipt-only disposition, terminal bookkeeping).
const VERIFY_RANK = { skipped: 0, pass: 1, warn: 2 };
const combineVerify = (a, b) => ((VERIFY_RANK[b] || 0) > (VERIFY_RANK[a] || 0) ? b : a);

// ── the pass ─────────────────────────────────────────────────────────────────────────────
async function runMotionPass(name, opts = {}) {
  const dir = path.join(WORK, "targets", name);
  const log = opts.log || ((line) => console.log(line));
  const warnings = [];
  const warn = (msg) => { warnings.push(msg); log(`  ⚠ motion: ${msg}`); };
  const now = new Date().toISOString();

  const finish = (receipt) => {
    const receiptFile = path.join(dir, "motion-pass.json");
    fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n");
    try {
      const wf = require("./workflow.js");
      wf.appendLedger(name, {
        ts: now, event: "motion-pass", phase: null, runId: wf.runId(), gate: null, forced: false,
        reason: receipt.summary,
      });
    } catch (error) { log(`  ⚠ motion: workflow.jsonl receipt failed (pass unaffected): ${firstLine(error)}`); }
    log(`  motion pass: ${receipt.summary}`);
    log(`  receipt: ${path.relative(WORK, receiptFile)}`);
    return receipt;
  };

  if (!fs.existsSync(path.join(dir, "clone", "index.html"))) {
    return finish({
      schema: RECEIPT_SCHEMA, at: now, target: name, ok: true, noop: true,
      summary: "no-op — no clone/index.html to animate (build the clone first)",
      warnings,
    });
  }

  const docRead = readMotionDoc(dir);
  if (!docRead.doc) {
    const why = docRead.exists ? "motion-doc.json is unreadable" : "no motion-doc.json (capture recorded no motion)";
    if (docRead.exists) warn(`${why} — the capture wrote a doc this pass cannot parse; re-run ${CMD.replace("workflow.js", "capture-runner.js")} capture-run ${name}`);
    return finish({
      schema: RECEIPT_SCHEMA, at: now, target: name, ok: true, noop: true,
      summary: `no-op — ${why}`,
      warnings,
    });
  }
  const doc = docRead.doc;
  const docSha16 = sha(JSON.stringify(doc)).slice(0, 16);

  // ── partition the tracks by tier ───────────────────────────────────────────────────────
  const cssTracks = [];      // css-inherited by construction
  const engineTracks = [];   // gsap/waapi → exact-parameter players
  const sampledTracks = [];  // sampled → clip/loop players
  const skipped = [];        // {track, reason, tier}
  for (const track of doc.tracks) {
    const tier = String((track.provenance && track.provenance.tier) || "");
    if (tier === "introspected-css" || tier === "introspected-transition") { cssTracks.push(track); continue; }
    if (tier === "fitted") { skipped.push({ track, tier, verify: "skipped", reason: "fitted model reconstruction — engine bundle machinery owns it; not auto-applied" }); continue; }
    if (track.timeline && track.timeline.type !== "document") {
      skipped.push({ track, tier, verify: "skipped", reason: `${track.timeline.type}-linked — no time-based player form (receipted; the input linkage cannot be reproduced by a clock)` });
      warn(`${tier} track on ${track.target.selector} is ${track.timeline.type}-linked — skipped (no time-based player form)`);
      continue;
    }
    if (tier === "introspected-gsap" || tier === "introspected-waapi") { engineTracks.push(track); continue; }
    if (tier === "sampled") { sampledTracks.push(track); continue; }
    skipped.push({ track, tier, verify: "skipped", reason: "unknown tier — no action" });
  }

  // ── css-inherited: static verify against the clone's own CSS ─────────────────────────
  const cssText = cssTracks.length ? cloneCssText(dir) : "";
  const cssGroups = new Map(); // selector\u0000tier → group
  for (const track of cssTracks) {
    const tier = track.provenance.tier;
    const key = `${track.target.selector}\u0000${tier}`;
    if (!cssGroups.has(key)) cssGroups.set(key, { selector: track.target.selector, tier, action: "css-inherited", verify: "skipped", notes: [], tracks: 0 });
    const group = cssGroups.get(key);
    const v = verifyCssTrack(track, cssText);
    group.tracks++;
    group.verify = combineVerify(group.verify, v.verify);
    if (!group.notes.includes(v.note)) group.notes.push(v.note);
    if (v.verify === "warn") warn(`${track.target.selector}: ${v.note}`);
  }

  // ── players: gsap/waapi (exact parameters) + sampled (clip/loop) ───────────────────────
  const { merged, rest } = mergeGsapTransforms(engineTracks, warnings);
  const candidates = []; // { selector, tier, payload, receipt: {…} }
  for (const m of merged) {
    candidates.push({
      selector: m.selector, tier: "introspected-gsap",
      payload: { selector: m.selector, property: m.property, mode: "clip", keyframes: m.keyframes, duration: m.duration, delay: m.delay, ...(m.iterations !== undefined ? { iterations: m.iterations } : {}), ...(m.direction ? { direction: m.direction } : {}) },
      receipt: { ids: m.ids, selector: m.selector, property: "transform", mode: "clip", frames: m.keyframes.length, duration_ms: m.duration, source: "gsap (merged transform channels)" },
    });
  }
  for (const track of rest) {
    const payload = engineClipPayload(track, warnings);
    if (!payload) { skipped.push({ track, tier: track.provenance.tier, verify: "skipped", reason: "no CSS form for this channel" }); continue; }
    candidates.push({
      selector: track.target.selector, tier: track.provenance.tier, payload,
      receipt: { ids: [track.id], selector: track.target.selector, property: payload.property, mode: "clip", frames: payload.keyframes.length, duration_ms: payload.duration, source: (track.provenance && track.provenance.source) || null },
    });
  }
  for (const track of sampledTracks) {
    const mode = motionApply.replayMode(track);
    if (mode.mode === "unloopable") {
      skipped.push({ track, tier: "sampled", verify: "warn", reason: "ongoing motion with no periodic fit — a clip that stops is a fabricated ending; sample longer so the marquee class can win, or the element stays static in the draft" });
      warn(`${track.target.selector} ${track.property}: ongoing motion with no periodic fit — skipped (a one-shot clip would freeze mid-motion; re-sample with more --frames)`);
      continue;
    }
    const base = { selector: track.target.selector, property: motionApply.waapiProperty(track.property) };
    const payload = mode.mode === "loop"
      ? { ...base, mode: "loop", axis: mode.axis, velocityPxPerSec: mode.velocityPxPerSec, direction: mode.direction }
      : { ...base, mode: "clip", keyframes: keyframesPayload(track.keyframes).map(({ offset, value }) => ({ offset, value })), duration: track.timing.duration_ms, delay: track.timing.delay_ms || 0 };
    candidates.push({
      selector: track.target.selector, tier: "sampled", payload,
      receipt: { ids: [track.id], selector: track.target.selector, property: track.property, mode: mode.mode, ...(mode.ongoing ? { ongoing: true } : {}), frames: track.keyframes.length, duration_ms: track.timing.duration_ms, source: (track.provenance && track.provenance.source) || null },
    });
  }

  // ── ONE WRITER PER (selector, property) — statically ──────────────────────────────────
  // Two time-based animations on one property of one element override each other (WAAPI
  // composite "replace"), and for css-inherited tracks the captured CSS is itself a
  // writer. First candidate wins, the rest are receipted skips — the kit never stacks
  // implementations, statically or dynamically.
  const cssWrites = new Set(cssTracks.map((t) => `${t.target.selector}\u0000${motionApply.waapiProperty(t.property)}`));
  const claimed = new Set();
  const playerEntries = [];
  for (const entry of candidates) {
    const key = `${entry.payload.selector}\u0000${entry.payload.property}`;
    if (cssWrites.has(key)) {
      skipped.push({ track: { id: entry.receipt.ids.join("+"), target: { selector: entry.selector } }, tier: entry.tier, verify: "skipped", reason: `the captured CSS already animates ${entry.payload.property} on this element — a player would stack a second writer (css-inherited wins)` });
      warn(`${entry.selector} ${entry.payload.property}: captured CSS already animates it — ${entry.tier} player skipped`);
      continue;
    }
    if (claimed.has(key)) {
      skipped.push({ track: { id: entry.receipt.ids.join("+"), target: { selector: entry.selector } }, tier: entry.tier, verify: "warn", reason: `another applied track already animates ${entry.payload.property} on this element — first wins, receipted` });
      warn(`${entry.selector} ${entry.payload.property}: a second ${entry.tier} track targets the same property — skipped (first wins)`);
      continue;
    }
    claimed.add(key);
    playerEntries.push(entry);
  }

  // ── ONE OWNER: probe for competing writers before writing players ─────────────────────
  const probeDisabled = opts.probe === false || process.env.PPK_MOTION_PASS_NO_PROBE === "1";
  let probe = { mode: probeDisabled ? "disabled" : "ran", changed: [], elements: 0 };
  if (playerEntries.length && !probeDisabled) {
    const selectors = [...new Set(playerEntries.map((entry) => entry.payload.selector))];
    try {
      const result = await motionApply.ownerProbe(name, dir, selectors, { attach: opts.attach, chrome: opts.chrome, headful: opts.headful });
      probe = { mode: "ran", changed: result.changed, elements: result.elements, missing: result.missing, replayHeld: result.replayHeld };
    } catch (error) {
      probe = { mode: "unavailable", reason: firstLine(error), changed: [], elements: 0 };
      warn(`owner probe unavailable (${probe.reason}) — players applied with ownership UNVERIFIED (receipted)`);
    }
  } else if (playerEntries.length) {
    warn(`owner probe skipped by flag — players applied with ownership UNVERIFIED (receipted)`);
  }
  const owned = new Set((probe.changed || []).map((c) => c.selector));
  const applied = [];
  for (const entry of playerEntries) {
    if (owned.has(entry.payload.selector)) {
      skipped.push({ track: { id: entry.receipt.ids.join("+"), target: { selector: entry.selector } }, tier: entry.tier, verify: "warn", reason: "another implementation owns this element (owner probe saw it move with the kit's replay held aside) — the kit never stacks implementations" });
      warn(`${entry.selector}: another implementation owns this element — player skipped`);
      continue;
    }
    applied.push(entry);
  }

  // ── write the player (idempotent marker block; every applied track in one file) ───────
  let replay = null;
  if (applied.length) {
    const headerReceipt = {
      schema: motionApply.REPLAY_SCHEMA,
      at: now,
      target: name,
      doc: { file: `targets/${name}/motion-doc.json`, sha256_16: docSha16 },
      items: [{ id: "motion-pass", trigger: "load", tracks: applied.map((entry) => entry.receipt) }],
    };
    const payloads = [{ id: "motion-pass", trigger: "load", start: "load", observe: null, tracks: applied.map((entry) => entry.payload) }];
    const source = motionApply.renderReplay(headerReceipt, payloads);
    const replayFile = path.join(dir, "clone", "motion-replay.js");
    fs.writeFileSync(replayFile, source);
    const indexFile = path.join(dir, "clone", "index.html");
    const injected = motionApply.injectScriptTag(fs.readFileSync(indexFile, "utf8"));
    fs.writeFileSync(indexFile, injected.html);
    replay = { file: `targets/${name}/clone/motion-replay.js`, sha256_16: sha(source).slice(0, 16), bytes: Buffer.byteLength(source), scriptTag: injected.action, tracks: applied.length };
  }

  // ── bookkeeping: one @2 item per (selector, tier) group ────────────────────────────────
  const items = [];
  for (const group of cssGroups.values()) {
    const deep = `deep diff: ${CMD} motion verify-introspected ${name} ${passItemId(group.selector, group.tier)}`;
    items.push(writeItem(dir, {
      ...group,
      receipt: `${group.tracks} track(s) carried by the captured CSS; ${group.notes.join("; ")} — ${deep}`,
    }));
  }
  const playerGroups = new Map();
  for (const entry of playerEntries) {
    const key = `${entry.selector}\u0000${entry.tier}`;
    if (!playerGroups.has(key)) playerGroups.set(key, { selector: entry.selector, tier: entry.tier, applied: 0, skippedCount: 0 });
    const g = playerGroups.get(key);
    if (owned.has(entry.payload.selector)) g.skippedCount++;
    else g.applied++;
  }
  for (const s of skipped) {
    if (!s.track || !s.track.target || !s.track.target.selector) continue;
    const key = `${s.track.target.selector}\u0000${s.tier}`;
    if (!playerGroups.has(key)) playerGroups.set(key, { selector: s.track.target.selector, tier: s.tier, applied: 0, skippedCount: 0 });
    const g = playerGroups.get(key);
    if (!owned.has(s.track.target.selector)) g.skippedCount++;
    g.skipVerify = combineVerify(g.skipVerify || "skipped", s.verify || "warn");
    g.reason = s.reason;
  }
  for (const group of playerGroups.values()) {
    const action = group.applied > 0 ? "player-applied" : "skipped";
    // Applied players earn "pass" only when the owner probe actually RAN and cleared
    // the element; an unavailable/disabled probe leaves ownership unverified — "warn".
    const appliedVerify = group.applied > 0 ? (probe.mode === "ran" ? "pass" : "warn") : "skipped";
    const verify = combineVerify(appliedVerify, group.skipVerify || "skipped");
    const receiptText = action === "player-applied"
      ? `${group.applied} track(s) replayed as time-based WAAPI in clone/motion-replay.js (parameters verbatim from motion-doc.json${probe.mode === "ran" ? "; owner probe clean" : `; owner probe ${probe.mode}`})${group.skippedCount ? `; ${group.skippedCount} track(s) skipped` : ""}`
      : `skipped — ${group.reason || "another implementation owns this element"}`;
    items.push(writeItem(dir, { selector: group.selector, tier: group.tier, action, verify, receipt: receiptText }));
  }

  // ── assets: receipts only ──────────────────────────────────────────────────────────────
  const assets = (doc.assets || []).map((asset) => ({ kind: asset.kind, url: asset.url, file: asset.file, bytes: asset.bytes }));
  if (assets.length) log(`  motion assets receipted (re-embedding is a future item): ${assets.map((a) => `${a.kind} ${a.file}`).join(", ")}`);

  const summary = [
    `${doc.tracks.length} track(s)`,
    `${cssTracks.length} css-inherited`,
    `${applied.length} player-applied`,
    `${skipped.length} skipped`,
    ...(assets.length ? [`${assets.length} asset(s) receipted`] : []),
    ...(warnings.length ? [`${warnings.length} warning(s)`] : []),
  ].join(", ") + " — receipts and warnings only; motion never fails a build";

  return finish({
    schema: RECEIPT_SCHEMA,
    at: now,
    target: name,
    ok: true,
    doc: { file: `targets/${name}/motion-doc.json`, sha256_16: docSha16 },
    tracks: { total: doc.tracks.length, cssInherited: cssTracks.length, playersApplied: applied.length, skipped: skipped.length },
    ownerProbe: probe,
    replay,
    items: { schema: ITEMS_SCHEMA, ids: items },
    assets,
    skipped: skipped.map((s) => ({ track: s.track && s.track.id, selector: s.track && s.track.target && s.track.target.selector, tier: s.tier, reason: s.reason })),
    warnings,
    summary,
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { probe: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--no-probe") a.probe = false;
    else if (v === "--attach") a.attach = argv[++i];
    else if (v === "--chrome") a.chrome = argv[++i];
    else if (v === "--headful") a.headful = true;
    else if (v.startsWith("--")) { console.error(`unknown flag ${v} — usage: ${VIA_PPK ? "pingfusi motion pass" : "node harness/motion-pass.js"} <name> [--no-probe] [--attach <port>] [--chrome <path>] [--headful]`); process.exit(2); }
    else rest.push(v);
  }
  a.name = rest[0];
  return a;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.name) { console.error(`usage: ${VIA_PPK ? "pingfusi motion pass" : "node harness/motion-pass.js"} <name> [--no-probe]`); process.exit(2); }
  const dir = path.join(WORK, "targets", args.name);
  if (!fs.existsSync(dir)) { console.error(`✗ targets/${args.name}/ does not exist — run: ${CMD === "pingfusi" ? "pingfusi" : "node harness/new-target.js"} new ${args.name} <url>`); process.exit(1); }
  try { readMotionItems(dir); }
  catch (error) { console.error(`✗ targets/${args.name}/motion-items.json: ${firstLine(error)} — repair or remove it, then re-run`); process.exit(1); }
  // WARNINGS, NEVER FAILURES: the pass exits 0 whatever it found — the receipt and the
  // warning lines are the result. Only usage/environment errors above exit nonzero.
  await runMotionPass(args.name, args);
  process.exit(0);
}

if (require.main === module) {
  main().catch((error) => { console.error(`✗ ${firstLine(error)}`); process.exit(1); });
}

module.exports = { RECEIPT_SCHEMA, engineClipPayload, mergeGsapTransforms, runMotionPass, verifyCssTrack, main };
