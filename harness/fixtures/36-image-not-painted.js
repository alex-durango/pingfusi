// fixtures/36-image-not-painted.js — THE BOX IS NOT THE IMAGE.
//
// Paid for on chrono24 (2026-07-13), and it is the miss a fully green sweep did not catch:
// --visual 0/5911, strict 0/18770, coverage 396/396, behavior PASS, clone-lint clean — and the
// FIRST thing the reviewer said was "the images are not rendered".
//
// Ten watch photos in the "our most popular models" grid failed to load in the clone. They rendered
// as grey holes. The gate never saw it, because an <img> that 404s but whose size comes from CSS is
// IDENTICAL, in every property the snapshot recorded, to the real photo:
//
//     box (rect/glyph cx,cy,w,h)  272 x 332   — same (CSS sizes it)
//     bg, present, layout, font   same
//     naturalWidth                0           — NEVER RECORDED
//
// Reproduced against the real captures: the OLD gate passes the broken clone 0/6002; the NEW gate
// fails it 10/6091, naming img_80…img_101 `glyph.painted live=true clone=false`. That pair is
// frozen in the corpus as `image-not-painted`.
//
// TWO defects, one symptom — both are fixed and both are tested here:
//   1. THE GATE was blind: an image's PIXELS are a painted mark and nothing measured them.
//      `complete && naturalWidth > 0` is the whole test.
//   2. THE BUILD broke the URL: capture-build did `srcset.split(",")`, but a candidate URL MAY
//      CONTAIN COMMAS. Cloudflare's image resizer puts them in the path —
//      `/cdn-cgi/image/f=auto,metadata=none,q=85/…` — so one URL was shattered into three
//      fragments, each then resolved against the page origin into garbage
//      (`https://www.chrono24.com/metadata=none`). The browser picked a garbage candidate and it
//      404'd.
//
// NARROW BY CONSTRUCTION: `painted` is compared as a BOOLEAN and only when BOTH captures recorded
// it. naturalW/naturalH are recorded for diagnosis but never gated — live and the clone may settle
// on different srcset candidates (1x vs 2x) and still paint identically (control 4). And an image
// broken on BOTH sides is a MATCH, not a defect: the clone is faithfully reproducing a broken image,
// which is the site's real rendering (control 3, the #25 rule).
"use strict";
let bad = 0;
const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

// ── 1. THE GATE — a live image that paints vs a clone image that doesn't ─────────────
{
  const { diffSnapshots } = require("../../tools/pixel-diff.js");
  const gfx = (glyph) => ({
    present: true,
    rect: { x: 100, y: 79, w: 272, h: 332, top: 79, right: 372, bottom: 411, fromRight: 200 },
    font: {}, box: {}, layout: { display: "block", position: "static" }, parent: { display: "flex", gap: 8 },
    glyph: { cx: 236, cy: 245, w: 272, h: 332, bgPos: "0% 0%", ...glyph },
    bg: "rgb(255,255,255)",
  });
  const snap = (el) => ({ viewport: { width: 1728, height: 941 }, mode: "CSS1Compat", elements: { img_80: el } });
  const visual = (l, c) => diffSnapshots(snap(l), snap(c), { visual: true });

  // FAILS WITHOUT THE CHANGE: every other property matches, so the old gate reported 0 failures.
  const holes = visual(gfx({ painted: true }), gfx({ painted: false }));
  check("--visual FAILS a clone whose image did not paint (live=true, clone=false)", !holes.ok);
  check("…and the failing row names `glyph.painted`, so the operator knows it is the PIXELS, not the box",
    holes.rows.some((r) => !r.pass && r.prop === "glyph.painted"));
  check("…while the BOX itself still matches (proving the box could never have caught this)",
    !holes.rows.some((r) => !r.pass && /^glyph\.(cx|cy|w|h)$/.test(r.prop)));

  // 2. CONTROL — both painted → pass.
  check("CONTROL: both sides painted → pass", visual(gfx({ painted: true }), gfx({ painted: true })).ok);

  // 3. CONTROL — broken on BOTH. The clone faithfully reproduces a broken image; that IS the site's
  //    rendering (#25). Flagging it would be inventing a defect on a correct clone.
  check("CONTROL: an image broken on BOTH sides is a MATCH, not a hole (#25)",
    visual(gfx({ painted: false }), gfx({ painted: false })).ok);

  // 4. CONTROL — different srcset candidate (2x vs 1x): both paint, natural sizes differ. Must pass;
  //    gating naturalW/H would fail a clone that renders identically.
  check("CONTROL: live 2x vs clone 1x candidate — both paint, natural sizes differ → pass",
    visual(gfx({ painted: true, naturalW: 544, naturalH: 664 }), gfx({ painted: true, naturalW: 272, naturalH: 332 })).ok);

  // 5. CONTROL — an OLD capture that predates `painted` must not be retro-failed.
  check("CONTROL: a snapshot predating `painted` is skipped, not failed (old-schema)",
    visual(gfx({}), gfx({ painted: true })).ok && visual(gfx({ painted: true }), gfx({})).ok);

  // 6. CONTROL — a NON-image graphic (an svg icon) carries no `painted` field at all and is untouched.
  check("CONTROL: an <svg> glyph (no `painted` field) compares exactly as before",
    visual(gfx({ src: "svg-path" }), gfx({ src: "svg-path" })).ok);
}

// ── 2. THE BUILD — srcset must survive a URL that contains commas ────────────────────
{
  const { parseSrcset } = require("../../harness/capture-build.js");
  check("capture-build exports parseSrcset (the parse is testable without a browser)",
    typeof parseSrcset === "function");

  if (typeof parseSrcset === "function") {
    // THE CHRONO24 SHAPE — Cloudflare image-resizing options are comma-separated INSIDE the path.
    // FAILS WITHOUT THE CHANGE: `split(",")` yields 6 garbage fragments instead of 2 candidates.
    const cf = "https://cdn2.chrono24.com/cdn-cgi/image/f=auto,metadata=none,q=85/images/topmodels/45-x-Main.png 1x, " +
               "https://cdn2.chrono24.com/cdn-cgi/image/f=auto,metadata=none,q=65/images/topmodels/45-x-Main_2x.png 2x";
    const got = parseSrcset(cf);
    check("a candidate URL containing COMMAS survives (Cloudflare /cdn-cgi/image/f=auto,q=85/…)",
      got.length === 2 &&
      got[0].url === "https://cdn2.chrono24.com/cdn-cgi/image/f=auto,metadata=none,q=85/images/topmodels/45-x-Main.png" &&
      got[1].url === "https://cdn2.chrono24.com/cdn-cgi/image/f=auto,metadata=none,q=65/images/topmodels/45-x-Main_2x.png");
    check("…and its descriptors are preserved (1x / 2x)", got[0].desc === "1x" && got[1].desc === "2x");
    check("…and NO fragment is produced that would resolve against the page origin (the 404 garbage)",
      !got.some((c) => /^(metadata=|q=\d|f=auto)/.test(c.url)));

    // CONTROLS — ordinary srcsets must parse exactly as before.
    const plain = parseSrcset("/a.png 1x, /b.png 2x");
    check("CONTROL: an ordinary 1x/2x srcset is unchanged",
      plain.length === 2 && plain[0].url === "/a.png" && plain[1].desc === "2x");
    const widths = parseSrcset("a.jpg 480w, b.jpg 800w, c.jpg 1200w");
    check("CONTROL: width descriptors are unchanged",
      widths.length === 3 && widths[2].url === "c.jpg" && widths[2].desc === "1200w");
    const bare = parseSrcset("/a.png, /b.png");
    check("CONTROL: comma-separated candidates with NO descriptor still split correctly",
      bare.length === 2 && bare[0].url === "/a.png" && bare[1].url === "/b.png" && bare[0].desc === "");
    const single = parseSrcset("only.png");
    check("CONTROL: a single candidate with no descriptor", single.length === 1 && single[0].url === "only.png");
    check("CONTROL: empty srcset yields no candidates", parseSrcset("").length === 0);
  }
}

console.log(bad ? `\n✗ ${bad} check(s) failed` : "\n✓ 36-image-not-painted: an image's PIXELS are gated, and a comma in a URL no longer breaks it.");
process.exit(bad ? 1 : 0);
