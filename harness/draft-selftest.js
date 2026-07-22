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
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");
const { buildManifest, rewriteAssetRefs, verifyDraftServes, verifyDraftRecord } = require("./draft.js");

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

  const genericPage = path.join(work, "generic.html");
  fs.writeFileSync(genericPage, "<main>generic hosted build</main>");
  const genericSha = crypto.createHash("sha256").update(fs.readFileSync(genericPage)).digest("hex").slice(0, 16);
  const genericRecord = { url: pathToFileURL(genericPage).href, slug: "generic12345", verifiedSha256: genericSha };
  const genericOk = await verifyDraftRecord(genericRecord);
  check("a generic hosted record re-verifies without its original build directory", genericOk.ok && genericOk.sha256 === genericSha);
  fs.writeFileSync(genericPage, "<main>replaced bytes</main>");
  const genericChanged = await verifyDraftRecord(genericRecord);
  check("a replaced generic hosted page fails its recorded-hash check", !genericChanged.ok && /changed/.test(genericChanged.reason));
  fs.writeFileSync(genericPage, "<main>generic hosted build</main>");

  // ── CLI contract: usage + missing-clone errors are self-describing ──────────
  const run = (args, cwd) => {
    try { return { code: 0, out: execFileSync("node", [path.join(__dirname, "draft.js"), ...args], { cwd, stdio: "pipe" }).toString() }; }
    catch (e) { return { code: e.status, out: (e.stdout || "").toString() + (e.stderr || "").toString() }; }
  };
  { const r = run([], work); check("no args → exit 2 with usage", r.code === 2 && /usage/.test(r.out)); }
  { const r = run(["push", "nope"], work); check("unknown target → exit 1 naming the fix", r.code === 1 && /targets\/nope missing/.test(r.out)); }
  fs.mkdirSync(path.join(work, "targets", "t2"), { recursive: true });
  { const r = run(["push", "t2"], work); check("no clone/index.html → exit 1 pointing at capture-build + hosted adopted-build publishing", r.code === 1 && /capture-build/.test(r.out) && /pingfusi publish/.test(r.out) && /--target/.test(r.out)); }
  { const r = run(["status", "t2"], work); check("status with no draft.json → exit 1 pointing at push", r.code === 1 && /push/.test(r.out)); }
  fs.writeFileSync(path.join(work, "targets", "t2", "draft.json"), JSON.stringify(genericRecord));
  { const r = run(["status", "t2"], work); check("status re-verifies a generically published adopted build by receipt hash", r.code === 0 && /recorded index bytes/.test(r.out), r.out); }

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

  // ── the REAL user flow, offline: `review file` against a hosted draft ───────
  // file:// BASE serves a canned request_review.json; the draft.json url is a
  // file:// path shaped like /d/<slug> so the hosted (rewrite-aware) verify
  // branch runs against disk. Locks two live bugs: (a) review-qa's exports must
  // be assigned BEFORE main() runs, or draft.js's circular require captures
  // undefined resolveToken/BASE (node printed circular-dependency warnings in
  // the real `pingfusi review file` flow); (b) the hosted verify must accept
  // the service's rewritten bytes.
  {
    const fixtures = path.join(work, "fixtures");
    fs.mkdirSync(fixtures, { recursive: true });
    fs.writeFileSync(path.join(fixtures, "request_review.json"), JSON.stringify({ ping_id: "11111111-1111-1111-1111-111111111111" }));
    const servedDir = path.join(work, "served", "d");
    fs.mkdirSync(servedDir, { recursive: true });
    fs.writeFileSync(path.join(servedDir, SLUG), rewriteAssetRefs(fs.readFileSync(idx, "utf8"), SLUG));
    fs.writeFileSync(path.join(t1, "draft.json"), JSON.stringify({ url: pathToFileURL(path.join(servedDir, SLUG)).href, slug: SLUG }));
    let out = "", code = 0;
    try {
      out = execFileSync("node", [path.join(__dirname, "review-qa.js"), "file", "t1"], {
        cwd: work,
        stdio: "pipe",
        env: { ...process.env, PPK_PINGHUMANS_URL: pathToFileURL(fixtures).href, PINGFUSI_TOKEN: "" },
      }).toString();
    } catch (e) { code = e.status; out = (e.stdout || "").toString() + (e.stderr || "").toString(); }
    check("`review file` files against the hosted draft offline (canned rpc)", code === 0 && /filed round/.test(out), out.slice(0, 200));
    check("no circular-dependency damage in the file flow", !/non-existent property|circular dependency/.test(out), out.slice(0, 200));
    const hq = JSON.parse(fs.readFileSync(path.join(t1, "review-qa.json"), "utf8"));
    const last = hq.rounds[hq.rounds.length - 1];
    check("the recorded round pins the hosted draft url", last && last.ping_id === "11111111-1111-1111-1111-111111111111" && /\/d\//.test(last.draft_url || ""));

    // The adopted/generic path has no clone/index.html. It must still re-check the
    // immutable hash from `pingfusi publish --target` before filing.
    fs.writeFileSync(path.join(work, "targets", "t2", "target.json"), JSON.stringify({ name: "t2", url: "https://example.com/", width: 1280, adopted: true }));
    let adoptedOut = "", adoptedCode = 0;
    try {
      adoptedOut = execFileSync("node", [path.join(__dirname, "review-qa.js"), "file", "t2"], {
        cwd: work,
        stdio: "pipe",
        env: { ...process.env, PPK_PINGHUMANS_URL: pathToFileURL(fixtures).href, PINGFUSI_TOKEN: "" },
      }).toString();
    } catch (e) { adoptedCode = e.status; adoptedOut = (e.stdout || "").toString() + (e.stderr || "").toString(); }
    check("`review file` re-verifies and files a generic hosted adopted build", adoptedCode === 0 && /filed round/.test(adoptedOut), adoptedOut.slice(0, 200));

    fs.writeFileSync(genericPage, "<main>changed after publish</main>");
    try {
      adoptedOut = execFileSync("node", [path.join(__dirname, "review-qa.js"), "file", "t2"], {
        cwd: work,
        stdio: "pipe",
        env: { ...process.env, PPK_PINGHUMANS_URL: pathToFileURL(fixtures).href, PINGFUSI_TOKEN: "" },
      }).toString();
      adoptedCode = 0;
    } catch (e) { adoptedCode = e.status; adoptedOut = (e.stdout || "").toString() + (e.stderr || "").toString(); }
    check("a changed generic hosted page is refused before a review round is spent", adoptedCode === 1 && /no longer verified/.test(adoptedOut), adoptedOut.slice(0, 200));
  }

  fs.rmSync(work, { recursive: true, force: true });
  console.log(failed ? `\n❌ draft-selftest: ${failed} check(s) failed.` : "\n✓ draft-selftest: all checks pass.");
  process.exit(failed ? 1 : 0);
})();
