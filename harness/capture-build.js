// harness/capture-build.js <name> [dom.html] [--fixes] — build the clone BY CAPTURE.
//
// WHY THIS EXISTS (LEARNINGS #19). The gate's chronic blind spot is TECHNIQUE mismatches —
// a clone that lands the same numbers by a different construction and rasterises
// differently (#12 #14 #15 #17 #18). Every one of those is self-inflicted by hand-rebuilding.
// A clone built FROM the captured post-hydration DOM inherits live's doctype, authored
// line-heights, font-feature-settings, and drawing primitives BY CONSTRUCTION — the whole
// defect class never exists. Evidence across this repo's targets: the one capture-built
// clone (github) passed 3136 comparisons with 0 fails and 0 structural deltas in a single
// pipeline pass; the hand-rebuilt ones burned 3 and 8 review rounds on
// exactly the misses capture eliminates.
//
// WHAT IT DOES — from a captured DOM serialization (get it with `pxSendDom(...)`, see
// tools/RUNBOOK.md "Build by capture") it writes targets/<name>/clone/index.html that
// renders standalone:
//   - downloads every linked stylesheet          → clone/assets/css/   (self-hosted)
//   - downloads every font the CSS references    → clone/assets/fonts/ (self-hosted —
//     the assets gate verifies their wOF2 magic; cross-origin fonts need CORS anyway)
//   - rewrites every other css/html asset ref to the ABSOLUTE live URL (byte-identical
//     bytes from the origin/CDN; nothing redrawn, nothing re-encoded)
//   - strips <script> (a static clone must not re-hydrate/redirect), script preloads,
//     the CSP <meta> (it would block the local assets), and <base> (refs are absolutized)
//   - forces loading="lazy" → "eager" (a lazy image in a hidden container never fires
//     its viewport check on a static page)
//   - PRESERVES THE DOCTYPE — or its absence — byte-for-byte. Never "fixes" it: a live
//     site with no doctype renders in quirks mode, and the capture must too (#18).
//
// WHAT STAYS YOURS: JS-driven behavior and generative content (animations, WebGL,
// carousels) cannot be captured statically — reproduce them separately, and spend review
// QA rounds there, not on statics the gate proves. The measure→visual→coverage→strict
// gates run unchanged on a capture-built clone: they still catch a font that failed to
// self-host, a stripped script that removed a load-bearing class, and environment drift.
//
// USAGE
//   node harness/capture-build.js <name> [domFile] [--fixes]
//   pingfusi capture-build <name> [domFile] [--fixes]
// domFile defaults to targets/<name>/dom.html.
// --fixes injects <script src="fixes.js" defer></script> before </body> — the ONE vanilla
// reproduction script for the `behavior` phase (docs/WORKFLOW.md; method: lovable_dupe_html's
// CLONE_PLAYBOOK.md §8). It's a flag, not automatic:
// a capture-built clone defaults to byte-honest (no script tags at all — the whole point of
// §18/#19 is that a static clone renders identically to a stripped-JS snapshot of live). Only
// once you've written targets/<name>/clone/fixes.js do you opt in to loading it. Re-running
// capture-build (e.g. after a live re-capture) is idempotent: it re-adds the tag if missing,
// never duplicates it, and never touches fixes.js itself (that file is source you maintain by
// hand, capture-build only wires the <script> tag). Downloads use node's built-in fetch
// (node >= 18) — no curl, no subprocess.
"use strict";

const fs = require("fs");
const path = require("path");

const WORK = process.cwd();

// ── url helpers ───────────────────────────────────────────────────────────────
// A ref we must leave untouched: data:/blob:/about:, fragments, javascript:, mailto:.
const isOpaqueRef = (ref) => /^(data:|blob:|about:|javascript:|mailto:|tel:|#)/i.test(ref.trim());

// Resolve any URL reference (root-relative, relative, protocol-relative, absolute)
// against a base absolute URL. Returns null for refs that must not be rewritten.
function absolutize(ref, baseUrl) {
  const r = (ref || "").trim();
  if (!r || isOpaqueRef(r)) return null;
  try { return new URL(r, baseUrl).href; } catch (e) { return null; }
}

const sanitizeFile = (s) => (s.replace(/[^a-zA-Z0-9._-]/g, "") || "asset");
const baseNameOfUrl = (u) => sanitizeFile(path.posix.basename(new URL(u).pathname.split("?")[0]) || "asset");

// file:// origins are first-class: point target.json's url at a saved page (e.g. a
// SingleFile dump) and assets resolve from disk — also what makes the selftest run
// offline and inside sandboxes that block sockets.
async function fetchTo(url, dest) {
  if (url.startsWith("file://")) { fs.copyFileSync(new URL(url), dest); return; }
  const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

// ── css processing (scan is separate from rewrite: downloads are async, replace
//    callbacks can't await — so we collect font URLs first, download, THEN rewrite) ──
const FONT_RE = /\.(woff2?|ttf|otf|eot)([?#]|$)/i;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s][^)]*?))\s*\)/gi;

function scanCssFontUrls(css, cssUrl) {
  const found = [];
  for (const m of css.matchAll(CSS_URL_RE)) {
    const abs = absolutize(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3], cssUrl);
    if (abs && FONT_RE.test(abs)) found.push(abs);
  }
  return found;
}

// Rewrite one CSS text: fonts → their fontMap entry, everything else → absolute.
// `cssUrl` is the absolute URL this CSS came from (relative refs resolve against IT).
function rewriteCss(css, cssUrl, state) {
  // @import targets are absolutized but NOT recursed into — fonts behind an @import
  // won't be self-hosted. Loud, never silent: each one is listed in the report.
  css = css.replace(/@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)|"([^"]*)"|'([^']*)')/gi, (m, a, b, c, d, e) => {
    const ref = a || b || c || d || e;
    const abs = absolutize(ref, cssUrl);
    if (!abs) return m;
    state.imports.push(abs);
    return m.replace(ref, abs);
  });
  return css.replace(CSS_URL_RE, (m, dq, sq, bare) => {
    const abs = absolutize(dq != null ? dq : sq != null ? sq : bare, cssUrl);
    if (!abs) return m; // data:/blob:/fragment/unparseable — leave byte-identical
    if (state.fontMap.has(abs)) return `url(${state.fontMap.get(abs)})`;
    return `url(${abs})`;
  });
}

async function downloadFonts(urls, state) {
  for (const abs of urls) {
    if (state.fontMap.has(abs)) continue;
    let file = baseNameOfUrl(abs);
    // same basename from a different URL → disambiguate, never silently overwrite
    if ([...state.fontMap.values()].includes(`/assets/fonts/${file}`)) file = `${state.fontMap.size}-${file}`;
    try {
      await fetchTo(abs, path.join(state.fontDir, file));
      state.fontMap.set(abs, `/assets/fonts/${file}`);
    } catch (e) {
      state.failures.push(`font ${abs} — ${e.message}`);
      state.fontMap.set(abs, abs); // keep the absolute URL so the page still tries the CDN
    }
  }
}

// ── html attribute helpers ────────────────────────────────────────────────────
// Attribute values are HTML-entity-encoded in the source (a multi-query-param URL like
// Google Fonts' combined css2?family=A&family=B legally authors the "&" as "&amp;" inside
// an attribute). Passing that raw string straight to `new URL()` parses "&amp;family=B" as
// a single bogus param named "amp;family" — the server silently drops every family after
// the first, which is a silent, load-bearing asset loss (LEARNINGS-class miss: a captured
// clone falls back to a system font while every measured metric quietly drifts). Decode the
// handful of entities legally found in attribute values before treating them as URLs.
const decodeAttrEntities = (s) =>
  s.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
const attrValue = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  const raw = m ? (m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]) : null;
  return raw != null ? decodeAttrEntities(raw) : null;
};
const setAttrValue = (tag, name, value) =>
  tag.replace(new RegExp(`\\b(${name}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i"), `$1"${value}"`);
const dropAttr = (tag, name) => tag.replace(new RegExp(`\\s+${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "gi"), "");

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const [name, domArg] = args.filter((a) => !a.startsWith("--"));
  if (!name) { console.error("usage: pingfusi capture-build <name> [domFile] [--fixes]"); process.exit(2); }
  // The web QA toolbar is GONE (reviewing happens in the review app, which brings its own
  // pinning UI): the injected <script> just 404'd on every draft view. Refuse the stale flag.
  if (flags.has("--qa-toolbar")) { console.error("❌ --qa-toolbar was removed — reviewers use the review app's own tools; no script tag is injected into clones."); process.exit(1); }
  if (typeof fetch !== "function") { console.error("capture-build needs node >= 18 (built-in fetch)"); process.exit(1); }

  const dir = path.join(WORK, "targets", name);
  const targetPath = path.join(dir, "target.json");
  if (!fs.existsSync(targetPath)) { console.error(`targets/${name}/target.json missing — run: pingfusi new ${name} <url> [width]`); process.exit(1); }
  const target = JSON.parse(fs.readFileSync(targetPath, "utf8"));
  if (!target.url) { console.error(`targets/${name}/target.json has no url`); process.exit(1); }

  const domFile = domArg ? path.resolve(WORK, domArg) : path.join(dir, "dom.html");
  if (!fs.existsSync(domFile)) {
    console.error(`captured DOM not found: ${path.relative(WORK, domFile)}
capture it off the LIVE page first (tools/RUNBOOK.md "Build by capture"):
  1. inject tools/browser-capture.js as plain source on the live tab
  2. await pxSendDom('http://localhost:7799/dom.html')   // sink running in targets/${name}/
     (CSP-blocked POST → pxStash(null, 900, pxDomHtml()) + batched pxRead)`);
    process.exit(1);
  }
  let html = fs.readFileSync(domFile, "utf8");
  if (!html.trim()) { console.error(`${path.relative(WORK, domFile)} is empty — the capture failed; re-capture.`); process.exit(1); }

  const cloneDir = path.join(dir, "clone");
  const cssDir = path.join(cloneDir, "assets", "css");
  const fontDir = path.join(cloneDir, "assets", "fonts");
  fs.mkdirSync(cssDir, { recursive: true });
  fs.mkdirSync(fontDir, { recursive: true });

  const state = { fontMap: new Map(), imports: [], failures: [], fontDir };

  // ── the doctype is a pixel-determining property of the whole page (#18) ─────
  // Preserve exactly what was captured; only REPORT the implied rendering mode.
  const hasDoctype = /^\s*<!doctype/i.test(html);
  const mode = hasDoctype ? "standards (CSS1Compat)" : "QUIRKS (BackCompat — live ships no doctype; preserved, do not add one)";

  // ── pass 1: discover + download stylesheets, then fonts, then rewrite CSS ───
  // cssMap: absolute stylesheet URL → local /assets/css/ path (used to rewrite both
  // the <link rel=stylesheet> tags and any rel=preload as=style pointing at the same URL).
  const cssMap = new Map();   // absUrl → local path
  const cssText = new Map();  // absUrl → { dest, css }
  let cssIdx = 0;
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = (attrValue(tag, "rel") || "").toLowerCase();
    if (!/\bstylesheet\b/.test(rel)) continue;
    const href = attrValue(tag, "href");
    const abs = href && absolutize(href, target.url);
    if (!abs || cssMap.has(abs)) continue;
    const file = `${String(cssIdx++).padStart(2, "0")}-${baseNameOfUrl(abs).replace(/\.css$|$/i, ".css")}`;
    const dest = path.join(cssDir, file);
    try {
      await fetchTo(abs, dest);
      cssText.set(abs, { dest, css: fs.readFileSync(dest, "utf8") });
      cssMap.set(abs, `/assets/css/${file}`);
    } catch (e) {
      state.failures.push(`stylesheet ${abs} — ${e.message}`);
    }
  }

  // fonts referenced by downloaded CSS or inline <style> blocks — collect, then fetch
  const fontUrls = [];
  for (const [abs, { css }] of cssText) fontUrls.push(...scanCssFontUrls(css, abs));
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) fontUrls.push(...scanCssFontUrls(m[1], target.url));
  await downloadFonts(fontUrls, state);

  for (const [abs, { dest, css }] of cssText) fs.writeFileSync(dest, rewriteCss(css, abs, state));

  // ── pass 2: rewrite the HTML ─────────────────────────────────────────────────
  // scripts: a static clone must never re-hydrate, redirect, or blank itself
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "").replace(/<script\b[^>]*\/>/gi, "");
  // CSP meta would block the self-hosted assets we just created
  html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");
  // <base> would re-relativize everything — we absolutize instead, so it must go
  const hadBase = /<base\b[^>]*>/i.test(html);
  html = html.replace(/<base\b[^>]*>/gi, "");

  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = (attrValue(tag, "rel") || "").toLowerCase();
    const as = (attrValue(tag, "as") || "").toLowerCase();
    if (/\bmodulepreload\b/.test(rel) || (/\bpreload\b/.test(rel) && as === "script")) return ""; // script preloads: gone with the scripts
    const href = attrValue(tag, "href");
    const abs = href && absolutize(href, target.url);
    if (!abs) return tag;
    let local = null;
    if (cssMap.has(abs)) local = cssMap.get(abs);
    else if (state.fontMap.has(abs) && state.fontMap.get(abs) !== abs) local = state.fontMap.get(abs);
    let out = setAttrValue(tag, "href", local || abs);
    // SRI/crossorigin were computed for the ORIGINAL bytes at the original origin —
    // they'd block the rewritten local copy
    if (local) out = dropAttr(dropAttr(out, "integrity"), "crossorigin");
    return out;
  });

  // src/poster on img/video/iframe/source/etc → absolute (bytes come from the live origin/CDN)
  html = html.replace(/\b(src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (m, attr, dq, sq) => {
    const abs = absolutize(dq != null ? dq : sq, target.url);
    return abs ? `${attr}="${abs}"` : m;
  });
  html = html.replace(/\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (m, dq, sq) => {
    const val = dq != null ? dq : sq;
    if (/^data:/i.test(val.trim())) return m;
    const rewritten = val.split(",").map((entry) => {
      const t = entry.trim();
      if (!t) return t;
      const [u, ...desc] = t.split(/\s+/);
      const abs = absolutize(u, target.url);
      return [abs || u, ...desc].join(" ");
    }).join(", ");
    return `srcset="${rewritten}"`;
  });
  // a lazy image inside a hidden/JS-toggled container never fires its viewport check
  html = html.replace(/\bloading\s*=\s*(?:"lazy"|'lazy'|lazy\b)/gi, 'loading="eager"');

  // inline <style> blocks get the same treatment as downloaded CSS (base = the page URL)
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (m, open, css, close) => open + rewriteCss(css, target.url, state) + close);

  // --fixes: wire the ONE vanilla behavior-reproduction script (never generated here — you
  // write clone/fixes.js by hand, per-target, following lovable_dupe_html/CLONE_PLAYBOOK.md
  // §8). Idempotent: skip if a fixes.js tag is already present (re-running capture-build
  // after a live re-capture must not duplicate it or clobber a hand-edited script tag).
  let fixesWired = false;
  if (flags.has("--fixes")) {
    if (/\bsrc\s*=\s*["']?\.?\/?fixes\.js\b/i.test(html)) { fixesWired = true; }
    else { html = html.replace(/<\/body>/i, '<script src="fixes.js" defer></script></body>'); fixesWired = true; }
  }

  fs.writeFileSync(path.join(cloneDir, "index.html"), html);
  // Scaffold a starter fixes.js ONLY if --fixes was requested and none exists yet — never
  // overwrite one you've already written (that's the file discovery + measurement feeds).
  const fixesPath = path.join(cloneDir, "fixes.js");
  if (flags.has("--fixes") && !fs.existsSync(fixesPath)) {
    fs.writeFileSync(fixesPath, `// clone/fixes.js — one vanilla IIFE that re-drives this target's JS-driven dynamics.
// No framework. The HTML/CSS stay byte-exact; this only animates what a static capture
// can't show. Method: lovable_dupe_html/CLONE_PLAYBOOK.md §8 (ported, not reinvented).
// Discover behaviors on LIVE first with tools/behavior-capture.js (pxBehaviorDiscover) —
// that inventory (behaviors-live.json) is your to-do list; each entry here should
// correspond to one key in it. Guard each behavior in its own try so one bug doesn't
// blank the rest of the page.
(function () {
  "use strict";
  const ready = (fn) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn());
  ready(function () {
    // try { initYourBehaviorHere(); } catch (e) { console.error("fixes.js:", e); }
  });
})();
`);
  }

  // ── report — loud about everything that is NOT a byte-identical capture ─────
  console.log(`clone/index.html written — ${html.length} bytes (from ${path.relative(WORK, domFile)})
  doctype:    ${mode}
  css:        ${cssMap.size} stylesheet(s) self-hosted → clone/assets/css/
  fonts:      ${[...state.fontMap.values()].filter((v) => v.startsWith("/assets/")).length} self-hosted → clone/assets/fonts/  (assets gate checks their wOF2 magic)
  stripped:   <script> tags, script preloads, CSP <meta>${hadBase ? ", <base> (refs absolutized)" : ""}
  fixes.js:   ${fixesWired ? `wired (<script src="fixes.js" defer> before </body>)` : "not wired — pass --fixes once you have targets/" + name + "/clone/fixes.js (behavior phase)"}`);
  if (state.imports.length) console.log(`  ⚠ @import: ${state.imports.length} absolutized, NOT recursed — fonts behind them are not self-hosted:\n      ${state.imports.join("\n      ")}`);
  if (state.failures.length) {
    console.error(`  ❌ ${state.failures.length} download(s) FAILED — these are pixel-determining; fix before advancing build:\n      ${state.failures.join("\n      ")}`);
    process.exit(1);
  }
  console.log(`
next: serve + capture the clone (RUNBOOK), then the gates run unchanged:
  ${process.env.PPK_ENTRY === "1" ? "pingfusi" : "node harness/workflow.js"} status ${name}
JS-driven behavior + animated/generative content can't be captured statically — discover +
measure it on live with tools/behavior-capture.js, reproduce in clone/fixes.js, rebuild with
--fixes, then capture behaviors-clone.json the same way. See docs/WORKFLOW.md's \`behavior\` phase.`);
}

if (require.main === module) main().catch((e) => { console.error(`capture-build failed: ${e.message}`); process.exit(1); });
module.exports = { absolutize, scanCssFontUrls, rewriteCss };
