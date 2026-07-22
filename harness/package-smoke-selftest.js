#!/usr/bin/env node
"use strict";

// Prove the generated npm artifact carries the one-repo motion workflow a fresh coding
// agent sees. This is offline: npm pack assembles bytes but never installs or publishes.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const KIT = path.resolve(__dirname, "..");
const BUILD = path.join(KIT, "scripts", "build-public.js");
let failed = 0;
const ok = (condition, message) => {
  if (condition) console.log(`  ✓ ${message}`);
  else { failed++; console.log(`  ✗ ${message}`); }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
};
const run = (entry, args, cwd, home) => spawnSync(process.execPath, [entry, ...args], {
  cwd,
  encoding: "utf8",
  env: { ...process.env, HOME: home, USERPROFILE: home },
});

console.log("package-smoke-selftest — generated fresh-agent surface");

if (!fs.existsSync(BUILD)) {
  ok(fs.existsSync(path.join(KIT, "packages", "motion", "bin", "motion-kit.js")), "public checkout includes the integrated motion entrypoint");
  ok(fs.existsSync(path.join(KIT, "skill", "pixel-perfect-clone", "SKILL.md")), "public checkout includes the clone-agent skill");
  ok(fs.existsSync(path.join(KIT, "skill", "beautify-with-pingfusi", "SKILL.md")), "public checkout includes the beautify-agent skill");
  ok(fs.existsSync(path.join(KIT, "use-cases", "beautify", "README.md")), "public checkout includes the beautify catalog entry");
  process.exit(failed ? 1 : 0);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-package-smoke-"));
process.on("exit", () => fs.rmSync(temp, { recursive: true, force: true }));
const publicDir = path.join(temp, "public");
const packDir = path.join(temp, "pack");
const extractDir = path.join(temp, "extract");
const blank = path.join(temp, "blank-repo");
const home = path.join(temp, "home");
for (const dir of [publicDir, packDir, extractDir, blank, home]) fs.mkdirSync(dir, { recursive: true });

const built = spawnSync(process.execPath, [BUILD, publicDir, "0.0.0-smoke"], { cwd: KIT, encoding: "utf8" });
ok(built.status === 0, "public generator accepts the integrated motion package and its neutral review vocabulary");
if (built.status !== 0) {
  process.stdout.write((built.stdout || "") + (built.stderr || ""));
  process.exit(1);
}

let packInfo = null;
try {
  packInfo = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir], {
    cwd: publicDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // A release smoke must not inherit or mutate the developer's npm cache. Besides
    // making this deterministic, an isolated cache proves npm pack needs no existing
    // machine state from a prior pingfusi install.
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      npm_config_cache: path.join(temp, "npm-cache"),
    },
  }))[0];
} catch (error) {
  process.stdout.write((error.stdout || "").toString() + (error.stderr || "").toString());
}
ok(packInfo && packInfo.filename, "npm pack creates a local branch artifact without publishing");
if (!packInfo || !packInfo.filename) process.exit(1);
const nameList = (packInfo.files || []).map((file) => file.path);
const names = new Set(nameList);
for (const required of [
  "bin/pingfusi",
  "harness/capability-router.js",
  "harness/motion-sampler.js",
  "harness/publish.js",
  "packages/motion/bin/motion-kit.js",
  "packages/motion/src/linked/builder.js",
  "packages/motion/player/linked.html",
  "packages/motion/package-lock.json",
  "skill/pixel-perfect-clone/SKILL.md",
  "skill/beautify-with-pingfusi/SKILL.md",
  "skill/fix-with-pingfusi/SKILL.md",
  "skill/review-video-with-pingfusi/SKILL.md",
  "use-cases/beautify/README.md",
  "use-cases/video-review/README.md",
]) ok(names.has(required), `packed artifact contains ${required}`);
// negative surface: local capture artifacts, recorded video, and the internal leak-guard
// selftest must never ride along in a release tarball
ok(!nameList.some((p) => p.startsWith("packages/motion/captures/")), "no path under packages/motion/captures/ ships");
ok(!nameList.some((p) => /\.(?:webm|mp4)$/i.test(p)), "no recorded video (*.webm / *.mp4) ships");
ok(!nameList.some((p) => /leak-guard-selftest\.js$/.test(p)), "the internal leak-guard selftest never ships");

const tarball = path.join(packDir, packInfo.filename);
execFileSync("tar", ["-xzf", tarball, "-C", extractDir]);
const packed = path.join(extractDir, "package");
// content scan (before any symlink adds foreign files): a packed file embedding the
// BUILDING machine's home directory ("/Users/<name>/…") is a machine-path leak — the
// class a stray capture/receipt artifact carries. Scanned as the real homedir, not the
// bare "/Users/" literal, because shipped selftests legitimately use fixture paths like
// "/Users/t" and "/Users/x".
{
  const machineHome = Buffer.from(os.homedir() + path.sep);
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else if (fs.readFileSync(fp).includes(machineHome)) offenders.push(path.relative(packed, fp));
    }
  };
  walk(packed);
  ok(offenders.length === 0, `no packed file content contains this machine's "${os.homedir()}" path${offenders.length ? ` (found: ${offenders.slice(0, 5).join(", ")})` : ""}`);
}

const entry = path.join(packed, "bin", "pingfusi");
const publishHelp = run(entry, ["publish", "--help"], blank, home);
ok(publishHelp.status === 0 && /built-dir\|video\.mp4/.test((publishHelp.stdout || "") + (publishHelp.stderr || "")),
  "packed CLI exposes hosted website/video publishing without starting a tunnel");
// LAZY WORLD — there is no postinstall anymore, so a fresh install has NO
// packages/motion/node_modules. The core CLI must work in that world, and motion
// commands must fail closed with the install remedy instead of an ESM stack.
const lazyMotion = run(entry, ["motion", "--help"], blank, home);
ok(lazyMotion.status === 2 && /pingfusi motion install\b/.test((lazyMotion.stderr || "") + (lazyMotion.stdout || "")),
  "without the lazy engine deps, motion commands fail closed pointing at `pingfusi motion install`");

const setup = run(entry, ["agent-setup", "codex", "--force"], blank, home);
const installedSkill = path.join(home, ".codex", "skills", "pixel-perfect-clone", "SKILL.md");
const installedBeautify = path.join(home, ".codex", "skills", "beautify-with-pingfusi", "SKILL.md");
const installedFix = path.join(home, ".codex", "skills", "fix-with-pingfusi", "SKILL.md");
const installedVideo = path.join(home, ".codex", "skills", "review-video-with-pingfusi", "SKILL.md");
ok(setup.status === 0 && fs.existsSync(installedSkill) && fs.existsSync(installedBeautify)
  && fs.existsSync(installedFix) && fs.existsSync(installedVideo),
  "packed setup installs clone, fix, beautify, and video skills into an isolated coding-agent home");
const skillText = fs.existsSync(installedSkill) ? fs.readFileSync(installedSkill, "utf8") : "";
ok(/pingfusi next/.test(skillText) && /motion pass/.test(skillText) && !/motion review\b/.test(skillText), "installed skill teaches the default-on motion pass and machine-check routing, with review-round motion machinery gone");
const beautifyText = fs.existsSync(installedBeautify) ? fs.readFileSync(installedBeautify, "utf8") : "";
ok(/pingfusi publish/.test(beautifyText) && /core\.review\.file/.test(beautifyText) && /omit `draft_url`/.test(beautifyText)
  && /Professionally polished/.test(beautifyText),
  "packed beautify skill uses the generic single-page round with an exact approval verdict");
const fixText = fs.existsSync(installedFix) ? fs.readFileSync(installedFix, "utf8") : "";
ok(/pingfusi publish/.test(fixText) && /--target/.test(fixText) && /genuinely requires a live server/.test(fixText),
  "packed fix skill defaults to hosted builds and keeps tunnels as a live-runtime fallback");
const videoText = fs.existsSync(installedVideo) ? fs.readFileSync(installedVideo, "utf8") : "";
ok(/pingfusi publish/.test(videoText) && /asset_url/.test(videoText) && /Content-Range/.test(videoText),
  "packed video skill publishes a seekable hosted MP4 and uses its direct asset URL");
ok([skillText, beautifyText, fixText, videoText].every((text) =>
  /automatically\s+chains client-safe wait/i.test(text)
  && /raw MCP leg returns pending[\s\S]{0,100}`pingfusi_wait`/i.test(text)
  && /never return\s+pending to the user/i.test(text)
  && /passive\s+(?:result\/verify|verify\/result)\s+reads\s+do\s+not/i.test(text)),
  "every installed review skill teaches automatic client-safe continuation until feedback");

const target = path.join(blank, "targets", "circle");
writeJson(path.join(target, "workflow.json"), {
  name: "circle",
  url: "https://example.test/",
  phaseOrder: ["visual"],
  phases: { visual: { status: "pending" } },
});
writeJson(path.join(target, "target.json"), { name: "circle", url: "https://example.test/", width: 1280 });
writeJson(path.join(target, "motion-items.json"), {
  schema: "pingfusi/motion-items@1",
  items: [{
    id: "expanding-circle", kind: "animation", status: "exported-needs-linked-review",
    trigger: "scroll-through:#story/80/16", scope: "#story .circle",
    traceDir: "targets/circle/motion/trace", libraryDir: "targets/circle/motion/library",
  }],
});
const next = run(entry, ["next", "circle", "--json"], blank, home);
let action = null;
try { action = JSON.parse(next.stdout || ""); } catch (_) {}
ok(next.status === 0 && action && action.utility === "motion-export" && /^pingfusi motion export targets\/circle\/motion\/trace/.test(action.command), "a packed fresh-agent project routes legacy scroll-through work to its machine export — review-round machinery is gone");
ok(action && !/--compare|\balign\b|motion review|prepare-linked/i.test(action.command), "packaged motion routing cannot fall through to layout feedback or review-round machinery");

// MOTION-INCLUSIVE half: `pingfusi motion install` creates this dependency tree on a real
// install; the offline smoke links the already-installed internal tree so it can exercise
// the exact packed entrypoint without registry access. Guard the source first — a dangling
// symlink here used to fail later with an unrelated ENOENT.
const sourceMotionModules = path.join(KIT, "packages", "motion", "node_modules");
if (!fs.existsSync(sourceMotionModules)) {
  ok(false, "packages/motion/node_modules missing in this checkout — run npm install / pingfusi motion install first");
} else {
  const packedMotionModules = path.join(packed, "packages", "motion", "node_modules");
  fs.symlinkSync(sourceMotionModules, packedMotionModules, "dir");
  const help = run(entry, ["motion", "--help"], blank, home);
  ok(help.status === 0 && /compare-build/.test(help.stdout || "") && /scroll-through/.test(help.stdout || ""), "packed CLI exposes the synchronized motion builder once the lazy engine deps exist");
}

console.log(failed ? `\n❌ package-smoke-selftest: ${failed} assertion(s) failed.` : "\n✓ package-smoke-selftest: all assertions pass.");
process.exit(failed ? 1 : 0);
