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
      // A lazy image can be UNLOADABLE BY DESIGN at settle time. Measured on mindmarket
      // (2026-07-17): the client-logo belt ships loading="lazy" logos whose boxes are ZERO-WIDTH
      // until the bytes arrive (height attr only, width:auto) — the lazy loader never fires for a
      // box it never sees intersect, so `complete` stays false FOREVER and the wait above times
      // out identically on every run. That is #32's shape again: a gate demanding a state the
      // page cannot reach on its own is a deadlock, not honesty. So the kit PROVIDES the state
      // instead of waiting for it: promote the stuck lazy images to eager (the fetch fires
      // immediately, no intersection needed), give the network one more bounded window, then put
      // the attribute back so dom.html ships byte-identical to live — the instrument must not
      // bake itself into the artifact (#24/#29). A promoted image that STILL never completes
      // refuses the capture exactly as before: eager-and-in-flight means the page truly is not
      // ready, and stable:false stays the verdict. The promotion is recorded in the report — a
      // capture that intervened must say so.
      const lazyPromoted = [];
      for (const im of pendingImages().filter((i) => i.loading === "lazy")) {
        const attr = typeof im.getAttribute === "function" ? im.getAttribute("loading") : null;
        im.loading = "eager";
        lazyPromoted.push({ im, attr, src: im.currentSrc || im.src || "(no src)" });
      }
      if (lazyPromoted.length) {
        let promoWaited = 0;
        while (pendingImages().length && promoWaited < imgWaitMs) { await sleep(250); promoWaited += 250; }
        for (const p of lazyPromoted) {
          if (p.attr != null && typeof p.im.setAttribute === "function") p.im.setAttribute("loading", p.attr);
          else if (p.attr == null && typeof p.im.removeAttribute === "function") p.im.removeAttribute("loading");
        }
      }
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
        lazyPromoted: lazyPromoted.length,
        lazyPromotedSrcs: lazyPromoted.slice(0, 5).map((p) => p.src),
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

  // ── in-page animation readers: pxIntrospectAnimations + pxProbeGsap ──────────
  // The DECLARED-motion tiers of the capture ladder: read what the page itself declares
  // (CSS/WAAPI via document.getAnimations, GSAP via its public timeline API) before any
  // sampling tier has to reverse-engineer pixels. Both readers are STRICTLY read-only —
  // no play/pause/seek, no style writes: an instrument that perturbs the animation it is
  // recording is measuring itself (the agent-DOM lesson, one layer down). Output is plain
  // JSON, CAPPED (never unbounded — a page can hold thousands of live animations), and
  // shaped EXACTLY as harness/motion-doc.js's IntrospectionRecord / GsapRecord JSDoc
  // contracts, so fromIntrospection/fromGsap consume the `records` arrays verbatim.

  // A STABLE selector for an arbitrary element: #id when it has one (escaped), else a
  // short nth-of-type path. Algorithm-identical with behavior-capture.js selectorOf —
  // the two files are injected SEPARATELY on strict-CSP pages, so the algorithm is
  // duplicated by design and must stay in lockstep: a motion track and a behavior record
  // must key the same element with the same string.
  const selectorOf = (el) => {
    if (!el || el.nodeType !== 1 || !el.tagName) return null;
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
  };
  root.pxSelectorOf = selectorOf;

  const isScalarValue = (v) => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  // Infinity does not survive JSON — the motion-doc contract (see its JSDoc) is to ship
  // it as the STRING "Infinity"; the converter maps it back (normalizeIterations).
  const jsonSafeScalar = (v) => (typeof v === "number" && !isFinite(v) ? String(v) : v);

  // effect.getKeyframes() frames are already near-plain objects; keep ONLY scalar entries
  // (offset may legally be null — preserved) so the record is JSON-safe by construction.
  const safeKeyframe = (kf) => {
    const out = {};
    for (const k of Object.keys(kf || {})) {
      const v = kf[k];
      if (isScalarValue(v)) out[k] = jsonSafeScalar(v);
    }
    return out;
  };

  // getComputedTiming() subset per the IntrospectionRecord contract. A scroll-driven
  // animation may report a NON-number duration (a CSSNumericValue percentage) — record
  // its string form rather than dropping it; the converter treats non-numbers as 0.
  const introspectTiming = (effect, anim) => {
    let t = {};
    try { t = effect.getComputedTiming() || {}; } catch (e) {}
    const out = {};
    const put = (k, v) => { if (v !== undefined) out[k] = isScalarValue(v) ? jsonSafeScalar(v) : String(v); };
    put("duration", t.duration);
    put("delay", t.delay);
    put("iterations", t.iterations);   // Infinity → "Infinity" (motion-doc JSDoc contract)
    put("direction", t.direction);
    put("fill", t.fill);
    put("endTime", t.endTime);         // Infinity → "Infinity"; diagnosis, not consumed
    if (typeof anim.playbackRate === "number" && isFinite(anim.playbackRate)) out.playbackRate = anim.playbackRate;
    return out;
  };

  // Chrome reports an unset animation range as the string "normal" (the default) — that
  // is the absence of a binding, not a binding; recording it would invent a constraint.
  const rangeString = (r) => {
    if (r == null) return null;
    if (typeof r === "string") return r;
    if (typeof r === "object" && r.rangeName) return `${r.rangeName}${r.offset != null ? " " + String(r.offset) : ""}`;
    return String(r);
  };
  // Feature-detected: on a host without ScrollTimeline/ViewTimeline globals nothing can
  // BE one, so everything classifies "document" — never a throw. ViewTimeline extends
  // ScrollTimeline, so it must be tested first.
  const introspectTimeline = (anim) => {
    const tl = anim.timeline;
    if (!tl) return { type: "document" };
    const isView = !!(root.ViewTimeline && tl instanceof root.ViewTimeline);
    const isScroll = isView || !!(root.ScrollTimeline && tl instanceof root.ScrollTimeline);
    if (!isScroll) return { type: "document" };
    const out = { type: isView ? "view" : "scroll" };
    const src = selectorOf(tl.subject || tl.source);  // ViewTimeline names it subject, ScrollTimeline source
    if (src) out.source = src;
    const rs = rangeString(anim.rangeStart), re = rangeString(anim.rangeEnd);
    if (rs && rs !== "normal") out.rangeStart = rs;
    if (re && re !== "normal") out.rangeEnd = re;
    return out;
  };

  // instanceof when the host has the constructors, duck-typing as the fallback (only
  // CSSAnimation exposes animationName; only CSSTransition exposes transitionProperty).
  const animationType = (anim) => {
    if (root.CSSTransition && anim instanceof root.CSSTransition) return "CSSTransition";
    if (root.CSSAnimation && anim instanceof root.CSSAnimation) return "CSSAnimation";
    if (typeof anim.animationName === "string") return "CSSAnimation";
    if (typeof anim.transitionProperty === "string") return "CSSTransition";
    return "Animation";
  };

  root.pxIntrospectAnimations = function (opts) {
    const o = opts || {};
    const cap = o.cap || 500;
    if (!document || typeof document.getAnimations !== "function") {
      return { supported: false, total: 0, truncated: false, records: [], skipped: { noTarget: 0, agentDom: 0 } };
    }
    let anims = [];
    try { anims = document.getAnimations({ subtree: true }) || []; }
    catch (e) { try { anims = document.getAnimations() || []; } catch (e2) { anims = []; } }
    const skipped = { noTarget: 0, agentDom: 0 };
    const records = [];
    let truncated = false;
    for (const anim of anims) {
      if (records.length >= cap) { truncated = true; break; }
      const effect = anim && anim.effect;
      const target = effect && effect.target;
      // No target = nothing a clone could bind the track to; skipped WITH a count — a
      // reader that drops silently is a reader that cannot be audited.
      if (!target) { skipped.noTarget++; continue; }
      // The agent's own overlay animates (glow-border pulse). The instrument must not
      // record itself as the site's motion — same contract as pxDomHtml/pxEnumerateLeaves.
      if (root.pxIsAgentDom(target)) { skipped.agentDom++; continue; }
      const type = animationType(anim);
      const selector = selectorOf(target);
      if (!selector) { skipped.noTarget++; continue; }
      let keyframes = [];
      try { keyframes = (effect.getKeyframes() || []).map(safeKeyframe); } catch (e) {}
      const record = {
        type,
        // a pseudo-element animation belongs to `#sel::before`, not to `#sel`
        selector: selector + (effect.pseudoElement || ""),
        keyframes,
        timing: introspectTiming(effect, anim),
        timeline: introspectTimeline(anim),
      };
      if (type === "CSSAnimation" && typeof anim.animationName === "string") record.animationName = anim.animationName;
      if (type === "CSSTransition" && typeof anim.transitionProperty === "string") record.transitionProperty = anim.transitionProperty;
      records.push(record);
    }
    return { supported: true, total: anims.length, truncated, records, skipped };
  };

  // pxProbeGsap — serialize the page's GSAP tweens (window.gsap v3) as GsapRecords.
  // Version-guarded: an unknown major is REPORTED ({present:true, unsupported}) instead of
  // guessed at — a probe walking internals it does not know would fabricate a receipt.
  root.pxProbeGsap = function (opts) {
    const o = opts || {};
    const cap = o.cap || 500;
    const gsap = root.gsap;
    if (!gsap) return { present: false };
    const version = String(gsap.version || "");
    if (parseInt(version, 10) !== 3) return { present: true, unsupported: version || "(unknown)" };
    const result = {
      present: true, version, truncated: false, tweens: 0,
      records: [], scrollTriggers: [],
      skipped: { nonElementTargets: 0, agentDom: 0, droppedVarKeys: 0 },
    };
    let children = [];
    try {
      children = gsap.globalTimeline && typeof gsap.globalTimeline.getChildren === "function"
        ? gsap.globalTimeline.getChildren(true, true, true) || []   // (nested, tweens, timelines)
        : [];
    } catch (e) { children = []; }

    // ScrollTrigger may live on window (script-tag load) or only inside gsap's registered
    // globals (bundler load) — check both, never require either.
    let ST = root.ScrollTrigger || null;
    if (!ST && gsap.core && typeof gsap.core.globals === "function") {
      try { ST = gsap.core.globals().ScrollTrigger || null; } catch (e) { ST = null; }
    }
    let triggers = [];
    try { triggers = ST && typeof ST.getAll === "function" ? ST.getAll() || [] : []; } catch (e) { triggers = []; }
    const trigEntries = triggers.map((st) => {
      const vars = (st && st.vars) || {};
      const cfg = {};
      const trig = (st && st.trigger) || vars.trigger;
      const tsel = typeof trig === "string" ? trig : selectorOf(trig);
      if (tsel) cfg.trigger = tsel;
      // authored config first (vars.start "top 80%"), computed px fallback; functions are
      // not values — skipped. Strings because the GsapRecord contract says string.
      const startRaw = isScalarValue(vars.start) && vars.start != null ? vars.start : (st && isScalarValue(st.start) && st.start != null ? st.start : null);
      const endRaw = isScalarValue(vars.end) && vars.end != null ? vars.end : (st && isScalarValue(st.end) && st.end != null ? st.end : null);
      if (startRaw != null) cfg.start = String(startRaw);
      if (endRaw != null) cfg.end = String(endRaw);
      if (isScalarValue(vars.scrub) && vars.scrub != null) cfg.scrub = jsonSafeScalar(vars.scrub);
      return { st, cfg, matched: false };
    });
    // a trigger drives a tween directly (st.animation === tween) or drives a TIMELINE the
    // tween sits on — walk the parent chain so nested tweens inherit their trigger.
    const matchTrigger = (tween) => {
      for (const t of trigEntries) {
        const anim = t.st && t.st.animation;
        if (!anim) continue;
        for (let a = tween; a; a = a.parent) {
          if (a === anim) { t.matched = true; return t.cfg; }
        }
      }
      return null;
    };

    // vars, data-only: scalars kept verbatim, functions and non-startAt objects DROPPED
    // with a count (never serialized — a stringified callback is not a value). startAt
    // (gsap.fromTo start values) is consumed by the converter, so its scalars survive.
    const safeVars = (vars) => {
      const out = {};
      let dropped = 0;
      for (const k of Object.keys(vars || {})) {
        const v = vars[k];
        if (isScalarValue(v)) { out[k] = jsonSafeScalar(v); continue; }
        if (k === "startAt" && v && typeof v === "object" && !Array.isArray(v)) {
          const sub = {};
          for (const sk of Object.keys(v)) {
            if (isScalarValue(v[sk])) sub[sk] = jsonSafeScalar(v[sk]);
            else dropped++;
          }
          out.startAt = sub;
          continue;
        }
        dropped++;
      }
      return { vars: out, dropped };
    };
    const readNum = (fn) => { try { const v = fn(); return typeof v === "number" && isFinite(v) ? v : undefined; } catch (e) { return undefined; } };

    for (const child of children) {
      if (!child || typeof child.targets !== "function") continue;  // timelines are containers, not motion
      if (result.records.length >= cap) { result.truncated = true; break; }
      result.tweens++;
      let targets = [];
      try { targets = child.targets() || []; } catch (e) { targets = []; }
      const sv = safeVars(child.vars);
      result.skipped.droppedVarKeys += sv.dropped;
      const duration_s = readNum(() => child.duration());
      const delay_s = readNum(() => child.delay());
      const startTime_s = readNum(() => child.startTime());
      const repeat = readNum(() => child.repeat());
      let yoyo = false;
      try { yoyo = typeof child.yoyo === "function" ? !!child.yoyo() : false; } catch (e) {}
      const ease = child.vars && typeof child.vars.ease === "string" ? child.vars.ease : undefined;
      const scrollTrigger = matchTrigger(child);
      for (const t of targets) {
        if (result.records.length >= cap) { result.truncated = true; break; }
        // plain-object tweens (gsap.to({val:0},…)) animate no pixels a clone could show;
        // skipped with a count, same audit contract as the introspection reader.
        if (!t || t.nodeType !== 1) { result.skipped.nonElementTargets++; continue; }
        if (root.pxIsAgentDom(t)) { result.skipped.agentDom++; continue; }
        const selector = selectorOf(t);
        if (!selector) { result.skipped.nonElementTargets++; continue; }
        const rec = { selector, vars: sv.vars, duration_s: duration_s !== undefined ? duration_s : 0 };
        if (delay_s !== undefined) rec.delay_s = delay_s;
        if (startTime_s !== undefined) rec.startTime_s = startTime_s;
        if (ease !== undefined) rec.ease = ease;
        if (repeat !== undefined) rec.repeat = repeat;
        if (yoyo) rec.yoyo = true;
        if (scrollTrigger) rec.scrollTrigger = scrollTrigger;
        result.records.push(rec);
      }
    }
    // every trigger is reported (matched or not) — an unmatched trigger is inventory the
    // sampling tiers must dispose of, not a config that silently vanished.
    result.scrollTriggers = trigEntries.map((t) => Object.assign({}, t.cfg, { matched: t.matched }));
    return result;
  };

  // Expose the pure sibling walk to node so the prevGap invariance can be fixtured without
  // driving a browser (same reason behavior-capture.js exports probeHover). Harmless in the
  // browser — `module` is undefined there.
  if (typeof module !== "undefined" && module.exports) module.exports = { prevRenderedSibling, classifyLeaf, slugName, captureAllShouldAbort };
})(typeof window !== "undefined" ? window : globalThis);

// ── pxDenseRecord* — the SAMPLED tier's in-page dense recorder ────────────────
// The last rung of the capture ladder: when a page declares nothing (no CSS/WAAPI
// animation to introspect, no GSAP timeline to probe) but pixels still move — a
// hand-rolled rAF loop writing inline styles — the only honest record is a SAMPLED
// one: computed values read at uniform virtual-time steps. The recorder does NOT
// own the clock. The node-side runner (harness/motion-sampler.js) steps virtual
// time over CDP (Emulation.setVirtualTimePolicy, or the hooked-clock fallback) and
// hands each step's tMs in; this file only READS at the moments it is told about.
// Determinism — two runs must produce byte-identical samples — is therefore the
// runner's stepped clock plus this file's pure reads, and nothing else.
//
// Read-only against the page's rendering, same doctrine as pxIntrospectAnimations:
// observers and getComputedStyle reads only — no style writes, no play/pause/seek,
// no DOM nodes added. An instrument that perturbs the animation it is recording is
// measuring itself. And the instrument must not RECORD itself either: the agent
// overlay namespace (pxIsAgentDom) is skipped at element resolution AND at write
// capture, with counts — a reader that drops silently cannot be audited.
//
// Contract (the sampler binds to these exact names):
//   pxDenseRecordStart({scopes:[selector], props:["transform","opacity",…]})
//     → resolves elements from the scopes NOW (each scope root, plus descendants
//       with their OWN computed transform — they animate independently and a
//       scope-level sample cannot see them), installs a MutationObserver for
//       inline-style writes (attributes:true, attributeFilter:["style"],
//       attributeOldValue:true, subtree:true) on each scope root.
//   pxDenseRecordStep(tMs)
//     → drains pending style-write records (attributed to THIS step's tMs: a write
//       lands during the frame advance between steps, and at the declared fps the
//       step boundary IS its observable virtual timestamp — sub-step ordering is
//       below the instrument's resolution by design), then snapshots the computed
//       value of every requested prop for every tracked element.
//   pxDenseRecordStop()
//     → { frames, stepMs, elements: [{selector, samples: [{t, values}]}],
//         writes: [{t, selector, prop, value}], truncated }
//       plus audit fields (skipped counts, writesObserved). Raw samples out —
//       Stop CONVERTS NOTHING; turning samples into motion-doc tracks
//       (provenance.tier "sampled") is the node-side sampler's job.
//
// Plain-JSON by construction and CAPPED, never unbounded: 200 elements, 2000
// frames, 5000 writes — any cap trip sets the explicit `truncated` flag. Values
// ship as computed strings exactly as getComputedStyle returns them (transform is
// the computed matrix string or "none"); a prop the host cannot resolve is null.
(function (root) {
  "use strict";
  const DENSE_MAX_ELEMENTS = 200;
  const DENSE_MAX_FRAMES = 2000;
  const DENSE_MAX_WRITES = 5000;
  const DENSE_DEFAULT_PROPS = ["transform", "opacity", "filter", "visibility"];

  let dr = null; // the active recording — one at a time; Start resets, Stop clears

  // Inline-style declaration parser: split on ";" at paren/quote depth 0 (a url()
  // or data: value may legally contain semicolons), prop lowercased except custom
  // properties (-- prefix is case-sensitive by spec). Later duplicates win, as in
  // the style attribute itself.
  const parseDenseDecls = (cssText) => {
    const out = [];
    const text = String(cssText == null ? "" : cssText);
    let depth = 0, quote = null, start = 0;
    const push = (chunk) => {
      const i = chunk.indexOf(":");
      if (i < 1) return;
      const raw = chunk.slice(0, i).trim();
      const prop = raw.indexOf("--") === 0 ? raw : raw.toLowerCase();
      if (prop) out.push([prop, chunk.slice(i + 1).trim()]);
    };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) { if (ch === quote && text[i - 1] !== "\\") quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") depth = depth > 0 ? depth - 1 : 0;
      else if (ch === ";" && depth === 0) { push(text.slice(start, i)); start = i + 1; }
    }
    push(text.slice(start));
    return out;
  };
  const denseDeclMap = (cssText) => {
    const m = {};
    for (const d of parseDenseDecls(cssText)) m[d[0]] = d[1];
    return m;
  };
  const denseStyleAttr = (el) => {
    try { return (el && el.getAttribute && el.getAttribute("style")) || ""; } catch (e) { return ""; }
  };

  // Drain style-write records and attribute them to virtual time t. All records —
  // whether the observer's async callback fired mid-advance or takeRecords() hands
  // them over now — are processed HERE, at the step boundary, so the attribution
  // never depends on when the host chose to schedule a microtask: that is what
  // makes two runs byte-identical. Per element, the FIRST record's oldValue is the
  // pre-step baseline and the current attribute is the post-step state; the diff
  // between them is what a recorder sampling at this fps can honestly observe
  // (multiple sub-step writes collapse to their final value — the same collapse
  // the screen itself performs). A removed prop records value "".
  const denseDrainWrites = (t) => {
    if (!dr || !dr.observer) return;
    const records = dr.queue.splice(0);
    let taken = [];
    try { taken = dr.observer.takeRecords() || []; } catch (e) { taken = []; }
    for (const r of taken) records.push(r);
    if (!records.length) return;
    const perEl = new Map();
    for (const rec of records) {
      const target = rec && rec.target;
      if (!target || target.nodeType !== 1) continue;
      if (root.pxIsAgentDom && root.pxIsAgentDom(target)) { dr.skipped.agentDom++; continue; }
      if (!perEl.has(target)) perEl.set(target, rec.oldValue != null ? rec.oldValue : "");
    }
    for (const entry of perEl) {
      const target = entry[0];
      const before = denseDeclMap(entry[1]);
      const after = denseDeclMap(denseStyleAttr(target));
      const selector = root.pxSelectorOf ? root.pxSelectorOf(target) : null;
      if (!selector) continue;
      const props = new Set(Object.keys(before).concat(Object.keys(after)));
      for (const p of props) {
        if (before[p] === after[p]) continue;
        if (dr.writes.length >= DENSE_MAX_WRITES) { dr.truncated = true; return; }
        dr.writes.push({ t, selector, prop: p, value: after[p] !== undefined ? after[p] : "" });
      }
    }
  };

  root.pxDenseRecordStart = function (opts) {
    const o = opts || {};
    const scopes = Array.isArray(o.scopes) && o.scopes.length ? o.scopes.map(String) : ["body"];
    const props = Array.isArray(o.props) && o.props.length ? o.props.map(String) : DENSE_DEFAULT_PROPS.slice();
    if (dr && dr.observer) { try { dr.observer.disconnect(); } catch (e) {} }
    dr = {
      props, tracked: [], times: [], writes: [], queue: [],
      truncated: false, lastT: 0, observer: null,
      skipped: { agentDom: 0 },
    };
    const seen = new Set();
    const roots = [];
    const track = (el) => {
      if (!el || el.nodeType !== 1 || seen.has(el)) return;
      if (root.pxIsAgentDom && root.pxIsAgentDom(el)) { dr.skipped.agentDom++; return; }
      if (dr.tracked.length >= DENSE_MAX_ELEMENTS) { dr.truncated = true; return; }
      seen.add(el);
      dr.tracked.push({ el, selector: root.pxSelectorOf ? root.pxSelectorOf(el) : null, samples: [] });
    };
    for (const sel of scopes) {
      let hits = [];
      try { hits = [...document.querySelectorAll(sel)]; } catch (e) { hits = []; }
      for (const scopeEl of hits) {
        if (root.pxIsAgentDom && root.pxIsAgentDom(scopeEl)) { dr.skipped.agentDom++; continue; }
        roots.push(scopeEl);
        track(scopeEl);
        // Descendants with their OWN transform move independently of the scope
        // root; a sample of the root alone would miss them entirely. Resolved
        // ONCE, now — the element set is fixed at Start so every frame samples
        // the same elements (a set that changed mid-run could never be replayed).
        let descendants = [];
        try { descendants = scopeEl.querySelectorAll ? [...scopeEl.querySelectorAll("*")] : []; } catch (e) { descendants = []; }
        for (const d of descendants) {
          if (dr.tracked.length >= DENSE_MAX_ELEMENTS) { dr.truncated = true; break; }
          let tf = "none";
          try { tf = getComputedStyle(d).transform || "none"; } catch (e) { tf = "none"; }
          if (tf !== "none") track(d);
        }
      }
    }
    const MO = root.MutationObserver;
    if (MO) {
      // The callback only queues — every record is PROCESSED at the next step
      // boundary (denseDrainWrites), so timestamp attribution is deterministic
      // regardless of microtask scheduling.
      const queue = dr.queue;
      dr.observer = new MO(function (records) { for (const r of records) queue.push(r); });
      for (const scopeEl of roots) {
        try {
          dr.observer.observe(scopeEl, { attributes: true, attributeFilter: ["style"], attributeOldValue: true, subtree: true });
        } catch (e) {}
      }
    }
    return { tracking: dr.tracked.length, writesObserved: !!dr.observer, truncated: dr.truncated, skipped: dr.skipped };
  };

  root.pxDenseRecordStep = function (tMs) {
    // A step against no recording is a caller bug — throw, never silently no-op:
    // a recorder that pretends to record fabricates the artifact downstream.
    if (!dr) throw new Error("pxDenseRecordStep: no active dense recording (call pxDenseRecordStart first)");
    const t = typeof tMs === "number" && isFinite(tMs) ? tMs : 0;
    dr.lastT = t;
    denseDrainWrites(t);
    if (dr.times.length >= DENSE_MAX_FRAMES) {
      dr.truncated = true;
      return { frame: dr.times.length, truncated: true };
    }
    dr.times.push(t);
    for (const tr of dr.tracked) {
      const values = {};
      let cs = null;
      try { cs = getComputedStyle(tr.el); } catch (e) { cs = null; }
      for (const p of dr.props) {
        let v = cs ? cs[p] : undefined;
        if (v === undefined && cs && typeof cs.getPropertyValue === "function") {
          try { v = cs.getPropertyValue(p); } catch (e) { v = undefined; }
        }
        values[p] = v === undefined || v === null ? null : String(v);
      }
      tr.samples.push({ t, values });
    }
    return { frame: dr.times.length, truncated: dr.truncated };
  };

  root.pxDenseRecordStop = function () {
    if (!dr) throw new Error("pxDenseRecordStop: no active dense recording");
    denseDrainWrites(dr.lastT); // writes that landed after the final step still count
    if (dr.observer) { try { dr.observer.disconnect(); } catch (e) {} }
    const frames = dr.times.length;
    const out = {
      frames,
      // Uniform stepping is the runner's contract; the recorder REPORTS the step it
      // actually saw (first delta) rather than trusting a parameter it never received.
      stepMs: frames >= 2 ? dr.times[1] - dr.times[0] : 0,
      elements: dr.tracked.map((tr) => ({ selector: tr.selector, samples: tr.samples })),
      writes: dr.writes,
      truncated: dr.truncated,
      skipped: dr.skipped,
      writesObserved: !!dr.observer,
    };
    dr = null;
    return out;
  };
})(typeof window !== "undefined" ? window : globalThis);

// ── pxOwnerProbe — the ONE-OWNER gate's in-page half (motion apply-sampled) ───
// Before the kit attaches its replay to the clone, apply-sampled must know whether
// another implementation already writes the target elements — the kit never STACKS
// implementations (two writers on one element means the later one silently wins, seen
// live when a finished clip's fill overrode a coexisting implementation forever). This
// probe watches each selector's elements for ~durationMs of wall time and reports any
// change to their inline style or computed transform. The kit's OWN replay animations
// (id-tagged "pingfusi:motion-replay" by the generated player) are cancelled at every
// tick first: the question is who ELSE writes, and a previously applied replay is the
// kit, not a competitor.
//
// VANTAGE RULE: competing writers are commonly visibility-gated — a belt advances only
// while its rail is in the viewport (seen live: a rail at document-top 13725px whose rAF
// writer paused off-screen answered a scroll-0 probe with a false all-clear). So the
// probe observes every watched element AT the vantage the player will run from: elements
// are sorted by document top, partitioned into viewport groups (tops within ~0.8·vh),
// and each group is scrolled into view — one settle tick for its writers to arm — before
// its baseline is read and its watch window runs. The original scroll position is
// restored afterwards. Groups are capped (maxGroups, default 5); elements beyond the cap
// are reported in `unwatched`, never silently skipped — an element the probe did not
// observe is an element it cannot clear. Read-only toward the page except the
// cancellation of the kit's own animations and the probe's scrolling; capped (50
// elements, 50 changes) and promise-returning so the caller can await the full window.
(function (root) {
  root.pxOwnerProbe = function (opts) {
    var o = opts && typeof opts === "object" ? opts : {};
    var selectors = Array.isArray(o.selectors) ? o.selectors.filter(function (s) { return typeof s === "string" && s; }) : [];
    var durationMs = typeof o.durationMs === "number" && isFinite(o.durationMs) && o.durationMs > 0 ? o.durationMs : 1000;
    var maxGroups = typeof o.maxGroups === "number" && isFinite(o.maxGroups) && o.maxGroups >= 1 ? Math.floor(o.maxGroups) : 5;
    var tickMs = Math.max(40, Math.min(200, Math.floor(durationMs / 10) || 100));
    var cancelOwn = function () {
      var anims = [];
      try { anims = typeof document.getAnimations === "function" ? document.getAnimations() : []; } catch (e) { anims = []; }
      var n = 0;
      for (var i = 0; i < anims.length; i++) {
        var a = anims[i];
        if (a && typeof a.id === "string" && a.id.indexOf("pingfusi:motion-replay") === 0) {
          try { a.cancel(); n++; } catch (e) {}
        }
      }
      return n;
    };
    var watch = [];
    var missing = [];
    for (var s = 0; s < selectors.length; s++) {
      var els = [];
      try { els = document.querySelectorAll(selectors[s]); } catch (e) { els = []; }
      if (!els.length) { missing.push(selectors[s]); continue; }
      for (var j = 0; j < els.length && watch.length < 50; j++) watch.push({ selector: selectors[s], index: j, el: els[j] });
    }
    var read = function (w) {
      var style = "";
      var transform = "";
      try { style = w.el.getAttribute("style") || ""; } catch (e) {}
      try { var cs = getComputedStyle(w.el); transform = (cs && cs.transform) || ""; } catch (e) {}
      return { style: style, transform: transform };
    };
    var docTop = function (el) {
      try { var r = el.getBoundingClientRect(); return r.top + (root.scrollY || 0); } catch (e) { return 0; }
    };
    var vh = 0;
    try { vh = root.innerHeight || (root.document.documentElement && root.document.documentElement.clientHeight) || 0; } catch (e) {}
    for (var k = 0; k < watch.length; k++) watch[k].top = docTop(watch[k].el);
    var groups = [];
    var sorted = watch.slice().sort(function (a, b) { return a.top - b.top; });
    for (var g = 0; g < sorted.length; g++) {
      var grp = groups.length ? groups[groups.length - 1] : null;
      if (!grp || (vh > 0 && sorted[g].top - grp.top > Math.max(1, vh * 0.8))) { grp = { top: sorted[g].top, members: [] }; groups.push(grp); }
      grp.members.push(sorted[g]);
    }
    var unwatched = [];
    while (groups.length > maxGroups) {
      var over = groups.pop();
      for (var u = 0; u < over.members.length; u++) unwatched.push({ selector: over.members[u].selector, index: over.members[u].index });
    }
    var origX = 0, origY = 0, canScroll = false;
    try { origX = root.scrollX || 0; origY = root.scrollY || 0; canScroll = typeof root.scrollTo === "function"; } catch (e) {}
    var scrolledAny = false;
    var scrollGroup = function (target) {
      if (!canScroll || vh <= 0) return false;
      var to = Math.max(0, target.top - vh / 3);
      var cur = 0;
      try { cur = root.scrollY || 0; } catch (e) {}
      if (Math.abs(to - cur) < 2) return false;
      try { root.scrollTo(0, to); scrolledAny = true; return true; } catch (e) { return false; }
    };
    var ownCancelled = cancelOwn();
    var changed = [];
    var seen = {};
    var ticks = 0;
    var groupsReport = [];
    return new Promise(function (resolve) {
      var gi = 0;
      var runGroup = function () {
        if (gi >= groups.length) {
          if (scrolledAny) { try { root.scrollTo(origX, origY); } catch (e) {} }
          resolve({ schema: "pingfusi/owner-probe@2", durationMs: durationMs, ticks: ticks, elements: watch.length, missing: missing, ownCancelled: ownCancelled, changed: changed, groups: groupsReport, unwatched: unwatched, scrolled: scrolledAny });
          return;
        }
        var grp = groups[gi++];
        var moved = scrollGroup(grp);
        var begin = function () {
          ownCancelled += cancelOwn();
          for (var i = 0; i < grp.members.length; i++) grp.members[i].base = read(grp.members[i]);
          var started = Date.now();
          var tick = function () {
            ownCancelled += cancelOwn();
            ticks++;
            var atMs = Date.now() - started;
            for (var i = 0; i < grp.members.length; i++) {
              var w = grp.members[i];
              var now = read(w);
              for (var p in now) {
                if (now[p] === w.base[p]) continue;
                var key = w.selector + " " + w.index + " " + p;
                if (seen[key] || changed.length >= 50) continue;
                seen[key] = 1;
                changed.push({
                  selector: w.selector, index: w.index,
                  prop: p === "style" ? "inline-style" : p,
                  from: String(w.base[p]).slice(0, 120), to: String(now[p]).slice(0, 120),
                  atMs: atMs,
                });
              }
            }
            if (atMs >= durationMs) {
              groupsReport.push({ top: Math.round(grp.top), elements: grp.members.length, scrolled: moved });
              runGroup();
              return;
            }
            setTimeout(tick, tickMs);
          };
          setTimeout(tick, tickMs);
        };
        // A visibility-gated writer needs a beat to arm once its element scrolls into
        // view — one settle tick (scroll handlers included) before the baseline is read,
        // so the writer's very first frame lands AFTER the baseline and is seen.
        if (moved) setTimeout(begin, tickMs); else begin();
      };
      runGroup();
    });
  };
})(typeof window !== "undefined" ? window : globalThis);

// ── pxCanvasDominant — is this page's visible painting a script-driven canvas? ──
// The BLACK-PAGE GREEN miss (bizar.ro, LEARNINGS #37): a WebGL canvas painted the whole
// page, the DOM skeleton measured identical on both sides — live.json and clone.json come
// from the SAME instrument, so a property the capture cannot see is one both sides agree
// about — and every gate passed while the published draft rendered solid black. A static
// DOM clone CANNOT reproduce script-driven canvas painting; this helper is the honest
// capability statement, read on the LIVE capture and receipted by capture-run. Two halves
// so the rule is fixtured in node (harness/fixtures/44-canvas-dominant.js):
//   pxCanvasDominance(viewport, canvasRects, markRects, opts) — the PURE classifier
//   pxCanvasDominant(opts)                                    — the DOM read
// "In front" is approximated by OVERLAP: painted leaves (pxEnumerateLeaves) whose boxes
// intersect the biggest canvas's box. Real z-order needs per-pixel hit-testing the
// instrument doesn't do — a full-bleed background canvas under plenty of DOM marks is NOT
// dominant (the DOM clone reproduces most of what a viewer sees); a big canvas with next
// to nothing over it IS. Read-only toward the page; agent DOM skipped like every reader.
(function (root) {
  root.pxCanvasDominance = function (viewport, canvasRects, markRects, opts) {
    var o = opts && typeof opts === "object" ? opts : {};
    var minCoverage = typeof o.minCoverage === "number" ? o.minCoverage : 0.5; // > ~half the viewport
    var maxMarks = typeof o.maxMarks === "number" ? o.maxMarks : 12;           // "fewer than N painted DOM marks in front"
    var vw = (viewport && viewport.w) || 0, vh = (viewport && viewport.h) || 0;
    var viewArea = vw * vh;
    var best = null, bestCov = 0;
    for (var i = 0; i < (canvasRects || []).length; i++) {
      var r = canvasRects[i];
      if (!r || !(r.w > 0) || !(r.h > 0)) continue;
      var ix = Math.max(0, Math.min(r.x + r.w, vw) - Math.max(r.x, 0));
      var iy = Math.max(0, Math.min(r.y + r.h, vh) - Math.max(r.y, 0));
      var cov = viewArea > 0 ? (ix * iy) / viewArea : 0;
      if (cov > bestCov) { bestCov = cov; best = r; }
    }
    var marks = 0;
    if (best) {
      for (var j = 0; j < (markRects || []).length; j++) {
        var m = markRects[j];
        if (!m || !(m.w > 0) || !(m.h > 0)) continue;
        var ox = Math.max(0, Math.min(m.x + m.w, best.x + best.w) - Math.max(m.x, best.x));
        var oy = Math.max(0, Math.min(m.y + m.h, best.y + best.h) - Math.max(m.y, best.y));
        if (ox * oy > 0) marks++;
      }
    }
    return {
      schema: "pingfusi/canvas-dominant@1",
      viewport: { w: vw, h: vh },
      canvases: (canvasRects || []).length,
      bestCoverage: Math.round(bestCov * 1000) / 1000,
      marksInFront: marks,
      dominant: !!best && bestCov >= minCoverage && marks < maxMarks,
    };
  };
  root.pxCanvasDominant = function (opts) {
    var vw = 0, vh = 0;
    try { vw = root.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0; } catch (e) {}
    try { vh = root.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0; } catch (e) {}
    var isAgent = typeof root.pxIsAgentDom === "function" ? root.pxIsAgentDom : function () { return false; };
    var rectOf = function (el) { var r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
    var canvases = [];
    var nodes = [];
    try { nodes = document.querySelectorAll("canvas"); } catch (e) { nodes = []; }
    for (var i = 0; i < nodes.length; i++) {
      if (isAgent(nodes[i])) continue;
      try { canvases.push(rectOf(nodes[i])); } catch (e) {}
    }
    // Painted DOM marks: the same enumeration every gate certifies (text, media, painted
    // boxes), canvases themselves excluded — a canvas cannot testify for its own painting.
    var marks = [];
    if (typeof root.pxEnumerateLeaves === "function") {
      var leaves = [];
      try { leaves = root.pxEnumerateLeaves(); } catch (e) { leaves = []; }
      for (var j = 0; j < leaves.length; j++) {
        var el = leaves[j] && leaves[j].el;
        if (!el || String(el.tagName || "").toLowerCase() === "canvas") continue;
        try { marks.push(rectOf(el)); } catch (e) {}
      }
    }
    return root.pxCanvasDominance({ w: vw, h: vh }, canvases, marks, opts);
  };
})(typeof window !== "undefined" ? window : globalThis);

// ── pxFreezeAnimations / pxMarksInSubtrees / pxCaptureAllPhased — PHASE-FREEZE ──
// Measurement must happen at a FIXED ANIMATION PHASE on both sides (LEARNINGS #38).
// A never-settling animation (an infinite CSS spin, a WAAPI belt) is at a phase
// determined by WHEN the page loaded, so live and clone snapshots of a CORRECT clone
// land at different phases and visual/strict fail with hundreds of constant-offset
// deltas (mindmarket: 334–336 deltas, two runs, nothing wrong with the clone). The
// settle wait cannot fix this — the animation never settles BY DESIGN.
//
// So the measurement capture freezes phase first:
//   pxFreezeAnimations(opts)  → pause every document.getAnimations() animation that is
//     still RUNNING and seek it to the canonical measure phase — progress 0 within its
//     CURRENT iteration (phase 0 pose is identical across iterations for normal-
//     direction loops, and keeping the iteration preserves alternate-direction parity).
//     Kit-generated players freeze THEMSELVES first through the hook registry
//     window.__pingfusiFreezeHooks (each hook pauses its own writers at phase 0 and
//     returns {player, frozen, ids}); a future non-WAAPI kit player MUST register the
//     same hook or its subtree is honestly excluded as unfreezable. What the pass may
//     NOT touch, receipted by count: finished/idle animations (their end state IS the
//     settled page), page-authored paused animations (a deliberate pose), scroll/view-
//     timeline animations (scroll position already fixes their phase), and the agent's
//     own overlay (the instrument must not adjust itself).
//   THEN a bounded post-freeze watch (the dense recorder — the ongoing sampler's own
//     instrument) reads what STILL moves: rAF-driven motion owns no Animation object
//     and cannot be paused generically (GSAP included). Those selectors are receipted
//     as `unfreezable`; the caller-known list (the capture sweep's ongoing movers)
//     rides in via opts.unfreezable and is merged in.
//   pxMarksInSubtrees(selectors) → {markName: selector} for every enumerated leaf
//     inside an unfreezable mover's subtree, so the diff can EXCLUDE those marks from
//     pixel-determining comparisons — receipted per mark in the snapshot's `freeze`
//     field and LISTED by the gates, never silently dropped.
//   pxCaptureAllPhased(sinkUrl, opts) → the phased one-call: settle → freeze → measure,
//     same report contract as pxCaptureAll (settle STOP included). In value mode
//     (falsy sinkUrl) the snapshot payload gains the `freeze` field; in sink mode the
//     freeze still HAPPENS (deterministic phase) and the receipt returns on the report,
//     but the POSTed snapshot predates it — prefer capture-run / value mode.
//
// Read-mostly by design: pausing and seeking declared animations is the ONE deliberate
// perturbation, made because measuring an arbitrary phase is measuring the instrument's
// own arrival time, not the page (#20's rule: the reference must be the site, not the
// instrument's accident). Everything is receipted — count, ids, what was skipped and
// why, what refused to freeze.
(function (root) {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const KIT_ANIM_PREFIX = "pingfusi:"; // the generated players tag their animations (motion-replay et al.)
  const firstMsg = (e) => String((e && e.message) || e).slice(0, 120);

  const freezeLabel = (anim, target) => {
    if (typeof anim.id === "string" && anim.id) return anim.id;
    const sel = root.pxSelectorOf ? root.pxSelectorOf(target) : null;
    const kind = typeof anim.animationName === "string" ? `css:${anim.animationName}`
      : typeof anim.transitionProperty === "string" ? `transition:${anim.transitionProperty}`
      : "waapi";
    return sel ? `${kind}@${sel}` : kind;
  };

  root.pxFreezeAnimations = async function (opts) {
    const o = opts || {};
    const receipt = {
      supported: !!(root.document && typeof root.document.getAnimations === "function"),
      frozen: 0,
      ids: [],
      players: [],
      alreadyPaused: 0,
      skipped: { finished: 0, scrollLinked: 0, agentDom: 0, kitPlayer: 0, failed: 0 },
      unfreezable: [],
      stillMoving: [],
      watch: null,
    };
    for (const s of Array.isArray(o.unfreezable) ? o.unfreezable : []) {
      if (typeof s === "string" && s.trim() && receipt.unfreezable.indexOf(s) === -1) receipt.unfreezable.push(s);
    }

    // 1) Kit players first: they own their writers and freeze them at phase 0 through
    //    the hook registry. A hook that throws is receipted, never fatal.
    for (const hook of Array.isArray(root.__pingfusiFreezeHooks) ? root.__pingfusiFreezeHooks.slice() : []) {
      try {
        const r = typeof hook === "function" ? hook() : null;
        receipt.players.push(r && typeof r === "object"
          ? { player: String(r.player || "kit-player").slice(0, 40), frozen: r.frozen | 0, ids: (Array.isArray(r.ids) ? r.ids : []).slice(0, 50).map(String) }
          : { player: "kit-player", frozen: 0, ids: [] });
      } catch (e) {
        receipt.players.push({ player: "kit-player", frozen: 0, ids: [], error: firstMsg(e) });
      }
    }

    // 2) The generic pass: every declared animation still RUNNING is paused and seeked
    //    to progress 0 of its current iteration.
    if (receipt.supported) {
      let anims = [];
      try { anims = document.getAnimations({ subtree: true }) || []; }
      catch (e) { try { anims = document.getAnimations() || []; } catch (e2) { anims = []; } }
      for (const anim of anims) {
        try {
          if (typeof anim.id === "string" && anim.id.indexOf(KIT_ANIM_PREFIX) === 0) { receipt.skipped.kitPlayer++; continue; } // the player's own hook handled it
          const effect = anim.effect;
          const target = effect && effect.target;
          if (target && root.pxIsAgentDom && root.pxIsAgentDom(target)) { receipt.skipped.agentDom++; continue; }
          const tl = anim.timeline;
          const scrollDriven = !!tl && ((root.ViewTimeline && tl instanceof root.ViewTimeline) || (root.ScrollTimeline && tl instanceof root.ScrollTimeline));
          if (scrollDriven) { receipt.skipped.scrollLinked++; continue; } // scroll position IS its phase — already deterministic, and ms-seeking a percent clock would corrupt it
          const state = anim.playState;
          if (state === "finished" || state === "idle") { receipt.skipped.finished++; continue; } // the settled end state is the page users see
          if (state === "paused") { receipt.alreadyPaused++; continue; } // page-authored pose — not the instrument's to move
          let t = {};
          try { t = (effect && typeof effect.getComputedTiming === "function" && effect.getComputedTiming()) || {}; } catch (e) {}
          const dur = typeof t.duration === "number" && isFinite(t.duration) ? t.duration : 0;
          const iter = typeof t.currentIteration === "number" && isFinite(t.currentIteration) ? t.currentIteration : 0;
          const delay = typeof t.delay === "number" && isFinite(t.delay) ? t.delay : 0;
          anim.pause();
          anim.currentTime = delay + iter * dur; // progress 0 within the CURRENT iteration
          receipt.frozen++;
          if (receipt.ids.length < 100) receipt.ids.push(freezeLabel(anim, target));
        } catch (e) { receipt.skipped.failed++; }
      }
    }

    // 3) The post-freeze watch: what still moves after every declared animation is held
    //    is a writer no pause can reach (a hand-rolled rAF loop, GSAP's own ticker).
    //    Reuses the dense recorder — the sampled tier's instrument — so "still moving"
    //    means the same thing here as in the ongoing-motion sweep: changed in EVERY
    //    interval (element samples), or inline-style writes at 2+ distinct step times.
    const watchIntervals = typeof o.watchIntervals === "number" && o.watchIntervals >= 1 ? Math.floor(o.watchIntervals) : 2;
    const watchIntervalMs = typeof o.watchIntervalMs === "number" && o.watchIntervalMs > 0 ? o.watchIntervalMs : 180;
    if (o.watch === false || typeof root.pxDenseRecordStart !== "function") {
      receipt.watch = { ran: false, reason: o.watch === false ? "disabled by caller" : "dense recorder unavailable" };
    } else {
      try {
        root.pxDenseRecordStart({ scopes: [typeof o.watchScope === "string" && o.watchScope ? o.watchScope : "body"], props: ["transform", "opacity"] });
        root.pxDenseRecordStep(0);
        for (let i = 1; i <= watchIntervals; i++) { await sleep(watchIntervalMs); root.pxDenseRecordStep(i * watchIntervalMs); }
        const rec = root.pxDenseRecordStop();
        const moving = {};
        for (const el of rec.elements || []) {
          if (!el || typeof el.selector !== "string" || !el.selector || !Array.isArray(el.samples) || el.samples.length < watchIntervals + 1) continue;
          for (const prop of ["transform", "opacity"]) {
            let moved = true;
            for (let i = 1; i < el.samples.length; i++) {
              const a = el.samples[i - 1] && el.samples[i - 1].values ? el.samples[i - 1].values[prop] : null;
              const b = el.samples[i] && el.samples[i].values ? el.samples[i].values[prop] : null;
              if (a === b) { moved = false; break; }
            }
            if (moved) { moving[el.selector] = 1; break; }
          }
        }
        const writeTimes = {};
        for (const w of rec.writes || []) {
          if (!w || typeof w.selector !== "string" || !w.selector) continue;
          (writeTimes[w.selector] = writeTimes[w.selector] || {})[w.t] = 1;
        }
        for (const sel of Object.keys(writeTimes)) if (Object.keys(writeTimes[sel]).length >= 2) moving[sel] = 1;
        receipt.stillMoving = Object.keys(moving).sort();
        receipt.watch = { ran: true, intervals: watchIntervals, intervalMs: watchIntervalMs, tracked: (rec.elements || []).length, writes: (rec.writes || []).length, truncated: !!rec.truncated };
      } catch (e) {
        receipt.watch = { ran: false, reason: firstMsg(e) };
      }
    }
    for (const sel of receipt.stillMoving) if (receipt.unfreezable.indexOf(sel) === -1) receipt.unfreezable.push(sel);
    return receipt;
  };

  // Which enumerated marks live inside an unfreezable mover's subtree? Keyed by the same
  // slug names the snapshot uses (pxEnumerateLeaves is deterministic on a frozen DOM), so
  // the diff can exclude exactly these marks and LIST them. closest() matches the mover
  // itself too — the mover is its own first excluded mark.
  root.pxMarksInSubtrees = function (selectors) {
    const out = {};
    const sels = [];
    for (const s of Array.isArray(selectors) ? selectors : []) if (typeof s === "string" && s.trim()) sels.push(s);
    if (!sels.length || typeof root.pxEnumerateLeaves !== "function") return out;
    for (const leaf of root.pxEnumerateLeaves()) {
      for (const sel of sels) {
        let hit = null;
        try { hit = leaf.el && leaf.el.closest ? leaf.el.closest(sel) : null; } catch (e) { hit = null; }
        if (hit) { out[leaf.name] = sel; break; }
      }
    }
    return out;
  };

  // The phased one-call: settle → freeze → measure. Same report contract as pxCaptureAll
  // — including the settle STOP (the predicate is duplicated from captureAllShouldAbort
  // because this section is append-only by design; keep them in lockstep).
  root.pxCaptureAllPhased = async function (sinkUrl, opts) {
    const o = opts || {};
    const prefix = o.prefix || "live";
    const settle = o.settle === false ? "skipped" : await root.pxScrollSettle(o.settleOpts);
    if (settle && typeof settle === "object" && settle.stable === false) {
      return {
        prefix, leaves: 0, byKind: {}, delivered: [], failed: [], ok: false,
        aborted: "settle-not-stable", settle,
        hint: "the page never settled (still growing, or images still loading) — the DOM right now is a page that never existed. Inspect settle.heights / settle.imagesPending / settle.pendingImageSrcs, fix or wait, then re-run.",
      };
    }
    const freeze = await root.pxFreezeAnimations({
      unfreezable: o.unfreezable,
      watch: o.freezeWatch,
      watchIntervalMs: o.freezeWatchIntervalMs,
      watchIntervals: o.freezeWatchIntervals,
    });
    const inner = {};
    for (const k of Object.keys(o)) inner[k] = o[k];
    inner.settle = false; // the settle above already ran and passed — never settle twice
    const report = await root.pxCaptureAll(sinkUrl, inner);
    report.settle = settle; // the real settle evidence, not "skipped"
    const excludedMarks = root.pxMarksInSubtrees(freeze.unfreezable);
    freeze.excludedMarks = excludedMarks;
    const file = prefix + ".json";
    if (report.payloads && typeof report.payloads[file] === "string") {
      try {
        const snap = JSON.parse(report.payloads[file]);
        snap.freeze = {
          frozen: freeze.frozen, ids: freeze.ids, players: freeze.players,
          alreadyPaused: freeze.alreadyPaused, skipped: freeze.skipped,
          unfreezable: freeze.unfreezable, excludedMarks,
        };
        report.payloads[file] = JSON.stringify(snap);
        for (const d of report.delivered || []) if (d && d.file === file) d.bytes = new TextEncoder().encode(report.payloads[file]).length;
      } catch (e) { freeze.embedError = firstMsg(e); }
    }
    report.freeze = freeze;
    return report;
  };
})(typeof window !== "undefined" ? window : globalThis);
