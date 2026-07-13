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
const { verifyPulled, safeFileName } = require("./capture-remote.js");

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

// ── safeFileName (pure) — the pulled name is REMOTE-CONTROLLED ────────────────
// `pull --all` takes the filename straight from the session listing (json.files[].name), so a
// hostile or compromised sink can name a file `../../../.zshrc` and the integrity checks would
// all still PASS — the bytes ARE what the server declared; it is the DESTINATION that lies.
check("a plain filename is accepted", safeFileName("live.json") === "live.json");
check("dotfiles and hyphens still fine", safeFileName("behaviors-live.json") === "behaviors-live.json");
for (const evil of ["../x", "../../../.zshrc", "a/b.json", "/etc/passwd", "..", ".", "sub\\win.json", "x\0.json", ""]) {
  check(`traversal/odd name refused: ${JSON.stringify(evil)}`, safeFileName(evil) === null);
}

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
  // END-TO-END: a HOSTILE SINK names a delivered file `../../../pwned.txt`. `pull --all` takes
  // that name from the server's own listing, so without the guard it would be joined onto the
  // target dir and escape the tree — with every integrity check passing, because the BYTES are
  // exactly what the service declared. The pull must refuse it AND write nothing outside.
  const evil = "../../../pwned.txt";
  const listPath = path.join(fixtures, "capture-list.json");
  const good = fs.readFileSync(listPath, "utf8");
  fs.writeFileSync(listPath, JSON.stringify({ ticket: TICKET, files: [{ name: evil, bytes: buf.length, sha256: sha }] }));
  fs.writeFileSync(path.join(fixtures, `capture-file-${evil}`.replace(/[\/\\]/g, "_")), buf); // never read; the guard fires first
  const escaped = path.resolve(work, "targets", "t1", evil); // = <work>/pwned.txt — outside the target dir
  const r = run(["pull", "t1", "--all"]);
  check("a traversal filename from the sink is REFUSED by name", r.code === 1 && /path traversal/.test(r.out), r.out.slice(0, 200));
  check("…and nothing is written outside targets/<name>/", !fs.existsSync(escaped), `wrote ${escaped}`);
  fs.writeFileSync(listPath, good); // restore for the checks below
}
{
  // END-TO-END: a symlink already sitting at targets/<name>/live.json (a legal, plain name — the
  // name guard cannot see it) would be FOLLOWED by writeFileSync, redirecting the write anywhere
  // it points. The pull must lstat the destination and refuse to write through it.
  const dest = path.join(work, "targets", "t1", "live.json");
  const outside = path.join(work, "redirect-target.txt");
  fs.rmSync(dest, { force: true });
  fs.symlinkSync(outside, dest);
  const r = run(["pull", "t1", "live.json"]);
  check("a symlink at the destination is REFUSED (write not followed)", r.code === 1 && /symlink/.test(r.out), r.out.slice(0, 200));
  check("…and the symlink's target was never written", !fs.existsSync(outside), `wrote ${outside}`);
  fs.rmSync(dest, { force: true }); // restore for the checks below
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
