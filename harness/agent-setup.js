// harness/agent-setup.js — `pingfusi agent-setup`: teach the user's AI agent to use the kit.
//
// The kit's entire new-user experience is "install, then ask your agent to clone a
// site" — this is the command that makes the second half true. It installs the kit's
// clone-site skill into the selected coding agent's skill directory, where the agent
// auto-discovers it: from then on, "clone https://example.com" in any
// session triggers the skill, which drives the full pingfusi pipeline and iterates on
// review rounds answered by an independent reviewer until one approves.
//
// USAGE:  pingfusi agent-setup [claude-code|cursor|codex] [--force]
//         With no client, existing agent homes are detected; Claude Code is the fallback.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const PKG = path.resolve(__dirname, "..");

const CLIENT_SKILL_DIRS = Object.freeze({
  "claude-code": [".claude", "skills"],
  cursor: [".cursor", "skills"],
  codex: [".codex", "skills"],
});

function resolveClients(homeDir, requested) {
  const raw = Array.isArray(requested) ? requested : requested ? [requested] : [];
  if (raw.length) {
    const normalized = [...new Set(raw.map((v) => String(v).toLowerCase()))];
    const unsupported = normalized.filter((v) => !CLIENT_SKILL_DIRS[v] && v !== "claude-desktop");
    if (unsupported.length) throw new Error(`unsupported coding-agent client: ${unsupported.join(", ")}`);
    return normalized.filter((v) => CLIENT_SKILL_DIRS[v]);
  }
  const detected = Object.keys(CLIENT_SKILL_DIRS).filter((client) =>
    fs.existsSync(path.join(homeDir, CLIENT_SKILL_DIRS[client][0]))
  );
  return detected.length ? detected : ["claude-code"];
}

function skillDir(homeDir, client) {
  return path.join(homeDir, ...CLIENT_SKILL_DIRS[client]);
}

function install(homeDir, force, requestedClient, options = {}) {
  // Every skill the kit ships lives in PKG/skill/<skill-name>/SKILL.md — install them
  // all (pixel-perfect-clone: the full gated pipeline; fix-with-pingfusi: polish any
  // existing draft with review rounds). One kit, several front doors.
  const skillRoot = path.join(PKG, "skill");
  if (!fs.existsSync(skillRoot)) return { ok: false, message: `kit skills missing at ${skillRoot} — broken install; reinstall pingfusi`, installed: [] };
  const names = fs.readdirSync(skillRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(skillRoot, e.name, "SKILL.md"))).map((e) => e.name);
  if (!names.length) return { ok: false, message: `no skills found under ${skillRoot} — broken install; reinstall pingfusi`, installed: [] };

  let clients;
  try { clients = resolveClients(homeDir, requestedClient); }
  catch (e) { return { ok: false, message: e.message, installed: [], clients: [] }; }
  if (!clients.length) {
    return { ok: false, message: "the selected client has no coding-agent skill directory; MCP setup still applies", installed: [], clients };
  }

  const installed = new Set(), refreshed = new Set(), skipped = [], destinations = [];
  for (const client of clients) {
    const root = skillDir(homeDir, client);
    destinations.push(root);
    for (const n of names) {
      const source = path.join(skillRoot, n, "SKILL.md");
      const dest = path.join(root, n, "SKILL.md");
      const exists = fs.existsSync(dest);
      const current = exists && fs.readFileSync(source).equals(fs.readFileSync(dest));
      if (exists && (!force || (options.skipCurrent && current))) {
        skipped.push(`${client}:${n}`);
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(source, dest);
      installed.add(n);
      if (exists) refreshed.add(n);
    }
  }
  const installedNames = [...installed];
  if (!installedNames.length) {
    return { ok: false, message: `already current for ${clients.join(", ")}${force ? "" : " — re-run with --force to overwrite"}`, installed: installedNames, refreshed: [], skipped, clients, destinations };
  }
  return { ok: true, installed: installedNames, refreshed: [...refreshed], skipped, clients, destinations, message: `✓ installed/refreshed skill(s): ${installedNames.join(", ")}${skipped.length ? `  (kept current/existing: ${skipped.join(", ")})` : ""}
  → ${destinations.join("\n  → ")}
  Your agent picks them up on its next session. Then just ask it:
    "Clone https://example.com pixel-perfect."   (the full gated pipeline)
    "Fix it with pingfusi."                           (from inside any draft project — review rounds)
  (Review rounds are answered by an independent reviewer — the agent iterates until one approves.)` };
}

// `pingfusi remove` counterpart: delete the kit's skills from the agent's skill
// dir again. Driven by the same PKG/skill listing as install, so the two stay in
// sync by construction. Best-effort; returns the names it actually removed.
function removeSkills(homeDir, requestedClient) {
  const skillRoot = path.join(PKG, "skill");
  const removed = new Set();
  if (!fs.existsSync(skillRoot)) return [];
  let clients;
  try { clients = requestedClient ? resolveClients(homeDir, requestedClient) : Object.keys(CLIENT_SKILL_DIRS); }
  catch { return []; }
  for (const client of clients) {
    for (const e of fs.readdirSync(skillRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dest = path.join(skillDir(homeDir, client), e.name);
      if (!fs.existsSync(dest)) continue;
      try {
        fs.rmSync(dest, { recursive: true, force: true });
        removed.add(e.name);
      } catch {
        /* leave what we can't delete */
      }
    }
  }
  return [...removed];
}

function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const flag = argv.indexOf("--client");
  const requested = flag >= 0 ? argv[flag + 1] : argv.find((v) => !v.startsWith("--"));
  const r = install(os.homedir(), force, requested);
  console.log(r.message);
  process.exit(r.ok ? 0 : 1);
}

if (require.main === module) main();
module.exports = { CLIENT_SKILL_DIRS, resolveClients, install, removeSkills };
