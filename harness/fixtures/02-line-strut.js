// fixtures/02-line-strut.js — the line-box CONTAINER's line-height (the strut) positions
// the glyphs; the leaf's own line-height can match live exactly while the container
// differs. Found on the HN header (flagged after a green --visual): live authored
// `line-height:12pt` (16px) on the td, the clone left the td `normal` — every measured
// leaf matched (12 vs 12), the same-machine offset was 0.25px (under tolerance), but
// `normal` resolves differently across platforms so the text sat visibly lower for the
// reviewer. The fix: capture `font.strut` = the nearest line-box container's
// line-height and compare it in --visual — `normal` vs a number is a technique mismatch
// that fails loudly regardless of the sub-pixel same-machine delta. LEARNINGS #17.
const { diffSnapshots } = require("../../tools/pixel-diff.js");
let bad = 0; const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

// minimal text target: leaf line-height matches (12 vs 12); only the strut varies
const el = (strut) => ({
  present: true,
  rect: { x: 30, y: 10, w: 300, h: 20, top: 10, right: 330, bottom: 30 },
  font: { weight: "700", size: 13.33, line: 12, spacing: "normal", transform: "none",
    color: "rgb(0, 0, 0)", decoration: "none", smoothing: "auto",
    ...(strut === undefined ? {} : { strut }) },
  box: {}, layout: {}, parent: null,
  text: { x: 30, right: 330, top: 11.5, bottom: 28, w: 300, h: 16.5 },
  underline: { present: false },
  bg: "rgb(255, 102, 0)",
});
const snap = (e) => ({ viewport: { width: 1512 }, elements: { title: e } });

// 1) authored strut (16px) vs `normal` must FAIL on font.strut — the exact HN defect
{
  const res = diffSnapshots(snap(el(16)), snap(el("normal")), { visual: true });
  check("gate catches strut mismatch (16 vs normal) even when the leaf line matches", !res.ok && res.rows.some((r) => !r.pass && r.prop === "font.strut"));
}
// 2) two different NUMBERS over tolerance must fail too (16 vs 18)
{
  const res = diffSnapshots(snap(el(16)), snap(el(18)), { visual: true });
  check("gate catches numeric strut delta (16 vs 18)", !res.ok && res.rows.some((r) => !r.pass && r.prop === "font.strut"));
}
// 3) identical struts pass (no false positive)
{
  const res = diffSnapshots(snap(el(16)), snap(el(16)), { visual: true });
  check("identical strut passes", res.ok);
}
// 4) both `normal` passes — same technique on both sides is a match
{
  const res = diffSnapshots(snap(el("normal")), snap(el("normal")), { visual: true });
  check("normal-vs-normal passes (same technique)", res.ok);
}
// 5) schema back-compat: a capture that predates strut (undefined) must add NO strut row
{
  const res = diffSnapshots(snap(el(undefined)), snap(el(16)), { visual: true });
  check("old-schema snapshot adds no strut row (no mixed-capture false positive)", res.ok && !res.rows.some((r) => r.prop === "font.strut"));
}

process.exit(bad ? 1 : 0);
