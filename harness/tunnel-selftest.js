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
const { parseTunnelUrl, publicUrlForLocal, verifyServes, looksLikeSink } = require("./tunnel.js");

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
check(
  "adopted dev-server tunnel preserves the requested path, query, and hash",
  publicUrlForLocal(
    "https://engines-pad-firewire-investing.trycloudflare.com",
    "http://localhost:3000/design/review?mode=full#hero"
  ) === "https://engines-pad-firewire-investing.trycloudflare.com/design/review?mode=full#hero"
);

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

  // Adopted builds deliberately have no clone/index.html. Their weaker reachability-only
  // tunnel record must still be checked again at file time: stale refuses; live files.
  const adoptedDir = path.join(work, "targets", "adopted");
  fs.mkdirSync(adoptedDir, { recursive: true });
  fs.writeFileSync(path.join(adoptedDir, "target.json"), JSON.stringify({ name: "adopted", url: "https://example.com/design", width: 1280, adopted: true }));
  fs.writeFileSync(path.join(adoptedDir, "tunnel.json"), JSON.stringify({ url: pathToFileURL(path.join(work, "missing-adopted.html")).href, verified: "reachable" }));
  const fixtures = path.join(work, "fixtures");
  fs.mkdirSync(fixtures, { recursive: true });
  fs.writeFileSync(path.join(fixtures, "request_review.json"), JSON.stringify({ ping_id: "22222222-2222-2222-2222-222222222222" }));
  const fileAdopted = () => {
    let result = "", code = 0;
    try {
      result = execFileSync("node", [path.join(__dirname, "review-qa.js"), "file", "adopted"], {
        cwd: work,
        stdio: "pipe",
        env: { ...process.env, PPK_PINGHUMANS_URL: pathToFileURL(fixtures).href, PINGFUSI_TOKEN: "" },
      }).toString();
    } catch (e) { code = e.status; result = (e.stdout || "").toString() + (e.stderr || "").toString(); }
    return { code, out: result };
  };
  const staleAdopted = fileAdopted();
  check("review-qa file re-checks and refuses a stale adopted-build tunnel", staleAdopted.code === 1 && /adopted draft url is not serving/.test(staleAdopted.out), staleAdopted.out.slice(0, 160));

  const livePage = path.join(work, "live-adopted.html");
  fs.writeFileSync(livePage, `<html><body>${"reachable adopted page ".repeat(12)}</body></html>`);
  fs.writeFileSync(path.join(adoptedDir, "tunnel.json"), JSON.stringify({ url: pathToFileURL(livePage).href, verified: "reachable" }));
  const liveAdopted = fileAdopted();
  check("review-qa file accepts a reachable adopted-build tunnel", liveAdopted.code === 0 && /filed round/.test(liveAdopted.out), liveAdopted.out.slice(0, 160));

  fs.rmSync(work, { recursive: true, force: true });
  console.log(failed ? `\n❌ tunnel-selftest: ${failed} check(s) failed.` : "\n✓ tunnel-selftest: all checks pass.");
  process.exit(failed ? 1 : 0);
})();
