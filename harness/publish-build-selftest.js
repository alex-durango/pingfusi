#!/usr/bin/env node
// publish-build-selftest — the hosted game-build path, fully offline.
//
// Three layers: arg parsing, the local pre-flight refusals (every one a named
// failure BEFORE bytes move), and the wire sequence — the last against a real
// local HTTP server so the STREAMING PUT (duplex:'half', content-length, the
// counting watchdog) and the dead-token re-mint ladder run for real, not as
// mocks. No network, no token: the local server plays the service.
"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { parseArgs, publishBuild } = require("./publish-build.js");
const {
  preflightBuildZip,
  listZipEntryNames,
  refuseWebBuildZip,
  refuseUnsignedMacApp,
  sha256File,
  putBuildWithRetry,
  MAX_BUILD_BYTES,
} = require("../packages/core/builds.js");

let failed = 0;
const ok = (condition, label) => {
  console.log(`${condition ? "✓" : "✗"} ${label}`);
  if (!condition) failed++;
};
const refuses = (fn, re, label) => {
  try {
    fn();
    ok(false, `${label} (did not throw)`);
  } catch (e) {
    ok(re.test(e.message), `${label}${re.test(e.message) ? "" : ` (got: ${e.message})`}`);
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-build-test-"));
const ZIP_HEAD = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function writeZip(name, bytes) {
  const p = path.join(root, name);
  const body = Buffer.concat([ZIP_HEAD, crypto.randomBytes(Math.max(bytes - 4, 0))]);
  fs.writeFileSync(p, body);
  return p;
}

(async () => {
  try {
    // ── arg parsing ─────────────────────────────────────────────────────────
    const parsed = parseArgs(["game.zip", "--platform", "windows", "--name", "beta 3", "--record", "r.json", "--json"]);
    ok(parsed.sourcePath === "game.zip" && parsed.platform === "windows" && parsed.name === "beta 3" && parsed.recordPath === "r.json" && parsed.json,
      "CLI options describe one hosted build");
    refuses(() => parseArgs(["game.zip"]), /--platform windows\|macos is required/,
      "a filing without --platform is refused by name");
    refuses(() => parseArgs(["game.zip", "--platform", "linux"]), /--platform windows\|macos/,
      "an unsupported platform is refused by name");

    // ── local pre-flight (no bytes move) ────────────────────────────────────
    refuses(() => preflightBuildZip(path.join(root, "missing.zip")), /does not exist/,
      "a missing file is a named local failure");
    const notZip = path.join(root, "game.tar.gz");
    fs.writeFileSync(notZip, ZIP_HEAD);
    refuses(() => preflightBuildZip(notZip), /zip-only/,
      "a non-.zip extension is refused with the zip -r remedy");
    const badMagic = path.join(root, "fake.zip");
    fs.writeFileSync(badMagic, Buffer.from("MZ\x90\x00 not a zip"));
    refuses(() => preflightBuildZip(badMagic), /does not look like a zip/,
      "an exe renamed .zip fails the magic-byte check");
    const sparse = path.join(root, "huge.zip");
    fs.writeFileSync(sparse, ZIP_HEAD);
    fs.truncateSync(sparse, MAX_BUILD_BYTES + 1);
    refuses(() => preflightBuildZip(sparse), /hosted-build cap/,
      "an oversize zip is refused locally, naming the cap");
    const good = writeZip("game.zip", 64 * 1024);
    const pf = preflightBuildZip(good);
    ok(pf.bytes === 64 * 1024 && pf.filename === "game.zip",
      "a real zip passes pre-flight with its exact size and basename");
    const sha = await sha256File(good);

    // ── deep pre-flight: what's IN the zip ──────────────────────────────────
    // Real (stored, uncompressed) zips written inline — no external zip tool,
    // and they exercise the central-directory lister for real. The fake zips
    // above have no central directory, which doubles as the fail-open case.
    const zlib = require("zlib");
    const makeStoredZip = (name, entries) => {
      const chunks = [];
      const central = [];
      let offset = 0;
      for (const [entryName, content] of entries) {
        const data = Buffer.from(content);
        const nameBuf = Buffer.from(entryName);
        const crc = zlib.crc32 ? zlib.crc32(data) : 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        chunks.push(local, nameBuf, data);
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(data.length, 20);
        cd.writeUInt32LE(data.length, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt32LE(offset, 42);
        central.push(Buffer.concat([cd, nameBuf]));
        offset += 30 + nameBuf.length + data.length;
      }
      const cdBuf = Buffer.concat(central);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(entries.length, 8);
      eocd.writeUInt16LE(entries.length, 10);
      eocd.writeUInt32LE(cdBuf.length, 12);
      eocd.writeUInt32LE(offset, 16);
      const file = path.join(root, name);
      fs.writeFileSync(file, Buffer.concat([...chunks, cdBuf, eocd]));
      return file;
    };

    const webZip = makeStoredZip("web.zip", [["index.html", "<html>"], ["assets/app.js", "x"]]);
    ok(JSON.stringify(listZipEntryNames(webZip)) === JSON.stringify(["index.html", "assets/app.js"]),
      "the central-directory lister returns exact entry names");
    refuses(() => refuseWebBuildZip(webZip), /pingfusi publish/,
      "a web build zip is refused, pointing at the hosted-draft path");
    const wrappedWebZip = makeStoredZip("web-wrapped.zip", [["dist/index.html", "<html>"]]);
    refuses(() => refuseWebBuildZip(wrappedWebZip), /pingfusi publish/,
      "a folder-wrapped web build zip is refused too");
    const nativeZip = makeStoredZip("native.zip", [["Game.app/Contents/Info.plist", "<plist/>"], ["index.html", "readme"]]);
    refuseWebBuildZip(nativeZip);
    ok(true, "a zip containing an .app is never mistaken for a web build");
    ok(listZipEntryNames(badMagic) === null && (refuseWebBuildZip(badMagic) === undefined),
      "an unlistable zip fails OPEN through the web-build check");

    // The Mac-app shape/signature preflight needs macOS tooling — darwin
    // only, fail open elsewhere (mirrors the check itself). Rules under test
    // (2026-08-20 research): script main executables are an unsupported
    // bundle shape; unsigned arm64 is kernel-killed (ad-hoc suffices);
    // x86_64-only runs unsigned under Rosetta and must pass.
    if (process.platform === "darwin") {
      const { execFileSync } = require("child_process");
      const makeApp = (name, execContent, { mode = 0o755 } = {}) => {
        const appDir = path.join(root, name + ".app");
        fs.mkdirSync(path.join(appDir, "Contents", "MacOS"), { recursive: true });
        fs.writeFileSync(path.join(appDir, "Contents", "Info.plist"),
          `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>run</string><key>CFBundleIdentifier</key><string>t.${name}</string></dict></plist>`);
        if (execContent !== null) fs.writeFileSync(path.join(appDir, "Contents", "MacOS", "run"), execContent, { mode });
        return appDir;
      };
      const zipApp = (appDir, zipName) => {
        const zip = path.join(root, zipName);
        execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", appDir, zip]);
        return zip;
      };

      // Script main executable → refused as an unsupported shape.
      const scriptApp = makeApp("ScriptMain", "#!/bin/sh\nexit 0\n");
      refuses(() => refuseUnsignedMacApp(zipApp(scriptApp, "script-app.zip")), /not a Mach-O binary/,
        "a script-main .app is refused as an unsupported bundle shape");

      // Missing declared executable → refused by name.
      const hollowApp = makeApp("Hollow", null);
      refuses(() => refuseUnsignedMacApp(zipApp(hollowApp, "hollow-app.zip")), /is missing/,
        "an .app whose CFBundleExecutable is absent is refused by name");

      // Real Mach-O fixtures (clang ships with the CLT this selftest already
      // relies on for ditto/codesign).
      const cSrc = path.join(root, "t.c");
      fs.writeFileSync(cSrc, "int main(void){return 0;}\n");
      const x86Bin = path.join(root, "run-x86");
      execFileSync("/usr/bin/clang", ["-arch", "x86_64", "-o", x86Bin, cSrc], { stdio: "pipe" });
      execFileSync("/usr/bin/codesign", ["--remove-signature", x86Bin], { stdio: "pipe" });
      const x86App = makeApp("IntelOnly", fs.readFileSync(x86Bin));
      refuseUnsignedMacApp(zipApp(x86App, "intel-app.zip"));
      ok(true, "an unsigned x86_64-only app passes (Rosetta runs it)");

      const armBin = path.join(root, "run-arm");
      execFileSync("/usr/bin/clang", ["-arch", "arm64", "-o", armBin, cSrc], { stdio: "pipe" });
      execFileSync("/usr/bin/codesign", ["--remove-signature", armBin], { stdio: "pipe" });
      const armApp = makeApp("ArmUnsigned", fs.readFileSync(armBin));
      refuses(() => refuseUnsignedMacApp(zipApp(armApp, "arm-unsigned-app.zip")), /codesign --force -s -/,
        "an unsigned arm64 app is refused with the ad-hoc remedy");

      execFileSync("/usr/bin/codesign", ["--force", "-s", "-", path.join(armApp, "Contents", "MacOS", "run")], { stdio: "pipe" });
      refuseUnsignedMacApp(zipApp(armApp, "arm-signed-app.zip"));
      ok(true, "the same arm64 app ad-hoc signed passes");

      refuseUnsignedMacApp(webZip);
      ok(true, "a zip with no .app inside fails OPEN through the signature check");
    }

    ok(/^[0-9a-f]{64}$/.test(sha) && sha === crypto.createHash("sha256").update(fs.readFileSync(good)).digest("hex"),
      "the streamed sha256 matches a buffered hash");

    // ── the PUT ladder against a real local server ──────────────────────────
    // First mint 403s once (the dead-token shape), the re-minted URL accepts
    // and the server counts the streamed bytes — proving stream restart,
    // re-mint, and content-length all at once.
    let putBodies = [];
    let reminted = 0;
    const server = http.createServer((req, res) => {
      if (req.method === "PUT" && req.url === "/upload/dead") {
        req.resume();
        req.on("end", () => { res.statusCode = 403; res.end("token expired"); });
        return;
      }
      if (req.method === "PUT" && req.url === "/upload/live") {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          putBodies.push(Buffer.concat(chunks));
          res.statusCode = 200;
          res.end("{}");
        });
        return;
      }
      if (req.method === "POST" && /^\/api\/build\/slug12345678\/upload-url$/.test(req.url)) {
        reminted++;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ path: "slug12345678/game.zip", url: `http://127.0.0.1:${server.address().port}/upload/live` }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const port = server.address().port;
    // api() needs a token + BASE pointed at the local server.
    process.env.PINGFUSI_TOKEN = "ph_selftest";
    process.env.PPK_PINGHUMANS_URL = `http://127.0.0.1:${port}`;
    // wire.js reads env at require time in some paths — re-require fresh.
    for (const mod of ["../packages/core/wire.js", "../packages/core/drafts.js", "../packages/core/builds.js"]) {
      delete require.cache[require.resolve(mod)];
    }
    const freshBuilds = require("../packages/core/builds.js");
    await freshBuilds.putBuildWithRetry(
      good,
      pf.bytes,
      "slug12345678",
      `http://127.0.0.1:${port}/upload/dead`,
      null
    );
    ok(reminted === 1, "a 403 (dead signed URL) re-mints once instead of burning retries");
    ok(putBodies.length === 1 && putBodies[0].length === pf.bytes && putBodies[0].equals(fs.readFileSync(good)),
      "the streamed PUT restarts from disk and lands byte-identical");

    // ── the full wire sequence via injected push (publish.js pattern) ───────
    let pushedWith = null;
    const record = await publishBuild(
      { sourcePath: good, platform: "windows", name: "beta", recordPath: path.join(root, "receipt.json"), json: true },
      {
        push: async (file, opts) => {
          pushedWith = { file, ...opts };
          return { url: "https://pingfusi.com/b/Ab3-_9xYz012", slug: "Ab3-_9xYz012", filename: "game.zip", bytes: pf.bytes, sha256: sha, platform: opts.platform, expires_at: "soon", pushedAt: "now" };
        },
        onProgress: null,
      }
    );
    ok(pushedWith.platform === "windows" && pushedWith.file === path.resolve(good),
      "publishBuild hands core.build.push the resolved zip and the platform");
    ok(record.receipts.length === 1 && JSON.parse(fs.readFileSync(record.receipts[0], "utf8")).url === record.url,
      "--record persists the hosted-build receipt");

    server.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(failed ? `\n❌ publish-build-selftest: ${failed} check(s) failed.` : "\n✓ publish-build-selftest: all checks pass.");
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
