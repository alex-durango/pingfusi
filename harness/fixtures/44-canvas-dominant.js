// fixtures/44-canvas-dominant.js — THE HONEST CAPABILITY STATEMENT: a DOM clone cannot
// reproduce script-driven canvas painting, and the kit must SAY so on the live capture.
//
// The BLACK-PAGE GREEN miss (bizar.ro, LEARNINGS #37): a WebGL canvas painted the whole
// page; every DOM gate passed while the published draft rendered solid black. The rule:
// a canvas covering > ~half the viewport with fewer than N painted DOM marks in front is
// receipted canvasDominant on the live side (capture-run.json) — a statement about what
// this site IS, not about any gate. This fixture fails without pxCanvasDominance /
// pxCanvasDominant (tools/browser-capture.js) and pins:
//   • the PURE classifier: coverage vs the viewport, the marks-in-front cap, the receipt
//     shape (schema, rounded coverage) — nothing DOM-dependent
//   • the DOM half: canvases enumerated, the agent's own overlay skipped, painted marks
//     read from the SAME leaf enumeration the gates certify, canvases never counting as
//     marks for themselves
"use strict";
let bad = 0; const check = (n, c, d) => { console.log(`${c ? "✓" : "✗"} ${n}${c || !d ? "" : ` — ${d}`}`); if (!c) bad++; };

const CAPTURE = require.resolve("../../tools/browser-capture.js");

// ── load the injected source in node (the fixture 32/39/42 harness pattern) ──
function load(canvasEls) {
  global.window = global;
  global.innerWidth = 1440;
  global.innerHeight = 900;
  global.document = { querySelectorAll: (sel) => (sel === "canvas" ? canvasEls.slice() : []) };
  global.getComputedStyle = () => ({});
  delete require.cache[CAPTURE];
  require(CAPTURE);
}
const el = (tag, rect, opts = {}) => ({
  nodeType: 1, tagName: tag.toUpperCase(),
  getBoundingClientRect: () => ({ left: rect.x, top: rect.y, width: rect.w, height: rect.h }),
  matches: opts.matches || (() => false), closest: () => null,
});

// ── the PURE classifier ───────────────────────────────────────────────────────
load([]);
const dominance = global.pxCanvasDominance;
check("pxCanvasDominance is exported (fails without the kit change)", typeof dominance === "function");
const VP = { w: 1440, h: 900 };
const FULL = { x: 0, y: 0, w: 1440, h: 900 };

// the bizar.ro shape: one full-viewport canvas, next to nothing in front
{
  const r = dominance(VP, [FULL], [{ x: 20, y: 20, w: 120, h: 40 }, { x: 20, y: 860, w: 200, h: 20 }]);
  check("full-viewport canvas with 2 marks in front → dominant", r.dominant === true && r.marksInFront === 2, JSON.stringify(r));
  check("receipt shape: schema + rounded coverage + viewport", r.schema === "pingfusi/canvas-dominant@1" && r.bestCoverage === 1 && r.viewport.w === 1440 && r.canvases === 1);
}
// coverage floor: a canvas under ~half the viewport is decoration, not the page
{
  const r = dominance(VP, [{ x: 0, y: 0, w: 1440, h: 400 }], []);
  check("CONTROL — a canvas covering <50% of the viewport is not dominant", r.dominant === false && r.bestCoverage < 0.5, JSON.stringify(r));
}
// marks floor: a full-bleed background canvas UNDER a painted page is not dominant
{
  const marks = Array.from({ length: 20 }, (_, i) => ({ x: 40, y: 40 + i * 42, w: 400, h: 30 }));
  const r = dominance(VP, [FULL], marks);
  check("CONTROL — a background canvas under 20 painted DOM marks is not dominant", r.dominant === false && r.marksInFront === 20);
}
// off-viewport marks (below the fold) are not "in front" at first paint
{
  const r = dominance(VP, [FULL], [{ x: 0, y: 2000, w: 1440, h: 400 }]);
  check("a mark below the fold does not count against a first-paint canvas", r.dominant === true && r.marksInFront === 0);
}
// only the viewport-visible part of a canvas counts as coverage
{
  const r = dominance(VP, [{ x: 0, y: 450, w: 1440, h: 3000 }], []);
  check("coverage is clipped to the viewport (a tall canvas half off-screen ≈ 0.5)", Math.abs(r.bestCoverage - 0.5) < 0.01, JSON.stringify(r));
}
// degenerate inputs stay honest
{
  const none = dominance(VP, [], []);
  check("CONTROL — no canvases → dominant:false, canvases:0", none.dominant === false && none.canvases === 0 && none.bestCoverage === 0);
  const zero = dominance({ w: 0, h: 0 }, [FULL], []);
  check("a zero-area viewport can never be covered", zero.dominant === false && zero.bestCoverage === 0);
}
// the floors are opts, with the documented defaults
{
  const r = dominance(VP, [{ x: 0, y: 0, w: 1440, h: 500 }], [], { minCoverage: 0.4 });
  check("minCoverage/maxMarks are documented knobs (defaults 0.5 / 12)", r.dominant === true &&
    dominance(VP, [FULL], Array.from({ length: 12 }, () => ({ x: 0, y: 0, w: 10, h: 10 }))).dominant === false);
}

// ── the DOM half ──────────────────────────────────────────────────────────────
{
  const scene = el("canvas", FULL);
  const agentCanvas = el("canvas", FULL, { matches: (s) => s.indexOf("claude-agent-") !== -1 });
  load([scene, agentCanvas]);
  // painted marks come from the SAME enumeration the gates certify; the canvas leaf must
  // not testify for its own painting
  global.pxEnumerateLeaves = () => [
    { name: "canvas_scene", el: scene, kind: "media" },
    { name: "h1_title", el: el("h1", { x: 40, y: 40, w: 300, h: 60 }), kind: "text" },
  ];
  const r = global.pxCanvasDominant();
  check("DOM half: agent-overlay canvases are skipped, the site's canvas is read", r.canvases === 1, JSON.stringify(r));
  check("DOM half: the canvas's own leaf never counts as a mark in front", r.marksInFront === 1 && r.dominant === true);
}
{
  load([]);
  delete global.pxEnumerateLeaves; // pxEnumerateLeaves is redefined by the fresh load
  const r = global.pxCanvasDominant();
  check("DOM half: a canvas-free page reports dominant:false with 0 canvases", r.dominant === false && r.canvases === 0);
}

process.exit(bad ? 1 : 0);
