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
const { route, MCP_COMMANDS, kitSkillClient, sweepsKitSkills } = require("../bin/pingfusi");
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
for (const cmd of ["setup", "new", "adopt", "review", "motion", "next", "behavior-worksheet", "tunnel", "doctor", "agent-setup", "status", "advance", "help"]) {
  ok(route(cmd) === "kit", `'pingfusi ${cmd}' → kit workflow`);
}
ok(route(undefined) === "kit" && route("no-such-cmd") === "kit", "bare/unknown → kit (workflow.js owns help + unknown-command handling)");
ok(route("version") === "version" && route("-v") === "version", "version is answered by the dispatcher (vendored file would print its frozen 0.2.4)");
ok(JSON.stringify([...MCP_COMMANDS].sort()) === JSON.stringify(["remove", "rules", "uninstall", "wait", "whoami"]),
  "MCP passthrough surface is exactly the installer's own commands");
ok(!MCP_COMMANDS.has("motion") && !MCP_COMMANDS.has("next"), "motion/next cannot drift into the generic MCP passthrough");
ok(/case "motion"/.test(wf) && /case "next"/.test(wf) && /case "behavior-worksheet"/.test(wf), "workflow owns motion routing and the installed behavior worksheet");
ok(!/name === "declare"/.test(wf) && !/motion-declare\.js/.test(wf) && !/motion-review\.js/.test(wf), "the motion declare/review dispatch entries are gone (first-draft doctrine)");

// remove/uninstall sweep the kit's coding-agent skills in the same client scope.
ok(sweepsKitSkills(["remove"]) && sweepsKitSkills(["uninstall"]), "full remove sweeps kit skills");
ok(sweepsKitSkills(["remove", "--client", "claude-code"]) && sweepsKitSkills(["remove", "--code"]),
  "claude-code-scoped remove sweeps kit skills");
ok(sweepsKitSkills(["remove", "--client", "cursor"]) && sweepsKitSkills(["remove", "--cursor"]) &&
  sweepsKitSkills(["remove", "--codex"]) && !sweepsKitSkills(["remove", "--claude"]),
  "Cursor/Codex scoped remove sweeps their kit skills; Desktop has no skill surface");
ok(kitSkillClient(["remove", "--cursor"]) === "cursor" && kitSkillClient(["remove", "--codex"]) === "codex" &&
  kitSkillClient(["remove"]) === null, "remove client scope is parsed deterministically");
ok(!sweepsKitSkills(["wait"]) && !sweepsKitSkills(["setup"]), "non-remove commands never sweep");

// A malformed/absent --client value must be a HARD ERROR listing the valid clients — the
// old "" fallthrough read as "no client" and swept EVERY client's skill dirs.
const throwsClientError = (argv) => {
  try { kitSkillClient(argv); return null; }
  catch (e) { return e.message; }
};
const missingValue = throwsClientError(["remove", "--client"]);
const bogusValue = throwsClientError(["remove", "--client", "bogus"]);
ok(!!missingValue && /claude-code, cursor, codex, claude-desktop/.test(missingValue), "--client with NO value is a hard error listing the valid clients (never an all-client sweep)");
ok(!!bogusValue && /got "bogus"/.test(bogusValue) && /claude-code/.test(bogusValue), "--client with an unknown value is a hard error naming what it got");
{
  // end-to-end: the bin refuses BEFORE any sweep or installer runs, leaving skills intact
  const errHome = fs.mkdtempSync(path.join(os.tmpdir(), "ppk-bin-client-err-"));
  try {
    install(errHome, true);
    const BIN = path.join(__dirname, "..", "bin", "pingfusi");
    const r = spawnSync(process.execPath, [BIN, "remove", "--client"], { encoding: "utf8", env: { ...process.env, HOME: errHome, USERPROFILE: errHome } });
    ok(r.status === 2 && /--client needs one of/.test(r.stderr || ""), "`pingfusi remove --client` (missing value) exits 2 with the valid-client list");
    ok(fs.existsSync(path.join(errHome, ".claude", "skills", "pixel-perfect-clone")), "…and no skill dir was swept by the refused remove");
  } finally {
    fs.rmSync(errHome, { recursive: true, force: true });
  }
}

// the sweep round-trips against agent-setup's install (same PKG/skill listing)
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ppk-bin-dispatch-"));
try {
  const inst = install(tmpHome, true);
  const removed = removeSkills(tmpHome);
  ok(inst.ok && removed.length === inst.installed.length &&
    removed.every((n) => !fs.existsSync(path.join(tmpHome, ".claude", "skills", n))),
    `removeSkills deletes exactly what install wrote (${removed.join(", ")})`);
  ok(removeSkills(tmpHome).length === 0, "removeSkills is a no-op when nothing is installed");

  const codex = install(tmpHome, true, "codex");
  install(tmpHome, true, "cursor");
  const removedCodex = removeSkills(tmpHome, "codex");
  ok(codex.ok && removedCodex.length === codex.installed.length &&
    !fs.existsSync(path.join(tmpHome, ".codex", "skills", "pixel-perfect-clone")) &&
    fs.existsSync(path.join(tmpHome, ".cursor", "skills", "pixel-perfect-clone")),
    "scoped removal deletes Codex skills without touching Cursor");
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

// the vendored installer is intact ESM (top-level await — .mjs only) and byte-stable
const vendor = path.join(__dirname, "..", "vendor", "pingfusi-review.mjs");
ok(fs.existsSync(vendor), "vendor/pingfusi-review.mjs is shipped");
const chk = spawnSync(process.execPath, ["--check", vendor], { stdio: "pipe" });
ok(chk.status === 0, "vendored installer parses (node --check)");
const vendorText = fs.readFileSync(vendor, "utf8");
ok(/install the pingfusi review MCP server/.test(vendorText), "vendored file is the real installer, not a stub");
ok(/Clone-target precedence:[\s\S]*Never call the raw review MCP tools/.test(vendorText) &&
  /Clone Targets: the CLI Owns Orchestration[\s\S]*Never call request_review_test/.test(vendorText),
  "installed generic guidance yields clone targets to CLI gates and typed motion routing");

console.log(failed ? `\n❌ bin-dispatch-selftest: ${failed} assertion(s) failed.` : "\n✓ bin-dispatch-selftest: all assertions pass.");
process.exit(failed ? 1 : 0);
