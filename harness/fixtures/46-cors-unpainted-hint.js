// fixtures/46-cors-unpainted-hint.js — THE ROW WAS RIGHT AND THE AGENT STILL HAND-DEBUGGED IT.
//
// Paid for on bizar.ro (2026-07-20, kit 0.9.0). The clone kept cross-origin <img> srcs with
// their crossorigin attributes, so on localhost Chrome fetched them in CORS mode, the CDN sent
// no ACAO for that origin, and Chrome REFUSED TO PAINT — grey holes over a box-identical page.
// The gate's `glyph.painted live=true clone=false` row (fixture 36) caught it… as a bare
// boolean. Nothing named the cause, so the fix was a hand fixup instead of the one command
// that repairs the whole class (capture-build now self-hosts media and drops crossorigin —
// capture-build-selftest locks that half).
//
// This locks the DIAGNOSIS half: a failing glyph.painted row in the live-true/clone-false
// direction must carry a warning that names the cross-origin/CORS cause and the capture-build
// remedy. Direction matters: clone-painted/live-broken is a different defect (the clone
// invented an image), and both-false is a MATCH (#25) — neither may emit the CORS hint.
"use strict";
let bad = 0;
const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

const { diffSnapshots } = require("../../tools/pixel-diff.js");
const gfx = (glyph) => ({
  present: true,
  rect: { x: 100, y: 79, w: 272, h: 332, top: 79, right: 372, bottom: 411, fromRight: 200 },
  font: {}, box: {}, layout: { display: "block", position: "static" }, parent: { display: "flex", gap: 8 },
  glyph: { cx: 236, cy: 245, w: 272, h: 332, bgPos: "0% 0%", ...glyph },
  bg: "rgb(255,255,255)",
});
const snap = (el) => ({ viewport: { width: 1728, height: 941 }, mode: "CSS1Compat", elements: { hero_img: el } });
const visual = (l, c) => diffSnapshots(snap(l), snap(c), { visual: true });

// FAILS WITHOUT THE CHANGE: the row existed, the cause did not.
const holes = visual(gfx({ painted: true }), gfx({ painted: false }));
const hint = holes.warnings.find((w) => /hero_img/.test(w));
check("live-true/clone-false emits a warning naming the element", !!hint);
check("…the warning names the CORS/cross-origin cause", !!hint && /cross-origin/i.test(hint) && /CORS/.test(hint));
check("…and the remedy: re-run capture-build (self-hosts media, drops crossorigin)",
  !!hint && /capture-build/.test(hint) && /assets\/media/.test(hint) && /crossorigin/.test(hint));
check("…while the row itself still fails (the hint explains, never replaces, the row)",
  holes.rows.some((r) => !r.pass && r.prop === "glyph.painted"));

// CONTROLS — no hint in any other painted combination.
check("CONTROL: both painted → no CORS hint", !visual(gfx({ painted: true }), gfx({ painted: true })).warnings.some((w) => /CORS/.test(w)));
check("CONTROL: broken on BOTH sides (a faithful broken image, #25) → no CORS hint",
  !visual(gfx({ painted: false }), gfx({ painted: false })).warnings.some((w) => /CORS/.test(w)));
check("CONTROL: clone painted where live is broken (reverse direction) → no CORS hint",
  !visual(gfx({ painted: false }), gfx({ painted: true })).warnings.some((w) => /CORS/.test(w)));
check("CONTROL: a snapshot predating `painted` → no CORS hint",
  !visual(gfx({}), gfx({ painted: false })).warnings.some((w) => /CORS/.test(w)));

process.exit(bad ? 1 : 0);
