// harness/doctor.js — `pingfusi doctor`: the one-command preflight for new installs.
//
// WHY: the kit's failure surface for a NEWCOMER is spread across four tools that fail at
// the worst possible moments — wrong node errors on the first fetch, missing cloudflared
// only at tunnel time (an hour into a run), a missing review login only at the review
// phase (hours in). Each failure is self-describing WHEN HIT; doctor moves all of them to
// minute one, with the fix command per miss. Run it right after install, and have agents
// run it before starting a clone (LAUNCH-PROMPT / the clone-site skill both say to).
//
// USAGE:  pingfusi doctor      (exit 0 = ready for the full pipeline, 1 = something missing)
"use strict";

const { spawnSync } = require("child_process");

// Each check: { name, ok, detail, fix?, required } — pure data so the selftest can drive
// the report logic without real binaries. Exported builders take injectable probes.
function checkNode(versionString) {
  const major = parseInt((versionString || "").split(".")[0], 10);
  return {
    name: "node >= 18",
    ok: major >= 18,
    detail: `found ${versionString}`,
    fix: "install Node 18+ (https://nodejs.org)",
    required: true,
  };
}

function checkBinary(name, args, why, fix, required) {
  let ok = false, detail = "not found on PATH";
  try {
    const r = spawnSync(name, args, { stdio: "pipe", timeout: 10_000 });
    if (r.status === 0 || (r.stdout && r.stdout.length) || (r.stderr && r.stderr.length && !r.error)) {
      ok = !r.error;
      detail = ok ? String(r.stdout || r.stderr).split("\n")[0].trim().slice(0, 60) : detail;
    }
  } catch (e) { /* not found */ }
  return { name: `${name} (${why})`, ok, detail, fix, required };
}

function checkReviewToken(resolveToken) {
  let token = null;
  try { token = resolveToken(); } catch (e) {}
  return {
    name: "review login (remote review rounds)",
    ok: !!token,
    detail: token ? "token found" : "no token found",
    fix: "run: pingfusi setup — review rounds require the login (an independent reviewer answers them; there is no offline review path)",
    required: true,
  };
}

function report(checks) {
  let failedRequired = 0;
  for (const c of checks) {
    const mark = c.ok ? "✓" : c.required ? "❌" : "⚠";
    console.log(`${mark} ${c.name} — ${c.detail}`);
    if (!c.ok && c.fix) console.log(`    fix: ${c.fix}`);
    if (!c.ok && c.required) failedRequired++;
  }
  console.log(`
ℹ your AI agent needs BROWSER AUTOMATION to drive live-site captures (e.g. Claude Code
  with the Chrome extension / claude-in-chrome MCP) — doctor can't verify that from here;
  make sure your agent can open and script a browser tab.`);
  if (failedRequired) {
    console.log(`\n❌ ${failedRequired} required check(s) failed — fix the lines above, then re-run: pingfusi doctor`);
    return 1;
  }
  console.log(`\n✓ ready. Teach your agent next (once): pingfusi agent-setup
  then just ask it: "Clone https://example.com pixel-perfect."`);
  return 0;
}

function main() {
  const { resolveToken } = require("./review-qa.js");
  const checks = [
    checkNode(process.versions.node),
    checkBinary("cloudflared", ["--version"], "public tunnels — the capture sink + adopted-build dev servers (hosted drafts need none)", "brew install cloudflared   (or https://developers.cloudflare.com/cloudflared)", false),
    checkReviewToken(resolveToken),
    checkBinary("ffmpeg", ["-version"], "optional — frame-level video verification", "brew install ffmpeg", false),
  ];
  process.exit(report(checks));
}

if (require.main === module) main();
module.exports = { checkNode, checkBinary, checkReviewToken, report };
