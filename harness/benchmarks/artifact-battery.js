// artifact-battery.js — the detection instrument for the CAPTURE-READINESS and ARTIFACT layers.
//
// WHY THIS EXISTS. detection-power scored three instruments: battery.js (the visual DIFF),
// behavior-battery.js (the behavior GATE), capture-battery.js (element `measure()`). Every one of
// them starts from a snapshot or a DOM that ALREADY EXISTS. Two layers before that had no ruler
// at all:
//
//   • READINESS — did the capture even record the right page? `pxScrollSettle` decides WHEN the
//     DOM is taken. Get that wrong and the artifact is a page that never existed.
//   • ARTIFACT  — is the built clone whole? `clone-lint` is the conscience that reads the shipped
//     HTML: empty mount points, frozen reveals, the automation's own injected overlay.
//
// The cost of the gap was measured on the 2026-07-13 gorjana run: FIVE separate, correct,
// evidence-backed improvements scored **+0 gained / +0 false positives removed** and were
// therefore REFUSED by promote-learning — not because they were wrong, but because nothing in the
// kit could see them. The headline one: pxScrollSettle returned `scrolledTo: 4439` while the live
// page went on to 5877px (a product carousel hydrating late), so the clone shipped an empty mount
// point and `--visual` 1300/1300, strict 4144/4144 and coverage 88/88 all went green over less
// than half the page's painted content. A gate cannot see what was never enumerated — and the
// SCORER could not see the fix. That is LEARNINGS #23's own lesson turned on the kit again: when a
// correct improvement cannot be scored, THE INSTRUMENT IS THE DEFECT. Fix the ruler.
//
//   • DEFECT  → the kit really is producing/accepting something wrong. A correct kit CATCHES it
//     (settle refuses or reports the true page; clone-lint FAILs).
//   • CONTROL → the kit is behaving correctly. A flag here is a FALSE POSITIVE — friction the kit
//     invents, which spends the same trust as a miss (#23).
//
// KNOWN LIMIT, stated rather than hidden: clone-lint's empty-mount rule cannot tell a container
// that is empty because the CAPTURE was too early (a real hole) from one that is empty because
// LIVE renders nothing into it either (gorjana's `wishlist-item-persist` / `error-dialog` — both
// zero-height on live). Both look identical in the clone's HTML. That false positive is REAL and
// is NOT encoded below, because this battery only sees the artifact. Closing it needs live/settle
// evidence plumbed into the rule — the next kit change, not a case to fake here.
"use strict";
const cp = require("child_process");
const path = require("path");

const RUNNER = path.join(__dirname, "settle-runner.js");
const wrap = (body) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

// ── ARTIFACT cases: run against clone-lint's lintHtml. `pass` = the lint raised no FAIL. ───────
// [name, kind, html, note]
const artifactBattery = [
  // ── DEFECTS: a clone that is genuinely broken; a correct lint must FAIL it ──
  ["lint-agent-dom", "defect",
    `<header>real</header><div id="claude-agent-glow-border"><div id="claude-agent-glow-border-inner"></div></div><div id="claude-phantom-cursor"></div>`,
    "the automation's own overlay baked into the clone — the instrument painting on the page (LEARNINGS #24)"],
  // The SAME extension, a THIRD prefix. #24 keyed the rule on claude-agent-* and claude-phantom-*
  // and stopped there; the "Claude is active in this tab group" toast ships under claude-static-*.
  // On dtf all five nodes were baked into the shipped clone and THIS rule exited 0 on it — the
  // backstop walked past the very thing it exists to catch. A guard that enumerates two of three
  // prefixes is a guard the instrument walks around.
  ["lint-agent-static-dom", "defect",
    `<header>real</header><div id="claude-static-indicator-container"><button id="claude-static-chat-button"></button><div id="claude-static-chat-tooltip">Open chat</div><button id="claude-static-close-button"></button><div id="claude-static-close-tooltip">Dismiss</div></div>`,
    "the automation's 'Claude is active' toast baked into the clone — #24's namespace, enumerated incompletely"],
  ["lint-empty-mount-framework", "defect",
    `<h1>gorjana</h1><div class="recommendations" data-vue="recommendations"><layers-recommendations-slider></layers-recommendations-slider></div>`,
    "a framework mount (data-vue) that renders nothing — no config blob, so the old rule walked past it"],
  ["lint-empty-mount-config", "defect",
    `<h1>site</h1><div data-section-config='{"section_title":"AS SEEN ON"}'></div>`,
    "a config-blob mount that renders nothing (the aloyoga shape) — must stay caught"],
  ["lint-frozen-reveal", "defect",
    `<section style="opacity: 0; transition: opacity 0.6s;">This reveals on scroll</section>`,
    "a scroll-reveal frozen at its start state — invisible forever without JS; must stay caught"],

  // ── CONTROLS: a clone that is FAITHFUL; a flag here is friction the kit invented ──
  ["adv-lint-clean-clone", "control",
    `<header>real</header><main id="content">jewelry</main>`,
    "a whole, static clone → no rule fires"],
  ["adv-lint-display-none-suppression", "control",
    `<div id="app-banner" style="display: none; visibility: hidden; opacity: 0;">Download our app</div><p>real content</p>`,
    "live itself ships this hidden (a transition cannot fire on display:none) — the clone is faithful (LEARNINGS #25)"],
  ["adv-lint-site-claude-name", "control",
    `<div id="claude-monet-collection">necklaces</div><p class="claude">x</p>`,
    "a site's OWN 'claude-*' id/class is not the automation's overlay — the rule is a namespace, not a substring"],
  // The false-positive hunter for the widened namespace: widening to claude-static-* must not
  // start eating a site's own markup. The rule is an ID NAMESPACE, never a substring — a site is
  // free to ship a static-* id, or the word "claude", or both.
  ["adv-lint-site-static-name", "control",
    `<div id="static-header">menu</div><section id="claude-monet-static-gallery">Water Lilies</section><p class="claude-static">x</p>`,
    "a site's own 'static-*' id, a 'claude…static' id of its own, and a claude-static CLASS → none are the extension's nodes"],
  ["adv-lint-mount-that-renders", "control",
    `<div data-vue="product-grid"><article>Lou Hoops</article><article>Wilder</article></div>`,
    "a framework mount that DOES render → never flagged (the rule needs BOTH: declares a mount, paints nothing)"],

  // A DEFECT that exists to keep the display:none exemption (LEARNINGS #25) honest: exempting display:none must NOT exempt
  // visibility:hidden. Visibility CAN transition, and pre-mounted hover menus hide exactly that
  // way (#22) — so this must STAY caught. An over-reaching "hidden things are fine" fix shows up
  // here as a LOST defect, not as a silent regression.
  ["lint-visibility-hidden-reveal", "defect",
    `<nav style="visibility: hidden; opacity: 0;">menu panel</nav>`,
    "visibility:hidden + opacity:0 (no display:none) is a real reveal — must stay caught after the display:none exemption (LEARNINGS #25)"],
];

// Run the readiness (settle) cases against a specific browser-capture.js, out of process.
function scoreReadiness(captureSrc) {
  const r = cp.spawnSync(process.execPath, [RUNNER, captureSrc], { encoding: "utf8", timeout: 60000 });
  if (r.status !== 0 || !r.stdout) {
    throw new Error(`settle-runner failed for ${captureSrc}: ${(r.stderr || "").slice(0, 200) || "timed out (a settle that never returns is itself the defect)"}`);
  }
  return JSON.parse(r.stdout);
}

const READINESS_KIND = {
  "settle-lazy-growth": "defect",
  "adv-settle-static-page": "control",
  "adv-settle-infinite-feed": "control",
  "settle-image-pending": "defect",
  "adv-settle-images-loaded": "control",
  "adv-settle-hidden-pixel": "control",
  "adv-settle-image-in-closed-flyout": "control",
  "settle-smooth-scroll": "defect",
  "adv-settle-auto-scroll": "control",
};
const READINESS_NOTE = {
  "settle-lazy-growth": "the page grew after the walk passed the section (4439 → 5877) — capturing now yields a page that never existed (fixtures/30-scroll-settle-stability.js)",
  "adv-settle-static-page": "a page that never grows → settle reports its true height, raises no alarm",
  "adv-settle-infinite-feed": "an endlessly-growing page must TERMINATE, not hang — a silent hang is not better than a silent miss",
  "settle-image-pending": "the height held still while a lazy <img> was still in flight — a 0-width box that reflows its row when it lands (chrono24's footer QR shifted two badges 90px, and the gate blamed the CLONE). Height-stability is not readiness (fixtures/32-settle-image-readiness.js)",
  "adv-settle-images-loaded": "every image has landed → the page IS ready; the settle must not invent an alarm",
  "adv-settle-hidden-pixel": "a never-loading display:none tracking pixel cannot reflow anything — refusing a capture over one would block every page with analytics",
  "adv-settle-image-in-closed-flyout": "a pending image inside a display:none ANCESTOR (chrono24's closed header flyout) has no layout box — its own computed display is still \"block\", so only the box test reveals it renders nothing. The naive display-only rule blocked the capture forever",
  "settle-smooth-scroll": "the site sets `scroll-behavior: smooth`, so the sweep's scrollTo(0,y) became an rAF animation that never landed — the settle walked NOTHING and still said stable:true (chrono24). A measurement scroll must be instant (fixtures/34-settle-instant-scroll.js)",
  "adv-settle-auto-scroll": "a page with no smooth CSS already scrolled fine — the instant scroll must not change that",
};

// Score BOTH layers with one (lintHtml, captureSrc) pair, so the A/B can run the BASELINE's own
// clone-lint and the BASELINE's own capture — scoring the current ones on both sides would report
// a fix as a no-op, which is exactly how these layers became unscorable in the first place.
function scoreArtifactGate(lintHtml, captureSrc) {
  const rows = [];
  let caught = 0, defects = 0, falsePos = 0, controls = 0;

  const readiness = scoreReadiness(captureSrc);
  for (const [name, res] of Object.entries(readiness)) {
    const kind = READINESS_KIND[name] || "control";
    const pass = !!res.pass;
    if (kind === "defect") { defects++; if (!pass) caught++; }
    else { controls++; if (!pass) falsePos++; }
    rows.push({ name, kind, pass, note: READINESS_NOTE[name] || res.detail, correct: kind === "defect" ? !pass : pass });
  }

  for (const [name, kind, html, note] of artifactBattery) {
    let pass;
    try { pass = lintHtml(wrap(html)).ok !== false; }
    catch (e) { pass = true; } // a lint that throws flagged nothing
    if (kind === "defect") { defects++; if (!pass) caught++; }
    else { controls++; if (!pass) falsePos++; }
    rows.push({ name, kind, pass, note, correct: kind === "defect" ? !pass : pass });
  }

  return { rows, caught, defects, falsePos, controls };
}

// The flat [name, kind] roll-call of every case this battery scores — READINESS cases included,
// which live in READINESS_KIND rather than in the array above. promote-learning checks a candidate
// declares a real defect + control case by name; without this it would refuse every artifact- or
// readiness-class learning for "no defect case" no matter how well evidenced — the exact failure
// that made capture fixes unpromotable in the first place (#23), reproduced one layer up.
const artifactCases = Object.entries(READINESS_KIND).concat(artifactBattery.map((r) => [r[0], r[1]]));

module.exports = { artifactBattery, artifactCases, scoreArtifactGate, scoreReadiness };
