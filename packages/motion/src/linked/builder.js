import { randomInt } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchSession, settle, VIEWPORT } from '../capture/session.js';
import { readJson, sha256, sha256OfFile, slug, writeArtifact } from '../lib/artifacts.js';
import { buildScrollStimulus, scopeSelector, validateViewport } from './stimulus.js';

const PUBLIC_FILE_LIMIT = 300;
const PUBLIC_TOTAL_LIMIT = 100 * 1024 * 1024;
const PUBLIC_SINGLE_LIMIT = 25 * 1024 * 1024;
const PRIVATE_FILES = new Set(['loop-state.json', 'loop-log.jsonl', 'receipts.jsonl']);
const PLAYER_FILE = fileURLToPath(new URL('../../player/linked.html', import.meta.url));

function assertHttpUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label} must use http or https`);
  return url.href;
}

function changedRange(element) {
  const samples = Array.isArray(element?.samples) ? element.samples : [];
  for (const channel of ['tx', 'ty', 'tz', 'sx', 'sy', 'rot', 'opacity']) {
    const values = samples.map((sample) => sample?.[channel]).filter(Number.isFinite);
    if (values.length < 3) continue;
    const range = Math.max(...values) - Math.min(...values);
    const threshold = channel === 'opacity' || channel === 'sx' || channel === 'sy' ? 0.002 : 0.2;
    if (range >= threshold) return true;
  }
  return false;
}

export function motionSelectors(traceDir, trace) {
  const fitPath = join(traceDir, 'fits.json');
  let selectors = [];
  if (existsSync(fitPath)) {
    const fits = readJson(fitPath);
    selectors = (Array.isArray(fits.fits) ? fits.fits : [])
      .filter((fit) => fit?.fit?.kind === 'scroll-linear' && typeof fit.path === 'string')
      .map((fit) => fit.path);
  }
  if (!selectors.length) {
    selectors = (Array.isArray(trace.elements) ? trace.elements : [])
      .filter(changedRange)
      .map((element) => element.path)
      .filter((path) => typeof path === 'string');
  }
  selectors = [...new Set(selectors)];
  if (!selectors.length) {
    throw new Error('source trace identifies no moving DOM target; retrace the requested scroll effect with --scope');
  }
  return selectors;
}

async function configureBlockedRequests(page, blocked) {
  if (!blocked.length) return;
  await page.route(
    (url) => blocked.some((needle) => url.href.includes(needle)),
    (route) => route.abort(),
  );
}

async function inspectPage(page, { sectionSelector, scope, selectors, label, requireMotionTargets = false }) {
  const result = await page.evaluate(
    ({ sectionSelector: section, scopeSelector: scopeSel, motionSelectors: paths }) => {
      const trigger = document.querySelector(section);
      const scoped = document.querySelector(scopeSel);
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
      const triggerRect = trigger?.getBoundingClientRect() ?? null;
      const scopeRect = scoped?.getBoundingClientRect() ?? null;
      const matches = paths.map((selector) => ({ selector, count: document.querySelectorAll(selector).length }));
      return {
        triggerFound: !!trigger,
        scopeFound: !!scoped,
        sectionStartY: triggerRect ? Math.max(0, Math.min(maxScroll, scrollY + triggerRect.top)) : null,
        maxScroll,
        scopeRect: scopeRect
          ? { x: scopeRect.x, y: scopeRect.y, width: scopeRect.width, height: scopeRect.height }
          : null,
        matches,
      };
    },
    { sectionSelector, scopeSelector: scope, motionSelectors: selectors },
  );
  if (!result.triggerFound) throw new Error(`${label} page is missing scroll trigger section ${JSON.stringify(sectionSelector)}`);
  if (!result.scopeFound) throw new Error(`${label} page is missing motion scope ${JSON.stringify(scope)}`);
  if (requireMotionTargets && !result.matches.some((match) => match.count > 0)) {
    throw new Error(`${label} page is missing every traced motion target (${selectors.join(', ')})`);
  }
  return result;
}

async function readScopeRect(page, selector) {
  return page.evaluate((scope) => {
    const element = document.querySelector(scope);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, selector);
}

async function setScroll(page, top, dwellMs) {
  return page.evaluate(
    async ({ targetY, dwell }) => {
      const raf = () => new Promise((done) => requestAnimationFrame(done));
      scrollTo({ top: targetY, behavior: 'instant' });
      await raf();
      await raf();
      if (dwell > 0) await new Promise((done) => setTimeout(done, dwell));
    },
    { targetY: top, dwell: dwellMs },
  );
}

async function fingerprint(page, selectors) {
  return page.evaluate((paths) => {
    const values = [];
    for (const selector of paths) {
      // A repeated selector is still deterministic. Cap it so a broad generated CSS
      // path cannot turn a preflight read into a whole-document serialization.
      for (const element of [...document.querySelectorAll(selector)].slice(0, 20)) {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        values.push({
          selector,
          transform: style.transform,
          opacity: style.opacity,
          width: style.width,
          height: style.height,
          clipPath: style.clipPath,
          filter: style.filter,
          borderRadius: style.borderRadius,
          backgroundColor: style.backgroundColor,
          rectWidth: +rect.width.toFixed(2),
          rectHeight: +rect.height.toFixed(2),
        });
      }
    }
    return values;
  }, selectors);
}

async function fingerprintScope(page, selector) {
  return page.evaluate((scope) => {
    const root = document.querySelector(scope);
    if (!root) return [];
    const values = [];
    // The declared scope is the cross-repo contract; internal clone markup is not.
    // Read the bounded subtree so a changed circle/canvas wrapper is still live even
    // when none of the source page's generated CSS paths exist in the clone.
    for (const element of [root, ...root.querySelectorAll('*')].slice(0, 250)) {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      values.push({
        tag: element.tagName,
        transform: style.transform,
        opacity: style.opacity,
        width: style.width,
        height: style.height,
        clipPath: style.clipPath,
        filter: style.filter,
        borderRadius: style.borderRadius,
        backgroundColor: style.backgroundColor,
        rectWidth: +rect.width.toFixed(2),
        rectHeight: +rect.height.toFixed(2),
      });
    }
    return values;
  }, selector);
}

export function sourceClip(rects, viewport) {
  const usable = rects.filter(
    (rect) => rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite),
  );
  if (!usable.length) throw new Error('source motion scope could not be measured across the scroll schedule');
  const x1 = Math.min(...usable.map((rect) => rect.x));
  const y1 = Math.min(...usable.map((rect) => rect.y));
  const x2 = Math.max(...usable.map((rect) => rect.x + rect.width));
  const y2 = Math.max(...usable.map((rect) => rect.y + rect.height));
  const pad = 8;
  const x = Math.max(0, Math.floor(x1 - pad));
  const y = Math.max(0, Math.floor(y1 - pad));
  const right = Math.min(viewport.width, Math.ceil(x2 + pad));
  const bottom = Math.min(viewport.height, Math.ceil(y2 + pad));
  if (right - x < 24 || bottom - y < 24) {
    throw new Error('source motion scope has no usable viewport intersection at the section start');
  }
  return { x, y, width: right - x, height: bottom - y };
}

function listFiles(root, at = root) {
  const out = [];
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    const path = join(at, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(root, path));
    else if (entry.isFile()) out.push({ path, rel: relative(root, path) });
  }
  return out;
}

export function validatePublicBundle(dir) {
  const files = listFiles(dir).filter((file) => !PRIVATE_FILES.has(basename(file.rel)));
  if (files.length > PUBLIC_FILE_LIMIT) {
    throw new Error(`linked bundle has ${files.length} public files; limit is ${PUBLIC_FILE_LIMIT}`);
  }
  let totalBytes = 0;
  for (const file of files) {
    const bytes = statSync(file.path).size;
    if (bytes > PUBLIC_SINGLE_LIMIT) {
      throw new Error(`linked bundle file ${file.rel} is ${(bytes / 1024 / 1024).toFixed(1)} MB; per-file limit is 25 MB`);
    }
    totalBytes += bytes;
  }
  if (totalBytes > PUBLIC_TOTAL_LIMIT) {
    throw new Error(`linked bundle is ${(totalBytes / 1024 / 1024).toFixed(1)} MB; public limit is 100 MB`);
  }
  return { fileCount: files.length, totalBytes };
}

function publicManifest(dir) {
  return listFiles(dir)
    .filter((file) => !PRIVATE_FILES.has(basename(file.rel)))
    .sort((a, b) => a.rel.localeCompare(b.rel))
    .map((file) => ({ file: file.rel, bytes: statSync(file.path).size, sha256: sha256OfFile(file.path) }));
}

function installBundle(tempDir, finalDir) {
  mkdirSync(resolve(finalDir, '..'), { recursive: true });
  rmSync(finalDir, { recursive: true, force: true });
  renameSync(tempDir, finalDir);
}

export async function buildLinkedComparison({
  traceDir,
  candidateUrl,
  out,
  headless = true,
  seed = null,
  maxFrames,
  candidateScope = null,
  candidateSelector = null,
} = {}) {
  if (!traceDir) throw new Error('linked comparison needs traceDir');
  if (!candidateUrl) throw new Error('linked comparison needs candidateUrl');
  const resolvedTraceDir = resolve(traceDir);
  const tracePath = join(resolvedTraceDir, 'trace.json');
  if (!existsSync(tracePath)) throw new Error(`trace.json missing from ${resolvedTraceDir}`);
  const trace = readJson(tracePath);
  const sourceUrl = assertHttpUrl(trace.url, 'trace source URL');
  const resolvedCandidateUrl = assertHttpUrl(candidateUrl, 'candidate URL');
  const stimulus = buildScrollStimulus(trace, maxFrames == null ? {} : { maxFrames });
  const scope = scopeSelector(trace.scope, stimulus.selector);
  if (!scope) throw new Error('source trace has no usable scope selector');
  const resolvedCandidateScope = scopeSelector(candidateScope, scope);
  // The source trace remains authoritative for every captured pixel offset. A clone
  // may use different section markup, though, so only its local section-start anchor
  // is replaceable. This must never become a candidate-specific 0..1 normalization.
  const resolvedCandidateSelector = scopeSelector(candidateSelector, stimulus.selector);
  const selectors = motionSelectors(resolvedTraceDir, trace);
  const { viewport, deviceScaleFactor } = validateViewport(
    trace.viewport ?? VIEWPORT,
    trace.deviceScaleFactor ?? trace.dpr ?? 1,
  );
  const finalDir = resolve(out || join(resolvedTraceDir, `linked-${slug(new URL(resolvedCandidateUrl).hostname)}`));
  if (finalDir === resolvedTraceDir) throw new Error('linked comparison output cannot overwrite its trace directory');
  const tempDir = `${finalDir}.building-${process.pid}-${Date.now()}`;
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });

  const sideSeed = seed == null ? randomInt(0, 0x7fffffff) : Number(seed);
  if (!Number.isInteger(sideSeed) || sideSeed < 0) throw new Error('linked comparison seed must be a non-negative integer');
  const swap = sideSeed % 2 === 1;
  const sideMapping = swap
    ? { LEFT: 'candidate', RIGHT: 'source' }
    : { LEFT: 'source', RIGHT: 'candidate' };
  const assets = { LEFT: [], RIGHT: [] };
  const sourceFingerprints = new Set();
  const candidateFingerprints = new Set();
  const sourceFrameHashes = [];
  const candidateFrameHashes = [];
  let sourceSession;
  let candidateSession;
  try {
    [sourceSession, candidateSession] = await Promise.all([
      launchSession({ headless, viewport, deviceScaleFactor }),
      launchSession({ headless, viewport, deviceScaleFactor }),
    ]);
    const blocked = (Array.isArray(trace.blocked) ? trace.blocked : []).filter((item) => typeof item === 'string' && item);
    await Promise.all([
      configureBlockedRequests(sourceSession.page, blocked),
      configureBlockedRequests(candidateSession.page, blocked),
    ]);
    await Promise.all([
      sourceSession.page.goto(sourceUrl, { waitUntil: 'domcontentloaded' }),
      candidateSession.page.goto(resolvedCandidateUrl, { waitUntil: 'domcontentloaded' }),
    ]);
    await Promise.all([settle(sourceSession.page), settle(candidateSession.page)]);

    let [sourceInfo, candidateInfo] = await Promise.all([
      inspectPage(sourceSession.page, {
        sectionSelector: stimulus.selector,
        scope,
        selectors,
        label: 'source',
        requireMotionTargets: true,
      }),
      inspectPage(candidateSession.page, {
        sectionSelector: resolvedCandidateSelector,
        scope: resolvedCandidateScope,
        selectors,
        label: 'candidate',
      }),
    ]);
    await Promise.all([
      setScroll(sourceSession.page, sourceInfo.sectionStartY, stimulus.dwellMs),
      setScroll(candidateSession.page, candidateInfo.sectionStartY, stimulus.dwellMs),
    ]);
    [sourceInfo, candidateInfo] = await Promise.all([
      inspectPage(sourceSession.page, {
        sectionSelector: stimulus.selector,
        scope,
        selectors,
        label: 'source',
        requireMotionTargets: true,
      }),
      inspectPage(candidateSession.page, {
        sectionSelector: resolvedCandidateSelector,
        scope: resolvedCandidateScope,
        selectors,
        label: 'candidate',
      }),
    ]);
    const prepassDocumentTimeOrigin = await sourceSession.page.evaluate(() => performance.timeOrigin);
    // Crop measurement is a prepass, not a first-frame guess. Scale-from-zero effects
    // have a near-empty initial rect; unioning every source rect preserves their final
    // grown bounds. Reset both pages afterwards so the evidence pass begins at frame 0.
    const sourceScopeRects = [];
    for (const frame of stimulus.schedule) {
      await setScroll(sourceSession.page, sourceInfo.sectionStartY + frame.offsetPx, stimulus.dwellMs);
      sourceScopeRects.push(await readScopeRect(sourceSession.page, scope));
    }
    const clip = sourceClip(sourceScopeRects, viewport);
    // A scroll reset is not a state reset: smoothed/hysteretic renderers retain velocity
    // and easing state from the prepass endpoint. Replace both documents, settle again,
    // and recompute their independent section starts before collecting evidence.
    await Promise.all([
      sourceSession.page.goto('about:blank'),
      candidateSession.page.goto('about:blank'),
    ]);
    await Promise.all([
      sourceSession.page.goto(sourceUrl, { waitUntil: 'domcontentloaded' }),
      candidateSession.page.goto(resolvedCandidateUrl, { waitUntil: 'domcontentloaded' }),
    ]);
    await Promise.all([settle(sourceSession.page), settle(candidateSession.page)]);
    [sourceInfo, candidateInfo] = await Promise.all([
      inspectPage(sourceSession.page, {
        sectionSelector: stimulus.selector,
        scope,
        selectors,
        label: 'source',
        requireMotionTargets: true,
      }),
      inspectPage(candidateSession.page, {
        sectionSelector: resolvedCandidateSelector,
        scope: resolvedCandidateScope,
        selectors,
        label: 'candidate',
      }),
    ]);
    const evidenceDocumentTimeOrigin = await sourceSession.page.evaluate(() => performance.timeOrigin);
    if (evidenceDocumentTimeOrigin === prepassDocumentTimeOrigin) {
      throw new Error('linked comparison could not prove a clean document replay after crop measurement');
    }
    await Promise.all([
      setScroll(sourceSession.page, sourceInfo.sectionStartY, stimulus.dwellMs),
      setScroll(candidateSession.page, candidateInfo.sectionStartY, stimulus.dwellMs),
    ]);

    for (const frame of stimulus.schedule) {
      await Promise.all([
        setScroll(sourceSession.page, sourceInfo.sectionStartY + frame.offsetPx, stimulus.dwellMs),
        setScroll(candidateSession.page, candidateInfo.sectionStartY + frame.offsetPx, stimulus.dwellMs),
      ]);
      const [sourceImage, candidateImage, sourcePrint, candidatePrint] = await Promise.all([
        sourceSession.page.screenshot({ type: 'jpeg', quality: 82, clip }),
        candidateSession.page.screenshot({ type: 'jpeg', quality: 82, clip }),
        fingerprint(sourceSession.page, selectors),
        fingerprintScope(candidateSession.page, resolvedCandidateScope),
      ]);
      const sourceHash = sha256(sourceImage);
      const candidateHash = sha256(candidateImage);
      sourceFrameHashes.push(sourceHash);
      candidateFrameHashes.push(candidateHash);
      sourceFingerprints.add(sha256(JSON.stringify(sourcePrint)));
      candidateFingerprints.add(sha256(JSON.stringify(candidatePrint)));

      const number = String(frame.index).padStart(4, '0');
      const leftRole = sideMapping.LEFT;
      const leftImage = leftRole === 'source' ? sourceImage : candidateImage;
      const rightImage = leftRole === 'source' ? candidateImage : sourceImage;
      const leftRel = `frames/a/${number}.jpg`;
      const rightRel = `frames/b/${number}.jpg`;
      writeArtifact(tempDir, leftRel, leftImage);
      writeArtifact(tempDir, rightRel, rightImage);
      assets.LEFT.push(leftRel);
      assets.RIGHT.push(rightRel);
    }

    if (sourceFingerprints.size < 2) {
      throw new Error('source motion target stayed static under the captured scroll schedule; the trace or live source drifted');
    }
    if (candidateFingerprints.size < 2) {
      throw new Error('candidate motion target stayed static under the captured scroll schedule; integrate the linked effect before review');
    }
    if (new Set(sourceFrameHashes).size < 2) {
      throw new Error('source rendered frames stayed static under the captured scroll schedule; review evidence was not created');
    }
    if (new Set(candidateFrameHashes).size < 2) {
      throw new Error('candidate rendered frames stayed static in the source crop; the linked effect may be hidden or off-crop');
    }

    const player = readFileSync(PLAYER_FILE);
    writeArtifact(tempDir, 'player.html', player);
    writeArtifact(tempDir, 'index.html', player);
    const reviewTask = {
      schema: 'motion-kit/linked-task@1',
      question_type: '2afc',
      round: 1,
      assets: [...assets.LEFT, ...assets.RIGHT],
      response: {
        '2afc': "one of: LEFT | RIGHT | can't tell",
        diagnosis: 'one linked-motion vocabulary tag, optionally frame-anchored',
      },
      player: 'player.html?mode=2afc',
      diagnosePlayer: 'player.html?mode=diagnose',
      adjustPlayer: 'player.html?mode=diagnose',
      vocabulary: [
        'timing/progress differs',
        'starts at wrong scroll point',
        'finishes at wrong scroll point',
        'wrong trajectory/direction',
        'wrong distance/scale',
        'jumps/flickers',
        'rendering artifact',
        'other',
      ],
      linked: {
        schema: 'motion-kit/linked-frames@1',
        frameMs: stimulus.frameMs,
        frameCount: stimulus.schedule.length,
        sides: assets,
        viewport: { ...viewport, deviceScaleFactor },
        clip,
        stimulus: {
          kind: 'scroll-through',
          distancePx: stimulus.sourceDistancePx,
          scheduleHash: stimulus.hash,
        },
      },
      effort: { '2afc': '~30s', diagnosis: '~30s' },
      stopCriteria:
        "wrong target pick or can't tell means perceptually converged; a correct target pick requires linked-motion diagnosis and fresh evidence",
    };
    writeArtifact(tempDir, 'review-task.json', reviewTask);

    const preflight = {
      sourceTargetStates: sourceFingerprints.size,
      candidateTargetStates: candidateFingerprints.size,
      sourceRenderedStates: new Set(sourceFrameHashes).size,
      candidateRenderedStates: new Set(candidateFrameHashes).size,
      sourceSectionStartY: +sourceInfo.sectionStartY.toFixed(3),
      candidateSectionStartY: +candidateInfo.sectionStartY.toFixed(3),
      clip,
      reinitializedAfterClip: true,
      prepassDocumentTimeOrigin,
      evidenceDocumentTimeOrigin,
    };
    const state = {
      schema: 'motion-kit/linked-state@1',
      round: 1,
      createdAt: new Date().toISOString(),
      traceDir: resolvedTraceDir,
      traceSha256: sha256OfFile(tracePath),
      sourceUrl,
      candidateUrl: resolvedCandidateUrl,
      sourceUrlSha256: sha256(sourceUrl),
      candidateUrlSha256: sha256(resolvedCandidateUrl),
      sideSeed,
      sideMapping,
      viewport: { ...viewport, deviceScaleFactor },
      scope,
      candidateScope: resolvedCandidateScope,
      candidateSelector: resolvedCandidateSelector,
      motionSelectors: selectors,
      stimulus,
      preflight,
      frameHashes: {
        source: sourceFrameHashes,
        candidate: candidateFrameHashes,
      },
    };
    writeArtifact(tempDir, 'loop-state.json', state);
    const limits = validatePublicBundle(tempDir);
    state.publicBundle = {
      ...limits,
      manifestSha256: sha256(JSON.stringify(publicManifest(tempDir))),
    };
    writeArtifact(tempDir, 'loop-state.json', state);
    installBundle(tempDir, finalDir);
    return {
      dir: finalDir,
      frameCount: stimulus.schedule.length,
      scheduleHash: stimulus.hash,
      task: reviewTask,
      preflight,
      limits,
    };
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  } finally {
    await Promise.all([
      sourceSession?.browser.close().catch(() => {}),
      candidateSession?.browser.close().catch(() => {}),
    ]);
  }
}
