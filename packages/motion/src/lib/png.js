import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export function decodePng(buffer) {
  return PNG.sync.read(buffer);
}

export function encodePng(png) {
  return PNG.sync.write(png);
}

export function cropPng(png, rect) {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const width = Math.min(png.width - x, Math.ceil(rect.width));
  const height = Math.min(png.height - y, Math.ceil(rect.height));
  const out = new PNG({ width, height });
  PNG.bitblt(png, out, x, y, width, height, 0, 0);
  return out;
}

// Compare two same-sized PNGs. Returns global ratio plus the worst 32×32 window count,
// so a small element that is badly wrong can't hide inside a low global percentage.
export function comparePng(a, b, { threshold = 0.1, windowSize = 32 } = {}) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const total = a.width * a.height;
  const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold });
  const windowMax = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold, windowSize });
  const win = Math.min(windowSize, a.width, a.height);
  return {
    diffPixels,
    ratio: total ? diffPixels / total : 0,
    windowMax,
    windowRatio: win > 0 ? windowMax / (win * win) : 0,
    diff,
  };
}

export function unionRects(rects) {
  const rs = rects.filter(Boolean);
  if (!rs.length) return null;
  const x1 = Math.min(...rs.map((r) => r.x));
  const y1 = Math.min(...rs.map((r) => r.y));
  const x2 = Math.max(...rs.map((r) => r.x + r.width));
  const y2 = Math.max(...rs.map((r) => r.y + r.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function padClampRect(rect, pad, bounds) {
  const x = Math.max(0, rect.x - pad);
  const y = Math.max(0, rect.y - pad);
  return {
    x,
    y,
    width: Math.min(bounds.width - x, rect.width + 2 * pad),
    height: Math.min(bounds.height - y, rect.height + 2 * pad),
  };
}
