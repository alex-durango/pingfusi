// harness/setup-selftest.js — guards the one-command onboarding (harness/setup.js).
// Fully offline: setup() takes an injectable io, so every prompt path is driven with
// scripted answers and a fake probe map; run() calls are recorded, never executed.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { setup, saidYes } = require("./setup.js");
const { supportsNode } = require("./node-runtime.js");
const { globalMotionPackageDir } = require("./motion-browser.js");

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed++; console.log(`  ✗ ${msg}`); } };

console.log("setup-selftest — one-command onboarding");

// consent semantics: Enter is yes ONLY on a real terminal; non-TTY silence is never consent
ok(saidYes("y", false) && saidYes("yes", true) && saidYes("", true), "y / yes / Enter-on-TTY are consent");
ok(!saidYes("", false) && !saidYes("n", true), "non-TTY silence and 'n' are NOT consent");

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-global-root-"));
  const motion = path.join(root, "pingfusi", "packages", "motion");
  fs.mkdirSync(motion, { recursive: true });
  const resolved = globalMotionPackageDir(() => ({ status: 0, stdout: `${root}\n` }));
  ok(resolved === motion, "npx setup resolves the persisted global motion package before installing hermetic browser binaries");
  fs.rmSync(root, { recursive: true, force: true });
}

function fakeIO({ probes, answers, tty, paths }) {
  const logs = [], runs = [];
  let i = 0;
  return {
    io: {
      isTTY: tty !== false,
      log: (...a) => logs.push(a.join(" ")),
      run: (cmd, args) => {
        runs.push([cmd, ...args].join(" "));
        return { status: 0 };
      },
      probe: (cmd) => !!probes[cmd],
      which: (cmd) => (paths && paths[cmd]) || null,
      ask: () => {
        const answer = answers[i++];
        return Promise.resolve(answer != null ? answer : "");
      },
    },
    logs, runs,
  };
}

const motionReady = () => ({ ok: true, source: "offline test" });
const motionMissing = () => ({ ok: false, reason: "browser missing in offline test" });

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-setup-"));

  // ── fresh machine (true npx first-run), user consents to everything ──────────
  // `which pingfusi` resolves to npx's EPHEMERAL bin — that must NOT count as installed
  // (found live: the bare probe said "already installed" during the npx run itself)
  {
    const { io, logs, runs } = fakeIO({ probes: { brew: true }, answers: ["", "", ""], paths: { pingfusi: "/Users/x/.npm/_npx/abc123/node_modules/.bin/pingfusi" } });
    let browserChecks = 0;
    const installsCleanly = () => ++browserChecks === 1 ? motionMissing() : motionReady();
    const r = await setup(io, { home, sourceCheckout: false, resolveToken: () => null, dittoApiKey: false, probeMotionBrowser: installsCleanly });
    ok(r.ok, "fresh-machine run completes");
    ok(runs.includes("npm i -g pingfusi"), "npx's ephemeral bin doesn't count as installed — global install prompt fires and runs on consent");
    ok(!runs.includes("brew install cloudflared"), "cloudflared is NOT installed by setup (the default flow is tunnel-free)");
    ok(logs.some((l) => /cloudflared not installed — fine/.test(l)), "absent cloudflared is reported as optional, not a warning");
    ok(runs.some((r2) => /playwright[\\/]cli\.js install chromium$/.test(r2)), "fresh setup installs the package-owned motion browser runtime on consent");
    ok(runs.some((r2) => /vendor[\\/]pingfusi-review\.mjs setup$/.test(r2)), "login step runs the VENDORED MCP installer (device flow + config patch), not npx cpyany");
    ok(logs.some((l) => /ditto \(optional fast builder\): connect its MCP/.test(l)), "ditto guidance is MCP/API-key based — never a binary probe (macOS ships /usr/bin/ditto, a guaranteed false positive)");
    ok(logs.some((l) => /taught your AI agent \(claude-code\): .*pixel-perfect-clone/.test(l)), "installs the agent skills into the detected coding-agent client");
    ok(fs.existsSync(path.join(home, ".claude", "skills", "pixel-perfect-clone", "SKILL.md")), "skills really land in the fake HOME");
    ok(logs.some((l) => /Clone https:\/\/example\.com pixel-perfect/.test(l)) && logs.some((l) => /Fix it with pingfusi/.test(l)), "summary teaches both agent sentences (clone + fix-it-with-pingfusi)");
  }

  // spawnSync can fail without a numeric status; never report that as installed.
  {
    const fake = fakeIO({ probes: { cloudflared: true }, answers: [""], paths: { pingfusi: "/usr/local/bin/pingfusi" } });
    fake.io.run = (cmd, args) => {
      fake.runs.push([cmd, ...args].join(" "));
      return { status: null, error: new Error("spawn failed") };
    };
    const r = await setup(fake.io, { home, sourceCheckout: false, resolveToken: () => "tok", dittoApiKey: false, probeMotionBrowser: motionMissing });
    ok(!r.ok && r.steps.includes("motion-browser-failed") && !fake.logs.some((l) => /installed motion browser runtime/.test(l)), "null-status/error browser installer cannot become a false success");
  }

  // A successful download is still incomplete when the real recording probe fails.
  {
    const fake = fakeIO({ probes: { cloudflared: true }, answers: [""], paths: { pingfusi: "/usr/local/bin/pingfusi" } });
    const r = await setup(fake.io, { home, sourceCheckout: false, resolveToken: () => "tok", dittoApiKey: false, probeMotionBrowser: motionMissing });
    ok(!r.ok && fake.logs.some((l) => /downloaded, but motion recording is not usable/i.test(l)), "exit-0 download is re-probed before setup claims readiness");
  }

  // Missing package-owned Playwright CLI is a structured setup failure, not a stack.
  {
    const fake = fakeIO({ probes: { cloudflared: true }, answers: [""], paths: { pingfusi: "/usr/local/bin/pingfusi" } });
    const r = await setup(fake.io, {
      home,
      sourceCheckout: false,
      resolveToken: () => "tok",
      dittoApiKey: false,
      probeMotionBrowser: motionMissing,
      resolveGlobalMotionPackageDir: () => path.join(home, "missing-motion-package"),
    });
    ok(!r.ok && fake.logs.some((l) => /Playwright CLI missing/.test(l)), "installer invocation errors are caught and surfaced with the recovery command");
    ok(fake.runs.some((r2) => /^npm ci --prefix .*missing-motion-package --ignore-scripts --global=false$/.test(r2)),
      "a lazy install (no engine node_modules) gets the npm dependency install first, under the same consent");
  }

  // ── a real global install IS recognized; a DITTO_API_KEY is reported ─────────
  {
    const { io, logs, runs } = fakeIO({ probes: { cloudflared: true }, answers: [], paths: { pingfusi: "/usr/local/bin/pingfusi" } });
    const r = await setup(io, { home, sourceCheckout: false, resolveToken: () => "tok", dittoApiKey: true, probeMotionBrowser: motionReady });
    ok(r.ok && runs.length === 0 && logs.some((l) => /already installed globally/.test(l)), "a persistent global bin counts as installed (no prompt)");
    ok(logs.some((l) => /DITTO_API_KEY found/.test(l)), "a configured ditto API key is reported");
  }

  // ── `pingfusi setup cursor`: the client arg reaches the MCP installer ────────
  {
    const { io, runs } = fakeIO({ probes: { cloudflared: true }, answers: [""], paths: { pingfusi: "/usr/local/bin/pingfusi" } });
    await setup(io, { home, sourceCheckout: false, resolveToken: () => null, dittoApiKey: false, mcpClient: "cursor", probeMotionBrowser: motionReady });
    ok(runs.some((r2) => /pingfusi-review\.mjs setup --client cursor$/.test(r2)), "optional client positional is passed through as the installer's --client flag");
  }

  // ── logged in + explicit client: the login gate must NOT swallow the request ──
  // (found live: `pingfusi setup codex` after a claude-code install was a silent
  // no-op — the "login found" branch never ran the installer for the new client)
  {
    const { io, runs } = fakeIO({ probes: { cloudflared: true }, answers: [], paths: { pingfusi: "/usr/local/bin/pingfusi" } });
    const r = await setup(io, { home, sourceCheckout: false, resolveToken: () => "tok", dittoApiKey: false, mcpClient: "codex", probeMotionBrowser: motionReady });
    ok(r.ok && runs.some((r2) => /pingfusi-review\.mjs setup --client codex$/.test(r2)), "existing login + explicit client still runs the installer for that client");
    ok(r.steps.includes("login-client-added"), "the client-add is recorded as its own step");
    const codexSkill = path.join(home, ".codex", "skills", "pixel-perfect-clone", "SKILL.md");
    ok(fs.existsSync(codexSkill), "setup codex installs the clone-routing skill into Codex's native skill directory");
    // PRESERVE contract: a byte-different installed skill may be a user edit — a plain
    // re-run must never clobber it; only an explicit --force refreshes it.
    fs.writeFileSync(codexSkill, "user-edited routing guidance\n");
    await setup(io, { home, sourceCheckout: false, resolveToken: () => "tok", dittoApiKey: false, mcpClient: "codex", probeMotionBrowser: motionReady });
    ok(/user-edited routing guidance/.test(fs.readFileSync(codexSkill, "utf8")), "a plain setup re-run preserves a locally-edited skill (never force-overwrites)");
    await setup(io, { home, sourceCheckout: false, resolveToken: () => "tok", dittoApiKey: false, mcpClient: "codex", force: true, probeMotionBrowser: motionReady });
    ok(/pingfusi next/.test(fs.readFileSync(codexSkill, "utf8")), "setup --force deliberately refreshes stale managed guidance");
  }

  // ── skip-everything path is HONEST about what breaks (no local-mode fallback) ──
  {
    const { io, logs, runs } = fakeIO({ probes: {}, answers: ["n", "n", "n"] });
    const r = await setup(io, { home: fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-setup2-")), sourceCheckout: false, resolveToken: () => null, dittoApiKey: false, probeMotionBrowser: motionMissing });
    ok(r.ok && runs.length === 0, "declining every prompt runs nothing");
    ok(logs.some((l) => /review rounds will NOT work without a login/.test(l)) && logs.some((l) => /pingfusi setup/.test(l)), "skipping the login says review rounds won't work + how to log in later");
    ok(logs.some((l) => /motion capture\/trace\/replay will not work/.test(l)) && logs.some((l) => /pingfusi motion install-browser/.test(l)), "skipping the motion browser names the affected tools and a runnable installed-package fix");
    ok(!logs.some((l) => /--local|__review|LOCAL review mode/.test(l)), "no remnant of the removed local review mode in setup output");
  }

  // ── accepting a required motion install that then fails is not "Done" ───────
  {
    const fake = fakeIO({ probes: { cloudflared: true }, answers: [""], paths: { pingfusi: "/usr/local/bin/pingfusi" } });
    fake.io.run = (cmd, args) => {
      fake.runs.push([cmd, ...args].join(" "));
      return { status: 1 };
    };
    const r = await setup(fake.io, {
      home,
      sourceCheckout: false,
      resolveToken: () => "tok",
      dittoApiKey: false,
      probeMotionBrowser: motionMissing,
    });
    ok(!r.ok && r.steps.includes("motion-browser-failed"), "a failed accepted motion-browser install makes setup exit nonzero");
    ok(fake.logs.some((l) => /Setup incomplete/.test(l)) && !fake.logs.some((l) => /Done\. Open your AI agent/.test(l)), "failed required setup never prints the success handoff");
  }

  // ── unattended (non-TTY): silence never installs or opens logins ─────────────
  {
    const { io, runs } = fakeIO({ probes: { brew: true }, answers: [], tty: false });
    const r = await setup(io, { home: fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-setup3-")), sourceCheckout: false, resolveToken: () => null, dittoApiKey: false, probeMotionBrowser: motionMissing });
    ok(r.ok && runs.length === 0, "non-TTY run never executes installers (silence is not consent)");
  }

  // ── source checkout + everything already present = pure no-op re-run ─────────
  {
    const { io, logs, runs } = fakeIO({ probes: { cloudflared: true }, answers: [] });
    const r = await setup(io, { home, sourceCheckout: true, resolveToken: () => "tok", dittoApiKey: false, probeMotionBrowser: motionReady });
    ok(r.ok && runs.length === 0, "idempotent re-run: probes pass, nothing executes");
    ok(logs.some((l) => /source checkout/.test(l)) && logs.some((l) => /login found/.test(l)), "re-run reports present state (checkout copy, login)");
    ok(r.steps.includes("skills-present"), "already-installed skills are kept, not overwritten");
  }

  // ── exact dependency-supported Node boundaries ───────────────────────────────
  ok(!supportsNode("20.16.9") && supportsNode("20.17.0") && !supportsNode("21.9.0")
    && !supportsNode("22.12.9") && supportsNode("22.13.0")
    && !supportsNode("23.4.9") && supportsNode("23.5.0") && supportsNode("24.0.0"), "setup shares the exact Node floor required by its direct dependencies");

  console.log(failed ? `\n❌ setup-selftest: ${failed} assertion(s) failed.` : "\n✓ setup-selftest: all assertions pass.");
  process.exit(failed ? 1 : 0);
})();
