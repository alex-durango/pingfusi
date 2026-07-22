// packages/core/rounds.js — round records: the load/save/push primitives over a STATE
// FILE PATH the caller provides, the semantic response/comment envelope, verdict
// handling, and the ⌖ per-comment readback. Extracted from harness/review-qa.js
// (2026-07-20 core extraction) — the state file keeps review-qa.json's EXACT shape; the
// kit passes targets/<name>/review-qa.json, but this module never knows about targets/.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

// ── round state ───────────────────────────────────────────────────────────────
const loadRounds = (stateFile) => (fs.existsSync(stateFile) ? readJson(stateFile) : { rounds: [] });
const saveRounds = (stateFile, hq) => fs.writeFileSync(stateFile, JSON.stringify(hq, null, 2) + "\n");

function pushRound(stateFile, ping_id, spec, approve) {
  const hq = loadRounds(stateFile);
  hq.rounds.push({
    ping_id,
    draft_url: (spec && spec.draft_url) || null,
    region: (spec && spec.title) || null,
    n_target: (spec && spec.n_target) || null,
    approve_verdicts: approve,
    verdict_options: (spec && spec.verdict_options) || null,
    review_contract: (spec && spec.review_contract) || null,
    filed_at: new Date().toISOString(),
    last: null,
    checked_at: null,
  });
  saveRounds(stateFile, hq);
  return hq.rounds.length;
}

// A diagnostic round NEVER satisfies a review gate: recorded in hq.diagnostics, and
// verify reads hq.rounds only (see harness/review-qa.js for the doctrine).
function pushDiagnostic(stateFile, ping_id, spec, region, assistMeta) {
  const hq = loadRounds(stateFile);
  hq.diagnostics = hq.diagnostics || [];
  hq.diagnostics.push({ ping_id, kind: "diagnostic", region, draft_url: (spec && spec.draft_url) || null, n_target: (spec && spec.n_target) || null, filed_at: new Date().toISOString(), deadline_seconds: (spec && spec.deadline_seconds) || 60, last: null, checked_at: null, ...(assistMeta ? { assist: assistMeta } : {}) });
  saveRounds(stateFile, hq);
  return hq.diagnostics.length;
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// ── align-delta parsing ───────────────────────────────────────────────────────
// An alignment "move" comment carries its numbers ONLY inside the app's alignText
// prose ("Alignment (measured at 1512px-wide viewport; element is 200×48px): this
// element should move -4px right, 12px down and scale ×1.05 to match the original.").
// Parse them back out, tolerantly: right/down are the canonical signed axes, but
// left/up variants negate; scale accepts × or x. NEVER guess — a field that doesn't
// parse is null, and if none of tx/ty/scale parse the whole result is null (the
// verbatim prose is still shown to the agent either way).
function parseAlignDeltas(text) {
  const s = String(text || "");
  const mx = /(-?\d+(?:\.\d+)?)\s*px\s+(right|left)\b/i.exec(s);
  const my = /(-?\d+(?:\.\d+)?)\s*px\s+(down|up)\b/i.exec(s);
  const ms = /scale\s*[×x]\s*(-?\d+(?:\.\d+)?)/i.exec(s);
  const mv = /measured\s+at\s+(\d+(?:\.\d+)?)\s*px[- ]wide\s+viewport/i.exec(s);
  const tx = mx ? parseFloat(mx[1]) * (/left/i.test(mx[2]) ? -1 : 1) : null;
  const ty = my ? parseFloat(my[1]) * (/up/i.test(my[2]) ? -1 : 1) : null;
  const scale = ms ? parseFloat(ms[1]) : null;
  if (tx === null && ty === null && scale === null) return null;
  return { tx, ty, scale, viewportW: mv ? parseFloat(mv[1]) : null };
}

// ── the semantic envelope: what a round result persists ──────────────────────
// Real response schema (verified empirically): the verdict pick is `choice`, prose is
// `free_text`; older/other shapes may use `verdict`/`notes` — accept both.
function semanticResponsesOf(sc) {
  return (sc.responses || []).map((r) => ({
    verdict: r.choice != null ? r.choice : (r.verdict != null ? r.verdict : null),
    notes: r.free_text || r.notes || r.comment || null,
    steps_result: Array.isArray(r.steps_result) ? r.steps_result : [],
  }));
}

// Persist the WHOLE structured envelope the compare tools post (side, selector,
// target label, op move/delete, the drawn annotation with its 0..1 points kept
// VERBATIM, viewport, rect, dual-anchor other, kind/position from newer app
// builds) — every field absent-tolerant, because older rounds carry text-only
// comments. A field dropped here is a reviewer's mark the agent never sees.
// `alignDeltas` is derived: the tx/ty/scale a "move" comment carries only inside
// its prose, parsed by parseAlignDeltas (null when unparseable — never guessed).
function semanticCommentsOf(sc) {
  return (Array.isArray(sc.comments) ? sc.comments : []).map((comment) => {
    const kept = {
      step_index: comment.step_index,
      text: comment.text || null,
      text_sha256: comment.text ? crypto.createHash("sha256").update(String(comment.text)).digest("hex") : null,
    };
    for (const key of ["side", "selector", "target", "op", "kind", "annotation", "viewport", "rect", "other", "position"]) {
      if (comment[key] !== undefined && comment[key] !== null) kept[key] = comment[key];
    }
    const alignDeltas = parseAlignDeltas(comment.text);
    if (alignDeltas) kept.alignDeltas = alignDeltas;
    return kept;
  });
}

// ── verdict handling ──────────────────────────────────────────────────────────
// A response with NO verdict pick normally can never pass: INFERRING approval from prose
// is the exact hole review gates exist to close. There are two narrow, non-inferring
// exceptions, and they exist because the reviewer-facing UI can make the pick IMPOSSIBLE
// (the round-level verdict button does not render — app update pending). Both demand an
// EXACT match against the round's own declared verdict strings — not a sentiment read,
// not a keyword search, not "looks good" — and both receipt themselves via
// `verdict_source` so no one later mistakes them for a real pick. The full history
// (lelabo rounds 4-5, chrono24 rounds 2-4, opendesign round 2) lives at the call site
// in harness/review-qa.js `verify`.
const normVerdict = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const verdictStepIndexOf = (sc) => Math.max(0, ((sc.responses || [])[0]?.steps_result || []).length - 1);

// A verdict TAPPED on the verdict step: the step carries the verdict strings as
// `options` precisely because option-bearing STEPS render as pickers in today's app
// while the round-level button does not. A tapped option is the verdict through a
// working control — accepted for approval AND rejection (a tapped "clearly different"
// is a verdict, not a missing one), matched exactly against the round's own declared
// list, receipted as verdict_step_answer. Mutates the matched entries in `resp`;
// returns how many matched.
function applyVerdictStepAnswers(sc, resp, allVerdicts, verdictStepIndex) {
  let answerMatched = 0;
  (sc.responses || []).forEach((raw, i) => {
    const r = resp[i];
    if (!r || r.verdict != null) return;
    const ans = normVerdict((((raw || {}).steps_result || [])[verdictStepIndex] || {}).answer);
    if (!ans) return;
    const hit = allVerdicts.find((v) => normVerdict(v) === ans);
    if (hit) { r.verdict = hit; r.verdict_source = "verdict_step_answer"; answerMatched++; }
  });
  return answerMatched;
}

// The free-text bridge: a comment ON THE VERDICT STEP whose text exactly equals a
// declared approve verdict — it carries exactly the information the missing button
// would have carried, entered through the only field the UI offered. NARROW ON
// PURPOSE: the match must come from the VERDICT STEP ITSELF, and equal a declared
// approve verdict exactly. A comment anywhere else, or prose that merely sounds
// approving ("looks good"), still fails — as it must (opendesign round 2: a PIN
// comment on a <div> read "Header identical" — a description of an element, not a
// verdict). Mutates the matched entries in `resp`; returns how many matched.
function applyFreeTextVerdicts(resp, comments, approveVerdicts, verdictStepIndex) {
  let freeTextMatched = 0;
  for (const r of resp) {
    if (r.verdict != null) continue;
    const onVerdictStep = comments.filter((c) => c.step_index === verdictStepIndex).map((c) => normVerdict(c.text));
    const hit = (approveVerdicts || []).find((v) => onVerdictStep.includes(normVerdict(v)));
    if (hit) { r.verdict = hit; r.verdict_source = "free_text_exact_match"; freeTextMatched++; }
  }
  return freeTextMatched;
}

// ── the per-comment readback ──────────────────────────────────────────────────
// The verdict line says WHETHER the round passed; these blocks say WHAT the reviewer
// actually marked. The compare tools post rich structured marks (side, selector,
// target label, op, a drawn annotation whose points are 0..1 fractions of the anchor
// element's box, the measuring viewport, the element rect, the dual-anchor `other`
// element) — printing only the verdict threw all of that away and the agent flew
// blind on exactly the feedback it paid a round for. Printed on ALL THREE response
// outcomes — approval (approved rounds still carry notes worth reading), rejection,
// AND the no-verdict-pick failure (the comments are the ONLY feedback that state
// has). One block per comment:
//   ⌖ DRAFT · <target> [<selector>] — <op/shape hint> — "<text>" (step N)
//      region: x[10%–48%] y[5%–20%] of the element (viewport 1512×982)
//      align: move 4px left, 12px down, scale ×1.05 (measured at 1512px)
//      other side: <label>
//      measured elements under the mark: <slug>, <slug>
// The last line is a pure read of the existing snapshots in `dir` (live.json for a
// mark on the original, clone.json for one on the draft): leaves whose measured boxes
// intersect the comment's rect, most-covered first — it names the kit's own slugs for
// the spot the reviewer marked, so the agent can jump straight to the diff rows.
function printCommentBlocks(dir, comments, log) {
  if (!Array.isArray(comments) || !comments.length) return;
  const snapshots = {};
  const snapshotFor = (side) => {
    const file = side === "original" ? "live.json" : side === "draft" ? "clone.json" : null;
    if (!file) return null;
    if (!(file in snapshots)) {
      try { snapshots[file] = readJson(path.join(dir, file)); } catch (e) { snapshots[file] = null; }
    }
    return snapshots[file];
  };
  const finiteRect = (r) => r && ["x", "y", "w", "h"].every((k) => Number.isFinite(r[k]));
  const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  for (const c of comments) {
    if (!c || typeof c !== "object") continue;
    const hint = [];
    if (c.op) hint.push(String(c.op));
    if (c.kind && c.kind !== c.op) hint.push(String(c.kind));
    const points = (c.annotation && Array.isArray(c.annotation.points))
      ? c.annotation.points.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      : [];
    if (c.annotation && c.annotation.shape) hint.push(`drawn ${c.annotation.shape}`);
    else if (points.length) hint.push("drawn mark");
    let head = `  ⌖ ${c.side ? String(c.side).toUpperCase() : "NOTE"} · ${c.target || c.selector || "(unanchored)"}`;
    if (c.selector) head += ` [${c.selector}]`;
    head += ` — ${hint.join(" + ") || "note"} — "${c.text || ""}"`;
    if (c.step_index != null) head += ` (step ${c.step_index})`;
    log(head);
    if (points.length) {
      // annotation points are 0..1 fractions of the anchored element's box — the bbox
      // says WHICH SUB-REGION of the element the reviewer marked.
      const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
      const pct = (v) => `${Math.round(v * 100)}%`;
      let line = `     region: x[${pct(Math.min(...xs))}–${pct(Math.max(...xs))}] y[${pct(Math.min(...ys))}–${pct(Math.max(...ys))}] of the element`;
      if (c.viewport && Number.isFinite(c.viewport.w) && Number.isFinite(c.viewport.h)) line += ` (viewport ${c.viewport.w}×${c.viewport.h})`;
      log(line);
    }
    if (c.alignDeltas) {
      const d = c.alignDeltas;
      const dir = (v, pos, neg) => `${Math.abs(v)}px ${v < 0 ? neg : pos}`;
      const parts = [];
      const move = [];
      if (d.tx !== null && d.tx !== undefined) move.push(dir(d.tx, "right", "left"));
      if (d.ty !== null && d.ty !== undefined) move.push(dir(d.ty, "down", "up"));
      if (move.length) parts.push(`move ${move.join(", ")}`);
      if (d.scale !== null && d.scale !== undefined) parts.push(`scale ×${d.scale}`);
      log(`     align: ${parts.join(", ")}${d.viewportW ? ` (measured at ${d.viewportW}px)` : ""}`);
    }
    if (c.other && (c.other.label || c.other.selector)) {
      log(`     other side: ${c.other.label || "(unlabeled)"}${c.other.selector ? ` [${c.other.selector}]` : ""}`);
    }
    // Element cross-check — a pure read of the existing snapshot for the comment's
    // side. Only when the geometry is actually comparable: same viewport width the
    // capture was measured at, else the px coordinates mean different layouts.
    if (c.selector && finiteRect(c.rect) && c.viewport && Number.isFinite(c.viewport.w)) {
      const snap = snapshotFor(c.side);
      if (snap && snap.elements && snap.viewport && Number.isFinite(snap.viewport.width)) {
        if (snap.viewport.width !== c.viewport.w) {
          log(`     (viewport differs from capture width — skipping element match)`);
        } else {
          const hits = Object.entries(snap.elements)
            .filter(([, e]) => e && e.present && finiteRect(e.rect) && overlap(e.rect, c.rect) > 0)
            .map(([slug, e]) => ({ slug, share: overlap(e.rect, c.rect) / Math.max(1, e.rect.w * e.rect.h) }))
            .sort((a, b) => b.share - a.share)
            .slice(0, 5);
          if (hits.length) log(`     measured elements under the mark: ${hits.map((h) => h.slug).join(", ")}`);
        }
      }
    }
  }
}

module.exports = {
  loadRounds, saveRounds, pushRound, pushDiagnostic,
  sha256Json, parseAlignDeltas,
  semanticResponsesOf, semanticCommentsOf,
  normVerdict, verdictStepIndexOf, applyVerdictStepAnswers, applyFreeTextVerdicts,
  printCommentBlocks,
};
