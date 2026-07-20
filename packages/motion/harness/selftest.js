// Browserless selftests for the pure logic (ppk style: hand-rolled, exit code is truth).
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { parseTrigger } from '../src/capture/triggers.js';
import { mergeRecords, identityKey } from '../src/capture/merge.js';
import { groupKey, normalizeAnimation } from '../src/capture/cdp-adapter.js';
import { comparePng, cropPng, unionRects, padClampRect } from '../src/lib/png.js';
import { extractKeyframesRule } from '../src/capture/css-rules.js';
import { effectiveEasing, animationShorthand, synthesizeKeyframesCss } from '../src/export/export.js';
import { cssEasingToMotion, waapiToMotionTransition } from '../src/lib/motion-convert.js';
import { applyDiagnosis, tweenToSpring, parseDiagnosis } from '../src/loop/nudge.js';
import { composeControls } from '../src/loop/compose-controls.js';
import { buildFitEntry, runExportFits, springLinearEasing } from '../src/export/export-fits.js';
import { SAMPLER_SOURCE } from '../src/tier3/sampler.js';
import { launchRemedy } from '../src/capture/session.js';
import { runServeSelftests } from './serve-selftest.js';

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n  ${err.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n  ${err.stack || err.message}`);
  }
}

test('tier3 sampler injection parses as one browser script', () => {
  assert.doesNotThrow(() => new Function(SAMPLER_SOURCE));
});

test('motion launch remedies distinguish runtime, host libraries, and unrelated errors', () => {
  assert.match(launchRemedy("Executable doesn't exist at /playwright/ffmpeg"), /install-browser/);
  assert.match(launchRemedy('Host system is missing dependencies to run browsers'), /system libraries/);
  assert.equal(launchRemedy('Target page crashed for an unrelated reason'), null);
});

test('parseTrigger: bare and selector forms', () => {
  assert.deepEqual(parseTrigger('load'), { kind: 'load', spec: 'load' });
  assert.equal(parseTrigger('hover:.btn').selector, '.btn');
  assert.equal(parseTrigger('click:#a > .b:nth-of-type(2)').selector, '#a > .b:nth-of-type(2)');
  assert.throws(() => parseTrigger('drag:.x'));
  assert.throws(() => parseTrigger('hover:'));
  assert.deepEqual(parseTrigger('scroll-through:#big-ball/80/16'), {
    kind: 'scroll-through', selector: '#big-ball', steps: 80, dwellMs: 16,
    spec: 'scroll-through:#big-ball/80/16',
  });
  assert.throws(() => parseTrigger('scroll-through:#big-ball/nope/16'));
});

test('parseTrigger: pointer path and selector forms', () => {
  const p = parseTrigger('pointer:100,300->900,300/1200');
  assert.equal(p.kind, 'pointer');
  assert.deepEqual(p.points, [{ x: 100, y: 300 }, { x: 900, y: 300 }]);
  assert.equal(p.durationMs, 1200);
  assert.equal(p.spec, 'pointer:100,300->900,300/1200');
  assert.equal(parseTrigger('pointer:0,0->10,0->10,10/500').points.length, 3); // waypoints
  const sel = parseTrigger('pointer:.magnet/800');
  assert.equal(sel.selector, '.magnet');
  assert.equal(sel.durationMs, 800);
  assert.throws(() => parseTrigger('pointer:100,300->900,300')); // no duration
  assert.throws(() => parseTrigger('pointer:/800'));
  assert.throws(() => parseTrigger('pointer:100->900/500')); // malformed waypoint
});

const cdpAnim = (over = {}, effectOver = {}) =>
  normalizeAnimation({
    id: over.id ?? '1',
    name: over.name ?? 'pop',
    type: over.type ?? 'CSSAnimation',
    startTime: over.startTime ?? 1000,
    currentTime: 0,
    playbackRate: 1,
    source: { delay: 0, duration: 600, backendNodeId: 7, ...effectOver },
    ...(over.vst ? { viewOrScrollTimeline: over.vst } : {}),
  });

test('groupKey: exact startTime for time-based, source+axis for SDA', () => {
  assert.equal(groupKey(cdpAnim()), groupKey(cdpAnim({ id: '2' })));
  assert.notEqual(groupKey(cdpAnim()), groupKey(cdpAnim({ id: '3', startTime: 1001 })));
  const sda = cdpAnim({ vst: { sourceNodeId: 4, axis: 'vertical', startOffset: 0, endOffset: 500 } });
  assert.equal(groupKey(sda), 'sda:4:vertical');
});

test('mergeRecords: identical re-firings collapse, distinct payloads get suffixes', () => {
  const cdpAnimations = [
    cdpAnim({ id: '1' }),
    cdpAnim({ id: '2' }), // identical re-firing of 1
    cdpAnim({ id: '3', type: 'WebAnimation', name: '' }),
  ];
  const waapi = (opacity) => ({
    animationName: 'pop',
    timing: { duration: 600, delay: 0 },
    keyframes: [{ offset: 0, opacity }],
    target: { path: 'body > div:nth-of-type(1)', tag: 'div' },
    timeline: { kind: 'document' },
    playState: 'finished',
  });
  const pageSnapshot = {
    byCdp: { 1: waapi('0'), 2: waapi('0') },
    extras: [{ ctor: 'Animation', playState: 'running', target: { path: 'body > canvas' } }],
    watchedCount: 4,
  };
  const { records, crossCheck } = mergeRecords({ cdpAnimations, pageSnapshot });
  assert.equal(records.length, 2); // 1+2 collapsed
  assert.equal(records[0].firedCount, 2);
  assert.equal(records[0].tier, 1);
  assert.equal(records[1].tier, 2);
  assert.equal(records[1].resolved, false);
  assert.equal(crossCheck.matched, 1);
  assert.equal(crossCheck.pageOnly.length, 1);
  assert.deepEqual(crossCheck.cdpOnly, [records[1].key]);

  // same identity but DIFFERENT keyframe values → kept separate with suffix
  const differing = mergeRecords({
    cdpAnimations: [cdpAnim({ id: '1' }), cdpAnim({ id: '2' })],
    pageSnapshot: { byCdp: { 1: waapi('0'), 2: waapi('0.5') }, extras: [] },
  });
  assert.equal(differing.records.length, 2);
  assert.equal(differing.records[1].key, `${identityKey(differing.records[0])}#2`);
});

test('mergeRecords: caps runaway captures loudly', () => {
  const cdpAnimations = [];
  const byCdp = {};
  for (let i = 0; i < 10; i++) {
    cdpAnimations.push(cdpAnim({ id: String(i), name: `anim-${i}` }));
    byCdp[String(i)] = {
      animationName: `anim-${i}`,
      timing: { duration: 600, delay: 0 },
      keyframes: [],
      target: { path: `body > div:nth-of-type(${i + 1})`, tag: 'div' },
      timeline: { kind: 'document' },
    };
  }
  const { records, crossCheck } = mergeRecords({
    cdpAnimations,
    pageSnapshot: { byCdp, extras: [] },
    maxRecords: 4,
  });
  assert.equal(records.length, 4);
  assert.deepEqual(crossCheck.truncated, { kept: 4, dropped: 6 });
});

test('mergeRecords: duration disagreement between sources is surfaced', () => {
  const pageSnapshot = {
    byCdp: {
      1: {
        animationName: 'pop',
        timing: { duration: 480, delay: 0 },
        keyframes: [],
        target: { path: 'div' },
        timeline: { kind: 'document' },
      },
    },
    extras: [],
  };
  const { crossCheck } = mergeRecords({ cdpAnimations: [cdpAnim({ id: '1' })], pageSnapshot });
  assert.equal(crossCheck.warnings.length, 1);
  assert.equal(crossCheck.warnings[0].field, 'duration');
});

test('export: author easing comes from first keyframe, not effect timing', () => {
  const rec = {
    waapi: {
      keyframes: [{ offset: 0, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', opacity: '0' }, { offset: 1, opacity: '1' }],
      timing: { duration: 800, easing: 'linear', fill: 'both' },
    },
  };
  assert.equal(effectiveEasing(rec), 'cubic-bezier(0.16, 1, 0.3, 1)');
  assert.equal(
    animationShorthand('enter', rec.waapi.timing, effectiveEasing(rec)),
    'enter 800ms cubic-bezier(0.16, 1, 0.3, 1) both',
  );
  assert.match(synthesizeKeyframesCss('x', rec.waapi.keyframes), /0% \{ opacity: 0; animation-timing-function: cubic-bezier/);
});

test('export: transition easing comes from effect timing, not keyframes (linear.app bug)', () => {
  // CSS transitions are the mirror image of CSS animations: getKeyframes() easing is
  // 'linear' and the author's curve is timing.easing. Caught live on linear.app's
  // Sign up hover (cubic-bezier(.25,.46,.45,.94) was exported as 'linear').
  const rec = {
    type: 'CSSTransition',
    waapi: {
      keyframes: [
        { offset: 0, easing: 'linear', backgroundColor: 'rgb(229, 229, 230)' },
        { offset: 1, easing: 'linear', backgroundColor: 'rgb(255, 255, 255)' },
      ],
      timing: { duration: 160, easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)' },
    },
  };
  assert.equal(effectiveEasing(rec), 'cubic-bezier(0.25, 0.46, 0.45, 0.94)');
  const t = waapiToMotionTransition(rec.waapi, { authorEasing: effectiveEasing(rec) });
  assert.deepEqual(t.ease, [0.25, 0.46, 0.45, 0.94]);
});

test('motion-convert: css easings + waapi → Motion-canonical transitions', () => {
  assert.equal(cssEasingToMotion('ease-out'), 'easeOut');
  assert.deepEqual(cssEasingToMotion('cubic-bezier(0.16, 1, 0.3, 1)'), [0.16, 1, 0.3, 1]);
  assert.deepEqual(cssEasingToMotion('ease'), [0.25, 0.1, 0.25, 1]);
  assert.equal(cssEasingToMotion('steps(4, end)'), 'steps(4, end)'); // untranslated passthrough

  const t = waapiToMotionTransition({
    timing: { duration: 800, delay: 150, iterations: 'Infinity', direction: 'alternate' },
    keyframes: [
      { offset: 0, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      { offset: 0.6, easing: 'ease-out' },
      { offset: 1 },
    ],
  });
  assert.equal(t.type, 'keyframes');
  assert.equal(t.duration, 0.8); // Motion: seconds
  assert.deepEqual(t.times, [0, 0.6, 1]);
  assert.deepEqual(t.ease, [[0.16, 1, 0.3, 1], 'easeOut']); // per-segment, last keyframe's unused
  assert.equal(t.delay, 0.15);
  assert.equal(t.repeat, 'Infinity'); // JSON convention for Infinity
  assert.equal(t.repeatType, 'mirror');

  const t2 = waapiToMotionTransition({
    timing: { duration: 400, easing: 'linear' },
    keyframes: [{ offset: 0, easing: 'ease' }, { offset: 1 }],
  });
  assert.deepEqual(t2, { type: 'tween', duration: 0.4, ease: [0.25, 0.1, 0.25, 1] });
});

test('export-fits: Motion-idiomatic per-value entry from Tier 3 fits', () => {
  const entry = buildFitEntry({
    path: '#hero > div',
    trigger: 'click:#go',
    sourceUrl: 'https://example.com/',
    capturedAt: '2026-07-07T00:00:00Z',
    engines: { engines: ['gsap'] },
    fits: [
      {
        channel: 'tx',
        fit: { kind: 'spring', transition: { type: 'spring', stiffness: 200, damping: 10, mass: 1, velocity: 0 }, valueFrom: 50, valueTo: 250, settleMs: 1800, confidence: 0.97 },
      },
      {
        channel: 'opacity',
        fit: { kind: 'tween', transition: { type: 'tween', duration: 0.6, ease: [0.25, 0.1, 0.25, 1] }, valueFrom: 0, valueTo: 1, confidence: 0.93 },
      },
    ],
  });
  assert.deepEqual(entry.values.x, [0, 200]); // translate channels are RELATIVE deltas
  assert.deepEqual(entry.values.opacity, [0, 1]); // opacity absolute
  assert.equal(entry.transition.x.type, 'spring');
  assert.equal(entry.transition.opacity.duration, 0.6);
  assert.equal(entry.confidence, 0.93); // min across channels
  assert.equal(entry.meta.fidelity, 'fitted'); // never verbatim for Tier 3
  assert.match(entry.code, /linear\(0 0%.*1 100%\)/s); // spring pre-sampled into linear() easing
  assert.match(entry.code, /translateX\(200px\)/); // WAAPI fallback transform
  assert.match(entry.code, /prefers-reduced-motion/);

  const easing = springLinearEasing({ type: 'spring', stiffness: 500, damping: 25, mass: 1, velocity: 0 }, 0, 240, 800, 16);
  const stops = easing.slice(7, -1).split(', ').map((s) => parseFloat(s));
  assert.equal(stops.length, 16);
  assert.equal(stops[0], 0);
  assert.equal(stops[stops.length - 1], 1);
});

test('nudge: diagnosis answers map to mechanical parameter changes', () => {
  const spring = { kind: 'spring', transition: { type: 'spring', stiffness: 200, damping: 10, mass: 1, velocity: 0 }, valueFrom: 0, valueTo: 200, delayMs: 0 };
  const tween = { kind: 'tween', transition: { type: 'tween', duration: 0.6, ease: [0.34, 1.56, 0.64, 1] }, valueFrom: 0, valueTo: 160, delayMs: 150 };

  assert.equal(applyDiagnosis(spring, 'too fast').fit.transition.stiffness, 140);
  assert.equal(applyDiagnosis(spring, 'too much bounce').fit.transition.damping, 14);
  assert.equal(applyDiagnosis(tween, 'too slow').fit.transition.duration, 0.48);
  assert.equal(applyDiagnosis(tween, 'too much bounce').fit.transition.ease[1], 1.28); // overshoot halved toward 1

  const swapped = applyDiagnosis(tween, 'no bounce').fit; // model-class swap
  assert.equal(swapped.kind, 'spring');
  assert.equal(swapped.transition.type, 'spring');
  assert.deepEqual(swapped.transition, tweenToSpring(0.6));

  const later = applyDiagnosis(tween, 'starts too late').fit;
  assert.equal(later.delayMs, 50);
  assert.equal(later.transition.delay, 0.05);
  assert.equal(applyDiagnosis({ ...tween, delayMs: 40 }, 'starts too late').fit.delayMs, 0);

  assert.equal(applyDiagnosis(spring, 'wrong direction').fit.valueTo, -200);
  assert.equal(applyDiagnosis(spring, 'other').note.changed, null);
  assert.throws(() => applyDiagnosis(spring, 'looks weird'));

  // time-anchored answers parse and are recorded for the flywheel log
  assert.deepEqual(parseDiagnosis('stops too hard @ 0.42s'), { tag: 'stops too hard', detail: null, atMs: 420 });
  assert.deepEqual(parseDiagnosis('too fast'), { tag: 'too fast', detail: null, atMs: null });
  // "other" carries the reviewer's own words as detail — tag matching stays exact
  assert.deepEqual(parseDiagnosis('other: it never moves sideways @ 1.24s'), {
    tag: 'other',
    detail: 'it never moves sideways',
    atMs: 1240,
  });
  assert.equal(applyDiagnosis(spring, 'other: too floaty @ 2s').note.detail, 'too floaty');
  const anchored = applyDiagnosis(spring, 'too much bounce @ 1.2s');
  assert.equal(anchored.fit.transition.damping, 14);
  assert.equal(anchored.note.atMs, 1200);
  // original objects untouched
  assert.equal(spring.transition.stiffness, 200);
  assert.equal(tween.delayMs, 150);
});

test('adjust: composeControls renders the AI\'s uncertainty as UI-as-data', () => {
  const fits = [
    { channel: 'tx', fit: { kind: 'spring', transition: { stiffness: 200, damping: 10 }, valueFrom: 0, valueTo: 200, confidence: 0.6 } },
    { channel: 'opacity', fit: { kind: 'tween', transition: { duration: 0.6, ease: [0, 0, 1, 1] }, valueFrom: 1, valueTo: 0, confidence: 0.95 } },
    { channel: 'rot', fit: { kind: 'scroll-linear', link: { slope: 1 }, confidence: 0.2 } },
  ];
  const panel = composeControls({ fits });
  assert.equal(panel.schema, 'motion-kit/controls@1');
  assert.ok(panel.controls.length <= 3);
  // the uncertain spring's two params fuse into ONE xy pad, ranked above the confident tween
  assert.equal(panel.controls[0].type, 'xy');
  assert.deepEqual(panel.controls[0].param, ['tx.stiffness', 'tx.damping']);
  assert.equal(panel.controls[0].axes.y.invert, true); // up = bouncier = LOWER damping
  assert.deepEqual(panel.controls[0].axes.x.range, [100, 300]); // ±50%
  // labels are perceptual, never technical
  const text = JSON.stringify(panel.controls.map((c) => c.label));
  assert.match(text, /Snappiness|Bounciness|Speed/);
  assert.ok(!/stiffness|damping|duration/i.test(text));
  // scroll-linear never gets controls; every control carries a stress fixture
  assert.ok(!JSON.stringify(panel.controls).includes('rot.'));
  assert.ok(panel.controls.every((c) => c.stress != null));
  // confident tween still fits in the top-3 as an inverted Speed slider
  const speed = panel.controls.find((c) => c.type === 'slider');
  assert.equal(speed.label, 'Speed');
  assert.equal(speed.invert, true);
  assert.equal(speed.unit, 's');
  assert.equal(panel.escape.signal, 'wrong-model-class');
});

test('adjust: marquee panel carries the velocity slider (0.25x–4x px/s) and a direction toggle', () => {
  const fits = [
    { channel: 'tx', fit: { kind: 'marquee', params: { velocityPxPerSec: 60, direction: 1, axis: 'x' }, valueFrom: -1188, confidence: 0.55, delayMs: 0 } },
  ];
  // samples that the fit reproduces exactly — exercises the params-container
  // sensitivity perturbation alongside the ranking
  const samples = Array.from({ length: 60 }, (_, i) => ({ t: i * 50, tx: -1188 + (60 * i * 50) / 1000 }));
  const panel = composeControls({ fits, samples, loopMs: 2950 });
  const slider = panel.controls.find((c) => c.type === 'slider' && c.param === 'tx.velocityPxPerSec');
  assert.ok(slider, 'velocity slider expected');
  assert.deepEqual(slider.range, [15, 240]); // marquee contract: 0.25x..4x the fitted value
  assert.equal(slider.unit, 'px/s');
  assert.equal(slider.invert, false); // right = faster is already intuitive
  assert.equal(slider.initial, 60);
  assert.equal(slider.stress, 240);
  const toggle = panel.controls.find((c) => c.type === 'toggle');
  assert.ok(toggle, 'direction toggle expected');
  assert.equal(toggle.param, 'tx.direction');
  assert.deepEqual(toggle.options.map((o) => o.value), [1, -1]);
  assert.deepEqual(toggle.range, [-1, 1]); // declared range so the applied value validates
  assert.equal(toggle.initial, 1);
  assert.match(toggle.options[0].label, /right/);
  // a vertical rail gets vertical direction labels
  const vertical = composeControls({
    fits: [{ channel: 'ty', fit: { kind: 'marquee', params: { velocityPxPerSec: 36.5, direction: -1, axis: 'y' }, valueFrom: 0, confidence: 0.5 } }],
  });
  const vToggle = vertical.controls.find((c) => c.type === 'toggle');
  assert.match(vToggle.options[0].label, /down/);
  assert.equal(vToggle.initial, -1);
  assert.equal(vToggle.stress, 1);
});

test('nudge: marquee diagnoses map to velocity/direction; settle tags escalate', () => {
  const mq = { kind: 'marquee', params: { velocityPxPerSec: 60, direction: 1, axis: 'x' }, valueFrom: 0, delayMs: 0 };
  assert.equal(applyDiagnosis(mq, 'too fast').fit.params.velocityPxPerSec, 48);
  assert.equal(applyDiagnosis(mq, 'too slow').fit.params.velocityPxPerSec, 75);
  assert.equal(applyDiagnosis(mq, 'wrong direction').fit.params.direction, -1);
  assert.equal(applyDiagnosis(mq, 'starts too early').fit.delayMs, 100);
  // bounce/stop tags describe settle behavior a constant-velocity rail doesn't have
  assert.equal(applyDiagnosis(mq, 'no bounce').note.changed, null);
  assert.equal(applyDiagnosis(mq, 'stops too hard').note.changed, null);
  assert.throws(() => applyDiagnosis(mq, 'looks weird'));
  assert.equal(mq.params.velocityPxPerSec, 60); // original untouched
});

test('adjust: the timing probe is standing, hypothesis-flagged, and never doubles up', () => {
  const fits = [
    { channel: 'tx', fit: { kind: 'spring', transition: { stiffness: 200, damping: 10 }, valueFrom: 0, valueTo: 200, confidence: 0.6, delayMs: 0 } },
  ];
  // "when does it start" is the first thing a reviewer reaches for — the delay
  // probe ships from round 1 (doctrine revision 2026-07-10, live feedback)
  const calm = composeControls({ fits, diagnosisRounds: 0 });
  const probe = calm.controls.find((c) => c.hypothesis);
  assert.ok(probe, 'standing timing probe expected from the first round');
  assert.equal(probe.param, 'tx.delayMs');
  assert.equal(probe.label, 'Timing');
  assert.ok(probe.hint, 'every control carries a cause-and-effect hint');
  // bidirectional: "even the earliest is still not early enough" — negative = earlier
  assert.deepEqual(probe.range, [-300, 300]);
  assert.equal(probe.initial, 0);
  // hypothesis controls stay OUTSIDE the top-2-3 uncertainty ranking
  assert.ok(calm.controls.filter((c) => !c.hypothesis).length <= 3);
  // a fit with a real delay gets the probe CENTERED on it, not a conflicting zero
  const delayed = [
    { channel: 'tx', fit: { kind: 'spring', transition: { stiffness: 200, damping: 10 }, valueFrom: 0, valueTo: 200, confidence: 0.6, delayMs: 120 } },
  ];
  const centered = composeControls({ fits: delayed }).controls.find((c) => c.hypothesis);
  assert.equal(centered.initial, 120);
  assert.deepEqual(centered.range, [-180, 420]);
});

test('extractKeyframesRule: nested braces, quoted names, last definition wins', () => {
  const css = `
    .a { color: red; }
    @keyframes pop { from { opacity: 0 } to { opacity: 1 } }
    @media (min-width: 600px) { @keyframes pop { 0% { transform: scale(.9) } 100% { transform: scale(1) } } }
    @keyframes "quoted" { from { top: 0 } }
    @-webkit-keyframes legacy { from { left: 0 } }
  `;
  assert.match(extractKeyframesRule(css, 'pop'), /scale\(\.9\)/); // last definition
  assert.match(extractKeyframesRule(css, 'quoted'), /top: 0/);
  assert.match(extractKeyframesRule(css, 'legacy'), /-webkit-keyframes/);
  assert.equal(extractKeyframesRule(css, 'absent'), null);
});

function solidPng(w, h, [r, g, b]) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = 255;
  }
  return png;
}

test('comparePng: identical → 0, concentrated blob caught by window ratio', () => {
  const a = solidPng(200, 200, [240, 240, 240]);
  const same = comparePng(a, solidPng(200, 200, [240, 240, 240]));
  assert.equal(same.diffPixels, 0);
  const b = solidPng(200, 200, [240, 240, 240]);
  for (let y = 50; y < 74; y++)
    for (let x = 50; x < 74; x++) {
      const i = (y * 200 + x) * 4;
      b.data[i] = 200;
      b.data[i + 1] = 30;
      b.data[i + 2] = 30;
    }
  const cmp = comparePng(a, b);
  assert.ok(cmp.ratio < 0.02, `global ratio ${cmp.ratio} should look small`);
  assert.ok(cmp.windowRatio > 0.35, `window ratio ${cmp.windowRatio} should catch the blob`);
});

test('rect helpers: union, pad, clamp, crop', () => {
  const u = unionRects([
    { x: 10, y: 10, width: 20, height: 20 },
    { x: 25, y: 5, width: 30, height: 10 },
  ]);
  assert.deepEqual(u, { x: 10, y: 5, width: 45, height: 25 });
  const clamped = padClampRect({ x: 4, y: 4, width: 100, height: 100 }, 24, { width: 120, height: 90 });
  assert.equal(clamped.x, 0);
  assert.equal(clamped.width, 120);
  assert.equal(clamped.height, 90);
  const cropped = cropPng(solidPng(100, 100, [1, 2, 3]), { x: 90, y: 90, width: 50, height: 50 });
  assert.equal(cropped.width, 10);
  assert.equal(cropped.height, 10);
});

await asyncTest('export-fits: pure scroll linkage exports a runnable entry beside time-based fits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'motion-export-fits-'));
  const traceDir = join(root, 'trace');
  const out = join(root, 'library');
  mkdirSync(traceDir, { recursive: true });
  try {
    writeFileSync(
      join(traceDir, 'trace.json'),
      JSON.stringify({
        capturedAt: '2026-07-16T00:00:00Z',
        frames: [{ scrollY: 100 }, { scrollY: 500 }],
        elements: [
          {
            path: '#circle',
            samples: [{ tx: 12, ty: 80, tz: 0, sx: 0.3, sy: 0.3, rot: 0 }],
          },
        ],
      }),
    );
    writeFileSync(
      join(traceDir, 'fits.json'),
      JSON.stringify({
        url: 'https://example.com/',
        trigger: 'scroll-sweep',
        engines: { engines: ['framer-sites'] },
        fits: [
          {
            path: '#circle',
            channel: 'sx',
            fit: {
              kind: 'scroll-linear',
              link: { kind: 'scroll-linear', slope: 0.002, intercept: 0.1, r2: 0.99 },
              confidence: 0.98,
            },
          },
          {
            path: '#circle',
            channel: 'sy',
            fit: {
              kind: 'scroll-linear',
              link: { kind: 'scroll-linear', slope: 0.002, intercept: 0.1, r2: 0.99 },
              confidence: 0.97,
            },
          },
          {
            path: '#fade',
            channel: 'opacity',
            fit: {
              kind: 'tween',
              transition: { type: 'tween', duration: 0.4, ease: 'linear' },
              valueFrom: 0,
              valueTo: 1,
              confidence: 0.96,
            },
          },
        ],
      }),
    );

    const result = await runExportFits({ traceDir, out });
    assert.equal(result.entries.length, 2);
    assert.equal(result.skipped.length, 0);

    const scrollEntry = result.entries.find((entry) => entry.path === '#circle');
    const timeEntry = result.entries.find((entry) => entry.path === '#fade');
    assert.deepEqual(scrollEntry.channels, ['scaleX', 'scaleY']);
    const scrollCode = readFileSync(join(out, scrollEntry.name, `${scrollEntry.name}.js`), 'utf8');
    const runtime = await import(`data:text/javascript;base64,${Buffer.from(scrollCode).toString('base64')}`);
    assert.equal(runtime.valuesAtScroll(300).scaleX, 0.7);
    assert.ok(Math.abs(runtime.valuesAtScroll(0).scaleX - 0.3) < 1e-9); // clamped to captured range
    assert.equal(runtime.valuesAtScroll(300).x, 12); // constant transform baseline is preserved
    assert.match(scrollCode, /addEventListener\('scroll'/);

    const registry = JSON.parse(
      readFileSync(join(out, scrollEntry.name, 'registry-item.json'), 'utf8'),
    );
    assert.equal(registry.meta.animation.scrollLinks.length, 2);
    assert.deepEqual(registry.meta.animation.semantic.scrollRange, [100, 500]);

    const timeCode = readFileSync(join(out, timeEntry.name, `${timeEntry.name}.js`), 'utf8');
    assert.match(timeCode, /export const keyframes/);
    assert.match(timeCode, /return el\.animate/); // established time-based runtime remains intact
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

try {
  await runServeSelftests();
} catch (err) {
  failed++;
  console.error(`FAIL serve selftest\n  ${err.stack || err.message}`);
}

process.exit(failed ? 1 : 0);
