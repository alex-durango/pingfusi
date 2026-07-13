#!/usr/bin/env node
// settle-runner.js — run the READINESS cases of artifact-battery.js against ONE browser-capture.js
// and print the results as JSON.
//
// Why a child process: pxScrollSettle is async (it must be — it waits on the page), but
// detection-power's scoreAll is synchronous and composes every battery's rows in one pass. Rather
// than make the whole scorer async (and re-derive its careful OLD/NEW pairing semantics), the
// settle cases run out-of-process and their verdicts come back as data. That also gives the
// baseline a genuinely clean module registry — no cache bleed between the OLD and NEW capture.
//
// usage: node settle-runner.js <path/to/browser-capture.js>   → JSON to stdout
"use strict";
const capturePath = process.argv[2];
if (!capturePath) { console.error("usage: settle-runner.js <browser-capture.js>"); process.exit(2); }

// A document whose scrollHeight can grow under us, exactly like a hydrating page — and whose
// <img>s can still be in flight, exactly like a page whose lazy images have not landed. Both are
// "the page is not ready yet"; only the first one moves the height.
function shim({ startHeight, grownHeight, growAfterReads = 0, foreverGrowing = false, images = [] }) {
  let reads = 0, height = startHeight;
  return {
    get documentElement() {
      return {
        get scrollHeight() {
          reads++;
          if (foreverGrowing) return (height += 100);
          if (growAfterReads && reads > growAfterReads) height = grownHeight;
          return height;
        },
      };
    },
    images,
    querySelectorAll: () => [],
  };
}
// `rendered` models whether the image has a LAYOUT BOX. It is false for a display:none image AND
// for one inside a display:none ANCESTOR (a closed flyout) — the case that matters, because such
// an image's OWN computed display is still "block".
const img = ({ complete, rendered = true, src = "x.svg" }) => ({
  complete, src, currentSrc: src,
  getClientRects: () => (rendered ? [{ width: 32, height: 32 }] : []),
});

function loadSettle(document_, { smoothCss = false, onScroll = null } = {}) {
  global.window = global;
  global.document = document_;
  global.innerHeight = 900;
  // A page with CSS `scroll-behavior: smooth` ANIMATES a plain scrollTo(0, y) — under a throttled
  // rAF (a background tab, routine under automation) that animation never lands, so the scroll is
  // a no-op. Only an explicit behavior:"instant" bypasses it. The shim models exactly that: with
  // smoothCss, a positional scroll does nothing unless the caller demanded instant.
  global.scrollTo = (a, b) => {
    const opts = typeof a === "object" && a !== null ? a : null;
    const instant = opts ? opts.behavior === "instant" : false;
    const y = opts ? opts.top : b;
    if (smoothCss && !instant) return;   // the smooth animation never lands
    if (onScroll) onScroll(y);
  };
  // the settle asks whether a pending image RENDERS (a display:none pixel can never reflow the page)
  global.getComputedStyle = (el) => (el && el.style) || { display: "block" };
  delete require.cache[require.resolve(capturePath)];
  require(capturePath);
  return global.pxScrollSettle;
}

// Fast timings — the MECHANISM is under test, not the wall clock.
const FAST = { pause: 1, settle: 1, stableGapMs: 1, stableChecks: 3, maxSweeps: 4, imageWaitMs: 30 };

(async () => {
  const out = {};

  // THE GORJANA SHAPE — the document grows AFTER the walk has passed the section's slot.
  // A trustworthy settle reports the page that EXISTS (or refuses with stable:false). A settle
  // that hands back the pre-hydration height has silently produced an artifact that is not the
  // page — and every downstream gate is then green over a page with a hole in it.
  try {
    const settle = loadSettle(shim({ startHeight: 4439, grownHeight: 5877, growAfterReads: 8 }));
    const r = await settle(FAST);
    // "pass" = the kit ACCEPTED a wrong artifact without flagging it (the defect went undetected)
    out["settle-lazy-growth"] = { pass: r.scrolledTo !== 5877 && r.stable !== false, detail: `scrolledTo=${r.scrolledTo} stable=${r.stable} sweeps=${r.sweeps}` };
  } catch (e) { out["settle-lazy-growth"] = { pass: true, detail: `threw: ${e.message}` }; }

  // CONTROL — a page that never grows. The settle must return its true height and raise no alarm.
  // Deliberately tolerant of a baseline that has no `stable` field at all: an old settle that got
  // the height right did not raise a false alarm, and crediting this as a "false positive removed"
  // would inflate the verdict for a change that did not earn it.
  try {
    const settle = loadSettle(shim({ startHeight: 3000, grownHeight: 3000 }));
    const r = await settle(FAST);
    out["adv-settle-static-page"] = { pass: r.scrolledTo === 3000 && r.stable !== false, detail: `scrolledTo=${r.scrolledTo} stable=${r.stable}` };
  } catch (e) { out["adv-settle-static-page"] = { pass: false, detail: `threw: ${e.message}` }; }

  // CONTROL — a page that grows FOREVER (an infinite feed) must TERMINATE. Trading a silent miss
  // for a silent hang is not an improvement. (This case caught a real hang in the first draft of
  // the stability fix: the watch loop was unbounded.) The runner's own timeout is the backstop.
  try {
    const settle = loadSettle(shim({ startHeight: 1000, foreverGrowing: true }));
    const r = await settle(FAST);
    out["adv-settle-infinite-feed"] = { pass: true, detail: `returned: stable=${r.stable} sweeps=${r.sweeps}` };
  } catch (e) { out["adv-settle-infinite-feed"] = { pass: false, detail: `threw: ${e.message}` }; }

  // THE CHRONO24 SHAPE — the height holds perfectly still while a lazy <img> is STILL IN FLIGHT.
  // An unloaded image is a ZERO-WIDTH box, so it silently shifts the row it sits in (the footer QR
  // shifted two app-store badges 90px), and the reference records a layout no user ever sees. The
  // height watch cannot see this: nothing is mounting, so nothing grows. A settle that reports
  // `stable:true` here has certified a page that is not ready.
  try {
    const settle = loadSettle(shim({
      startHeight: 3000, grownHeight: 3000,
      images: [img({ complete: true }), img({ complete: false, src: "footer-app-qr-code.svg" })],
    }));
    const r = await settle(FAST);
    // "pass" = the kit ACCEPTED the not-ready page without flagging it (the defect went undetected)
    out["settle-image-pending"] = { pass: r.stable !== false, detail: `stable=${r.stable} imagesPending=${r.imagesPending}` };
  } catch (e) { out["settle-image-pending"] = { pass: true, detail: `threw: ${e.message}` }; }

  // CONTROL — every image has landed. The settle must report a ready page and raise no alarm.
  try {
    const settle = loadSettle(shim({
      startHeight: 3000, grownHeight: 3000,
      images: [img({ complete: true }), img({ complete: true })],
    }));
    const r = await settle(FAST);
    out["adv-settle-images-loaded"] = { pass: r.stable !== false && !r.imagesPending, detail: `stable=${r.stable} imagesPending=${r.imagesPending}` };
  } catch (e) { out["adv-settle-images-loaded"] = { pass: false, detail: `threw: ${e.message}` }; }

  // CONTROL — the FALSE-POSITIVE HUNTER. A never-loading <img> that renders NOTHING (the
  // display:none tracking pixel every analytics script ships, or a badge inside a CLOSED FLYOUT)
  // can never reflow the page. If a pending-image rule refused a capture over one of those, no
  // page with analytics or a hidden menu could ever be captured — the gate would have invented a
  // permanent blocker. chrono24 shipped exactly this: a 32x32 badge inside a display:none header
  // flyout, whose OWN computed display is still "block". Rendered-only, tested by LAYOUT BOX.
  try {
    const settle = loadSettle(shim({
      startHeight: 3000, grownHeight: 3000,
      images: [img({ complete: true }), img({ complete: false, rendered: false, src: "pixel.gif" })],
    }));
    const r = await settle(FAST);
    out["adv-settle-hidden-pixel"] = { pass: r.stable !== false && !r.imagesPending, detail: `stable=${r.stable} imagesPending=${r.imagesPending}` };
  } catch (e) { out["adv-settle-hidden-pixel"] = { pass: false, detail: `threw: ${e.message}` }; }

  // CONTROL — the same thing one level of indirection out: the image is inside a CLOSED FLYOUT
  // (a display:none ANCESTOR). This is the case the first cut of the rule got wrong on the real
  // site, so it gets its own control: the image's own display is "block", and only its missing
  // layout box reveals that it renders nothing.
  try {
    const settle = loadSettle(shim({
      startHeight: 3000, grownHeight: 3000,
      images: [img({ complete: true }), img({ complete: false, rendered: false, src: "certified-filled-inverted.svg" })],
    }));
    const r = await settle(FAST);
    out["adv-settle-image-in-closed-flyout"] = { pass: r.stable !== false && !r.imagesPending, detail: `stable=${r.stable} imagesPending=${r.imagesPending}` };
  } catch (e) { out["adv-settle-image-in-closed-flyout"] = { pass: false, detail: `threw: ${e.message}` }; }

  // THE SMOOTH-SCROLL SHAPE — the site sets `html { scroll-behavior: smooth }` (chrono24 does), so
  // the sweep's plain scrollTo(0, y) becomes an rAF animation that never lands under a throttled
  // tab. The sweep then walks NOTHING; the lazy section below the fold never mounts; and the height
  // never changes — *because nothing scrolled*. A settle that reports `stable:true` here has
  // certified a page it never visited (LEARNINGS #22: a probe that cannot fire the mechanism it is
  // probing must not report success). A correct settle scrolls INSTANTLY and reaches the content.
  try {
    let reached = 0;
    const doc = {
      get documentElement() {
        // the lazy section mounts only once the sweep has ACTUALLY scrolled past 2000px
        return { get scrollHeight() { return reached > 2000 ? 5000 : 3000; } };
      },
      images: [],
      querySelectorAll: () => [],
    };
    const settle = loadSettle(doc, { smoothCss: true, onScroll: (y) => { if (y > reached) reached = y; } });
    const r = await settle(FAST);
    // "pass" = the kit ACCEPTED the never-swept page (the defect went undetected)
    out["settle-smooth-scroll"] = { pass: r.scrolledTo !== 5000, detail: `scrolledTo=${r.scrolledTo} reachedY=${reached} stable=${r.stable}` };
  } catch (e) { out["settle-smooth-scroll"] = { pass: true, detail: `threw: ${e.message}` }; }

  // CONTROL — the same page WITHOUT smooth CSS. A plain scroll lands, so the old settle already
  // worked here; the instant scroll must not change that (and must not double-count as a "gain").
  try {
    let reached = 0;
    const doc = {
      get documentElement() { return { get scrollHeight() { return reached > 2000 ? 5000 : 3000; } }; },
      images: [],
      querySelectorAll: () => [],
    };
    const settle = loadSettle(doc, { smoothCss: false, onScroll: (y) => { if (y > reached) reached = y; } });
    const r = await settle(FAST);
    out["adv-settle-auto-scroll"] = { pass: r.scrolledTo === 5000, detail: `scrolledTo=${r.scrolledTo} reachedY=${reached}` };
  } catch (e) { out["adv-settle-auto-scroll"] = { pass: false, detail: `threw: ${e.message}` }; }

  process.stdout.write(JSON.stringify(out));
})();
