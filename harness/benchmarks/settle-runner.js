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

// A document whose scrollHeight can grow under us, exactly like a hydrating page.
function shim({ startHeight, grownHeight, growAfterReads = 0, foreverGrowing = false }) {
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
    querySelectorAll: () => [],
  };
}

function loadSettle(document_) {
  global.window = global;
  global.document = document_;
  global.innerHeight = 900;
  global.scrollTo = () => {};
  delete require.cache[require.resolve(capturePath)];
  require(capturePath);
  return global.pxScrollSettle;
}

// Fast timings — the MECHANISM is under test, not the wall clock.
const FAST = { pause: 1, settle: 1, stableGapMs: 1, stableChecks: 3, maxSweeps: 4 };

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

  process.stdout.write(JSON.stringify(out));
})();
