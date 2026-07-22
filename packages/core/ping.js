// packages/core/ping.js — the one-question poll verb over wire.js: put one small
// question in front of a reviewer (up to 1 credit; the send operation owns the
// renewable wait), and the passive free re-fetch of its answers.
// ADVISORY ONLY by doctrine: polls never satisfy a review gate — the gate still
// requires an approving verdict on a full scope-pinned round (harness/review-qa.js).
"use strict";

const { rpc } = require("./wire.js");

async function ping(question, { choices, nTarget = 1, deadlineSeconds, timeoutMs = 320_000 } = {}) {
  const args = { question, n_target: nTarget };
  // Omit the field by default so the service applies its short renewable
  // agent lease. A caller may still request an explicit longer window.
  if (deadlineSeconds !== undefined) args.deadline_seconds = deadlineSeconds;
  if (choices && choices.length) args.choices = choices;
  return rpc("quick_poll", args, timeoutMs);
}

// Passive free re-fetch of a pending poll's answers. This does not renew the
// short idle lease; normal ping() already owned the wait.
async function pingResult(ping_id) {
  return rpc("get_ping", { ping_id });
}

module.exports = { ping, pingResult };
