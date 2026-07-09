#!/usr/bin/env node
/**
 * cli-selftest.js — guards the TOOL CONTRACTS of the kit's Node entry points.
 *
 * selftest.js guards what the diff *measures*; this guards how the tools *behave at their
 * edges* — the Claude Code tool-contract properties: validate input, bound output, fail
 * loudly with a self-describing, actionable message (never a raw stack), and use stable
 * exit codes. Each assertion here is a bug we fixed; this file keeps it fixed.
 *
 * Runs against the real pixel-diff CLI (child process) and the pure, exported guards of
 * serve.js / sink.js (no sockets). Exit 0 = green.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const PD = path.join(__dirname, "pixel-diff.js");
const { resolvePath } = require("../harness/serve.js");
const { classifyBody, sanitizeName } = require("./sink.js");

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed++; console.log(`  ✗ ${msg}`); } };

// scratch dir in the OS temp area (hermetic)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-cli-"));
process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });
const w = (f, s) => { const p = path.join(dir, f); fs.writeFileSync(p, s); return p; };
const snap = JSON.stringify({ viewport: { width: 1728 }, elements: { logo: { present: true, rect: { x: 0, y: 0, w: 10, h: 10, top: 0, right: 10, bottom: 10, fromRight: 0 } } } });
const run = (args) => { const r = cp.spawnSync(process.execPath, [PD, ...args], { encoding: "utf8" }); return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }; };

const a = w("a.json", snap), b = w("b.json", snap);

console.log("cli-selftest — tool contracts (validate input, self-describing errors, exit codes)");

// pixel-diff: valid diff of identical snapshots exits 0
ok(run([a, b]).code === 0, "identical snapshots → exit 0");

// --tol now WORKS (regression: the flag value was being counted as a file)
{ const r = run([a, b, "--tol", "0.5"]); ok(r.code === 0 && !/usage/.test(r.out), "--tol 0.5 is parsed, not treated as a file"); }
// a bad --tol value is rejected with a clear message
{ const r = run([a, b, "--tol", "abc"]); ok(r.code === 2 && /--tol needs a non-negative number/.test(r.out), "--tol abc → exit 2 with an actionable message"); }
// unknown flags are rejected, not silently ignored
{ const r = run([a, b, "--nope"]); ok(r.code === 2 && /unknown flag/.test(r.out), "unknown flag → exit 2"); }

// missing file → self-describing error (not a raw ENOENT stack), exit 2
{ const r = run([a, path.join(dir, "nope.json")]); ok(r.code === 2 && /not found/.test(r.out) && !/at Object\./.test(r.out), "missing file → 'not found', no stack trace"); }
// invalid JSON → self-describing error (not a raw SyntaxError stack)
{ const bad = w("bad.json", "not json{"); const r = run([a, bad]); ok(r.code === 2 && /not valid JSON/.test(r.out) && !/SyntaxError\b.*\n\s+at /.test(r.out), "invalid JSON → 'not valid JSON', no stack trace"); }
// a [BLOCKED…] automation sentinel is caught, not diffed as data
{ const blk = w("blk.json", "[BLOCKED: content filter]"); const r = run([a, blk]); ok(r.code === 2 && /BLOCKED/.test(r.out), "[BLOCKED…] sentinel → exit 2 with guidance"); }
// wrong shape (no .elements) without --inspect is a clear mix-up error
{ const noEl = w("noel.json", JSON.stringify({ viewport: { width: 1728 } })); const r = run([a, noEl]); ok(r.code === 2 && /no "elements"/.test(r.out), "snapshot without elements → clear mix-up error"); }
// wrong count of files → exit 2 + usage
{ const r = run([a]); ok(r.code === 2 && /expected 2 snapshot files/.test(r.out), "one file → exit 2 with usage"); }

// serve.js path-boundary guard (pure): legit paths resolve, traversal + prefix-siblings rejected
{
  const roots = { cloneDir: "/x/clone", toolsDir: "/x/tools" };
  ok(resolvePath("/", roots) === path.resolve("/x/clone", "index.html"), "'/' → clone/index.html");
  ok(resolvePath("/styles.css", roots) === path.resolve("/x/clone", "styles.css"), "in-root file resolves");
  ok(resolvePath("/tools/browser-capture.js", roots) === path.resolve("/x/tools", "browser-capture.js"), "/tools/* → tools dir");
  ok(resolvePath("/../secret", roots) === null, "../ traversal rejected");
  ok(resolvePath("/tools/../../etc/passwd", roots) === null, "nested ../ traversal rejected");
  ok(resolvePath("/%", roots) === null, "malformed percent-encoding returns null instead of throwing (server survives)");
  ok(resolvePath("/%zz", roots) === null, "invalid escape sequence returns null instead of throwing");
}

// sink.js body guard (pure): empty / oversize / [BLOCKED] refused; non-JSON warned; good JSON ok
ok(classifyBody("clone.json", "").write === false && classifyBody("clone.json", "").status === 400, "empty body refused (400)");
ok(classifyBody("clone.json", "[BLOCKED: x]").write === false, "[BLOCKED…] body refused");
ok(classifyBody("clone.json", "x".repeat(21 * 1024 * 1024)).status === 413, "oversize body refused (413)");
{ const r = classifyBody("clone.json", "not json"); ok(r.write === true && /NOT valid JSON/.test(r.message), "non-JSON under .json name is written but warned"); }
ok(classifyBody("clone.json", snap).status === 200 && classifyBody("clone.json", snap).write === true, "valid JSON snapshot accepted");
ok(sanitizeName("/a/b/clone.json").renamed === true, "sub-path name flagged as sanitized (silent-rename footgun surfaced)");
{ const r = sanitizeName("/clone.json?t=1"); ok(r.clean === "clone.json" && r.renamed === false, "query string is stripped, not fused into the filename"); }

// reassemble.js — chunk joining is a VERIFIED operation (the HN dogfood run corrupted a
// snapshot by hand-concatenating chunks; these lock the validator that prevents it).
{
  const RA = path.join(__dirname, "reassemble.js");
  const runRA = (args) => { const r = cp.spawnSync(process.execPath, [RA, ...args], { encoding: "utf8", cwd: dir }); return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }; };
  const c0 = w("chunk-00.txt", snap.slice(0, 40));
  const c1 = w("chunk-01.txt", snap.slice(40));
  const outFile = path.join(dir, "reassembled.json");
  { const r = runRA([outFile, "--bytes", String(snap.length), c0, c1]); ok(r.code === 0 && fs.existsSync(outFile) && fs.readFileSync(outFile, "utf8") === snap, "valid chunks + matching byte count reassemble to the exact snapshot"); }
  { const r = runRA([outFile, "--bytes", String(snap.length + 7), c0, c1]); ok(r.code === 2 && /byte count mismatch/.test(r.out), "byte-count mismatch → exit 2 naming the missing bytes"); }
  // drop a QUOTE at the boundary → structurally invalid JSON, caught by the parse check
  { const qi = snap.indexOf('"', 10); const cbad = w("chunk-01bad.txt", snap.slice(qi + 1)); const r = runRA([outFile, w("chunk-00q.txt", snap.slice(0, qi)), cbad]); ok(r.code === 2 && /not valid JSON/.test(r.out), "corrupt chunk boundary (dropped quote) → exit 2, nothing written silently"); }
  // drop a LETTER at the boundary → still-parseable-but-wrong JSON (the real dogfood bug);
  // only the byte count catches this class — which is why --bytes must always be passed
  { const r = runRA([outFile, "--bytes", String(snap.length), w("chunk-00l.txt", snap.slice(0, 40)), w("chunk-01l.txt", snap.slice(41))]); ok(r.code === 2 && /byte count mismatch/.test(r.out), "dropped-letter corruption (valid JSON, wrong data) → caught by --bytes"); }
  { const r = runRA([outFile]); ok(r.code === 2 && /usage/.test(r.out), "no chunk files → exit 2 with usage"); }
}

// serve.js port collision → actionable error, not a raw stack
{
  const holder = cp.spawn(process.execPath, ["-e", "require('http').createServer(() => {}).listen(18094, () => console.log('up')); setTimeout(() => {}, 30000)"], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    let up = false;
    for (let i = 0; i < 30 && !up; i++) { const ping = cp.spawnSync("curl", ["-s", "-o", "/dev/null", "--max-time", "1", "http://127.0.0.1:18094/"], {}); if (ping.status === 0 || ping.status === 52) up = true; else cp.spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 100)"]); }
    fs.mkdirSync(path.join(dir, "targets", "col", "clone"), { recursive: true });
    const r = cp.spawnSync(process.execPath, [path.join(__dirname, "..", "harness", "serve.js"), "col", "18094"], { encoding: "utf8", cwd: dir, timeout: 5000 });
    const out2 = (r.stdout || "") + (r.stderr || "");
    ok(r.status === 1 && /already in use/.test(out2) && !/at Server\./.test(out2), "serve on a taken port → 'already in use' + exit 1, no stack trace");
  } finally { holder.kill(); }
}

// sink streaming abort (real server, tiny limit via env): the size bound must hold DURING
// the stream, not just at end — the aborted body must never reach disk.
{
  const port = 17799;
  const sink = cp.spawn(process.execPath, [path.join(__dirname, "sink.js")], {
    cwd: dir,
    env: { ...process.env, PPK_SINK_PORT: String(port), PPK_SINK_MAX_BYTES: "1000" },
    stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      const ping = cp.spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "OPTIONS", `http://127.0.0.1:${port}/ping`], { encoding: "utf8" });
      if (ping.stdout === "200") up = true;
      else cp.spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 100)"]);
    }
    ok(up, "sink starts on an env-configured port");
    const r = cp.spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--data-binary", "x".repeat(5000), `http://127.0.0.1:${port}/big.json`], { encoding: "utf8" });
    ok(r.stdout === "413", `oversize body is aborted mid-stream with 413 (got ${r.stdout || "no response"})`);
    ok(!fs.existsSync(path.join(dir, "big.json")), "aborted oversize body is never written to disk");
  } finally {
    sink.kill();
  }
}

console.log(failed ? `\n❌ cli-selftest: ${failed} assertion(s) failed — a tool contract regressed.` : `\n✓ cli-selftest: tool contracts hold (validated input, self-describing errors, safe paths).`);
process.exit(failed ? 1 : 0);
