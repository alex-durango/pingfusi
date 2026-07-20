// behavior-capture.js — the BROWSER half of the `behavior` phase, extracted verbatim (same
// reason as browser-capture.js: inject as PLAIN SOURCE on a strict-CSP live site — never
// base64/gzip/fetch+eval, see tools/RUNBOOK.md). Discovers and MEASURES JS-driven dynamics
// (animations, rotations, reveals, marquees, counters, hover-mounted content) so the
// `behavior` phase gate can compare live vs clone by NUMBER, never by eyeballing a replay.
//
// METHOD (ported from lovable_dupe_html/CLONE_PLAYBOOK.md §8a — port, don't reinvent):
//   static pass    — grep candidates: @keyframes names in <style>/stylesheets, and DOM
//                     markers (class/style hints for opacity-0, translate, blur, will-change,
//                     animate-*, data-state, data-[starting-style]). Necessary but noisy —
//                     every hit is a CANDIDATE, not a confirmed behavior.
//   dynamic pass   — the authoritative one: attach a MutationObserver (class/style/data-*)
//                     across the region, snapshot computed opacity/transform/filter PER
//                     ELEMENT before and after a scripted scroll sweep + hover of each
//                     candidate trigger, and diff. Whatever actually changed is a real
//                     behavior. A candidate that stays frozen remains DECLARED inventory:
//                     it still needs measurement or an explicit non-temporal disposition,
//                     but weak marker evidence alone does not become a motion owner.
//   measure, don't eyeball — a marquee's speed is sampled translateX over a real time
//                     window and converted to px/sec; a reveal's duration is the wall-clock
//                     time between trigger and the computed style settling; there is no
//                     "looks about right" path through this file.
//
// The discovery pass's OWN metadata (scroll range, observer duration, elements scanned) is
// recorded in the output — this is what proves discovery ACTUALLY RAN on a page with zero
// live behaviors, vs. a script that silently no-oped (docs/WORKFLOW.md: "no dynamic behaviors
// discovered" must be an evidenced gate result, never a free pass).
(function (root) {
  "use strict";
  const num = (v) => { const n = parseFloat(v); return isNaN(n) ? v : Math.round(n * 1000) / 1000; };
  const now = () => (root.performance ? root.performance.now() : Date.now());

  // THE INSTRUMENT MUST NOT MEASURE ITSELF. A browser-automation extension injects overlay DOM
  // into the page it is driving — Claude-in-Chrome paints #claude-agent-glow-border (which
  // PULSES via a @keyframes it also injects) and #claude-phantom-cursor. Discovery scans
  // document.body, so it found the glow, saw its opacity move 0.697 → 0.609 across the sweep,
  // and recorded `reveal:claude-agent-glow-border-inner` as a BEHAVIOR OF GORJANA — plus
  // `declared:claude-phantom-cursor` and `claude-pulse` in the site's keyframe list. A behavior
  // the site does not have and the clone can never reproduce: a defect the gate invents about a
  // page where nothing is wrong (#23), sourced from the measuring apparatus itself.
  // Narrow by construction: keyed on the agent's own ID NAMESPACE (a site may legitimately use a
  // class named "claude-*"; only these ids belong to the extension).
  // Three prefixes, not two — the extension's "Claude is active" toast lives under
  // claude-static-* and #24's guard did not list it. On dtf, discovery inventoried
  // `declared:claude-static-chat-tooltip` and `declared:claude-static-close-tooltip` as
  // behaviors OF THE SITE, awaiting reproduction. Keep in sync with browser-capture.js.
  const AGENT_DOM_SELECTOR = '[id^="claude-agent-"], [id^="claude-phantom-"], [id^="claude-static-"]';
  const isAgentDom = (el) => !!(el && el.nodeType === 1 && el.closest && el.closest(AGENT_DOM_SELECTOR));

  root.pxRegion = root.pxRegion || { maxY: 200 };
  const inRegion = (el) => {
    const reg = root.pxRegion || {};
    if (isAgentDom(el)) return false; // the automation's own overlay is not the site's content
    if (reg.sel && !el.closest(reg.sel)) return false;
    const r = el.getBoundingClientRect();
    if (reg.maxY != null && r.top > reg.maxY + (reg.maxYSlack || 4000)) return false; // generous: behaviors can occur below the fold (scroll reveals)
    if (reg.minY != null && r.bottom < reg.minY) return false;
    return true; // unlike browser-capture's inRegion, width===0 is still a candidate (opacity:0 start state has zero box until revealed)
  };

  // ── static pass: candidate discovery (necessary, noisy) ─────────────────────
  // Grep every reachable stylesheet's cssText for @keyframes names — same-origin sheets only;
  // a cross-origin sheet throws on .cssRules (SecurityError), which we swallow (can't read it
  // from script anyway; its keyframes still fire and get caught by the dynamic pass).
  function keyframeNames() {
    const names = new Set();
    for (const sheet of Array.from(document.styleSheets)) {
      // Skip the stylesheet the AUTOMATION injected (<style id="claude-agent-animation-styles">):
      // its @keyframes (`claude-pulse`) drive the agent's glow overlay, not the site's design.
      // Identified by its owner NODE, not by guessing at rule names.
      const owner = sheet.ownerNode;
      if (owner && owner.id && /^claude-(agent|phantom)-/.test(owner.id)) continue;
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (rule.type === CSSRule.KEYFRAMES_RULE) names.add(rule.name);
      }
    }
    return names;
  }
  const MARKER_RE = /(^|[\s"'`])(opacity-0|translate-[xy]-|blur-|will-change|animate-|data-\[starting-style\]|data-state)/;
  // Attributes whose NAME declares animation intent (site-authored choreography markers —
  // apple ships data-anim-scroll-group / data-video-load-kf etc.; generic data-scroll-* and
  // data-animate-* cover the common libraries).
  const DECLARED_ATTR_RE = /^data-(anim|animate|scroll|video-load|autoplay|parallax|reveal|carousel|gallery|progress)/i;
  const timeMs = (value) => Math.max(0, ...String(value || "0s").split(",").map((part) => {
    const text = part.trim();
    const n = parseFloat(text) || 0;
    return text.endsWith("ms") ? n : n * 1000;
  }));
  function meaningfulTransform(value) {
    const text = String(value || "").trim();
    if (!text || text === "none") return false;
    const matrix = /^matrix\(([^)]+)\)$/.exec(text);
    if (matrix) {
      const n = matrix[1].split(",").map(Number);
      return n.length !== 6 || n.some((v, i) => Math.abs(v - [1, 0, 0, 1, 0, 0][i]) > 1e-6);
    }
    const matrix3d = /^matrix3d\(([^)]+)\)$/.exec(text);
    if (matrix3d) {
      const n = matrix3d[1].split(",").map(Number);
      const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      return n.length !== 16 || n.some((v, i) => Math.abs(v - identity[i]) > 1e-6);
    }
    return true;
  }
  function declaredHints(el, cs) {
    const hints = [];
    if (cs.animationName && cs.animationName !== "none") hints.push("animation-name:" + cs.animationName);
    if (el.className && typeof el.className === "string" && MARKER_RE.test(el.className)) hints.push("class-marker");
    if (el.hasAttribute("data-state") || el.hasAttribute("data-starting-style")) hints.push("data-state");
    if (cs.willChange && cs.willChange !== "auto") hints.push("will-change:" + cs.willChange);
    for (const a of el.attributes) if (DECLARED_ATTR_RE.test(a.name)) hints.push("attr:" + a.name);
    // a transition paired with a hidden/offset start state = a reveal waiting for a trigger
    if (timeMs(cs.transitionDuration) > 0 && (parseFloat(cs.opacity) === 0 || meaningfulTransform(cs.transform))) hints.push("transition-from-start-state");
    if (el.tagName === "VIDEO") hints.push(`video:${el.autoplay ? "autoplay" : "scripted"}:${el.preload || "auto"}`);
    return hints;
  }
  function temporalEvidence(cs, hints) {
    const names = String(cs.animationName || "").split(",").map((name) => name.trim()).filter((name) => name && name !== "none");
    const animationDurationMs = timeMs(cs.animationDuration);
    const animationDelayMs = timeMs(cs.animationDelay);
    if (names.length && animationDurationMs > 0) {
      return {
        candidate: "strong",
        kind: "css-animation",
        trigger: "load",
        animationName: names.join(","),
        durationMs: animationDurationMs,
        delayMs: animationDelayMs,
        easing: cs.animationTimingFunction || null,
        iterationCount: cs.animationIterationCount || null,
        signals: hints.filter((hint) => /^animation-name:/i.test(hint)),
        reason: `named CSS animation ${names.join(", ")} with ${animationDurationMs}ms duration`,
      };
    }
    const transitionDurationMs = timeMs(cs.transitionDuration);
    if (transitionDurationMs > 0 && hints.includes("transition-from-start-state")) {
      return {
        candidate: "weak",
        mechanism: "css-transition",
        durationMs: transitionDurationMs,
        delayMs: timeMs(cs.transitionDelay),
        easing: cs.transitionTimingFunction || null,
        signals: ["transition-from-start-state"],
      };
    }
    return null;
  }
  function staticCandidates(root_) {
    const kf = keyframeNames();
    const out = [];
    const all = root_.querySelectorAll("*");
    for (const el of all) {
      if (!inRegion(el)) continue;
      const cs = getComputedStyle(el);
      const hints = declaredHints(el, cs);
      if (hints.length) out.push({ el, hints, temporal: temporalEvidence(cs, hints) });
    }
    return { keyframes: [...kf], candidates: out };
  }

  // ── dynamic differential pass (authoritative) ────────────────────────────────
  // Per-element snapshot: opacity/transform/filter, the three properties JS-driven reveals
  // and rotations actually touch (per the playbook). Cheap enough to run on every candidate
  // plus a bounded scan of the region without a real perf hit.
  // `visibility` earns its place next to opacity/transform/filter: a mega-menu revealed by
  // `visibility: hidden → visible` (aloyoga) moves NONE of the other three — opacity stays 1
  // the whole time — so a snapshot without it reads an open menu and a closed one as the same
  // state. Same shape as the backdrop-colour miss (#16): a painted mark the tool never measured.
  //
  // `display` earns its place for exactly the same reason, and chrono24 is the proof. Its header
  // flyouts are revealed by toggling ONE class:
  //     .header-navigation .header-flyout        { display: none; }
  //     .header-navigation .header-flyout.active { display: block; }
  // The panel is PRE-MOUNTED (103 descendants, closed and open alike) and its opacity, transform,
  // filter and visibility are ALL already at their open values while it is shut. Measured on live:
  // toggling `.active` took the panel from display:none / 0px tall to display:block / 543px of
  // painted menu — and the four-property snapshot recorded BYTE-IDENTICAL before and after. The
  // instrument was blind to a 543px panel. A snapshot that cannot tell an open menu from a closed
  // one cannot gate a reveal, and it makes every such probe look "inconclusive" forever.
  //
  // The durable rule this is the second instance of (#22 was the first): the snapshot must record
  // EVERY property a reveal can move. opacity, transform, filter, visibility, display.
  function styleSnap(el) {
    const cs = getComputedStyle(el);
    return { opacity: num(cs.opacity), transform: cs.transform === "none" ? "none" : cs.transform, filter: cs.filter === "none" ? "none" : cs.filter, visibility: cs.visibility, display: cs.display };
  }
  // `display` is compared only when BOTH sides recorded it — a snapshot captured before this field
  // existed must not read as a mismatch (same old-schema rule as strut/mode).
  const styleSnapEq = (a, b) => a.opacity === b.opacity && a.transform === b.transform && a.filter === b.filter && a.visibility === b.visibility &&
    (a.display === undefined || b.display === undefined || a.display === b.display);

  // A scroll-linked transform can be perfectly reversible: y=0 starts at state A, the sweep
  // reaches state B, then returning to y=0 lands back on A. Comparing only the pre-sweep and
  // post-reset snapshots therefore erases the very motion the sweep was meant to measure.
  // Reconcile the bounded snapshots taken AT each scroll stop and retain one representative
  // maximum delta. This helper is deliberately pure so the reversible case is regression-
  // testable without browser timing.
  function styleSweepEvidence(before, samples, after) {
    const differenceCount = (snapshot) => {
      if (!snapshot) return 0;
      let count = 0;
      for (const field of ["opacity", "transform", "filter", "visibility"]) {
        if (before[field] !== snapshot[field]) count++;
      }
      if (before.display !== undefined && snapshot.display !== undefined && before.display !== snapshot.display) count++;
      return count;
    };
    let representative = null;
    let maxChangedProperties = 0;
    const rows = Array.isArray(samples) ? samples : [];
    for (const row of rows) {
      if (!row || !row.snapshot) continue;
      const changedProperties = differenceCount(row.snapshot);
      if (changedProperties > maxChangedProperties) {
        maxChangedProperties = changedProperties;
        representative = { atY: row.atY, snapshot: row.snapshot };
      }
    }
    const finalChangedProperties = differenceCount(after);
    const changedDuringSweep = maxChangedProperties > 0;
    if (!changedDuringSweep && finalChangedProperties > 0) {
      maxChangedProperties = finalChangedProperties;
      representative = { atY: null, snapshot: after };
    }
    return {
      changed: changedDuringSweep || finalChangedProperties > 0,
      changedDuringSweep,
      returnedToStart: changedDuringSweep && finalChangedProperties === 0,
      representative,
      maxChangedProperties,
      sampleCount: rows.filter((row) => row && row.snapshot).length,
    };
  }

  // A named/structured animation can keep advancing while the scroll sweep happens without
  // being CAUSED by scroll. Preserve an already-strong measured trigger; infer scroll only
  // when the sweep is the first strong temporal evidence.
  function triggerForSweep(temporal) {
    return temporal && temporal.candidate === "strong" && temporal.trigger
      ? temporal.trigger
      : "scroll-sweep";
  }

  function mutationTemporalEvidence(samples) {
    const rows = (samples || []).filter((sample) => sample && sample.snapshot);
    if (rows.length < 3) return null;
    const distinct = new Set(rows.map((sample) => JSON.stringify(sample.snapshot))).size;
    const durationMs = Number(rows[rows.length - 1].t) - Number(rows[0].t);
    if (distinct < 2 || !Number.isFinite(durationMs) || durationMs < 32) return null;
    const ys = new Set(rows.map((sample) => Number(sample.atY)).filter(Number.isFinite));
    const trigger = ys.size > 1 ? "scroll-sweep" : "load";
    const differenceCount = (a, b) => {
      let count = 0;
      for (const field of ["opacity", "transform", "filter", "visibility", "display"])
        if (a[field] !== undefined && b[field] !== undefined && a[field] !== b[field]) count++;
      return count;
    };
    let representative = rows[0];
    for (const sample of rows) {
      if (differenceCount(rows[0].snapshot, sample.snapshot) > differenceCount(rows[0].snapshot, representative.snapshot)) representative = sample;
    }
    if (!differenceCount(rows[0].snapshot, representative.snapshot)) return null;
    return {
      trigger,
      before: rows[0].snapshot,
      after: rows[rows.length - 1].snapshot,
      during: representative.snapshot,
      sampleCount: rows.length,
      durationMs: num(durationMs),
      returnedToStart: styleSnapEq(rows[0].snapshot, rows[rows.length - 1].snapshot),
    };
  }

  // Sample an element's transform translation over a wall-clock window → px/sec on the
  // DOMINANT axis (a logo belt is usually horizontal, a ticker/credits roll is vertical —
  // sampling only X would read a vertical marquee as 0 and "pass" a frozen one). Playbook §8:
  // "measure the real speed — sample the transform over 1s → px/sec"; never eyeball.
  function sampleTranslateSpeed(el, ms) {
    return new Promise((resolve) => {
      const read = () => {
        const m = /matrix(3d)?\(([^)]+)\)/.exec(getComputedStyle(el).transform);
        if (!m) return { x: 0, y: 0 };
        const p = m[2].split(",").map((s) => parseFloat(s.trim()));
        return m[1] ? { x: p[12], y: p[13] } : { x: p[4], y: p[5] }; // matrix3d tx/ty at 12/13; matrix at 4/5
      };
      const t0 = now(), s0 = read();
      setTimeout(() => {
        const t1 = now(), s1 = read();
        const dtSec = (t1 - t0) / 1000;
        const dx = Math.abs(s1.x - s0.x), dy = Math.abs(s1.y - s0.y);
        const axis = dx >= dy ? "x" : "y";
        const dist = Math.max(dx, dy);
        resolve({ pxPerSec: dtSec > 0 ? num(dist / dtSec) : 0, axis, from: num(axis === "x" ? s0.x : s0.y), to: num(axis === "x" ? s1.x : s1.y), sampledMs: num(t1 - t0) });
      }, ms);
    });
  }

  // Wait for a MutationObserver to go quiet for `quietMs`, capped at `maxMs`. Used to let a
  // one-shot reveal settle before snapshotting its end state (never a fixed guess-sleep).
  function waitQuiet(target, quietMs, maxMs) {
    return new Promise((resolve) => {
      let timer, done = false;
      const finish = () => { if (done) return; done = true; try { mo.disconnect(); } catch (e) {} resolve(); };
      const mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(finish, quietMs); });
      mo.observe(target, { attributes: true, attributeFilter: ["class", "style"], subtree: true, attributeOldValue: false });
      timer = setTimeout(finish, quietMs);
      setTimeout(finish, maxMs); // hard cap — a page that mutates forever must not hang discovery
    });
  }

  // waitQuiet settles on MUTATION quiet — but a CSS transition mutates no attribute, so it
  // returns while an `opacity .3s` fade is still mid-flight and the "end state" snapshot lands on
  // a random frame (measured on aloyoga: the same four panels read opacity 1, 0.314, 1, 0.315 in
  // one pass — noise, not a measurement, and the gate would compare it against the clone's noise).
  // Read the element's own declared transition-duration/delay and wait it out, so `after` is the
  // SETTLED end state. Bounded by the same cap as everything else — never an unbounded wait.
  const maxSeconds = (v) => Math.max(0, ...String(v || "0s").split(",").map((s) => parseFloat(s) * (s.indexOf("ms") > -1 ? 1e-3 : 1) || 0));
  function settleTransition(el, maxMs) {
    const cs = getComputedStyle(el);
    const ms = (maxSeconds(cs.transitionDuration) + maxSeconds(cs.transitionDelay)) * 1000;
    if (!ms) return Promise.resolve();
    return new Promise((r) => setTimeout(r, Math.min(ms + 50, maxMs))); // +50ms: land past the final frame, not on it
  }

  // Scripted scroll sweep in increments, dwelling briefly at each stop so scroll-linked /
  // IntersectionObserver-triggered reveals get a chance to fire (playbook §8a).
  async function scrollSweep(steps, dwellMs, onSample) {
    const max = Math.max(0, (document.scrollingElement || document.documentElement).scrollHeight - window.innerHeight);
    const positions = [];
    for (let i = 0; i <= steps; i++) {
      const y = Math.round((max * i) / steps);
      window.scrollTo(0, y);
      positions.push(y);
      await new Promise((r) => setTimeout(r, dwellMs));
      if (onSample) onSample(y);
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, dwellMs));
    return { from: 0, to: max, steps, positions };
  }

  // Dispatch a synthetic hover on `el` (pointerover/enter + mouseover/enter — physical hover
  // doesn't persist across separate automation calls, playbook §9), wait for it to settle,
  // return the snapshot delta on `scope` (the element or a documented ancestor scope).
  // A synthetic MouseEvent cannot reproduce a real pointer: it does not set the CSS `:hover`
  // pseudo-class, and JS that gates on a trusted event (or reads `matches(':hover')`) ignores it.
  // On aloyoga the mega-menu is opened by JS class-toggling (`navOpenOnHoverChild`) on a real
  // pointer: the panel is pre-mounted and `visibility: hidden`, so under the synthetic probe
  // NOTHING moves — before === after, descendants flat — and the probe recorded `changed: false`.
  //
  // That is the trap: `changed: false` is ABSENCE OF EVIDENCE, not evidence of absence, and it
  // is byte-identical to what a clone with no menu at all produces. The gate then passed a clone
  // missing the entire mega-menu.
  //
  // We cannot fire a real hover from in-page script. What we CAN do is refuse to launder that
  // failure into a pass: naming a hover trigger is the operator ASSERTING something opens there,
  // so a probe that observes nothing is INCONCLUSIVE and must be disposed (reproduced and
  // confirmed in a review round, or written down as a deviation) — never silently green.
  async function probeHover(el, scope, settleMs) {
    // A hover that MOUNTS content (a mega-menu portal) changes the scope's CHILDREN, not the
    // scope's own opacity/transform — snapshotting only the scope's style would read a mounted
    // menu as "nothing changed". Count descendants too; either delta counts as a real change.
    const snapScope = (s) => Object.assign(styleSnap(s), { descendants: s.querySelectorAll("*").length });
    const before = snapScope(scope);
    for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter"])
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    await waitQuiet(scope, 150, settleMs);
    await settleTransition(scope, settleMs);
    const after = snapScope(scope);
    // reset — move focus away so a later probe doesn't inherit an open state
    for (const type of ["pointerout", "pointerleave", "mouseout", "mouseleave"])
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));
    const eventChanged = !styleSnapEq(before, after) || before.descendants !== after.descendants;
    const out = { before, after, changed: eventChanged };
    // Nothing moved under a probe that structurally cannot fire a real-pointer reveal → say so.
    // The gate turns this into a row that must be disposed, instead of a silent pass.
    if (!eventChanged) {
      out.inconclusive = true;
      out.inconclusiveReason = "the probe observed nothing — which is NOT proof nothing happens. Either the mechanism did not fire (a synthetic MouseEvent sets no CSS :hover and satisfies no trusted-event-gated JS), or the reveal paints OUTSIDE the snapshotted scope (aloyoga: a PRE-MOUNTED panel that only flips `visibility`, so the default scope — document.body — sees neither a style change nor a descendant-count change). Pass a findScope pointing at the element that actually paints, then re-probe";
    }
    return out;
  }

  // A stable key for a behavior: prefer an explicit id/data-testid/aria-label, else a
  // class-based descriptor, else a structural path. Stability across live/clone captures
  // matters more than prettiness — the gate keys off exact string match.
  function keyOf(el, prefix) {
    const id = el.id || el.getAttribute("data-testid") || el.getAttribute("aria-label");
    if (id) return `${prefix}:${id}`;
    const cls = (typeof el.className === "string" ? el.className : "").trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
    if (cls) return `${prefix}:${el.tagName.toLowerCase()}.${cls}`;
    let path = el.tagName.toLowerCase(), e = el, hops = 0;
    while (e.parentElement && hops < 3) { const i = [...e.parentElement.children].indexOf(e); path = `${e.parentElement.tagName.toLowerCase()}>${path}[${i}]`; e = e.parentElement; hops++; }
    return `${prefix}:${path}`;
  }

  function selectorOf(el) {
    if (el.id) {
      const escaped = root.CSS && typeof root.CSS.escape === "function" ? root.CSS.escape(el.id) : String(el.id).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
      return `#${escaped}`;
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 5) {
      let part = cur.tagName.toLowerCase();
      if (cur.parentElement) {
        const peers = [...cur.parentElement.children].filter((node) => node.tagName === cur.tagName);
        if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(">");
  }

  // ── the discovery + measurement pass ─────────────────────────────────────────
  // opts: { scrollSteps=6, dwellMs=250, hoverTriggers=[[name, findFn]], marqueeSelectors=[…],
  //         settleMs=1500 }
  async function discover(opts) {
    const o = Object.assign({ scrollSteps: 6, dwellMs: 250, hoverTriggers: [], marqueeSelectors: [], settleMs: 1500 }, opts || {});
    const startedAt = new Date().toISOString();
    const t0 = now();
    const scanRoot = document.body;

    const { keyframes, candidates } = staticCandidates(scanRoot);
    const before = new Map(candidates.map((c) => [c.el, styleSnap(c.el)]));
    const sweepSamples = new Map(candidates.map((c) => [c.el, []]));

    // dynamic pass: MutationObserver across the whole region while we sweep+dwell
    const mutated = new Set();
    const mutationSamples = new Map();
    const mo = new MutationObserver((records) => {
      const t = now();
      for (const r of records) {
        if (!r.target || r.target.nodeType !== 1) continue;
        const el = r.target;
        mutated.add(el);
        const rows = mutationSamples.get(el) || [];
        const snapshot = styleSnap(el);
        const previous = rows[rows.length - 1];
        if (!previous || !styleSnapEq(previous.snapshot, snapshot)) rows.push({ t, atY: window.scrollY, snapshot });
        if (rows.length > 80) rows.shift();
        mutationSamples.set(el, rows);
      }
    });
    mo.observe(scanRoot, { attributes: true, attributeFilter: ["class", "style"], subtree: true, attributeOldValue: false, childList: true });

    const sweep = await scrollSweep(o.scrollSteps, o.dwellMs, (atY) => {
      for (const { el } of candidates) sweepSamples.get(el).push({ atY, snapshot: styleSnap(el) });
    });
    await waitQuiet(scanRoot, 200, o.settleMs);
    mo.disconnect();

    const behaviors = {};

    // reconcile: candidate whose computed style moved from its captured start state is a
    // confirmed one-shot/scroll-linked behavior. A candidate that NEVER moved is NOT
    // discarded (the pre-iphone17 rule): its markers still DECLARE intent, and in an
    // environment-inverted run (a site that gates its choreography behind no-js/bot
    // detection) nothing fires while everything is still supposed to. Unfired candidates
    // become the `declared` inventory — each gets an identity BEFORE any reproduction is
    // engineered, so two distinct behaviors can't silently merge into one invented hybrid,
    // and each row can be put in front of the reviewer ("something happens here — what?").
    const declared = {};
    for (const { el, hints, temporal } of candidates) {
      const b = before.get(el);
      const a = styleSnap(el);
      const sweepEvidence = styleSweepEvidence(b, sweepSamples.get(el), a);
      if (sweepEvidence.changed) {
        const key = keyOf(el, "reveal");
        const trigger = triggerForSweep(temporal);
        // A style change at a scroll stop is STATE evidence: it proves a reveal fired, not
        // that specialist motion work exists. Grade it with temporalEvidence's own bar
        // (motion-items keeps dormant transitions "weak"): only an element that already
        // carries an engine timing signal (a named animation with a real duration) keeps a
        // strong temporal candidate — everything else records the observation WITHOUT
        // promotion, or every ordinary reveal auto-enters the specialist motion queue.
        behaviors[key] = {
          trigger,
          kind: "class-toggle-or-style-mutation",
          selector: selectorOf(el),
          hints,
          temporal: {
            ...(temporal || {}),
            trigger,
            reason: sweepEvidence.returnedToStart
              ? "computed style changed during the measured scroll sweep and returned to its start state"
              : "computed style changed during the measured scroll sweep",
          },
          measured: {
            before: b,
            after: a,
            ...(sweepEvidence.changedDuringSweep ? { during: sweepEvidence.representative } : {}),
            changedDuringSweep: sweepEvidence.changedDuringSweep,
            returnedToStart: sweepEvidence.returnedToStart,
            maxChangedProperties: sweepEvidence.maxChangedProperties,
            sampleCount: sweepEvidence.sampleCount,
            mutatedDuringSweep: mutated.has(el),
          },
        };
      } else {
        const key = keyOf(el, "declared");
        if (!declared[key]) declared[key] = { hints, ...(temporal ? { temporal } : {}), startState: b, text: (el.textContent || "").trim().slice(0, 60) || null };
      }
    }
    // any element the observer saw mutate but that wasn't a static candidate (e.g. a purely
    // JS-timed rotation with no CSS keyframe/class marker) still counts — MEASURE its delta
    for (const el of mutated) {
      if (!inRegion(el)) continue;
      if (before.has(el)) continue; // already reconciled above
      const key = keyOf(el, "mutation");
      if (behaviors[key]) continue;
      const measuredMotion = mutationTemporalEvidence(mutationSamples.get(el));
      // Same deliberate grading as the static pass above: a handful of class/childList
      // mutations spread across scroll stops is how ordinary content mounts and reveals
      // look, so the sampled observation alone never promotes. Promotion requires the
      // element itself to carry engine timing evidence right now (temporalEvidence's bar —
      // a named animation with a real duration; a dormant transition stays weak).
      const cs = getComputedStyle(el);
      const engine = temporalEvidence(cs, declaredHints(el, cs));
      behaviors[key] = measuredMotion && engine && engine.candidate === "strong" ? {
        trigger: measuredMotion.trigger,
        kind: "animation",
        selector: selectorOf(el),
        temporal: {
          ...engine,
          trigger: measuredMotion.trigger,
          durationMs: measuredMotion.durationMs,
          reason: "repeated computed temporal-style mutations were measured during discovery on an element with an active engine timing declaration",
        },
        measured: measuredMotion,
      } : measuredMotion ? {
        // Observation recorded without promotion: keep the sampled states but NOT the
        // sampled durationMs — a temporal field in `measured` is itself a motion-owner
        // signal (motion-items hasTemporalField), and mutation spread is not a timing.
        trigger: "mutation",
        kind: "observed-mutation",
        selector: selectorOf(el),
        measured: { before: measuredMotion.before, after: measuredMotion.after, during: measuredMotion.during, sampleCount: measuredMotion.sampleCount, returnedToStart: measuredMotion.returnedToStart },
      } : { trigger: "mutation", kind: "observed-mutation", selector: selectorOf(el), measured: { after: styleSnap(el), sampleCount: (mutationSamples.get(el) || []).length } };
    }

    // marquees: explicit selectors (the caller names the moving belt — playbook §8: "animate
    // the WHOLE wrapper, not one inner track", so discovery measures the wrapper the caller
    // points at, never guesses which of several nested tracks is the real mover)
    for (const [name, sel] of o.marqueeSelectors) {
      const el = typeof sel === "function" ? sel() : document.querySelector(sel);
      if (!el) continue;
      const speed = await sampleTranslateSpeed(el, 1000);
      const key = `marquee:${name}`;
      behaviors[key] = {
        trigger: "load",
        kind: "marquee",
        ...(typeof sel === "string" ? { selector: sel } : {}),
        measured: speed,
      };
    }

    // hover-mounted content: caller supplies [name, triggerFindFn, scopeFindFn?]
    for (const [name, findTrigger, findScope] of o.hoverTriggers) {
      const trigger = typeof findTrigger === "function" ? findTrigger() : document.querySelector(findTrigger);
      if (!trigger) continue;
      const scope = (findScope ? (typeof findScope === "function" ? findScope() : document.querySelector(findScope)) : null) || document.body;
      const result = await probeHover(trigger, scope, Math.min(o.settleMs, 1200));
      const key = `hover:${name}`;
      behaviors[key] = { trigger: "hover", kind: "hover-mount", measured: result };
    }

    const endedAt = new Date().toISOString();
    return {
      url: location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
      mode: document.compatMode,
      // discovery pass metadata — the evidence that discovery ACTUALLY RAN (an absent/empty
      // behaviors object could otherwise mean "nothing dynamic" OR "the script never fired").
      discovery: {
        startedAt, endedAt, durationMs: num(now() - t0),
        // A BACKGROUND tab throttles timers and does not advance CSS transitions — a capture taken
        // there reports whatever frame the fade happened to be stuck on (measured: the same four
        // panels read opacity 1 foregrounded and 0 hidden). Those numbers are an artifact of the
        // capture environment, not of the page, and comparing live-foregrounded against
        // clone-hidden invents a miss that does not exist. Record it so the gate can refuse it —
        // silently emitting throttled values is how a whole session gets spent chasing a ghost.
        documentHidden: typeof document.hidden === "boolean" ? document.hidden : null,
        scrollSweep: sweep,
        observeMs: o.settleMs,
        elementsScanned: scanRoot.querySelectorAll("*").length,
        staticCandidateCount: candidates.length,
        keyframesFound: keyframes,
        hoverTriggersProbed: o.hoverTriggers.map(([n]) => n),
        marqueeSelectorsProbed: o.marqueeSelectors.map(([n]) => n),
      },
      behaviors,
      declared,
    };
  }

  root.pxBehaviorDiscover = discover;
  root.pxBehaviorCapture = function (opts) { return discover(opts).then((snap) => JSON.stringify(snap, null, 2)); };
  // Same delivery pattern as browser-capture.js: direct POST preferred; stash/read fallback
  // for a CSP that blocks page→localhost fetch.
  root.pxBehaviorSend = function (url, opts) {
    return discover(opts).then((snap) => fetch(url, { method: "POST", body: JSON.stringify(snap) }).then((r) => r.text()));
  };
  const DEFAULT_CHUNK = 900;
  root.pxBehaviorStash = async function (opts, chunk) {
    const json = JSON.stringify(await discover(opts));
    const size = chunk || DEFAULT_CHUNK;
    let ta = document.getElementById("__pxbehavior");
    if (!ta) { ta = document.createElement("textarea"); ta.id = "__pxbehavior"; ta.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px"; document.body.appendChild(ta); }
    ta.value = json; ta.dataset.chunk = size;
    return { bytes: json.length, chunks: Math.ceil(json.length / size), chunkSize: size };
  };
  root.pxBehaviorRead = function (i) {
    const ta = document.getElementById("__pxbehavior");
    if (!ta) return null;
    const size = Number(ta.dataset.chunk) || DEFAULT_CHUNK;
    return ta.value.slice(i * size, (i + 1) * size);
  };

  // Expose the pure, DOM-reading internals to node so the CAPTURE half can be fixtured (the
  // gate half already was). Without this the capture is only testable by driving a browser,
  // which is exactly how a capture-side blind spot (a reveal it never records) stays invisible
  // to the regression suite. Harmless in the browser — `module` is undefined there.
  if (typeof module !== "undefined" && module.exports) module.exports = { probeHover, styleSnap, styleSnapEq, styleSweepEvidence, triggerForSweep, mutationTemporalEvidence, isAgentDom, meaningfulTransform, temporalEvidence, AGENT_DOM_SELECTOR };
})(typeof window !== "undefined" ? window : globalThis);
