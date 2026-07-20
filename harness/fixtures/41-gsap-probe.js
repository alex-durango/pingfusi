// fixtures/41-gsap-probe.js — READ GSAP THROUGH ITS PUBLIC API, GUESS AT NOTHING.
//
// pxProbeGsap is the GSAP tier of the declared-motion ladder: it walks
// gsap.globalTimeline.getChildren(true, true, true) and serializes each TWEEN into the
// exact GsapRecord shape harness/motion-doc.js fromGsap consumes (contract in its JSDoc).
// This fixture pins the contract in node with a fake window.gsap (fixture 32/39 pattern):
//   • absence and version honesty — no gsap → {present:false}; an unknown major →
//     {present:true, unsupported:version}, NEVER a throw and never a guessed walk of
//     internals the probe does not know
//   • targets — DOM targets become stable selectors (one record per element); plain-object
//     tweens (gsap.to({val:0},…)) animate no pixels a clone could show — skipped WITH a
//     count; the agent's own overlay is never recorded
//   • vars — safe scalars verbatim, functions and non-startAt objects DROPPED with a count
//     (a stringified callback is not a value); startAt scalars survive (fromTo start frame)
//   • ScrollTrigger — configs (trigger/start/end/scrub) as safe scalars, matched to their
//     tween directly or through the tween's parent-timeline chain; unmatched triggers are
//     still reported as inventory, matched:false
//   • bounded (500-record cap, explicit truncated flag), JSON-safe, and read-only
//   • end-to-end — the emitted records feed fromGsap verbatim and validate
"use strict";
let bad = 0;
const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

const CAPTURE = require.resolve("../../tools/browser-capture.js");
const { fromGsap } = require("../motion-doc.js");

// ── mock DOM + mock GSAP ──────────────────────────────────────────────────────
const el = (tag, opts = {}) => {
  const e = { nodeType: 1, tagName: tag.toUpperCase(), id: opts.id || "", children: [], parentElement: null };
  if (opts.matches) { e.matches = opts.matches; e.closest = () => null; }
  return e;
};

// a mock tween: getters as GSAP exposes them (no-arg call = read), spies on the control
// surface so the read-only contract is asserted, not assumed.
let sideEffects = 0;
const tween = ({ targets, vars, duration = 1, delay = 0, startTime, repeat = 0, yoyo = false, parent = null }) => ({
  vars: vars || {},
  parent,
  targets: () => targets,
  duration: () => duration,
  delay: () => delay,
  startTime: () => (startTime !== undefined ? startTime : delay),
  repeat: () => repeat,
  yoyo: () => yoyo,
  pause: () => { sideEffects++; },
  play: () => { sideEffects++; },
  progress: () => { sideEffects++; },
});

function loadProbe(gsap, scrollTrigger) {
  global.window = global;
  global.document = { querySelectorAll: () => [] };
  if (gsap === undefined) delete global.gsap; else global.gsap = gsap;
  if (scrollTrigger === undefined) delete global.ScrollTrigger; else global.ScrollTrigger = scrollTrigger;
  delete require.cache[CAPTURE];
  require(CAPTURE);
  return global.pxProbeGsap;
}
const gsapOf = (children, extra) => ({
  version: "3.12.5",
  globalTimeline: { getChildren: (nested, tweens, timelines) => (nested && tweens && timelines ? children : []) },
  ...(extra || {}),
});

(async () => {
  // ── 1. absence + version honesty ──────────────────────────────────────────────
  {
    const probe = loadProbe(undefined, undefined);
    check("no window.gsap → { present:false }", JSON.stringify(probe()) === JSON.stringify({ present: false }));
  }
  {
    const probe = loadProbe({ version: "4.0.0", globalTimeline: { getChildren: () => { throw new Error("must never be walked"); } } }, undefined);
    const r = probe();
    check("unknown major (4.0.0) → { present:true, unsupported:\"4.0.0\" } — internals never walked",
      r.present === true && r.unsupported === "4.0.0" && r.records === undefined);
  }
  {
    const probe = loadProbe({ version: "2.1.3", globalTimeline: { getChildren: () => [] } }, undefined);
    check("gsap 2 is also refused honestly", probe().unsupported === "2.1.3");
  }

  // ── the main scene ────────────────────────────────────────────────────────────
  const hero = el("div", { id: "hero" });
  const belt = el("div", { id: "belt" });
  const card = el("article", { id: "card" });
  const agentEl = el("div", { id: "claude-agent-glow-border", matches: (s) => s.indexOf("claude-agent-") !== -1 });

  const heroTween = tween({
    targets: [hero],
    vars: { x: 100, opacity: 0.5, duration: 1, ease: "power2.out", onComplete: () => {}, snap: { x: 10 } },
    duration: 1, delay: 0.25, startTime: 0.25,
  });
  const counterTween = tween({ targets: [{ val: 0 }], vars: { val: 100 } });              // plain-object tween
  const mixedTween = tween({ targets: [card, { val: 1 }], vars: { y: () => 40, scale: 1.2 } }); // fn-valued var + mixed targets
  const beltTween = tween({
    targets: [belt],
    vars: { x: -400, repeat: -1, ease: "none", startAt: { x: 0, onUpdate: () => {} } },
    duration: 8, repeat: -1, yoyo: true,
  });
  const sectionTl = { getChildren: () => [], duration: () => 5 };   // a TIMELINE child: container, not motion
  const nestedTween = tween({ targets: [card], vars: { rotation: 90 }, parent: sectionTl });
  const agentTween = tween({ targets: [agentEl], vars: { opacity: 1 } });

  const triggers = [
    { animation: beltTween, trigger: belt, vars: { start: "top 80%", end: 400, scrub: true } },   // direct match; numeric end
    { animation: sectionTl, trigger: card, vars: { start: () => 0 }, start: 640, end: 900 },       // matches via parent chain; fn start → computed px
    { animation: null, trigger: hero, vars: { start: "top top" } },                                // unmatched: inventory
  ];
  const probe = loadProbe(gsapOf([heroTween, counterTween, mixedTween, beltTween, sectionTl, nestedTween, agentTween]),
    { getAll: () => triggers });
  const r = probe();

  // ── 2. tween serialization — selectors, timing, ease, repeat/yoyo ─────────────
  {
    const rec = r.records.find((x) => x.selector === "#hero");
    check("DOM tween → stable selector, duration_s/delay_s/startTime_s from the getters",
      !!rec && rec.duration_s === 1 && rec.delay_s === 0.25 && rec.startTime_s === 0.25);
    check("…ease recorded verbatim from vars.ease", rec && rec.ease === "power2.out");
    check("…vars keep safe scalars, DROP the callback and the non-startAt object (snap)",
      rec && rec.vars.x === 100 && rec.vars.opacity === 0.5 && rec.vars.onComplete === undefined && rec.vars.snap === undefined);
    const bRec = r.records.find((x) => x.selector === "#belt");
    check("repeat -1 and yoyo survive; startAt scalars survive, its callback is dropped",
      !!bRec && bRec.repeat === -1 && bRec.yoyo === true && bRec.vars.startAt && bRec.vars.startAt.x === 0 &&
      bRec.vars.startAt.onUpdate === undefined);
    check("dropped keys are COUNTED (onComplete + snap + y-fn + startAt.onUpdate = 4)",
      r.skipped.droppedVarKeys === 4);
  }

  // ── 3. audited skips — plain objects, agent DOM, timeline containers ──────────
  {
    check("plain-object tween targets are skipped WITH a count (counter + mixed = 2)",
      r.skipped.nonElementTargets === 2 && !r.records.some((x) => x.vars && x.vars.val !== undefined));
    check("a mixed-target tween still yields its DOM record", r.records.some((x) => x.selector === "#card" && x.vars.scale === 1.2));
    check("the agent's own overlay tween is never recorded", r.skipped.agentDom === 1);
    check("timeline children are containers, not motion — walked past, never serialized",
      r.tweens === 6 && !r.records.some((x) => x.duration_s === 5));
  }

  // ── 4. ScrollTrigger — matched directly, through the parent chain, or reported ─
  {
    const bRec = r.records.find((x) => x.selector === "#belt");
    check("a trigger on the tween itself attaches: trigger selector + start/end AS STRINGS + scrub",
      bRec && bRec.scrollTrigger && bRec.scrollTrigger.trigger === "#belt" &&
      bRec.scrollTrigger.start === "top 80%" && bRec.scrollTrigger.end === "400" && bRec.scrollTrigger.scrub === true);
    const nRec = r.records.find((x) => x.selector === "#card" && x.vars.rotation === 90);
    check("a trigger driving a PARENT TIMELINE reaches its nested tween; fn start falls back to computed px",
      nRec && nRec.scrollTrigger && nRec.scrollTrigger.trigger === "#card" &&
      nRec.scrollTrigger.start === "640" && nRec.scrollTrigger.end === "900");
    check("every trigger is reported as inventory — the unmatched one says matched:false",
      r.scrollTriggers.length === 3 &&
      r.scrollTriggers.filter((t) => t.matched).length === 2 &&
      r.scrollTriggers.some((t) => t.trigger === "#hero" && t.matched === false));
  }

  // ── 5. JSON safety + read-only ────────────────────────────────────────────────
  {
    let roundTrips = false;
    try { roundTrips = JSON.stringify(JSON.parse(JSON.stringify(r))) === JSON.stringify(r); } catch (e) {}
    check("the whole result JSON round-trips byte-identical (plain-JSON-safe by construction)", roundTrips);
    check("READ-ONLY: no play()/pause()/progress() was ever called on any tween", sideEffects === 0);
  }

  // ── 6. ScrollTrigger via gsap.core.globals() (bundler load: nothing on window) ─
  {
    const t = tween({ targets: [el("div", { id: "b2" })], vars: { x: 1 } });
    const st = { animation: t, trigger: el("div", { id: "trig2" }), vars: { start: "top center" } };
    const probe2 = loadProbe(gsapOf([t], { core: { globals: () => ({ ScrollTrigger: { getAll: () => [st] } }) } }), undefined);
    const r2 = probe2();
    check("ScrollTrigger found through gsap.core.globals() when window has none",
      r2.records[0] && r2.records[0].scrollTrigger && r2.records[0].scrollTrigger.trigger === "#trig2");
  }

  // ── 7. the cap — bounded output with an explicit truncated flag ───────────────
  {
    const many = Array.from({ length: 520 }, (_, i) => el("i", { id: `m${i}` }));
    const probe3 = loadProbe(gsapOf([tween({ targets: many, vars: { opacity: 1 } })]), undefined);
    const r3 = probe3();
    check("a 520-target tween → 500 records, truncated:true", r3.records.length === 500 && r3.truncated === true);
  }

  // ── 8. end-to-end — the records feed fromGsap VERBATIM and validate ───────────
  {
    let doc = null, err = null;
    try { doc = fromGsap(r.records, { url: "https://example.test/" }); } catch (e) { err = e; }
    check("fromGsap accepts the emitted records with no massaging" + (err ? ` (threw: ${err.message})` : ""), !!doc);
    if (doc) {
      const beltTrack = doc.tracks.find((t) => t.target.selector === "#belt" && t.property === "x");
      check("…the fromTo belt tween lands with explicit 0→1 keyframes (startAt), infinite iterations, scroll timeline",
        !!beltTrack && beltTrack.keyframes.length === 2 && beltTrack.keyframes[0].value === "0" &&
        beltTrack.timing.iterations === "infinite" && beltTrack.timeline.type === "scroll" &&
        beltTrack.provenance.tier === "introspected-gsap");
      const heroTrack = doc.tracks.find((t) => t.target.selector === "#hero" && t.property === "x");
      check("…startTime wins over delay (0.25s → delay_ms 250, never double-counted)",
        !!heroTrack && heroTrack.timing.delay_ms === 250);
    }
  }

  console.log(bad ? `\n✗ ${bad} check(s) failed` : "\n✓ 41-gsap-probe: GSAP is read through its public API — versions guarded, targets audited, receipts JSON-safe, nothing driven.");
  process.exit(bad ? 1 : 0);
})();
