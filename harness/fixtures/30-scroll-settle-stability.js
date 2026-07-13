// fixtures/30-scroll-settle-stability.js — REACHING THE BOTTOM IS NOT BEING SETTLED.
//
// THE MISS (gorjana, 2026-07-13) — and it is the one a fully green sweep did not catch.
// pxScrollSettle walked down until `y + innerHeight >= scrollHeight` and returned. But a section
// that mounts ASYNCHRONOUSLY (fetched after load, hydrated by a framework) lands a beat AFTER the
// walk passes its slot. Measured: settle reported `scrolledTo: 4439`; moments later the live
// document was **5877px** — a Shopify product-recommendations carousel (23 product tiles, 25
// swipers, a 583px slider) had hydrated into `<div data-vue="recommendations">`.
//
// The DOM was captured in that window, so the clone shipped an EMPTY mount point. And the leaf
// enumeration is derived from the same captured DOM — so the missing section was never enumerated,
// and every gate passed over a page with a hole in it:
//     --visual 1300/1300 ✓   strict 4144/4144 ✓   coverage 88/88 ✓
// Re-capturing after a STABLE settle found **184** painted leaves. The gates had been green over
// less than half the page's painted content. A gate cannot see what was never enumerated — which
// makes the capture, not the diff, the load-bearing instrument (LEARNINGS #19/#23).
//
// THE FIX: sweep, then require the document height to HOLD STILL across consecutive checks; if it
// grew, sweep again (the new content may itself lazy-load). Bounded — and the evidence is
// RETURNED: `stable:false` means the page was still growing when we gave up, and a DOM captured
// then is not the page. An unbounded wait would just trade a silent miss for a silent hang.
"use strict";
let bad = 0; const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

// ── DOM shim: a document whose scrollHeight can grow under us, like a hydrating page ──
function shim({ startHeight, grownHeight, growAfterReads = 0, foreverGrowing = false }) {
  let reads = 0, height = startHeight;
  const doc = {
    get documentElement() {
      return {
        get scrollHeight() {
          reads++;
          if (foreverGrowing) return (height += 100);          // never settles
          if (growAfterReads && reads > growAfterReads) height = grownHeight;
          return height;
        },
      };
    },
    querySelectorAll: () => [],   // frozenOpacity0 → 0
  };
  return doc;
}

const KIT_CAPTURE = "../../tools/browser-capture.js";
function loadSettle(document_) {
  const prevWindow = global.window, prevDoc = global.document;
  global.window = global;                       // browser-capture binds to `window` when present
  global.document = document_;
  global.innerHeight = 900;
  global.scrollTo = () => {};
  delete require.cache[require.resolve(KIT_CAPTURE)];
  require(KIT_CAPTURE);
  const settle = global.pxScrollSettle;
  return { settle, restore: () => { global.window = prevWindow; global.document = prevDoc; } };
}

// fast timings — the mechanism is what's under test, not the wall clock
const FAST = { pause: 1, settle: 1, stableGapMs: 1, stableChecks: 3, maxSweeps: 4 };

async function main() {
  // 1) THE GORJANA SHAPE — the page grows AFTER the first sweep reaches the bottom.
  //    Pre-fix: returns scrolledTo 4439 (the pre-hydration height) and the carousel is not in the
  //    DOM you capture. Post-fix: it notices the growth, re-sweeps, and reports the real page.
  {
    // grows once the first sweep has reached the bottom and started watching — exactly when the
    // real carousel hydrated (after the walk had already passed its slot).
    const { settle, restore } = loadSettle(shim({ startHeight: 4439, grownHeight: 5877, growAfterReads: 8 }));
    const r = await settle(FAST);
    restore();
    check(`the page that grew 4439 → 5877 is settled at the GROWN height (got ${r.scrolledTo})`, r.scrolledTo === 5877);
    check("settle reports stable:true only once the height has actually held still", r.stable === true);
    check("it re-swept rather than returning after the first pass", r.sweeps >= 2);
    check("the growth is EVIDENCED in the returned heights (an operator can see what happened)",
      Array.isArray(r.heights) && r.heights.includes(4439) && r.heights.includes(5877));
  }

  // 2) CONTROL — a page that never grows must settle on the FIRST sweep. The fix must not make
  //    every static capture pay for extra sweeps (that would be a tax on the common case).
  {
    const { settle, restore } = loadSettle(shim({ startHeight: 3000, grownHeight: 3000 }));
    const r = await settle(FAST);
    restore();
    check("CONTROL: a static page settles in ONE sweep (no re-sweep tax)", r.sweeps === 1 && r.stable === true);
    check("CONTROL: …and reports its true height", r.scrolledTo === 3000);
  }

  // 3) CONTROL — a page that grows FOREVER (an infinite feed) must TERMINATE and say so. Trading
  //    a silent miss for a silent hang is not a fix; `stable:false` is the operator's signal that
  //    a DOM captured now is not the page.
  {
    const { settle, restore } = loadSettle(shim({ startHeight: 1000, foreverGrowing: true }));
    const r = await settle(FAST);
    restore();
    check("CONTROL: an endlessly-growing page terminates at the sweep cap, never hangs", r.sweeps === FAST.maxSweeps);
    check("CONTROL: …and reports stable:false — 'do not capture this DOM'", r.stable === false);
  }

  // 4) the pre-existing contract still holds: frozenOpacity0 is still reported (fixture 20's
  //    frozen-reveal detection reads it) — the fix must not drop a field callers depend on.
  {
    const { settle, restore } = loadSettle(shim({ startHeight: 2000, grownHeight: 2000 }));
    const r = await settle(FAST);
    restore();
    check("the frozenOpacity0 field survives the change (callers still read it)", r.frozenOpacity0 === 0);
  }

  console.log(bad ? `\n❌ 30-scroll-settle-stability: ${bad} check(s) failed.` : "\n✓ 30-scroll-settle-stability: settle waits for the document height to HOLD STILL (re-sweeping if it grew), returns the evidence, and still terminates on a page that never settles.");
  process.exit(bad ? 1 : 0);
}
main();
