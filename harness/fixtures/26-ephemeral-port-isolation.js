// fixtures/26-ephemeral-port-isolation.js — the GATE ITSELF was flaky, and flaky in the
// direction that passes.
//
// Paid for on the 2026-07-13 gorjana run, at step 1 ("prove the framework"): `node
// harness/regression.js` printed "❌ 1 of 25 file(s) failed" (tools/cli-selftest.js) — and the
// same command, re-run seconds later, was green. Nothing had changed. The gate's verdict was a
// coin flip.
//
// Cause: cli-selftest hardcoded two ports — 17799 (sink) and 18094 (serve). A test that names a
// fixed port is not testing the tool; it is testing whether anything else on the machine happens
// to hold that port. Two cli-selftests running at once (regression in one shell + a selftest in
// another; a CI matrix; a stray dev sink) fight over the same socket. Measured A/B at 16
// concurrent runs, pre-fix: 5/16 FAILED, wall 40.1s. Post-fix: 0/16, wall 1.45s.
//
// And the failure mode was NOT merely noise. The curls printed `000` — no response — because a
// run's request was reaching ANOTHER run's sink, in another cwd. The sink writes files relative to
// its own cwd, so `ok(!fs.existsSync(dir/big.json))` ("the aborted body is never written to disk")
// was checking THIS run's empty tmpdir against THAT run's server. The safety assertion passed
// VACUOUSLY: it would have held even if the sink wrote the oversize body every time. A gate that
// depends on a global resource another process may hold does not merely flake — it can certify a
// contract it never tested.
//
// The fix: every server in the selftest binds an OS-assigned ephemeral port (:0) and REPORTS the
// port it actually bound; the test discovers that port instead of assuming one. Nothing is
// shared, so nothing can collide or impersonate.
//
// This fixture makes that flake DETERMINISTIC: it occupies the two historical ports with an
// impostor that answers 200 to everything, then demands the selftest still pass. Against the old
// code the impostor answers the readiness probe (so the poll thinks "the sink is up"), then
// answers 200 where a 413/409 was required — a hard, repeatable failure. Against the fixed code
// the ports are irrelevant.
"use strict";
const cp = require("child_process"), fs = require("fs"), os = require("os"), path = require("path");
let bad = 0; const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

const KIT = path.join(__dirname, "..", "..");
const SINK = path.join(KIT, "tools", "sink.js");
const SERVE = path.join(KIT, "harness", "serve.js");
const CLI_SELFTEST = path.join(KIT, "tools", "cli-selftest.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppk-fix26-"));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Poll a file the child writes once listening. A sync script's event loop never turns, so a
// child's stdout pipe is unreadable here — the filesystem is the only channel that works.
function awaitFile(file, what, re, ms = 10000) {
  for (let waited = 0; waited < ms; waited += 50) {
    if (fs.existsSync(file)) { const m = re.exec(fs.readFileSync(file, "utf8")); if (m) return m[1]; }
    sleep(50);
  }
  throw new Error(`${what} never reported within ${ms}ms`);
}

// An impostor that answers 200 to EVERY request — the nastiest squatter, because it satisfies a
// naive readiness probe and then lies to every assertion behind it.
//
// If the port is ALREADY held (another concurrent run of this very fixture, a stray server), the
// squatter child dies on EADDRINUSE — but the fixture's premise ("the port is occupied") is then
// already true, so treat any occupant as an acceptable squatter and carry on. Without this the
// fixture crashes whenever two regressions overlap: the exact flake class it exists to prevent.
function squat(port) {
  const ready = path.join(tmp, `squat-${port}.port`);
  const src = `const s = require('http').createServer((q, r) => { r.writeHead(200); r.end('impostor'); });
    s.on('error', () => process.exit(1));
    s.listen(${port}, () => require('fs').writeFileSync(process.argv[1], String(s.address().port)));
    setTimeout(() => {}, 60000);`;
  const child = cp.spawn(process.execPath, ["-e", src, ready], { stdio: "ignore" });
  for (let waited = 0; waited < 10000; waited += 50) {
    if (fs.existsSync(ready)) { const m = /(\d+)/.exec(fs.readFileSync(ready, "utf8")); if (m) return { child, port: +m[1] }; }
    // No child-death detection is possible here: this sync script's event loop never turns, so
    // the child's 'exit' event is never processed and child.exitCode stays null forever. The one
    // signal that needs no event loop is the PORT itself — if anything answers there, the premise
    // ("the port is occupied") holds, whether the occupant is our squatter or a concurrent run's.
    // React to that immediately; waiting out the window is how the occupant that beat us is gone
    // again before we look for it. (:0 has no knowable port to probe — the file is its only signal.)
    if (port !== 0) {
      const probe = cp.spawnSync("curl", ["-s", "-o", "/dev/null", "--max-time", "1", `http://127.0.0.1:${port}/`], {});
      if (probe.status === 0 || probe.status === 52 || probe.status === 28) return { child, port }; // answered / empty reply / accepted-then-hung: all prove an occupant
    }
    sleep(50);
  }
  child.kill();
  throw new Error(`the squatter on :${port} neither bound nor found an existing occupant within 10s`);
}

// ── 1. THE FLAKE, MADE DETERMINISTIC ────────────────────────────────────────────────────
// The two ports cli-selftest used to hardcode. With them occupied, the OLD selftest fails hard;
// the fixed one never looks at them.
{
  const squatters = [17799, 18094].map(squat);
  try {
    const r = cp.spawnSync(process.execPath, [CLI_SELFTEST], { encoding: "utf8", timeout: 120000 });
    check("cli-selftest passes with its HISTORICAL fixed ports (17799 sink, 18094 serve) both occupied", r.status === 0);
    if (r.status !== 0) process.stdout.write(((r.stdout || "") + (r.stderr || "")).split("\n").filter((l) => /✗|❌/.test(l)).map((l) => `    ${l}\n`).join(""));
  } finally { squatters.forEach((s) => s.child.kill()); }
}

// ── 2. THE CONTRACT THAT MAKES IT POSSIBLE — a server must report the port it BOUND ─────
// PPK_SINK_PORT=0 asks the OS for a free port. A banner echoing the REQUESTED port prints
// "localhost:0", and an ephemeral port nobody can discover is an ephemeral port nobody can use.
{
  const log = path.join(tmp, "sink0.log");
  const fd = fs.openSync(log, "a");
  const sink = cp.spawn(process.execPath, [SINK], { cwd: tmp, env: { ...process.env, PPK_SINK_PORT: "0" }, stdio: ["ignore", fd, fd] });
  try {
    const port = +awaitFile(log, "the sink on :0", /localhost:(\d+)/);
    check(`sink on :0 reports the port it actually BOUND, not the 0 it was asked for (got ${port})`, port > 0);
    const ping = cp.spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "OPTIONS", `http://127.0.0.1:${port}/ping`], { encoding: "utf8" });
    check("…and that reported port is the one actually serving (OPTIONS → 200)", ping.stdout === "200");
  } finally { sink.kill(); fs.closeSync(fd); }
}

// ── 3. CONTROLS — the fix must not cost the collision DIAGNOSTICS ───────────────────────
// Going ephemeral everywhere would be an over-fix if it meant a real, explicitly-requested port
// collision stopped being reported. A user who asks for :7799 and cannot have it must still be
// told so, actionably, without a raw stack.
{
  const holder = squat(0);                     // a genuinely-taken port, OS-assigned
  try {
    const r = cp.spawnSync(process.execPath, [SINK], { cwd: tmp, encoding: "utf8", timeout: 10000, env: { ...process.env, PPK_SINK_PORT: String(holder.port) } });
    const out = (r.stdout || "") + (r.stderr || "");
    check("CONTROL: sink on an explicitly-requested TAKEN port still exits 1 with 'already in use'", r.status === 1 && /already in use/.test(out));
    check("CONTROL: …and says it without a raw stack trace", !/at Server\./.test(out));

    fs.mkdirSync(path.join(tmp, "targets", "col", "clone"), { recursive: true });
    const r2 = cp.spawnSync(process.execPath, [SERVE, "col", String(holder.port)], { cwd: tmp, encoding: "utf8", timeout: 10000 });
    const out2 = (r2.stdout || "") + (r2.stderr || "");
    check("CONTROL: serve on a TAKEN port still exits 1 with 'already in use', no stack", r2.status === 1 && /already in use/.test(out2) && !/at Server\./.test(out2));
  } finally { holder.child.kill(); }
}

// ── 4. THE GENERAL RULE, GREPPED — no fixed listen port may return to the selftest ──────
// The lesson is not "17799 was unlucky"; it is that a self-test may not name a port at all.
{
  const src = fs.readFileSync(CLI_SELFTEST, "utf8");
  const hardcoded = [...src.matchAll(/(?:PPK_SINK_PORT|listen\(|127\.0\.0\.1:)\s*[:="'(]*\s*(\d{4,5})\b/g)].map((m) => m[1]).filter((p) => p !== "0");
  check(`cli-selftest hardcodes no listen port (found: ${hardcoded.length ? hardcoded.join(", ") : "none"})`, hardcoded.length === 0);
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(bad ? `\n❌ 26-ephemeral-port-isolation: ${bad} check(s) failed.` : "\n✓ 26-ephemeral-port-isolation: the selftest binds OS-assigned ports and discovers them — it cannot collide with, or be impersonated by, another process holding a port. Collision diagnostics intact.");
process.exit(bad ? 1 : 0);
