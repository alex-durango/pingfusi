// harness/agent-setup.js — `pingfusi agent-setup`: teach the user's AI agent to use the kit.
//
// The kit's entire new-user experience is "install, then ask your agent to clone a
// site" — this is the command that makes the second half true. It installs the kit's
// clone-site skill into the user's agent skill directory (~/.claude/skills/), where
// Claude Code auto-discovers it: from then on, "clone https://example.com" in any
// session triggers the skill, which drives the full pingfusi pipeline and treats the user
// as the reviewer.
//
// USAGE:  pingfusi agent-setup [--force]     (--force overwrites an existing install)
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const PKG = path.resolve(__dirname, "..");

function install(homeDir, force) {
  // Every skill the kit ships lives in PKG/skill/<skill-name>/SKILL.md — install them
  // all (pixel-perfect-clone: the full gated pipeline; fix-with-pingfusi: polish any
  // existing draft with review rounds). One kit, several front doors.
  const skillRoot = path.join(PKG, "skill");
  if (!fs.existsSync(skillRoot)) return { ok: false, message: `kit skills missing at ${skillRoot} — broken install; reinstall pingfusi`, installed: [] };
  const names = fs.readdirSync(skillRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(skillRoot, e.name, "SKILL.md"))).map((e) => e.name);
  if (!names.length) return { ok: false, message: `no skills found under ${skillRoot} — broken install; reinstall pingfusi`, installed: [] };

  const installed = [], skipped = [];
  for (const n of names) {
    const dest = path.join(homeDir, ".claude", "skills", n, "SKILL.md");
    if (fs.existsSync(dest) && !force) { skipped.push(n); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(skillRoot, n, "SKILL.md"), dest);
    installed.push(n);
  }
  if (!installed.length) {
    return { ok: false, message: `already installed (${skipped.join(", ")}) — re-run with --force to overwrite with this kit version's copies`, installed };
  }
  return { ok: true, installed, message: `✓ installed skill(s): ${installed.join(", ")}${skipped.length ? `  (kept existing: ${skipped.join(", ")} — --force to refresh)` : ""}
  → ${path.join(homeDir, ".claude", "skills")}
  Your agent picks them up on its next session. Then just ask it:
    "Clone https://example.com pixel-perfect."   (the full gated pipeline)
    "Fix it with pingfusi."                           (from inside any draft project — review rounds)
  (You'll be the reviewer: answer the pings — pin what looks wrong, always pick a verdict button.)` };
}

// `pingfusi remove` counterpart: delete the kit's skills from the agent's skill
// dir again. Driven by the same PKG/skill listing as install, so the two stay in
// sync by construction. Best-effort; returns the names it actually removed.
function removeSkills(homeDir) {
  const skillRoot = path.join(PKG, "skill");
  const removed = [];
  if (!fs.existsSync(skillRoot)) return removed;
  for (const e of fs.readdirSync(skillRoot, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dest = path.join(homeDir, ".claude", "skills", e.name);
    if (!fs.existsSync(dest)) continue;
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      removed.push(e.name);
    } catch {
      /* leave what we can't delete */
    }
  }
  return removed;
}

function main() {
  const force = process.argv.includes("--force");
  const r = install(os.homedir(), force);
  console.log(r.message);
  process.exit(r.ok ? 0 : 1);
}

if (require.main === module) main();
module.exports = { install, removeSkills };
