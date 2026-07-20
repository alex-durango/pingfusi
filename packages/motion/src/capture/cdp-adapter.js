// Thin adapter over the experimental CDP Animation domain. Field shapes can drift across
// Chrome versions, so normalizeAnimation() is the single place that touches raw payloads.
// Conventions mirrored from DevTools' AnimationModel (see docs/prior-art/devtools-animation-panel.md):
// work off animationStarted (animationCreated is a no-op there), drop payloads with no
// backendNodeId, take the latest payload on animationUpdated, always releaseAnimations.
export class AnimationCollector {
  constructor(cdp) {
    this.cdp = cdp;
    this.byId = new Map();
    this.canceled = new Set();
    this.lastEventAt = 0;
    this.joinFailures = [];
    this._joinChain = Promise.resolve();
    this._handlers = {
      'Animation.animationStarted': (e) => this.#onStarted(e),
      'Animation.animationUpdated': (e) => this.#onUpdated(e),
      'Animation.animationCanceled': (e) => this.#onCanceled(e),
    };
  }

  async start() {
    for (const [event, handler] of Object.entries(this._handlers)) this.cdp.on(event, handler);
    await this.cdp.send('Animation.enable');
  }

  // Detach listeners so several collectors can share one CDP session sequentially
  // (the gate re-navigates per record; navigation invalidates all animation ids anyway).
  stop() {
    for (const [event, handler] of Object.entries(this._handlers)) this.cdp.off(event, handler);
  }

  #onStarted({ animation }) {
    this.lastEventAt = Date.now();
    if (!animation || !animation.source || animation.source.backendNodeId == null) return;
    if (!this.arrivedAt) this.arrivedAt = new Map();
    if (!this.arrivedAt.has(animation.id)) this.arrivedAt.set(animation.id, Date.now());
    this.byId.set(animation.id, animation);
    // resolveAnimation invalidates remote objects from earlier resolves, so each
    // resolve→stash pair must complete before the next resolve is issued
    this._joinChain = this._joinChain.then(() => this.#join(animation.id));
  }

  joinsSettled() {
    return this._joinChain;
  }

  #onUpdated({ animation }) {
    this.lastEventAt = Date.now();
    if (animation && this.byId.has(animation.id)) this.byId.set(animation.id, animation);
  }

  #onCanceled({ id }) {
    this.lastEventAt = Date.now();
    if (this.byId.has(id)) this.canceled.add(id);
  }

  // Join key between the two capture sources: resolve the CDP animation to its in-page
  // JS object and stash it in the injected registry under the CDP id.
  async #join(id) {
    try {
      const { remoteObject } = await this.cdp.send('Animation.resolveAnimation', { animationId: id });
      if (!remoteObject?.objectId) throw new Error('no objectId');
      await this.cdp.send('Runtime.callFunctionOn', {
        objectId: remoteObject.objectId,
        functionDeclaration:
          'function(id) { if (window.__motionKit) window.__motionKit.byCdpId[id] = this; }',
        arguments: [{ value: id }],
      });
    } catch (err) {
      this.joinFailures.push({ id, error: String(err?.message || err) });
    }
  }

  // Wait until no animation event has arrived for quietMs (capped) — measured from
  // whenever lastEventAt was last bumped, so callers reset it right before a trigger.
  async waitQuiet({ quietMs = 700, maxMs = 4000 } = {}) {
    const started = Date.now();
    for (;;) {
      const last = Math.max(this.lastEventAt, started);
      const now = Date.now();
      if (now - last >= quietMs) return;
      if (now - started >= maxMs) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  normalized() {
    return [...this.byId.values()].map((a) => ({
      ...normalizeAnimation(a, { canceled: this.canceled.has(a.id) }),
      arrivedAt: this.arrivedAt?.get(a.id) ?? null,
    }));
  }

  async seek(ids, currentTime) {
    if (!ids.length) return;
    try {
      await this.cdp.send('Animation.seekAnimations', { animations: ids, currentTime });
    } catch {
      // an id can be gone (canceled/replaced) — the gate compares pixels, not seek acks
    }
  }

  async pause(ids, paused) {
    if (!ids.length) return;
    try {
      await this.cdp.send('Animation.setPaused', { animations: ids, paused });
    } catch {}
  }

  async release() {
    const ids = [...this.byId.keys()];
    if (!ids.length) return;
    try {
      await this.cdp.send('Animation.releaseAnimations', { animations: ids });
    } catch {}
  }
}

export function normalizeAnimation(a, { canceled = false } = {}) {
  const src = a.source || {};
  const vst = a.viewOrScrollTimeline;
  return {
    id: a.id,
    name: a.name || null,
    type: a.type,
    cssId: a.cssId || null,
    startTime: a.startTime,
    currentTime: a.currentTime,
    playState: a.playState || null,
    pausedState: a.pausedState ?? null,
    playbackRate: a.playbackRate ?? 1,
    canceled,
    effect: {
      delay: src.delay ?? 0,
      endDelay: src.endDelay ?? 0,
      iterationStart: src.iterationStart ?? 0,
      iterations: src.iterations ?? null,
      duration: src.duration ?? null,
      direction: src.direction || 'normal',
      fill: src.fill || 'none',
      easing: src.easing || 'linear',
      backendNodeId: src.backendNodeId ?? null,
      keyframesRule: src.keyframesRule
        ? {
            name: src.keyframesRule.name || null,
            keyframes: (src.keyframesRule.keyframes || []).map((k) => ({
              offset: k.offset,
              easing: k.easing,
            })),
          }
        : null,
    },
    viewOrScrollTimeline: vst
      ? {
          sourceNodeId: vst.sourceNodeId ?? null,
          startOffset: vst.startOffset ?? null,
          endOffset: vst.endOffset ?? null,
          subjectNodeId: vst.subjectNodeId ?? null,
          axis: vst.axis ?? null,
        }
      : null,
  };
}

// DevTools grouping predicate: scroll-driven animations group by (source, axis);
// time-based by exact startTime equality.
export function groupKey(n) {
  if (n.viewOrScrollTimeline) {
    return `sda:${n.viewOrScrollTimeline.sourceNodeId}:${n.viewOrScrollTimeline.axis}`;
  }
  return `t:${n.startTime}`;
}
