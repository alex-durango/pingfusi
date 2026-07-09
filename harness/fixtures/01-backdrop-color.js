// fixtures/01-backdrop-color.js — a painted BACKDROP colour (announcement bar /
// button / badge) is a mark the gate must compare. Found on aloyoga: the blue
// announcement bar lives on a CONTAINER, not the text leaf, so `background-color`
// was never captured — a bright-red bar passed a green --visual (the red-bar
// snapshot was byte-identical to the good one). The fix: capture `bg` = the nearest
// painted background behind each mark (transparent chain → the white canvas), and
// compare it in --visual. This fixture fails WITHOUT that comparison.
const { diffSnapshots } = require("../../tools/pixel-diff.js");
let bad = 0; const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

// minimal text target carrying a painted backdrop colour
const el = (bg) => ({
  present: true,
  rect: { x: 15, y: 15, w: 1698, h: 20, top: 15, right: 1713, bottom: 35 },
  font: { weight: "600", size: 14, color: "rgb(0, 0, 0)" },
  box: {}, layout: {}, parent: null,
  text: { x: 522, right: 1205, top: 16, bottom: 35, w: 683, h: 19 },
  underline: { present: false },
  bg,
});
const snap = (e) => ({ viewport: { width: 1728 }, elements: { announce: e } });

// 1) a wrong backdrop colour (live blue bar vs a red clone bar) must FAIL on `bg`
{
  const res = diffSnapshots(snap(el("rgb(113, 198, 235)")), snap(el("rgb(255, 0, 0)")), { visual: true });
  check("gate catches wrong backdrop colour", !res.ok && res.rows.some((r) => !r.pass && r.prop === "bg"));
}
// 2) an identical backdrop must PASS (no false positive)
{
  const res = diffSnapshots(snap(el("rgb(113, 198, 235)")), snap(el("rgb(113, 198, 235)")), { visual: true });
  check("identical backdrop passes", res.ok);
}
// 3) transparent-on-both must be SKIPPED (text/icons on the canvas add no noise)
{
  const res = diffSnapshots(snap(el("rgba(0, 0, 0, 0)")), snap(el("rgba(0, 0, 0, 0)")), { visual: true });
  check("transparent backdrop adds no bg row", res.ok && !res.rows.some((r) => r.prop === "bg"));
}
// 4) TRANSLUCENT backdrops are out of scope — the gate compares only OPAQUE colours
// (a translucent layer composites to pixels we can't reconstruct from the string, so
// comparing it would false-positive a translucent-vs-solid pair that looks identical).
{
  const res = diffSnapshots(snap(el("rgba(0, 0, 0, 0.5)")), snap(el("rgb(128,128,128)")), { visual: true });
  check("translucent-vs-solid adds no bg row (no false positive)", res.ok && !res.rows.some((r) => r.prop === "bg"));
}
// 5) whitespace in the colour string must not matter ("rgb(0,0,0)" == "rgb(0, 0, 0)")
{
  const res = diffSnapshots(snap(el("rgb(113,198,235)")), snap(el("rgb(113, 198, 235)")), { visual: true });
  check("colour compare is whitespace-insensitive", res.ok);
}

process.exit(bad ? 1 : 0);
