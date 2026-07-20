// motion-integration-selftest.js — proves the temporal engine is reached through the
// one pingfusi command, runs in the clone workspace, and has no backend dependency.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const KIT = path.resolve(__dirname, "..");
const BIN = path.join(KIT, "bin", "pingfusi");
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.stack || e}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-motion-integration-"));
try {
  test("global installs force the lazy motion install back to local mode", () => {
    const smokeRoot = path.join(tmp, "global-install-smoke");
    const motionRoot = path.join(smokeRoot, "packages", "motion");
    fs.mkdirSync(motionRoot, { recursive: true });
    fs.writeFileSync(path.join(motionRoot, "package.json"), JSON.stringify({
      name: "pingfusi-motion-lazy-install-smoke",
      version: "1.0.0",
    }));
    fs.writeFileSync(path.join(motionRoot, "package-lock.json"), JSON.stringify({
      name: "pingfusi-motion-lazy-install-smoke",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "pingfusi-motion-lazy-install-smoke", version: "1.0.0" },
      },
    }));

    // `pingfusi motion install` replaced the postinstall. Mirror its exact npm flags out
    // of the source so the smoke run below exercises what the CLI actually spawns.
    const source = fs.readFileSync(path.join(KIT, "harness", "workflow.js"), "utf8");
    const invocation = source.match(/spawnSync\("npm", \["ci", "--prefix", packageDir, ([^\]]+)\]/);
    assert.ok(invocation, "workflow.js runs the lazy motion install through a nested npm ci");
    const flags = invocation[1].match(/"[^"]+"/g).map((flag) => flag.slice(1, -1));
    assert.ok(flags.includes("--global=false"), flags.join(" "));
    const r = spawnSync("npm", ["ci", "--prefix", motionRoot, ...flags], {
      cwd: smokeRoot,
      env: {
        ...process.env,
        npm_config_cache: path.join(tmp, "npm-cache"),
        npm_config_global: "true",
        npm_config_offline: "true",
        NPM_CONFIG_GLOBAL: "true",
        NPM_CONFIG_OFFLINE: "true",
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.doesNotMatch(r.stderr || "", /ECIGLOBAL/);
  });

  test("motion browser installer resolves inside the packaged engine", () => {
    const { installerInvocation } = require("./motion-browser.js");
    const invocation = installerInvocation(path.join(KIT, "packages", "motion"));
    assert.equal(invocation.command, process.execPath);
    assert.match(invocation.args[0], /packages[\\/]motion[\\/]node_modules[\\/]playwright[\\/]cli\.js$/);
    assert.deepEqual(invocation.args.slice(1), ["install", "chromium"]);
  });

  const blocker = path.join(tmp, "block-network.cjs");
  fs.writeFileSync(blocker, `
globalThis.fetch = async () => { throw new Error("network forbidden in motion integration test"); };
for (const mod of [require("node:http"), require("node:https")]) {
  mod.request = () => { throw new Error("network forbidden in motion integration test"); };
  mod.get = () => { throw new Error("network forbidden in motion integration test"); };
}
`);
  const env = {
    ...process.env,
    HOME: path.join(tmp, "empty-home"),
    PINGFUSI_TOKEN: "",
    PPK_PINGHUMANS_TOKEN: "",
    PINGFUSI_APP_URL: "https://invalid.example.test",
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${blocker}`].filter(Boolean).join(" "),
  };
  fs.mkdirSync(env.HOME, { recursive: true });

  test("pingfusi motion help exposes the integrated command", () => {
    const r = spawnSync(process.execPath, [BIN, "motion", "help"], { cwd: tmp, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /pingfusi motion — copy animations/);
    assert.match(r.stdout, /pingfusi motion trace/);
    assert.match(r.stdout, /--scope <selector>/);
    assert.match(r.stdout, /scroll-through:<selector>/);
    assert.doesNotMatch(r.stdout + r.stderr, /unknown command|needs a <name>/);
  });

  test("root delegation exports a motion capture in the caller workspace", () => {
    const capture = path.join(tmp, "capture");
    fs.mkdirSync(path.join(capture, "animations"), { recursive: true });
    fs.writeFileSync(path.join(capture, "capture.json"), JSON.stringify({
      url: "https://example.com/",
      capturedAt: "2026-07-14T00:00:00.000Z",
      trigger: "load",
      referenceVideo: null,
      animations: [{ artifact: "animations/fade.json" }],
    }));
    fs.writeFileSync(path.join(capture, "animations", "fade.json"), JSON.stringify({
      key: "fade",
      name: "fade",
      type: "CSSAnimation",
      tier: 1,
      resolved: true,
      target: { path: "main > h1", tag: "h1" },
      waapi: {
        keyframes: [
          { offset: 0, easing: "ease-out", opacity: "0" },
          { offset: 1, opacity: "1" },
        ],
        timing: { duration: 500, delay: 0, iterations: 1, direction: "normal", fill: "both", easing: "linear" },
      },
    }));

    const r = spawnSync(process.execPath, [BIN, "motion", "export", "capture", "--out", "motion-library"], {
      cwd: tmp, env, encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const index = JSON.parse(fs.readFileSync(path.join(tmp, "motion-library", "index.json"), "utf8"));
    assert.equal(index.entries.length, 1);
    const entry = index.entries[0];
    assert.ok(fs.existsSync(path.join(tmp, "motion-library", entry.name, `${entry.name}.css`)));
    assert.ok(fs.existsSync(path.join(tmp, "motion-library", entry.name, "registry-item.json")));
    assert.ok(fs.existsSync(path.join(tmp, "motion-library", "receipts.jsonl")));
    assert.match(r.stdout, /exported 1 entry/);
  });

  test("dispatcher is package-relative and contains no sibling-repo dependency", () => {
    const source = fs.readFileSync(path.join(KIT, "harness", "workflow.js"), "utf8");
    assert.match(source, /packages\/motion\/bin\/motion-kit\.js/);
    assert.doesNotMatch(source, /\/Users\/durango\/motion-kit/);
  });

  test("managed motion commands receipt lifecycle only after engine exit 0", () => {
    const capture = path.join(tmp, "capture");
    const target = path.join(tmp, "targets", "demo");
    fs.mkdirSync(target, { recursive: true });
    const manifestFile = path.join(target, "motion-items.json");
    const writeManifest = (status, fields = {}) => fs.writeFileSync(manifestFile, JSON.stringify({
      schema: "pingfusi/motion-items@1",
      items: [{
        id: "fade",
        kind: "css-animation",
        status,
        captureDir: "capture",
        libraryDir: "managed-library",
        ...fields,
      }],
    }));
    writeManifest("pending");
    const success = spawnSync(process.execPath, [
      BIN, "motion", "export", "capture", "--out", "managed-library", "--target", "demo", "--item", "fade",
    ], { cwd: tmp, env, encoding: "utf8" });
    assert.equal(success.status, 0, success.stderr || success.stdout);
    let item = JSON.parse(fs.readFileSync(manifestFile, "utf8")).items[0];
    assert.equal(item.status, "exported");
    assert.equal(item.libraryDir, "managed-library");

    const hardTrace = path.join(tmp, "hard-trace");
    fs.mkdirSync(hardTrace, { recursive: true });
    fs.writeFileSync(path.join(hardTrace, "trace.json"), JSON.stringify({
      capturedAt: "2026-07-16T00:00:00Z",
      frames: [{ t: 0, scrollY: 0 }, { t: 500, scrollY: 500 }],
      elements: [{ path: "main > .hero", samples: [{ t: 0, tx: 0, ty: 0, tz: 0, sx: 1, sy: 1, rot: 0, opacity: 1 }, { t: 500, tx: 100, ty: 0, tz: 0, sx: 1, sy: 1, rot: 0, opacity: 1 }] }],
    }));
    fs.writeFileSync(path.join(hardTrace, "fits.json"), JSON.stringify({
      url: "https://example.com/",
      trigger: "scroll-sweep",
      engines: { engines: ["raf"] },
      fits: [{ path: "main > .hero", channel: "tx", fit: { kind: "scroll-linear", confidence: 0.95, link: { slope: 0.2, intercept: 0, r2: 0.99 } } }],
    }));
    writeManifest("traced", { kind: "scroll-linked", captureDir: null, traceDir: "hard-trace", libraryDir: "hard-library" });
    const hardExport = spawnSync(process.execPath, [
      BIN, "motion", "export", "hard-trace", "--out", "hard-library", "--target", "demo", "--item", "fade",
    ], { cwd: tmp, env, encoding: "utf8" });
    assert.equal(hardExport.status, 0, hardExport.stderr || hardExport.stdout);
    item = JSON.parse(fs.readFileSync(manifestFile, "utf8")).items[0];
    // First-draft doctrine: export is a terminal machine receipt — no review round is
    // left to park it for, but a fresh trace export still clears stale bundle receipts.
    assert.equal(item.status, "exported");
    assert.equal(item.reviewConstraint, undefined);
    assert.equal(item.bundleDir, null);

    writeManifest("pending");
    const wrongOutput = spawnSync(process.execPath, [
      BIN, "motion", "export", "capture", "--out", "other-library", "--target", "demo", "--item", "fade",
    ], { cwd: tmp, env, encoding: "utf8" });
    assert.notEqual(wrongOutput.status, 0);
    assert.match(wrongOutput.stderr, /output path .* is not the item's declared libraryDir/);
    assert.equal(JSON.parse(fs.readFileSync(manifestFile, "utf8")).items[0].status, "pending");
    assert.ok(!fs.existsSync(path.join(tmp, "other-library")), "an unrelated destination is rejected before the engine runs");

    const unrelatedCapture = path.join(tmp, "unrelated-capture");
    fs.cpSync(capture, unrelatedCapture, { recursive: true });
    const wrongInput = spawnSync(process.execPath, [
      BIN, "motion", "export", "unrelated-capture", "--out", "managed-library", "--target", "demo", "--item", "fade",
    ], { cwd: tmp, env, encoding: "utf8" });
    assert.notEqual(wrongInput.status, 0);
    assert.match(wrongInput.stderr, /input path .* is not the item's declared captureDir/);
    assert.equal(JSON.parse(fs.readFileSync(manifestFile, "utf8")).items[0].status, "pending");

    const emptyTrace = path.join(tmp, "empty-trace");
    fs.mkdirSync(emptyTrace, { recursive: true });
    fs.writeFileSync(path.join(emptyTrace, "trace.json"), JSON.stringify({ capturedAt: "2026-07-16T00:00:00Z", frames: [], elements: [] }));
    fs.writeFileSync(path.join(emptyTrace, "fits.json"), JSON.stringify({ url: "https://example.com/", trigger: "load", engines: { engines: [] }, fits: [] }));
    writeManifest("pending", { captureDir: null, traceDir: "empty-trace", libraryDir: "empty-library" });
    const failedExport = spawnSync(process.execPath, [
      BIN, "motion", "export", "empty-trace", "--out", "empty-library", "--target", "demo", "--item", "fade",
    ], { cwd: tmp, env, encoding: "utf8" });
    assert.notEqual(failedExport.status, 0);
    item = JSON.parse(fs.readFileSync(manifestFile, "utf8")).items[0];
    assert.equal(item.status, "pending");
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n❌ motion-integration-selftest: ${failed} assertion(s) failed.` : "\n✓ motion-integration-selftest: all assertions pass.");
process.exit(failed ? 1 : 0);
