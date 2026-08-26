#!/usr/bin/env node
// Upload a game build (one zip) to Pingfusi's hosted build store so reviewers
// can playtest it without a store page. Prints the /b/<slug> URL to file the
// playtest with (the review tool, platform:'windows'|'macos', url:<that URL>).
//
// Hosted builds are TEMPORARY by design: they live 72 hours unless a filed
// round extends them, and each account holds at most a handful at once —
// this hosts a playtest round, not a game. Reviewers are told up front the
// build is an unreviewed developer upload and may stop, penalty-free. On
// macOS the reviewer app downloads and launches the build itself (no browser
// quarantine, no Gatekeeper wall), which is why an unsigned .app is refused
// at upload — ad-hoc is enough (codesign -s -).
"use strict";

const path = require("path");
const core = require("../packages/core");
const { MAX_BUILD_BYTES } = require("../packages/core/builds.js");

// Brand parameterization (a wrapper brand's bin passes its own command name and
// the tool name its mount registers); the defaults keep the stock pingfusi bytes.
const usageFor = (brandCommand) =>
  `usage: ${brandCommand} <game.zip> --platform windows|macos [--name <label>] [--record <file>] [--json]`;
const BRAND_COMMAND = "pingfusi publish-build";
// The job-named review tool the /api/mcp mount registers — the old next-step
// named the kit's INTERNAL verb (request_review), which no mount registers.
const NEXT_STEP_TOOL = "pingfusi_review_website";
const USAGE = usageFor(BRAND_COMMAND);

function parseArgs(argv, usage = USAGE) {
  if (!argv[0] || argv[0] === "--help" || argv[0] === "-h") {
    return { help: true };
  }
  const out = { sourcePath: argv[0], platform: null, name: null, recordPath: null, json: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") { out.json = true; continue; }
    if (["--platform", "--name", "--record"].includes(arg)) {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a value — ${usage}`);
      if (arg === "--platform") out.platform = value;
      if (arg === "--name") out.name = value;
      if (arg === "--record") out.recordPath = value;
      continue;
    }
    throw new Error(`unknown option ${arg} — ${usage}`);
  }
  if (out.platform !== "windows" && out.platform !== "macos") {
    throw new Error(`--platform windows|macos is required (the reviewer pool the build is for) — ${usage}`);
  }
  return out;
}

const fmtMb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/** ~1 Hz single-line stderr progress; silent when stderr isn't a TTY. */
function makeProgressRenderer() {
  if (!process.stderr.isTTY) return null;
  let lastAt = 0;
  return (loaded, total, startedAt) => {
    const now = Date.now();
    if (now - lastAt < 1000 && loaded < total) return;
    lastAt = now;
    const pct = Math.floor((loaded / total) * 100);
    const rate = loaded / Math.max((now - startedAt) / 1000, 0.001);
    process.stderr.write(`\r  uploading ${fmtMb(loaded)}/${fmtMb(total)} — ${pct}% — ${fmtMb(rate)}/s   `);
    if (loaded >= total) process.stderr.write("\n");
  };
}

async function publishBuild(options, deps = {}) {
  const push = deps.push || core.build.push;
  const result = await push(path.resolve(options.sourcePath), {
    name: options.name,
    platform: options.platform,
    onProgress: deps.onProgress === undefined ? makeProgressRenderer() : deps.onProgress,
  });
  const receipts = [];
  if (options.recordPath) {
    // Same atomic-receipt shape as publish.js — one JSON the round can read.
    const fs = require("fs");
    const resolved = path.resolve(options.recordPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const temp = `${resolved}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(result, null, 2) + "\n");
    fs.renameSync(temp, resolved);
    receipts.push(resolved);
  }
  return { ...result, receipts };
}

// opts is the wrapper-brand seam: {brandCommand, nextStepToolName} — absent,
// the stock pingfusi defaults print.
async function main(argv = process.argv.slice(2), opts = {}) {
  const brandCommand = opts.brandCommand || BRAND_COMMAND;
  const nextStepToolName = opts.nextStepToolName || NEXT_STEP_TOOL;
  const usage = usageFor(brandCommand);
  let options;
  try { options = parseArgs(argv, usage); }
  catch (error) { console.error(`✗ ${error.message}`); process.exitCode = 2; return; }
  if (options.help) { console.log(usage); return; }
  try {
    const result = await publishBuild(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`✓ hosted build — expires ${result.expires_at || "per service policy"} (temporary by design; filing a playtest extends it through the round)`);
    console.log(`  url: ${result.url}`);
    console.log(`  file: ${result.filename} (${fmtMb(result.bytes)}, sha256 ${result.sha256.slice(0, 16)}…)`);
    for (const receipt of result.receipts) console.log(`  receipt: ${receipt}`);
    console.log(`  next: file the playtest — ${nextStepToolName} with platform:'${result.platform}', url:'${result.url}', est_minutes:<5-30>`);
    if (result.platform === "macos") {
      console.log("  note: the reviewer app downloads and launches the build itself after an unreviewed-build disclosure — no Gatekeeper wall. Pre-flighted here on Macs: Mach-O main executable required, arm64 slices at least ad-hoc signed.");
    } else {
      console.log("  note: reviewers are told this is an unreviewed dev build and may stop at a Windows warning, penalty-free.");
    }
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
module.exports = { USAGE, parseArgs, publishBuild, main, MAX_BUILD_BYTES };
