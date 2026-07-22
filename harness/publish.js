#!/usr/bin/env node
// Publish any reviewable static artifact through Pingfusi's hosted-draft service.
// Directories must already be built and contain index.html. A single MP4 is wrapped
// in a tiny static player page and the returned asset_url points at the seekable file.
// This is the workspace-neutral hosted path used by Beautify and Video review; clone
// targets keep their existing `pingfusi draft <name> push` convenience command.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const core = require("../packages/core");
const { MAX_FILE_BYTES } = require("../packages/core/drafts.js");

const USAGE = "usage: pingfusi publish <built-dir|video.mp4> [--name <label>] [--target <clone-target>] [--record <file>] [--json]";

function parseArgs(argv) {
  if (!argv[0] || argv[0] === "--help" || argv[0] === "-h") {
    return { help: true };
  }
  const out = { sourcePath: argv[0], name: null, target: null, recordPath: null, json: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") { out.json = true; continue; }
    if (["--name", "--target", "--record"].includes(arg)) {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a value — ${USAGE}`);
      if (arg === "--name") out.name = value;
      if (arg === "--target") out.target = value;
      if (arg === "--record") out.recordPath = value;
      continue;
    }
    throw new Error(`unknown option ${arg} — ${USAGE}`);
  }
  if (out.target && (!/^[A-Za-z0-9_-]+$/.test(out.target) || out.target === "." || out.target === "..")) {
    throw new Error(`--target must be a target name, not a path (got ${JSON.stringify(out.target)})`);
  }
  return out;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[ch]);
}

function prepareSource(sourcePath) {
  const resolved = path.resolve(sourcePath);
  if (!fs.existsSync(resolved)) throw new Error(`${resolved} does not exist`);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    const indexPath = path.join(resolved, "index.html");
    if (!fs.existsSync(indexPath)) {
      throw new Error(`${resolved} is not a publishable static build: index.html is missing`);
    }
    return { dir: resolved, kind: "website", assetRelative: null, cleanup() {} };
  }
  if (!stat.isFile() || path.extname(resolved).toLowerCase() !== ".mp4") {
    throw new Error(`${resolved} must be a built directory or an .mp4 file`);
  }
  if (stat.size < 2) throw new Error(`${resolved} is empty`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`${resolved} is ${stat.size} bytes (> ${MAX_FILE_BYTES} hosted-video cap); render a smaller MP4 or use another public Range-serving host`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-publish-"));
  const assetRelative = "video.mp4";
  fs.copyFileSync(resolved, path.join(tempDir, assetRelative));
  const title = escapeHtml(path.basename(resolved));
  fs.writeFileSync(path.join(tempDir, "index.html"), `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>html,body{margin:0;min-height:100%;background:#090909;color:#fff;font:16px system-ui}body{display:grid;place-items:center}video{display:block;max-width:100%;max-height:100vh}</style>
<video controls preload="metadata" src="./${assetRelative}"></video>
`);
  return {
    dir: tempDir,
    kind: "video",
    assetRelative,
    cleanup() { fs.rmSync(tempDir, { recursive: true, force: true }); },
  };
}

function atomicWriteJson(file, value) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temp = `${resolved}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(temp, resolved);
  return resolved;
}

function assetUrl(base, relative) {
  return `${String(base).replace(/\/+$/, "")}/${relative.split("/").map(encodeURIComponent).join("/")}`;
}

async function publishPath(options, deps = {}) {
  const push = deps.push || core.draft.push;
  const workDir = path.resolve(deps.workDir || process.cwd());
  let targetReceipt = null;
  if (options.target) {
    const targetDir = path.join(workDir, "targets", options.target);
    if (!fs.existsSync(targetDir)) {
      throw new Error(`targets/${options.target} does not exist — run pingfusi adopt ${options.target} <original-url> first`);
    }
    targetReceipt = path.join(targetDir, "draft.json");
  }
  const prepared = prepareSource(options.sourcePath);
  try {
    const sourceBase = path.basename(path.resolve(options.sourcePath));
    const label = options.name || (prepared.kind === "video" ? path.basename(sourceBase, path.extname(sourceBase)) : sourceBase);
    const hosted = await push(prepared.dir, { name: label });
    const result = {
      kind: prepared.kind,
      url: hosted.url,
      asset_url: prepared.assetRelative ? assetUrl(hosted.url, prepared.assetRelative) : null,
      slug: hosted.slug,
      expires_at: hosted.expires_at || null,
      files: hosted.files,
      bytes: hosted.bytes,
      verifiedSha256: hosted.verifiedSha256,
      pushedAt: hosted.pushedAt,
    };
    const receipts = [];
    if (targetReceipt) receipts.push(atomicWriteJson(targetReceipt, result));
    if (options.recordPath) receipts.push(atomicWriteJson(options.recordPath, result));
    return { ...result, receipts };
  } finally {
    prepared.cleanup();
  }
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); }
  catch (error) { console.error(`✗ ${error.message}`); process.exitCode = 2; return; }
  if (options.help) { console.log(USAGE); return; }
  try {
    const result = await publishPath(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`✓ hosted ${result.kind} — expires ${result.expires_at || "per service policy"}`);
    console.log(`  page: ${result.url}`);
    if (result.asset_url) console.log(`  video_url: ${result.asset_url}`);
    for (const receipt of result.receipts) console.log(`  receipt: ${receipt}`);
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
module.exports = { USAGE, parseArgs, prepareSource, assetUrl, publishPath, main };
