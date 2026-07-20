import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launchSession, settle, VIEWPORT } from '../capture/session.js';
import { parseTrigger, runTrigger } from '../capture/triggers.js';
import { SAMPLER_SOURCE } from './sampler.js';
import { DETECT_SOURCE } from './detect.js';
import { fitChannel, detectStagger } from './fit.js';
import { installGlTap, collectGlTap, reconstructTracks, perspectivePx } from '../capture/gl-tap.js';
import { fitTunnel } from './fit-tunnel.js';
import { fitDisplacement, pickDynamicFloatTexture } from './fit-displacement.js';
import { readJson, writeArtifact, slug } from '../lib/artifacts.js';
import { remuxSeekable } from '../lib/video.js';

const CHANNELS = ['tx', 'ty', 'tz', 'sx', 'sy', 'rot', 'opacity'];

export function fitAll(data, { triggerAt = null } = {}) {
  const fits = [];
  for (const el of data.elements) {
    for (const ch of CHANNELS) {
      const samples = el.samples
        .map((s) => ({ t: s.t, v: s[ch] }))
        .filter((s) => typeof s.v === 'number' && isFinite(s.v));
      const fit = fitChannel(samples, data.frames, { triggerAt, channel: ch, pointer: data.pointer ?? null });
      if (fit) fits.push({ elementId: el.id, path: el.path, channel: ch, fit });
    }
  }
  return { fits, staggers: detectStagger(fits) };
}

export async function trace({ url, trigger = 'load', out, observeMs = 4000, headless = true, gl = false, block = null, triggerDelayMs = 0, scope = null }) {
  const parsed = parseTrigger(trigger);
  const dir = out || join('captures', slug(`${new URL(url).hostname}-trace-${trigger}`));
  mkdirSync(dir, { recursive: true });
  const videoTmp = join(dir, '.video-tmp');
  const { browser, context, page } = await launchSession({ headless, videoDir: videoTmp });
  try {
    // real-site hygiene: consent banners and trackers pollute captures (overlays in the
    // reference video, mutation noise). Blocked substrings are stored with the trace.
    const blocked = block ? String(block).split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (blocked.length) {
      await page.route(
        (u) => blocked.some((b) => u.href.includes(b)),
        (route) => route.abort(),
      );
    }
    if (gl) await installGlTap(page);
    await page.addInitScript({ content: SAMPLER_SOURCE });
    await page.addInitScript({ content: DETECT_SOURCE });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await settle(page);
    const engines = await page.evaluate(() => window.__mkDetect());
    await page.evaluate(
      ({ maxElements, scopeSelector }) => window.__mkTrace.start({ maxElements, scope: scopeSelector }),
      { maxElements: 48, scopeSelector: scope || null },
    );
    // load-intro isolation: let load-time motion (intro bursts) finish before the
    // trigger runs, so the two phases don't contaminate each other's fits
    if (triggerDelayMs > 0) await page.waitForTimeout(triggerDelayMs);
    const triggerAt = await page.evaluate(() => performance.now());
    await runTrigger(page, parsed);
    await page.waitForTimeout(observeMs); // fixed sampling window (motion may loop; quiet-detection would starve loops)
    const data = await page.evaluate(() => {
      window.__mkTrace.stop();
      return window.__mkTrace.collect();
    });
    const glRaw = gl ? await collectGlTap(page) : null;

    const video = page.video();
    await context.close();
    let referenceVideo = null;
    if (video) {
      try {
        await video.saveAs(join(dir, 'reference.webm'));
        await remuxSeekable(join(dir, 'reference.webm'));
        referenceVideo = 'reference.webm';
      } catch {}
    }
    rmSync(videoTmp, { recursive: true, force: true });

    const { fits, staggers } = fitAll(data, { triggerAt });
    writeArtifact(dir, 'trace.json', {
      url,
      trigger: parsed.spec,
      viewport: VIEWPORT,
      capturedAt: new Date().toISOString(),
      tier: 3,
      engines,
      triggerAt,
      referenceVideo,
      frameCount: data.frames.length,
      elementCount: data.elements.length,
      pointerCount: data.pointer?.length ?? 0,
      droppedElements: data.dropped,
      maxElements: data.maxElements,
      frames: data.frames,
      pointer: data.pointer ?? [],
      elements: data.elements,
      ...(data.scope ? { scope: data.scope } : {}),
      ...(blocked.length ? { blocked } : {}),
    });
    writeArtifact(dir, 'fits.json', {
      url,
      trigger: parsed.spec,
      engines,
      staggers,
      fits,
      maxElements: data.maxElements,
      ...(data.scope ? { scope: data.scope } : {}),
    });

    let glResult = null;
    if (gl) {
      const recon = reconstructTracks(glRaw);
      const canvas = glRaw?.canvases?.[0] ?? null;
      const tunnel = fitTunnel({
        tracks: recon.tracks,
        inputs: glRaw?.inputs ?? [],
        projection: recon.projection,
        fog: recon.fog,
        canvases: glRaw?.canvases ?? [],
      });
      // displacement-field candidate: motion carried by per-frame float-texture uploads
      // rather than matrices. Tried whenever a dynamic data texture exists — the two
      // families are disjoint, so this is not a fallback ordering, just a cheap guard.
      let displacement = null;
      if (pickDynamicFloatTexture(recon.uploads)) {
        displacement = fitDisplacement({
          uploads: recon.uploads,
          pointer: data.pointer ?? [],
          uniforms: recon.uniforms,
        });
      }
      const best = tunnel.ok ? tunnel : displacement?.ok ? displacement : tunnel;
      glResult = {
        url,
        trigger: parsed.spec,
        capturedAt: new Date().toISOString(),
        drawCount: recon.drawCount,
        frameCount: recon.frameCount,
        trackCount: recon.tracks.length,
        perspectivePx: perspectivePx(recon.projection, canvas?.cssH ?? VIEWPORT.height),
        projection: recon.projection,
        fog: recon.fog,
        canvases: glRaw?.canvases ?? [],
        inputs: glRaw?.inputs ?? [],
        uploads: recon.uploads,
        uniforms: recon.uniforms,
        warnings: [...recon.warnings, ...(tunnel.warnings ?? []), ...(displacement?.warnings ?? [])],
        tracks: recon.tracks,
      };
      writeArtifact(dir, 'gl-trace.json', glResult);
      writeArtifact(dir, 'gl-fits.json', {
        url,
        trigger: parsed.spec,
        capturedAt: glResult.capturedAt,
        perspectivePx: glResult.perspectivePx,
        ok: best.ok,
        kind: best.ok ? best.model.kind : null,
        model: best.model ?? null,
        replay: best.replay ?? null,
        warnings: glResult.warnings,
      });
      glResult.tunnel = tunnel;
      glResult.displacement = displacement;
    }
    return { dir, engines, fits, staggers, data, gl: glResult };
  } finally {
    await browser.close().catch(() => {});
  }
}

// Re-run fitting on an existing trace without re-capturing: fitters evolve, captures are
// expensive (and live sites move). Rewrites fits.json / gl-fits.json in place, receipted.
export function refit({ dir }) {
  const out = { dir };
  const tracePath = join(dir, 'trace.json');
  let t = null;
  if (existsSync(tracePath)) {
    t = readJson(tracePath);
    const { fits, staggers } = fitAll({ frames: t.frames, elements: t.elements, pointer: t.pointer }, { triggerAt: t.triggerAt });
    writeArtifact(dir, 'fits.json', {
      url: t.url,
      trigger: t.trigger,
      engines: t.engines,
      staggers,
      fits,
      ...(t.maxElements != null ? { maxElements: t.maxElements } : {}),
      ...(t.scope ? { scope: t.scope } : {}),
    });
    out.fits = fits;
    out.staggers = staggers;
  }
  const glPath = join(dir, 'gl-trace.json');
  if (existsSync(glPath)) {
    const g = readJson(glPath);
    const tunnel = fitTunnel({
      tracks: g.tracks,
      inputs: g.inputs ?? [],
      projection: g.projection ?? null,
      fog: g.fog ?? readGlFog(dir),
      canvases: g.canvases ?? [],
    });
    // uploads/uniforms only exist in traces captured after the displacement tap landed;
    // older traces simply have no candidate (no silent fabrication from thin air)
    let displacement = null;
    if (pickDynamicFloatTexture(g.uploads)) {
      displacement = fitDisplacement({
        uploads: g.uploads,
        pointer: t?.pointer ?? [],
        uniforms: g.uniforms ?? {},
      });
    }
    const best = tunnel.ok ? tunnel : displacement?.ok ? displacement : tunnel;
    writeArtifact(dir, 'gl-fits.json', {
      url: g.url,
      trigger: g.trigger,
      capturedAt: g.capturedAt,
      refitAt: new Date().toISOString(),
      perspectivePx: g.perspectivePx,
      ok: best.ok,
      kind: best.ok ? best.model.kind : null,
      model: best.model ?? null,
      replay: best.replay ?? null,
      warnings: [...(g.warnings ?? []), ...(tunnel.warnings ?? []), ...(displacement?.warnings ?? [])],
    });
    out.gl = { ...best, perspectivePx: g.perspectivePx, trackCount: g.tracks.length, tunnel, displacement };
  }
  return out;
}

// fog constants are only stored in the previous gl-fits.json (the raw draws are not
// persisted) — carry them across a refit rather than dropping them silently
function readGlFog(dir) {
  try {
    return readJson(join(dir, 'gl-fits.json')).model?.fog ?? null;
  } catch {
    return null;
  }
}
