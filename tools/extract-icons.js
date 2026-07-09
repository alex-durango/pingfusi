/**
 * extract-icons.js — reusable web-icon extractor (sibling of fonts/extract-fonts.js)
 * ----------------------------------------------------------------------------------
 * Paste this whole file into the DevTools Console on ANY site (or run it via a
 * browser-automation `javascript_tool`). It finds icons however the site ships
 * them and bundles them into ONE zip (single download — dodges Chrome's
 * "multiple automatic downloads" block) named "<host>-icons.zip":
 *
 *   icons/<name>.svg   one standalone SVG per icon (inline <svg>, sprite <use>,
 *                      data-URI background/mask, <img src=*.svg>)
 *   icons.css          ready-to-use classes; CSS-background icons keep their
 *                      EXACT original data-URI so they render byte-identically
 *   preview.html       a gallery of everything captured, with names
 *   report.json        what was captured, by which method, plus anything skipped
 *
 * Usage:
 *   extractIcons()                 // whole page
 *   extractIcons('header')         // limit to a CSS selector (scope)
 *   extractIcons('header', /22|24/)// scope + only icons whose viewBox/size matches
 *
 * Notes:
 *  - Icon FONTS (Font Awesome, Material Icons, etc.) can't be turned into SVGs
 *    here — they're glyphs in a webfont. They're listed in report.json; grab the
 *    font itself with fonts/extract-fonts.js.
 *  - External (cross-origin) SVG URLs are fetched best-effort; CORS failures are
 *    recorded in report.json rather than aborting the run.
 */
async function extractIcons(scope = null, filter = null) {
  const root = scope ? document.querySelector(scope) || document.body : document.body;
  const SVG_NS = "http://www.w3.org/2000/svg";

  // ---------- minimal store-mode ZIP writer (no deps) ----------
  const crcTable = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (u8) => {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const u16 = (n) => [n & 255, (n >> 8) & 255];
  const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
  function buildZip(files) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    for (const f of files) {
      const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
      const nb = enc.encode(f.name), crc = crc32(data), sz = data.length;
      const head = [0x50, 0x4b, 3, 4, ...u16(20), ...u16(0), ...u16(0), ...u16(0),
        ...u16(0), ...u32(crc), ...u32(sz), ...u32(sz), ...u16(nb.length), ...u16(0)];
      const arr = new Uint8Array(head.length + nb.length + sz);
      arr.set(head, 0); arr.set(nb, head.length); arr.set(data, head.length + nb.length);
      chunks.push(arr); central.push({ nb, crc, sz, offset }); offset += arr.length;
    }
    const cd = []; let cdSize = 0;
    for (const c of central) {
      const rec = [0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0), ...u16(0),
        ...u16(0), ...u16(0), ...u32(c.crc), ...u32(c.sz), ...u32(c.sz),
        ...u16(c.nb.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(c.offset)];
      const arr = new Uint8Array(rec.length + c.nb.length);
      arr.set(rec, 0); arr.set(c.nb, rec.length); cd.push(arr); cdSize += arr.length;
    }
    const eocd = new Uint8Array([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0),
      ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
    return new Blob([...chunks, ...cd, eocd], { type: "application/zip" });
  }

  // ---------- helpers ----------
  const used = new Set();
  const slug = (s) =>
    (s || "icon").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "icon";
  const uniqName = (base) => {
    let n = slug(base), i = 2;
    while (used.has(n)) n = `${slug(base)}-${i++}`;
    used.add(n);
    return n;
  };
  // best label for an element: aria-label > title > icon-ish class > tag
  const labelFor = (el) => {
    const a = el.closest("a,button,[aria-label],[title]");
    const lbl = a?.getAttribute("aria-label") || a?.getAttribute("title") || el.getAttribute("aria-label");
    if (lbl) return lbl;
    const cls = [...el.classList].find((c) => /icon|ico|svg|glyph/i.test(c));
    if (cls) return cls.replace(/icon|ico|static|svg/gi, "");
    return el.tagName.toLowerCase();
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.width <= 200 && r.height <= 200;
  };
  // normalize an svg string for dedup
  const norm = (s) => s.replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();
  const seen = new Set();

  const svgFiles = [];   // {name, svg}
  const cssIcons = [];   // {name, w, h, bg}  (background/mask data-URIs kept verbatim)
  const report = { host: location.hostname, captured: [], skipped: [] };

  function pushSvg(svgStr, label, method) {
    if (filter && !filter.test(`${label} ${svgStr}`)) return null; // optional viewBox/size/name filter
    const n = norm(svgStr);
    if (seen.has(n)) return null;
    seen.add(n);
    const name = uniqName(label);
    svgFiles.push({ name: `icons/${name}.svg`, svg: svgStr });
    report.captured.push({ name, method });
    return name;
  }

  // ---------- 1. inline <svg> (skip the giant logo? no — keep everything small) ----------
  for (const svg of root.querySelectorAll("svg")) {
    if (!visible(svg)) continue;
    if (svg.querySelector("use")) continue; // handled by sprite pass
    const clone = svg.cloneNode(true);
    if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", SVG_NS);
    pushSvg(clone.outerHTML, labelFor(svg), "inline-svg");
  }

  // ---------- 2. sprite <use href="#id"> ----------
  for (const use of root.querySelectorAll("use")) {
    const svg = use.closest("svg");
    if (!svg || !visible(svg)) continue;
    const href = use.getAttribute("href") || use.getAttribute("xlink:href") || "";
    const id = href.startsWith("#") ? href.slice(1) : href.split("#")[1];
    if (!id) continue;
    const sym = document.getElementById(id);
    if (!sym) { report.skipped.push({ label: labelFor(svg), reason: `sprite ref #${id} not found in DOM` }); continue; }
    const vb = sym.getAttribute("viewBox") || svg.getAttribute("viewBox") || "0 0 24 24";
    const out = `<svg xmlns="${SVG_NS}" viewBox="${vb}">${sym.innerHTML}</svg>`;
    pushSvg(out, labelFor(svg), "sprite-use");
  }

  // ---------- 3. CSS background-image / mask-image (data-URI or external) ----------
  // strips the FULL data-URI prefix up to the first comma (handles
  // `data:image/svg+xml,`, `;charset=utf-8,`, `;base64,`, etc.)
  const decodeDataSvg = (uri) => {
    const comma = uri.indexOf(",");
    if (comma < 0) return null;
    const meta = uri.slice(0, comma), body = uri.slice(comma + 1);
    if (/;base64/i.test(meta)) { try { return atob(body); } catch { return null; } }
    try { return decodeURIComponent(body); } catch { return body; }
  };
  for (const el of root.querySelectorAll("*")) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const mask = cs.maskImage && cs.maskImage !== "none" ? cs.maskImage
      : cs.webkitMaskImage && cs.webkitMaskImage !== "none" ? cs.webkitMaskImage : null;
    const pick = mask || (cs.backgroundImage !== "none" ? cs.backgroundImage : null);
    if (!pick) continue;
    const m = pick.match(/url\((['"]?)(.*?)\1\)/s);
    if (!m) continue;
    const uri = m[2];
    const r = el.getBoundingClientRect();
    const w = Math.round(r.width), h = Math.round(r.height);
    const label = labelFor(el);

    if (uri.startsWith("data:image/svg")) {
      const svg = decodeDataSvg(uri);
      if (svg && svg.includes("<svg")) {
        const name = pushSvg(svg, label, mask ? "css-mask" : "css-background");
        // keep the exact original URI for a pixel-perfect CSS class too
        if (name) cssIcons.push({ name, w: w || null, h: h || null, bg: pick, recolor: mask ? cs.backgroundColor : null });
      }
    } else if (/\.svg(\?|#|$)/i.test(uri)) {
      // external svg — best-effort fetch
      try {
        const txt = await (await fetch(uri, { mode: "cors" })).text();
        if (txt.includes("<svg")) {
          const name = pushSvg(txt, label, "external-svg");
          if (name) cssIcons.push({ name, w: w || null, h: h || null, bg: `url("./icons/${name}.svg")` });
        }
      } catch (e) { report.skipped.push({ label, reason: "external svg fetch failed (CORS)" }); }
    }
  }

  // ---------- 4. <img src="*.svg"> ----------
  for (const img of root.querySelectorAll("img")) {
    if (!visible(img)) continue;
    const src = img.currentSrc || img.src || "";
    if (!/\.svg(\?|#|$)/i.test(src) && !src.startsWith("data:image/svg")) continue;
    try {
      let txt;
      if (src.startsWith("data:image/svg")) txt = decodeDataSvg(src);
      else txt = await (await fetch(src, { mode: "cors" })).text();
      if (txt && txt.includes("<svg")) pushSvg(txt, labelFor(img) || img.alt, "img-svg");
    } catch (e) { report.skipped.push({ label: img.alt || "img", reason: "img svg fetch failed (CORS)" }); }
  }

  // ---------- 5. detect (but can't extract) icon fonts ----------
  const iconFontEls = new Set();
  for (const el of root.querySelectorAll("*")) {
    const fam = getComputedStyle(el).fontFamily || "";
    if (/font ?awesome|material icons|material symbols|ionicons|glyphicon|feather|remixicon/i.test(fam)) {
      iconFontEls.add(fam.split(",")[0].replace(/["']/g, "").trim());
    }
  }
  if (iconFontEls.size)
    report.skipped.push({ label: [...iconFontEls].join(", "), reason: "icon font — extract the webfont with extract-fonts.js instead" });

  if (!svgFiles.length) {
    console.warn("No extractable icons found on this page.", report);
    return report;
  }

  // ---------- assemble icons.css ----------
  let css = "/* " + location.hostname + " icons — generated by extract-icons.js */\n";
  css += ".icon{display:inline-block;background-repeat:no-repeat;background-position:center;background-size:contain}\n";
  for (const ic of cssIcons) {
    const dims = (ic.w ? `width:${ic.w}px;` : "") + (ic.h ? `height:${ic.h}px;` : "");
    const recolor = ic.recolor && ic.recolor !== "rgba(0, 0, 0, 0)"
      ? `background-color:${ic.recolor};-webkit-mask:${ic.bg} center/contain no-repeat;mask:${ic.bg} center/contain no-repeat;`
      : `background-image:${ic.bg};`;
    css += `.icon-${ic.name}{${dims}${recolor}}\n`;
  }

  // ---------- preview.html ----------
  const cards = svgFiles.map((f) => {
    const nm = f.name.replace("icons/", "").replace(".svg", "");
    return `<figure><div class="box">${f.svg}</div><figcaption>${nm}</figcaption></figure>`;
  }).join("\n");
  const preview = `<!doctype html><meta charset=utf8><title>${location.hostname} icons</title>
<style>body{font:14px system-ui;padding:24px;background:#fff;color:#111}
h1{font-size:18px}.grid{display:flex;flex-wrap:wrap;gap:16px;margin-top:16px}
figure{margin:0;width:120px;text-align:center}.box{height:60px;display:grid;place-items:center;border:1px solid #eee;border-radius:8px}
.box svg{width:28px;height:28px}figcaption{margin-top:6px;font-size:11px;color:#555;word-break:break-all}</style>
<h1>${svgFiles.length} icons from ${location.hostname}</h1><div class=grid>${cards}</div>`;

  // ---------- build + download one zip ----------
  const files = [
    ...svgFiles.map((f) => ({ name: f.name, data: f.svg })),
    { name: "icons.css", data: css },
    { name: "preview.html", data: preview },
    { name: "report.json", data: JSON.stringify(report, null, 2) },
  ];
  const host = location.hostname.replace(/^www\./, "");
  const blob = buildZip(files);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${host}-icons.zip`;
  document.body.appendChild(a); a.click(); a.remove();

  console.log(`✅ ${svgFiles.length} icon(s) → ${a.download} (${blob.size} bytes)`);
  if (report.skipped.length) console.warn("⚠️ skipped:", report.skipped);
  return report;
}

// Auto-run when pasted directly; comment out to only define the function.
extractIcons();
