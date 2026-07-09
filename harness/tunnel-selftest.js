// harness/tunnel-selftest.js — guards the verified-tunnel tool (harness/tunnel.js).
// The lesson it locks in: a review round filed against a dead or wrong tunnel burns a whole
// QA round (hn round 1: "clone unreachable — tunnel died"), so "the tunnel serves the
// clone" must be a CHECKED fact. Tests the pure halves offline (file:// — socket-free):
//   - parseTunnelUrl finds the quick-tunnel url in cloudflared's log noise
//   - verifyServes: byte-identical → ok; different bytes → named mismatch; missing → unreachable
//   - review-qa file-time integration: no tunnel.json + no --draft → refusal names tunnel.js
// Run: node harness/tunnel-selftest.js   (regression.js runs it too)
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");
const { parseTunnelUrl, verifyServes, looksLikeSink } = require("./tunnel.js");

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
};

// ── parseTunnelUrl ────────────────────────────────────────────────────────────
const LOG = `2026-07-02T20:00:01Z INF Thank you for trying Cloudflare Tunnel.
2026-07-02T20:00:02Z INF +--------------------------------------------------------------+
2026-07-02T20:00:02Z INF |  Your quick Tunnel has been created! Visit it at:             |
2026-07-02T20:00:02Z INF |  https://engines-pad-firewire-investing.trycloudflare.com     |
2026-07-02T20:00:02Z INF +--------------------------------------------------------------+`;
check("parses the quick-tunnel url out of log noise", parseTunnelUrl(LOG) === "https://engines-pad-firewire-investing.trycloudflare.com");
check("no url in log → null (keeps waiting, no garbage match)", parseTunnelUrl("INF Starting tunnel connection...") === null);

// ── the sink signature (--sink mode verifies delivery through the tunnel by provoking the
//    sink's distinctive empty-POST reply — not by GET/byte-compare, the sink serves nothing) ──
check("400 + 'empty body' IS the sink", looksLikeSink(400, "empty body for pxprobe.json — capture returned nothing (the finder/injection likely failed)."));
check("200 from some other server is NOT the sink", !looksLikeSink(200, "ok"));
check("a 400 with different text is NOT the sink", !looksLikeSink(400, "Bad Request"));

// ── verifyServes (file:// — offline) ─────────────────────────────────────────
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-tunnel-"));
const idx = path.join(work, "index.html");
fs.writeFileSync(idx, "<html><body>the clone</body></html>");
const twin = path.join(work, "twin.html");
fs.writeFileSync(twin, "<html><body>the clone</body></html>");
const other = path.join(work, "other.html");
fs.writeFileSync(other, "<html><body>something else entirely</body></html>");

(async () => {
  const same = await verifyServes(pathToFileURL(twin).href, idx);
  check("byte-identical content verifies ok (+sha recorded)", same.ok && /^[0-9a-f]{16}$/.test(same.sha256));
  const diff = await verifyServes(pathToFileURL(other).href, idx);
  check("different bytes → NOT ok, mismatch is named", !diff.ok && /NOT clone\/index\.html/.test(diff.reason));
  const dead = await verifyServes(pathToFileURL(path.join(work, "missing.html")).href, idx);
  check("missing/dead url → NOT ok, reported unreachable", !dead.ok && /unreachable/.test(dead.reason));

  // ── review-qa integration: refusal path names the tunnel tool ───────────────
  const tdir = path.join(work, "targets", "t1");
  fs.mkdirSync(path.join(tdir, "clone"), { recursive: true });
  fs.writeFileSync(path.join(tdir, "target.json"), JSON.stringify({ name: "t1", url: "https://example.com/", width: 1280 }));
  fs.writeFileSync(path.join(tdir, "clone", "index.html"), "<html></html>");
  let out = "", status = 0;
  try { out = execFileSync("node", [path.join(__dirname, "review-qa.js"), "file", "t1"], { cwd: work, stdio: "pipe" }).toString(); }
  catch (e) { status = e.status; out = (e.stdout || "").toString() + (e.stderr || "").toString(); }
  check("review-qa file with no tunnel.json and no --draft refuses, pointing at tunnel.js", status === 1 && /tunnel\.js/.test(out));

  // with a recorded tunnel.json pointing at DEAD content, file-time re-verify refuses
  fs.writeFileSync(path.join(tdir, "tunnel.json"), JSON.stringify({ url: pathToFileURL(path.join(work, "gone.html")).href, port: 8080 }));
  status = 0; out = "";
  try { out = execFileSync("node", [path.join(__dirname, "review-qa.js"), "file", "t1"], { cwd: work, stdio: "pipe" }).toString(); }
  catch (e) { status = e.status; out = (e.stdout || "").toString() + (e.stderr || "").toString(); }
  check("review-qa file refuses when the recorded tunnel no longer serves (hn round 1)", status === 1 && /refusing to file/.test(out));

  fs.rmSync(work, { recursive: true, force: true });
  console.log(failed ? `\n❌ tunnel-selftest: ${failed} check(s) failed.` : "\n✓ tunnel-selftest: all checks pass.");
  process.exit(failed ? 1 : 0);
})();
