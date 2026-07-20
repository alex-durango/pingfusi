import { join } from 'node:path';
import { readJson, writeArtifact, slug } from '../lib/artifacts.js';
import { launchSession, VIEWPORT } from '../capture/session.js';
import { INIT_SOURCE } from '../capture/inject.js';
import { observe, collectRecords } from '../capture/capture.js';
import { parseTrigger } from '../capture/triggers.js';
import {
  decodePng,
  encodePng,
  cropPng,
  comparePng,
  unionRects,
  padClampRect,
} from '../lib/png.js';

// Scrub-and-screenshot replay gate. Rationale (docs/prior-art/puppeteer-capture.md):
// deterministic frame capture via beginFrame is unavailable on macOS, so instead of
// diffing video frames we pin BOTH sides at aligned animation-times and diff stills.
// Pass A freezes the page's own animations per fraction (CDP seekAnimations / scroll
// position) and screenshots. Pass B re-loads, replaces one animation with a replay built
// purely from the captured JSON, freezes everything else identically, and screenshots the
// same fractions. Any pixel delta inside the element's padded box is replay infidelity —
// the page around it is frozen identically in both passes.
const FRACTIONS = [0.002, 0.25, 0.5, 0.75, 0.998]; // epsilon-inset so boundary fill rules don't bite
const THRESHOLDS = { maxRatio: 0.02, maxWindowRatio: 0.35, pixelThreshold: 0.1 };
const PAD = 24;

function timeAt(rec, f) {
  const timing = rec.waapi?.timing || {};
  const delay = typeof timing.delay === 'number' ? timing.delay : (rec.cdp?.effect?.delay ?? 0);
  let dur =
    typeof timing.duration === 'number'
      ? timing.duration
      : typeof rec.cdp?.effect?.duration === 'number'
        ? rec.cdp.effect.duration
        : 0;
  if (!isFinite(dur)) dur = 0;
  return delay + f * dur; // compare within the first iteration
}

function scrollOffsetAt(rec, f) {
  const vst = rec.cdp?.viewOrScrollTimeline || {};
  const start = vst.startOffset ?? 0;
  const end = vst.endOffset ?? start;
  return start + f * (end - start);
}

function matchRecords(captured, fresh) {
  const freshByKey = new Map(fresh.map((r) => [r.key, r]));
  const matches = [];
  const misses = [];
  for (const rec of captured) {
    const f = freshByKey.get(rec.key);
    if (f) {
      matches.push({ captured: rec, fresh: f });
      freshByKey.delete(rec.key);
    } else {
      misses.push(rec.key);
    }
  }
  return { matches, misses };
}

function timeIds(matches, { excludeKey = null } = {}) {
  return matches
    .filter((m) => !m.captured.scrollDriven && m.captured.key !== excludeKey)
    .map((m) => m.fresh.cdp.id);
}

// One consistent global freeze per fraction: every matched animation pinned at its own
// t(f) (or scroll offset), so the only difference between passes is the replay under test.
async function seekAll(page, collector, matches, f, { replacedKey = null } = {}) {
  for (const m of matches) {
    if (m.captured.scrollDriven) {
      await page.evaluate(
        ({ path, axis, offset }) => window.__motionKit.seekScroll(path, axis, offset),
        {
          path: m.captured.waapi?.timeline?.source || null,
          axis: m.captured.cdp?.viewOrScrollTimeline?.axis || 'vertical',
          offset: scrollOffsetAt(m.captured, f),
        },
      );
    } else if (m.captured.key === replacedKey) {
      await page.evaluate(({ id, t }) => window.__motionKit.seekReplay(id, t), {
        id: m.fresh.cdp.id,
        t: timeAt(m.captured, f),
      });
    } else {
      await collector.seek([m.fresh.cdp.id], timeAt(m.captured, f));
    }
  }
  // two rAFs so the compositor commits the seeked state before the screenshot
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function shoot(page) {
  return decodePng(await page.screenshot({ animations: 'allow', caret: 'hide' }));
}

export async function runGate({ captureDir, headless = true }) {
  const summary = readJson(join(captureDir, 'capture.json'));
  const captured = summary.animations.map((a) => readJson(join(captureDir, a.artifact)));
  const results = captured.map((rec) => ({
    key: rec.key,
    name: rec.name,
    type: rec.type,
    tier: rec.tier,
    scrollDriven: rec.scrollDriven,
    fractions: [],
    pass: false,
    reason: null,
  }));

  const { browser, page, cdp } = await launchSession({ headless });
  try {
    await page.addInitScript({ content: INIT_SOURCE });

    // Pass A — originals: one run serves every record (full-viewport shots per fraction)
    let collector = await observe({ page, cdp, url: summary.url, trigger: summary.trigger });
    // replay the capture's own filtering semantics: on busy real pages the ambient load
    // animations can overflow the record cap and truncate away the animation under test
    const postTriggerOnly = !['load', 'scroll-sweep'].includes(parseTrigger(summary.trigger).kind);
    const freshA = (await collectRecords(page, collector, { postTriggerOnly })).records;
    const matchA = matchRecords(captured, freshA);
    await collector.pause(timeIds(matchA.matches), true);
    const shotsA = [];
    for (const f of FRACTIONS) {
      await seekAll(page, collector, matchA.matches, f);
      const png = await shoot(page);
      const bboxes = {};
      for (const m of matchA.matches) {
        bboxes[m.captured.key] = await page.evaluate(
          (id) => window.__motionKit.bboxOfCdp(id),
          m.fresh.cdp.id,
        );
      }
      shotsA.push({ png, bboxes });
    }
    await collector.release();
    collector.stop();

    // Pass B — one fresh load per record, replay under test swapped in
    for (const rec of captured) {
      const result = results.find((r) => r.key === rec.key);
      if (!matchA.matches.some((m) => m.captured.key === rec.key)) {
        result.reason = 'did not re-fire on gate run';
        continue;
      }
      if (!rec.resolved || !rec.waapi?.keyframes?.length) {
        result.reason = 'no verbatim payload (CDP↔page join failed)';
        continue;
      }
      collector = await observe({ page, cdp, url: summary.url, trigger: summary.trigger });
      const freshB = (await collectRecords(page, collector, { postTriggerOnly })).records;
      const matchB = matchRecords(captured, freshB);
      const mine = matchB.matches.find((m) => m.captured.key === rec.key);
      if (!mine) {
        result.reason = 'did not re-fire on replay run';
        await collector.release();
        collector.stop();
        continue;
      }
      const replaced = await page.evaluate(
        ({ id, spec }) => window.__motionKit.replaceWithReplay(id, spec),
        { id: mine.fresh.cdp.id, spec: rec.waapi },
      );
      if (!replaced.ok) {
        result.reason = `replay build failed: ${replaced.error}`;
        await collector.release();
        collector.stop();
        continue;
      }
      await collector.pause(timeIds(matchB.matches, { excludeKey: rec.key }), true);
      const shotsB = [];
      for (const f of FRACTIONS) {
        await seekAll(page, collector, matchB.matches, f, { replacedKey: rec.key });
        const png = await shoot(page);
        const bbox = await page.evaluate(
          (id) => window.__motionKit.bboxOfCdp(id),
          mine.fresh.cdp.id,
        );
        shotsB.push({ png, bbox });
      }
      await collector.release();
      collector.stop();

      const rects = [
        ...shotsA.map((s) => s.bboxes[rec.key]),
        ...shotsB.map((s) => s.bbox),
      ].filter(Boolean);
      const union = unionRects(rects);
      if (!union || union.width < 2 || union.height < 2) {
        result.reason = 'empty bounding box';
        continue;
      }
      const clip = padClampRect(union, PAD, VIEWPORT);
      const dirSlug = `gate/${String(captured.indexOf(rec)).padStart(2, '0')}-${slug(rec.name || rec.type)}`;
      let allPass = true;
      for (let i = 0; i < FRACTIONS.length; i++) {
        const a = cropPng(shotsA[i].png, clip);
        const b = cropPng(shotsB[i].png, clip);
        const cmp = comparePng(a, b, { threshold: THRESHOLDS.pixelThreshold });
        const framePass =
          cmp.ratio <= THRESHOLDS.maxRatio && cmp.windowRatio <= THRESHOLDS.maxWindowRatio;
        allPass &&= framePass;
        result.fractions.push({
          f: FRACTIONS[i],
          ratio: +cmp.ratio.toFixed(5),
          windowRatio: +cmp.windowRatio.toFixed(4),
          diffPixels: cmp.diffPixels,
          pass: framePass,
        });
        writeArtifact(captureDir, `${dirSlug}/f${i}-orig.png`, encodePng(a));
        writeArtifact(captureDir, `${dirSlug}/f${i}-replay.png`, encodePng(b));
        if (!framePass) writeArtifact(captureDir, `${dirSlug}/f${i}-diff.png`, encodePng(cmp.diff));
      }
      result.pass = allPass;
      if (!allPass && !result.reason) result.reason = 'pixel diff over threshold';
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const passed = results.filter((r) => r.pass).length;
  const out = {
    captureDir,
    url: summary.url,
    trigger: summary.trigger,
    thresholds: THRESHOLDS,
    fractions: FRACTIONS,
    records: results,
    summary: { total: results.length, passed },
    ok: results.length > 0 && passed === results.length,
  };
  writeArtifact(captureDir, 'gate.json', out);
  return out;
}
