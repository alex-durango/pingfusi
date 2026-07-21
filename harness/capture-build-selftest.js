// harness/capture-build-selftest.js — guards the capture-build tool (the default build
// strategy, LEARNINGS #19). Runs capture-build end-to-end against a file:// "live site"
// (offline, socket-free — sandboxes that block loopback connects can still run it) and
// asserts every contract:
//   - doctype PRESERVED byte-for-byte — absent stays absent (quirks, #18), present stays present
//   - <script>/script-preloads/CSP <meta>/<base> stripped
//   - stylesheets downloaded + self-hosted; SRI/crossorigin dropped from rewritten links
//   - fonts downloaded to /assets/fonts/ with REAL bytes (the assets gate checks wOF2 magic)
//   - <img>/<video>/<audio>/<source> assets downloaded to /assets/media/ with REAL bytes,
//     src/srcset/poster rewritten to the local copy, crossorigin DROPPED from media tags
//     (a kept cross-origin src + crossorigin attr = Chrome refuses to paint on localhost)
//   - a media download that fails is a PER-ASSET ⚠ receipt, the ref stays absolute, and
//     the build still exits 0 (unlike stylesheets, which stay fatal)
//   - every other ref absolutized (inline-style url()); data: untouched;
//     anchor hrefs untouched; loading=lazy → eager
//   - a failed stylesheet download exits nonzero (pixel-determining, never silent)
// Run: node harness/capture-build-selftest.js   (regression.js runs it too)
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");

const TOOL = path.join(__dirname, "capture-build.js");
let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-capbuild-"));

// ── a tiny live-site stand-in on disk (served via file:// — no sockets) ───────
const site = path.join(work, "site");
fs.mkdirSync(path.join(site, "assets"), { recursive: true });
fs.mkdirSync(path.join(site, "img"), { recursive: true });
fs.mkdirSync(path.join(site, "vid"), { recursive: true });
fs.writeFileSync(path.join(site, "assets", "brand.woff2"), Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(28, 7)]));
// real media bytes — these MUST self-host; img/a.png etc. stay deliberately missing so
// the per-asset failure path (kept absolute, ⚠ receipt, exit 0) is exercised too
fs.writeFileSync(path.join(site, "img", "real.png"), Buffer.from("PNG-REAL-BYTES"));
fs.writeFileSync(path.join(site, "img", "real-2x.png"), Buffer.from("PNG-REAL-2X-BYTES"));
fs.writeFileSync(path.join(site, "vid", "v.mp4"), Buffer.from("MP4-REAL-BYTES"));
fs.writeFileSync(path.join(site, "assets", "site.css"), [
  '@font-face{font-family:X;src:url(./brand.woff2) format("woff2")}',
  "@import url(./extra.css);",
  ".rel{background:url(./img/rel.png)}",
  ".abs{background:url(https://cdn.example.com/pic.png)}",
  ".data{background:url(data:image/png;base64,AAAA)}",
].join("\n"));
const origin = pathToFileURL(site).href; // file:///…/site — target.json url = `${origin}/`

function domHtml(doctype, cssHref) {
  return `${doctype}<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'">
<base href="https://example.com/">
<link rel="preload" href="./app.js" as="script">
<link rel="modulepreload" href="./chunk.mjs">
<link rel="stylesheet" href="${cssHref}" integrity="sha384-bogus" crossorigin="anonymous">
<link rel="preconnect" href="https://cdn.example.com/css2?family=A&amp;family=B&amp;display=swap">
<style>.inline{background:url(/img/inline.png)}</style>
<script src="./app.js"></script>
<script>window.hydrate()</script>
</head><body>
<img loading="lazy" src="./img/a.png" srcset="./img/a.png 1x, ./img/a@2x.png 2x">
<img class="hero" src="./img/real.png" srcset="./img/real.png 1x, ./img/real-2x.png 2x" crossorigin="anonymous">
<video poster="./img/poster.jpg"><source src="./vid/v.mp4"></video>
<a href="/pricing">Pricing</a>
</body></html>`;
}

// Run capture-build for one synthetic target; returns { status, out, cloneDir }.
function run(name, doctype, cssHref, extraFlags) {
  const dir = path.join(work, "targets", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "target.json"), JSON.stringify({ name, url: `${origin}/`, width: 1280 }));
  fs.writeFileSync(path.join(dir, "dom.html"), domHtml(doctype, cssHref));
  let out = "", status = 0;
  try { out = execFileSync("node", [TOOL, name, ...(extraFlags || [])], { cwd: work, stdio: "pipe" }).toString(); }
  catch (e) { status = e.status; out = (e.stdout || "").toString() + (e.stderr || "").toString(); }
  return { status, out, cloneDir: path.join(dir, "clone") };
}

// ── case 1: quirks-mode capture (no doctype) — the full contract ──────────────
const r1 = run("quirks", "", "./assets/site.css");
check("quirks build exits 0", r1.status === 0, r1.out);
const idx = fs.readFileSync(path.join(r1.cloneDir, "index.html"), "utf8");
check("absent doctype PRESERVED (quirks stays quirks, #18)", /^<html/.test(idx));
check("no <script> survives", !/<script/i.test(idx));
check("CSP <meta> stripped", !/content-security-policy/i.test(idx));
check("<base> stripped", !/<base\b/i.test(idx));
check("script preload + modulepreload stripped", !/app\.js|chunk\.mjs/.test(idx));
check("stylesheet href rewritten to self-hosted path", idx.includes('href="/assets/css/00-site.css"'));
check("SRI + crossorigin dropped from rewritten link", !/integrity=|crossorigin=/i.test(idx));
check("inline <style> root-relative url() absolutized", idx.includes("url(file:///img/inline.png)"));
check("MISSING media kept absolute (per-asset failure, never fatal)", idx.includes(`src="${origin}/img/a.png"`));
check("missing srcset entries kept absolute", idx.includes(`srcset="${origin}/img/a.png 1x, ${origin}/img/a@2x.png 2x"`));
// real media self-hosts EXACTLY like css/fonts — the bizar.ro paper cut: a kept
// cross-origin src (+ crossorigin attr) is an image Chrome refuses to paint on localhost
check("img src rewritten to self-hosted /assets/media/ path", idx.includes('src="/assets/media/real.png"'));
check("img srcset rewritten to self-hosted candidates", idx.includes('srcset="/assets/media/real.png 1x, /assets/media/real-2x.png 2x"'));
check("crossorigin dropped from media tags (CORS refuses paint on localhost)", !/crossorigin/i.test(idx));
check("media self-hosted with REAL bytes",
  fs.existsSync(path.join(r1.cloneDir, "assets", "media", "real.png")) &&
  fs.readFileSync(path.join(r1.cloneDir, "assets", "media", "real.png"), "latin1") === "PNG-REAL-BYTES");
check("report counts self-hosted media", /media:\s+3 self-hosted → clone\/assets\/media\//.test(r1.out));
check("failed media downloads are ⚠ receipted per-asset (a.png named), build still exit 0",
  /⚠ media: 3 download\(s\) failed/.test(r1.out) && r1.out.includes("img/a.png"));
// Link hrefs are entity-decoded BEFORE url-parsing — without the decode, "&amp;" inside a
// multi-param href becomes a bogus "amp;family" param and every family after the first is
// silently dropped (astryx: 1 of 15 Google Fonts families loaded, ~74 visual fails from a
// system-font fallback — the gate caught it live; this locks the fix in)
check("&amp;-encoded link href decoded before parsing (astryx Google Fonts miss)", idx.includes('href="https://cdn.example.com/css2?family=A&family=B&display=swap"'));
check("missing video poster kept absolute; <source> self-hosted", idx.includes(`poster="${origin}/img/poster.jpg"`) && idx.includes('src="/assets/media/v.mp4"'));
check("anchor href untouched (doesn't paint)", idx.includes('href="/pricing"'));
check('loading="lazy" forced to eager', idx.includes('loading="eager"') && !/loading\s*=\s*"lazy"/i.test(idx));
check("no scaffold TODO (build gate would pass)", !/TODO: build to spec/.test(idx));

const css = fs.readFileSync(path.join(r1.cloneDir, "assets", "css", "00-site.css"), "utf8");
check("font ref rewritten to self-hosted path", css.includes("url(/assets/fonts/brand.woff2)"));
check("relative css ref absolutized against the CSS URL", css.includes(`url(${origin}/assets/img/rel.png)`));
check("already-absolute css ref untouched", css.includes("url(https://cdn.example.com/pic.png)"));
check("data: uri untouched", css.includes("url(data:image/png;base64,AAAA)"));
check("@import absolutized + reported (not recursed)", css.includes(`${origin}/assets/extra.css`) && r1.out.includes("@import"));
const font = fs.readFileSync(path.join(r1.cloneDir, "assets", "fonts", "brand.woff2"));
check("font self-hosted with REAL wOF2 magic (assets gate)", font.subarray(0, 4).toString("latin1") === "wOF2");
check("report names the quirks mode", /QUIRKS/i.test(r1.out));

// ── case 2: standards-mode capture — doctype preserved verbatim ───────────────
const r2 = run("standards", "<!DOCTYPE html>\n", "./assets/site.css");
const idx2 = fs.readFileSync(path.join(r2.cloneDir, "index.html"), "utf8");
check("present doctype PRESERVED verbatim", r2.status === 0 && /^<!DOCTYPE html>/i.test(idx2));

// ── case 3: a failing stylesheet download is LOUD (exit 1), never silent ──────
const r3 = run("broken", "", "./assets/missing.css");
check("missing stylesheet → exit 1 + named in the report", r3.status === 1 && r3.out.includes("missing.css"));

// ── case 4: --fixes wires clone/fixes.js and reports it; without the flag it's absent ──
const r4a = run("nofixes", "", "./assets/site.css");
const idx4a = fs.readFileSync(path.join(r4a.cloneDir, "index.html"), "utf8");
check("without --fixes: no fixes.js script tag, no scaffold file", !/fixes\.js/i.test(idx4a) && !fs.existsSync(path.join(r4a.cloneDir, "fixes.js")));
const r4b = run("withfixes", "", "./assets/site.css", ["--fixes"]);
const idx4b = fs.readFileSync(path.join(r4b.cloneDir, "index.html"), "utf8");
check("--fixes wires <script src=\"fixes.js\" defer> before </body>", /<script src="fixes\.js" defer><\/script><\/body>/i.test(idx4b));
check("--fixes scaffolds a starter clone/fixes.js when none exists", fs.existsSync(path.join(r4b.cloneDir, "fixes.js")));
check("report confirms fixes.js wired", /fixes\.js:\s+wired/.test(r4b.out));
// re-running --fixes must be idempotent: no duplicate tag, and a hand-edited fixes.js survives
fs.writeFileSync(path.join(r4b.cloneDir, "fixes.js"), "// hand-written behavior code\n");
const r4c = run("withfixes", "", "./assets/site.css", ["--fixes"]);
const idx4c = fs.readFileSync(path.join(r4c.cloneDir, "index.html"), "utf8");
check("re-running --fixes doesn't duplicate the script tag", (idx4c.match(/src="fixes\.js"/g) || []).length === 1);
check("re-running --fixes never overwrites a hand-edited fixes.js", fs.readFileSync(path.join(r4c.cloneDir, "fixes.js"), "utf8").includes("hand-written behavior code"));

fs.rmSync(work, { recursive: true, force: true });
console.log(failed ? `\n❌ capture-build selftest: ${failed} check(s) failed.` : "\n✓ capture-build selftest: all checks pass.");
process.exit(failed ? 1 : 0);
