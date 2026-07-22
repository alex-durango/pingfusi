#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { MAX_FILE_BYTES } = require("../packages/core/drafts.js");
const { parseArgs, prepareSource, publishPath } = require("./publish.js");

let failed = 0;
const ok = (condition, label) => {
  console.log(`${condition ? "✓" : "✗"} ${label}`);
  if (!condition) failed++;
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-publish-test-"));

(async () => {
  try {
    const parsed = parseArgs(["dist", "--name", "demo", "--target", "site", "--record", "receipt.json", "--json"]);
    ok(parsed.sourcePath === "dist" && parsed.name === "demo" && parsed.target === "site" && parsed.recordPath === "receipt.json" && parsed.json,
      "CLI options describe one hosted artifact and optional receipts");

    const web = path.join(root, "dist");
    fs.mkdirSync(web);
    fs.writeFileSync(path.join(web, "index.html"), "<h1>built</h1>");
    fs.mkdirSync(path.join(root, "targets", "site"), { recursive: true });
    let pushedDir = null;
    const website = await publishPath({ sourcePath: web, name: "site", target: "site", recordPath: null }, {
      workDir: root,
      push: async (dir) => {
        pushedDir = dir;
        return { url: "https://pingfusi.com/d/abc123DEF456", slug: "abc123DEF456", expires_at: "soon", files: 1, bytes: 14, verifiedSha256: "abc", pushedAt: "now" };
      },
    });
    ok(pushedDir === web && website.kind === "website" && website.asset_url === null,
      "a built website directory publishes without a tunnel");
    const targetReceipt = JSON.parse(fs.readFileSync(path.join(root, "targets", "site", "draft.json"), "utf8"));
    ok(targetReceipt.url === website.url,
      "--target records the hosted URL where clone review already looks for draft.json");

    const mp4 = path.join(root, "render.mp4");
    fs.writeFileSync(mp4, Buffer.from([0, 0, 0, 1]));
    let wrapperVerified = false;
    const video = await publishPath({ sourcePath: mp4, name: "render", target: null, recordPath: path.join(root, "video.json") }, {
      workDir: root,
      push: async (dir) => {
        wrapperVerified = fs.existsSync(path.join(dir, "index.html")) && fs.readFileSync(path.join(dir, "video.mp4")).length === 4;
        return { url: "https://pingfusi.com/d/vid123DEF456", slug: "vid123DEF456", expires_at: "soon", files: 2, bytes: 400, verifiedSha256: "def", pushedAt: "now" };
      },
    });
    ok(wrapperVerified && video.kind === "video" && video.asset_url === "https://pingfusi.com/d/vid123DEF456/video.mp4",
      "an MP4 gets a hosted player plus the direct seekable video_url");
    ok(JSON.parse(fs.readFileSync(path.join(root, "video.json"), "utf8")).asset_url === video.asset_url,
      "--record persists the immutable video URL for the review round");

    const huge = path.join(root, "huge.mp4");
    fs.writeFileSync(huge, "x");
    fs.truncateSync(huge, MAX_FILE_BYTES + 1);
    let sizeRefused = false;
    try { prepareSource(huge); }
    catch (error) { sizeRefused = /hosted-video cap/.test(error.message); }
    ok(sizeRefused, "an oversized video is refused locally before upload");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(failed ? `\n❌ publish-selftest: ${failed} check(s) failed.` : "\n✓ publish-selftest: all checks pass.");
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
