// Phase 4 gate — the automated parts of the convergence loop, exit-code-as-truth:
//   1. good fit → deterministic model-vs-trace diff is SMALL (replay path is faithful)
//   2. corrupted fit → diff is LARGE (the loop can detect imperfection)
//   3. applying a review diagnosis answer ("too fast") to the corrupted fit REDUCES the
//      diff (a convergence step actually converges)
//   4. the bundle is complete (player, both videos, review-task.json, flywheel log)
// The remote 2AFC pass itself is exercised live through a review round, not in this gate.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { startFixtureServer } from '../fixtures/serve.js';
import { trace } from '../src/tier3/trace.js';
import { runLoop, applyRound, applyAdjust, buildBundle } from '../src/loop/loop.js';
import { readJson, writeArtifact } from '../src/lib/artifacts.js';

const OUT = 'captures/phase4';
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failed++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

rmSync(OUT, { recursive: true, force: true });
const { port, close } = await startFixtureServer();
let results = {};
try {
  const traceDir = `${OUT}/springs-trace`;
  await trace({
    url: `http://127.0.0.1:${port}/tier3/springs.html`,
    trigger: 'click:#go',
    out: traceDir,
    observeMs: 3600,
  });

  // 1. good fit → small deterministic diff
  const good = await runLoop({ traceDir, elementPath: '#s1', out: `${OUT}/round-good` });
  check('good fit replays faithfully', good.maxNrmse < 0.05, `max nRMSE ${(good.maxNrmse * 100).toFixed(2)}%`);
  results.good = good.maxNrmse;

  // 2. corrupted fit → large diff (loop detects imperfection)
  const state = readJson(join(`${OUT}/round-good`, 'loop-state.json'));
  const corrupted = structuredClone(state.fits);
  for (const f of corrupted) {
    if (f.fit.kind === 'spring') f.fit.transition.stiffness = +(f.fit.transition.stiffness * 2.2).toFixed(2);
  }
  const bad = await buildBundle({
    dir: `${OUT}/round-corrupted`,
    look: state.look,
    samples: state.samples,
    fits: corrupted,
    loopMs: state.loopMs,
    round: 1,
    minConfidence: state.minConfidence,
  });
  check('corrupted fit is detected', bad.maxNrmse > 0.1, `max nRMSE ${(bad.maxNrmse * 100).toFixed(2)}%`);
  results.corrupted = bad.maxNrmse;

  // 3. a diagnosis answer moves the corrupted fit TOWARD the original
  // (stiffness ×2.2 makes the spring visibly faster → a reviewer would answer "too fast")
  const nudged = await applyRound({ bundleDir: `${OUT}/round-corrupted`, answer: 'too fast' });
  check(
    'diagnosis nudge converges',
    nudged.maxNrmse < bad.maxNrmse * 0.75,
    `nRMSE ${(bad.maxNrmse * 100).toFixed(2)}% → ${(nudged.maxNrmse * 100).toFixed(2)}%`,
  );
  results.nudged = nudged.maxNrmse;

  // 4. bundle completeness + flywheel log
  for (const f of ['player.html', 'adjust.html', 'trace.webm', 'trace.mp4', 'model.webm', 'model.mp4', 'review-task.json', 'loop-state.json', 'loop-log.jsonl']) {
    check(`bundle has ${f}`, existsSync(join(`${OUT}/round-good`, f)));
  }

  // 5. adjust task type: dynamically composed panel (UI-as-data), live updates,
  //    perceptual labels, drag responsiveness, trajectory, escape hatch, and the
  //    propose→dispose round-trip via applyAdjust
  {
    const task = readJson(join(`${OUT}/round-good`, 'review-task.json'));
    const panel = task.controls;
    check(
      'adjust: control schema is composed per task (UI-as-data)',
      panel?.schema === 'motion-kit/controls@1' &&
        panel.controls.filter((c) => !c.hypothesis).length <= 3 &&
        panel.controls.every((c) => c.stress != null),
      `${panel?.controls.length} controls`,
    );
    const labels = JSON.stringify(panel.controls.map((c) => c.label));
    check(
      'adjust: labels are perceptual, not technical',
      /Snappiness|Bounciness|Speed/.test(labels) && !/stiffness|damping|duration/i.test(labels),
      labels,
    );
    // the springs fixture's uncertain spring should compose to an xy pad
    check('adjust: spring params fuse into an xy pad', panel.controls.some((c) => c.type === 'xy'));

    const browser = await chromium.launch();
    const pg = await browser.newPage();
    await pg.goto(pathToFileURL(resolve(`${OUT}/round-good/adjust.html`)).href);
    const before = await pg.evaluate(() => ({ ...window.__mkAdjust.params }));

    // drag storm on the xy pad while measuring frame cadence: laggy controls corrupt
    // reviewer tuning data (test drag responsiveness, not just render correctness)
    const storm = await pg.evaluate(async () => {
      const pad = document.querySelector('.xy');
      const r = pad.getBoundingClientRect();
      const gaps = [];
      let last = performance.now();
      let stop = false;
      const meter = () => {
        const n = performance.now();
        gaps.push(n - last);
        last = n;
        if (!stop) requestAnimationFrame(meter);
      };
      requestAnimationFrame(meter);
      const ev = (type, x, y) =>
        pad.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: y }));
      ev('pointerdown', r.left + r.width / 2, r.top + r.height / 2);
      for (let i = 0; i < 60; i++) {
        const p = i / 59;
        ev('pointermove', r.left + 4 + p * (r.width - 8), r.top + 4 + (1 - p) * (r.height - 8));
        await new Promise((res) => setTimeout(res, 8));
      }
      ev('pointerup', r.left + r.width - 4, r.top + 4);
      stop = true;
      await new Promise((res) => setTimeout(res, 50));
      gaps.sort((a, b) => a - b);
      return {
        p95: gaps[Math.floor(gaps.length * 0.95)],
        frames: gaps.length,
        params: { ...window.__mkAdjust.params },
        traj: window.__mkAdjust.trajectory.length,
      };
    });
    const xyIds = panel.controls.find((c) => c.type === 'xy').param;
    check(
      'adjust: xy drag live-updates both params and logs trajectory',
      xyIds.every((id) => storm.params[id] !== before[id]) && storm.traj >= 3,
      `${xyIds.join('+')} moved, trajectory ${storm.traj} points`,
    );
    check(
      'adjust: drag stays fluid (p95 frame gap < 40ms under input storm)',
      storm.p95 < 40,
      `p95 ${storm.p95.toFixed(1)}ms over ${storm.frames} frames`,
    );
    await pg.click('#escape');
    const escaped = await pg.evaluate(() => document.body.dataset.answer);
    check('adjust: escape signals wrong model class', escaped.startsWith('no-match: wrong-model-class'), escaped);
    await pg.click('#done');
    const matched = await pg.evaluate(() => document.body.dataset.answer);
    check('adjust: matched answer carries final params', /^matched: .+=/.test(matched));
    await browser.close();

    // reviewer tunes the corrupted bundle back to the good params → diff collapses
    const goodState = readJson(join(`${OUT}/round-good`, 'loop-state.json'));
    const goodTx = goodState.fits.find((f) => f.channel === 'tx').fit.transition;
    const tuned = await applyAdjust({
      bundleDir: `${OUT}/round-corrupted`,
      params: { 'tx.stiffness': goodTx.stiffness, 'tx.damping': goodTx.damping },
      trajectory: [{ t: 0, params: { 'tx.stiffness': goodTx.stiffness } }],
    });
    check(
      'adjust: applyAdjust round-trips (tuned-to-good diff collapses)',
      tuned.maxNrmse < 0.02,
      `max nRMSE ${(tuned.maxNrmse * 100).toFixed(2)}%`,
    );
    const log2 = readFileSync(join(`${OUT}/round-corrupted`, 'loop-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    check(
      'adjust: trajectory recorded in flywheel log',
      log2.some((l) => l.event === 'review-adjust' && Array.isArray(l.trajectory)),
    );
  }
  const log = readFileSync(join(`${OUT}/round-corrupted`, 'loop-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  check(
    'flywheel log records passes + diagnosis',
    log.filter((l) => l.event === 'deterministic-pass').length >= 2 && log.some((l) => l.event === 'review-diagnosis'),
    `${log.length} entries`,
  );
  const task = readJson(join(`${OUT}/round-good`, 'review-task.json'));
  check(
    'review task is decodable, constrained, and reviewer-safe',
    task.sideMapping === undefined && // ground truth must NOT leak to reviewers
      task.motion?.schema === 'motion-kit/motion@1' &&
      Array.isArray(task.motion.samples) &&
      task.motion.samples.length > 10 &&
      task.motion.fits.length >= 1 &&
      ['trace', 'model'].includes(readJson(join(`${OUT}/round-good`, 'loop-state.json')).sideMapping.LEFT) &&
      task.vocabulary.includes('too much bounce'),
  );
} finally {
  await close();
}

writeArtifact(OUT, 'phase4-gate.json', { ranAt: new Date().toISOString(), results, failed, ok: failed === 0 });
console.log(`\nphase4 gate: ${failed === 0 ? 'PASS' : `FAIL (${failed})`}`);
process.exit(failed ? 1 : 0);
