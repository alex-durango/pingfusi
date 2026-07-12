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
  const glyphBox = (el) => {
    const wrap = (b, extra) => ({
      cx: num(b.left + b.width / 2), cy: num(b.top + b.height / 2),
      top: num(b.top), bottom: num(b.bottom), w: num(b.width), h: num(b.height), ...extra,
    });
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

  function measure(el, want) {
    if (!el) return { present: false };
    const r = el.getBoundingClientRect();
    const c = getComputedStyle(el);
    const vw = window.innerWidth;
    const parent = el.parentElement;
    const pc = parent ? getComputedStyle(parent) : null;
    const prev = el.previousElementSibling;
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
  root.pxScrollSettle = function (opts) {
    const o = opts || {};
    const pause = o.pause || 300;        // per-step: long enough for observers + image kicks
    const settle = o.settle || 1500;     // at bottom and back at top: reveal transitions run ~1s
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    return (async () => {
      const step = Math.max(400, Math.floor(root.innerHeight * 0.8));
      let y = 0, guard = 0;
      // scrollHeight GROWS as lazy sections mount — re-read it every step, don't snapshot it
      while (y + root.innerHeight < document.documentElement.scrollHeight && guard++ < (o.maxSteps || 300)) {
        y += step;
        root.scrollTo(0, y);
        await sleep(pause);
      }
      const scrolledTo = document.documentElement.scrollHeight;
      root.scrollTo(0, scrolledTo);
      await sleep(settle);
      root.scrollTo(0, 0);
      await sleep(settle);
      const frozenOpacity0 = document.querySelectorAll('[style*="opacity: 0"], [style*="opacity:0"]').length;
      return { scrolledTo, frozenOpacity0 };
    })();
  };
  // The full post-hydration DOM, doctype INCLUDED-OR-ABSENT exactly as live ships it —
  // outerHTML alone drops the doctype, and adding a tidy one to a quirks-mode site moves
  // pixels with every computed style identical (LEARNINGS #18). Feed the result to
  // `pingfusi capture-build <name>` (the default build strategy). On any page with
  // below-fold content, run `await pxScrollSettle()` FIRST — a top-of-page capture
  // freezes lazy sections out of existence and scroll-reveals at opacity:0.
  root.pxDomHtml = function () {
    const dt = document.doctype;
    const doctype = dt
      ? "<!DOCTYPE " + dt.name + (dt.publicId ? ' PUBLIC "' + dt.publicId + '"' : "") + (!dt.publicId && dt.systemId ? " SYSTEM" : "") + (dt.systemId ? ' "' + dt.systemId + '"' : "") + ">\n"
      : "";
    return doctype + document.documentElement.outerHTML;
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
})(typeof window !== "undefined" ? window : globalThis);
