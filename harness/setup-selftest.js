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
const { MANIFEST_BASENAME, hashSkill } = require("./skill-provenance.js");

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

// Windows first-run (found live 2026-08-10, LEARNINGS #42): npm is npm.cmd — a batch
// file Node only spawns through the shell — and `command -v` needs an sh Windows doesn't
// have, so setup told the user the install they had JUST run had failed. Pin both
// platform-split invocation shapes, and the one-place quoting shell:true demands.
{
  const { npmInvocation, whichInvocation } = require("./proc.js");
  const posix = npmInvocation(["i", "-g", "pingfusi"], "darwin");
  ok(posix.command === "npm" && posix.shell === false && posix.args.join(" ") === "i -g pingfusi", "posix npm spawns directly — no shell, args untouched");
  const win = npmInvocation(["i", "-g", "pingfusi"], "win32");
  ok(win.shell === true && win.command === "npm i -g pingfusi", "win32 npm routes through the shell (npm.cmd is a batch file — bare spawn is EINVAL)");
  const spaced = npmInvocation(["ci", "--prefix", "C:\\Users\\Jo Smith\\npm-cache\\_npx\\m"], "win32");
  ok(spaced.command === 'npm ci --prefix "C:\\Users\\Jo Smith\\npm-cache\\_npx\\m"', "shell:true does not escape args — a spaced path is quoted in proc.js, nowhere else");
  const winWhich = whichInvocation("pingfusi", "win32");
  ok(winWhich.command === "where" && winWhich.args[0] === "pingfusi", "win32 PATH probe is `where` — there is no sh to run `command -v`");
  const posixWhich = whichInvocation("pingfusi", "linux");
  ok(posixWhich.command === "sh" && posixWhich.args[1] === "command -v pingfusi", "posix PATH probe stays sh -c command -v");
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
  const motionPackage = path.join(home, "global-pingfusi", "packages", "motion");
  const playwrightCli = path.join(motionPackage, "node_modules", "playwright", "cli.js");
  fs.mkdirSync(path.dirname(playwrightCli), { recursive: true });
  fs.writeFileSync(playwrightCli, "// offline Playwright CLI fixture\n");
  const resolveMotionPackage = () => motionPackage;

  // ── fresh machine (true npx first-run), user consents to everything ──────────
  // `which pingfusi` resolves to npx's EPHEMERAL bin — that must NOT count as installed
  // (found live: the bare probe said "already installed" during the npx run itself)
  {
    const { io, logs, runs } = fakeIO({ probes: { brew: true }, answers: ["", "", ""], paths: { pingfusi: "/Users/x/.npm/_npx/abc123/node_modules/.bin/pingfusi" } });
    let browserChecks = 0;
    const installsCleanly = () => ++browserChecks === 1 ? motionMissing() : motionReady();
    const r = await setup(io, { home, sourceCheckout: false, resolveToken: () => null, dittoApiKey: false, probeMotionBrowser: installsCleanly, resolveGlobalMotionPackageDir: resolveMotionPackage });
    ok(r.ok, "fresh-machine run completes");
    ok(runs.includes("npm i -g pingfusi"), "npx's ephemeral bin doesn't count as installed — global install prompt fires and runs on consent");
    ok(!runs.includes("brew install cloudflared"), "cloudflared is NOT installed by setup (the default flow is tunnel-free)");
    ok(logs.some((l) => /cloudflared not installed — fine/.test(l)), "absent cloudflared is reported as optional, not a warning");
    ok(runs.some((r2) => /playwright[\\/]cli\.js install chromium$/.test(r2)), "fresh setup installs the package-owned motion browser runtime on consent");
    ok(runs.some((r2) => /vendor[\\/]pingfusi-review\.mjs setup$/.test(r2)), "login step runs the VENDORED MCP installer (device flow + config patch), not npx cpyany");
    ok(logs.some((l) => /ditto \(optional fast builder\): connect its MCP/.test(l)), "ditto guidance is MCP/API-key based — never a binary probe (macOS ships /usr/bin/ditto, a guaranteed false positive)");
    ok(logs.some((l) => /taught your AI agent \(claude-code\): .*pixel-perfect-clone/.test(l)), "installs the agent skills into the detected coding-agent client");
    ok(fs.existsSync(path.join(home, ".claude", "skills", "pixel-perfect-clone", "SKILL.md")), "skills really land in the fake HOME");
    ok(logs.some((l) => /Clone https:\/\/example\.com pixel-perfect/.test(l))
      && logs.some((l) => /Fix it with pingfusi/.test(l))
      && logs.some((l) => /Beautify this page\. Use pingfusi/.test(l))
      && logs.some((l) => /Review this video with pingfusi/.test(l))
      && logs.some((l) => /Which headline is clearer\? Ask a human/.test(l))
      && logs.some((l) => /Review this build with pingfusi/.test(l)),
      "summary teaches universal routing plus all four specialized agent prompts");
  }

  // spawnSync can fail without a numeric status; never report that as installed.
  {
    const fake = fakeIO({ probes: { cloudflared: true }, answers: [""], paths: { pingfusi: "/usr/local/bin/pingfusi" } });
    fake.io.run = (cmd, args) => {
      fake.runs.push([cmd, ...args].join(" "));
      return { status: null, error: new Error("spawn failed") };
    };
    const r = await setup(fake.io, { home, sourceCheckout: false, resolveToken: () => "tok", dittoApiKey: false, probeMotionBrowser: motionMissing, resolveGlobalMotionPackageDir: resolveMotionPackage });
    ok(!r.ok && r.steps.includes("motion-browser-failed") && !fake.logs.some((l) => /installed motion browser runtime/.test(l)), "null-status/error browser installer cannot become a false success");
  }

  // A successful download is still incomplete when the real recording probe fails.
  {
    const fake = fakeIO({ probes: { cloudflared: true }, answers: [""], paths: { pingfusi: "/usr/local/bin/pingfusi" } });
    const r = await setup(fake.io, { home, sourceCheckout: false, resolveToken: () => "tok", dittoApiKey: false, probeMotionBrowser: motionMissing, resolveGlobalMotionPackageDir: resolveMotionPackage });
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
    ok(r.ok && !runs.some((r2) => /^npm /.test(r2)) && logs.some((l) => /already installed globally/.test(l)), "a persistent global bin counts as installed (no prompt)");
    ok(logs.some((l) => /DITTO_API_KEY found/.test(l)), "a configured ditto API key is reported");
    // The agent RULES text ships inside the vendored installer and moves with the
    // package, and the installer is the only thing that rewrites it. This branch used
    // to run nothing at all, so a logged-in machine kept the rules of whatever version
    // first installed them — found live, months of re-runs on guidance naming tools the
    // service no longer registers.
    ok(runs.length === 1 && /vendor[\\/]pingfusi-review\.mjs rules$/.test(runs[0]) && r.steps.includes("rules-refreshed"),
      "an already-logged-in re-run still refreshes the installed agent rules");
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
    ok(!runs.some((r2) => /pingfusi-review\.mjs rules$/.test(r2)), "an explicit client does NOT also spawn the rules refresh — that installer run already rewrote them");
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
      resolveGlobalMotionPackageDir: resolveMotionPackage,
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
    ok(r.ok && runs.length === 1 && /pingfusi-review\.mjs rules$/.test(runs[0]), "idempotent re-run: probes pass, nothing installs (the rules self-heal is the only thing that runs)");
    ok(logs.some((l) => /source checkout/.test(l)) && logs.some((l) => /login found/.test(l)), "re-run reports present state (checkout copy, login)");
    ok(r.steps.includes("skills-present"), "already-installed skills are kept, not overwritten");
  }

  // ── external-wrapper drive (opts.wrapper): the thin-brand pass-through ──────
  // A wrapper package (e.g. qaping) rides the whole setup with its own brand,
  // installer flags, skill root, and always-loaded rule; absent wrapper options
  // are pinned byte-identical by every stock assertion above ($-anchored run
  // regexes prove no flags leak into default invocations).
  {
    const wrapHome = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-setup-wrap-"));
    const skillRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-wrap-skills-"));
    fs.mkdirSync(path.join(skillRoot, "qaping"), { recursive: true });
    fs.writeFileSync(path.join(skillRoot, "qaping", "SKILL.md"), "---\nname: qaping\n---\nQA loop guidance\n");
    const wrapper = {
      brand: "qaping",
      appUrl: "https://qaping.example",
      mcpPath: "/api/mcp/qaping",
      serverKey: "qaping",
      skipInstructionSurfaces: true,
      skillRoot,
      ruleAsset: { fileBaseName: "qaping", body: "Run QA through the wrapper's MCP tools.\n" },
    };
    // The kit-only steps (cloudflared, the motion runtime, ditto) serve the
    // clone/review pipeline only — a wrapper brand must skip them entirely,
    // so a counting probe pins that motion is never even consulted.
    let motionProbes = 0;
    const motionCounted = () => { motionProbes++; return motionReady(); };
    const { io, logs, runs } = fakeIO({ probes: { cloudflared: true }, answers: [], paths: { qaping: "/usr/local/bin/qaping" } });
    const r = await setup(io, { home: wrapHome, sourceCheckout: false, resolveToken: () => "tok", dittoApiKey: true, mcpClient: "claude-code", probeMotionBrowser: motionCounted, wrapper });
    ok(r.ok && logs[0] === "qaping setup\n─────────────────────────" && logs.some((l) => /qaping already installed globally/.test(l)),
      "wrapper drive: the header and global-install step speak the wrapper's own brand/bin");
    ok(r.steps.includes("kit-steps-skipped") && motionProbes === 0
      && !logs.some((l) => /cloudflared|motion|ditto|DITTO/i.test(l))
      && r.steps.every((s) => !/^(cloudflared|motion-browser|ditto)/.test(s)),
      "wrapper drive: the kit-only steps (cloudflared, motion runtime, ditto) are skipped — never probed, never prompted, never logged");
    ok(runs.some((r2) => /pingfusi-review\.mjs setup --client claude-code --app-url https:\/\/qaping\.example --mcp-path \/api\/mcp\/qaping --server-key qaping --skip-instruction-surfaces$/.test(r2)),
      "wrapper drive: appUrl/mcpPath/serverKey/skipInstructionSurfaces all ride the vendored installer's flags");
    ok(fs.existsSync(path.join(wrapHome, ".claude", "skills", "qaping", "SKILL.md"))
      && !fs.existsSync(path.join(wrapHome, ".claude", "skills", "pixel-perfect-clone")),
      "wrapper drive: skills install from the wrapper's own skillRoot — none of the kit's");
    ok(fs.readFileSync(path.join(wrapHome, ".claude", "rules", "qaping.md"), "utf8") === wrapper.ruleAsset.body,
      "wrapper drive: the always-loaded rule lands under the wrapper's name (plain md for Claude Code)");
    ok(!logs.some((l) => /Clone https:\/\/example\.com pixel-perfect/.test(l)) && logs.some((l) => /qaping guidance/.test(l)),
      "wrapper drive: the pingfusi handoff prompts are replaced by a brand-neutral close");
    // already-logged-in re-run without a client: a wrapper CANNOT stop at the
    // `rules` refresh — under --skip-instruction-surfaces that writes no MCP
    // config, so an existing (shared) pingfusi login made a bare wrapper setup
    // a silent no-op (found by adversarial review). The existing-login path
    // must run the vendored `setup` (stored-credential reuse, no re-auth) so
    // the wrapper's own MCP entry still lands.
    const again = fakeIO({ probes: {}, answers: [], paths: { qaping: "/usr/local/bin/qaping" } });
    const rAgain = await setup(again.io, { home: wrapHome, sourceCheckout: false, resolveToken: () => "tok", dittoApiKey: false, probeMotionBrowser: motionCounted, wrapper });
    ok(again.runs.some((r2) => /pingfusi-review\.mjs setup --app-url https:\/\/qaping\.example --mcp-path \/api\/mcp\/qaping --server-key qaping --skip-instruction-surfaces$/.test(r2))
      && !again.runs.some((r2) => /pingfusi-review\.mjs rules/.test(r2)),
      "wrapper drive: the logged-in no-client re-run still runs the vendored `setup` with the wrapper flags (never a bare rules no-op)");
    ok(rAgain.steps.includes("login-present") && rAgain.steps.includes("login-mcp-configured"),
      "wrapper drive: the existing-login MCP config write is recorded as its own step");
    ok(again.logs.some((l) => /^✓ login found/.test(l)) && !again.logs.some((l) => /review login found/.test(l)),
      "wrapper drive: the login-found line stays brand-neutral (no pingfusi review prose)");

    // failing installer, wrapper drive: for a wrapper the MCP entry IS the
    // product, so a vendored-installer failure must fail the whole setup loudly
    // (found by the qaping verifier: a dead service printed the success epilogue
    // and exited 0 over a machine with no MCP config). Stock setup keeps its
    // lenient contract — step 5 has always been skippable there.
    const failing = fakeIO({ probes: {}, answers: [], paths: { qaping: "/usr/local/bin/qaping" } });
    failing.io.run = (cmd, args) => {
      failing.runs.push([cmd, ...args].join(" "));
      return /pingfusi-review\.mjs/.test(args.join(" ")) ? { status: 1 } : { status: 0 };
    };
    const rFail = await setup(failing.io, { home: wrapHome, sourceCheckout: false, resolveToken: () => "tok", dittoApiKey: false, probeMotionBrowser: motionCounted, wrapper });
    ok(!rFail.ok && rFail.steps.includes("login-install-failed")
      && failing.logs.some((l) => /^✗ qaping MCP install failed — the qaping MCP entry was not written\. Re-run: npx qaping setup$/.test(l)),
      "wrapper drive: a failing vendored installer fails setup (ok:false, login-install-failed, loud error) instead of a success epilogue");
    const stockFail = fakeIO({ probes: { cloudflared: true }, answers: [], paths: { pingfusi: "/usr/local/bin/pingfusi" } });
    stockFail.io.run = (cmd, args) => {
      stockFail.runs.push([cmd, ...args].join(" "));
      return { status: 1 };
    };
    const stockHome = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-setup-stockfail-"));
    const rStock = await setup(stockFail.io, { home: stockHome, sourceCheckout: false, resolveToken: () => "tok", mcpClient: "claude-code", probeMotionBrowser: motionReady });
    ok(rStock.ok && !rStock.steps.includes("login-install-failed"),
      "stock drive: a failing installer run keeps the lenient stock contract (ok:true, no wrapper failure step) — behavior unchanged");

    // logged-out wrapper drive: the login prompt + skip warning speak the
    // wrapper's brand, never the pingfusi review-round prose
    const asked = [];
    const loggedOut = fakeIO({ probes: {}, answers: [], paths: { qaping: "/usr/local/bin/qaping" } });
    const askCapture = loggedOut.io.ask;
    loggedOut.io.ask = (q) => { asked.push(q); return askCapture(q); }; // answers [] → "" but tty:true… force decline below
    loggedOut.io.isTTY = false; // non-TTY: "" is never consent, so the skip branch runs
    await setup(loggedOut.io, { home: wrapHome, sourceCheckout: false, resolveToken: () => null, dittoApiKey: false, probeMotionBrowser: motionCounted, wrapper });
    ok(asked.some((q) => q.startsWith("qaping login + MCP install")) && !asked.some((q) => /review/.test(q)),
      "wrapper drive: the login prompt says `qaping login + MCP install`, not the review-round prose");
    ok(loggedOut.logs.some((l) => /qaping rounds will NOT work without a login/.test(l) && /Log in later: qaping setup/.test(l))
      && !loggedOut.logs.some((l) => /review rounds will NOT work/.test(l)),
      "wrapper drive: the skipped-login warning speaks the wrapper's brand");

    // the upgrade path a wrapper's users actually hit: the package ships a NEW SKILL.md
    // while the machine still carries the one its first setup wrote. Without provenance
    // that stale file survived every re-run and the new guidance reached fresh installs
    // only (QAPING_PLAN.md §8) — with it, a plain `qaping setup` takes ours, and only a
    // file we have never shipped is held back (loudly, naming the override).
    {
      const SHIPPED_OLD = fs.readFileSync(path.join(skillRoot, "qaping", "SKILL.md"), "utf8");
      const SHIPPED_NEW = SHIPPED_OLD + "\nthe next version's doctrine\n";
      fs.writeFileSync(path.join(skillRoot, "qaping", "SKILL.md"), SHIPPED_NEW);
      fs.writeFileSync(path.join(skillRoot, MANIFEST_BASENAME),
        JSON.stringify({ skills: { qaping: [hashSkill(SHIPPED_OLD), hashSkill(SHIPPED_NEW)] } }));
      const dest = path.join(wrapHome, ".claude", "skills", "qaping", "SKILL.md"); // holds SHIPPED_OLD

      const up = fakeIO({ probes: {}, answers: [], paths: { qaping: "/usr/local/bin/qaping" } });
      await setup(up.io, { home: wrapHome, sourceCheckout: false, resolveToken: () => "tok", dittoApiKey: false, probeMotionBrowser: motionCounted, wrapper });
      ok(fs.readFileSync(dest, "utf8") === SHIPPED_NEW && !up.logs.some((l) => /kept your locally-edited/.test(l)),
        "wrapper drive: a plain re-run upgrades a skill this package shipped before — no --force, no warning");

      fs.writeFileSync(dest, SHIPPED_OLD + "\nthe user's own note\n");
      const kept = fakeIO({ probes: {}, answers: [], paths: { qaping: "/usr/local/bin/qaping" } });
      const rKept = await setup(kept.io, { home: wrapHome, sourceCheckout: false, resolveToken: () => "tok", dittoApiKey: false, probeMotionBrowser: motionCounted, wrapper });
      ok(rKept.steps.includes("skills-preserved")
        && fs.readFileSync(dest, "utf8").includes("the user's own note")
        && kept.logs.some((l) => /kept your locally-edited skill\(s\): claude-code:qaping/.test(l) && /qaping setup --force/.test(l)),
        "wrapper drive: an unrecognized skill is kept, and setup says so in the wrapper's brand with the exact override command");
    }

    // cursor rule flavor + scoped wrapper removal (direct agent-setup drive)
    const as = require("./agent-setup.js");
    const r2 = as.install(wrapHome, true, "cursor", { skillRoot, ruleAsset: wrapper.ruleAsset });
    const mdc = fs.readFileSync(path.join(wrapHome, ".cursor", "rules", "qaping.mdc"), "utf8");
    ok(r2.ok && mdc === "---\nalwaysApply: true\n---\n\n" + wrapper.ruleAsset.body,
      "wrapper rule for Cursor gets the alwaysApply frontmatter (mirrors the vendored rulePath/ruleContent)");
    const removed = as.removeSkills(wrapHome, "cursor", { skillRoot, ruleAsset: { fileBaseName: "qaping" } });
    ok(removed.includes("qaping")
      && !fs.existsSync(path.join(wrapHome, ".cursor", "skills", "qaping"))
      && !fs.existsSync(path.join(wrapHome, ".cursor", "rules", "qaping.mdc"))
      && fs.existsSync(path.join(wrapHome, ".claude", "skills", "qaping", "SKILL.md")),
      "wrapper removeSkills sweeps its own skillRoot + rule in client scope, nothing else");
    fs.rmSync(wrapHome, { recursive: true, force: true });
    fs.rmSync(skillRoot, { recursive: true, force: true });
  }

  // ── exact dependency-supported Node boundaries ───────────────────────────────
  ok(!supportsNode("20.16.9") && supportsNode("20.17.0") && !supportsNode("21.9.0")
    && !supportsNode("22.12.9") && supportsNode("22.13.0")
    && !supportsNode("23.4.9") && supportsNode("23.5.0") && supportsNode("24.0.0"), "setup shares the exact Node floor required by its direct dependencies");

  console.log(failed ? `\n❌ setup-selftest: ${failed} assertion(s) failed.` : "\n✓ setup-selftest: all assertions pass.");
  process.exit(failed ? 1 : 0);
})();
