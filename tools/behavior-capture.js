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
//                     behavior; whatever stayed frozen in its start state is presentational
//                     noise (a candidate that never fires isn't a behavior to reproduce).
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

  root.pxRegion = root.pxRegion || { maxY: 200 };
  const inRegion = (el) => {
    const reg = root.pxRegion || {};
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
  function declaredHints(el, cs) {
    const hints = [];
    if (cs.animationName && cs.animationName !== "none") hints.push("animation-name:" + cs.animationName);
    if (el.className && typeof el.className === "string" && MARKER_RE.test(el.className)) hints.push("class-marker");
    if (el.hasAttribute("data-state") || el.hasAttribute("data-starting-style")) hints.push("data-state");
    if (cs.willChange && cs.willChange !== "auto") hints.push("will-change:" + cs.willChange);
    for (const a of el.attributes) if (DECLARED_ATTR_RE.test(a.name)) hints.push("attr:" + a.name);
    // a transition paired with a hidden/offset start state = a reveal waiting for a trigger
    if (cs.transitionDuration && cs.transitionDuration !== "0s" && (parseFloat(cs.opacity) === 0 || (cs.transform && cs.transform !== "none"))) hints.push("transition-from-start-state");
    if (el.tagName === "VIDEO") hints.push(`video:${el.autoplay ? "autoplay" : "scripted"}:${el.preload || "auto"}`);
    return hints;
  }
  function staticCandidates(root_) {
    const kf = keyframeNames();
    const out = [];
    const all = root_.querySelectorAll("*");
    for (const el of all) {
      if (!inRegion(el)) continue;
      const cs = getComputedStyle(el);
      const hints = declaredHints(el, cs);
      if (hints.length) out.push({ el, hints });
    }
    return { keyframes: [...kf], candidates: out };
  }

  // ── dynamic differential pass (authoritative) ────────────────────────────────
  // Per-element snapshot: opacity/transform/filter, the three properties JS-driven reveals
  // and rotations actually touch (per the playbook). Cheap enough to run on every candidate
  // plus a bounded scan of the region without a real perf hit.
  function styleSnap(el) {
    const cs = getComputedStyle(el);
    return { opacity: num(cs.opacity), transform: cs.transform === "none" ? "none" : cs.transform, filter: cs.filter === "none" ? "none" : cs.filter };
  }
  const styleSnapEq = (a, b) => a.opacity === b.opacity && a.transform === b.transform && a.filter === b.filter;

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

  // Scripted scroll sweep in increments, dwelling briefly at each stop so scroll-linked /
  // IntersectionObserver-triggered reveals get a chance to fire (playbook §8a).
  async function scrollSweep(steps, dwellMs) {
    const max = Math.max(0, (document.scrollingElement || document.documentElement).scrollHeight - window.innerHeight);
    const positions = [];
    for (let i = 0; i <= steps; i++) {
      const y = Math.round((max * i) / steps);
      window.scrollTo(0, y);
      positions.push(y);
      await new Promise((r) => setTimeout(r, dwellMs));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, dwellMs));
    return { from: 0, to: max, steps, positions };
  }

  // Dispatch a synthetic hover on `el` (pointerover/enter + mouseover/enter — physical hover
  // doesn't persist across separate automation calls, playbook §9), wait for it to settle,
  // return the snapshot delta on `scope` (the element or a documented ancestor scope).
  async function probeHover(el, scope, settleMs) {
    // A hover that MOUNTS content (a mega-menu portal) changes the scope's CHILDREN, not the
    // scope's own opacity/transform — snapshotting only the scope's style would read a mounted
    // menu as "nothing changed". Count descendants too; either delta counts as a real change.
    const snapScope = (s) => Object.assign(styleSnap(s), { descendants: s.querySelectorAll("*").length });
    const before = snapScope(scope);
    for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter"])
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    await waitQuiet(scope, 150, settleMs);
    const after = snapScope(scope);
    // reset — move focus away so a later probe doesn't inherit an open state
    for (const type of ["pointerout", "pointerleave", "mouseout", "mouseleave"])
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));
    return { before, after, changed: !styleSnapEq(before, after) || before.descendants !== after.descendants };
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

    // dynamic pass: MutationObserver across the whole region while we sweep+dwell
    const mutated = new Set();
    const mo = new MutationObserver((records) => { for (const r of records) if (r.target && r.target.nodeType === 1) mutated.add(r.target); });
    mo.observe(scanRoot, { attributes: true, attributeFilter: ["class", "style"], subtree: true, attributeOldValue: false, childList: true });

    const sweep = await scrollSweep(o.scrollSteps, o.dwellMs);
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
    for (const { el, hints } of candidates) {
      const b = before.get(el);
      const a = styleSnap(el);
      if (!styleSnapEq(a, b)) {
        const key = keyOf(el, "reveal");
        behaviors[key] = {
          trigger: "scroll",
          kind: "class-toggle-or-style-mutation",
          hints,
          measured: { before: b, after: a, mutatedDuringSweep: mutated.has(el) },
        };
      } else {
        const key = keyOf(el, "declared");
        if (!declared[key]) declared[key] = { hints, startState: b, text: (el.textContent || "").trim().slice(0, 60) || null };
      }
    }
    // any element the observer saw mutate but that wasn't a static candidate (e.g. a purely
    // JS-timed rotation with no CSS keyframe/class marker) still counts — MEASURE its delta
    for (const el of mutated) {
      if (!inRegion(el)) continue;
      if (before.has(el)) continue; // already reconciled above
      const key = keyOf(el, "mutation");
      if (behaviors[key]) continue;
      behaviors[key] = { trigger: "mutation", kind: "observed-mutation", measured: { after: styleSnap(el) } };
    }

    // marquees: explicit selectors (the caller names the moving belt — playbook §8: "animate
    // the WHOLE wrapper, not one inner track", so discovery measures the wrapper the caller
    // points at, never guesses which of several nested tracks is the real mover)
    for (const [name, sel] of o.marqueeSelectors) {
      const el = typeof sel === "function" ? sel() : document.querySelector(sel);
      if (!el) continue;
      const speed = await sampleTranslateSpeed(el, 1000);
      const key = `marquee:${name}`;
      behaviors[key] = { trigger: "load", kind: "marquee", measured: speed };
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
})(typeof window !== "undefined" ? window : globalThis);
