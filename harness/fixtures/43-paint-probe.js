// fixtures/43-paint-probe.js — PIXELS ARE THE ONLY WITNESS THAT PAINTING HAPPENED.
//
// The BLACK-PAGE GREEN miss (bizar.ro, LEARNINGS #37): the page paints in a WebGL canvas,
// live.json and clone.json are BOTH produced by tools/browser-capture.js, so the DOM
// skeleton measured identical on both sides — visual passed 1236/1236 while the published
// draft rendered SOLID BLACK. capture-run's paint probe closes the blind spot: one
// Page.captureScreenshot per side, decoded by a dependency-honest PNG scanline reader
// (zlib is a Node built-in — no image library in the core kit), reduced to a paint
// statistic. This fixture pins the PROBE MATH — it fails without paintStatFromPng /
// paintVerdict (harness/capture-runner.js) and passes with them:
//   • a uniform frame classifies nearBlank (nonUniformRatio ≈ 0)
//   • a rich frame does not (checkerboard ≈ 0.5)
//   • the verdict fires ONLY on the pairing (clone near-blank AND live rich) — a
//     genuinely minimal live page never flags its equally minimal clone
//   • all five PNG filter types decode to the SAME stats (Chrome picks filters per row)
//   • RGB (colorType 2) and RGBA (colorType 6) agree; exotic shapes are refused by name
"use strict";
const zlib = require("zlib");
const { paintStatFromPng, paintVerdict, PAINT_NEAR_BLANK_RATIO, PAINT_RICH_RATIO } = require("../capture-runner.js");
let bad = 0; const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

// ── a tiny PNG encoder (filter-0 rows; CRCs zeroed — the probe reads its own Chrome's
//    bytes and does not verify CRCs, which this fixture documents by relying on it) ─────
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
};
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function rawScanlines(width, height, px, bpp) {
  const stride = width * bpp;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const off = y * (stride + 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = px(x, y);
      const i = off + 1 + x * bpp;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
      if (bpp === 4) raw[i + 3] = 255;
    }
  }
  return raw;
}
function makePng(width, height, px, opts = {}) {
  const colorType = opts.rgb ? 2 : 6;
  const bpp = opts.rgb ? 3 : 4;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = opts.bitDepth || 8; ihdr[9] = colorType; ihdr[12] = opts.interlace || 0;
  let raw = rawScanlines(width, height, px, bpp);
  if (opts.filters) raw = filterRows(raw, width, height, bpp, opts.filters);
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
// Forward-apply per-row PNG filters (types cycle) so the decoder's unfilter is exercised —
// predictors read the UNFILTERED previous row, exactly as the spec defines them.
function filterRows(raw, width, height, bpp, types) {
  const stride = width * bpp;
  const out = Buffer.from(raw);
  for (let y = 0; y < height; y++) {
    const t = types[y % types.length];
    const off = y * (stride + 1);
    out[off] = t;
    for (let i = 0; i < stride; i++) {
      const cur = raw[off + 1 + i];
      const a = i >= bpp ? raw[off + 1 + i - bpp] : 0;
      const b = y > 0 ? raw[(y - 1) * (stride + 1) + 1 + i] : 0;
      const c = y > 0 && i >= bpp ? raw[(y - 1) * (stride + 1) + 1 + i - bpp] : 0;
      let pred = 0;
      if (t === 1) pred = a;
      else if (t === 2) pred = b;
      else if (t === 3) pred = (a + b) >> 1;
      else if (t === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[off + 1 + i] = (cur - pred) & 255;
    }
  }
  return out;
}

// ── the shapes under test ─────────────────────────────────────────────────────
const BLACK = () => [0, 0, 0];
const CHECKER = (x, y) => (((x >> 3) + (y >> 3)) % 2 ? [255, 255, 255] : [20, 40, 200]);
const GRADIENT = (x, y) => [(x * 3) & 255, (y * 5) & 255, (x + y) & 255];
// a white page with ~1% dark marks — sparse-but-real content, the false-positive trap
const SPARSE = (x, y) => (x % 10 === 0 && y % 10 === 0 ? [0, 0, 0] : [255, 255, 255]);

check("the probe math is exported (fails without the kit change)",
  typeof paintStatFromPng === "function" && typeof paintVerdict === "function" &&
  typeof PAINT_NEAR_BLANK_RATIO === "number" && typeof PAINT_RICH_RATIO === "number");

// 1. uniform frame → nearBlank (the solid-black draft, as the reviewer saw it)
const black = paintStatFromPng(makePng(120, 80, BLACK));
check("a uniform black frame classifies NEAR-BLANK (nonUniformRatio ≈ 0)",
  black.nearBlank === true && black.nonUniformRatio < 0.001 && black.lumaMean < 1, JSON.stringify(black));

// 2. rich frame → not nearBlank
const rich = paintStatFromPng(makePng(120, 80, CHECKER));
check("a checkerboard frame is rich (ratio ≈ 0.5, never near-blank)",
  rich.nearBlank === false && rich.nonUniformRatio > 0.4 && rich.nonUniformRatio < 0.6, JSON.stringify(rich));

// 3. sparse marks sit near the documented floor — the verdict PAIRING is what protects them
const sparse = paintStatFromPng(makePng(120, 80, SPARSE));
check("sparse content measures sparse (~1% off the dominant tone)",
  sparse.nonUniformRatio > 0.005 && sparse.nonUniformRatio < 0.03, JSON.stringify(sparse));

// 4. the verdict: fires ONLY on clone-near-blank + live-rich
check("verdict fires on a near-blank clone under a rich live page, and says so plainly",
  /paints almost nothing/.test(paintVerdict(rich, black) || ""));
check("CONTROL — rich clone under rich live: no verdict", paintVerdict(rich, rich) === null);
check("CONTROL — a minimal live page never flags its equally minimal clone", paintVerdict(black, black) === null && paintVerdict(sparse, black) === null);
check("CONTROL — a missing side proves nothing (probe unavailable ≠ blank)", paintVerdict(null, black) === null && paintVerdict(rich, null) === null);
check("the canvas capability statement rides the verdict when live receipted dominance",
  /script-driven canvas/.test(paintVerdict(rich, black, { dominant: true, bestCoverage: 0.97, marksInFront: 2 }) || "") &&
  !/script-driven canvas/.test(paintVerdict(rich, black, { dominant: false }) || ""));

// 5. every PNG filter type decodes to the same stats (Chrome picks filters per row)
const plain = paintStatFromPng(makePng(64, 64, GRADIENT));
const filtered = paintStatFromPng(makePng(64, 64, GRADIENT, { filters: [1, 2, 3, 4, 0] }));
check("Sub/Up/Average/Paeth rows decode identically to filter-0 rows",
  plain.nonUniformRatio === filtered.nonUniformRatio && plain.lumaMean === filtered.lumaMean && plain.lumaStdev === filtered.lumaStdev,
  `plain ${JSON.stringify(plain)} vs filtered ${JSON.stringify(filtered)}`);

// 6. RGB (colorType 2) agrees with RGBA (colorType 6)
const rgb = paintStatFromPng(makePng(64, 64, GRADIENT, { rgb: true }));
check("colorType 2 (RGB) and 6 (RGBA) produce the same stats", rgb.nonUniformRatio === plain.nonUniformRatio && rgb.lumaMean === plain.lumaMean);

// 7. exotic shapes are refused BY NAME — the caller receipts, never guesses
for (const [label, opts] of [["16-bit depth", { bitDepth: 16 }], ["interlaced", { interlace: 1 }]]) {
  let err = null;
  try { paintStatFromPng(makePng(8, 8, BLACK, opts)); } catch (e) { err = e.message; }
  check(`${label} PNG refused by name`, /unsupported PNG shape/.test(err || ""), err);
}
{
  let err = null;
  try { paintStatFromPng(Buffer.from("not a png at all, not even close")); } catch (e) { err = e.message; }
  check("non-PNG bytes refused", /not a PNG/.test(err || ""));
}

process.exit(bad ? 1 : 0);
