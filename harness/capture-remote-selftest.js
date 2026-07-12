// harness/capture-remote-selftest.js — guards the hosted capture-delivery CLI.
//
// The lesson it locks in: capture delivery must be LOUD on failure. The
// browser-download path silently rationed saves (one per tab; later saves
// no-op while returning success-shaped values — found live 2026-07-12), so
// the hosted path's pull step verifies every byte against the service's
// recorded facts and refuses mismatches by name. Offline (file:// canned
// responses), like the review-qa/draft selftests.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");
const { verifyPulled } = require("./capture-remote.js");

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
};

// ── verifyPulled (pure) ───────────────────────────────────────────────────────
const buf = Buffer.from('{"probe":"hello capture"}');
const crypto = require("crypto");
const sha = crypto.createHash("sha256").update(buf).digest("hex");
check("matching bytes+sha verify ok", verifyPulled(buf, { bytes: buf.length, sha256: sha }).ok);
check("short transfer refused by name", !verifyPulled(buf, { bytes: buf.length + 9, sha256: sha }).ok && /truncated/.test(verifyPulled(buf, { bytes: buf.length + 9, sha256: sha }).reason));
check("corrupted transfer refused by name", !verifyPulled(buf, { bytes: buf.length, sha256: "0".repeat(64) }).ok && /mismatch/.test(verifyPulled(buf, { bytes: buf.length, sha256: "0".repeat(64) }).reason));
check("no recorded facts → size/sha not enforced (defensive)", verifyPulled(buf, {}).ok);

// ── the CLI offline: open + pull against canned file:// responses ─────────────
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-capture-"));
const fixtures = path.join(work, "fixtures");
fs.mkdirSync(path.join(work, "targets", "t1"), { recursive: true });
fs.mkdirSync(fixtures, { recursive: true });
const TICKET = "AAAAAAAAAAAAAAAA";
fs.writeFileSync(path.join(fixtures, "capture-open.json"), JSON.stringify({ ticket: TICKET, sink_url: `https://example.com/api/capture/u/${TICKET}`, expires_at: new Date(Date.now() + 3600e3).toISOString() }));
fs.writeFileSync(path.join(fixtures, "capture-list.json"), JSON.stringify({ ticket: TICKET, files: [{ name: "live.json", bytes: buf.length, sha256: sha }, { name: "bad.json", bytes: 999, sha256: sha }] }));
fs.writeFileSync(path.join(fixtures, "capture-file-live.json"), buf);
fs.writeFileSync(path.join(fixtures, "capture-file-bad.json"), buf); // 25 bytes ≠ the 999 the list records

const run = (args) => {
  try {
    return { code: 0, out: execFileSync("node", [path.join(__dirname, "capture-remote.js"), ...args], { cwd: work, stdio: "pipe", env: { ...process.env, PPK_PINGHUMANS_URL: pathToFileURL(fixtures).href, PINGFUSI_TOKEN: "" } }).toString() };
  } catch (e) { return { code: e.status, out: (e.stdout || "").toString() + (e.stderr || "").toString() }; }
};

{
  const r = run(["open", "t1"]);
  check("open records the session + prints the senders", r.code === 0 && /pxSendDom\(/.test(r.out) && /pull t1 --all/.test(r.out), r.out.slice(0, 160));
  const s = JSON.parse(fs.readFileSync(path.join(work, "targets", "t1", "capture-session.json"), "utf8"));
  check("capture-session.json carries ticket + sink_url", s.ticket === TICKET && /\/api\/capture\/u\//.test(s.sink_url));
}
{
  const r = run(["pull", "t1", "live.json"]);
  const written = path.join(work, "targets", "t1", "live.json");
  check("pull verifies and writes into targets/<name>/", r.code === 0 && fs.existsSync(written) && fs.readFileSync(written).equals(buf), r.out.slice(0, 160));
}
{
  const r = run(["pull", "t1", "bad.json"]);
  check("pull REFUSES a transfer that mismatches the recorded facts", r.code === 1 && /truncated|mismatch/.test(r.out), r.out.slice(0, 160));
  check("refused pull writes nothing", !fs.existsSync(path.join(work, "targets", "t1", "bad.json")));
}
{
  const r = run(["pull", "t1", "--all"]);
  check("pull --all pulls every listed file and fails on the bad one", r.code === 1 && /live\.json/.test(r.out) && /bad\.json/.test(r.out));
}
{
  const r = run(["pull", "t9", "live.json"]);
  check("pull without a session points at open", r.code === 1 && /capture open t9/.test(r.out));
}
{
  // expired session → named refusal pointing at a fresh open
  const sp = path.join(work, "targets", "t1", "capture-session.json");
  const s = JSON.parse(fs.readFileSync(sp, "utf8"));
  s.expires_at = new Date(Date.now() - 3600e3).toISOString();
  fs.writeFileSync(sp, JSON.stringify(s));
  const r = run(["pull", "t1", "live.json"]);
  check("expired session → named refusal", r.code === 1 && /expired/.test(r.out) && /capture open t1/.test(r.out));
}

fs.rmSync(work, { recursive: true, force: true });
console.log(failed ? `\n❌ capture-remote-selftest: ${failed} check(s) failed.` : "\n✓ capture-remote-selftest: all checks pass.");
process.exit(failed ? 1 : 0);
