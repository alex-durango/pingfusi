// Phase 1 gate: capture every fixture, replay-gate every captured animation.
// Pass = every fixture captures at least its expected animation count AND ≥90% of all
// captured animations replay pixel-faithfully. Exit code is the verdict (ppk discipline);
// evidence lands in captures/phase1/ (per-capture artifacts + phase1-gate.json).
import { rmSync } from 'node:fs';
import { startFixtureServer } from '../fixtures/serve.js';
import { capture } from '../src/capture/capture.js';
import { runGate } from '../src/replay/gate.js';
import { writeArtifact } from '../src/lib/artifacts.js';

const OUT = 'captures/phase1';
const PASS_FRACTION = 0.9;

const FIXTURES = [
  { page: 'transition-hover.html', trigger: 'hover:.btn', expect: 2 },
  { page: 'keyframes-load.html', trigger: 'load', expect: 1 },
  { page: 'waapi-click.html', trigger: 'click:#chip', expect: 1 },
  { page: 'scroll-driven.html', trigger: 'scroll-sweep', expect: 1 },
  { page: 'stagger-load.html', trigger: 'load', expect: 3 },
];

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  const { port, close } = await startFixtureServer();
  const results = [];
  try {
    for (const fx of FIXTURES) {
      const url = `http://127.0.0.1:${port}/pages/${fx.page}`;
      const dir = `${OUT}/${fx.page.replace('.html', '')}`;
      const entry = { fixture: fx.page, trigger: fx.trigger, expect: fx.expect };
      try {
        const cap = await capture({ url, trigger: fx.trigger, out: dir });
        entry.captured = cap.records.length;
        entry.crossCheck = cap.crossCheck;
        const gate = await runGate({ captureDir: dir });
        entry.gate = gate.summary;
        entry.records = gate.records.map((r) => ({
          key: r.key,
          pass: r.pass,
          reason: r.reason,
          worst: Math.max(0, ...r.fractions.map((f) => f.ratio)),
        }));
      } catch (err) {
        entry.error = String(err?.stack || err);
      }
      results.push(entry);
      const passed = entry.gate ? `${entry.gate.passed}/${entry.gate.total} replayed` : 'ERROR';
      console.log(
        `${fx.page}: captured ${entry.captured ?? 0}/${fx.expect} expected, ${passed}${entry.error ? `\n  ${entry.error.split('\n')[0]}` : ''}`,
      );
    }
  } finally {
    await close();
  }

  const totalAnimations = results.reduce((n, r) => n + (r.gate?.total ?? 0), 0);
  const passedAnimations = results.reduce((n, r) => n + (r.gate?.passed ?? 0), 0);
  const coverageOk = results.every((r) => (r.captured ?? 0) >= r.expect && !r.error);
  const replayFraction = totalAnimations ? passedAnimations / totalAnimations : 0;
  const ok = coverageOk && replayFraction >= PASS_FRACTION;

  writeArtifact(OUT, 'phase1-gate.json', {
    ranAt: new Date().toISOString(),
    fixtures: results,
    totals: { totalAnimations, passedAnimations, replayFraction, coverageOk },
    thresholds: { passFraction: PASS_FRACTION },
    ok,
  });

  console.log(
    `\nphase1 gate: coverage ${coverageOk ? 'ok' : 'FAILED'}, replay ${passedAnimations}/${totalAnimations} (${(replayFraction * 100).toFixed(0)}%) → ${ok ? 'PASS' : 'FAIL'}`,
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(2);
});
