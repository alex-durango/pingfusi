// harness/bin-dispatch-selftest.js — guards the `pingfusi` bin dispatcher.
//
// One command, two engines: the kit (harness/workflow.js) is the DEFAULT for every
// invocation, and the pingfusi review MCP installer (vendor/pingfusi-review.mjs) handles
// only its own non-colliding commands.
// This is the contract that `pingfusi setup` is the merged onboarding (its login step
// runs the installer's device flow) while `pingfusi wait <ping_id>` etc. still work.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const os = require("os");
const { route, MCP_COMMANDS, sweepsKitSkills } = require("../bin/pingfusi");
const { install, removeSkills } = require("./agent-setup.js");

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed++; console.log(`  ✗ ${msg}`); } };

console.log("bin-dispatch-selftest — the pingfusi bin routes both engines");

// installer passthrough — only its own commands, all verified non-colliding with the kit
const wf = fs.readFileSync(path.join(__dirname, "workflow.js"), "utf8");
for (const cmd of ["remove", "uninstall", "wait", "whoami", "rules"]) {
  ok(route(cmd) === "mcp", `'pingfusi ${cmd}' → MCP installer`);
  ok(!new RegExp(`case "${cmd}"`).test(wf), `'${cmd}' does not collide with a kit command (drift guard)`);
}

// the kit is the default — setup DELIBERATELY: the merged onboarding runs the MCP
// device-flow install as its login step, so no installer surface is lost
for (const cmd of ["setup", "new", "adopt", "review", "tunnel", "doctor", "agent-setup", "status", "advance", "help"]) {
  ok(route(cmd) === "kit", `'pingfusi ${cmd}' → kit workflow`);
}
ok(route(undefined) === "kit" && route("no-such-cmd") === "kit", "bare/unknown → kit (workflow.js owns help + unknown-command handling)");
ok(route("version") === "version" && route("-v") === "version", "version is answered by the dispatcher (vendored file would print its frozen 0.2.4)");
ok(MCP_COMMANDS.size === 5, "MCP passthrough surface is exactly the installer's own commands");

// remove/uninstall sweep the kit's agent skills too — but only when Claude Code is
// in scope (the MCP installer knows nothing about ~/.claude/skills/<kit-skill>)
ok(sweepsKitSkills(["remove"]) && sweepsKitSkills(["uninstall"]), "full remove sweeps kit skills");
ok(sweepsKitSkills(["remove", "--client", "claude-code"]) && sweepsKitSkills(["remove", "--code"]),
  "claude-code-scoped remove sweeps kit skills");
ok(!sweepsKitSkills(["remove", "--client", "cursor"]) && !sweepsKitSkills(["remove", "--cursor"]) &&
  !sweepsKitSkills(["remove", "--claude"]) && !sweepsKitSkills(["remove", "--codex"]),
  "other-client remove leaves ~/.claude alone");
ok(!sweepsKitSkills(["wait"]) && !sweepsKitSkills(["setup"]), "non-remove commands never sweep");

// the sweep round-trips against agent-setup's install (same PKG/skill listing)
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ppk-bin-dispatch-"));
try {
  const inst = install(tmpHome, true);
  const removed = removeSkills(tmpHome);
  ok(inst.ok && removed.length === inst.installed.length &&
    removed.every((n) => !fs.existsSync(path.join(tmpHome, ".claude", "skills", n))),
    `removeSkills deletes exactly what install wrote (${removed.join(", ")})`);
  ok(removeSkills(tmpHome).length === 0, "removeSkills is a no-op when nothing is installed");
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

// the vendored installer is intact ESM (top-level await — .mjs only) and byte-stable
const vendor = path.join(__dirname, "..", "vendor", "pingfusi-review.mjs");
ok(fs.existsSync(vendor), "vendor/pingfusi-review.mjs is shipped");
const chk = spawnSync(process.execPath, ["--check", vendor], { stdio: "pipe" });
ok(chk.status === 0, "vendored installer parses (node --check)");
ok(/install the pingfusi review MCP server/.test(fs.readFileSync(vendor, "utf8")), "vendored file is the real installer, not a stub");

console.log(failed ? `\n❌ bin-dispatch-selftest: ${failed} assertion(s) failed.` : "\n✓ bin-dispatch-selftest: all assertions pass.");
process.exit(failed ? 1 : 0);
