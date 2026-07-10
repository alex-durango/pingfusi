// harness/draft-selftest.js — guards the hosted-draft tool (harness/draft.js).
// The lessons it locks in: (1) the kit-side /assets/ rewrite must stay byte-identical
// to the service's, or push's verify reports false mismatches on every healthy draft;
// (2) the manifest walk is what the server verifies uploads against — a dropped file
// here is a 409 there; (3) review-qa defaults --draft to draft.json ahead of
// tunnel.json. Tests the pure halves offline (file:// — socket-free).
// Run: node harness/draft-selftest.js   (regression.js runs it too)
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");
const { buildManifest, rewriteAssetRefs, verifyDraftServes } = require("./draft.js");

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
};

// ── rewriteAssetRefs: MUST mirror the service (lib/drafts.ts) ────────────────
const SLUG = "abc123DEF456";
check(
  "root-absolute kit refs are anchored into the draft path",
  rewriteAssetRefs('<link href="/assets/css/x.css">', SLUG) === `<link href="/d/${SLUG}/assets/css/x.css">`
);
check(
  "css url(/assets/…) is anchored too",
  rewriteAssetRefs("@font-face{src:url(/assets/fonts/f.woff2)}", SLUG) === `@font-face{src:url(/d/${SLUG}/assets/fonts/f.woff2)}`
);
check(
  "absolutized live-origin urls containing /assets/ are UNTOUCHED",
  rewriteAssetRefs('<img src="https://example.com/assets/keep.png">', SLUG) === '<img src="https://example.com/assets/keep.png">'
);

// ── buildManifest: the declared upload list the server verifies against ──────
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-draft-"));
const clone = path.join(work, "targets", "t1", "clone");
fs.mkdirSync(path.join(clone, "assets", "fonts"), { recursive: true });
fs.writeFileSync(path.join(clone, "index.html"), '<link href="/assets/css/x.css">page');
fs.writeFileSync(path.join(clone, "assets", "fonts", "f.woff2"), Buffer.from([1, 2, 3]));
fs.writeFileSync(path.join(clone, ".DS_Store"), "junk");
{
  const m = buildManifest(clone);
  check("manifest walks nested dirs with sizes", m.length === 2 && m[0].path === "assets/fonts/f.woff2" && m[0].bytes === 3 && m[1].path === "index.html");
  check("dotfiles are workspace noise, never uploaded", !m.some((f) => f.path.includes(".DS_Store")));
}

(async () => {
  // ── verifyDraftServes (file:// — offline): rewrite-aware byte compare ───────
  const idx = path.join(clone, "index.html");
  const served = path.join(work, "served.html");
  fs.writeFileSync(served, rewriteAssetRefs(fs.readFileSync(idx, "utf8"), SLUG));
  const ok = await verifyDraftServes(pathToFileURL(served).href, idx, SLUG);
  check("served bytes matching the rewritten clone verify ok (+sha)", ok.ok && /^[0-9a-f]{16}$/.test(ok.sha256));
  const stale = path.join(work, "stale.html");
  fs.writeFileSync(stale, "<html>old push</html>");
  const bad = await verifyDraftServes(pathToFileURL(stale).href, idx, SLUG);
  check("stale/wrong bytes → NOT ok, rewrite-aware mismatch named", !bad.ok && /rewrite/.test(bad.reason));
  const dead = await verifyDraftServes(pathToFileURL(path.join(work, "gone.html")).href, idx, SLUG);
  check("missing/dead url → NOT ok, reported unreachable", !dead.ok && /unreachable/.test(dead.reason));

  // ── CLI contract: usage + missing-clone errors are self-describing ──────────
  const run = (args, cwd) => {
    try { return { code: 0, out: execFileSync("node", [path.join(__dirname, "draft.js"), ...args], { cwd, stdio: "pipe" }).toString() }; }
    catch (e) { return { code: e.status, out: (e.stdout || "").toString() + (e.stderr || "").toString() }; }
  };
  { const r = run([], work); check("no args → exit 2 with usage", r.code === 2 && /usage/.test(r.out)); }
  { const r = run(["push", "nope"], work); check("unknown target → exit 1 naming the fix", r.code === 1 && /targets\/nope missing/.test(r.out)); }
  fs.mkdirSync(path.join(work, "targets", "t2"), { recursive: true });
  { const r = run(["push", "t2"], work); check("no clone/index.html → exit 1 pointing at capture-build + the adopted-build tunnel path", r.code === 1 && /capture-build/.test(r.out) && /--url/.test(r.out)); }
  { const r = run(["status", "t2"], work); check("status with no draft.json → exit 1 pointing at push", r.code === 1 && /push/.test(r.out)); }

  // ── review-qa integration: draft.json wins the --draft default ──────────────
  // (offline: file 'template' just prints the spec — the draft url lands in draft_url)
  const t1 = path.join(work, "targets", "t1");
  fs.writeFileSync(path.join(t1, "target.json"), JSON.stringify({ name: "t1", url: "https://example.com/", width: 1280 }));
  fs.writeFileSync(path.join(t1, "tunnel.json"), JSON.stringify({ url: "https://old-tunnel.example.com" }));
  fs.writeFileSync(path.join(t1, "draft.json"), JSON.stringify({ url: "https://pingfusi.com/d/abc123DEF456", slug: SLUG }));
  const rq = (args) => {
    try { return { code: 0, out: execFileSync("node", [path.join(__dirname, "review-qa.js"), ...args], { cwd: work, stdio: "pipe" }).toString() }; }
    catch (e) { return { code: e.status, out: (e.stdout || "").toString() + (e.stderr || "").toString() }; }
  };
  {
    const r = rq(["template", "t1"]);
    const spec = r.code === 0 ? JSON.parse(r.out) : {};
    check("review-qa defaults --draft to the hosted draft over the tunnel", spec.draft_url === "https://pingfusi.com/d/abc123DEF456", r.out.slice(0, 120));
  }
  fs.unlinkSync(path.join(t1, "draft.json"));
  {
    const r = rq(["template", "t1"]);
    const spec = r.code === 0 ? JSON.parse(r.out) : {};
    check("without draft.json the verified tunnel is still the fallback", spec.draft_url === "https://old-tunnel.example.com", r.out.slice(0, 120));
  }

  fs.rmSync(work, { recursive: true, force: true });
  console.log(failed ? `\n❌ draft-selftest: ${failed} check(s) failed.` : "\n✓ draft-selftest: all checks pass.");
  process.exit(failed ? 1 : 0);
})();
