// fixtures/42-dense-record.js — THE SAMPLED TIER'S RECORDER: PURE READS ON A CLOCK IT DOES NOT OWN.
//
// pxDenseRecordStart/Step/Stop (tools/browser-capture.js) is the in-page half of the
// capture ladder's last rung: when a page declares no motion (nothing to introspect,
// no GSAP to probe) but pixels still move, the only honest record is computed values
// sampled at uniform VIRTUAL-time steps. The node-side runner owns the clock and hands
// each step's tMs in; the recorder only reads. This fixture pins that contract in node
// with a mock DOM (the fixture 32/39/40 harness pattern):
//   • shape — Start resolves scope roots + descendants with their OWN transform;
//     Step snapshots the requested props per tracked element; Stop returns
//     { frames, stepMs, elements:[{selector, samples:[{t, values}]}],
//       writes:[{t, selector, prop, value}], truncated } and CONVERTS NOTHING
//   • style-write capture — inline-style writes land in `writes` with the virtual
//     timestamp of the step boundary that drained them (deterministic attribution:
//     the async-callback path and takeRecords() feed the same drain), removed props
//     record value "", sub-step write-and-revert collapses to nothing
//   • caps — 200 elements / 2000 frames / 5000 writes, explicit truncated flag
//   • agent-DOM skip — the instrument's own overlay is neither tracked nor has its
//     writes recorded, and the skips are COUNTED (a silent drop cannot be audited)
//   • determinism — two identical scripted runs produce byte-identical output; the
//     whole point of virtual time is that the record can be re-taken and compared
//   • read-only — the recorder never writes a style or attribute on the page
"use strict";
let bad = 0;
const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

const CAPTURE = require.resolve("../../tools/browser-capture.js");

// ── mock DOM ──────────────────────────────────────────────────────────────────
let setAttrCalls = 0; // read-only spy: the recorder must NEVER write to the page
const allDescendants = (node) => {
  const out = [];
  const walk = (n) => { for (const c of n.children || []) { out.push(c); walk(c); } };
  walk(node);
  return out;
};
const el = (tag, opts = {}) => {
  const attrs = { style: opts.style || "" };
  const e = {
    nodeType: 1, tagName: tag.toUpperCase(), id: opts.id || "",
    children: [], parentElement: null, attrs,
    computed: opts.computed || {},
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: () => { setAttrCalls++; },
  };
  if (opts.matches) { e.matches = opts.matches; e.closest = () => null; }
  e.querySelectorAll = (q) => (q === "*" ? allDescendants(e) : []);
  return e;
};
const append = (parent, child) => { child.parentElement = parent; parent.children.push(child); return child; };

// MutationObserver mock: records are queued by the fixture (a fake style write) and
// surface either via takeRecords() at the next drain or via the async callback path —
// both must land identically, that is the determinism claim under test.
class MockMutationObserver {
  constructor(cb) {
    this.cb = cb; this.queue = []; this.observations = []; this.disconnected = false;
    MockMutationObserver.instances.push(this);
  }
  observe(target, options) { this.observations.push({ target, options }); }
  disconnect() { this.disconnected = true; }
  takeRecords() { return this.queue.splice(0); }
}
MockMutationObserver.instances = [];

const activeObserver = () => MockMutationObserver.instances[MockMutationObserver.instances.length - 1];
// A "site write": mutate the inline style attribute and emit the mutation record —
// oldValue carried exactly as a real observer with attributeOldValue:true would.
const writeStyle = (target, text, opts = {}) => {
  const rec = { type: "attributes", attributeName: "style", target, oldValue: target.attrs.style };
  target.attrs.style = text;
  const ob = activeObserver();
  if (!ob) return;
  if (opts.viaCallback) ob.cb([rec]); else ob.queue.push(rec);
};

function loadRecorder(registry, opts = {}) {
  global.window = global;
  global.document = { querySelectorAll: (sel) => (registry[sel] ? registry[sel].slice() : []) };
  global.getComputedStyle = (e) => (e && e.computed) || {};
  if (opts.noObserver) delete global.MutationObserver;
  else { global.MutationObserver = MockMutationObserver; MockMutationObserver.instances = []; }
  delete require.cache[CAPTURE];
  require(CAPTURE);
  return { start: global.pxDenseRecordStart, step: global.pxDenseRecordStep, stop: global.pxDenseRecordStop };
}

(async () => {
  // ── the scene: a scope whose root fades, a child that translates on its own
  //    transform, a child with NO transform (sampled never, written to by "the site"),
  //    and the agent's own overlay (transformed — would qualify — but must be skipped).
  let vclock = 0; // the fixture's deterministic fake clock (ms) — computed values derive from it
  const hero = el("section", { id: "hero" });
  hero.computed = {
    transform: "none",
    get opacity() { return String(Math.min(1, vclock / 400)); },
    filter: "none", visibility: "visible",
  };
  const card = append(hero, el("div", { id: "card" }));
  card.computed = {
    get transform() { return `matrix(1, 0, 0, 1, ${vclock / 10}, 0)`; },
    opacity: "1", filter: "none", visibility: "visible",
  };
  const label = append(hero, el("p", { id: "label", computed: { transform: "none", opacity: "1" } }));
  const agent = append(hero, el("div", {
    id: "claude-agent-glow-border",
    matches: (s) => s.indexOf("claude-agent-") !== -1,
    computed: { transform: "matrix(1, 0, 0, 1, 5, 5)", opacity: "1" },
  }));

  // One scripted session, re-runnable verbatim — determinism is asserted by running it twice.
  const run = () => {
    const { start, step, stop } = loadRecorder({ ".hero": [hero] });
    vclock = 0;
    hero.attrs.style = ""; card.attrs.style = ""; label.attrs.style = ""; agent.attrs.style = "";
    const started = start({ scopes: [".hero"], props: ["transform", "opacity"] });
    for (let i = 0; i <= 4; i++) {
      vclock = i * 100;
      // writes land BETWEEN frames (during the virtual-time advance) — drained at this step's t
      if (i === 2) writeStyle(label, "opacity: 0.5; transform: translateX(12px)");
      if (i === 3) writeStyle(label, "opacity: 0.5", { viaCallback: true }); // transform REMOVED, async-callback path
      if (i === 3) writeStyle(agent, "opacity: 0");                          // the instrument's own overlay
      if (i === 4) { writeStyle(card, "outline: 1px solid red"); writeStyle(card, ""); } // write-and-revert inside one step
      step(vclock);
    }
    return { started, out: stop() };
  };

  const { started, out } = run();

  // ── 1. Start — element resolution from scopes, fixed at Start ─────────────────
  {
    check("scope root + the descendant with its OWN transform are tracked (2); a transform-less child is not",
      started.tracking === 2 && out.elements.length === 2 &&
      out.elements[0].selector === "#hero" && out.elements[1].selector === "#card");
    const ob = activeObserver();
    const cfg = ob && ob.observations[0];
    check("the MutationObserver watches the scope root: attributes+style filter+oldValue+subtree",
      !!cfg && cfg.target === hero && cfg.options.attributes === true &&
      cfg.options.attributeFilter.join(",") === "style" && cfg.options.attributeOldValue === true &&
      cfg.options.subtree === true);
  }

  // ── 2. Step/Stop — the sampled record, shape and values ───────────────────────
  {
    check("5 steps → frames:5, stepMs derived from what actually happened (100)",
      out.frames === 5 && out.stepMs === 100);
    const heroSamples = out.elements[0].samples;
    check("every tracked element carries one sample per frame, stamped with its virtual t",
      heroSamples.length === 5 && out.elements[1].samples.length === 5 &&
      heroSamples.map((s) => s.t).join(",") === "0,100,200,300,400");
    check("values are the COMPUTED strings at each step (hero opacity 0 → 1)",
      heroSamples[0].values.opacity === "0" && heroSamples[2].values.opacity === "0.5" &&
      heroSamples[4].values.opacity === "1");
    check("transform ships as the computed matrix string (card at t=200: matrix …, 20, 0)",
      out.elements[1].samples[2].values.transform === "matrix(1, 0, 0, 1, 20, 0)");
    check("values hold ONLY the requested props, in request order",
      Object.keys(heroSamples[0].values).join(",") === "transform,opacity");
  }

  // ── 3. style-write capture — timestamps, removal, collapse ────────────────────
  {
    check("an inline-style write between frames is recorded at the step t that drained it (t=200), per prop",
      out.writes.length === 3 &&
      out.writes[0].t === 200 && out.writes[0].selector === "#label" && out.writes[0].prop === "opacity" && out.writes[0].value === "0.5" &&
      out.writes[1].t === 200 && out.writes[1].prop === "transform" && out.writes[1].value === "translateX(12px)");
    check("a REMOVED prop records value \"\" — and the async-callback delivery path lands identically (t=300)",
      out.writes[2].t === 300 && out.writes[2].selector === "#label" && out.writes[2].prop === "transform" && out.writes[2].value === "");
    check("a write-and-revert inside one step collapses to NOTHING — below the fps resolution, as on screen",
      out.writes.every((w) => w.selector !== "#card"));
  }

  // ── 4. agent-DOM skip — the instrument must not record itself ─────────────────
  {
    check("the agent overlay is neither tracked nor written into the record, and both skips are COUNTED",
      out.skipped.agentDom === 2 &&
      out.elements.every((e) => e.selector.indexOf("claude") === -1) &&
      out.writes.every((w) => w.selector.indexOf("claude") === -1));
  }

  // ── 5. read-only + cleanup — observers and reads, nothing else ────────────────
  {
    check("READ-ONLY: the recorder never wrote an attribute on any element", setAttrCalls === 0);
    check("Stop disconnects the observer — nothing keeps watching the page", activeObserver().disconnected === true);
    let threw = false;
    try { global.pxDenseRecordStep(500); } catch (e) { threw = true; }
    check("Step after Stop THROWS — a recorder that pretends to record fabricates the artifact", threw);
  }

  // ── 6. determinism — the record can be re-taken and compared byte-for-byte ────
  {
    const again = run().out;
    check("two identical scripted runs produce BYTE-IDENTICAL output (the virtual-time promise)",
      JSON.stringify(again) === JSON.stringify(out));
    let roundTrips = false;
    try { roundTrips = JSON.stringify(JSON.parse(JSON.stringify(out))) === JSON.stringify(out); } catch (e) {}
    check("the record JSON round-trips byte-identical (plain-JSON-safe by construction)", roundTrips);
  }

  // ── 7. caps — bounded output with the explicit truncated flag ─────────────────
  {
    const belt = el("div", { id: "belt", computed: { transform: "none", opacity: "1" } });
    for (let i = 0; i < 220; i++) {
      append(belt, el("span", { id: `s${i}`, computed: { transform: "matrix(1, 0, 0, 1, 1, 0)", opacity: "1" } }));
    }
    const rec = loadRecorder({ ".belt": [belt] });
    const s = rec.start({ scopes: [".belt"] });
    rec.step(0);
    const capped = rec.stop();
    check("221 candidates → 200 tracked, truncated:true (element cap)",
      s.tracking === 200 && capped.truncated === true && capped.elements.length === 200);
    check("props default to the contract's four when none are requested",
      Object.keys(capped.elements[0].samples[0].values).join(",") === "transform,opacity,filter,visibility");
  }
  {
    const solo = el("div", { id: "solo", computed: { transform: "none", opacity: "1" } });
    const rec = loadRecorder({ "#solo": [solo] });
    rec.start({ scopes: ["#solo"], props: ["opacity"] });
    let last = null;
    for (let i = 0; i < 2005; i++) last = rec.step(i * 10);
    const capped = rec.stop();
    check("2005 steps → 2000 frames, truncated:true, the over-cap step says so (frame cap)",
      capped.frames === 2000 && capped.truncated === true && last.truncated === true &&
      capped.elements[0].samples.length === 2000);
  }
  {
    const solo = el("div", { id: "solo2", computed: { transform: "none", opacity: "1" } });
    const rec = loadRecorder({ "#solo2": [solo] });
    rec.start({ scopes: ["#solo2"], props: ["opacity"] });
    const decls = [];
    for (let i = 0; i < 5001; i++) decls.push(`--p${i}: ${i}`);
    writeStyle(solo, decls.join("; "));
    rec.step(0);
    const capped = rec.stop();
    check("a 5001-prop style write → 5000 writes, truncated:true (write cap)",
      capped.writes.length === 5000 && capped.truncated === true);
  }

  // ── 8. degraded hosts — reported, never thrown at ─────────────────────────────
  {
    const solo = el("div", { id: "noc", computed: { transform: "none", opacity: "1" } });
    const rec = loadRecorder({ "#noc": [solo] }, { noObserver: true });
    const s = rec.start({ scopes: ["#noc"], props: ["opacity"] });
    rec.step(0);
    const r = rec.stop();
    check("no MutationObserver on the host → writesObserved:false, sampling still works, no throw",
      s.writesObserved === false && r.writesObserved === false && r.writes.length === 0 && r.frames === 1);
    let threw = false;
    try { rec.step(0); } catch (e) { threw = true; }
    check("Step with no recording active THROWS (explicit failure beats a silent no-op)", threw);
  }

  console.log(bad ? `\n✗ ${bad} check(s) failed` : "\n✓ 42-dense-record: the sampled tier reads on a clock it does not own — capped, receipted, byte-repeatable, untouched.");
  process.exit(bad ? 1 : 0);
})();
