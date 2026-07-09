// fixtures/03-compat-mode.js — the rendering MODE is a pixel-determining property of the
// whole page. Found on the HN header (flagged, round 3): live HN ships NO doctype →
// quirks mode ("BackCompat"); the clone's `<!doctype html>` → standards mode. Quirks
// computes table-cell line boxes differently, so the login line sat 0.25px lower with
// EVERY computed style byte-identical — no element-level property could ever catch it.
// The fix: capture `mode` (document.compatMode) in the snapshot root and fail loudly on a
// mismatch. LEARNINGS #18.
const { diffSnapshots } = require("../../tools/pixel-diff.js");
let bad = 0; const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

const el = () => ({
  present: true,
  rect: { x: 30, y: 10, w: 300, h: 20, top: 10, right: 330, bottom: 30 },
  font: { weight: "400", size: 13.33, line: 12, spacing: "normal", transform: "none",
    color: "rgb(0, 0, 0)", decoration: "none", smoothing: "auto", strut: 16 },
  box: {}, layout: {}, parent: null,
  text: { x: 30, right: 330, top: 11.5, bottom: 28, w: 300, h: 16.5 },
  underline: { present: false },
  bg: "rgb(255, 102, 0)",
});
const snap = (mode) => ({ viewport: { width: 1512 }, ...(mode ? { mode } : {}), elements: { title: el() } });

// 1) quirks vs standards must FAIL on page.mode — the exact HN defect
{
  const res = diffSnapshots(snap("BackCompat"), snap("CSS1Compat"), { visual: true });
  check("gate catches quirks-vs-standards mode mismatch", !res.ok && res.rows.some((r) => !r.pass && r.target === "page" && r.prop === "mode"));
}
// 2) same mode on both sides passes
{
  const res = diffSnapshots(snap("BackCompat"), snap("BackCompat"), { visual: true });
  check("same mode passes", res.ok);
}
// 3) schema back-compat: a capture that predates `mode` adds NO row (no false positive)
{
  const res = diffSnapshots(snap(null), snap("BackCompat"), { visual: true });
  check("old-schema snapshot adds no mode row", res.ok && !res.rows.some((r) => r.prop === "mode"));
}
// 4) strict mode fails on it too (it's a defect in both modes of the diff)
{
  const res = diffSnapshots(snap("BackCompat"), snap("CSS1Compat"), {});
  check("strict also fails on mode mismatch", !res.ok && res.rows.some((r) => !r.pass && r.prop === "mode"));
}

process.exit(bad ? 1 : 0);
