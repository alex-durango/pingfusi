import { evalFitAt, residualFor } from './eval-fit.js';

// UI-as-data review interface: the adjust panel is DYNAMICALLY COMPOSED per task
// by this module — a declarative control schema the reviewer client renders from a FIXED
// component library. Never AI-generated UI code. The panel is a rendering of the AI's
// uncertainty: params ranked by (1 − fit confidence) plus residual-flatness (a residual
// the data can't pin down is exactly where a reviewer's perception can help), top 2-3 only.
//
// Labels are perceptual, not technical — the composer owns the param→lay-term mapping,
// range selection (±50% around the current fit) and axis inversion so that dragging
// right/up always means the intuitive direction.

// Labels name the feeling; hints name the cause-and-effect ("what happens when I
// drag right?") — live reviewer feedback (2026-07-10): a label alone explains nothing.
const LAY = {
  stiffness: { label: 'Snappiness', invert: false, hint: 'right = arrives faster' },
  damping: { label: 'Bounciness', invert: true, hint: 'right = wobblier at the end' }, // more damping = LESS bounce
  duration: { label: 'Speed', invert: true, unit: 's', hint: 'right = faster' }, // longer = slower
  delayMs: { label: 'Timing', invert: false, unit: 'ms', hint: 'left = starts earlier, right = later' },
  velocityPxPerSec: { label: 'Speed', invert: false, unit: 'px/s', hint: 'right = moves faster' }, // marquee contract
};

const range = (v) => [+(v * 0.5).toPrecision(4), +(v * 1.5).toPrecision(4)];
// marquee contract: the velocity slider spans 0.25x..4x the fitted value — rails vary
// far more than the ±50% that pins down an already-plausible spring
const marqueeRange = (v) => [+(v * 0.25).toPrecision(4), +(v * 4).toPrecision(4)];

export function composeControls({ fits, samples = null, loopMs = null, diagnosisRounds = 0, maxControls = 3 }) {
  const candidates = [];
  for (const { channel, fit } of fits) {
    if (fit.kind === 'spring') {
      for (const key of ['stiffness', 'damping']) {
        candidates.push({ channel, fit, key, value: fit.transition[key] });
      }
    } else if (fit.kind === 'tween') {
      candidates.push({ channel, fit, key: 'duration', value: fit.transition.duration });
    } else if (fit.kind === 'marquee') {
      candidates.push({ channel, fit, key: 'velocityPxPerSec', value: fit.params.velocityPxPerSec, container: 'params' });
    }
  }

  for (const c of candidates) {
    c.uncertainty = 1 - (c.fit.confidence ?? 0.5);
    if (samples && loopMs) {
      const base = residualFor(c.fit, c.channel, samples, loopMs);
      if (base != null) {
        const perturbed = structuredClone(c.fit);
        perturbed[c.container || 'transition'][c.key] = c.value * 1.15;
        const pert = residualFor(perturbed, c.channel, samples, loopMs);
        if (pert != null) {
          c.sensitivity = +Math.abs(pert - base).toFixed(4);
          // flat residual under perturbation → the data can't identify this param
          c.uncertainty += Math.max(0, 0.05 - Math.min(c.sensitivity, 0.05)) * 10;
        }
      }
    }
    c.uncertainty = +c.uncertainty.toFixed(4);
  }
  candidates.sort((a, b) => b.uncertainty - a.uncertainty);
  const chosen = candidates.slice(0, maxControls);

  const controls = [];
  const used = new Set();
  for (const c of chosen) {
    const id = `${c.channel}.${c.key}`;
    if (used.has(id)) continue;
    // a spring's two params selected together become ONE xy pad — the natural
    // "snappiness × bounciness" plane
    const partnerKey = c.key === 'stiffness' ? 'damping' : c.key === 'damping' ? 'stiffness' : null;
    const partner = partnerKey && chosen.find((x) => x.channel === c.channel && x.key === partnerKey);
    if (partner) {
      const st = c.key === 'stiffness' ? c : partner;
      const da = c.key === 'damping' ? c : partner;
      used.add(`${c.channel}.stiffness`);
      used.add(`${c.channel}.damping`);
      controls.push({
        type: 'xy',
        param: [`${c.channel}.stiffness`, `${c.channel}.damping`],
        label: 'Snappiness × Bounciness',
        hint: 'drag right = arrives faster, drag up = wobblier — release to replay',
        axes: {
          x: { param: `${c.channel}.stiffness`, label: 'Snappier →', range: range(st.value), initial: st.value, invert: false },
          y: { param: `${c.channel}.damping`, label: '↑ Bouncier', range: range(da.value), initial: da.value, invert: true },
        },
        uncertainty: Math.max(c.uncertainty, partner.uncertainty),
        // toolcraft stressFixture pattern: the exact values the perf check applies
        stress: { [`${c.channel}.stiffness`]: range(st.value)[1], [`${c.channel}.damping`]: range(da.value)[0] },
      });
    } else {
      used.add(id);
      const lay = LAY[c.key];
      const r = c.key === 'velocityPxPerSec' ? marqueeRange(c.value) : range(c.value);
      controls.push({
        type: 'slider',
        param: id,
        label: lay.label,
        hint: lay.hint,
        ...(lay.unit ? { unit: lay.unit } : {}),
        range: r,
        initial: c.value,
        invert: !!lay.invert,
        uncertainty: c.uncertainty,
        stress: r[1],
      });
      // marquee contract: the velocity slider always travels with a direction toggle —
      // a rail running the right speed the wrong way is the most common miss
      if (c.key === 'velocityPxPerSec') {
        const dir = c.fit.params.direction ?? 1;
        const vertical = c.fit.params.axis === 'y';
        controls.push({
          type: 'toggle',
          param: `${c.channel}.direction`,
          label: 'Direction',
          hint: 'flip which way it travels',
          options: vertical
            ? [{ label: 'down ↓', value: 1 }, { label: 'up ↑', value: -1 }]
            : [{ label: 'right →', value: 1 }, { label: 'left ←', value: -1 }],
          range: [-1, 1], // declared so the reviewed value validates like any slider param
          initial: dir,
          uncertainty: c.uncertainty,
          stress: -dir,
        });
      }
    }
  }

  // Timing probe: a param OUTSIDE the fitted model, marked hypothesis so the fitter
  // knows a model-class revision may be needed. Originally gated behind 2+ stalled
  // diagnosis rounds; live reviewer feedback (2026-07-10) showed "when does it start"
  // is the first thing a reviewer reaches for — it's now a standing control (still
  // hypothesis-flagged, still exempt from the top-2-3 uncertainty ranking), and it
  // runs BOTH directions ("even the earliest is still not early enough"): centered
  // on the current delay, negative = starts earlier.
  {
    // the probe belongs on the channel the panel is already focused on (most
    // uncertain), not the biggest-range one — ranges aren't comparable across
    // units (a 0.05 scale pop vs a 1.0 opacity fade)
    const domChannel = chosen[0]?.channel;
    const dom =
      fits.find((f) => f.channel === domChannel && (f.fit.kind === 'spring' || f.fit.kind === 'tween')) ||
      fits.filter((f) => f.fit.kind === 'spring' || f.fit.kind === 'tween')[0];
    if (dom) {
      const current = dom.fit.delayMs || 0;
      controls.push({
        type: 'slider',
        param: `${dom.channel}.delayMs`,
        label: LAY.delayMs.label,
        hint: LAY.delayMs.hint,
        unit: 'ms',
        range: [current - 300, current + 300],
        initial: current,
        invert: false,
        hypothesis: true,
        stress: current + 300,
      });
    }
  }

  return {
    schema: 'motion-kit/controls@1',
    controls,
    escape: { label: 'none of these get close', signal: 'wrong-model-class' },
  };
}
