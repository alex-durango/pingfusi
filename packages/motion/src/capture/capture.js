import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launchSession, settle, VIEWPORT } from './session.js';
import { AnimationCollector } from './cdp-adapter.js';
import { INIT_SOURCE } from './inject.js';
import { parseTrigger, runTrigger } from './triggers.js';
import { mergeRecords } from './merge.js';
import { keyframesRulesViaCdp } from './css-rules.js';
import { writeArtifact, slug } from '../lib/artifacts.js';
import { remuxSeekable } from '../lib/video.js';

// Navigate, settle post-hydration, arm collection, fire the trigger, wait for the
// animation burst to go quiet. The collector is armed BEFORE navigation so load-triggered
// animations are seen. Returns the live collector (caller releases/stops it).
export async function observe({ page, cdp, url, trigger, observeMs = 3000 }) {
  const t = typeof trigger === 'string' ? parseTrigger(trigger) : trigger;
  const collector = new AnimationCollector(cdp);
  await collector.start();
  // pointer position persists across navigations: if a prior pass left the mouse parked
  // on the trigger target, the fresh document computes its initial style WITH :hover and
  // the re-hover produces no transition at all — park the pointer at the origin first
  await page.mouse.move(0, 0);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await settle(page);
  collector.lastEventAt = Date.now(); // measure quiet from the trigger, not from load
  collector.triggerAt = Date.now();
  await runTrigger(page, t);
  await collector.waitQuiet({ quietMs: 700, maxMs: observeMs });
  return collector;
}

// postTriggerOnly: an interaction capture (hover/click/…) is about what the interaction
// caused — filter out the page's ambient load animations still re-firing underneath.
export async function collectRecords(page, collector, { postTriggerOnly = false } = {}) {
  await collector.joinsSettled();
  const pageSnapshot = await page.evaluate(() => window.__motionKit.snapshot());
  let cdpAnimations = collector.normalized();
  if (postTriggerOnly && collector.triggerAt) {
    cdpAnimations = cdpAnimations.filter(
      (a) => a.arrivedAt == null || a.arrivedAt >= collector.triggerAt,
    );
  }
  return {
    ...mergeRecords({ cdpAnimations, pageSnapshot, joinFailures: collector.joinFailures }),
    pageSnapshot,
  };
}

function defaultDir(url, trigger) {
  const u = new URL(url);
  return join('captures', slug(`${u.hostname}${u.pathname.replace(/\//g, '-')}-${trigger}`));
}

export async function capture({ url, trigger = 'load', out, observeMs = 3000, headless = true, all = false }) {
  const parsed = parseTrigger(trigger); // validate before paying for a browser
  const postTriggerOnly = !all && parsed.kind !== 'load' && parsed.kind !== 'scroll-sweep';
  const dir = out || defaultDir(url, trigger);
  mkdirSync(dir, { recursive: true });
  const videoTmp = join(dir, '.video-tmp');
  const { browser, context, page, cdp } = await launchSession({ headless, videoDir: videoTmp });
  try {
    await page.addInitScript({ content: INIT_SOURCE });
    const collector = await observe({ page, cdp, url, trigger: parsed, observeMs });
    // let in-flight motion finish so the reference video shows the full animation
    await page.waitForTimeout(Math.min(1500, observeMs));
    const { records, crossCheck } = await collectRecords(page, collector, { postTriggerOnly });
    for (const rec of records) {
      if (rec.type === 'CSSAnimation' && rec.name) {
        rec.cssRuleText = await page.evaluate(
          (name) => window.__motionKit.keyframesRuleText(name),
          rec.name,
        );
        rec.cssRuleSource = rec.cssRuleText ? 'cssom' : null;
      }
    }
    // cross-origin sheets are invisible to the CSSOM walk — pull the rest via CDP
    const missing = [...new Set(
      records.filter((r) => r.type === 'CSSAnimation' && r.name && !r.cssRuleText).map((r) => r.name),
    )];
    if (missing.length) {
      const found = await keyframesRulesViaCdp(cdp, missing);
      for (const rec of records) {
        if (!rec.cssRuleText && found[rec.name]) {
          rec.cssRuleText = found[rec.name];
          rec.cssRuleSource = 'cdp';
        }
      }
    }
    await collector.release();
    collector.stop();

    // reference video is sacred: recorded on every capture, ground truth for all future
    // reviewer comparisons. It only finalizes when the context closes.
    const video = page.video();
    await context.close();
    let referenceVideo = null;
    let referenceVideoSeekable = false;
    if (video) {
      try {
        await video.saveAs(join(dir, 'reference.webm'));
        referenceVideo = 'reference.webm';
        referenceVideoSeekable = await remuxSeekable(join(dir, 'reference.webm'));
      } catch {
        referenceVideo = null;
      }
    }
    rmSync(videoTmp, { recursive: true, force: true });

    const summary = {
      url,
      trigger: parsed.spec,
      viewport: VIEWPORT,
      capturedAt: new Date().toISOString(),
      engine: 'chromium',
      referenceVideo,
      referenceVideoSeekable,
      crossCheck,
      animations: records.map((r, i) => ({
        index: i,
        key: r.key,
        type: r.type,
        name: r.name,
        tier: r.tier,
        group: r.group,
        target: r.target?.path ?? null,
        resolved: r.resolved,
        scrollDriven: r.scrollDriven,
        artifact: `animations/${String(i).padStart(2, '0')}-${slug(r.name || r.type)}.json`,
      })),
    };
    for (let i = 0; i < records.length; i++) {
      writeArtifact(dir, summary.animations[i].artifact, records[i]);
    }
    writeArtifact(dir, 'capture.json', summary);
    return { dir, records, crossCheck };
  } finally {
    await browser.close().catch(() => {});
  }
}
