// harness/doctor-selftest.js — guards the new-user onboarding surface: `pingfusi doctor`'s
// check/report logic and `pingfusi agent-setup`'s skill install. Offline + socket-free.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { checkNode, checkKitVersion, checkReviewToken, report } = require("./doctor.js");
const { install } = require("./agent-setup.js");

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed++; console.log(`  ✗ ${msg}`); } };

console.log("doctor-selftest — onboarding preflight + agent skill install");

// ── doctor checks (pure) ──────────────────────────────────────────────────────
ok(checkNode("22.1.0").ok && checkNode("18.0.0").ok, "node 18/22 pass the version check");
ok(!checkNode("16.20.0").ok && checkNode("16.20.0").fix.includes("18"), "node 16 fails with an actionable fix");
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
  ok(r1.ok && fs.existsSync(dest) && fs.existsSync(destFix), "installs ALL kit skills (pixel-perfect-clone + fix-with-pingfusi) into ~/.claude/skills/");
  const body = fs.readFileSync(dest, "utf8");
  ok(/^---\nname: pixel-perfect-clone/.test(body) && /description: .*[Cc]lone/.test(body), "installed skill has the frontmatter Claude Code discovers it by");
  ok(/pingfusi doctor/.test(body) && /pingfusi where/.test(body) && /independent reviewer/i.test(body) && /verdict/i.test(body), "skill teaches preflight, kit location, and the independent-reviewer contract");
  const fix = fs.readFileSync(destFix, "utf8");
  ok(/^---\nname: fix-with-pingfusi/.test(fix) && /fix it with pingfusi/.test(fix) && /polish this clone/.test(fix) && /ditto/.test(fix), "fix-with-pingfusi triggers on 'fix it with pingfusi' / polish this clone / ditto phrasing");
  ok(/pingfusi adopt/.test(fix) && /--changelog/.test(fix) && /verdict/i.test(fix) && /DRAFT'S OWN source/.test(fix), "fix-with-pingfusi teaches adopt → tunnel --url → review loop, fixing in the draft's own source");
  const r2 = install(home, false);
  ok(!r2.ok && /--force/.test(r2.message), "refuses to overwrite an existing install without --force");
  ok(install(home, true).ok, "--force overwrites");
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(failed ? `\n❌ doctor-selftest: ${failed} assertion(s) failed.` : "\n✓ doctor-selftest: all assertions pass.");
process.exit(failed ? 1 : 0);
