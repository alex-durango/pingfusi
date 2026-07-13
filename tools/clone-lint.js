// tools/clone-lint.js — a STATIC check on the BUILT clone's HTML. No browser, no capture,
// no screenshot: it reads the file and flags markup that only looks right when JavaScript
// runs or the network answers. For a static clone, both are defects.
//
// Why this exists (paid for on aloyoga): the gate stack compares live.json vs clone.json,
// and BOTH are produced by tools/browser-capture.js. A property the capture cannot see is
// a property the clone and live agree about — so `--visual 156/156` went green while four
// whole sections of the page were missing, empty, invisible, or served from a live CDN.
// That is a shared blind spot by construction, not a bug in any one gate.
//
// The lint does NOT discover new classes — it is a ratchet, not an oracle. Its job is to
// make sure a known fingerprint never reaches a reviewer twice. Discovery stays with the
// reviewer (the `review` phase); every reviewer catch should come back here as a rule.
"use strict";

// --- tiny tag balancer: return the inner HTML of the element that OPENS at `openIdx` ---
// (regex alone can't do this: an unmounted React container is not `<div></div>`, it holds
// a skeleton child, so "is it empty" has to mean "does its SUBTREE paint anything".)
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
function innerOf(html, openIdx) {
  const tag = (html.slice(openIdx).match(/^<([a-z][a-z0-9-]*)/i) || [])[1];
  if (!tag || VOID.has(tag.toLowerCase())) return "";
  const openEnd = html.indexOf(">", openIdx);
  if (openEnd === -1) return "";
  if (html[openEnd - 1] === "/") return "";
  const re = new RegExp(`<(/?)${tag}\\b`, "gi");
  re.lastIndex = openEnd;
  let depth = 1;
  for (let m; (m = re.exec(html)); ) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(openEnd + 1, m.index);
    if (re.lastIndex > html.length) break;
  }
  return html.slice(openEnd + 1); // unbalanced — treat rest as inner
}

// does a subtree actually PAINT anything? (visible text or an image)
const paintsSomething = (inner) => {
  const noTags = inner.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;|&#\d+;/gi, " ");
  return /\S/.test(noTags) || /<img\b|<svg\b|<picture\b|<video\b/i.test(inner);
};

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'");

// ---------------------------------------------------------------- rules
// SEVERITY CALIBRATION (first version got two of these wrong by not reading
// capture-build.js before judging its output — flagging designed behavior as defects):
//   remote-assets    WARN — capture-build DELIBERATELY absolutizes image refs to the live
//                    origin ("byte-identical bytes from the origin/CDN; nothing redrawn").
//                    Worth surfacing (needs network; origin inventory can drift under the
//                    clone) but it is a documented design tradeoff, not a build bug.
//   empty-mount-point / frozen-reveal
//                    FAIL — but if the clone opts into `fixes.js` (capture-build --fixes,
//                    the behavior phase's reproduction script), downgrade to WARN: a page
//                    that ships JS may legitimately mount carousels and run reveals whose
//                    correct INITIAL state is opacity:0. Verify in the behavior phase.
// A lint that fails a clone for doing what the kit designed it to do gets ignored — and
// an ignored gate is worse than no gate.
function lintHtml(html) {
  const rules = [];
  const add = (id, level, hits, summary) => rules.push({ id, level, hits, count: hits.length, summary });
  // the ONE sanctioned script in a capture-built clone: the behavior-phase reproduction
  const hasFixes = /<script\b[^>]*\ssrc=["'][^"']*fixes\.js["']/i.test(html);

  // 1) REMOTE ASSETS — the clone depends on the network: live-CDN images can drift under
  //    it, and offline it renders holes. By design (byte-identical from origin), so WARN.
  {
    const hits = [];
    const hosts = new Set();
    for (const t of html.match(/<img\b[^>]*>/gi) || []) {
      const src = (t.match(/\ssrc=["']([^"']+)/i) || [])[1];
      if (src && /^(https?:)?\/\//i.test(src)) {
        const host = (src.replace(/^https?:/i, "").match(/^\/\/([^/]+)/) || [])[1];
        if (host) hosts.add(host.toLowerCase());
        hits.push(src.slice(0, 90));
      }
    }
    if (hits.length) add("remote-assets", "WARN", hits, `${hits.length} <img> served from the live origin (${[...hosts].slice(0, 4).join(", ")}${hosts.size > 4 ? `, +${hosts.size - 4} more` : ""}) — capture-build's documented tradeoff (byte-identical, but network-dependent and origin can drift)`);
  }

  // 2) EMPTY MOUNT POINT — a container carrying a config blob (data-*-config / React root)
  //    whose subtree paints nothing. JS was supposed to render into it; statically it never
  //    will. The section's title usually lives in the config JSON, so name what's missing.
  //    The kit's answer is the `behavior` phase (fixes.js), not a gate loosened around it.
  {
    const hits = [];
    // A config blob is only ONE way to declare a mount. gorjana mounts its product-recommendations
    // carousel with `<div class="recommendations" data-vue="recommendations">` — no data-*config
    // anywhere — so the rule walked straight past an empty container that live fills with 23
    // product tiles and a 583px slider. Match the FRAMEWORK MOUNT ATTRIBUTES too: whatever the
    // attribute is called, a container that declares "JS renders here" and paints nothing is a
    // hole in the clone. Narrow by construction: the container must both DECLARE a mount and
    // paint NOTHING — a mount attribute on a container that renders is never flagged.
    const re = /<([a-z][a-z0-9-]*)\b[^>]*\s(?:data-[a-z-]*config|data-vue|data-react[a-z-]*|data-component|data-island|data-controller)=["']([^"']*)["'][^>]*>/gi;
    for (let m; (m = re.exec(html)); ) {
      if (paintsSomething(innerOf(html, m.index))) continue;
      const title = (decode(m[2]).match(/"section_title"\s*:\s*"([^"]*)"/) || [])[1];
      hits.push(title ? `section_title="${title}"` : `<${m[1]}> declares a JS mount ("${decode(m[2]).slice(0, 30)}"), renders nothing`);
    }
    if (hits.length) add("empty-mount-point", hasFixes ? "WARN" : "FAIL", hits,
      `${hits.length} JS mount point(s) that render nothing` + (hasFixes
        ? ` — fixes.js is present: VERIFY it renders these in the behavior phase`
        : ` — reproduce in the behavior phase (write clone/fixes.js, rebuild with --fixes)`));
  }

  // 3) FROZEN REVEAL — an inline opacity:0 (usually with a transition) is a scroll-reveal
  //    caught at its START state. The capture recorded it faithfully; without JS to flip it
  //    to opacity:1, the element is invisible FOREVER. Root cause is capturing top-of-page:
  //    re-capture after `pxScrollSettle()` (tools/RUNBOOK.md "Build by capture" step 1).
  {
    const hits = [];
    const re = /<([a-z][a-z0-9-]*)\b[^>]*\sstyle=["']([^"']*opacity:\s*0(?:\.0+)?\s*[;"'][^"']*)["'][^>]*>/gi;
    for (let m; (m = re.exec(html)); ) {
      // An element whose SAME inline style also sets display:none is not a reveal frozen at its
      // start state — a transition can never fire on display:none, so there is no animation to
      // catch mid-flight. Live suppresses it outright (gorjana's mobile app banner ships
      // display:none;visibility:hidden;opacity:0 to desktop) and a clone matching live is not
      // missing content. visibility:hidden alone stays flagged — visibility CAN transition, and
      // pre-mounted hover menus hide exactly that way (LEARNINGS #22).
      if (/display:\s*none/i.test(m[2])) continue;
      const inner = innerOf(html, m.index);
      const text = inner.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
      const anim = /transition|transform/i.test(m[2]);
      hits.push(`<${m[1]}>${text ? ` "${text}"` : ""}${anim ? " (transition — scroll-reveal)" : ""}`);
    }
    if (hits.length) add("frozen-reveal", hasFixes ? "WARN" : "FAIL", hits,
      `${hits.length} element(s) at inline opacity:0 — invisible without JS` + (hasFixes
        ? ` — fixes.js is present: VERIFY it reveals these (opacity:0 may be a legit initial state)`
        : ` — re-capture the DOM after pxScrollSettle(), or reproduce the reveal in fixes.js`));
  }

  // 4) STRIPPED SCRIPTS — the build removed every <script> from a page whose content is
  //    JS-rendered. Anything that lived ONLY as JSON inside those scripts (a lazy section
  //    that had not rendered when the capture fired) is now gone with no trace.
  {
    const scripts = (html.match(/<script\b/gi) || []).length;
    const jsMarkers = (html.match(/data-[a-z-]*config=|react-[a-z-]*container|__NEXT_DATA__|data-reactroot/gi) || []).length;
    if (scripts === 0 && jsMarkers > 0)
      add("stripped-scripts", "WARN", [`${jsMarkers} JS-render marker(s), 0 <script>`], `page is JS-rendered but ships no <script> — content that lived only in script JSON was discarded`);
  }

  // 5) AGENT DOM — the automation extension driving the capture injects overlay nodes into the
  //    page it is measuring (Claude-in-Chrome: a pulsing #claude-agent-glow-border and a
  //    #claude-phantom-cursor, plus a <style> of @keyframes). A DOM captured while the agent is
  //    acting bakes them into the clone, which then SHIPS the instrument's own cursor and border
  //    to the reviewer. The capture now strips them (browser-capture.js pxDomHtml); this is the
  //    artifact-level backstop — the check that would have caught it. Found on gorjana.
  {
    const hits = [...html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\sid=["'](claude-(?:agent|phantom)-[a-z0-9-]*)["'][^>]*>/gi)]
      .map((m) => `<${m[1]} id="${m[2]}">`);
    if (hits.length)
      add("agent-dom", "FAIL", hits,
        `${hits.length} node(s) injected by the AUTOMATION EXTENSION, not by the site — the clone would ship the agent's own overlay. Re-capture with a current browser-capture.js (pxDomHtml strips them)`);
  }

  return { ok: !rules.some((r) => r.level === "FAIL"), rules };
}

// ---------------------------------------------------------------- cli
function main(argv) {
  const file = argv[0];
  if (!file) { console.error("usage: node tools/clone-lint.js <clone/index.html> [--verbose]"); return 2; }
  const fs = require("fs");
  if (!fs.existsSync(file)) { console.error(`clone-lint: no such file: ${file}`); return 2; }
  const verbose = argv.includes("--verbose");
  const { ok, rules } = lintHtml(fs.readFileSync(file, "utf8"));

  console.log(`clone-lint — ${file}\n`);
  if (!rules.length) { console.log("  ✓ clean — no JS/network dependence detected in the built clone"); return 0; }
  for (const r of rules) {
    console.log(`  ${r.level.padEnd(4)}  ${r.id.padEnd(19)} ${r.summary}`);
    for (const h of (verbose ? r.hits : r.hits.slice(0, 3))) console.log(`        ${h}`);
    if (!verbose && r.hits.length > 3) console.log(`        … +${r.hits.length - 3} more (--verbose)`);
  }
  const fails = rules.filter((r) => r.level === "FAIL").length;
  console.log(ok
    ? `\n✓ no FAIL rules (${rules.length} warning(s) — read them; WARNs are tradeoffs to verify, not noise)`
    : `\n✗ ${fails} rule(s) FAIL — content is missing or invisible in the static clone. Fix the CAPTURE (pxScrollSettle before pxSendDom) or reproduce it in the behavior phase (fixes.js) — do not loosen the gate.`);
  return ok ? 0 : 1;
}

module.exports = { lintHtml, innerOf, paintsSomething };
if (require.main === module) process.exit(main(process.argv.slice(2)));
