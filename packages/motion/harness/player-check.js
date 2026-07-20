// Scripted verification of player/compare.html: sync, controls, modes, side shuffling.
// Uses two different phase1 reference videos so drift/desync would be visible. Exit code
// is the verdict. Requires captures/phase1 to exist (run gate:phase1 first).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html', '.webm': 'video/webm', '.js': 'text/javascript' };

// Range support matters: without it Chromium never establishes a seekable range for
// media, and the player (correctly) hides its scrubber.
const server = createServer(async (req, res) => {
  try {
    const path = normalize(join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!path.startsWith(ROOT)) throw new Error('outside root');
    const body = await readFile(path);
    const type = TYPES[extname(path)] || 'application/octet-stream';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = Math.min(m[2] ? parseInt(m[2], 10) : body.length - 1, body.length - 1);
      res.writeHead(206, {
        'content-type': type,
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'content-length': end - start + 1,
      });
      res.end(body.subarray(start, end + 1));
    } else {
      res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': body.length });
      res.end(body);
    }
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const A = '/captures/phase1/keyframes-load/reference.webm';
const B = '/captures/phase1/waapi-click/reference.webm';
const playerUrl = (params) => `http://127.0.0.1:${port}/player/compare.html?a=${A}&b=${B}&${params}`;

const browser = await chromium.launch();
const page = await browser.newPage();
let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n  ${err.message}`);
  }
};

await test('videos load, play, and stay in sync', async () => {
  await page.goto(playerUrl('seed=2&mode=view'));
  await page.waitForFunction(() => {
    const l = document.getElementById('vidL');
    return l.duration > 0 && !l.paused && l.currentTime > 0.1;
  });
  await page.waitForTimeout(1500);
  const state = await page.evaluate(() => {
    const l = document.getElementById('vidL');
    const r = document.getElementById('vidR');
    return {
      lt: l.currentTime, rt: r.currentTime, rdur: r.duration,
      lPlaying: !l.paused, rPlaying: !r.paused,
    };
  });
  assert.ok(state.lPlaying && state.rPlaying, 'both playing');
  const drift = Math.abs((state.lt % state.rdur) - state.rt);
  assert.ok(drift < 0.15, `drift ${drift.toFixed(3)}s should be <150ms`);
});

await test('speed buttons set playbackRate on both videos', async () => {
  await page.click('button.speed[data-rate="0.25"]');
  const rates = await page.evaluate(() => [
    document.getElementById('vidL').playbackRate,
    document.getElementById('vidR').playbackRate,
  ]);
  assert.deepEqual(rates, [0.25, 0.25]);
});

await test('play/pause + restart control both videos', async () => {
  await page.click('#playpause');
  let paused = await page.evaluate(() => [vidL.paused, vidR.paused]);
  assert.deepEqual(paused, [true, true]);
  await page.click('#restart');
  paused = await page.evaluate(() => [vidL.paused, vidR.paused, vidL.currentTime < 0.4]);
  assert.deepEqual(paused, [false, false, true]);
});

await test('scrub pauses and seeks both', async () => {
  await page.locator('#scrub').fill('500');
  const s = await page.evaluate(() => ({
    paused: vidL.paused && vidR.paused,
    frac: vidL.currentTime / vidL.duration,
  }));
  assert.ok(s.paused, 'paused during scrub');
  assert.ok(Math.abs(s.frac - 0.5) < 0.05, `seeked to ~50% (got ${(s.frac * 100).toFixed(0)}%)`);
});

await test('seed deterministically swaps sides', async () => {
  await page.goto(playerUrl('seed=2'));
  const even = await page.evaluate(() => [vidL.src, vidR.src]);
  await page.goto(playerUrl('seed=3'));
  const odd = await page.evaluate(() => [vidL.src, vidR.src]);
  assert.equal(even[0], odd[1]);
  assert.equal(even[1], odd[0]);
  assert.ok(even[0].endsWith('reference.webm'));
});

await test('2afc mode asks the forced choice and records the answer', async () => {
  await page.goto(playerUrl('seed=2&mode=2afc'));
  const title = await page.textContent('#title');
  assert.match(title, /ORIGINAL/);
  const labels = await page.$$eval('#opts button', (bs) => bs.map((b) => b.textContent));
  assert.deepEqual(labels, ['LEFT', 'RIGHT', "can't tell"]);
  await page.click('#opts button:first-child');
  assert.equal(await page.evaluate(() => document.body.dataset.answer), 'LEFT');
});

await test('diagnose mode: constrained vocabulary, answers time-anchored via the scrubber', async () => {
  await page.goto(playerUrl('seed=2&mode=diagnose'));
  const labels = await page.$$eval('#opts button', (bs) => bs.map((b) => b.textContent));
  assert.ok(labels.includes('too much bounce') && labels.includes('stagger off') && labels.includes('other'));
  await page.waitForFunction(() => vidL.duration > 0);
  await page.locator('#scrub').fill('500'); // scrub to ~50% — the pick should be stamped there
  await page.click('text=too much bounce');
  const ds = await page.evaluate(() => ({ ...document.body.dataset }));
  assert.equal(ds.answerTag, 'too much bounce');
  const at = parseFloat(ds.answerAt);
  const half = await page.evaluate(() => vidL.duration / 2);
  assert.ok(Math.abs(at - half) < 0.2, `stamped at ${at}s ≈ ${half.toFixed(2)}s`);
  assert.match(ds.answer, /^too much bounce @ [\d.]+s$/);
});

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
