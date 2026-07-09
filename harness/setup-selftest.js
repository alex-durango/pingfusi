// harness/setup-selftest.js — guards the one-command onboarding (harness/setup.js).
// Fully offline: setup() takes an injectable io, so every prompt path is driven with
// scripted answers and a fake probe map; run() calls are recorded, never executed.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { setup, saidYes } = require("./setup.js");

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed++; console.log(`  ✗ ${msg}`); } };

console.log("setup-selftest — one-command onboarding");

// consent semantics: Enter is yes ONLY on a real terminal; non-TTY silence is never consent
ok(saidYes("y", false) && saidYes("yes", true) && saidYes("", true), "y / yes / Enter-on-TTY are consent");
ok(!saidYes("", false) && !saidYes("n", true), "non-TTY silence and 'n' are NOT consent");

function fakeIO({ probes, answers, tty, paths }) {
  const logs = [], runs = [];
  let i = 0;
  return {
    io: {
      isTTY: tty !== false,
      log: (...a) => logs.push(a.join(" ")),
      run: (cmd, args) => runs.push([cmd, ...args].join(" ")),
      probe: (cmd) => !!probes[cmd],
      which: (cmd) => (paths && paths[cmd]) || null,
      ask: () => Promise.resolve(answers[i++] != null ? answers[i++ - 1] : ""),
    },
    logs, runs,
  };
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-setup-"));

  // ── fresh machine (true npx first-run), user consents to everything ──────────
  // `which pingfusi` resolves to npx's EPHEMERAL bin — that must NOT count as installed
  // (found live: the bare probe said "already installed" during the npx run itself)
  {
    const { io, logs, runs } = fakeIO({ probes: { brew: true }, answers: ["", "", ""], paths: { pingfusi: "/Users/x/.npm/_npx/abc123/node_modules/.bin/pingfusi" } });
    const r = await setup(io, { home, sourceCheckout: false, resolveToken: () => null, dittoApiKey: false });
    ok(r.ok, "fresh-machine run completes");
    ok(runs.includes("npm i -g pingfusi"), "npx's ephemeral bin doesn't count as installed — global install prompt fires and runs on consent");
    ok(runs.includes("brew install cloudflared"), "installs cloudflared via brew on consent");
    ok(runs.some((r2) => /vendor[\\/]pingfusi-review\.mjs setup$/.test(r2)), "login step runs the VENDORED MCP installer (device flow + config patch), not npx cpyany");
    ok(logs.some((l) => /ditto \(optional fast builder\): connect its MCP/.test(l)), "ditto guidance is MCP/API-key based — never a binary probe (macOS ships /usr/bin/ditto, a guaranteed false positive)");
    ok(logs.some((l) => /taught your AI agent: .*pixel-perfect-clone/.test(l)), "installs the agent skills");
    ok(fs.existsSync(path.join(home, ".claude", "skills", "pixel-perfect-clone", "SKILL.md")), "skills really land in the fake HOME");
    ok(logs.some((l) => /Clone https:\/\/example\.com pixel-perfect/.test(l)) && logs.some((l) => /Fix it with pingfusi/.test(l)), "summary teaches both agent sentences (clone + fix-it-with-pingfusi)");
  }

  // ── a real global install IS recognized; a DITTO_API_KEY is reported ─────────
  {
    const { io, logs, runs } = fakeIO({ probes: { cloudflared: true }, answers: [], paths: { pingfusi: "/usr/local/bin/pingfusi" } });
    const r = await setup(io, { home, sourceCheckout: false, resolveToken: () => "tok", dittoApiKey: true });
    ok(r.ok && runs.length === 0 && logs.some((l) => /already installed globally/.test(l)), "a persistent global bin counts as installed (no prompt)");
    ok(logs.some((l) => /DITTO_API_KEY found/.test(l)), "a configured ditto API key is reported");
  }

  // ── `pingfusi setup cursor`: the client arg reaches the MCP installer ────────
  {
    const { io, runs } = fakeIO({ probes: { cloudflared: true }, answers: [""], paths: { pingfusi: "/usr/local/bin/pingfusi" } });
    await setup(io, { home, sourceCheckout: false, resolveToken: () => null, dittoApiKey: false, mcpClient: "cursor" });
    ok(runs.some((r2) => /pingfusi-review\.mjs setup --client cursor$/.test(r2)), "optional client positional is passed through as the installer's --client flag");
  }

  // ── logged in + explicit client: the login gate must NOT swallow the request ──
  // (found live: `pingfusi setup codex` after a claude-code install was a silent
  // no-op — the "login found" branch never ran the installer for the new client)
  {
    const { io, runs } = fakeIO({ probes: { cloudflared: true }, answers: [], paths: { pingfusi: "/usr/local/bin/pingfusi" } });
    const r = await setup(io, { home, sourceCheckout: false, resolveToken: () => "tok", dittoApiKey: false, mcpClient: "codex" });
    ok(r.ok && runs.some((r2) => /pingfusi-review\.mjs setup --client codex$/.test(r2)), "existing login + explicit client still runs the installer for that client");
    ok(r.steps.includes("login-client-added"), "the client-add is recorded as its own step");
  }

  // ── skip-everything path still ends usable (local review mode) ────────────────
  {
    const { io, logs, runs } = fakeIO({ probes: {}, answers: ["n", "n", "n"] });
    const r = await setup(io, { home: fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-setup2-")), sourceCheckout: false, resolveToken: () => null, dittoApiKey: false });
    ok(r.ok && runs.length === 0, "declining every prompt runs nothing");
    ok(logs.some((l) => /LOCAL review mode/.test(l)) && logs.some((l) => /file --local/.test(l)), "skip path points at local review mode explicitly");
  }

  // ── unattended (non-TTY): silence never installs or opens logins ─────────────
  {
    const { io, runs } = fakeIO({ probes: { brew: true }, answers: [], tty: false });
    const r = await setup(io, { home: fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-setup3-")), sourceCheckout: false, resolveToken: () => null, dittoApiKey: false });
    ok(r.ok && runs.length === 0, "non-TTY run never executes installers (silence is not consent)");
  }

  // ── source checkout + everything already present = pure no-op re-run ─────────
  {
    const { io, logs, runs } = fakeIO({ probes: { cloudflared: true }, answers: [] });
    const r = await setup(io, { home, sourceCheckout: true, resolveToken: () => "tok", dittoApiKey: false });
    ok(r.ok && runs.length === 0, "idempotent re-run: probes pass, nothing executes");
    ok(logs.some((l) => /source checkout/.test(l)) && logs.some((l) => /login found/.test(l)), "re-run reports present state (checkout copy, login)");
    ok(r.steps.includes("skills-present"), "already-installed skills are kept, not overwritten");
  }

  // ── old node fails fast with the fix ──────────────────────────────────────────
  // (checkable only via the saidYes/steps contract — setup reads the REAL process
  // version, so we assert the guard's presence in source rather than simulate it)
  ok(/needs Node 18\+/.test(fs.readFileSync(path.join(__dirname, "setup.js"), "utf8")), "old-node guard exists with the fix text");

  console.log(failed ? `\n❌ setup-selftest: ${failed} assertion(s) failed.` : "\n✓ setup-selftest: all assertions pass.");
  process.exit(failed ? 1 : 0);
})();
