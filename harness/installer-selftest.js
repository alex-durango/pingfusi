// harness/installer-selftest.js — the gate on vendor/pingfusi-review.mjs now that it is SOURCE.
//
// The installer used to be a GENERATED brand fork of the service repo's cli/index.mjs, and
// scripts/fork-vendor-selftest.js was its gate: it regenerated the file and demanded a byte
// match, which caught both an unported backend change and any hand-edit. That backend source
// is gone (the monorepo made the two trees one, then the service-side cli/ was deleted), so the
// pipeline and its gate went with it — and with them, quietly, three invariants they had been
// holding as side effects of regeneration. This file keeps them:
//
//   1. it parses. The old pipeline ran `node --check` on every write. Nothing else does: the
//      installer is spawned as a CHILD PROCESS (harness/setup.js) or dynamically imported by
//      bin/pingfusi, so a syntax error surfaces as a failed user install, never as a red test.
//      (regression.js's syntax sweep walks tools/harness/packages — not vendor/.)
//   2. VERSION tracks the kit. As a fork it kept an independent lineage (0.3.x while the kit
//      was 0.13.x) because it shipped from a different source; one repo, one version now, and
//      `pingfusi --version` vs the installer's own banner should not disagree.
//   3. SKILL_BODY still equals skill/pingfusi-review/SKILL.md. The installer writes that skill
//      into the user's agent from a template literal baked into itself, so the Markdown a human
//      edits and the payload a user receives are two copies of one text. The pipeline compared
//      them on every regeneration (via scripts/fork-overrides/skill-body.txt); with the payload
//      hand-maintained the drift is now a one-line edit away and completely silent — the user's
//      installed skill just stops matching the repo's.
//
// Plus the two shipped-surface checks harness/leak-guard-selftest.js already makes on this file.
// Cheap, and they belong to both stories: leak-guard asks "does the public tree stay de-branded",
// this asks "is the installer intact". A hand-edited banner should fail whichever one you run.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, execFileSync, spawnSync } = require("child_process");

const KIT = path.resolve(__dirname, "..");
const INSTALLER = path.join(KIT, "vendor", "pingfusi-review.mjs");
const SKILL = path.join(KIT, "skill", "pingfusi-review", "SKILL.md");

let failed = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failed++; console.log(`  ✗ ${msg}`); if (detail) console.log(detail.replace(/^/gm, "      ")); }
};

console.log("installer-selftest — vendor/pingfusi-review.mjs is intact, hand-maintained source");

const src = fs.readFileSync(INSTALLER, "utf8");

// ── 1. it parses ──────────────────────────────────────────────────────────────
let parseErr = "";
try { execFileSync("node", ["--check", INSTALLER], { stdio: "pipe" }); }
catch (e) { parseErr = ((e.stdout || "") + (e.stderr || "")).toString().trim(); }
ok(!parseErr, "vendor/pingfusi-review.mjs parses (node --check)", parseErr);

// ── 2. VERSION tracks the kit's package.json ──────────────────────────────────
const pkgVersion = JSON.parse(fs.readFileSync(path.join(KIT, "package.json"), "utf8")).version;
const m = src.match(/^const VERSION = "([^"]+)";$/m);
ok(Boolean(m), "installer declares a VERSION const");
if (m) {
  ok(
    m[1] === pkgVersion,
    `installer VERSION (${m[1]}) matches package.json (${pkgVersion})`,
    `The installer no longer has its own lineage — one repo, one version.\nBump \`const VERSION\` in vendor/pingfusi-review.mjs to "${pkgVersion}".`
  );
}

// ── 3. SKILL_BODY payload === the shipped SKILL.md ────────────────────────────
// SKILL.md is authored as plain Markdown; the installer carries it inside a JavaScript
// template literal. Escape only the template-literal syntax, so evaluating the installer
// reconstructs the Markdown byte-for-byte. (Ported from the deleted scripts/fork-vendor.js,
// which is the only reason the two ever agreed.)
function templateLiteralPayload(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

// Scan for the literal's closing backtick the same way the generator did: skip \-escaped
// pairs, so an escaped backtick inside the payload does not end it early.
function extractTemplate(text, name) {
  const marker = `const ${name} = \``;
  const start = text.indexOf(marker);
  if (start < 0) return null;
  let i = start + marker.length;
  while (i < text.length) {
    if (text[i] === "\\") { i += 2; continue; }
    if (text[i] === "`") return text.slice(start + marker.length, i);
    i++;
  }
  return null;
}

const payload = extractTemplate(src, "SKILL_BODY");
ok(payload !== null, "installer carries a SKILL_BODY template literal");
if (payload !== null) {
  const expected = templateLiteralPayload(fs.readFileSync(SKILL, "utf8"));
  let detail = "";
  if (payload !== expected) {
    const a = payload.split("\n"), b = expected.split("\n");
    let d = 0;
    while (d < Math.min(a.length, b.length) && a[d] === b[d]) d++;
    detail =
      `skill/pingfusi-review/SKILL.md is the human-readable SOURCE of this text; the SKILL_BODY\n` +
      `payload in vendor/pingfusi-review.mjs is the copy the installer writes into the user's\n` +
      `agent. Edit SKILL.md, then mirror it into the payload (escape \\ \` and \${ ).\n` +
      `First difference at payload line ${d + 1} (of ${a.length}; SKILL.md has ${b.length}):\n` +
      `  installer: ${JSON.stringify((a[d] ?? "<EOF>").slice(0, 100))}\n` +
      `  SKILL.md:  ${JSON.stringify((b[d] ?? "<EOF>").slice(0, 100))}`;
  }
  ok(payload === expected, "SKILL_BODY payload byte-equals skill/pingfusi-review/SKILL.md", detail);
}

// ── 4. banner invariants (mirrors harness/leak-guard-selftest.js — cheap, keep both) ──
ok(/install the pingfusi review MCP server/.test(src), "banner says 'install the pingfusi review MCP server'");
ok(!/PingHumans/.test(src), "no standalone 'PingHumans' branding in the installer");

// ── 5. brand-wrapper parameterization (--app-url / --mcp-path / --server-key /
// --skip-instruction-surfaces) — inert by default, threaded when asked ──────────
//
// Static pins first: every config-writing site goes through the parameterized
// pair, and the defaults are the stock values.
ok(src.includes('?? "/api/mcp"') && src.includes('?? "pingfusi"') && src.includes('?? "cpyany_wait"'),
  "MCP_PATH / SERVER_KEY / WAIT_TOOL default to the stock /api/mcp + pingfusi + cpyany_wait");
const writeSites = (src.match(/\$\{APP_URL\}\$\{MCP_PATH\}/g) || []).length;
ok(writeSites === 5, `all 5 wire URL sites thread \${APP_URL}\${MCP_PATH} — 4 config writes + the wait call (found ${writeSites})`);
const stockUrlSites = (src.match(/\$\{APP_URL\}\/api\/mcp`/g) || []).length;
ok(stockUrlSites === 0,
  `no hardcoded /api/mcp wire call remains — \`wait\` rides MCP_PATH + WAIT_TOOL; both flavors are pinned behaviorally below (found ${stockUrlSites})`);
ok((src.match(/config\.mcpServers\[SERVER_KEY\]/g) || []).length === 2
  && src.includes("[mcp_servers.${SERVER_KEY}]")
  && /"http",\s*\n\s*SERVER_KEY,/.test(src),
  "all 4 server-key sites write the parameterized key (desktop, cursor, codex, claude mcp add)");

// Behavioral: a foreign-brand invocation sweeps only its own key and never
// touches pingfusi's entries, instruction surfaces, or the shared login stash.
// PATH is restricted so client detection finds only the fixture's ~/.cursor —
// never the host's claude/codex CLIs.
const runSync = (args, home, extraEnv = {}) =>
  spawnSync(process.execPath, [INSTALLER, ...args], {
    encoding: "utf8",
    env: { HOME: home, USERPROFILE: home, PATH: "/usr/bin:/bin", DO_NOT_TRACK: "1", ...extraEnv },
  });
const writeFixtureHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-installer-"));
  fs.mkdirSync(path.join(home, ".cursor", "rules"), { recursive: true });
  fs.mkdirSync(path.join(home, ".cursor", "skills", "pingfusi-review"), { recursive: true });
  fs.mkdirSync(path.join(home, ".config", "pingfusi"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "pingfusi", "credentials.json"), JSON.stringify({ token: "tok_fixture" }));
  fs.writeFileSync(path.join(home, ".cursor", "rules", "pingfusi.mdc"), "rule fixture\n");
  fs.writeFileSync(path.join(home, ".cursor", "skills", "pingfusi-review", "SKILL.md"), "skill fixture\n");
  fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify({
    mcpServers: {
      pingfusi: { url: "https://pingfusi.com/api/mcp", headers: { Authorization: "Bearer t1" } },
      cpyany: { url: "https://pingfusi.com/api/mcp", headers: { Authorization: "Bearer t0" } },
      qaping: { url: "https://pingfusi.com/api/mcp/qaping", headers: { Authorization: "Bearer t1" } },
    },
  }, null, 2) + "\n");
  return home;
};
{
  const home = writeFixtureHome();
  const readCfg = () => JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"));
  // full foreign-brand remove: only its key goes; surfaces + shared login stay
  const r1 = runSync(["remove", "--server-key", "qaping", "--skip-instruction-surfaces"], home);
  const cfg1 = readCfg();
  ok(r1.status === 0 && !cfg1.mcpServers.qaping && !!cfg1.mcpServers.pingfusi && !!cfg1.mcpServers.cpyany,
    "foreign-brand remove sweeps ONLY its own server key (pingfusi + legacy entries untouched)");
  ok(r1.stdout.includes("✓ Removed qaping from Cursor config.")
    && !r1.stdout.includes("Removed pingfusi"),
    "…and its per-client line names the swept server key, never the pingfusi brand", r1.stdout);
  ok(fs.existsSync(path.join(home, ".cursor", "rules", "pingfusi.mdc"))
    && fs.existsSync(path.join(home, ".cursor", "skills", "pingfusi-review", "SKILL.md")),
    "…and --skip-instruction-surfaces keeps pingfusi's rule + skill files in place");
  ok(fs.existsSync(path.join(home, ".config", "pingfusi", "credentials.json")),
    "…and a foreign-brand full remove never deletes the machine's shared login stash");
  // stock remove afterwards behaves exactly as before the knobs existed
  const r2 = runSync(["remove"], home);
  const cfg2 = readCfg();
  ok(r2.status === 0 && !cfg2.mcpServers.pingfusi && !cfg2.mcpServers.cpyany,
    "stock remove still sweeps pingfusi + every legacy generation");
  ok(r2.stdout.includes("✓ Removed pingfusi from Cursor config."),
    "…and the stock per-client line keeps its exact pingfusi bytes", r2.stdout);
  ok(!fs.existsSync(path.join(home, ".cursor", "rules", "pingfusi.mdc"))
    && !fs.existsSync(path.join(home, ".cursor", "skills", "pingfusi-review"))
    && !fs.existsSync(path.join(home, ".config", "pingfusi", "credentials.json")),
    "…and still removes its own instruction surfaces and signs the machine out");
  fs.rmSync(home, { recursive: true, force: true });
}
{
  // env-var flavor: PINGFUSI_MCP_SERVER_KEY drives the same sweep as --server-key
  const home = writeFixtureHome();
  const r = runSync(["remove", "--client", "cursor"], home, { PINGFUSI_MCP_SERVER_KEY: "qaping", PINGFUSI_SKIP_INSTRUCTION_SURFACES: "1" });
  const cfg = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"));
  ok(r.status === 0 && !cfg.mcpServers.qaping && !!cfg.mcpServers.pingfusi
    && fs.existsSync(path.join(home, ".cursor", "rules", "pingfusi.mdc")),
    "PINGFUSI_MCP_SERVER_KEY / PINGFUSI_SKIP_INSTRUCTION_SURFACES env vars drive the same behavior as the flags");
  fs.rmSync(home, { recursive: true, force: true });
}
{
  // codex TOML: a foreign-brand remove drops only its own table
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-installer-codex-"));
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const toml = `[other]\nkey = "hand-authored"\n\n[mcp_servers.pingfusi]\nurl = "https://pingfusi.com/api/mcp"\n\n[mcp_servers.qaping]\nurl = "https://pingfusi.com/api/mcp/qaping"\n`;
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), toml);
  const r = runSync(["remove", "--client", "codex", "--server-key", "qaping", "--skip-instruction-surfaces"], home);
  const next = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
  ok(r.status === 0 && !next.includes("[mcp_servers.qaping]")
    && next.includes("[mcp_servers.pingfusi]") && next.includes('key = "hand-authored"'),
    "codex foreign-brand remove strips only its own TOML table (pingfusi + hand-authored tables survive)");
  fs.rmSync(home, { recursive: true, force: true });
}
{
  // CLI hint prose derives its brand from the server key: `qaping whoami`
  // (the wrapper spawns the vendored installer for wait/whoami) must never
  // tell the customer to run a pingfusi command, and the stock hints keep
  // their exact bytes.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-installer-whoami-"));
  const rQaping = runSync(["whoami", "--server-key", "qaping", "--skip-instruction-surfaces"], home);
  ok(rQaping.status === 0 && rQaping.stdout.includes("npx qaping setup")
    && !rQaping.stdout.includes("npx pingfusi setup"),
    "foreign-brand whoami hint says `npx qaping setup`, never the pingfusi command", rQaping.stdout);
  const rStock = runSync(["whoami"], home);
  ok(rStock.status === 0 && rStock.stdout.includes("Run `npx pingfusi setup` to authenticate."),
    "stock whoami hint keeps its exact pingfusi bytes", rStock.stdout);
  fs.rmSync(home, { recursive: true, force: true });
}
{
  // `rules` refresh honors the skip flag: stale pingfusi surfaces stay untouched
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-installer-rules-"));
  const rp = path.join(home, ".claude", "rules", "pingfusi.md");
  const sp = path.join(home, ".claude", "skills", "pingfusi-review", "SKILL.md");
  fs.mkdirSync(path.dirname(rp), { recursive: true });
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(rp, "stale rule\n");
  fs.writeFileSync(sp, "stale skill\n");
  const r1 = runSync(["rules", "--skip-instruction-surfaces"], home);
  ok(r1.status === 0 && fs.readFileSync(rp, "utf8") === "stale rule\n" && fs.readFileSync(sp, "utf8") === "stale skill\n"
    && !fs.existsSync(`${rp}.bak`),
    "`rules --skip-instruction-surfaces` leaves stale pingfusi surfaces byte-untouched (no refresh, no backup)");
  const r2 = runSync(["rules"], home);
  ok(r2.status === 0 && fs.readFileSync(rp, "utf8").includes("Use Pingfusi whenever")
    && fs.readFileSync(sp, "utf8") === fs.readFileSync(SKILL, "utf8")
    && fs.existsSync(`${rp}.bak`),
    "a stock `rules` run still refreshes both surfaces (with the replaced-text backup)");
  fs.rmSync(home, { recursive: true, force: true });
}

// ── 6. setup writes the parameterized config (and the stock one, byte-pinned) ──
// A local HTTP loopback stands in for the service: the stored token passes the
// whoami reuse check, so setup patches configs without a device flow. Async so
// the loopback can answer while the child runs.
(async () => {
  const http = require("http");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ email: "selftest@example.com" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const runAsync = (args, home, extraEnv = {}) => new Promise((resolve) => {
    execFile(process.execPath, [INSTALLER, ...args], {
      env: { HOME: home, USERPROFILE: home, PATH: "/usr/bin:/bin", DO_NOT_TRACK: "1", ...extraEnv },
    }, (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
  const makeHome = (token) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-installer-setup-"));
    fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
    fs.mkdirSync(path.join(home, ".config", "pingfusi"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "pingfusi", "credentials.json"), JSON.stringify({ token }));
    return home;
  };

  {
    const home = makeHome("tok_param");
    const r = await runAsync(
      ["setup", "--client", "cursor", "--app-url", base, "--mcp-path", "/api/mcp/qaping", "--server-key", "qaping", "--skip-instruction-surfaces"],
      home
    );
    const cfg = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"));
    ok(r.status === 0 && JSON.stringify(cfg) === JSON.stringify({
      mcpServers: { qaping: { url: `${base}/api/mcp/qaping`, headers: { Authorization: "Bearer tok_param" } } },
    }), "parameterized setup writes exactly the qaping server key on the /api/mcp/qaping mount", r.stderr);
    ok(!fs.existsSync(path.join(home, ".cursor", "rules", "pingfusi.mdc"))
      && !fs.existsSync(path.join(home, ".cursor", "skills", "pingfusi-review")),
      "…and installs NO pingfusi rule/skill surfaces under --skip-instruction-surfaces");
    // Epilogue prose derives its brand from the server key: a qaping dev must
    // never read a pingfusi banner, the clone-pitch Try-it line, or a sign-out
    // hint naming a command (`pingfusi remove`) that isn't theirs — and a
    // wrapper's own remove does NOT sign out, so no hint prints at all.
    ok(r.stdout.includes("qaping setup complete") && !r.stdout.includes("pingfusi setup complete"),
      "foreign-brand setup epilogue says `qaping setup complete`, never pingfusi's", r.stdout);
    ok(!r.stdout.includes("copy the hero section") && !r.stdout.includes("Try it:"),
      "…and the pingfusi clone-pitch Try-it line does NOT print for a foreign brand", r.stdout);
    ok(r.stdout.includes("reusing this machine's login") && !r.stdout.includes("pingfusi remove"),
      "…and the login-reuse line drops the stock sign-out hint (a wrapper remove never signs out)", r.stdout);
    fs.rmSync(home, { recursive: true, force: true });
  }
  {
    const home = makeHome("tok_stock");
    const r = await runAsync(["setup", "--client", "cursor"], home, { PINGFUSI_APP_URL: base });
    const cfg = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"));
    ok(r.status === 0 && JSON.stringify(cfg) === JSON.stringify({
      mcpServers: { pingfusi: { url: `${base}/api/mcp`, headers: { Authorization: "Bearer tok_stock" } } },
    }), "stock setup still writes exactly the pingfusi key on /api/mcp (the knobs are inert by default)", r.stderr);
    const rule = fs.readFileSync(path.join(home, ".cursor", "rules", "pingfusi.mdc"), "utf8");
    ok(rule.startsWith("---\nalwaysApply: true\n---\n\n") && rule.includes("Use Pingfusi whenever")
      && fs.readFileSync(path.join(home, ".cursor", "skills", "pingfusi-review", "SKILL.md"), "utf8") === fs.readFileSync(SKILL, "utf8"),
      "…and still installs its own rule + skill surfaces");
    ok(r.stdout.includes("✔ pingfusi setup complete")
      && r.stdout.includes(`Try it: ask your agent to "use pingfusi to copy the hero section from a reference site."`)
      && r.stdout.includes("reusing this machine's login (`pingfusi remove` signs out)"),
      "stock setup epilogue keeps its exact bytes (banner, Try-it pitch, sign-out hint)", r.stdout);
    fs.rmSync(home, { recursive: true, force: true });
  }
  server.close();

  // ── 7. `wait` rides the brand mount + wait tool — BOTH flavors pinned ────────
  // A loopback MCP server records the path and tool name of each wait leg:
  // stock must stay byte-identical on the wire (/api/mcp + cpyany_wait), a
  // wrapper invocation must hit its own mount with the --wait-tool it names.
  {
    const seen = [];
    const waitSrv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        seen.push({ path: req.url, tool: JSON.parse(body).params.name });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          jsonrpc: "2.0", id: 1,
          result: {
            content: [{ type: "text", text: "review complete: 1/1 results" }],
            structuredContent: { status: "complete", n_received: 1, n_target: 1 },
          },
        }));
      });
    });
    await new Promise((resolve) => waitSrv.listen(0, "127.0.0.1", resolve));
    const wbase = `http://127.0.0.1:${waitSrv.address().port}`;
    const PING = "12345678-1234-4123-8123-1234567890ab";
    const home = makeHome("tok_wait");
    const r1 = await runAsync(["wait", PING], home, { PINGFUSI_APP_URL: wbase });
    ok(r1.status === 0 && seen.length === 1 && seen[0].path === "/api/mcp" && seen[0].tool === "cpyany_wait",
      "stock `wait` still POSTs /api/mcp with cpyany_wait (wire bytes unchanged)",
      `${r1.stderr}\nseen: ${JSON.stringify(seen)}`);
    const r2 = await runAsync(
      ["wait", PING, "--app-url", wbase, "--mcp-path", "/api/mcp/qaping", "--server-key", "qaping", "--skip-instruction-surfaces", "--wait-tool", "qaping_wait"],
      home
    );
    ok(r2.status === 0 && seen.length === 2 && seen[1].path === "/api/mcp/qaping" && seen[1].tool === "qaping_wait",
      "wrapper `wait` rides its own mount and wait tool (--mcp-path + --wait-tool)",
      `${r2.stderr}\nseen: ${JSON.stringify(seen)}`);
    waitSrv.close();
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ── 8. the dead-token nudge derives its brand from the server key ────────────
  // A 401 loopback makes validateStoredToken declare the stored token dead; the
  // stderr nudge must name the invoking brand's setup command, never pingfusi's
  // for a wrapper — and keep the exact stock bytes otherwise.
  {
    const deadSrv = http.createServer((req, res) => { res.statusCode = 401; res.end("{}"); });
    await new Promise((resolve) => deadSrv.listen(0, "127.0.0.1", resolve));
    const dbase = `http://127.0.0.1:${deadSrv.address().port}`;
    const homeQ = makeHome("tok_dead_q");
    const rQ = await runAsync(["rules", "--skip-instruction-surfaces", "--server-key", "qaping"], homeQ, { PINGFUSI_APP_URL: dbase });
    ok(rQ.status === 0 && rQ.stderr.includes("Your qaping token is no longer valid")
      && rQ.stderr.includes("npx qaping setup") && !rQ.stderr.includes("pingfusi"),
      "foreign-brand dead-token nudge says `npx qaping setup`, never the pingfusi command", rQ.stderr);
    const homeS = makeHome("tok_dead_s");
    const rS = await runAsync(["rules"], homeS, { PINGFUSI_APP_URL: dbase });
    ok(rS.status === 0 && rS.stderr.includes("⚠ Your pingfusi token is no longer valid")
      && rS.stderr.includes("Re-link this machine:  npx pingfusi setup"),
      "stock dead-token nudge keeps its exact pingfusi bytes", rS.stderr);
    deadSrv.close();
    fs.rmSync(homeQ, { recursive: true, force: true });
    fs.rmSync(homeS, { recursive: true, force: true });
  }

  console.log(failed ? `\n❌ installer-selftest: ${failed} assertion(s) failed.` : "\n✓ installer-selftest: all assertions pass.");
  process.exit(failed ? 1 : 0);
})();
