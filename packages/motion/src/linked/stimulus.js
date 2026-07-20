import { parseTrigger } from '../capture/triggers.js';
import { sha256 } from '../lib/artifacts.js';

export const MAX_LINKED_FRAMES = 120;

export function scopeSelector(scope, fallback = null) {
  if (typeof scope === 'string' && scope.trim()) return scope.trim();
  if (scope && typeof scope.selector === 'string' && scope.selector.trim()) return scope.selector.trim();
  return fallback;
}

function finiteScrollFrames(trace) {
  const triggerAt = Number.isFinite(trace.triggerAt) ? trace.triggerAt : -Infinity;
  return (Array.isArray(trace.frames) ? trace.frames : [])
    .filter((frame) => Number.isFinite(frame?.t) && Number.isFinite(frame?.scrollY) && frame.t >= triggerAt)
    .sort((a, b) => a.t - b.t);
}

function collapseScrollFrames(frames) {
  const points = [];
  for (const frame of frames) {
    const y = +frame.scrollY.toFixed(3);
    if (!points.length || Math.abs(points.at(-1).sourceScrollY - y) >= 0.5) {
      points.push({ sourceScrollY: y, sourceT: +frame.t.toFixed(1) });
    }
  }
  return points;
}

function downsample(points, maxFrames) {
  if (points.length <= maxFrames) return points;
  const picked = [];
  let previous = -1;
  for (let i = 0; i < maxFrames; i++) {
    const index = Math.round((i * (points.length - 1)) / (maxFrames - 1));
    if (index !== previous) picked.push(points[index]);
    previous = index;
  }
  return picked;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// The source trace is the authority for distance. Each live page is aligned to its own
// section start, then receives these exact pixel deltas. Recomputing a separate 0..1
// range for the candidate would normalize away the very sticky-travel bugs under review.
export function buildScrollStimulus(trace, { maxFrames = MAX_LINKED_FRAMES } = {}) {
  const trigger = parseTrigger(trace?.trigger || '');
  if (trigger.kind !== 'scroll-through') {
    throw new Error(
      `linked comparison currently supports scroll-through DOM traces only (got ${JSON.stringify(trigger.spec)})`,
    );
  }
  if (!Number.isInteger(maxFrames) || maxFrames < 3) throw new Error('linked comparison maxFrames must be an integer >= 3');

  const raw = collapseScrollFrames(finiteScrollFrames(trace));
  if (raw.length < 3) {
    throw new Error('source trace has fewer than 3 distinct post-trigger scroll positions; retrace with scroll-through');
  }
  const firstY = raw[0].sourceScrollY;
  let previous = -Infinity;
  const withOffsets = raw.map((point) => {
    const offsetPx = +(point.sourceScrollY - firstY).toFixed(3);
    if (offsetPx + 0.5 < previous) {
      throw new Error('source scroll-through trace is not monotonic; linked comparison refuses an ambiguous schedule');
    }
    previous = Math.max(previous, offsetPx);
    return { ...point, offsetPx };
  });
  const distancePx = withOffsets.at(-1).offsetPx;
  if (!(distancePx >= 2)) throw new Error('source scroll-through trace has no usable pixel travel');

  const selected = downsample(withOffsets, maxFrames);
  const t0 = selected[0].sourceT;
  const schedule = selected.map((point, index) => ({
    index,
    offsetPx: point.offsetPx,
    sourceScrollY: point.sourceScrollY,
    sourceElapsedMs: +(point.sourceT - t0).toFixed(1),
  }));
  const deltas = [];
  for (let i = 1; i < withOffsets.length; i++) {
    const dt = withOffsets[i].sourceT - withOffsets[i - 1].sourceT;
    if (dt > 0 && dt < 2000) deltas.push(dt);
  }
  const observedFrameMs = median(deltas) ?? Math.max(16, Number(trigger.dwellMs) || 0);
  const frameMs = Math.round(Math.max(33, Math.min(250, observedFrameMs)));
  const payload = {
    schema: 'motion-kit/scroll-stimulus@1',
    trigger: trigger.spec,
    selector: trigger.selector,
    dwellMs: trigger.dwellMs,
    settleRafs: 2,
    frameMs,
    sourceStartY: firstY,
    sourceDistancePx: distancePx,
    originalPointCount: withOffsets.length,
    schedule,
  };
  return { ...payload, hash: sha256(JSON.stringify(payload)) };
}

export function validateViewport(viewport, dpr = 1) {
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
  const deviceScaleFactor = Number(dpr);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 200 || height < 200 || width > 4096 || height > 4096) {
    throw new Error(`invalid trace viewport ${JSON.stringify(viewport)} (expected integer width/height between 200 and 4096)`);
  }
  if (!(deviceScaleFactor > 0) || deviceScaleFactor > 4) throw new Error(`invalid trace DPR ${JSON.stringify(dpr)}`);
  return { viewport: { width, height }, deviceScaleFactor };
}
