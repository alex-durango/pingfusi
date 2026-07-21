// packages/core/index.js — the four-verb façade any coding agent needs from the review
// service: ping (one question), review {file, wait, verify} (a full round against a
// caller-owned state file), draft {push, status, delete} (a hosted public draft).
// Built ONLY from the extracted primitives (wire/rounds/drafts/ping) so the state file
// keeps review-qa.json's exact shape and the wire calls stay byte-identical to the
// kit's own — this façade adds no policy of its own. The kit's cloning pipeline keeps
// its richer CLI flows in harness/review-qa.js + harness/draft.js (guards, receipts,
// scope-pinned spec generation); this is the generic surface underneath them.
"use strict";

const fs = require("fs");
const path = require("path");
const wire = require("./wire.js");
const rounds = require("./rounds.js");
const drafts = require("./drafts.js");
const { ping, pingResult } = require("./ping.js");

// ── review.file — file a round and record it in the caller's state file ───────
// `spec` is a full round spec (request_review-shaped). approve_verdicts and
// review_contract are LOCAL round bookkeeping, never wire fields — stripped off the
// tool args exactly as harness/review-qa.js `file` does.
class ReviewSpecError extends Error {
  constructor(message) {
    super(`review.file: ${message}`);
    this.name = "ReviewSpecError";
    this.code = "PINGFUSI_REVIEW_SPEC_INVALID";
  }
}

function validateReviewSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new ReviewSpecError("spec must be a request_review-shaped object");
  }
  const { maxSteps, maxStepTextChars, maxOptionChars } = wire.SERVICE_CAPS;
  if (spec.steps !== undefined && !Array.isArray(spec.steps)) {
    throw new ReviewSpecError("steps must be an array when provided");
  }
  const steps = spec.steps || [];
  if (steps.length > maxSteps) {
    throw new ReviewSpecError(`steps has ${steps.length} entries; the service accepts at most ${maxSteps} — split or shorten the round`);
  }
  const validateOptions = (options, field) => {
    if (options === undefined) return;
    if (!Array.isArray(options)) throw new ReviewSpecError(`${field} must be an array when provided`);
    options.forEach((option, optionIndex) => {
      if (typeof option !== "string") throw new ReviewSpecError(`${field}[${optionIndex}] must be a string of at most ${maxOptionChars} chars`);
      if (option.length > maxOptionChars) {
        throw new ReviewSpecError(`${field}[${optionIndex}] is ${option.length} chars; the service accepts at most ${maxOptionChars} — shorten that option`);
      }
    });
  };
  steps.forEach((step, stepIndex) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new ReviewSpecError(`steps[${stepIndex}] must be an object with a text field`);
    }
    if (typeof step.text !== "string") {
      throw new ReviewSpecError(`steps[${stepIndex}].text must be a string of at most ${maxStepTextChars} chars`);
    }
    if (step.text.length > maxStepTextChars) {
      throw new ReviewSpecError(`steps[${stepIndex}].text is ${step.text.length} chars; the service accepts at most ${maxStepTextChars} — shorten that step`);
    }
    validateOptions(step.options, `steps[${stepIndex}].options`);
  });
  validateOptions(spec.verdict_options, "verdict_options");
  if (spec.n_target !== undefined && (!Number.isInteger(spec.n_target) || spec.n_target < 1 || spec.n_target > wire.MAX_REVIEW_RESULTS)) {
    throw new ReviewSpecError(`n_target must be a whole number from 1 to ${wire.MAX_REVIEW_RESULTS}; got ${JSON.stringify(spec.n_target)}`);
  }
}

async function reviewFile(stateFile, spec) {
  // Validate before even assembling the wire payload: service cap failures consume no
  // network call and name the exact field the caller must shorten or correct.
  validateReviewSpec(spec);
  const { approve_verdicts, review_contract, ...toolArgs } = spec;
  void review_contract; // local routing contract; the existing backend schema is unchanged
  const r = await wire.rpc("request_review", toolArgs);
  if (!r.ping_id) throw new Error("filing returned no ping_id");
  const round = rounds.pushRound(stateFile, r.ping_id, spec, approve_verdicts);
  return { ping_id: r.ping_id, round };
}

// ── review.wait — fetch a round's current result envelope (no state write) ────
async function reviewWait(ping_id, { timeoutMs } = {}) {
  return wire.rpc("get_test_results", { ping_id }, timeoutMs);
}

// ── review.verify — the LATEST round's verdict, persisted + judged ────────────
// Fetches fresh every time (a cached approval is never trusted), persists the same
// round.last envelope harness/review-qa.js `verify` writes (semantic responses,
// verbatim comment envelope, result_sha256, checked_at, verdict_source receipts),
// and returns a structured outcome instead of printing/exiting — the caller owns
// presentation. Verdict fallbacks are the same two narrow exact-match exceptions
// (verdict_step_answer, free_text_exact_match) documented in rounds.js.
async function reviewVerify(stateFile) {
  const hq = rounds.loadRounds(stateFile);
  if (!hq.rounds.length) return { ok: false, status: "no-round" };
  const round = hq.rounds[hq.rounds.length - 1];
  const sc = await wire.rpc("get_test_results", { ping_id: round.ping_id });
  const requestedTarget = round.n_target || sc.n_target || 1;
  const responses = rounds.semanticResponsesOf(sc);
  const comments = rounds.semanticCommentsOf(sc);
  round.last = {
    status: sc.status,
    n_received: sc.n_received,
    n_target: requestedTarget,
    result_sha256: rounds.sha256Json({ status: sc.status, n_received: sc.n_received, n_target: requestedTarget, responses, comments }),
    responses,
    comments,
  };
  round.checked_at = new Date().toISOString();
  rounds.saveRounds(stateFile, hq);
  const received = Math.max(Number(sc.n_received) || 0, responses.length);
  if (sc.status === "pending" && received < requestedTarget) return { ok: false, status: "pending", received, requestedTarget, round, comments };
  if (!responses.length) return { ok: false, status: sc.status === "expired" ? "expired" : "pending", received, requestedTarget, round, comments };
  const verdictStepIndex = rounds.verdictStepIndexOf(sc);
  const allVerdicts = round.verdict_options || round.approve_verdicts || [];
  if (rounds.applyVerdictStepAnswers(sc, responses, allVerdicts, verdictStepIndex)) {
    round.verdict_source = "verdict_step_answer";
    rounds.saveRounds(stateFile, hq);
  }
  const rawComments = Array.isArray(sc.comments) ? sc.comments : [];
  if (rounds.applyFreeTextVerdicts(responses, rawComments, round.approve_verdicts, verdictStepIndex)) {
    round.verdict_source = "free_text_exact_match";
    rounds.saveRounds(stateFile, hq);
  }
  const unpicked = responses.filter((r) => r.verdict == null);
  if (unpicked.length) return { ok: false, status: "no-verdict", unpicked, round, comments };
  const rejected = responses.filter((r) => !(round.approve_verdicts || []).includes(r.verdict));
  if (rejected.length) return { ok: false, status: "rejected", rejected, round, comments };
  return { ok: true, status: "approved", verdict: responses[0].verdict, round, comments };
}

// ── draft.push — upload a static dir, verify the served bytes, return the record ──
// Same wire sequence as harness/draft.js push (create → PUT uploads → finalize →
// rewrite-aware byte verify), throwing named failures instead of printing; the caps
// are checked locally first so a too-big bundle never moves bytes. Returns the exact
// record harness/draft.js writes to draft.json.
async function draftPush(dir, { name } = {}) {
  const idx = path.join(dir, "index.html");
  if (!fs.existsSync(idx)) throw new Error(`${idx} missing — a hosted draft serves a static bundle with index.html at its root`);
  const files = drafts.buildManifest(dir);
  const total = files.reduce((n, f) => n + f.bytes, 0);
  if (files.length > drafts.MAX_FILES) throw new Error(`${files.length} files (> ${drafts.MAX_FILES} cap)`);
  const big = files.find((f) => f.bytes > drafts.MAX_FILE_BYTES);
  if (big) throw new Error(`${big.path} is ${big.bytes} bytes (> ${drafts.MAX_FILE_BYTES} per-file cap)`);
  if (total > drafts.MAX_TOTAL_BYTES) throw new Error(`${total} bytes total (> ${drafts.MAX_TOTAL_BYTES} total cap)`);
  const created = await drafts.api("/api/draft", { method: "POST", body: { name: name || path.basename(path.dirname(dir)) || "draft", files } });
  const slug = created.slug;
  if (!drafts.SLUG_RE.test(String(slug || "")) || !Array.isArray(created.uploads)) throw new Error("draft create returned no valid slug/uploads");
  for (const u of created.uploads) {
    const buf = fs.readFileSync(path.join(dir, u.path));
    const r = await drafts.fetchOrExplain(`upload ${u.path}`, u.url, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: buf, signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`upload ${u.path} → HTTP ${r.status}`);
  }
  await drafts.api(`/api/draft/${slug}/finalize`, { method: "POST" });
  // Serve urls are built from OUR base, not the server's echo — a BASE override
  // (staging, file:// selftests) must stay consistent end-to-end.
  const url = `${wire.BASE}/d/${slug}`;
  const v = await drafts.verifyDraftServes(url, idx, slug);
  if (!v.ok) throw new Error(`draft finalized but the served bytes don't verify: ${v.reason}`);
  return { url, slug, expires_at: created.expires_at || null, files: files.length, bytes: total, verifiedSha256: v.sha256, pushedAt: new Date().toISOString() };
}

// ── draft.status — re-verify a recorded draft's served bytes ──────────────────
async function draftStatus(record, indexPath) {
  return drafts.verifyDraftServes(record.url, indexPath, record.slug);
}

// ── draft.delete — delete a hosted draft by slug ──────────────────────────────
async function draftDelete(slug) {
  return drafts.api(`/api/draft/${slug}`, { method: "DELETE" });
}

module.exports = {
  wire, rounds, drafts,
  ping, pingResult,
  review: { file: reviewFile, wait: reviewWait, verify: reviewVerify },
  draft: { push: draftPush, status: draftStatus, delete: draftDelete },
};
