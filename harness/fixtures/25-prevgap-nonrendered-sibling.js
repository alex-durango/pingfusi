// fixtures/25-prevgap-nonrendered-sibling.js — the strict gate's OWN false positive.
//
// Paid for on lelabo (2026-07-12). `rect.prevGap` is measured against `previousElementSibling`,
// which counts elements that RENDER NOTHING — <script>, <style>, <link>, <meta>, <template>,
// <noscript>. And the default build strips exactly those (capture-build, LEARNINGS #19).
//
// So a leaf preceded by a <script> gets a DIFFERENT previous sibling on live than in the clone,
// and strict reports a delta for a page where nothing moved. Measured: lelabo's screenreader
// `<h1 id="homepage-h1">Le Labo</h1>` sits after `<script> headerInitialize(); </script>`.
//   live : prev = the <script> (zero box, right edge 0)   → prevGap = -1
//   clone: the script is stripped, prev = <header> (right 1728) → prevGap = -1729
// A 1728px "structural delta" on a page whose --visual was green on all 1394 comparisons. The
// operator's only options were to fix a non-defect or to "document" noise — and teaching people
// to document noise is how a documented deviation stops meaning anything.
//
// The fix makes the measurement INVARIANT UNDER THE BUILD'S OWN TRANSFORM: walk back to the
// previous sibling that actually lays out. It must NOT go so far as to stop measuring prevGap —
// a leaf that genuinely moved relative to its rendered neighbour must still be caught.
"use strict";
let bad = 0; const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

// ── DOM shim (no deps, no jsdom) ────────────────────────────────────────────────────
global.window = undefined;
global.getComputedStyle = (el) => ({ display: el.__display || "block" });
const { prevRenderedSibling } = require("../../tools/browser-capture.js");

// a chain of siblings, left → right; each knows its previous
const chain = (...tags) => {
  const nodes = tags.map((t) => (typeof t === "string" ? { tagName: t } : t));
  nodes.forEach((n, i) => { n.previousElementSibling = i ? nodes[i - 1] : null; });
  return nodes;
};

// 1) THE LELABO SHAPE: <header> <script> <h1> — the script must be skipped, so live and clone
//    (where the script is gone) resolve the SAME previous sibling: the <header>.
{
  const [header, script, h1] = chain("HEADER", "SCRIPT", "H1");
  const [headerClone, h1Clone] = chain("HEADER", "H1");            // capture-build stripped <script>
  const live = prevRenderedSibling(h1);
  const clone = prevRenderedSibling(h1Clone);
  check("a <script> sibling is skipped — live resolves to <header>, not the script", live === header);
  check("clone (script stripped) resolves to the SAME element", clone === headerClone && live.tagName === clone.tagName);
  check("→ prevGap is invariant under capture-build's <script> stripping (the false positive is gone)", live.tagName === clone.tagName);
}

// 2) every non-rendered tag is skipped, not just <script>
for (const tag of ["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "NOSCRIPT"]) {
  const [div, ghost, target] = chain("DIV", tag, "SPAN");
  check(`<${tag.toLowerCase()}> sibling is skipped`, prevRenderedSibling(target) === div);
}

// 3) a run of several non-rendered siblings is skipped in one walk
{
  const [div, s1, s2, s3, target] = chain("DIV", "SCRIPT", "LINK", "STYLE", "SPAN");
  check("a RUN of non-rendered siblings is skipped in one walk", prevRenderedSibling(target) === div);
  void s1; void s2; void s3;
}

// 4) display:none renders nothing either — skip it (it has no box to measure a gap against)
{
  const hidden = { tagName: "DIV", __display: "none" };
  const [div, h, target] = chain("DIV", hidden, "SPAN");
  check("a display:none sibling is skipped (it has no box)", prevRenderedSibling(target) === div);
  void h;
}

// 5) THE CONTROL — the fix must not throw prevGap away. A real, rendered previous sibling is
//    still returned, so a leaf that genuinely moved relative to its neighbour is still caught.
{
  const [a, b] = chain("DIV", "SPAN");
  check("a RENDERED previous sibling is still returned (prevGap still measured — no over-fix)", prevRenderedSibling(b) === a);
}

// 6) no previous sibling at all → null (unchanged behaviour; measure() then omits prevGap)
{
  const [only] = chain("SPAN");
  check("first child → null (prevGap omitted, as before)", prevRenderedSibling(only) === null);
}

// 7) ALL previous siblings are non-rendered → null, never a zero-box script
{
  const [s, target] = chain("SCRIPT", "SPAN");
  check("only non-rendered siblings → null (never measure a gap against a zero-box script)", prevRenderedSibling(target) === null);
  void s;
}

console.log(bad ? `\n❌ 25-prevgap-nonrendered-sibling: ${bad} check(s) failed.` : "\n✓ 25-prevgap-nonrendered-sibling: prevGap is measured against the previous RENDERED sibling — invariant under the build's own <script> stripping, and still measured where it is real.");
process.exit(bad ? 1 : 0);
