// fixtures/40-introspect-animations.js — READ THE MOTION THE PAGE DECLARES, TOUCH NOTHING.
//
// pxIntrospectAnimations is the declared-motion reader of the capture ladder: it serializes
// document.getAnimations({subtree:true}) into the EXACT IntrospectionRecord shape that
// harness/motion-doc.js fromIntrospection consumes (the contract lives in its JSDoc). This
// fixture pins the contract in node with a mock DOM (the fixture 32/39 harness pattern):
//   • classification — CSSAnimation / CSSTransition / plain WAAPI Animation (duck-typed:
//     only CSSAnimation exposes animationName, only CSSTransition transitionProperty)
//   • JSON safety — Infinity iterations/endTime ship as the STRING "Infinity" (the
//     motion-doc contract), null keyframe offsets are PRESERVED (WAAPI distributes them)
//   • timelines — ScrollTimeline/ViewTimeline feature-detected via instanceof against the
//     host globals; source element + ranges recorded; "normal" ranges (the unset default)
//     are NOT recorded — recording the default would invent a constraint
//   • bounded — capped at 500 records with an explicit truncated flag, never unbounded
//   • read-only — the reader never calls play/pause/seek: an instrument that perturbs the
//     animation it is recording is measuring itself
//   • audited skips — no-target and agent-overlay animations are skipped WITH counts
//   • end-to-end — the emitted records feed fromIntrospection verbatim and validate
"use strict";
let bad = 0;
const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

const CAPTURE = require.resolve("../../tools/browser-capture.js");
const { fromIntrospection } = require("../motion-doc.js");

// ── mock DOM ──────────────────────────────────────────────────────────────────
const el = (tag, opts = {}) => {
  const e = { nodeType: 1, tagName: tag.toUpperCase(), id: opts.id || "", children: [], parentElement: null };
  if (opts.matches) { e.matches = opts.matches; e.closest = () => null; }
  return e;
};
const append = (parent, child) => { child.parentElement = parent; parent.children.push(child); return child; };

// mock control-surface spies: the read-only contract is asserted, not assumed
let sideEffects = 0;
const anim = (fields) => ({
  playbackRate: 1,
  pause: () => { sideEffects++; },
  play: () => { sideEffects++; },
  ...fields,
});
const effect = ({ target, keyframes, timing, pseudoElement }) => ({
  target,
  pseudoElement: pseudoElement || "",
  getKeyframes: () => keyframes || [],
  getComputedTiming: () => timing || {},
});

function loadReader(animations) {
  global.window = global;
  global.document = {
    getAnimations: animations ? () => animations : undefined,
    querySelectorAll: () => [],
  };
  if (animations === null) delete global.document.getAnimations;
  delete require.cache[CAPTURE];
  require(CAPTURE);
  return global.pxIntrospectAnimations;
}

(async () => {
  // ── 1. feature detection — a host without getAnimations is REPORTED, not thrown at ────
  {
    const read = loadReader(null);
    const r = read();
    check("no document.getAnimations → { supported:false }, empty records, no throw",
      r.supported === false && Array.isArray(r.records) && r.records.length === 0);
  }

  // scene shared by the main checks
  global.ScrollTimeline = class ScrollTimeline { constructor(o) { Object.assign(this, o || {}); } };
  global.ViewTimeline = class ViewTimeline extends global.ScrollTimeline {};

  const hero = el("div", { id: "hero" });
  const rail = el("section", { id: "rail" });
  const card = el("article", { id: "card" });
  // an id-less element whose selector must be a structural nth-of-type path
  const list = el("ul");
  append(list, el("li"));
  const li2 = append(list, el("li"));

  const cssAnim = anim({
    animationName: "slide",
    effect: effect({
      target: hero,
      keyframes: [
        { offset: 0, computedOffset: 0, easing: "ease", composite: "replace", transform: "translateX(0px)" },
        { offset: 1, computedOffset: 1, easing: "linear", transform: "translateX(120px)" },
      ],
      timing: { duration: 1000, delay: 0, iterations: Infinity, direction: "normal", fill: "both", endTime: Infinity },
    }),
    timeline: new global.ScrollTimeline({ source: rail }),
    rangeStart: "normal", rangeEnd: "normal",   // Chrome's unset default — must NOT be recorded
  });
  const cssTransition = anim({
    transitionProperty: "opacity",
    effect: effect({
      target: li2,
      keyframes: [
        { offset: 0, computedOffset: 0, easing: "ease", opacity: "0" },
        { offset: 1, computedOffset: 1, opacity: "1" },
      ],
      timing: { duration: 300, delay: 0, iterations: 1, direction: "normal", fill: "backwards", endTime: 300 },
    }),
    timeline: {},   // the document timeline: not a Scroll/ViewTimeline instance
  });
  const waapi = anim({
    playbackRate: 0.5,
    effect: effect({
      target: card,
      keyframes: [
        { offset: null, computedOffset: 0, opacity: "0" },
        { offset: null, computedOffset: 0.5, opacity: "0.3" },
        { offset: null, computedOffset: 1, opacity: "1" },
      ],
      timing: { duration: 500, delay: 100, iterations: 2, direction: "alternate", fill: "forwards", endTime: 1100 },
    }),
    timeline: null,
  });
  const viewAnim = anim({
    effect: effect({
      target: card,
      keyframes: [{ offset: 0, transform: "scale(0.8)" }, { offset: 1, transform: "scale(1)" }],
      timing: { duration: 1, delay: 0, iterations: 1, direction: "normal", fill: "both", endTime: 1 },
    }),
    timeline: new global.ViewTimeline({ subject: hero }),
    rangeStart: "entry 0%",
    rangeEnd: { rangeName: "cover", offset: { toString: () => "50%" } },   // TimelineRangeOffset object form
  });
  const noTarget = anim({ effect: effect({ target: null }) });
  const agentOverlay = anim({
    animationName: "claude-glow-pulse",
    effect: effect({
      target: el("div", { id: "claude-agent-glow-border", matches: (s) => s.indexOf("claude-agent-") !== -1 }),
      keyframes: [{ offset: 0, opacity: "0.4" }, { offset: 1, opacity: "1" }],
      timing: { duration: 1200, delay: 0, iterations: Infinity, direction: "alternate", fill: "none", endTime: Infinity },
    }),
  });

  const read = loadReader([cssAnim, cssTransition, waapi, viewAnim, noTarget, agentOverlay]);
  const r = read();

  // ── 2. classification + stable selectors ──────────────────────────────────────
  {
    check("CSSAnimation classified via animationName, selector = #hero, name recorded",
      r.records[0].type === "CSSAnimation" && r.records[0].selector === "#hero" && r.records[0].animationName === "slide");
    check("CSSTransition classified via transitionProperty, id-less target gets an nth-of-type path",
      r.records[1].type === "CSSTransition" && r.records[1].transitionProperty === "opacity" &&
      r.records[1].selector === "ul>li:nth-of-type(2)");
    check("bare WAAPI Animation classified as Animation, playbackRate recorded",
      r.records[2].type === "Animation" && r.records[2].timing.playbackRate === 0.5);
  }

  // ── 3. JSON safety — the record must survive the wire byte-identical ──────────
  {
    check("infinite iterations/endTime serialize as the STRING \"Infinity\" (motion-doc contract)",
      r.records[0].timing.iterations === "Infinity" && r.records[0].timing.endTime === "Infinity");
    check("null keyframe offsets are PRESERVED (WAAPI distributes them; computedOffset rides along)",
      r.records[2].keyframes.every((kf) => kf.offset === null) && r.records[2].keyframes[1].computedOffset === 0.5);
    let roundTrips = false;
    try { roundTrips = JSON.stringify(JSON.parse(JSON.stringify(r))) === JSON.stringify(r); } catch (e) {}
    check("the whole result JSON round-trips byte-identical (plain-JSON-safe by construction)", roundTrips);
  }

  // ── 4. timelines — document vs scroll vs view, ranges only when authored ──────
  {
    check("ScrollTimeline → {type:scroll, source:#rail}; the unset \"normal\" range is NOT recorded",
      r.records[0].timeline.type === "scroll" && r.records[0].timeline.source === "#rail" &&
      r.records[0].timeline.rangeStart === undefined && r.records[0].timeline.rangeEnd === undefined);
    check("document timeline (plain object) and null timeline both → {type:document}",
      r.records[1].timeline.type === "document" && r.records[2].timeline.type === "document");
    check("ViewTimeline → {type:view, source:subject}; ranges recorded, object form stringified",
      r.records[3].timeline.type === "view" && r.records[3].timeline.source === "#hero" &&
      r.records[3].timeline.rangeStart === "entry 0%" && r.records[3].timeline.rangeEnd === "cover 50%");
  }

  // ── 5. audited skips — nothing vanishes silently ──────────────────────────────
  {
    check("a no-target animation is skipped WITH a count", r.skipped.noTarget === 1);
    check("the agent's own overlay pulse is skipped — the instrument must not record itself",
      r.skipped.agentDom === 1 && r.records.every((rec) => rec.selector.indexOf("claude") === -1));
    check("total reports what the page HELD (6), records what survived the audit (4)",
      r.total === 6 && r.records.length === 4 && r.truncated === false);
  }

  // ── 6. read-only — the probe never drove the animations it read ───────────────
  check("READ-ONLY: no play()/pause() was ever called on any animation", sideEffects === 0);

  // ── 7. the cap — bounded output with an explicit truncated flag ───────────────
  {
    const many = Array.from({ length: 520 }, (_, i) => anim({
      effect: effect({
        target: el("div", { id: `n${i}` }),
        keyframes: [{ offset: 0, opacity: "0" }, { offset: 1, opacity: "1" }],
        timing: { duration: 100, delay: 0, iterations: 1, direction: "normal", fill: "both", endTime: 100 },
      }),
    }));
    const rc = loadReader(many)();
    check("520 animations → 500 records, truncated:true, total still reports 520",
      rc.records.length === 500 && rc.truncated === true && rc.total === 520);
  }

  // ── 8. end-to-end — the records feed fromIntrospection VERBATIM and validate ──
  {
    let doc = null, err = null;
    try { doc = fromIntrospection(r.records, { url: "https://example.test/", capturedAt: "2026-07-18T00:00:00.000Z" }); }
    catch (e) { err = e; }
    check("fromIntrospection accepts the emitted records with no massaging" + (err ? ` (threw: ${err.message})` : ""), !!doc);
    if (doc) {
      const heroTrack = doc.tracks.find((t) => t.target.selector === "#hero" && t.property === "transform");
      check("…the scroll-driven CSS animation lands as a transform track on a scroll timeline, iterations infinite",
        !!heroTrack && heroTrack.timeline.type === "scroll" && heroTrack.timing.iterations === "infinite" &&
        heroTrack.provenance.tier === "introspected-css");
      const waapiTrack = doc.tracks.find((t) => t.target.selector === "#card" && t.provenance.tier === "introspected-waapi");
      check("…the null-offset WAAPI frames resolve through computedOffset (0, 0.5, 1)",
        !!waapiTrack && waapiTrack.keyframes.map((k) => k.offset).join(",") === "0,0.5,1");
    }
  }

  console.log(bad ? `\n✗ ${bad} check(s) failed` : "\n✓ 40-introspect-animations: the reader ships the page's declared motion — capped, JSON-safe, audited, untouched.");
  process.exit(bad ? 1 : 0);
})();
