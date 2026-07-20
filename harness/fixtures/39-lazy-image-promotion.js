// fixtures/39-lazy-image-promotion.js — A GATE MAY DEMAND ONLY WHAT THE PAGE CAN PROVIDE.
//
// Paid for on mindmarket (2026-07-17). The client-logo belt ships loading="lazy" logos whose
// boxes are ZERO-WIDTH until the bytes arrive (height attr only, width:auto). Chrome's lazy
// loader never fires for a box it never sees intersect — so `complete` stays false FOREVER,
// the image-readiness wait (fixture 32) times out identically on every run, and the settle
// refusal becomes a DEADLOCK: capture-run can never proceed, on a page every real visitor
// loads fine. That is LEARNINGS #32's shape on a new axis: the gate demanded a state the page
// cannot reach on its own.
//
// The fix PROVIDES the state instead of waiting for it: stuck lazy images are promoted to
// eager (the fetch fires immediately, no intersection needed), the network gets one more
// bounded window, and the loading attribute is put back so dom.html ships byte-identical to
// live (#24/#29: the instrument must not bake itself into the artifact). The refusal is NOT
// weakened: a promoted image that still never completes refuses the capture exactly as before.
"use strict";
let bad = 0;
const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

const CAPTURE = require.resolve("../../tools/browser-capture.js");
const FAST = { pause: 1, settle: 1, stableGapMs: 1, stableChecks: 3, maxSweeps: 4, imageWaitMs: 30 };

// A lazy image the loader will never reach: zero-width box, complete flips true ONLY when the
// promotion assigns loading="eager" (loadsOnPromotion), or never (a genuinely dead fetch).
const lazyImg = ({ loadsOnPromotion, src = "logo.png" }) => {
  const attrs = { loading: "lazy" };
  const im = {
    complete: false, src, currentSrc: src,
    getClientRects: () => [{ width: 0, height: 100 }],   // zero-width box IS a layout box
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = v; },
    removeAttribute: (k) => { delete attrs[k]; },
    attrs,
  };
  Object.defineProperty(im, "loading", {
    get: () => attrs.loading,
    set: (v) => { attrs.loading = v; if (v === "eager" && loadsOnPromotion) im.complete = true; },
  });
  return im;
};
const plainImg = ({ complete, src = "x.svg" }) => ({
  complete, src, currentSrc: src,
  getClientRects: () => [{ width: 32, height: 32 }],
});

function loadSettle(images) {
  global.window = global;
  global.document = {
    documentElement: { get scrollHeight() { return 3000; } },
    images,
    querySelectorAll: () => [],
  };
  global.innerHeight = 900;
  global.scrollTo = () => {};
  global.getComputedStyle = () => ({ display: "block" });
  delete require.cache[CAPTURE];
  require(CAPTURE);
  return global.pxScrollSettle;
}

(async () => {
  // ── 1. THE DEFECT — a structurally-unloadable lazy image no longer deadlocks the capture ──
  // FAILS WITHOUT THE CHANGE: the old settle waited imageWaitMs and refused, run after run.
  {
    const belt = lazyImg({ loadsOnPromotion: true, src: "logo-moet-chandon.png" });
    const settle = loadSettle([plainImg({ complete: true }), belt]);
    const r = await settle(FAST);
    check("a stuck lazy image is PROMOTED to eager, loads, and the page settles", r.stable === true && r.imagesPending === 0);
    check("…the intervention is RECEIPTED (lazyPromoted count + srcs name the image)",
      r.lazyPromoted === 1 && Array.isArray(r.lazyPromotedSrcs) && /moet-chandon/.test(r.lazyPromotedSrcs.join(",")));
    check("…and the loading attribute is RESTORED — dom.html ships byte-identical to live",
      belt.attrs.loading === "lazy" && belt.complete === true);
  }

  // ── 2. CONTROL — promotion is not absolution: a promoted image that still never completes
  //      refuses the capture exactly as before (eager-and-in-flight = the page is not ready).
  {
    const settle = loadSettle([lazyImg({ loadsOnPromotion: false, src: "dead.png" })]);
    const r = await settle(FAST);
    check("CONTROL: a promoted image that STILL never loads refuses the capture (stable:false)",
      r.stable === false && r.imagesPending === 1 && r.lazyPromoted === 1);
  }

  // ── 3. CONTROL — only loading=\"lazy\" is promoted. An eager image still in flight is the
  //      network's business, not the loader's: the kit must wait/refuse, never touch it.
  {
    const settle = loadSettle([plainImg({ complete: false, src: "slow-hero.jpg" })]);
    const r = await settle(FAST);
    check("CONTROL: an in-flight NON-lazy image is never promoted (refusal intact, 0 promoted)",
      r.stable === false && r.imagesPending === 1 && r.lazyPromoted === 0);
  }

  // ── 4. CONTROL — fixture 32's rules are untouched: no pending images → no promotion,
  //      stable verdict, no invented receipt.
  {
    const settle = loadSettle([plainImg({ complete: true }), plainImg({ complete: true })]);
    const r = await settle(FAST);
    check("CONTROL: nothing pending → nothing promoted, stable, no invented receipt",
      r.stable === true && r.imagesPending === 0 && r.lazyPromoted === 0);
  }

  console.log(bad ? `\n✗ ${bad} check(s) failed` : "\n✓ 39-lazy-image-promotion: the kit provides the state the gate demands — and refuses exactly as before when it can't.");
  process.exit(bad ? 1 : 0);
})();
