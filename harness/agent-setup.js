// harness/agent-setup.js — `pingfusi agent-setup`: teach the user's AI agent to use the kit.
//
// The kit's new-user experience is "install, then ask your agent" — this command
// installs every shipped use-case skill into the selected coding agent's native skill
// directory. The universal pingfusi-review router teaches WHEN to ask a reviewer and
// which job to choose; the specialized skills own their detailed workflows.
//
// An already-installed SKILL.md is resolved by PROVENANCE, not by byte-equality alone
// (harness/skill-provenance.js): content this package has shipped before is OURS and a
// plain re-run refreshes it, so an upgrade's new guidance actually reaches an existing
// install; anything unrecognized is the user's edit and only --force replaces it, saving
// what it replaced as SKILL.md.bak.
//
// USAGE:  pingfusi agent-setup [claude-code|cursor|codex] [--force]
//         With no client, existing agent homes are detected; Claude Code is the fallback.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { skillNames, loadManifest, isShippedVersion } = require("./skill-provenance.js");

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

// Where a brand wrapper's always-loaded rule lands, per client. Mirrors the
// vendored installer's rulePath()/ruleContent() shape: Claude Code takes plain
// md in ~/.claude/rules/, Cursor takes .mdc with alwaysApply frontmatter in
// ~/.cursor/rules/, Codex has no rules dir.
function ruleAssetPath(homeDir, client, fileBaseName) {
  if (client === "claude-code") return path.join(homeDir, ".claude", "rules", `${fileBaseName}.md`);
  if (client === "cursor") return path.join(homeDir, ".cursor", "rules", `${fileBaseName}.mdc`);
  return null;
}

function ruleAssetContent(client, body) {
  return client === "cursor" ? "---\nalwaysApply: true\n---\n\n" + body : body;
}

function install(homeDir, force, requestedClient, options = {}) {
  // Every skill the kit ships lives in PKG/skill/<skill-name>/SKILL.md — install them
  // all. One kit, several use-case front doors over the same review verbs. A brand
  // wrapper riding the kit points options.skillRoot at its own skill dir instead, and
  // may add options.ruleAsset = { fileBaseName, body } for its always-loaded rule.
  const skillRoot = options.skillRoot || path.join(PKG, "skill");
  if (!fs.existsSync(skillRoot)) return { ok: false, message: `kit skills missing at ${skillRoot} — broken install; reinstall pingfusi`, installed: [] };
  const names = skillNames(skillRoot);
  if (!names.length) return { ok: false, message: `no skills found under ${skillRoot} — broken install; reinstall pingfusi`, installed: [] };
  // Provenance for the preserve rule below (harness/skill-provenance.js): the hash of
  // every SKILL.md version this package has shipped, so an install carrying an OLD one
  // can be refreshed without asking the user for --force.
  const shipped = loadManifest(skillRoot);

  let clients;
  try { clients = resolveClients(homeDir, requestedClient); }
  catch (e) { return { ok: false, message: e.message, installed: [], clients: [] }; }
  if (!clients.length) {
    return { ok: false, message: "the selected client has no coding-agent skill directory; MCP setup still applies", installed: [], clients };
  }

  const installed = new Set(), refreshed = new Set(), skipped = [], preserved = [], backups = [], destinations = [];
  for (const client of clients) {
    const root = skillDir(homeDir, client);
    destinations.push(root);
    for (const n of names) {
      const source = path.join(skillRoot, n, "SKILL.md");
      const dest = path.join(root, n, "SKILL.md");
      let onDisk = null;
      try { onDisk = fs.readFileSync(dest); } catch { /* nothing installed yet */ }
      const exists = onDisk !== null;
      const current = exists && fs.readFileSync(source).equals(onDisk);
      // A byte-difference is not evidence of a hand edit: content we have shipped
      // before is OURS, and a plain re-run refreshes it (that is how an upgrade's new
      // guidance reaches an existing install at all). Anything unrecognized is the
      // user's and still survives everything but --force.
      const ours = exists && !current && isShippedVersion(shipped, n, onDisk);
      const preserve = exists && !current && !ours && !force;
      const alreadyCurrent = exists && current && (!force || options.skipCurrent);
      if (preserve || alreadyCurrent) {
        skipped.push(`${client}:${n}`);
        if (preserve) preserved.push(`${client}:${n}`);
        continue;
      }
      // --force over an unrecognized file is the ONLY path that can lose the user's
      // work: copy it beside the skill first, the way the vendored installer's refresh
      // does. The `.bak` suffix falls outside the agent's SKILL.md discovery, so the
      // backup never becomes a second, stale copy of the guidance. Best-effort — a
      // backup we cannot write must not block the refresh.
      if (exists && !current && !ours) {
        try { fs.writeFileSync(`${dest}.bak`, onDisk); backups.push(`${dest}.bak`); } catch { /* best-effort */ }
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(source, dest);
      installed.add(n);
      if (exists) refreshed.add(n);
    }
  }
  // The wrapper's rule is managed text (like the vendored installer's own rule
  // file): always written to the current body, never preserved as a user edit.
  const rules = [];
  if (options.ruleAsset) {
    for (const client of clients) {
      const dest = ruleAssetPath(homeDir, client, options.ruleAsset.fileBaseName);
      if (!dest) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, ruleAssetContent(client, options.ruleAsset.body));
      rules.push(dest);
    }
  }

  // Only a file we could not recognize keeps the --force advice — after provenance,
  // "already current" usually means exactly that, with nothing left to overwrite.
  const preservedNote = preserved.length
    ? ` — kept your locally-edited skill(s): ${preserved.join(", ")}; re-run with --force to overwrite`
    : "";
  const installedNames = [...installed];
  if (!installedNames.length) {
    return { ok: false, message: `already current for ${clients.join(", ")}${preservedNote}`, installed: installedNames, refreshed: [], skipped, preserved, backups, clients, destinations, rules };
  }
  return { ok: true, installed: installedNames, refreshed: [...refreshed], skipped, preserved, backups, clients, destinations, rules, message: `✓ installed/refreshed skill(s): ${installedNames.join(", ")}${skipped.length ? `  (kept current/existing: ${skipped.join(", ")})` : ""}${preservedNote}
  → ${destinations.join("\n  → ")}
  Your agent picks them up on its next session. Then just ask it:
    "Which headline is clearer? Ask a human."    (one advisory judgment call)
    "Review this build with pingfusi."           (generic verdict + pinned feedback)
    "Clone https://example.com pixel-perfect."   (the full gated pipeline)
    "Fix it with pingfusi."                      (match an existing draft to its reference)
    "Beautify this page. Use pingfusi."          (professional polish, no reference required)
    "Review this video with pingfusi."           (rendered output judged against its brief)
  (Review rounds are answered by an independent reviewer — the agent iterates until one approves.)` };
}

// `pingfusi remove` counterpart: delete the kit's skills from the agent's skill
// dir again. Driven by the same skill-root listing as install (options.skillRoot,
// default PKG/skill), so the two stay in sync by construction. Best-effort;
// returns the names it actually removed.
function removeSkills(homeDir, requestedClient, options = {}) {
  const skillRoot = options.skillRoot || path.join(PKG, "skill");
  const removed = new Set();
  let clients;
  try { clients = requestedClient ? resolveClients(homeDir, requestedClient) : Object.keys(CLIENT_SKILL_DIRS); }
  catch { return []; }
  if (options.ruleAsset) {
    for (const client of clients) {
      const dest = ruleAssetPath(homeDir, client, options.ruleAsset.fileBaseName);
      if (!dest) continue;
      try { fs.rmSync(dest, { force: true }); } catch { /* leave what we can't delete */ }
    }
  }
  if (!fs.existsSync(skillRoot)) return [];
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
module.exports = { CLIENT_SKILL_DIRS, resolveClients, install, removeSkills, ruleAssetPath };
