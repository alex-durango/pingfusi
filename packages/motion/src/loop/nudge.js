// The constrained-diagnosis vocabulary and its mechanical parameter mappings (from
// docs/PLAN.md Phase 4): reviewers do the seeing, this file does the math. Every option a
// reviewer can pick maps to a deterministic transform of the fit — no interpretation step.

export const DIAGNOSIS_VOCABULARY = [
  'too fast',
  'too slow',
  'too much bounce',
  'no bounce',
  'stops too hard',
  'starts too late',
  'starts too early',
  'wrong direction',
  'wrong distance',
  'stagger off',
  'other',
];

// Motion's visualDuration→physics conversion (docs/prior-art/motion-spring.md) — used
// when a diagnosis demands a model-class swap from tween to spring.
export function tweenToSpring(durationS, bounce = 0.3) {
  const root = (2 * Math.PI) / (durationS * 1.2);
  const stiffness = +(root * root).toFixed(2);
  const damping = +(2 * Math.min(1, Math.max(0.05, 1 - bounce)) * Math.sqrt(stiffness)).toFixed(2);
  return { type: 'spring', stiffness, damping, mass: 1, velocity: 0 };
}

const round2 = (v) => +v.toFixed(2);

// Time-anchored answers ("stops too hard @ 0.42s") come from the player stamping the
// diagnosis with the moment on screen. The timestamp localizes the fix for the agent and
// is recorded in the flywheel log; the mechanical mappings below stay tag-driven.
export function parseDiagnosis(answer) {
  const m = /^(.*?)(?:\s*@\s*([\d.]+)\s*s?)?$/.exec(String(answer).trim());
  let tag = m[1].trim();
  let detail = null;
  // "other" may carry the reviewer's own words ("other: it never moves
  // sideways") — split them off so tag matching stays exact and the free
  // text reaches the agent as its own field.
  const colon = tag.indexOf(':');
  if (colon !== -1) {
    detail = tag.slice(colon + 1).trim() || null;
    tag = tag.slice(0, colon).trim();
  }
  return {
    tag,
    detail,
    atMs: m[2] != null ? Math.round(parseFloat(m[2]) * 1000) : null,
  };
}

// fit: a fitChannel() result ({kind, transition, valueFrom, valueTo, delayMs, ...}).
// Returns { fit, note } — a NEW fit object; `note` records what was changed (flywheel log).
export function applyDiagnosis(fit, rawAnswer) {
  const { tag: answer, detail, atMs } = parseDiagnosis(rawAnswer);
  const f = structuredClone(fit);
  const t = f.transition;
  const note = { answer, detail, atMs, changed: null };
  // marquee (constant-velocity rail): params live beside transition, and only speed,
  // direction, and timing have mechanical mappings — settle-shape tags (bounce/stop)
  // describe behavior a rail doesn't have, so they escalate to agent judgment
  if (f.kind === 'marquee') {
    if (!DIAGNOSIS_VOCABULARY.includes(answer)) throw new Error(`unknown diagnosis answer: ${answer}`);
    const p = f.params;
    switch (answer) {
      case 'too fast':
        p.velocityPxPerSec = round2(p.velocityPxPerSec * 0.8);
        note.changed = 'velocity ×0.8';
        break;
      case 'too slow':
        p.velocityPxPerSec = round2(p.velocityPxPerSec * 1.25);
        note.changed = 'velocity ×1.25';
        break;
      case 'wrong direction':
        p.direction = -p.direction;
        note.changed = 'direction flipped';
        break;
      case 'wrong distance':
        // over a fixed loop window, distance IS speed
        p.velocityPxPerSec = round2(p.velocityPxPerSec * 1.25);
        note.changed = 'velocity ×1.25 (distance over a fixed window is speed; verify next round)';
        break;
      case 'starts too late': {
        const d = Math.max(0, (f.delayMs ?? 0) - 100);
        note.changed = `delay ${f.delayMs}→${d}ms`;
        f.delayMs = d;
        break;
      }
      case 'starts too early': {
        const d = (f.delayMs ?? 0) + 100;
        note.changed = `delay ${f.delayMs}→${d}ms`;
        f.delayMs = d;
        break;
      }
      default:
        note.changed = null; // no mechanical mapping — escalate
    }
    return { fit: f, note };
  }
  switch (answer) {
    case 'too fast':
      if (f.kind === 'tween') { t.duration = +(t.duration * 1.25).toFixed(4); note.changed = 'duration ×1.25'; }
      else { t.stiffness = round2(t.stiffness * 0.7); note.changed = 'stiffness ×0.7'; }
      break;
    case 'too slow':
      if (f.kind === 'tween') { t.duration = +(t.duration * 0.8).toFixed(4); note.changed = 'duration ×0.8'; }
      else { t.stiffness = round2(t.stiffness * 1.35); note.changed = 'stiffness ×1.35'; }
      break;
    case 'too much bounce':
      if (f.kind === 'spring') { t.damping = round2(t.damping * 1.4); note.changed = 'damping ×1.4'; }
      else { t.ease[1] = +(1 + (t.ease[1] - 1) * 0.5).toFixed(4); note.changed = 'overshoot y1 halved toward 1'; }
      break;
    case 'no bounce':
      if (f.kind === 'spring') { t.damping = round2(t.damping * 0.65); note.changed = 'damping ×0.65'; }
      else {
        // model-class swap: the reviewer sees springiness the bezier can't express
        f.kind = 'spring';
        f.transition = tweenToSpring(t.duration ?? 0.4);
        note.changed = `swapped tween→spring ${JSON.stringify(f.transition)}`;
      }
      break;
    case 'stops too hard':
      if (f.kind === 'spring') { t.damping = round2(t.damping * 0.75); note.changed = 'damping ×0.75'; }
      else { t.ease[2] = +(t.ease[2] * 0.6).toFixed(4); note.changed = 'softer exit (x2 ×0.6)'; }
      break;
    case 'starts too late': {
      const d = Math.max(0, (f.delayMs ?? 0) - 100);
      note.changed = `delay ${f.delayMs}→${d}ms`;
      f.delayMs = d;
      if (t) { if (d > 0) t.delay = +(d / 1000).toFixed(3); else delete t.delay; }
      break;
    }
    case 'starts too early': {
      const d = (f.delayMs ?? 0) + 100;
      note.changed = `delay ${f.delayMs}→${d}ms`;
      f.delayMs = d;
      if (t) t.delay = +(d / 1000).toFixed(3);
      break;
    }
    case 'wrong direction':
      f.valueTo = f.valueFrom - (f.valueTo - f.valueFrom);
      note.changed = 'displacement flipped';
      break;
    case 'wrong distance':
      f.valueTo = f.valueFrom + (f.valueTo - f.valueFrom) * 1.25;
      note.changed = 'displacement ×1.25 (sign-ambiguous; verify next round)';
      break;
    case 'stagger off':
      note.changed = 'group-level stagger adjustment (applies to the stagger offset, not this fit)';
      break;
    case 'other':
      note.changed = null; // escalate to agent judgment — no mechanical change
      break;
    default:
      throw new Error(`unknown diagnosis answer: ${answer}`);
  }
  return { fit: f, note };
}
