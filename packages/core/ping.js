// packages/core/ping.js — the one-question poll verb over wire.js: put one small
// question in front of a reviewer (up to 1 credit; the server blocks up to ~300s, so
// an answer often arrives inside the call), and the free re-fetch of its answers.
// ADVISORY ONLY by doctrine: polls never satisfy a review gate — the gate still
// requires an approving verdict on a full scope-pinned round (harness/review-qa.js).
"use strict";

const { rpc } = require("./wire.js");

async function ping(question, { choices, nTarget = 1, deadlineSeconds = 3600, timeoutMs = 320_000 } = {}) {
  const args = { question, n_target: nTarget, deadline_seconds: deadlineSeconds };
  if (choices && choices.length) args.choices = choices;
  return rpc("quick_poll", args, timeoutMs);
}

// Free re-fetch of a pending poll's answers.
async function pingResult(ping_id) {
  return rpc("get_ping", { ping_id });
}

module.exports = { ping, pingResult };
