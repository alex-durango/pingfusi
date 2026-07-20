// In-page behavioral sampler (Tier 3): what rrweb deliberately doesn't do (see
// docs/prior-art/rrweb.md). Discovery is mutation-driven — every Tier 3 engine (GSAP,
// Framer Motion, anime.js, hand-rolled rAF) animates by writing inline styles, which
// fires attribute mutations; the sampler promotes mutated elements into a bounded
// tracked set and then samples decomposed transform + opacity per animation frame.
// Frames and element samples share the same per-tick timestamp so scroll pairing is exact.
export const SAMPLER_SOURCE = `(() => {
  if (window.__mkTrace) return;
  const T = (window.__mkTrace = {
    running: false,
    frames: [],
    tracked: [],
    pointer: [],
    seen: new WeakSet(),
    pending: [],
    cap: 40,
    dropped: 0,
    scope: null,
    matchedAtStart: 0,
  });

  // Pointer ground truth for pursuit fits: timestamped positions AS THE PAGE SAW THEM
  // (mousemove), never the commanded trigger path. capture+passive so page handlers
  // can't stopPropagation the record away or be slowed down by it.
  addEventListener('mousemove', function (e) {
    if (!T.running) return;
    T.pointer.push({ t: Math.round(performance.now() * 10) / 10, x: e.clientX, y: e.clientY });
  }, { capture: true, passive: true });

  const trByEl = new WeakMap();

  function inScope(el) {
    if (!T.scope) return true;
    try {
      return el.matches(T.scope) || !!el.closest(T.scope);
    } catch (e) {
      return false;
    }
  }

  // Sampling is mutation-driven (rrweb-style event records): the observer fires within a
  // microtask of each style write, so the value is read AT write time. Sampling only on
  // the rAF tick instead reads one frame stale (tick registered first) — traces become
  // ~17ms staircases: heads go missing, springs fit too stiff, and the Phase 4 replay
  // diff measures recording lag instead of fit quality.
  const mo = new MutationObserver(function (muts) {
    const now = Math.round(performance.now() * 10) / 10;
    const done = new Set();
    for (const m of muts) {
      const el = m.target;
      if (!el || el.nodeType !== 1 || done.has(el)) continue;
      done.add(el);
      const tr = trByEl.get(el);
      if (!T.running) {
        if (!T.seen.has(el)) {
          T.seen.add(el);
          T.pending.push(el);
        }
        continue;
      }
      // Scope is configured only when start() runs. An element may therefore have been
      // seen before start while out of scope; trByEl, not the discovery WeakSet, decides
      // whether its first in-scope mutation promotes it.
      if (!inScope(el)) continue;
      if (!tr) track(el, now);
      else if (now - tr.lastT > 2) sampleOne(tr, now);
    }
  });
  function arm() {
    mo.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', arm, { once: true });
  else arm();

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 12) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      if (node === document.body) { parts.unshift('body'); break; }
      const sel = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) { parts.unshift(sel); break; }
      const sibs = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
      parts.unshift(sibs.length > 1 ? sel + ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')' : sel);
      node = parent;
    }
    return parts.join(' > ');
  }

  function decompose(str) {
    if (!str || str === 'none') return { tx: 0, ty: 0, tz: 0, sx: 1, sy: 1, rot: 0 };
    const m = /matrix(3d)?\\(([^)]+)\\)/.exec(str);
    if (!m) return null;
    const v = m[2].split(',').map(Number);
    let a, b, c, d, e, f, g;
    if (m[1]) { a = v[0]; b = v[1]; c = v[4]; d = v[5]; e = v[12]; f = v[13]; g = v[14]; }
    else { a = v[0]; b = v[1]; c = v[2]; d = v[3]; e = v[4]; f = v[5]; g = 0; }
    const sx = Math.hypot(a, b);
    // scale(0) is a real, common animation endpoint (the Paysages circle starts
    // there). Treating zero as a missing decomposition fabricated scale=1 and turned
    // the trace into a discontinuity. When the first basis vector collapses, recover
    // scaleY from the second vector instead of dividing by zero.
    const sy = sx > 1e-12 ? (a * d - b * c) / sx : Math.hypot(c, d);
    return {
      tx: e, ty: f, tz: g, sx,
      sy,
      rot: Math.atan2(b, a) * (180 / Math.PI),
    };
  }

  function sampleOne(tr, t) {
    const cs = getComputedStyle(tr.el);
    const d = decompose(cs.transform);
    if (!d) return;
    tr.lastT = t;
    tr.samples.push({ t, tx: d.tx, ty: d.ty, tz: d.tz, sx: d.sx, sy: d.sy, rot: d.rot, opacity: parseFloat(cs.opacity) });
  }

  function track(el, now) {
    if (!el.isConnected || !inScope(el) || trByEl.has(el)) return;
    if (T.tracked.length >= T.cap) {
      T.dropped++; // no silent caps — surfaced in collect()
      return;
    }
    // the element's look, so Phase 4 stand-ins resemble the original
    let look = null;
    try {
      const cs = getComputedStyle(el);
      look = {
        w: el.offsetWidth || null,
        h: el.offsetHeight || null,
        radius: cs.borderRadius,
        bg: cs.backgroundColor,
        tag: el.tagName ? el.tagName.toLowerCase() : null,
      };
    } catch (e) {}
    const tr = { el, id: T.tracked.length + 1, path: cssPath(el), look, lastT: -1e9, samples: [] };
    trByEl.set(el, tr);
    sampleOne(tr, now);
    T.tracked.push(tr);
  }

  T.start = function (options) {
    // Number form remains supported for older Phase 4 bundles that call start(8).
    const opts = typeof options === 'number' ? { maxElements: options } : (options || {});
    if (opts.maxElements) T.cap = opts.maxElements;
    if (opts.scope) {
      // querySelectorAll is deliberately allowed to throw here: an invalid selector must
      // fail the command instead of producing a plausible-looking empty trace.
      const roots = Array.from(document.querySelectorAll(opts.scope));
      if (!roots.length) throw new Error('motion trace scope matched no elements: ' + opts.scope);
      T.scope = opts.scope;
      T.matchedAtStart = roots.length;
      const now = Math.round(performance.now() * 10) / 10;
      // Requested roots get the first slots before unrelated pre-start mutations drain.
      for (const root of roots) track(root, now);
    }
    if (T.running) return;
    T.running = true;
    const now = Math.round(performance.now() * 10) / 10;
    while (T.pending.length) track(T.pending.shift(), now); // mutated before start → baseline now
    function tick() {
      if (!T.running) return;
      const t = Math.round(performance.now() * 10) / 10;
      T.frames.push({ t, scrollY: scrollY, scrollX: scrollX });
      for (const tr of T.tracked) {
        if (!tr.el.isConnected) continue;
        // idle fallback only — mutation-driven samples carry the motion
        if (t - tr.lastT >= 15) sampleOne(tr, t);
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  };

  T.stop = function () {
    T.running = false;
    mo.disconnect();
  };

  T.collect = function () {
    return {
      frames: T.frames,
      pointer: T.pointer,
      dropped: T.dropped,
      maxElements: T.cap,
      scope: T.scope ? { selector: T.scope, matchedAtStart: T.matchedAtStart } : null,
      elements: T.tracked
        .filter(function (x) { return x.samples.length > 3; })
        .map(function (x) { return { id: x.id, path: x.path, look: x.look, samples: x.samples }; }),
    };
  };
})();`;
