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
for (const cmd of ["setup", "new", "adopt", "review", "motion", "next", "behavior-worksheet", "publish", "tunnel", "doctor", "agent-setup", "status", "advance", "help", "ask"]) {
  ok(route(cmd) === "kit", `'pingfusi ${cmd}' → kit workflow`);
}
ok(route(undefined) === "kit" && route("no-such-cmd") === "kit", "bare/unknown → kit (workflow.js owns help + unknown-command handling)");
ok(route("version") === "version" && route("-v") === "version", "version is answered by the dispatcher (vendored file would print its frozen 0.2.4)");
ok(JSON.stringify([...MCP_COMMANDS].sort()) === JSON.stringify(["remove", "rules", "uninstall", "wait", "whoami"]),
  "MCP passthrough surface is exactly the installer's own commands");
ok(!MCP_COMMANDS.has("motion") && !MCP_COMMANDS.has("next"), "motion/next cannot drift into the generic MCP passthrough");
ok(/case "motion"/.test(wf) && /case "next"/.test(wf) && /case "behavior-worksheet"/.test(wf) && /case "publish"/.test(wf), "workflow owns motion routing, hosted publishing, and the installed behavior worksheet");
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

// ── the workspace-free generic verb: `pingfusi ask` end-to-end, ZERO cloning code ──
// The core-extraction acceptance: an agent asking a reviewer to pick between taglines
// runs from an EMPTY directory (no targets/, no workspace) through the same file://
// mock transport the core selftests use (PPK_PINGHUMANS_URL=file://MOCK serves canned
// quick_poll.json / get_ping-<ping_id>.json), with state under ~/.pingfusi/asks/.
{
  const MOCK = fs.mkdtempSync(path.join(os.tmpdir(), "ppk-ask-mock-"));
  const askHome = fs.mkdtempSync(path.join(os.tmpdir(), "ppk-ask-home-"));
  const emptyWork = fs.mkdtempSync(path.join(os.tmpdir(), "ppk-ask-work-"));
  const BIN = path.join(__dirname, "..", "bin", "pingfusi");
  const env = { ...process.env, HOME: askHome, USERPROFILE: askHome, PPK_PINGHUMANS_URL: "file://" + MOCK };
  const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env, cwd: emptyWork });
  const ID = "00000000-0000-4000-8000-00000000a51d";
  const ID2 = "00000000-0000-4000-8000-00000000a52d";
  try {
    // file: the server returned pending inside the call — print the id + the collect command
    fs.writeFileSync(path.join(MOCK, "quick_poll.json"), JSON.stringify({ ping_id: ID, status: "pending", n_received: 0, n_target: 1, responses: [] }));
    let r = run(["ask", "Which tagline reads better?", "--options", "Draft first,Review everything", "--context", "two candidates for the launch page"]);
    ok(r.status === 0 && r.stdout.includes(`ping ${ID}`) && r.stdout.includes(`pingfusi ask result ${ID}`),
      "`pingfusi ask` files from an empty dir and prints the ping id + the collect command");
    const rec = JSON.parse(fs.readFileSync(path.join(askHome, ".pingfusi", "asks", `${ID}.json`), "utf8"));
    ok(rec.ping_id === ID && rec.question === "Which tagline reads better?" && rec.n_target === 1
      && JSON.stringify(rec.options) === JSON.stringify(["Draft first", "Review everything"])
      && rec.last && rec.last.status === "pending" && rec.last.responses.length === 0,
      "…and records the ask under ~/.pingfusi/asks/<ping_id>.json (workspace-free state)");
    ok(!fs.existsSync(path.join(emptyWork, "targets")), "…creating NO targets/ workspace anywhere");
    // collect: the answer + notes, persisted on the record
    fs.writeFileSync(path.join(MOCK, `get_ping-${ID}.json`), JSON.stringify({ status: "complete", n_received: 1, responses: [{ choice: "Draft first", free_text: "reads cleaner" }] }));
    r = run(["ask", "result", ID]);
    ok(r.status === 0 && /\[Draft first\] reads cleaner/.test(r.stdout), "`pingfusi ask result` collects the answer + notes (free re-fetch)");
    const rec2 = JSON.parse(fs.readFileSync(path.join(askHome, ".pingfusi", "asks", `${ID}.json`), "utf8"));
    ok(rec2.last.responses[0].choice === "Draft first" && rec2.last.responses[0].text === "reads cleaner" && !!rec2.checked_at,
      "…and persists the collected answer on the ask record");
    // the blocking call often carries the answer already — printed immediately
    fs.writeFileSync(path.join(MOCK, "quick_poll.json"), JSON.stringify({ ping_id: ID2, status: "complete", n_received: 1, n_target: 1, responses: [{ choice: "Yes", free_text: "clear winner" }] }));
    r = run(["ask", "quick check — does the second option read as a verb?"]);
    ok(r.status === 0 && /\[Yes\] clear winner/.test(r.stdout), "an answer arriving inside the blocking call is printed immediately");
    // a pending collect is exit 1 with the free re-check named
    fs.writeFileSync(path.join(MOCK, `get_ping-${ID2}.json`), JSON.stringify({ status: "pending", n_received: 0, responses: [] }));
    r = run(["ask", "result", ID2]);
    ok(r.status === 1 && /0 answers yet/.test(r.stderr) && new RegExp(`pingfusi ask result ${ID2}`).test(r.stderr),
      "a pending collect exits 1 and names the free re-check");
    // usage/cap errors are exit 2, refused locally before any wire call
    ok(run(["ask"]).status === 2, "`pingfusi ask` with no question is a usage error (exit 2)");
    ok(run(["ask", "result"]).status === 2, "`pingfusi ask result` with no ping id is a usage error (exit 2)");
    r = run(["ask", "pick one", "--options", "this option text is far past the forty character service cap,B"]);
    ok(r.status === 2 && /caps options at 40/.test(r.stderr), "an option past the 40-char service cap is a NAMED local refusal, before any bytes move");
  } finally {
    for (const d of [MOCK, askHome, emptyWork]) fs.rmSync(d, { recursive: true, force: true });
  }
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
