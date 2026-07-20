import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLinkedComparison } from '../src/linked/builder.js';
import { buildScrollStimulus, scopeSelector, validateViewport } from '../src/linked/stimulus.js';
import { startFixtureServer } from '../fixtures/serve.js';
import { serveDir } from '../src/loop/serve.js';
import { launchSession } from '../src/capture/session.js';

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok   linked: ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL linked: ${name}\n  ${error.stack || error.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`ok   linked: ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL linked: ${name}\n  ${error.stack || error.message}`);
  }
}

async function holdPlayerFrame(page, side, index) {
  const frame = String(index).padStart(4, '0');
  let release;
  let markRequested;
  let markDelivered;
  const gate = new Promise((resolve) => { release = resolve; });
  const requested = new Promise((resolve) => { markRequested = resolve; });
  const delivered = new Promise((resolve) => { markDelivered = resolve; });
  await page.route(`**/frames/${side}/${frame}.jpg`, async (route) => {
    markRequested();
    await gate;
    const response = await route.fetch();
    await route.fulfill({ response });
    markDelivered();
  });
  return { delivered, release, requested };
}

async function waitForPaints(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

function traceShape(overrides = {}) {
  const frames = Array.from({ length: 7 }, (_, index) => ({
    t: 100 + index * 34,
    scrollY: index * 120,
  }));
  return {
    url: 'https://example.test/source',
    trigger: 'scroll-through:#stage/6/0',
    triggerAt: 100,
    viewport: { width: 640, height: 360 },
    scope: { selector: '#stage', matchedAtStart: 1 },
    frames,
    elements: [
      {
        path: '#circle',
        samples: frames.map((frame, index) => ({
          t: frame.t,
          tx: 0,
          ty: 0,
          tz: 0,
          sx: index / 6,
          sy: index / 6,
          rot: 0,
          opacity: 0.1 + index * 0.15,
        })),
      },
    ],
    ...overrides,
  };
}

test('scope accepts legacy string and structured trace shapes', () => {
  assert.equal(scopeSelector('#stage'), '#stage');
  assert.equal(scopeSelector({ selector: '#stage' }), '#stage');
  assert.equal(scopeSelector(null, '#fallback'), '#fallback');
});

test('scroll stimulus preserves captured pixel offsets and stable timing', () => {
  const stimulus = buildScrollStimulus(traceShape());
  assert.deepEqual(stimulus.schedule.map((frame) => frame.offsetPx), [0, 120, 240, 360, 480, 600, 720]);
  assert.equal(stimulus.sourceDistancePx, 720);
  assert.equal(stimulus.frameMs, 34);
  assert.equal(stimulus.dwellMs, 0);
  assert.match(stimulus.hash, /^[a-f0-9]{64}$/);
});

test('scroll stimulus downsamples only to captured positions and retains endpoints', () => {
  const frames = Array.from({ length: 201 }, (_, index) => ({ t: index * 17, scrollY: index * 5 }));
  const stimulus = buildScrollStimulus(traceShape({ frames, triggerAt: 0 }), { maxFrames: 11 });
  assert.equal(stimulus.schedule.length, 11);
  assert.equal(stimulus.schedule[0].offsetPx, 0);
  assert.equal(stimulus.schedule.at(-1).offsetPx, 1000);
  assert.ok(stimulus.schedule.every((frame) => frame.offsetPx % 5 === 0));
});

test('unsupported, ambiguous, and undersampled traces fail closed', () => {
  assert.throws(() => buildScrollStimulus(traceShape({ trigger: 'pointer:0,0->10,10/200' })), /scroll-through DOM traces only/);
  assert.throws(
    () => buildScrollStimulus(traceShape({ frames: [{ t: 100, scrollY: 0 }, { t: 134, scrollY: 120 }, { t: 168, scrollY: 30 }] })),
    /not monotonic/,
  );
  assert.throws(() => buildScrollStimulus(traceShape({ frames: [{ t: 100, scrollY: 0 }] })), /fewer than 3/);
});

test('trace viewport and DPR validation is explicit', () => {
  assert.deepEqual(validateViewport({ width: 1512, height: 982 }, 2), {
    viewport: { width: 1512, height: 982 },
    deviceScaleFactor: 2,
  });
  assert.throws(() => validateViewport({ width: 0, height: 720 }, 1), /invalid trace viewport/);
  assert.throws(() => validateViewport({ width: 1280, height: 720 }, 0), /invalid trace DPR/);
});

await asyncTest('moving-but-wrong candidate builds a blinded synchronized player', async () => {
  const base = mkdtempSync(join(tmpdir(), 'motion-linked-selftest-'));
  const traceDir = join(base, 'trace');
  const out = join(base, 'bundle');
  mkdirSync(traceDir, { recursive: true });
  const fixture = await startFixtureServer();
  const sourceUrl = `http://127.0.0.1:${fixture.port}/linked/scroll-circle.html?mode=source-section`;
  const candidateUrl = `http://127.0.0.1:${fixture.port}/linked/scroll-circle.html?mode=wrong-alt-section`;
  // The traced scope starts at scale(0). The candidate deliberately uses different
  // internal markup and declares its own stable cross-repo scope.
  await writeFile(
    join(traceDir, 'trace.json'),
    JSON.stringify(traceShape({ url: sourceUrl, trigger: 'scroll-through:#source-stage/6/0', scope: '#circle' })),
  );
  await writeFile(
    join(traceDir, 'fits.json'),
    JSON.stringify({ fits: [{ path: '#circle', channel: 'sx', fit: { kind: 'scroll-linear' } }] }),
  );

  let bundleServer;
  let playerSession;
  try {
    const built = await buildLinkedComparison({
      traceDir,
      candidateUrl,
      candidateScope: '#candidate-stage',
      candidateSelector: '#candidate-stage',
      out,
      seed: 1,
    });
    assert.equal(built.frameCount, 7);
    assert.equal(built.preflight.sourceTargetStates, 7);
    assert.equal(built.preflight.candidateTargetStates, 7);
    assert.equal(built.preflight.reinitializedAfterClip, true);
    assert.notEqual(built.preflight.prepassDocumentTimeOrigin, built.preflight.evidenceDocumentTimeOrigin);
    assert.ok(built.limits.totalBytes < 100 * 1024 * 1024);
    assert.ok(built.limits.fileCount <= 300);
    assert.ok(built.task.linked.clip.width >= 180, `clip width ${built.task.linked.clip.width} omitted final scale`);
    assert.ok(built.task.linked.clip.height >= 180, `clip height ${built.task.linked.clip.height} omitted final scale`);
    assert.ok(existsSync(join(out, 'frames/a/0006.jpg')));
    assert.ok(existsSync(join(out, 'frames/b/0006.jpg')));

    const taskText = readFileSync(join(out, 'review-task.json'), 'utf8');
    const task = JSON.parse(taskText);
    assert.equal(task.schema, 'motion-kit/linked-task@1');
    assert.equal(task.linked.viewport.width, 640);
    assert.equal(task.linked.viewport.height, 360);
    assert.ok(!taskText.includes(sourceUrl));
    assert.ok(!taskText.includes(candidateUrl));
    assert.ok(!taskText.includes('#source-stage'));
    assert.ok(!taskText.includes('#candidate-stage'));
    assert.ok(!taskText.includes('source/'));
    assert.ok(!taskText.includes('candidate/'));
    const state = JSON.parse(readFileSync(join(out, 'loop-state.json'), 'utf8'));
    assert.deepEqual(state.sideMapping, { LEFT: 'candidate', RIGHT: 'source' });
    assert.equal(state.scope, '#circle');
    assert.equal(state.candidateScope, '#candidate-stage');
    assert.equal(state.stimulus.selector, '#source-stage');
    assert.equal(state.candidateSelector, '#candidate-stage');
    assert.equal(state.frameHashes.source.length, 7);
    assert.equal(state.frameHashes.candidate.length, 7);
    assert.equal(task.linked.diagnosisSides, undefined);

    bundleServer = await serveDir(out);
    playerSession = await launchSession({ viewport: { width: 900, height: 700 } });
    await playerSession.page.goto(`http://127.0.0.1:${bundleServer.port}/player.html?mode=2afc`);
    await playerSession.page.waitForFunction(() => document.body.dataset.frame === '0');
    await playerSession.page.click('#play');
    await playerSession.page.waitForFunction(() => !document.body.dataset.loadingFrame);
    await playerSession.page.locator('#scrub').evaluate((element) => {
      element.value = '0';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await playerSession.page.waitForFunction(() => document.body.dataset.frame === '0');

    // Scrubbing holds the displayed pair until both decoded resources are ready,
    // even when the right side completes first.
    const scrubLeft = await holdPlayerFrame(playerSession.page, 'a', 4);
    const scrubRight = await holdPlayerFrame(playerSession.page, 'b', 4);
    await playerSession.page.locator('#scrub').evaluate((element) => {
      element.value = '4';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await Promise.all([scrubLeft.requested, scrubRight.requested]);
    assert.equal(await playerSession.page.locator('#scrub').isDisabled(), true);
    assert.equal(await playerSession.page.locator('body').getAttribute('data-loading-frame'), '4');
    scrubRight.release();
    await scrubRight.delivered;
    await waitForPaints(playerSession.page);
    assert.equal(await playerSession.page.locator('body').getAttribute('data-frame'), '0');
    assert.match(await playerSession.page.locator('#left').getAttribute('src'), /frames\/a\/0000\.jpg$/);
    assert.match(await playerSession.page.locator('#right').getAttribute('src'), /frames\/b\/0000\.jpg$/);
    scrubLeft.release();
    await scrubLeft.delivered;
    await playerSession.page.waitForFunction(() => document.body.dataset.frame === '4');
    assert.equal(await playerSession.page.locator('body').getAttribute('data-frame'), '4');
    assert.match(await playerSession.page.locator('#left').getAttribute('src'), /frames\/a\/0004\.jpg$/);
    assert.match(await playerSession.page.locator('#right').getAttribute('src'), /frames\/b\/0004\.jpg$/);
    assert.equal(await playerSession.page.locator('#scrub').isDisabled(), false);

    // Autoplay is subject to the same pair barrier. Reverse the completion order
    // to prove neither side's network timing determines the committed frame.
    const playLeft = await holdPlayerFrame(playerSession.page, 'a', 5);
    const playRight = await holdPlayerFrame(playerSession.page, 'b', 5);
    await playerSession.page.click('#play');
    await Promise.all([playLeft.requested, playRight.requested]);
    playLeft.release();
    await playLeft.delivered;
    await waitForPaints(playerSession.page);
    assert.equal(await playerSession.page.locator('body').getAttribute('data-frame'), '4');
    assert.match(await playerSession.page.locator('#left').getAttribute('src'), /frames\/a\/0004\.jpg$/);
    assert.match(await playerSession.page.locator('#right').getAttribute('src'), /frames\/b\/0004\.jpg$/);
    await playerSession.page.click('#play');
    playRight.release();
    await playRight.delivered;
    await playerSession.page.waitForFunction(() => document.body.dataset.frame === '5');
    assert.match(await playerSession.page.locator('#left').getAttribute('src'), /frames\/a\/0005\.jpg$/);
    assert.match(await playerSession.page.locator('#right').getAttribute('src'), /frames\/b\/0005\.jpg$/);
    await playerSession.page.getByRole('button', { name: "can't tell" }).click();
    assert.equal(await playerSession.page.locator('body').getAttribute('data-answer'), "can't tell");
    const jpegResponse = await playerSession.page.request.get(
      `http://127.0.0.1:${bundleServer.port}/frames/a/0000.jpg`,
    );
    assert.equal(jpegResponse.headers()['content-type'], 'image/jpeg');

    const targetSide = Object.entries(state.sideMapping).find(([, role]) => role === 'source')[0];
    await playerSession.page.goto(
      `http://127.0.0.1:${bundleServer.port}/player.html?mode=diagnose&target-side=${targetSide}`,
    );
    await playerSession.page.waitForFunction(() => document.body.dataset.frame === '0');
    await playerSession.page.click('#play');
    assert.equal(await playerSession.page.locator('#left-label').textContent(), 'TARGET');
    assert.equal(await playerSession.page.locator('#right-label').textContent(), 'RE-CREATION');
    assert.match(await playerSession.page.locator('#left').getAttribute('src'), /frames\/b\/0000\.jpg$/);
    assert.match(await playerSession.page.locator('#right').getAttribute('src'), /frames\/a\/0000\.jpg$/);
    const protectedResponse = await playerSession.page.request.get(`http://127.0.0.1:${bundleServer.port}/loop-state.json`);
    assert.equal(protectedResponse.status(), 404);
  } finally {
    await playerSession?.browser.close().catch(() => {});
    await bundleServer?.close();
    await fixture.close();
    rmSync(base, { recursive: true, force: true });
  }
});

await asyncTest('missing and static candidates fail before installing a bundle', async () => {
  const base = mkdtempSync(join(tmpdir(), 'motion-linked-preflight-'));
  const traceDir = join(base, 'trace');
  mkdirSync(traceDir, { recursive: true });
  const fixture = await startFixtureServer();
  const sourceUrl = `http://127.0.0.1:${fixture.port}/linked/scroll-circle.html?mode=source`;
  await writeFile(join(traceDir, 'trace.json'), JSON.stringify(traceShape({ url: sourceUrl })));
  await writeFile(
    join(traceDir, 'fits.json'),
    JSON.stringify({ fits: [{ path: '#circle', channel: 'sx', fit: { kind: 'scroll-linear' } }] }),
  );
  try {
    const missingOut = join(base, 'missing-bundle');
    await assert.rejects(
      buildLinkedComparison({
        traceDir,
        candidateUrl: `http://127.0.0.1:${fixture.port}/linked/scroll-circle.html?mode=missing`,
        out: missingOut,
      }),
      /candidate page is missing scroll trigger section/,
    );
    assert.equal(existsSync(missingOut), false);

    const staticOut = join(base, 'static-bundle');
    await assert.rejects(
      buildLinkedComparison({
        traceDir,
        candidateUrl: `http://127.0.0.1:${fixture.port}/linked/scroll-circle.html?mode=static`,
        out: staticOut,
      }),
      /candidate motion target stayed static/,
    );
    assert.equal(existsSync(staticOut), false);
  } finally {
    await fixture.close();
    rmSync(base, { recursive: true, force: true });
  }
});

if (failed) {
  console.error(`\n${failed} linked selftest(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall linked selftests passed');
}
