// fixtures/34-settle-instant-scroll.js — THE SWEEP NEVER MOVED, AND REPORTED A SETTLED PAGE.
//
// Paid for on chrono24 (2026-07-13), which ships `html { scroll-behavior: smooth }`.
//
// pxScrollSettle walked the page with `scrollTo(0, y)`. That call OBEYS THE PAGE'S CSS: with
// scroll-behavior:smooth the browser turns each step into an rAF-driven ANIMATION. Two things then
// go wrong, and the second is fatal:
//   1. the sweep's fixed `pause` races the animation — a step may be measured mid-flight;
//   2. when rAF is throttled (a background or hidden tab — the NORMAL condition under browser
//      automation, since the agent's own tab is rarely the focused one) the animation never runs,
//      so the scroll NEVER LANDS.
//
// Measured live: with scrollY at 7743, `window.scrollTo(0, 1000)` left scrollY at 7743 — unmoved —
// while `window.scrollTo({top: 1000, behavior: "instant"})` landed at exactly 1000.
//
// So the sweep visited nothing. No IntersectionObserver fired, no lazy image was kicked, no
// below-fold section mounted. And the height watch then found the height perfectly stable — OF
// COURSE it was stable: NOTHING SCROLLED — so settle returned `stable: true` over a page it had
// never visited. Every downstream artifact (dom.html, live.json, the leaf enumeration, the review
// round) is built on that word.
//
// This is LEARNINGS #22 in a new coat: a probe that cannot fire the mechanism it is probing must
// never be allowed to report success. The instrument's scroll is not a user gesture to be
// animated — it is a measurement, and a measurement must be exact.
//
// NARROW BY CONSTRUCTION: the only change is HOW the sweep scrolls (behavior:"instant"). It does
// not touch what counts as settled, and control 3 proves a page that already scrolled fine still
// scrolls fine.
"use strict";
let bad = 0;
const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

const CAPTURE = require.resolve("../../tools/browser-capture.js");
const FAST = { pause: 1, settle: 1, stableGapMs: 1, stableChecks: 3, maxSweeps: 4, imageWaitMs: 10 };

// A page whose below-fold section only mounts once the sweep has REALLY scrolled past 2000px —
// and whose CSS may make a non-instant scroll a no-op (the smooth-scroll animation never landing).
function loadSettle({ smoothCss }) {
  const state = { reached: 0 };
  global.window = global;
  global.document = {
    get documentElement() {
      return { get scrollHeight() { return state.reached > 2000 ? 5000 : 3000; } };
    },
    images: [],
    querySelectorAll: () => [],
  };
  global.innerHeight = 900;
  global.scrollTo = (a, b) => {
    const opts = typeof a === "object" && a !== null ? a : null;
    const instant = opts ? opts.behavior === "instant" : false;
    const y = opts ? opts.top : b;
    if (smoothCss && !instant) return;              // the smooth animation never lands
    if (typeof y === "number" && y > state.reached) state.reached = y;
  };
  global.getComputedStyle = () => ({ display: "block" });
  delete require.cache[CAPTURE];
  require(CAPTURE);
  return { settle: global.pxScrollSettle, state };
}

(async () => {
  // ── 1+2. THE DEFECT — a smooth-scrolling page. The sweep must still reach the content ──
  // FAILS WITHOUT THE CHANGE: the old scrollTo(0,y) never lands, so reached stays 0, the lazy
  // section never mounts, and settle reports the pre-lazy height 3000 as a stable page.
  {
    const { settle, state } = loadSettle({ smoothCss: true });
    const r = await settle(FAST);
    check("on a `scroll-behavior: smooth` page the sweep ACTUALLY SCROLLS (instant, not animated)",
      state.reached > 2000);
    check("…so the lazy below-fold section mounts and settle reports the REAL height (5000, not 3000)",
      r.scrolledTo === 5000);
  }

  // ── 3. CONTROL — a page with no smooth CSS scrolled fine before; it must still ────────
  {
    const { settle, state } = loadSettle({ smoothCss: false });
    const r = await settle(FAST);
    check("CONTROL: a normal (auto-scroll) page still sweeps and still reports its true height",
      state.reached > 2000 && r.scrolledTo === 5000);
  }

  // ── 4. CONTROL — the settle must still return to the TOP when it is done. Sticky headers
  //      change class/geometry mid-scroll, so a capture taken at the bottom is a different page.
  {
    const { settle } = loadSettle({ smoothCss: true });
    let lastY = null;
    const realScrollTo = global.scrollTo;
    global.scrollTo = (a, b) => { const o = typeof a === "object" && a ? a : null; lastY = o ? o.top : b; realScrollTo(a, b); };
    await settle(FAST);
    check("CONTROL: the sweep still returns to the top when done (sticky headers depend on it)", lastY === 0);
  }

  console.log(bad ? `\n✗ ${bad} check(s) failed` : "\n✓ 34-settle-instant-scroll: the sweep's scroll is a measurement, and it lands.");
  process.exit(bad ? 1 : 0);
})();
