// fixtures/32-settle-image-readiness.js — HEIGHT HOLDING STILL IS NOT THE PAGE BEING READY.
//
// Paid for on chrono24 (2026-07-13). pxScrollSettle proves the document STOPPED GROWING — which
// catches an async section mounting late (#19/gorjana, fixture 30). It says nothing about whether
// the page has finished LOADING. A lazy <img> that has not arrived yet moves no height at all: it
// is a ZERO-WIDTH box that reflows its row the moment its bytes land.
//
// Measured: the footer QR code <img loading="lazy" height="90"> (no width attr) was still
// `complete:false` when settle returned `stable:true`. So live.json recorded it at w=0, and the
// two app-store badges beside it were measured 90px to the LEFT of where any real user sees them.
// The clone loaded the same image correctly — and the gate reported an 90px "defect" against the
// CLONE for a shift the clone did not cause. The reference was a page state that never existed
// (LEARNINGS #20: the reference must be the site, not the instrument's accident).
//
// The settle is the kit's readiness oracle. If it says "stable", every downstream artifact —
// dom.html, live.json, the leaf enumeration, the review round — is built on that word.
//
// NARROW BY CONSTRUCTION:
//   • `complete` is the predicate, NOT naturalWidth. A genuine 404 settles to complete=true with
//     naturalWidth 0, and its zero box IS the site's real rendering — the clone must reproduce it,
//     not wait for it. Only `!complete` means "in flight, this box is provisional". (Check 4.)
//   • RENDERED images only. A never-loading display:none tracking pixel cannot reflow anything;
//     refusing a capture over one would block every page that ships analytics. (Check 5.)
"use strict";
let bad = 0;
const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

const CAPTURE = require.resolve("../../tools/browser-capture.js");
const FAST = { pause: 1, settle: 1, stableGapMs: 1, stableChecks: 3, maxSweeps: 4, imageWaitMs: 30 };

// `rendered` = the image has a LAYOUT BOX. False for a display:none image AND for one inside a
// display:none ANCESTOR — and note that the latter's OWN computed display is still "block", which
// is precisely why the box, not the computed display, is the honest test.
const img = ({ complete, rendered = true, src = "x.svg" }) => ({
  complete, src, currentSrc: src,
  getClientRects: () => (rendered ? [{ width: 32, height: 32 }] : []),
});

// A document that never grows (the height watch is perfectly happy) but whose images may be in flight.
function loadSettle(images) {
  global.window = global;
  global.document = {
    documentElement: { get scrollHeight() { return 3000; } },
    images,
    querySelectorAll: () => [],
  };
  global.innerHeight = 900;
  global.scrollTo = () => {};
  global.getComputedStyle = () => ({ display: "block" });   // as it is for an element under a hidden ancestor
  delete require.cache[CAPTURE];
  require(CAPTURE);
  return global.pxScrollSettle;
}

(async () => {
  // ── 1+2. THE DEFECT — a rendered image still in flight means the page is NOT ready ─────
  // FAILS WITHOUT THE CHANGE: the old settle watched only the height, which never moved here, so
  // it returned stable:true (and had no imagesPending field at all).
  {
    const settle = loadSettle([img({ complete: true }), img({ complete: false, src: "footer-app-qr-code.svg" })]);
    const r = await settle(FAST);
    check("a lazy <img> still in flight is REPORTED — settle counts it (imagesPending)", r.imagesPending === 1);
    check("…and settle REFUSES to call the page stable (a provisional box is not a settled page)", r.stable === false);
    check("…and it names the image, so the operator can see what is pending",
      Array.isArray(r.pendingImageSrcs) && /footer-app-qr-code/.test(r.pendingImageSrcs.join(",")));
  }

  // ── 3. CONTROL — every image landed: the page IS ready, no alarm invented ──────────────
  {
    const settle = loadSettle([img({ complete: true }), img({ complete: true })]);
    const r = await settle(FAST);
    check("CONTROL: all images loaded → stable, 0 pending (no invented alarm)",
      r.stable === true && r.imagesPending === 0);
  }

  // ── 4. CONTROL — a BROKEN image (404) is complete:true. Its zero box is the site's real
  //      rendering; the clone must reproduce it, not wait forever for it.
  {
    const settle = loadSettle([img({ complete: true, src: "404.svg" })]);
    const r = await settle(FAST);
    check("CONTROL: a 404 image (complete:true, 0x0) does NOT block the capture — that zero box IS the site",
      r.stable === true && r.imagesPending === 0);
  }

  // ── 5. CONTROL — the false-positive hunter: a never-loading image that RENDERS NOTHING.
  //      It can never reflow the page. If this blocked a capture, no page shipping analytics —
  //      or a closed menu — could ever be cloned.
  //
  //      This control is here because the first cut of the rule GOT IT WRONG on the real site.
  //      It asked `getComputedStyle(img).display !== "none"`, and chrono24's one never-loading
  //      image was a 32x32 badge inside `#js-header-security-flyout` — a display:none flyout
  //      EIGHT levels up. The image's own computed display is "block" (an ancestor's display:none
  //      does not propagate into the child's computed value), so the naive rule counted it and
  //      refused the capture forever. Hidden flyouts, closed menus and offscreen templates hold
  //      pending images on most real sites. The layout box is the honest test.
  {
    const settle = loadSettle([img({ complete: true }), img({ complete: false, rendered: false, src: "pixel.gif" })]);
    const r = await settle(FAST);
    check("CONTROL: a pending image that renders nothing does NOT block the capture (no layout box)",
      r.stable === true && r.imagesPending === 0);
  }
  {
    // the exact chrono24 shape: pending image inside a display:none ANCESTOR (its own display is "block")
    const settle = loadSettle([img({ complete: true }), img({ complete: false, rendered: false, src: "certified-filled-inverted.svg" })]);
    const r = await settle(FAST);
    check("CONTROL: a pending image inside a CLOSED FLYOUT (display:none ancestor) does NOT block the capture",
      r.stable === true && r.imagesPending === 0);
  }

  // ── 6. #19 STILL HOLDS — the height watch is not weakened by any of this ───────────────
  {
    global.window = global;
    let reads = 0, height = 4439;
    global.document = {
      documentElement: { get scrollHeight() { reads++; if (reads > 8) height = 5877; return height; } },
      images: [],
      querySelectorAll: () => [],
    };
    global.innerHeight = 900;
    global.scrollTo = () => {};
    global.getComputedStyle = () => ({ display: "block" });
    delete require.cache[CAPTURE];
    require(CAPTURE);
    const r = await global.pxScrollSettle(FAST);
    check("#19 HOLDS: a page that GREW after the walk is still caught (height watch intact)",
      r.scrolledTo === 5877 || r.stable === false);
  }

  console.log(bad ? `\n✗ ${bad} check(s) failed` : "\n✓ 32-settle-image-readiness: settle proves the page is LOADED, not merely done growing.");
  process.exit(bad ? 1 : 0);
})();
