#!/usr/bin/env node
/**
 * next.js — read-only capability routing for a clone target.
 *
 * Usage: pingfusi next <name> [--json]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { nextAction } = require("./capability-router.js");
const { SCHEMA: MOTION_ITEMS_SCHEMA, readMotionItems } = require("./motion-items.js");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function optionalJson(file) {
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

function validName(name) {
  return typeof name === "string" && name.length > 0 && name !== "." && name !== ".." && !/[\\/]/.test(name);
}

function loadTarget(work, name) {
  const dir = path.join(work, "targets", name);
  const workflowFile = path.join(dir, "workflow.json");
  if (!fs.existsSync(workflowFile)) {
    const err = new Error(`no workflow for "${name}" — run: pingfusi init ${name} (or pingfusi new ${name} <url>)`);
    err.code = "NO_WORKFLOW";
    throw err;
  }

  let workflow;
  try { workflow = readJson(workflowFile); }
  catch (error) {
    const err = new Error(`targets/${name}/workflow.json is corrupt (${error.message}) — repair it or run: pingfusi init ${name} --force`);
    err.code = "CORRUPT_WORKFLOW";
    throw err;
  }

  const targetFile = path.join(dir, "target.json");
  const liveFile = path.join(dir, "live.json");
  const cloneFile = path.join(dir, "clone.json");
  const behaviorLiveFile = path.join(dir, "behaviors-live.json");
  const behaviorCloneFile = path.join(dir, "behaviors-clone.json");
  const draftFile = path.join(dir, "draft.json");
  const tunnelFile = path.join(dir, "tunnel.json");

  let target = null;
  let behaviorsLive = null;
  let behaviorsClone = null;
  let draft = null;
  let tunnel = null;
  let motionItems = null;
  let motionDocArtifact = null;
  try { target = optionalJson(targetFile); }
  catch (error) { target = { unreadable: error.message }; }
  // The motion doc is an ADDITIVE capture artifact (quarantine): the router uses it to
  // derive introspected-track bindings read-only, and an unreadable doc must never fail
  // routing — it is wrapped, and the router ignores anything without a tracks array.
  try { motionDocArtifact = optionalJson(path.join(dir, "motion-doc.json")); }
  catch (error) { motionDocArtifact = { unreadable: error.message }; }
  try { behaviorsLive = optionalJson(behaviorLiveFile); }
  catch (error) { behaviorsLive = { unreadable: error.message }; }
  try { behaviorsClone = optionalJson(behaviorCloneFile); }
  catch (error) { behaviorsClone = { unreadable: error.message }; }
  try { draft = optionalJson(draftFile); }
  catch (error) { draft = { unreadable: error.message }; }
  try { tunnel = optionalJson(tunnelFile); }
  catch (error) { tunnel = { unreadable: error.message }; }
  try {
    const manifest = readMotionItems(dir);
    // JSON.parse accepts a bare `null` file, which normalizes to zero items; surface it as
    // the corrupt manifest it is instead of dereferencing null for a schema below.
    if (manifest.exists && manifest.raw == null) throw new Error("the file holds JSON null instead of {schema, items}");
    motionItems = manifest.exists ? { schema: (manifest.raw && manifest.raw.schema) || MOTION_ITEMS_SCHEMA, items: manifest.items } : null;
  }
  catch (error) {
    const err = new Error(`targets/${name}/motion-items.json is corrupt or empty (${error.message}) — restore its {schema, items} content or remove that routing manifest`);
    err.code = "CORRUPT_MOTION_ITEMS";
    throw err;
  }

  let gate = null;
  const order = Array.isArray(workflow.phaseOrder) && workflow.phaseOrder.length ? workflow.phaseOrder : Object.keys(workflow.phases || {});
  const phase = order.find((key) => {
    const state = workflow.phases && workflow.phases[key];
    return !state || !["pass", "passed", "complete", "completed", "approved", "done", "exported"].includes(String(state.status || "pending").toLowerCase());
  });
  if (phase === "behavior" && path.resolve(work) === process.cwd()) {
    const workflowApi = require("./workflow.js");
    const behaviorPhase = workflowApi.PHASES.find((candidate) => candidate.key === "behavior");
    const result = workflowApi.safeGate(behaviorPhase, name);
    gate = { phase, ok: result.ok, reason: result.reason };
  }

  return {
    target: name,
    workflow,
    gate,
    motionItems,
    artifacts: {
      target,
      live: fs.existsSync(liveFile),
      clone: fs.existsSync(cloneFile),
      cloneHtml: fs.existsSync(path.join(dir, "clone", "index.html")),
      coverage: fs.existsSync(path.join(dir, "coverage.json")),
      behaviorsLive,
      behaviorsClone,
      draft,
      tunnel,
      motionDoc: motionDocArtifact,
    },
  };
}

function main(argv = process.argv.slice(2), options = {}) {
  const work = options.cwd || process.cwd();
  const name = argv.find((arg) => !arg.startsWith("--"));
  const json = argv.includes("--json");
  if (!validName(name)) {
    console.error("usage: pingfusi next <name> [--json] (name must be one target directory, not a path)");
    return 2;
  }

  let input;
  let action;
  try {
    input = loadTarget(work, name);
    action = nextAction(input);
  }
  catch (error) {
    console.error(`❌ ${error.message}`);
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(action));
  } else {
    console.log(`next — ${action.target}`);
    console.log(`  capability: ${action.capability}`);
    console.log(`  utility:    ${action.utility}`);
    console.log(`  run:        ${action.command}`);
    console.log(`  reason:     ${action.reason}`);
    for (const advisory of action.advisories || []) console.log(`  advisory:   ${advisory}`);
  }
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { main, loadTarget };
