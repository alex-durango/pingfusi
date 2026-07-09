/**
 * extract-fonts.js — reusable web-font extractor
 * ------------------------------------------------
 * Paste this whole file into the DevTools Console on ANY site (or run it via a
 * browser-automation `javascript_tool`). It:
 *   1. Reads every @font-face rule in the page's stylesheets.
 *   2. Fetches each font binary from its real (CORS-permitting) URL.
 *   3. Bundles them into ONE zip (single download — dodges Chrome's
 *      "multiple automatic downloads" block) named "<host>-fonts.zip".
 *   4. Also drops a ready-to-use fonts.css into the same zip.
 *
 * Filter which families to grab with the optional argument:
 *   extractFonts()                      // all families
 *   extractFonts(/proxima|arquitecta/i) // only matching families
 *
 * Notes:
 *  - Only fonts whose CDN allows cross-origin fetch (most do, incl. Typekit)
 *    will download; others are reported as errors but don't stop the run.
 *  - These are usually licensed fonts. Use for local testing only; don't
 *    redistribute or ship on a public site without a license.
 */
async function extractFonts(familyFilter = null) {
  // ---- minimal store-mode ZIP writer (no deps) ----
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
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const nb = enc.encode(f.name);
      const crc = crc32(f.data);
      const sz = f.data.length;
      const head = [0x50, 0x4b, 3, 4, ...u16(20), ...u16(0), ...u16(0), ...u16(0),
        ...u16(0), ...u32(crc), ...u32(sz), ...u32(sz), ...u16(nb.length), ...u16(0)];
      const arr = new Uint8Array(head.length + nb.length + sz);
      arr.set(head, 0); arr.set(nb, head.length); arr.set(f.data, head.length + nb.length);
      chunks.push(arr);
      central.push({ nb, crc, sz, offset });
      offset += arr.length;
    }
    const cd = [];
    let cdSize = 0;
    for (const c of central) {
      const rec = [0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0), ...u16(0),
        ...u16(0), ...u16(0), ...u32(c.crc), ...u32(c.sz), ...u32(c.sz),
        ...u16(c.nb.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(0), ...u32(c.offset)];
      const arr = new Uint8Array(rec.length + c.nb.length);
      arr.set(rec, 0); arr.set(c.nb, rec.length);
      cd.push(arr); cdSize += arr.length;
    }
    const eocd = new Uint8Array([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0),
      ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
    return new Blob([...chunks, ...cd, eocd], { type: 'application/zip' });
  }

  // ---- 1. collect @font-face rules ----
  const faces = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { continue; } // skip cross-origin sheets
    if (!rules) continue;
    for (const r of rules) {
      if (!(r.constructor && r.constructor.name === 'CSSFontFaceRule')) continue;
      const family = (r.style.getPropertyValue('font-family') || '').replace(/["']/g, '').trim();
      if (familyFilter && !familyFilter.test(family)) continue;
      const weight = r.style.getPropertyValue('font-weight') || '400';
      const style = r.style.getPropertyValue('font-style') || 'normal';
      const src = r.style.getPropertyValue('src') || '';
      // prefer woff2, fall back to first url()
      const m = src.match(/url\(["']?([^"')]+)["']?\)\s*format\(["']?woff2["']?\)/i)
        || src.match(/url\(["']?([^"')]+)["']?\)/i);
      if (!m) continue;
      const ext = (m[1].match(/\.(woff2|woff|ttf|otf)(?:[?#]|$)/i) || [, 'woff2'])[1].toLowerCase();
      const safeFam = (family || 'font').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      faces.push({
        family, weight, style, url: m[1],
        name: `${safeFam}-${weight}-${style}.${ext}`,
      });
    }
  }
  if (!faces.length) { console.warn('No matching @font-face rules found.'); return; }

  // ---- 2. fetch binaries ----
  const files = [];
  const errors = [];
  for (const f of faces) {
    try {
      const buf = await (await fetch(f.url, { mode: 'cors' })).arrayBuffer();
      files.push({ name: f.name, data: new Uint8Array(buf), face: f });
    } catch (e) {
      errors.push(`${f.name}: ${e.message}`);
    }
  }

  // ---- 3. generate fonts.css ----
  const css = files.map(({ face, name }) =>
    `@font-face {\n  font-family: "${face.family}";\n  font-weight: ${face.weight};\n  font-style: ${face.style};\n  src: url("./${name}") format("woff2");\n  font-display: swap;\n}`
  ).join('\n\n') + '\n';
  files.push({ name: 'fonts.css', data: new TextEncoder().encode(css) });

  // ---- 4. single download ----
  const host = location.hostname.replace(/^www\./, '');
  const blob = buildZip(files);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${host}-fonts.zip`;
  document.body.appendChild(a); a.click(); a.remove();

  console.log(`✅ ${files.length - 1} font(s) zipped → ${a.download} (${blob.size} bytes)`);
  if (errors.length) console.warn('⚠️ skipped (CORS/other):\n' + errors.join('\n'));
  return { downloaded: files.length - 1, errors };
}

// Auto-run when pasted directly; comment out if you only want the function defined.
extractFonts();
