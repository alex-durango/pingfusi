// harness/doctor-selftest.js — guards the new-user onboarding surface: `pingfusi doctor`'s
// check/report logic and `pingfusi agent-setup`'s skill install. Offline + socket-free.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { checkNode, checkMotionEngine, probeMotionBrowser, checkKitVersion, checkReviewToken, report } = require("./doctor.js");
const { install } = require("./agent-setup.js");

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed++; console.log(`  ✗ ${msg}`); } };

console.log("doctor-selftest — onboarding preflight + agent skill install");

// ── doctor checks (pure) ──────────────────────────────────────────────────────
ok(checkNode("20.17.0").ok && checkNode("22.13.0").ok && checkNode("23.5.0").ok && checkNode("24.0.0").ok, "supported Node boundary versions pass");
ok(!checkNode("20.16.9").ok && !checkNode("21.9.0").ok && !checkNode("22.12.9").ok && !checkNode("23.4.9").ok, "unsupported gaps and early releases fail the exact dependency floor");
ok(!checkNode("18.20.0").ok && checkNode("18.20.0").fix.includes("20.17"), "node 18 fails with an actionable fix");
const motionPkg = path.join(__dirname, "..", "packages", "motion");
const browserReady = () => ({ ok: true, source: "selftest" });
ok(checkMotionEngine("22.13.0", motionPkg, browserReady).ok, "integrated motion package + dependencies pass on a supported Node with a browser");
// motion is quarantined to declared items → its doctor row is WARNING-ONLY (like the
// version-skew row): a non-motion user's preflight must never fail on it.
ok(checkMotionEngine("22.13.0", motionPkg, browserReady).required === false, "the motion engine row is warning-only (required:false) — doctor never fails a non-motion user on it");
const noMotionBrowser = checkMotionEngine("22.13.0", motionPkg, () => ({ ok: false, reason: "no browser" }));
ok(!noMotionBrowser.ok && !noMotionBrowser.required && /pingfusi motion install-browser/.test(noMotionBrowser.fix), "a missing browser runtime is a warning with a package-location-independent remedy");
const missingMotion = checkMotionEngine("22.13.0", path.join(os.tmpdir(), "definitely-missing-pingfusi-motion"), browserReady);
ok(!missingMotion.ok && /npm i -g pingfusi@latest/.test(missingMotion.fix) && !/--prefix packages\/motion/.test(missingMotion.fix), "missing integrated package gets an installed-package repair, never a user-cwd-relative npm prefix");
{
  const incomplete = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-motion-incomplete-"));
  fs.mkdirSync(path.join(incomplete, "bin"), { recursive: true });
  fs.writeFileSync(path.join(incomplete, "bin", "motion-kit.js"), "");
  let lazyProbeCalled = false;
  const result = checkMotionEngine("22.13.0", incomplete, () => { lazyProbeCalled = true; return browserReady(); });
  ok(!result.ok && /pingfusi motion install\b/.test(result.fix) && !/--prefix packages\/motion/.test(result.fix), "a lazy (dependency-less) install points at `pingfusi motion install`, never a user-cwd-relative npm prefix");
  ok(!lazyProbeCalled, "the Chromium video probe never launches while the npm dependencies are missing — doctor stays a read-only filesystem check");
  fs.rmSync(incomplete, { recursive: true, force: true });
}
let oldNodeProbeCalled = false;
const oldMotionNode = checkMotionEngine("18.20.0", motionPkg, () => { oldNodeProbeCalled = true; return browserReady(); });
ok(!oldMotionNode.ok && !oldMotionNode.required && /Node 20\.17/.test(oldMotionNode.fix) && !oldNodeProbeCalled, "Node 18 fails fast with the precise Node remedy before launching the motion probe");
{
  let invocation = null;
  const ready = probeMotionBrowser(motionPkg, (command, args, opts) => {
    invocation = { command, args, opts };
    return { status: 0, stdout: "", stderr: "" };
  });
  ok(ready.ok && ready.source === "recordVideo probe", "motion browser probe only passes after its video subprocess succeeds");
  ok(invocation.command === process.execPath
    && invocation.args.includes("--input-type=module")
    && invocation.args.some((arg) => /launchSession\(\{ headless: true, videoDir \}\)/.test(arg))
    && invocation.args.some((arg) => /\.webm/.test(arg)), "motion browser probe drives the real recording session and requires a webm artifact");
  const noFfmpeg = probeMotionBrowser(motionPkg, () => ({
    status: 1,
    stdout: "",
    stderr: "browserContext.newPage: Executable doesn't exist at /playwright/ffmpeg",
  }));
  ok(!noFfmpeg.ok && /ffmpeg/i.test(noFfmpeg.reason), "missing Playwright FFmpeg makes the honest video probe fail");
}
ok(checkReviewToken(() => "tok_abc").ok, "token resolver returning a token passes");
const noTok = checkReviewToken(() => null);
ok(!noTok.ok && /pingfusi setup/.test(noTok.fix), "missing token fails, fix names `pingfusi setup`");
ok(!checkReviewToken(() => { throw new Error("boom"); }).ok, "a throwing resolver counts as no token, never crashes doctor");
// version skew: two developers on "the same kit", one stale — doctor must surface it, but
// never block on the npm registry (offline is a place people work)
ok(checkKitVersion("0.7.1", "0.7.1").ok, "installed == npm latest passes");
const stale = checkKitVersion("0.7.0", "0.7.1");
ok(!stale.ok && !stale.required && /0\.7\.1/.test(stale.detail) && /npm i -g pingfusi@latest/.test(stale.fix), "a stale install warns (never blocks) and the fix is the upgrade command");
ok(checkKitVersion("0.7.0", null).ok && /skipped/.test(checkKitVersion("0.7.0", null).detail), "unreachable registry skips the check instead of failing doctor");

// report(): exit code reflects REQUIRED failures only; optional misses are warnings
{
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  const codeAllGreen = report([{ name: "x", ok: true, detail: "d", required: true }]);
  const codeOptionalMiss = report([{ name: "x", ok: true, detail: "d", required: true }, { name: "opt", ok: false, detail: "d", fix: "f", required: false }]);
  const codeRequiredMiss = report([{ name: "x", ok: false, detail: "d", fix: "f", required: true }]);
  console.log = orig;
  ok(codeAllGreen === 0, "all green → exit 0");
  ok(codeOptionalMiss === 0, "an optional miss is a warning, not a failure");
  ok(codeRequiredMiss === 1, "a required miss → exit 1");
  ok(logs.some((l) => /browser automation/i.test(l)), "report always names the browser-agent requirement (undetectable from node)");
  ok(logs.some((l) => /agent-setup/.test(l)), "the all-green report points at the next step (pingfusi agent-setup)");
}

// ── agent-setup install (real files, fake HOME) ───────────────────────────────
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-doctor-"));
  const r1 = install(home, false);
  const dest = path.join(home, ".claude", "skills", "pixel-perfect-clone", "SKILL.md");
  const destFix = path.join(home, ".claude", "skills", "fix-with-pingfusi", "SKILL.md");
  const destBeautify = path.join(home, ".claude", "skills", "beautify-with-pingfusi", "SKILL.md");
  const destVideo = path.join(home, ".claude", "skills", "review-video-with-pingfusi", "SKILL.md");
  ok(r1.ok && fs.existsSync(dest) && fs.existsSync(destFix) && fs.existsSync(destBeautify) && fs.existsSync(destVideo), "installs ALL kit skills (clone + fix + beautify + video) into ~/.claude/skills/");
  const body = fs.readFileSync(dest, "utf8");
  ok(/^---\nname: pixel-perfect-clone/.test(body) && /description: .*[Cc]lone/.test(body), "installed skill has the frontmatter Claude Code discovers it by");
  ok(/pingfusi doctor/.test(body) && /pingfusi where/.test(body) && /independent reviewer/i.test(body) && /verdict/i.test(body), "skill teaches preflight, kit location, and the independent-reviewer contract");
  const fix = fs.readFileSync(destFix, "utf8");
  ok(/^---\nname: fix-with-pingfusi/.test(fix) && /fix it with pingfusi/.test(fix) && /polish this clone/.test(fix) && /ditto/.test(fix), "fix-with-pingfusi triggers on 'fix it with pingfusi' / polish this clone / ditto phrasing");
  ok(/pingfusi adopt/.test(fix) && /pingfusi publish/.test(fix) && /--target/.test(fix)
    && /tunnel[\s\S]*only when/i.test(fix) && /--changelog/.test(fix)
    && /verdict/i.test(fix) && /DRAFT'S OWN source/.test(fix),
    "fix-with-pingfusi teaches hosted production builds first, with a live-runtime tunnel fallback");
  const beautify = fs.readFileSync(destBeautify, "utf8");
  ok(/^---\nname: beautify-with-pingfusi/.test(beautify)
    && /beautify this website/.test(beautify) && /make this page look professional/.test(beautify),
    "beautify-with-pingfusi has discoverable beautify/professional-design triggers");
  ok(/pingfusi publish/.test(beautify) && /--record/.test(beautify) && /core\.review\.file/.test(beautify)
    && /omit `draft_url`/.test(beautify) && /pingfusi wait/.test(beautify)
    && /core\.review\.verify/.test(beautify) && /project's own source/.test(beautify),
    "beautify teaches publish → custom single-page round → wait → verify/refile in owned source");
  const videoSkill = fs.readFileSync(destVideo, "utf8");
  ok(/^---\nname: review-video-with-pingfusi/.test(videoSkill)
    && /review this video/.test(videoSkill) && /match the prompt\/brief/.test(videoSkill),
    "review-video-with-pingfusi has discoverable video-review triggers");
  ok(/pingfusi publish/.test(videoSkill) && /asset_url/.test(videoSkill)
    && /media_type: "video"/.test(videoSkill) && /core\.review\.file/.test(videoSkill)
    && /Matches the prompt/.test(videoSkill) && /pingfusi wait/.test(videoSkill)
    && /core\.review\.verify/.test(videoSkill) && /Content-Range/.test(videoSkill),
    "video skill teaches seekable publish → video round → wait → verify with the fixed verdict pair");
  const r2 = install(home, false);
  ok(!r2.ok && /--force/.test(r2.message), "refuses to overwrite an existing install without --force");
  ok(install(home, true).ok, "--force overwrites");
  const codex = install(home, false, "codex");
  const cursor = install(home, false, "cursor");
  ok(codex.ok && cursor.ok &&
    fs.existsSync(path.join(home, ".codex", "skills", "pixel-perfect-clone", "SKILL.md")) &&
    fs.existsSync(path.join(home, ".cursor", "skills", "pixel-perfect-clone", "SKILL.md")),
    "installs the same routing skills into Codex and Cursor native skill directories");
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(failed ? `\n❌ doctor-selftest: ${failed} assertion(s) failed.` : "\n✓ doctor-selftest: all assertions pass.");
process.exit(failed ? 1 : 0);
