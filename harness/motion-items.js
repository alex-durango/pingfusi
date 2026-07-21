// motion-items.js — machine bookkeeping for the motion pass (first-draft doctrine,
// owner decision 2026-07-19).
//
// motion-items.json records what the motion machinery did per element — tier, action
// taken, verify result. It is receipts and warnings, NEVER a gate: no status in this
// file may block `behavior`, `review`, or `done`, and no review-round machinery reads
// or writes it anymore. `pingfusi next` still routes the machine chain (capture →
// introspected diff / sample → apply → verify) from these receipts.
//
// SCHEMA @2 — the bookkeeping shape. The build-time motion pass (harness/motion-pass.js)
// auto-writes one item per (selector, tier) group it acted on:
//   { id, selector, tier, action: "css-inherited"|"player-applied"|"skipped",
//     verify: "pass"|"warn"|"skipped", receipt, scope, source: "motion-pass",
//     status: "pass"|"pending" }
// status mirrors verify ("pass" is already a terminal status; anything else stays
// "pending" so `pingfusi next` can route the deep machine check) — it gates NOTHING.
// @1 files (declare-era) remain readable; the next write re-stamps the file @2.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { trackFingerprint } = require("./motion-doc.js");

const SCHEMA = "pingfusi/motion-items@2";
// Readable legacy schemas: normalizeMotionItems understands their item shape, and any
// write through updateMotionItem re-stamps the file at the current SCHEMA.
const READABLE_SCHEMAS = new Set([SCHEMA, "pingfusi/motion-items@1"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// "verified-introspected" is the capture ladder's machine-verified terminal: an item bound
// to an introspected-* motion-doc track whose exact keyframe/timing diff against the clone
// exited 0 (harness/motion-verify.js). No review round is spent on it — the page's own
// engine declaration read on both sides IS the evidence, and a green check is a command
// that exits 0.
// "verified-sampled" is the SAMPLED tier's machine-verified terminal, earned the same way:
// the clone was re-sampled under the identical virtual-time stimulus (same fps/frames/
// trigger) and every live sampled track matched frame-by-frame within the documented
// tolerance (`pingfusi motion verify-sampled`, harness/motion-verify.js). Determinism is
// what makes the sampled record diffable at all, so equality here is evidence, not luck.
// "skipped" is the motion pass's receipted DISPOSITION (fitted/scroll-linked/no player
// form): there is no machine chain left to walk for it, so it must not read as pending
// work forever — the receipt on the item says exactly why nothing was applied.
const TERMINAL_STATUSES = new Set([
  "approved", "complete", "completed", "converged", "done", "exported", "pass", "passed",
  "skipped", "verified-introspected", "verified-sampled",
]);

// Temporal ownership is deliberately stricter than the general behavior inventory. A
// click/menu row is interaction work; it becomes motion work only when capture recorded an
// engine/timing signal or a strong, backwards-compatible author marker. This keeps ordinary
// state changes out of the specialist queue while still recognizing pre-@1 behavior captures.
const MOTION_KIND = /^(?:motion|animation|css-animation|css-transition|transition|waapi|spring|tween|timeline|raf|gsap|marquee|scroll-driven|scroll-linked|pointer-follow|canvas(?:-generative)?|webgl(?:-generative)?|shader)$/i;
const TEMPORAL_FIELD = new Set([
  "duration", "durationms", "delay", "delayms", "easing", "ease", "keyframes", "timeline",
  "timelineoffset", "pxpersec", "velocity", "stiffness", "damping", "mass", "settlems",
  "fps", "trajectory", "stagger", "staggerms", "raf",
]);
// Hints such as will-change, data-scroll-* and a dormant transition are useful worksheet
// clues, but not enough to spend specialist work on by themselves. A named CSS animation is
// an actual engine declaration and remains the one strong legacy hint.
const STRONG_HINT = /^animation-name:(?!none\b)/i;

function sha(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

// Capture JSON is assembled by browser-side code, so object key insertion order is not an
// evidence property. Canonicalize nested timing measurements before hashing them; otherwise a
// semantically identical recapture could reopen already-converged specialist work.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Temporal captures contain unavoidable acquisition noise (rAF scheduling, transform sample
// phase, and wall-clock timestamps). Ownership should reopen when the motion materially
// changes, not because a one-second sample measured 96.0px/s on one pass and 96.1px/s on the
// next. Two significant digits are deliberately tighter than the behavior gate's ±15% speed
// tolerance while still absorbing sub-percent timer noise.
function materialNumber(value) {
  if (!Number.isFinite(value) || value === 0) return value;
  const scale = 10 ** (1 - Math.floor(Math.log10(Math.abs(value))));
  return Math.round(value * scale) / scale;
}

const ACQUISITION_ONLY_FIELDS = new Set([
  "atY", "capturedAt", "endedAt", "observedAt", "sampleCount", "sampledMs", "startedAt", "timestamp",
]);

function materialEvidence(value) {
  if (typeof value === "number") return materialNumber(value);
  if (Array.isArray(value)) return value.map((entry) => materialEvidence(entry));
  if (!value || typeof value !== "object") return value;
  const speedSample = typeof value.pxPerSec === "number";
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !ACQUISITION_ONLY_FIELDS.has(key) && !(speedSample && (key === "from" || key === "to")))
    .map(([key, child]) => [key, materialEvidence(child)]));
}

function slug(value, fallback = "motion") {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || fallback;
}

function hasTemporalField(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => hasTemporalField(entry, seen));
  return Object.entries(value).some(([key, child]) => TEMPORAL_FIELD.has(key.toLowerCase()) || hasTemporalField(child, seen));
}

function engineTrigger(raw, kind) {
  const trigger = String(raw || "").trim();
  if (/^(?:load|scroll-sweep)$/.test(trigger) || /^(?:hover|click|focus|scroll-to|scroll-steps|scroll-through|pointer):.+/.test(trigger)) return trigger;
  // A bare interactive trigger cannot be replayed faithfully — degrading it to "load" would
  // silently capture the wrong stimulus and spend a paid review round on it. Fail loudly.
  if (/^(?:hover|click|focus|pointer)$/.test(trigger)) {
    const hint = trigger === "pointer" ? "pointer:<path>/<durationMs>" : `${trigger}:<selector>`;
    throw new Error(`trigger "${trigger}" is missing its selector — declare it as ${hint}`);
  }
  if (/scroll/i.test(trigger) || /scroll-(?:linked|driven)/i.test(kind)) return "scroll-sweep";
  // A generic mutation was observed during the discovery scroll sweep. It is not a valid
  // motion-engine DSL trigger, but scroll-sweep faithfully recreates the acquisition stimulus.
  if (trigger === "mutation") return "scroll-sweep";
  return "load";
}

function selectorFromBehaviorKey(key) {
  const value = String(key || "").replace(/^[^:]+:/, "").trim();
  if (!value || value.includes(">") || /\[[0-9]+\]/.test(value)) return null;
  // A bare token is commonly a logical probe name (`marquee:logo_belt`) or could have come
  // from data-testid/aria-label. Treating it as an id invents a selector the capture never
  // observed. Only preserve key suffixes that are already selector-shaped.
  if (/^(?:[#.][A-Za-z0-9_.#-]+|\[[^\]]+\]|[A-Za-z][A-Za-z0-9_-]*[.#][A-Za-z0-9_.#-]+)$/.test(value)) return value;
  return null;
}

function capturedSelector(value, temporal, behaviorKey) {
  const choices = [
    temporal && temporal.scope,
    value && value.scope,
    value && value.selector,
    value && value.targetSelector,
    value && value.elementSelector,
  ];
  const exact = choices.find((candidate) => typeof candidate === "string" && candidate.trim());
  return exact ? exact.trim() : selectorFromBehaviorKey(behaviorKey);
}

function explicitMotionGroup(value, temporal) {
  const candidate = (temporal && (temporal.motionGroup || temporal.groupId || temporal.group)) ||
    (value && (value.motionGroup || value.motionGroupId));
  return candidate == null || !String(candidate).trim() ? null : String(candidate).trim();
}

function animationName(hints) {
  const hit = (Array.isArray(hints) ? hints : []).find((hint) => /^animation-name:/i.test(String(hint)));
  return hit ? String(hit).replace(/^animation-name:/i, "").trim() : null;
}

function classifyMotionRow(behaviorKey, row, bucket) {
  const value = row && typeof row === "object" ? row : {};
  const hints = Array.isArray(value.hints) ? value.hints.map(String) : [];
  const temporal = value.temporal && typeof value.temporal === "object" ? value.temporal : null;
  const explicitKind = String((temporal && temporal.kind) || value.kind || "").trim();
  const strongHint = hints.find((hint) => STRONG_HINT.test(hint)) || null;
  const measured = hasTemporalField(value.measured);
  const strong = !!(
    (temporal && (temporal.candidate === "strong" || temporal.strong === true)) ||
    MOTION_KIND.test(explicitKind) || strongHint || measured
  );
  if (!strong) return null;

  let kind = explicitKind && MOTION_KIND.test(explicitKind) ? explicitKind.toLowerCase() : null;
  // STRONG_HINT only matches a named CSS animation, so it is the one hint-derived kind.
  if (!kind && strongHint) kind = "css-animation";
  if (!kind && value.measured && value.measured.pxPerSec != null) kind = "marquee";
  if (!kind) kind = "animation";

  const name = animationName(hints) || (temporal && temporal.animationName) || null;
  let trigger;
  try { trigger = engineTrigger((temporal && temporal.trigger) || value.trigger, kind); }
  catch (error) { throw new Error(`behavior ${behaviorKey}: ${error.message}`); }
  const scope = capturedSelector(value, temporal, behaviorKey);
  const explicitGroup = explicitMotionGroup(value, temporal);
  // Unnamed effects are independent by default. Two marquees that happen to share a speed
  // and trigger are not one lifecycle item. Sharing is allowed only when capture supplied an
  // explicit motion group or when CSS itself supplies the same named animation identity.
  const sharedAnimation = kind === "css-animation" && name && !/^none$/i.test(name);
  const groupKey = JSON.stringify(sharedAnimation
    ? { shared: "css-animation-name", kind, trigger, animationName: name }
    : explicitGroup
      ? { shared: "explicit", group: explicitGroup, kind, trigger }
      : { shared: "source", behaviorKey, kind, trigger });
  const fingerprint = sha(stableJson({
    behaviorKey,
    kind,
    trigger,
    scope: scope || null,
    animationName: name || null,
    explicitGroup,
    hints: [...hints].sort(),
    temporal: materialEvidence(temporal),
    measured: materialEvidence(value.measured || null),
  }));
  return {
    behaviorKey,
    bucket,
    kind,
    trigger,
    scope,
    animationName: name,
    explicitGroup,
    groupKey,
    fingerprint,
    // Deterministic id for the operator's declare command: two rows that share one motion
    // identity (same named animation / explicit group) suggest the same id, and re-declaring
    // evidence a legacy reconciliation once materialized lands on that legacy item's id.
    suggestedId: autoItemId(groupKey, kind),
    reason: temporal && temporal.reason
      ? String(temporal.reason)
      : `behavior capture recorded temporal evidence for ${behaviorKey}${strongHint ? ` (${strongHint})` : ""}`,
  };
}

function motionCandidatesFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return [];
  const out = [];
  for (const bucket of ["behaviors", "declared"]) {
    const rows = snapshot[bucket];
    if (!rows || typeof rows !== "object" || Array.isArray(rows)) continue;
    for (const [key, row] of Object.entries(rows)) {
      const candidate = classifyMotionRow(key, row, bucket);
      if (candidate) out.push(candidate);
    }
  }
  return out;
}

function behaviorKeysOf(item) {
  const keys = [];
  if (item && item.behaviorKey) keys.push(String(item.behaviorKey));
  if (item && item.sourceBehaviorKey) keys.push(String(item.sourceBehaviorKey));
  if (item && Array.isArray(item.sourceBehaviorKeys)) keys.push(...item.sourceBehaviorKeys.map(String));
  return [...new Set(keys)];
}

function ownedMotionCandidate(candidate, items) {
  return normalizeMotionItems(items || []).some((item) => {
    if (!behaviorKeysOf(item).includes(candidate.behaviorKey)) return false;
    const fingerprints = item.sourceBehaviorFingerprints;
    // Legacy/manual declarations without a baseline still own their key; the next explicit
    // sync establishes one. Once a fingerprint exists, however, it is part of ownership and
    // a materially different live row must be declared/reconciled before stale work routes.
    if (!fingerprints || !Object.prototype.hasOwnProperty.call(fingerprints, candidate.behaviorKey)) return true;
    return fingerprints[candidate.behaviorKey] === candidate.fingerprint;
  });
}

function unownedMotionCandidates(snapshot, items) {
  return motionCandidatesFromSnapshot(snapshot).filter((candidate) => !ownedMotionCandidate(candidate, items));
}

// Provenance split, kept for the machine chain's own safety (never for gating): the
// sampler/apply/verify commands only operate on items with operator/owner provenance so a
// raw sweep row cannot silently drive clone writes. declaredBy ("manual" | "review-signal"
// | "from-behaviors") is legacy declare-era provenance; source "behavior-capture" without
// declaredBy marks a sweep-derived row; "needs-declaration" is a legacy review-era
// placeholder. Items with none of those markers were written by an explicit operator act
// and count as owned.
function isDeclaredItem(item) {
  if (!item || typeof item !== "object") return false;
  if (["manual", "review-signal", "from-behaviors"].includes(item.declaredBy)) return true;
  if (item.source === "behavior-capture") return false;
  if (String(item.status || "").toLowerCase() === "needs-declaration") return false;
  return true;
}

// Sweep-derived temporal candidates with no owning receipt, for INFORMATIONAL display only.
function advisoryMotionCandidates(snapshot, items) {
  return unownedMotionCandidates(snapshot, items);
}

// ── behavior-gate receipt lookup (first-draft doctrine) ─────────────────────────────────
// The sweep's TEMPORAL observation prefixes: a scroll reveal, a repeated style mutation,
// a pre-navigation startup animation. Time-driven phenomena are the motion pass's
// jurisdiction — never behavior-deviations.json material (that file is for unsupported
// non-temporal interaction/state rows; docs/CLONE-ANY-SITE.md).
const TEMPORAL_ROW = /^(?:reveal|mutation|startup):/i;
function isTemporalBehaviorKey(key) {
  return TEMPORAL_ROW.test(String(key || ""));
}

// Does the motion machinery hold a receipt for this behavior row's element? Receipts live
// in motion-items.json (@2: the build pass writes one item per (selector, tier) it acted
// on — css-inherited verifies, applied players, receipted skips; declare-era items own
// behavior keys by lineage) and motion-doc.json (the capture's recorded tracks, which the
// pass's players are generated from). Match order: behavior-key lineage → item
// selector/scope (exact trimmed match, the same rule as introspected binding — fuzzy
// matching would attach a receipt to motion it never covered) → doc track target
// selector. Pure and throw-free: the result feeds an INFORMATIONAL line on the behavior
// gate's receipt, never a gate result.
function motionReceiptForBehaviorRow(behaviorKey, row, items, doc) {
  let normalized;
  try { normalized = normalizeMotionItems(items || []); } catch (_) { normalized = []; }
  const key = String(behaviorKey || "");
  const byKey = normalized.find((item) => behaviorKeysOf(item).includes(key));
  if (byKey) return { via: "behavior-key", id: byKey.id };
  const value = row && typeof row === "object" ? row : {};
  const temporal = value.temporal && typeof value.temporal === "object" ? value.temporal : null;
  const selector = capturedSelector(value, temporal, key);
  if (!selector) return null;
  const matches = (candidate) => typeof candidate === "string" && candidate.trim() === selector;
  const bySelector = normalized.find((item) => matches(item.selector) || matches(item.scope));
  if (bySelector) return { via: "selector", id: bySelector.id };
  const track = doc && Array.isArray(doc.tracks)
    ? doc.tracks.find((entry) => entry && typeof entry === "object" && entry.target && matches(entry.target.selector))
    : null;
  if (track) return { via: "doc-track", id: String(track.id != null ? track.id : selector) };
  return null;
}

function autoItemId(groupKey, kind) {
  return `auto-${slug(kind)}-${sha(groupKey).slice(0, 8)}`;
}

function normalizeMotionItems(raw) {
  if (raw == null) return [];
  let items;
  if (Array.isArray(raw)) items = raw;
  else if (raw && typeof raw === "object" && Array.isArray(raw.items)) items = raw.items;
  else if (raw && typeof raw === "object" && Array.isArray(raw.motions)) items = raw.motions;
  else if (raw && typeof raw === "object") {
    items = Object.entries(raw)
      .filter(([key, value]) => !["schema", "version", "updatedAt", "updated_at"].includes(key) && value && typeof value === "object" && !Array.isArray(value))
      .map(([key, value]) => ({ id: value.id || key, ...value }));
  } else {
    throw new Error("manifest must be an object or array");
  }

  const seen = new Set();
  return items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`item ${index + 1} must be an object`);
    const id = String(item.id || "");
    if (!SAFE_ID.test(id)) throw new Error(`item ${index + 1} needs a safe unique id`);
    if (seen.has(id)) throw new Error(`duplicate motion item id: ${id}`);
    seen.add(id);
    return { ...item, id };
  });
}

function isTerminalMotionItem(item) {
  return TERMINAL_STATUSES.has(String((item && item.status) || "pending").toLowerCase());
}

// ── provenance binding: motion-doc introspected tracks ↔ owned items ────────────────────
// The capture ladder is provenance-aware: a track the live capture READ from the page's own
// engine (provenance.tier "introspected-*") is machine-verifiable by exact diff, while
// sampled tracks get the deterministic per-frame replay diff (verify-sampled) and fitted
// tracks stay receipt-only engine-bundle machinery. The binding below records, on an OWNED
// item, which introspected doc track its scope claims (docTrackId + trackFingerprint,
// provenance "introspected") so routing can send it to `pingfusi motion verify-introspected`.
// Ownership holds on every edge — machine-chain safety, never gating: only owned items ever
// bind, raw sweep rows are untouched, and a missing/unreadable motion-doc.json is a silent
// no-op — nothing here may block a clone.

const INTROSPECTED_TIER = /^introspected-/;

// Never throws — an unreadable doc is reported as { doc: null }, because this file is read
// on declare/verify write paths and a corrupt additive artifact must not fail them.
function readMotionDoc(targetDir) {
  const file = path.join(targetDir, "motion-doc.json");
  if (!fs.existsSync(file)) return { exists: false, file, doc: null };
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const usable = doc && typeof doc === "object" && !Array.isArray(doc) && Array.isArray(doc.tracks);
    return { exists: true, file, doc: usable ? doc : null };
  } catch (_) {
    return { exists: true, file, doc: null };
  }
}

// Exact trimmed selector match ONLY. Scope is the operator's declared claim and the track
// selector is what the reader resolved on the live page; a fuzzy match would bind an item
// to motion its declaration never named. One animation commonly yields several tracks
// (one per property), so the match returns all of them.
function introspectedTracksForScope(doc, scope) {
  if (!doc || !Array.isArray(doc.tracks) || typeof scope !== "string" || !scope.trim()) return [];
  const wanted = scope.trim();
  return doc.tracks.filter((track) => track && typeof track === "object" &&
    track.provenance && INTROSPECTED_TIER.test(String(track.provenance.tier || "")) &&
    track.target && typeof track.target.selector === "string" && track.target.selector.trim() === wanted);
}

// The SAMPLED tier's binding (pure, read-only): the tracks an item's sample run merged
// into the doc. The sampler's recorded sampledTrackIds are authoritative — they name
// the exact tracks that run produced; the scope fallback (exact trimmed selector match,
// same rule as introspected) only covers pre-binding docs. Only sampled-tier tracks
// ever return: introspected tracks have their own exact-diff check and fitted tracks
// stay receipt-only (engine-bundle machinery, never auto-applied by the pass).
function sampledTracksForItem(item, doc) {
  if (!item || typeof item !== "object" || !doc || !Array.isArray(doc.tracks)) return [];
  const sampled = doc.tracks.filter((track) => track && typeof track === "object" &&
    track.provenance && String(track.provenance.tier || "") === "sampled");
  const ids = Array.isArray(item.sampledTrackIds) ? item.sampledTrackIds.map(String) : [];
  if (ids.length) {
    const wanted = new Set(ids);
    return sampled.filter((track) => wanted.has(String(track.id)));
  }
  if (typeof item.scope !== "string" || !item.scope.trim()) return [];
  const scope = item.scope.trim();
  return sampled.filter((track) => track.target && typeof track.target.selector === "string" &&
    track.target.selector.trim() === scope);
}

// Pure. The primary track (doc order) carries the recorded identity; when the scope owns
// several per-property tracks the full id list rides along so the verify receipt can name
// every track it must diff.
function introspectedBindingFor(item, doc) {
  if (!item || typeof item !== "object") return null;
  const tracks = introspectedTracksForScope(doc, item.scope);
  if (!tracks.length) return null;
  const primary = tracks[0];
  let fingerprint;
  try { fingerprint = trackFingerprint(primary); } catch (_) { return null; }
  return {
    provenance: "introspected",
    docTrackId: primary.id,
    trackFingerprint: fingerprint,
    ...(tracks.length > 1 ? { docTrackIds: tracks.map((track) => track.id) } : {}),
  };
}

// The write half: refresh bindings on every DECLARED item whose scope matches an
// introspected doc track. Invoked only from explicit write paths (declare reconciliation
// and the verify command itself) — read-only callers (`next`, gates) derive the same
// binding in memory and never write it.
function bindIntrospectedItems(targetDir, docOverride) {
  const doc = docOverride !== undefined ? docOverride : readMotionDoc(targetDir).doc;
  if (!doc) return { bound: [], items: readMotionItems(targetDir).items };
  const current = readMotionItems(targetDir);
  const bound = [];
  for (const item of current.items) {
    if (!isDeclaredItem(item)) continue; // sweep-derived rows stay advisory — never bound
    const binding = introspectedBindingFor(item, doc);
    if (!binding) continue;
    const prior = item.introspectedBinding;
    if (prior && prior.docTrackId === binding.docTrackId && prior.trackFingerprint === binding.trackFingerprint) continue;
    updateMotionItem(targetDir, item.id, { introspectedBinding: binding });
    bound.push(item.id);
  }
  return { bound, items: readMotionItems(targetDir).items };
}

function activeMotionItems(raw) {
  return normalizeMotionItems(raw).filter((item) => !isTerminalMotionItem(item));
}

function readMotionItems(targetDir) {
  const file = path.join(targetDir, "motion-items.json");
  if (!fs.existsSync(file)) return { exists: false, file, raw: null, items: [] };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`${path.basename(file)} is not valid JSON: ${error.message}`); }
  if (raw && raw.schema && !READABLE_SCHEMAS.has(raw.schema)) throw new Error(`unsupported motion-items schema: ${raw.schema}`);
  return { exists: true, file, raw, items: normalizeMotionItems(raw) };
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function updateMotionItem(targetDir, id, patch) {
  if (!SAFE_ID.test(String(id || ""))) throw new Error("motion item id must use only letters, numbers, dot, underscore, or dash");
  const current = readMotionItems(targetDir);
  const items = current.items.map((item) => ({ ...item }));
  const index = items.findIndex((item) => item.id === id);
  const now = new Date().toISOString();
  const prior = index >= 0 ? items[index] : { id, createdAt: now };
  const next = { ...prior, ...(patch || {}), id, updatedAt: now };
  if (index >= 0) items[index] = next;
  else items.push(next);
  const metadata = current.raw && !Array.isArray(current.raw) && typeof current.raw === "object"
    ? Object.fromEntries(Object.entries(current.raw).filter(([key]) => !["schema", "items", "motions"].includes(key)))
    : {};
  atomicJson(current.file, { ...metadata, schema: SCHEMA, items });
  return next;
}

function syncMotionItemsFromBehaviors(targetDir, snapshot, defaults = {}) {
  const current = readMotionItems(targetDir);
  const candidates = motionCandidatesFromSnapshot(snapshot);
  const unowned = [];
  const changedOwners = new Map();
  for (const candidate of candidates) {
    const owner = current.items.find((item) => behaviorKeysOf(item).includes(candidate.behaviorKey));
    if (!owner) {
      unowned.push(candidate);
      continue;
    }
    const fingerprints = owner.sourceBehaviorFingerprints;
    const hasPrior = !!(fingerprints && Object.prototype.hasOwnProperty.call(fingerprints, candidate.behaviorKey));
    const prior = hasPrior ? fingerprints[candidate.behaviorKey] : null;
    // A legacy/manual owner without a recorded baseline remains an owner; establish the
    // fingerprint without claiming its evidence changed. Once a baseline exists, any
    // material timing/engine/trigger/scope change invalidates the previous lifecycle result.
    if (!changedOwners.has(owner.id)) changedOwners.set(owner.id, { owner, rows: [], baselineOnly: [] });
    if (hasPrior && prior !== candidate.fingerprint) changedOwners.get(owner.id).rows.push(candidate);
    else if (!hasPrior) changedOwners.get(owner.id).baselineOnly.push(candidate);
  }

  const updated = [];
  for (const { owner, rows, baselineOnly } of changedOwners.values()) {
    if (!rows.length && !baselineOnly.length) continue;
    const fingerprints = { ...(owner.sourceBehaviorFingerprints || {}) };
    for (const row of [...rows, ...baselineOnly]) fingerprints[row.behaviorKey] = row.fingerprint;
    const patch = { sourceBehaviorFingerprints: fingerprints };
    // The capture/trace/bundle/library receipts describe the old temporal fingerprint. Reopen
    // at pending so routing reacquires that same declared item instead of accepting stale
    // convergence or manufacturing a second owner for the behavior key.
    if (rows.length) {
      const row = rows[0];
      const singleSource = behaviorKeysOf(owner).length === 1;
      const base = `targets/${defaults.name || path.basename(targetDir)}/motion/${owner.id}`;
      const verbatim = /^(?:css-animation|css-transition|waapi)$/.test(row.kind);
      patch.status = "pending";
      patch.kind = row.kind;
      patch.trigger = row.trigger;
      patch.scope = singleSource ? (row.scope || null) : null;
      patch.reason = row.reason;
      if (singleSource) patch.autoGroupKey = row.groupKey;
      if (verbatim) {
        patch.captureDir = owner.captureDir || `${base}/capture`;
        patch.traceDir = null;
      } else {
        patch.traceDir = owner.traceDir || `${base}/trace`;
        patch.captureDir = null;
      }
    }
    updateMotionItem(targetDir, owner.id, patch);
    if (rows.length) updated.push(owner.id);
    const refreshed = readMotionItems(targetDir).items.find((item) => item.id === owner.id);
    const at = current.items.findIndex((item) => item.id === owner.id);
    if (at >= 0) current.items[at] = refreshed;
  }
  // Sweep evidence updates only owners that already exist in the bookkeeping file;
  // unowned candidates return for informational display. `created` stays in the result
  // shape for callers that report reconciliation.
  // Owners re-bind to the live motion doc here; a motion-doc problem is a silent no-op —
  // nothing in this file may block a clone.
  try { bindIntrospectedItems(targetDir); } catch (_) {}
  return { candidates, unowned, created: [], updated, items: readMotionItems(targetDir).items };
}

module.exports = {
  SCHEMA,
  TERMINAL_STATUSES,
  activeMotionItems,
  advisoryMotionCandidates,
  behaviorKeysOf,
  bindIntrospectedItems,
  classifyMotionRow,
  introspectedBindingFor,
  introspectedTracksForScope,
  isDeclaredItem,
  isTemporalBehaviorKey,
  isTerminalMotionItem,
  motionCandidatesFromSnapshot,
  motionReceiptForBehaviorRow,
  normalizeMotionItems,
  ownedMotionCandidate,
  readMotionDoc,
  readMotionItems,
  sampledTracksForItem,
  syncMotionItemsFromBehaviors,
  unownedMotionCandidates,
  updateMotionItem,
};
