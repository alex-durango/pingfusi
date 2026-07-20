// In-page half of the capture pipeline, injected as plain source before navigation
// (ppk pattern: a window-attached IIFE, CSP-tolerant, no template literals). The schema
// this emits is consumed verbatim by merge.js — keep the two in lockstep.
//
// CDP's KeyframeStyle carries only {offset, easing}; this serializer is the ONLY source
// of keyframe property values. The Node side joins CDP animations to these objects via
// Animation.resolveAnimation + Runtime.callFunctionOn (stashed into byCdpId).
export const INIT_SOURCE = `(() => {
  if (window.__motionKit) return;
  const MK = (window.__motionKit = {
    byCdpId: Object.create(null),
    replays: Object.create(null),
    watched: [],
    _seen: new WeakSet(),
    _watching: false,
  });

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

  function resolvePath(path) {
    if (!path || path === 'html') return document.documentElement;
    try { return document.querySelector(path); } catch (e) { return null; }
  }

  function numOrString(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : String(v);
    if (typeof v === 'string') return v;
    try { return v.toString(); } catch (e) { return null; }
  }

  function serializeRangeOffset(r) {
    if (r == null) return null;
    if (typeof r === 'string') return r;
    let offset = null;
    try { offset = r.offset != null ? r.offset.toString() : null; } catch (e) {}
    return { rangeName: r.rangeName || null, offset };
  }

  function serializeTimeline(tl) {
    if (tl === null) return { kind: 'null' };
    if (!tl) return { kind: 'document' };
    try {
      if (typeof ViewTimeline !== 'undefined' && tl instanceof ViewTimeline) {
        return { kind: 'view', axis: tl.axis || null, subject: cssPath(tl.subject),
                 startOffset: numOrString(tl.startOffset), endOffset: numOrString(tl.endOffset) };
      }
      if (typeof ScrollTimeline !== 'undefined' && tl instanceof ScrollTimeline) {
        return { kind: 'scroll', axis: tl.axis || null, source: cssPath(tl.source) };
      }
    } catch (e) {}
    return { kind: 'document' };
  }

  MK.serializeAnimation = function (a) {
    const out = {
      ctor: a.constructor ? a.constructor.name : null,
      waapiId: a.id || null,
      animationName: a.animationName || null,
      transitionProperty: a.transitionProperty || null,
      playState: a.playState,
      playbackRate: a.playbackRate,
      startTime: numOrString(a.startTime),
      currentTime: numOrString(a.currentTime),
      timeline: serializeTimeline(a.timeline),
      rangeStart: null, rangeEnd: null,
      keyframes: null, timing: null, computed: null, target: null, pseudo: null,
    };
    try { out.rangeStart = serializeRangeOffset(a.rangeStart); } catch (e) {}
    try { out.rangeEnd = serializeRangeOffset(a.rangeEnd); } catch (e) {}
    const eff = a.effect;
    if (eff) {
      try {
        out.keyframes = eff.getKeyframes().map(function (k) {
          const o = {};
          for (const p in k) o[p] = k[p];
          return o;
        });
      } catch (e) {}
      try {
        const t = eff.getTiming();
        out.timing = { delay: t.delay, endDelay: t.endDelay, fill: t.fill,
                       iterationStart: t.iterationStart, iterations: numOrString(t.iterations),
                       duration: numOrString(t.duration), direction: t.direction, easing: t.easing };
      } catch (e) {}
      try {
        const c = eff.getComputedTiming();
        out.computed = { duration: numOrString(c.duration), activeDuration: numOrString(c.activeDuration),
                         endTime: numOrString(c.endTime), delay: c.delay, fill: c.fill };
      } catch (e) {}
      try {
        out.pseudo = eff.pseudoElement || null;
        if (eff.target) out.target = { path: cssPath(eff.target), tag: eff.target.tagName ? eff.target.tagName.toLowerCase() : null };
      } catch (e) {}
    }
    return out;
  };

  MK.snapshot = function () {
    const byCdp = {};
    const inRegistry = [];
    for (const id in MK.byCdpId) {
      byCdp[id] = MK.serializeAnimation(MK.byCdpId[id]);
      inRegistry.push(MK.byCdpId[id]);
    }
    const replayAnims = Object.keys(MK.replays).map(function (k) { return MK.replays[k]; });
    const extras = [];
    for (let i = 0; i < MK.watched.length; i++) {
      const w = MK.watched[i];
      if (inRegistry.indexOf(w.anim) !== -1 || replayAnims.indexOf(w.anim) !== -1) continue;
      const s = MK.serializeAnimation(w.anim);
      s.discoveredAt = w.at;
      extras.push(s);
    }
    return { byCdp, extras, watchedCount: MK.watched.length };
  };

  MK.keyframesRuleText = function (name) {
    const found = [];
    function walk(rules) {
      for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        if (r.type === 7 && r.name === name) found.push(r.cssText);
        else if (r.cssRules) { try { walk(r.cssRules); } catch (e) {} }
      }
    }
    for (let i = 0; i < document.styleSheets.length; i++) {
      try { walk(document.styleSheets[i].cssRules); } catch (e) {}
    }
    return found.length ? found[found.length - 1] : null;
  };

  function timingToOptions(timing) {
    const opts = {};
    if (!timing) return opts;
    if (typeof timing.delay === 'number') opts.delay = timing.delay;
    if (typeof timing.endDelay === 'number') opts.endDelay = timing.endDelay;
    if (timing.fill) opts.fill = timing.fill;
    if (typeof timing.iterationStart === 'number') opts.iterationStart = timing.iterationStart;
    if (timing.iterations != null) opts.iterations = timing.iterations === 'Infinity' ? Infinity : timing.iterations;
    if (typeof timing.duration === 'number') opts.duration = timing.duration;
    if (timing.direction) opts.direction = timing.direction;
    if (timing.easing) opts.easing = timing.easing;
    return opts;
  }

  function rangeToOption(r) {
    if (r == null) return null;
    if (typeof r === 'string') return r === 'normal' ? null : r;
    if (r.rangeName && r.offset) return r.rangeName + ' ' + r.offset;
    return r.offset || null;
  }

  function cleanKeyframes(keyframes) {
    return (keyframes || []).map(function (k) {
      const o = {};
      for (const p in k) {
        if (p === 'computedOffset') continue;
        o[p] = k[p];
      }
      if (o.offset == null && typeof k.computedOffset === 'number') o.offset = k.computedOffset;
      return o;
    });
  }

  // Replace the original animation with a replay built purely from the captured record.
  // Time-driven replays come back paused (the gate scrubs them); scroll-driven replays
  // stay live so the scroll position drives them, matching how the original is scrubbed.
  MK.replaceWithReplay = function (id, spec) {
    const original = MK.byCdpId[id];
    if (!original || !original.effect || !original.effect.target) {
      return { ok: false, error: 'original animation or target missing' };
    }
    const target = original.effect.target;
    const pseudo = original.effect.pseudoElement || null;
    const name = spec.animationName || null;
    original.cancel();
    for (let round = 0; round < 3 && name; round++) {
      // a style flush can resurrect a canceled CSS animation under the same name
      const replayAnims = Object.keys(MK.replays).map(function (k) { return MK.replays[k]; });
      const alive = target.getAnimations().filter(function (x) {
        return x !== original && x.animationName === name && replayAnims.indexOf(x) === -1;
      });
      if (!alive.length) break;
      alive.forEach(function (x) { x.cancel(); });
    }
    const opts = timingToOptions(spec.timing);
    if (pseudo) opts.pseudoElement = pseudo;
    if (spec.timeline && spec.timeline.kind === 'view') {
      const subject = resolvePath(spec.timeline.subject);
      if (!subject) return { ok: false, error: 'view timeline subject not found: ' + spec.timeline.subject };
      opts.timeline = new ViewTimeline({ subject, axis: spec.timeline.axis || 'block' });
    } else if (spec.timeline && spec.timeline.kind === 'scroll') {
      const source = resolvePath(spec.timeline.source);
      if (!source) return { ok: false, error: 'scroll timeline source not found: ' + spec.timeline.source };
      opts.timeline = new ScrollTimeline({ source, axis: spec.timeline.axis || 'block' });
    }
    const rs = rangeToOption(spec.rangeStart);
    const re = rangeToOption(spec.rangeEnd);
    if (rs) opts.rangeStart = rs;
    if (re) opts.rangeEnd = re;
    let anim;
    try {
      anim = target.animate(cleanKeyframes(spec.keyframes), opts);
    } catch (e) {
      return { ok: false, error: 'animate() failed: ' + (e && e.message) };
    }
    if (!opts.timeline) anim.pause();
    MK.replays[id] = anim;
    return { ok: true };
  };

  MK.seekReplay = function (id, t) {
    const r = MK.replays[id];
    if (!r) return false;
    r.currentTime = t;
    return true;
  };

  MK.bboxOfCdp = function (id) {
    const a = MK.byCdpId[id];
    const t = a && a.effect && a.effect.target;
    if (!t || !t.getBoundingClientRect) return null;
    const r = t.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };

  MK.seekScroll = function (path, axis, offset) {
    const el = resolvePath(path) || document.documentElement;
    const horizontal = axis === 'horizontal' || axis === 'inline' || axis === 'x';
    const opts = { behavior: 'instant' };
    if (horizontal) opts.left = offset; else opts.top = offset;
    if (el === document.documentElement || el === document.body || el === document.scrollingElement) {
      window.scrollTo(opts);
    } else {
      el.scrollTo(opts);
    }
    return true;
  };

  MK.startWatch = function () {
    if (MK._watching) return;
    MK._watching = true;
    function tick() {
      if (!MK._watching) return;
      let anims = [];
      try { anims = document.getAnimations(); } catch (e) {}
      for (let i = 0; i < anims.length; i++) {
        const a = anims[i];
        if (!MK._seen.has(a)) {
          MK._seen.add(a);
          MK.watched.push({ anim: a, at: performance.now() });
        }
      }
      requestAnimationFrame(tick);
    }
    function kick() { requestAnimationFrame(tick); }
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', kick, { once: true });
    else kick();
  };
  MK.stopWatch = function () { MK._watching = false; };
  MK.startWatch();
})();`;
