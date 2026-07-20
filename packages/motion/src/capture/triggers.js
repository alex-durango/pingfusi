// Trigger DSL: a capture is reproducible only if its trigger is. The spec string is
// stored in capture.json and replayed verbatim by the gate.
const WITH_SELECTOR = new Set(['hover', 'click', 'focus', 'scroll-to', 'scroll-steps', 'scroll-through', 'pointer']);
const BARE = new Set(['load', 'scroll-sweep']);

export function parseTrigger(spec) {
  if (BARE.has(spec)) return { kind: spec, spec };
  const idx = spec.indexOf(':');
  const kind = idx === -1 ? spec : spec.slice(0, idx);
  const selector = idx === -1 ? null : spec.slice(idx + 1);
  if (!WITH_SELECTOR.has(kind) || !selector) {
    throw new Error(`bad trigger spec "${spec}" (expected load | scroll-sweep | hover:<sel> | click:<sel> | focus:<sel> | scroll-to:<sel> | scroll-steps:<toPx>/<steps>/<dwellMs> | scroll-through:<sel>/<steps>/<dwellMs> | pointer:<x1>,<y1>-><x2>,<y2>/<durationMs> | pointer:<sel>/<durationMs>)`);
  }
  if (kind === 'scroll-steps') {
    const [toPx, steps, dwellMs] = selector.split('/').map(Number);
    if (!(toPx > 0) || !(steps > 0) || !(dwellMs >= 0)) {
      throw new Error(`bad scroll-steps spec "${spec}" (expected scroll-steps:<toPx>/<steps>/<dwellMs>)`);
    }
    return { kind, toPx, steps, dwellMs, spec };
  }
  if (kind === 'scroll-through') {
    const dwellSlash = selector.lastIndexOf('/');
    const stepsSlash = selector.lastIndexOf('/', dwellSlash - 1);
    const targetSelector = stepsSlash < 0 ? '' : selector.slice(0, stepsSlash);
    const steps = Number(selector.slice(stepsSlash + 1, dwellSlash));
    const dwellMs = Number(selector.slice(dwellSlash + 1));
    if (!targetSelector || !(steps > 0) || !(dwellMs >= 0)) {
      throw new Error(`bad scroll-through spec "${spec}" (expected scroll-through:<selector>/<steps>/<dwellMs>)`);
    }
    return { kind, selector: targetSelector, steps, dwellMs, spec };
  }
  if (kind === 'pointer') {
    // pointer:<x1>,<y1>-><x2>,<y2>[-><x3>,<y3>…]/<durationMs> — deterministic path,
    // constant speed along the polyline. pointer:<sel>/<durationMs> — (0,0) → element
    // center. Duration is after the LAST '/', so selectors keep their own syntax.
    const slash = selector.lastIndexOf('/');
    const durationMs = slash === -1 ? NaN : Number(selector.slice(slash + 1));
    const body = slash === -1 ? '' : selector.slice(0, slash);
    if (!(durationMs > 0) || !body) {
      throw new Error(`bad pointer spec "${spec}" (expected pointer:<x1>,<y1>-><x2>,<y2>/<durationMs> or pointer:<sel>/<durationMs>)`);
    }
    if (body.includes('->')) {
      const points = body.split('->').map((pt) => {
        const [x, y] = pt.split(',').map(Number);
        return { x, y };
      });
      if (points.length < 2 || points.some((p) => !isFinite(p.x) || !isFinite(p.y))) {
        throw new Error(`bad pointer path in "${spec}" (waypoints are <x>,<y> pairs joined by ->)`);
      }
      return { kind, points, durationMs, spec };
    }
    return { kind, selector: body, durationMs, spec };
  }
  return { kind, selector, spec };
}

// Real pages keep hidden duplicates of interactive elements (mobile menus, SSR
// fallbacks) — interaction triggers must target the first VISIBLE match, not the first.
function visibleTarget(page, selector) {
  return page.locator(selector).filter({ visible: true }).first();
}

export async function runTrigger(page, trigger) {
  switch (trigger.kind) {
    case 'load':
      return;
    case 'hover':
      // pointer stays on the element afterwards, so hover-state transitions hold
      return visibleTarget(page, trigger.selector).hover();
    case 'click':
      return visibleTarget(page, trigger.selector).click();
    case 'focus':
      return visibleTarget(page, trigger.selector).focus();
    case 'scroll-to':
      return page.evaluate((sel) => {
        document.querySelector(sel)?.scrollIntoView({ behavior: 'instant', block: 'center' });
      }, trigger.selector);
    case 'scroll-steps':
      // stepped scroll TO A TARGET, then stay: unlike scroll-sweep this keeps the
      // viewport inside a pinned section (scroll-driven renderers pause off-screen) and
      // ends with a quiet tail there — what decay/settling fits need
      return page.evaluate(
        async ({ toPx, steps, dwellMs }) => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          for (let i = 1; i <= steps; i++) {
            scrollTo({ top: (toPx * i) / steps, behavior: 'instant' });
            await sleep(dwellMs);
          }
        },
        { toPx: trigger.toPx, steps: trigger.steps, dwellMs: trigger.dwellMs },
      );
    case 'scroll-through':
      // Walk one section's complete sticky travel at fine resolution. A whole-page
      // scroll-sweep can jump hundreds of pixels per step and spends most samples on
      // unrelated/clamped ranges; this trigger produces the local scroll/value pairs a
      // section-linked fit actually needs.
      return page.evaluate(
        async ({ selector, steps, dwellMs }) => {
          const el = document.querySelector(selector);
          if (!el) throw new Error(`scroll-through matched no element: ${selector}`);
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const raf = () => new Promise((r) => requestAnimationFrame(r));
          const rect = el.getBoundingClientRect();
          const max = document.documentElement.scrollHeight - innerHeight;
          const from = Math.max(0, Math.min(max, scrollY + rect.top));
          const to = Math.max(from, Math.min(max, from + Math.max(0, rect.height - innerHeight)));
          scrollTo({ top: from, behavior: 'instant' });
          await raf();
          await raf();
          for (let i = 1; i <= steps; i++) {
            scrollTo({ top: from + ((to - from) * i) / steps, behavior: 'instant' });
            await raf();
            await raf();
            if (dwellMs) await sleep(dwellMs);
          }
        },
        { selector: trigger.selector, steps: trigger.steps, dwellMs: trigger.dwellMs },
      );
    case 'pointer': {
      // Pursuit driver: walk the path at constant speed in ~16ms steps, wall-clock
      // paced so total duration holds under CDP round-trip jitter. Fits use the pointer
      // series the PAGE recorded (sampler mousemove), never this commanded path — so
      // command jitter cannot skew a fit.
      let points = trigger.points;
      if (!points) {
        const box = await visibleTarget(page, trigger.selector).boundingBox();
        if (!box) throw new Error(`pointer trigger: no visible box for ${trigger.selector}`);
        points = [{ x: 0, y: 0 }, { x: box.x + box.width / 2, y: box.y + box.height / 2 }];
      }
      const lens = [];
      let total = 0;
      for (let i = 1; i < points.length; i++) {
        const l = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
        lens.push(l);
        total += l;
      }
      const at = (p) => {
        if (!(total > 0)) return points[0];
        let d = p * total;
        for (let i = 0; i < lens.length; i++) {
          if (d <= lens[i] || i === lens.length - 1) {
            const f = lens[i] > 0 ? Math.min(1, d / lens[i]) : 1;
            return {
              x: points[i].x + (points[i + 1].x - points[i].x) * f,
              y: points[i].y + (points[i + 1].y - points[i].y) * f,
            };
          }
          d -= lens[i];
        }
        return points[points.length - 1];
      };
      await page.mouse.move(points[0].x, points[0].y);
      const t0 = Date.now();
      for (;;) {
        const p = Math.min(1, (Date.now() - t0) / trigger.durationMs);
        const pt = at(p);
        await page.mouse.move(pt.x, pt.y);
        if (p >= 1) return;
        await page.waitForTimeout(16);
      }
    }
    case 'scroll-sweep':
      // ppk's scrollSweep: bottom and back in steps, mounting lazy/scroll-linked content
      return page.evaluate(async () => {
        const raf = () => new Promise((r) => requestAnimationFrame(r));
        const max = () => document.documentElement.scrollHeight - innerHeight;
        const steps = 24;
        for (let i = 1; i <= steps; i++) {
          scrollTo({ top: (max() * i) / steps, behavior: 'instant' });
          await raf();
          await raf();
        }
        for (let i = steps - 1; i >= 0; i--) {
          scrollTo({ top: (max() * i) / steps, behavior: 'instant' });
          await raf();
        }
      });
    default:
      throw new Error(`unhandled trigger kind ${trigger.kind}`);
  }
}
