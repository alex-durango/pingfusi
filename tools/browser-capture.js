// browser-capture.js — the BROWSER half of pixel-diff.js, extracted verbatim so it
// can be injected as plain source on a strict-CSP live site (base64 transport of the
// whole file proved fragile). Same measurement logic → schema-identical snapshots on
// live and clone; diff them with `node tools/pixel-diff.js live.json clone.json`.
(function (root) {
  "use strict";
  const num = (v) => { const n = parseFloat(v); return isNaN(n) ? v : Math.round(n * 100) / 100; };
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();

  root.pxRegion = root.pxRegion || { maxY: 200 };
  const inRegion = (el) => {
    const reg = root.pxRegion || {};
    if (reg.sel && !el.closest(reg.sel)) return false;
    const r = el.getBoundingClientRect();
    if (reg.maxY != null && r.top > reg.maxY) return false;
    if (reg.minY != null && r.bottom < reg.minY) return false;
    return r.width > 0;
  };
  const byText = (re) => {
    const hits = [...document.querySelectorAll("a,button,span,p,li,h1,h2,h3,h4,div,sup,small,strong")]
      .filter((e) => re.test(ownText(e)) && inRegion(e));
    return hits.sort((a, b) => ownText(a).length - ownText(b).length)[0] || null;
  };
  const byAria = (re) =>
    [...document.querySelectorAll("[aria-label]")].find((e) => re.test(e.getAttribute("aria-label")) && inRegion(e)) || null;

  const textBox = (el) => {
    const tn = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    if (!tn) return null;
    const r = document.createRange();
    r.selectNodeContents(tn);
    const b = r.getBoundingClientRect();
    return { x: num(b.x), right: num(b.right), top: num(b.top), bottom: num(b.bottom), w: num(b.width), h: num(b.height) };
  };

  // The STRUT of the line box that positions the glyphs: the nearest line-box CONTAINER's
  // line-height. A leaf can match live exactly (12 vs 12) while the container differs
  // (authored 16px vs `normal`) — sub-tolerance drift on the capture machine, visibly off
  // where `normal` resolves differently (the HN header miss — LEARNINGS #17). Kept
  // schema-identical with pixel-diff.js measure().
  const strutOf = (el) => {
    let e = el, hops = 0;
    while (e && hops < 8) {
      const s = getComputedStyle(e);
      if (/^(block|table-cell|list-item|flex|grid|inline-block|table-caption)$/.test(s.display)) {
        return s.lineHeight === "normal" ? "normal" : num(s.lineHeight);
      }
      e = e.parentElement; hops++;
    }
    return null;
  };

  // An underline is a painted mark with a BOX (thickness/x/width/y), not a boolean —
  // measure the element that actually draws it (often an ANCESTOR border-bottom) and
  // return its geometry, so a too-thin / too-short / mis-offset underline is caught by
  // the sweep, not by a operator three rounds later (LEARNINGS #12). Schema must match
  // pixel-diff.js's underlineBox exactly.
  const NO_UL = { present: false };
  const underlineBox = (el) => {
    let e = el, hops = 0;
    while (e && hops < 4) {
      const s = getComputedStyle(e);
      if ((s.textDecorationLine || "").includes("underline")) {
        const tb = textBox(el) || {};
        const th = s.textDecorationThickness && s.textDecorationThickness !== "auto"
          ? num(parseFloat(s.textDecorationThickness)) : "auto";
        return { present: true, thickness: th, x: tb.x ?? null, right: tb.right ?? null, w: tb.w ?? null, top: null, bottom: null };
      }
      const bbw = parseFloat(s.borderBottomWidth) || 0;
      const r = e.getBoundingClientRect();
      if (bbw > 0 && s.borderBottomStyle !== "none" && r.height < 60)
        return { present: true, thickness: num(bbw), x: num(r.x), right: num(r.right), w: num(r.width), top: num(r.bottom - bbw), bottom: num(r.bottom) };
      e = e.parentElement; hops++;
    }
    const tb = textBox(el);
    const base = el.closest("a,li") || el.parentElement;
    if (tb && base) {
      for (const cand of base.querySelectorAll("*")) {
        if (cand === el || cand.contains(el)) continue;
        const cs = getComputedStyle(cand);
        const r = cand.getBoundingClientRect();
        const bbw = parseFloat(cs.borderBottomWidth) || 0;
        const isBorder = bbw > 0 && cs.borderBottomStyle !== "none";
        const isFill = r.height <= 4;
        if ((isBorder || isFill) && r.width >= tb.w * 0.4 && r.bottom >= tb.bottom - 1 && r.bottom <= tb.bottom + 8) {
          const th = isBorder ? bbw : r.height;
          return { present: true, thickness: num(th), x: num(r.x), right: num(r.right), w: num(r.width), top: num(r.bottom - th), bottom: num(r.bottom) };
        }
      }
    }
    return NO_UL;
  };

  // The painted BACKDROP behind an element — a solid background-color is a painted
  // mark (bar/button/badge) that lives on a CONTAINER, not the leaf, so the gate
  // never saw it: a red announcement bar passed a green --visual. Walk self→ancestors
  // for the first non-transparent background-color. Schema must match pixel-diff.js.
  const TRANSPARENT_BG = "rgba(0, 0, 0, 0)";
  const isTransparent = (bc) => !bc || bc === TRANSPARENT_BG || bc === "transparent" || /,\s*0\)\s*$/.test(bc);
  const paintedBg = (el) => {
    // Walk to the ROOT for the first opaque background; a fully-transparent chain
    // resolves to the canvas default (white) so an explicit body{background:#fff}
    // clone compares EQUAL to a live canvas left transparent. Match pixel-diff.js.
    let e = el, hops = 0;
    while (e && hops < 40) {
      const bc = getComputedStyle(e).backgroundColor;
      if (!isTransparent(bc)) return bc;
      e = e.parentElement; hops++;
    }
    return "rgb(255, 255, 255)";
  };

  const depth = (e) => { let d = 0; while ((e = e.parentElement)) d++; return d; };
  // AN IMAGE'S PIXELS ARE A PAINTED MARK, AND THE BOX IS NOT THE IMAGE. A 404'd <img> whose size
  // comes from CSS has EXACTLY the box the real photo has — same rect, same centre, same backdrop,
  // still `present` — so every property the snapshot recorded matched and `--visual` went green
  // over a page full of grey holes. Measured on chrono24: 10 "most popular models" watch photos
  // failed to load in the clone (272x332 box, naturalWidth 0) and the sweep passed 5911/5911; a
  // reviewer opened the draft and the first thing they said was "the images are not rendered".
  // `complete && naturalWidth > 0` is the whole test: did this element actually rasterise pixels?
  // Kept schema-identical with pixel-diff.js. Compared ONLY as a boolean — naturalW/naturalH are
  // recorded for diagnosis but never gated, because live and the clone may legitimately settle on
  // different srcset candidates (1x vs 2x) and still paint identically.
  const imgOf = (el) => (el.tagName === "IMG" ? el : el.querySelector("img"));
  const imgPaint = (el) => {
    const im = imgOf(el);
    if (!im) return null;
    return { painted: !!(im.complete && im.naturalWidth > 0), naturalW: im.naturalWidth, naturalH: im.naturalHeight };
  };
  const glyphBox = (el) => {
    const ip = imgPaint(el);
    const wrap = (b, extra) => {
      const o = {
        cx: num(b.left + b.width / 2), cy: num(b.top + b.height / 2),
        top: num(b.top), bottom: num(b.bottom), w: num(b.width), h: num(b.height), ...extra,
      };
      if (ip) { o.painted = ip.painted; o.naturalW = ip.naturalW; o.naturalH = ip.naturalH; }
      return o;
    };
    const svg = el.tagName.toLowerCase() === "svg" ? el : el.querySelector("svg");
    if (svg) {
      const shapes = [...svg.querySelectorAll("path,circle,rect,polygon,polyline,line,ellipse,use")];
      let t = Infinity, l = Infinity, rr = -Infinity, bb = -Infinity;
      for (const s of shapes) { const r = s.getBoundingClientRect(); if (r.width || r.height) { t = Math.min(t, r.top); l = Math.min(l, r.left); rr = Math.max(rr, r.right); bb = Math.max(bb, r.bottom); } }
      if (isFinite(t)) return wrap({ left: l, top: t, width: rr - l, height: bb - t }, { src: "svg-path" });
      return wrap(svg.getBoundingClientRect(), { src: "svg" });
    }
    const withBg = [...el.querySelectorAll("*"), el].filter((e) => getComputedStyle(e).backgroundImage !== "none");
    const bgEl = withBg.sort((a, b) => depth(b) - depth(a))[0];
    if (bgEl) {
      const bc = getComputedStyle(bgEl);
      return wrap(bgEl.getBoundingClientRect(), { src: "bg", bgPos: bc.backgroundPosition, bgSize: bc.backgroundSize });
    }
    return wrap(el.getBoundingClientRect(), { src: "box" });
  };

  // `rect.prevGap` is the distance from the previous sibling's right edge — a LAYOUT fact, so it
  // must be measured against a sibling that actually LAYS OUT. previousElementSibling counts
  // elements that render nothing (<script>, <style>, <link>, <meta>, <template>, <noscript>), and
  // capture-build STRIPS exactly those (LEARNINGS #19). So a leaf preceded by a <script> gets a
  // different "previous sibling" on live than in the clone, and the strict gate reports a delta
  // for a page where nothing moved — a FALSE POSITIVE the kit manufactures itself.
  //
  // Measured on lelabo: the screenreader <h1 id="homepage-h1">Le Labo</h1> is preceded by
  // `<script> headerInitialize(); </script>`. Live: prev = the script (zero box, right edge 0) →
  // prevGap -1. Clone: the script is gone, prev = <header> (right edge 1728) → prevGap -1729. A
  // 1728px "delta" on a page where --visual is green on all 1394 comparisons. Skipping the
  // non-rendered siblings makes the measurement invariant under the build's own transform.
  // Kept schema-identical with pixel-diff.js's measure().
  const NON_RENDERED = /^(SCRIPT|STYLE|LINK|META|TEMPLATE|NOSCRIPT|TITLE|BASE|HEAD)$/;
  const prevRenderedSibling = (el) => {
    let p = el.previousElementSibling;
    while (p && (NON_RENDERED.test(p.tagName) || getComputedStyle(p).display === "none")) p = p.previousElementSibling;
    return p;
  };

  // OPACITY IS A PAINTED MARK, AND IT IS INHERITED BY COMPOSITION (harness/fixtures/38-opacity-painted-property.js).
  // The EFFECTIVE opacity — the product of every ancestor's — not the element's own: a scroll
  // reveal hides the CONTAINER, and the container's painted leaves each still compute
  // `opacity: 1`. Own-opacity would read 1 on every leaf of an invisible section and see nothing.
  // Walks to the document root; `null` when unknowable (detached), which the diff skips.
  const effectiveOpacity = (el) => {
    let o = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const v = parseFloat(getComputedStyle(n).opacity);
      if (!Number.isNaN(v)) o *= v;
      if (o === 0) break; // fully transparent: no ancestor can bring it back
    }
    return num(o);
  };

  function measure(el, want) {
    if (!el) return { present: false };
    const r = el.getBoundingClientRect();
    const c = getComputedStyle(el);
    const vw = window.innerWidth;
    const parent = el.parentElement;
    const pc = parent ? getComputedStyle(parent) : null;
    const prev = prevRenderedSibling(el);
    const out = {
      present: true,
      rect: { x: num(r.x), y: num(r.y), w: num(r.width), h: num(r.height), top: num(r.top), right: num(r.right), bottom: num(r.bottom), fromRight: num(vw - r.right) },
      font: {
        family: (c.fontFamily || "").split(",")[0].replace(/["']/g, "").trim(),
        weight: c.fontWeight, size: num(c.fontSize),
        line: c.lineHeight === "normal" ? "normal" : num(c.lineHeight),
        spacing: c.letterSpacing === "normal" ? "normal" : num(c.letterSpacing),
        transform: c.textTransform, color: c.color,
        decoration: c.textDecorationLine || "none",
        smoothing: c.webkitFontSmoothing || c.getPropertyValue("-webkit-font-smoothing") || "auto",
      },
      box: {
        padT: num(c.paddingTop), padR: num(c.paddingRight), padB: num(c.paddingBottom), padL: num(c.paddingLeft),
        marT: num(c.marginTop), marR: num(c.marginRight), marB: num(c.marginBottom), marL: num(c.marginLeft),
        bT: num(c.borderTopWidth), bR: num(c.borderRightWidth), bB: num(c.borderBottomWidth), bL: num(c.borderLeftWidth),
        sizing: c.boxSizing,
      },
      layout: {
        display: c.display, position: c.position,
        top: c.top === "auto" ? "auto" : num(c.top),
        left: c.left === "auto" ? "auto" : num(c.left),
        vAlign: c.verticalAlign,
      },
      parent: pc ? { display: pc.display, gap: pc.gap === "normal" ? 0 : num(pc.gap) } : null,
      bg: paintedBg(el),   // painted backdrop colour (bar/button/badge) — compared by --visual
      opacity: effectiveOpacity(el), // the EFFECTIVE (composited) opacity — compared by --visual
    };
    if (want && want.text) {
      out.text = textBox(el);
      out.font.strut = strutOf(el);            // the line-box container's line-height (LEARNINGS #17)
      out.underline = underlineBox(el);        // the underline as a painted BOX
      out.font.underline = out.underline.present; // boolean shorthand (back-compat)
      if (prev) out.rect.prevGap = num(r.left - prev.getBoundingClientRect().right);
    } else {
      out.glyph = glyphBox(el);
    }
    return out;
  }

  function capture(targets, opts) {
    const T = targets || root.pxTargets || [];
    const elements = {};
    for (const [name, find, text] of T) {
      let el = null;
      try { el = find(); } catch (e) {}
      elements[name] = measure(el, { text });
    }
    const snap = {
      url: location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
      // The rendering MODE is a pixel-determining property of the whole page: a quirks-mode
      // site (no doctype → "BackCompat") computes table-cell line boxes differently than a
      // standards-mode clone, shifting text with every computed style identical (LEARNINGS #18).
      mode: document.compatMode,
      elements,
    };
    return opts && opts.compact ? JSON.stringify(snap) : JSON.stringify(snap, null, 2);
  }

  root.pxByText = byText;
  root.pxByAria = byAria;
  root.pxMeasure = measure;
  root.pxCapture = capture;

  // Delivery integrity: every POST declares its exact byte count + sha256 in the query
  // string so the sink can REFUSE a truncated/corrupted delivery instead of writing it —
  // an 817 KB DOM once lost bytes in transit on every POST transport, and the gates then
  // certified the truncated page (23 of ~230 real targets measured). String .length is NOT
  // the byte count (multi-byte glyphs), so declare from the UTF-8 bytes the wire carries.
  const utf8 = (s) => new TextEncoder().encode(s);
  const sha256Hex = (bytes) =>
    root.crypto && root.crypto.subtle
      ? root.crypto.subtle.digest("SHA-256", bytes).then((d) => [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""))
      : Promise.resolve(null); // non-secure context: the byte count alone still gates truncation
  const withIntegrity = (url, bytes) =>
    sha256Hex(bytes).then((h) => url + (url.includes("?") ? "&" : "?") + "bytes=" + bytes.length + (h ? "&sha256=" + h : ""));

  root.pxSend = function (url, targets) {
    const body = capture(targets, { compact: true });
    return withIntegrity(url, utf8(body)).then((u) => fetch(u, { method: "POST", body })).then((r) => r.text());
  };
  // pxScrollSettle — walk the FULL page before a DOM capture, then return to top.
  // Paid for on aloyoga: dom.html was captured at top-of-page, so (a) a lazy section
  // ("AS SEEN ON") had never rendered — it existed only as JSON inside a <script> the
  // build then stripped, gone without trace — and (b) every below-fold scroll-reveal was
  // frozen at its inline START state (opacity:0 + transition), invisible forever in the
  // static clone. Scrolling fires the IntersectionObservers and lazy loaders; waiting lets
  // reveals finish and inline styles land at their END state; scrolling back restores the
  // top-of-page header state (sticky headers change class/geometry mid-scroll) so the
  // capture still matches what the gates measure. Returns {scrolledTo, frozenOpacity0} —
  // a nonzero frozenOpacity0 means some reveals STILL haven't fired (viewport-specific
  // triggers, hover-gated) — inspect them before capturing, don't hope.
  // REACHING THE BOTTOM IS NOT THE SAME AS BEING SETTLED. The original loop walked down until
  // `y + innerHeight >= scrollHeight` and returned — but a section that mounts ASYNCHRONOUSLY
  // (fetched after load, hydrated by a framework) lands a beat AFTER the walk passes its slot, so
  // the walk ends, the DOM is captured, and the section is not in it.
  //
  // Measured on gorjana (2026-07-13): settle returned `scrolledTo: 4439`; moments later the live
  // document was **5877px** — a Shopify product-recommendations carousel (23 product tiles, 25
  // swipers, a 583px-tall slider) had hydrated into `<div data-vue="recommendations">` after the
  // sweep finished. The clone was built from that pre-hydration DOM and shipped an EMPTY mount
  // point. And because the leaf enumeration is derived from the same captured DOM, the missing
  // section was never enumerated: `--visual` 1300/1300, strict 4144/4144, coverage 88/88 — every
  // gate green over a page with a hole in it. A gate cannot see what was never enumerated.
  //
  // So: sweep, then REQUIRE the document height to hold still across consecutive checks; if it
  // grew, sweep again (the new content may itself lazy-load). Bounded, and the evidence is
  // returned — `stable:false` means the page was STILL growing when we gave up, and a DOM
  // captured then is not the page.
  root.pxScrollSettle = function (opts) {
    const o = opts || {};
    const pause = o.pause || 300;        // per-step: long enough for observers + image kicks
    const settle = o.settle || 1500;     // at bottom and back at top: reveal transitions run ~1s
    const stableChecks = o.stableChecks || 3;   // consecutive equal heights required
    const stableGapMs = o.stableGapMs || 500;   // wait between height checks
    const maxSweeps = o.maxSweeps || 5;         // re-sweep this many times if the page grew
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const docHeight = () => document.documentElement.scrollHeight;
    // A MEASUREMENT SCROLL MUST BE INSTANT — `scrollTo(0, y)` obeys the PAGE's CSS
    // `scroll-behavior`, and a site that sets `scroll-behavior: smooth` turns every step of the
    // sweep into an rAF-driven ANIMATION. The sweep's fixed `pause` then races that animation, and
    // when rAF is throttled (a background/hidden tab — routine under automation) the scroll NEVER
    // LANDS AT ALL. Measured on chrono24 (html { scroll-behavior: smooth }): scrollTo(0, 1000) left
    // scrollY at 7743 — unmoved — while scrollTo({top:1000, behavior:"instant"}) landed exactly.
    // The settle then walked nothing, saw a height that never changed *because nothing scrolled*,
    // and returned `stable: true` over a page it had never visited: lazy sections unmounted, lazy
    // images unloaded, and a confident verdict. That is LEARNINGS #22 exactly — a probe that cannot
    // fire the mechanism it is probing must never report success. The instrument's own scroll is
    // not a user gesture to be animated; it is a measurement, and it must be exact.
    const scrollToY = (y) => {
      try { root.scrollTo({ top: y, left: 0, behavior: "instant" }); }
      catch (e) { root.scrollTo(0, y); }   // ancient host without the options form
    };
    return (async () => {
      const heights = [];
      let sweeps = 0, stable = false;
      const sweepOnce = async () => {
        const step = Math.max(400, Math.floor(root.innerHeight * 0.8));
        let y = 0, guard = 0;
        // scrollHeight GROWS as lazy sections mount — re-read it every step, don't snapshot it
        while (y + root.innerHeight < docHeight() && guard++ < (o.maxSteps || 300)) {
          y += step;
          scrollToY(y);
          await sleep(pause);
        }
        scrollToY(docHeight());
        await sleep(settle);
      };
      // The watch loop MUST be bounded. An unbounded "wait until it holds still" hangs forever on a
      // page that never holds still (an infinite feed) — that trades a silent miss for a silent
      // hang, which is not a fix. Bounded here, and bounded again by maxSweeps.
      const maxChecks = o.maxChecks || stableChecks * 4 + 8;
      while (sweeps < maxSweeps) {
        sweeps++;
        await sweepOnce();
        // hold at the bottom and watch the height: an async section mounts here, not during the walk
        const before = docHeight();
        heights.push(before);
        let held = 1, checks = 0;
        while (held < stableChecks && checks++ < maxChecks) {
          await sleep(stableGapMs);
          const h = docHeight();
          if (h !== heights[heights.length - 1]) { heights.push(h); held = 1; }  // it grew — restart the count
          else held++;
        }
        // stable only if the height held through every check AND is the one we started this watch on
        if (held >= stableChecks && docHeight() === before) { stable = true; break; }
        // it grew (or never held) → sweep again: the new content may itself lazy-load
      }
      scrollToY(0);   // instant, for the same reason the sweep is: a smooth return never lands
      await sleep(settle);
      // HEIGHT HOLDING STILL IS NOT THE PAGE BEING READY. The height watch above only proves that
      // nothing more is MOUNTING. A lazy <img> that has not loaded yet changes no height — it
      // occupies a ZERO-WIDTH box until its bytes arrive, and then it reflows its row.
      //
      // Measured on chrono24 (2026-07-13): the footer QR code (<img loading="lazy" height="90">,
      // no width attr) was still `complete:false` when settle returned `stable:true`. live.json
      // recorded it at w=0, so the two app-store badges beside it sat 90px to the LEFT of where a
      // real user sees them. The clone loaded the same image fine — and the gate blamed the CLONE
      // for a 90px shift it did not cause. The reference was a page state no user ever sees
      // (LEARNINGS #20: the reference must be the site, not the instrument's accident).
      //
      // So readiness = the height held still AND every RENDERED image has finished loading.
      // `complete` is the right predicate, not naturalWidth: a genuine 404 settles to
      // complete=true with naturalWidth 0, and its zero box is the site's real rendering — we
      // must reproduce that, not wait for it. Only `!complete` means "still in flight, this box
      // is provisional".
      //
      // NARROW — "does it RENDER", and the test for that is a LAYOUT BOX, not a computed display.
      // The first cut of this rule asked `getComputedStyle(img).display !== "none"`, which is
      // wrong: an element inside a display:none ANCESTOR still computes its own display as
      // "block". chrono24 proved it immediately — the one image that never loaded was a 32x32
      // badge inside `#js-header-security-flyout`, a display:none header flyout eight levels up.
      // It has no box, paints nothing, and can never reflow anything, yet the naive rule counted
      // it and refused the capture forever. Hidden menus, closed flyouts and offscreen templates
      // hold pending images on most real sites, so that rule would have blocked nearly every page.
      // `getClientRects().length` is the honest question — it is 0 for anything not rendered, for
      // whatever reason (its own display:none, an ancestor's, an unattached subtree) — and it
      // subsumes the display:none tracking pixel too.
      const pendingImages = () => {
        const imgs = document.images ? [...document.images] : [];
        return imgs.filter((im) => {
          if (im.complete) return false;
          // no layout box ⇒ it paints nothing and cannot shift anything when it lands
          if (typeof im.getClientRects === "function") return im.getClientRects().length > 0;
          return true;
        });
      };
      const imgWaitMs = o.imageWaitMs || 8000;
      let waited = 0;
      while (pendingImages().length && waited < imgWaitMs) { await sleep(250); waited += 250; }
      const stillPending = pendingImages();
      const imagesPending = stillPending.length;
      // An image still in flight after the bound means the page is NOT in its final layout. Say so
      // — `stable:false` is the contract the RUNBOOK already tells the operator to stop on. Never
      // hand back a settled-looking verdict over a page whose boxes are still provisional.
      if (imagesPending) stable = false;
      const frozenOpacity0 = document.querySelectorAll('[style*="opacity: 0"], [style*="opacity:0"]').length;
      const scrolledTo = docHeight();
      // `stable:false` = the document was still growing when we hit the sweep cap, OR an image is
      // still loading. Capturing now yields a page that does not exist. Investigate, don't hope.
      return {
        scrolledTo, frozenOpacity0, stable, sweeps, heights, imagesPending,
        pendingImageSrcs: stillPending.slice(0, 5).map((im) => im.currentSrc || im.src || "(no src)"),
      };
    })();
  };
  // The full post-hydration DOM, doctype INCLUDED-OR-ABSENT exactly as live ships it —
  // outerHTML alone drops the doctype, and adding a tidy one to a quirks-mode site moves
  // pixels with every computed style identical (LEARNINGS #18). Feed the result to
  // `pingfusi capture-build <name>` (the default build strategy). On any page with
  // below-fold content, run `await pxScrollSettle()` FIRST — a top-of-page capture
  // freezes lazy sections out of existence and scroll-reveals at opacity:0.
  // THE AGENT'S OWN DOM IS NOT THE SITE'S DOM. A browser-automation extension injects overlay
  // nodes into the very page it is measuring — Claude-in-Chrome paints a glow border
  // (#claude-agent-glow-border), a phantom cursor (#claude-phantom-cursor) and a <style
  // id="claude-agent-animation-styles"> of @keyframes, and it injects them WHILE the agent acts.
  // outerHTML returns them, so a DOM captured mid-run BAKES the agent's overlay into the clone —
  // and the clone then ships a pulsing border that belongs to the instrument, not the site.
  // Measured on gorjana: pxDomHtml() included #claude-agent-glow-border; behavior discovery
  // reported its pulse as a behavior of the SITE. The instrument must not measure itself.
  // Narrow by construction: keyed on the agent's own ID NAMESPACE, never on a class/text match
  // (a site is free to have a class named "claude-*"; only these ids are the extension's).
  // The namespace has THREE prefixes, not two. #24 listed agent- and phantom- and stopped there;
  // the extension ALSO injects a "Claude is active in this tab group" toast under claude-static-
  // (#claude-static-indicator-container, -chat-button, -chat-tooltip, -close-button,
  // -close-tooltip). Measured on dtf: all five nodes were serialized into dom.html and BAKED into
  // the shipped clone, clone-lint's agent-dom rule exited 0 on the contaminated artifact, and its
  // frozen-reveal rule blamed the SITE for the extension's own "Open chat"/"Dismiss" tooltips.
  // A guard that lists two of three prefixes is a guard the instrument walks around — enumerate
  // the vendor's namespace COMPLETELY, and keep the three call-sites (here, behavior-capture,
  // clone-lint) reading the same list.
  root.pxAgentDomSelector = '[id^="claude-agent-"], [id^="claude-phantom-"], [id^="claude-static-"]';
  root.pxIsAgentDom = function (el) {
    return !!(el && el.nodeType === 1 && (el.matches ? el.matches(root.pxAgentDomSelector) : false) ||
      (el && el.closest && el.closest(root.pxAgentDomSelector)));
  };
  // CLONING THE PAGE IS NOT COPYING IT — cloneNode(true) RE-RUNS CUSTOM-ELEMENT CONSTRUCTORS.
  // The agent-overlay strip above must happen off to the side (never mutate the live page), and
  // the obvious way to get "off to the side" is documentElement.cloneNode(true). But cloning an
  // UPGRADED custom element constructs a *fresh* instance of it: the browser calls its
  // constructor, and a framework-defined element (Vue defineCustomElement, Lit, Stencil …)
  // re-initialises itself there — so the clone comes back EMPTY while the live element is full.
  // Measured on chrono24: <c24-main-search-app data-v-app> holds the site's main search bar (22
  // nodes, 662x50). app.outerHTML → 1928 chars of form. app.cloneNode(true).children.length → 0.
  // pxDomHtml therefore captured `<c24-main-search-app><!----></c24-main-search-app>`, the build
  // shipped an empty mount point, and the kit could not clone the page's most prominent control
  // no matter how many times it re-captured.
  //
  // outerHTML on the LIVE element is faithful (it walks the real children), so: serialize FIRST,
  // then re-parse the string in a DOMParser document — which has NO custom-element registry, so
  // nothing upgrades, no constructor runs, and the subtree survives. The live page is still never
  // mutated, which is the property the clone was there to protect.
  // This is LEARNINGS #23 again (a measurement must be invariant under the kit's own transforms):
  // the instrument's own copy step was destroying the content it was sent to record.
  root.pxDomHtml = function () {
    const dt = document.doctype;
    const doctype = dt
      ? "<!DOCTYPE " + dt.name + (dt.publicId ? ' PUBLIC "' + dt.publicId + '"' : "") + (!dt.publicId && dt.systemId ? " SYSTEM" : "") + (dt.systemId ? ' "' + dt.systemId + '"' : "") + ">\n"
      : "";
    const live = document.documentElement;
    const DP = root.DOMParser;
    if (DP) {
      const doc = new DP().parseFromString(live.outerHTML, "text/html");
      const el = doc.documentElement;
      for (const n of el.querySelectorAll(root.pxAgentDomSelector)) n.remove();
      return doctype + el.outerHTML;
    }
    // No DOMParser (non-browser host): fall back to the clone path. Same agent-strip contract,
    // and no custom elements exist to upgrade there.
    const rootEl = live.cloneNode(true);
    for (const el of rootEl.querySelectorAll(root.pxAgentDomSelector)) el.remove();
    return doctype + rootEl.outerHTML;
  };
  root.pxSendDom = function (url) {
    // CSP-blocked POST? Fall back to the stash path: pxStash(null, 900, pxDomHtml()) + pxRead.
    const body = root.pxDomHtml();
    return withIntegrity(url, utf8(body)).then((u) => fetch(u, { method: "POST", body })).then((r) => r.text());
  };
  // pxSave — deliver through the browser's OWN download path (Blob + <a download> →
  // ~/Downloads): byte-exact at any size, no network, no CSP. The required path for large
  // payloads (> ~500 KB) and the escape hatch for any sink 409 — POST transports have
  // silently truncated big DOMs. Returns {name, bytes, sha256}; verify the saved file
  // against them (`shasum -a 256 ~/Downloads/<name>`) before building from it.
  root.pxSave = function (name, payload) {
    const body = payload != null ? payload : capture(null, { compact: true });
    const bytes = utf8(body);
    return sha256Hex(bytes).then((h) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      return { name, bytes: bytes.length, sha256: h };
    });
  };
  root.pxSaveDom = function (name) { return root.pxSave(name || "dom.html", root.pxDomHtml()); };
  const DEFAULT_CHUNK = 900;
  root.pxStash = function (targets, chunk, preJson) {
    const json = preJson != null ? preJson : capture(targets, { compact: true });
    const size = chunk || DEFAULT_CHUNK;
    let ta = document.getElementById("__pixeldiff");
    if (!ta) { ta = document.createElement("textarea"); ta.id = "__pixeldiff"; ta.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px"; document.body.appendChild(ta); }
    ta.value = json; ta.dataset.chunk = size;
    return { bytes: json.length, chunks: Math.ceil(json.length / size), chunkSize: size };
  };
  root.pxRead = function (i) {
    const ta = document.getElementById("__pixeldiff");
    if (!ta) return null;
    const size = Number(ta.dataset.chunk) || DEFAULT_CHUNK;
    return ta.value.slice(i * size, (i + 1) * size);
  };

  // ── pxEnumerateLeaves + pxCaptureAll — the whole capture as ONE call ─────────
  // Two costs this removes, both measured live: (a) leaf enumeration used to be a
  // prose instruction each agent improvised per run — an ad-hoc enumerator that
  // under-included <video> is exactly how yc round 1's height mismatch slipped every
  // pixel gate; (b) orchestrating settle→enumerate→capture→deliver as ~30 separate
  // automation calls pays a slow round-trip plus agent deliberation at every seam
  // (11 min between two gates on the 2026-07-13 yc run, while the measuring itself
  // took 8 s). One call per tab does the whole motion and returns a compact,
  // checkable report; the granular steps all remain for sites that misbehave.
  // Classification is PURE + exported so the leaf rules are fixtured in node.
  const MEDIA_TAGS = new Set(["img", "svg", "video", "canvas", "picture", "iframe", "input", "select", "textarea", "button", "embed", "object"]);
  const SKIP_TAGS = new Set(["script", "style", "link", "meta", "template", "noscript", "br", "wbr", "head", "title"]);
  // facts → {leaf, kind, text}. Encodes the failure catalog:
  //  - media tags are ALWAYS their own leaf, even inside a counted subtree (yc <video> miss)
  //  - a solid-painted container is a target even when it holds leaves (coverage rule:
  //    "0 missed solid-color containers" — the red announcement-bar class)
  function classifyLeaf(f) {
    if (SKIP_TAGS.has(f.tag) || !(f.w > 0) || !(f.h > 0)) return { leaf: false };
    if (MEDIA_TAGS.has(f.tag)) return { leaf: true, kind: "media", text: false };
    if (f.hasOwnText) return { leaf: true, kind: "text", text: true };
    if (f.bgImage) return { leaf: true, kind: "bg-image", text: false };
    if (f.bgColorDiffers || f.borderPaints) return { leaf: true, kind: f.leafDescendants ? "painted-container" : "painted-box", text: false };
    return { leaf: false };
  }
  // Pure: the one-call capture must refuse an unstable settle (chrono24 lessons: a page
  // still growing or an image still in flight is a layout no user ever sees). Only an
  // explicit settle:false skip (caller took responsibility) or a settle object that
  // affirms stability may proceed.
  function captureAllShouldAbort(settle) {
    return !!(settle && typeof settle === "object" && settle.stable === false);
  }

  // Stable, collision-free target names in traversal order (pure).
  function slugName(f, used) {
    const hint = (f.hint || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 28);
    let name = hint && hint !== f.tag ? `${f.tag}_${hint}` : f.tag;
    if (used.has(name)) { let i = 2; while (used.has(`${name}_${i}`)) i++; name = `${name}_${i}`; }
    used.add(name);
    return name;
  }
  function leafFacts(el, leafDescendants) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    const parentBg = el.parentElement ? getComputedStyle(el.parentElement).backgroundColor : null;
    const own = ownText(el);
    return {
      tag: el.tagName.toLowerCase(),
      w: r.width, h: r.height,
      hasOwnText: !!own,
      bgImage: s.backgroundImage !== "none",
      bgColorDiffers: !isTransparent(s.backgroundColor) && s.backgroundColor !== parentBg,
      borderPaints: ["Top", "Right", "Bottom", "Left"].some((side) => (parseFloat(s["border" + side + "Width"]) || 0) > 0 && s["border" + side + "Style"] !== "none"),
      leafDescendants,
      hint: (own || el.getAttribute("aria-label") || el.getAttribute("alt") || el.id || (typeof el.className === "string" ? el.className.split(/\s+/)[0] : "") || "").slice(0, 40),
    };
  }
  root.pxEnumerateLeaves = function () {
    const out = [], used = new Set();
    const walk = (el) => {
      if (el.nodeType !== 1 || SKIP_TAGS.has(el.tagName.toLowerCase()) || root.pxIsAgentDom(el)) return false;
      let childHasLeaf = false;
      for (const c of el.children) childHasLeaf = walk(c) || childHasLeaf;
      if (!inRegion(el)) return childHasLeaf;
      const f = leafFacts(el, childHasLeaf);
      const v = classifyLeaf(f);
      if (!v.leaf) return childHasLeaf;
      out.push({ name: slugName(f, used), el, text: v.text, kind: v.kind });
      return true;
    };
    if (document.body) walk(document.body);
    return out;
  };
  // The one call per tab: settle → enumerate → measure → deliver, one compact report.
  // Region defaults to the WHOLE page (the kit's default scope); pass {region: {...}}
  // to narrow, {prefix: 'clone'} on the clone tab, {dom: false} to skip the DOM send.
  // The report is data about what happened — read it before advancing: ok:false or a
  // non-empty `failed` list means a delivery did not land; settle.frozenOpacity0 > 0
  // means reveals never fired (inspect before trusting the capture).
  //
  // VALUE MODE: a falsy sinkUrl collects every artifact into report.payloads instead of
  // POSTing — for callers that read the report BY VALUE (the CDP capture runner via
  // Runtime.evaluate returnByValue). Same orchestration, same settle STOP contract, no
  // delivery hop to fail — which is the point: the sink/CSP/localhost dance exists only
  // because a page can't hand a value back to an agent; over CDP it can.
  root.pxCaptureAll = async function (sinkUrl, opts) {
    const o = opts || {};
    const prefix = o.prefix || "live";
    if (o.region !== undefined) root.pxRegion = o.region;
    else root.pxRegion = {}; // whole page unless the caller narrows
    const report = { prefix, leaves: 0, byKind: {}, delivered: [], failed: [] };
    report.settle = o.settle === false ? "skipped" : await root.pxScrollSettle(o.settleOpts);
    // stable:false ⇒ STOP is the settle contract, and the ONE-CALL path must ENFORCE it,
    // not narrate it: a report the caller might skim is how "the tool checks this; your
    // job is to believe it" fails in practice. No bypass flag — when this aborts, drop to
    // the granular steps, read settle.heights/imagesPending, and capture only once the
    // page is real (RUNBOOK "Build by capture" step 1).
    if (captureAllShouldAbort(report.settle)) {
      report.ok = false;
      report.aborted = "settle-not-stable";
      report.hint = "the page never settled (still growing, or images still loading) — the DOM right now is a page that never existed. Inspect settle.heights / settle.imagesPending / settle.pendingImageSrcs, fix or wait, then re-run.";
      return report;
    }
    const leaves = root.pxEnumerateLeaves();
    report.leaves = leaves.length;
    for (const l of leaves) report.byKind[l.kind] = (report.byKind[l.kind] || 0) + 1;
    const targets = leaves.map((l) => [l.name, () => l.el, l.text]);
    const base = String(sinkUrl || "").replace(/\/+$/, "");
    const send = sinkUrl
      ? async (file, body) => {
          try {
            const bytes = utf8(body);
            const h = await sha256Hex(bytes);
            const r = await fetch(base + "/" + file + "?bytes=" + bytes.length + (h ? "&sha256=" + h : ""), { method: "POST", body });
            const text = await r.text();
            (r.ok ? report.delivered : report.failed).push({ file, status: r.status, bytes: bytes.length, server: text.slice(0, 90) });
          } catch (e) {
            report.failed.push({ file, error: String((e && e.message) || e).slice(0, 120) });
          }
        }
      : async (file, body) => {
          // value mode: no wire, no integrity dance — the caller receives these bytes in the
          // same protocol message as the report itself, so truncation would fail its JSON parse
          report.payloads = report.payloads || {};
          report.payloads[file] = body;
          report.delivered.push({ file, bytes: utf8(body).length, returned: true });
        };
    await send(prefix + ".json", capture(targets, { compact: true }));
    if (prefix === "live") {
      await send("coverage.json", JSON.stringify(leaves.map((l) => l.name)));
      if (o.dom !== false) await send("dom.html", root.pxDomHtml());
    }
    report.ok = report.failed.length === 0;
    return report;
  };

  // Expose the pure sibling walk to node so the prevGap invariance can be fixtured without
  // driving a browser (same reason behavior-capture.js exports probeHover). Harmless in the
  // browser — `module` is undefined there.
  if (typeof module !== "undefined" && module.exports) module.exports = { prevRenderedSibling, classifyLeaf, slugName, captureAllShouldAbort };
})(typeof window !== "undefined" ? window : globalThis);
