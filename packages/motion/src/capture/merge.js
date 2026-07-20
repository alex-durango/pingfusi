import { groupKey } from './cdp-adapter.js';

// Identity key used to re-find a captured animation on a fresh page load. CDP ids and
// cssIds are session-scoped, so the key is semantic: type + name (animation name /
// transition property) + target path + duration.
export function identityKey(rec) {
  const name = rec.name || '';
  const path = rec.target?.path || '';
  const dur = rec.waapi?.timing?.duration ?? rec.cdp?.effect?.duration ?? '';
  return `${rec.type}:${name}:${path}:${dur}`;
}

function payloadSignature(rec) {
  return JSON.stringify(
    rec.waapi
      ? { k: rec.waapi.keyframes, t: rec.waapi.timing }
      : { k: rec.cdp.effect.keyframesRule, t: [rec.cdp.effect.duration, rec.cdp.effect.delay, rec.cdp.effect.easing] },
  );
}

// Merge the two capture sources into one record per animation.
// CDP contributes detection, timing, target node id, scroll-timeline offsets; the in-page
// serialization contributes keyframe values, timeline/range objects, and the target path.
// Where they overlap they must agree — disagreements are surfaced as warnings, not hidden.
//
// Real pages re-fire the same animation forever (carousels, typewriter loops): identical
// (identity, payload) pairs collapse into one record with a firedCount instead of flooding
// the capture. Genuinely different payloads sharing an identity get deterministic #n
// suffixes. Captures are capped at maxRecords — loudly, via crossCheck.truncated.
export function mergeRecords({ cdpAnimations, pageSnapshot, joinFailures = [], maxRecords = 60 }) {
  const raw = [];
  for (const cdp of cdpAnimations) {
    const waapi = pageSnapshot.byCdp[cdp.id] || null;
    const name =
      cdp.name || waapi?.animationName || waapi?.transitionProperty || waapi?.waapiId || '';
    const rec = {
      key: null,
      type: cdp.type,
      name,
      tier: cdp.type === 'WebAnimation' ? 2 : 1,
      resolved: !!waapi,
      firedCount: 1,
      group: groupKey(cdp),
      scrollDriven:
        !!cdp.viewOrScrollTimeline ||
        (waapi?.timeline && waapi.timeline.kind !== 'document' && waapi.timeline.kind !== 'null'),
      target: waapi?.target ? { ...waapi.target, pseudo: waapi.pseudo || null } : null,
      cdp,
      waapi,
    };
    rec.key = identityKey(rec);
    raw.push(rec);
  }

  const byKey = new Map();
  let records = [];
  for (const rec of raw) {
    const sig = payloadSignature(rec);
    const group = byKey.get(rec.key) || [];
    const existing = group.find((g) => g.sig === sig);
    if (existing) {
      existing.rec.firedCount++;
      // a later firing may have joined successfully where the first didn't
      if (!existing.rec.resolved && rec.resolved) {
        existing.rec.resolved = true;
        existing.rec.waapi = rec.waapi;
        existing.rec.target = rec.target;
      }
      continue;
    }
    group.push({ sig, rec });
    byKey.set(rec.key, group);
    records.push(rec);
  }
  for (const group of byKey.values()) {
    group.forEach((g, i) => {
      if (i > 0) g.rec.key += `#${i + 1}`;
    });
  }

  let truncated = null;
  if (records.length > maxRecords) {
    truncated = { kept: maxRecords, dropped: records.length - maxRecords };
    records = records.slice(0, maxRecords);
  }

  const warnings = [];
  for (const rec of records) {
    if (
      !rec.scrollDriven &&
      typeof rec.waapi?.timing?.duration === 'number' &&
      typeof rec.cdp.effect.duration === 'number' &&
      Math.abs(rec.waapi.timing.duration - rec.cdp.effect.duration) > 1
    ) {
      warnings.push({
        key: rec.key,
        field: 'duration',
        cdp: rec.cdp.effect.duration,
        waapi: rec.waapi.timing.duration,
      });
    }
  }

  const pageOnly = (pageSnapshot.extras || []).filter((e) => e.playState !== 'idle');
  return {
    records,
    crossCheck: {
      matched: records.filter((r) => r.resolved).length,
      cdpOnly: records.filter((r) => !r.resolved).map((r) => r.key),
      pageOnly: pageOnly.map((e) => ({
        ctor: e.ctor,
        name: e.animationName || e.transitionProperty || e.waapiId || null,
        target: e.target?.path ?? null,
      })),
      joinFailures,
      warnings,
      truncated,
    },
  };
}
