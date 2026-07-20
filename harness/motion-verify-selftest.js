// harness/motion-verify-selftest.js — guards the SAMPLED tier's apply/verify halves
// (`pingfusi motion apply-sampled` → harness/motion-apply.js, `pingfusi motion
// verify-sampled` → harness/motion-verify.js --sampled).
//
// OFFLINE (always runs). Apply: the generated clone/motion-replay.js WAAPI player (header
// receipt, node --check parse, trigger semantics, multi-item regeneration), the EMITTED
// player exercised in a mock DOM (finite clips release-on-finish — fill "none", commit
// only as sole owner, then cancel; ongoing tracks loop by fitted law with the wrap
// distance measured from the element at runtime), the marker-block idempotency in
// clone/index.html, the ongoing-without-periodic-fit refusal (a clip is not an
// implementation for ongoing motion), the ONE-OWNER probe (pxOwnerProbe in a mock DOM,
// plus the CLI refusal when a competing writer moves the element), the applied-sampled
// receipt + ledger entry, and the quarantine refusals. Verify: the pure per-frame diff at
// its documented tolerance, the ongoing motion-LAW diff (velocity/direction, phase-free),
// then the full command against a fake Chrome — the identical virtual-time stimulus PLUS
// the post-window frames past the clip end: a clone that freezes where live continues
// exits 1 named "unterminated motion", a looping clone must keep the fitted velocity, a
// clone that keeps animating where live settled fails too. Quarantine: an item that was
// never operator-declared is refused before Chrome is even contacted.
// (The introspected gate's pure core is covered in motion-items-selftest.)
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const vm = require("vm");
const { execFile, execFileSync } = require("child_process");
const { acceptKeyFor } = require("./cdp.js");
const motionDoc = require("./motion-doc.js");
const apply = require("./motion-apply.js");
const verify = require("./motion-verify.js");

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
};

// ── fake Chrome (same server-half RFC6455 as motion-sampler-selftest) ─────────
function serverFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (data.length < 126) { header = Buffer.alloc(2); header[1] = data.length; }
  else if (data.length < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(data.length, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}
function decodeClientFrames(state, chunk, out) {
  state.buf = state.buf.length ? Buffer.concat([state.buf, chunk]) : chunk;
  while (state.buf.length >= 2) {
    const opcode = state.buf[0] & 0x0f, masked = (state.buf[1] & 0x80) !== 0;
    let len = state.buf[1] & 0x7f, off = 2;
    if (len === 126) { if (state.buf.length < 4) return; len = state.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (state.buf.length < 10) return; len = Number(state.buf.readBigUInt64BE(2)); off = 10; }
    const need = off + (masked ? 4 : 0) + len;
    if (state.buf.length < need) return;
    const mask = masked ? state.buf.subarray(off, off + 4) : null;
    const data = Buffer.from(state.buf.subarray(off + (masked ? 4 : 0), need));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    state.buf = state.buf.subarray(need);
    out.push({ opcode, data });
  }
}

const GOOD_PROBE = { documentHidden: false, visibilityState: "visible", hasFocus: false, innerWidth: 1440, devicePixelRatio: 2, raf: { frames: 33, ms: 702 }, anim: { expectedPxPerSec: 100, measuredPxPerSec: 99.1 } };

function fakeChrome(script) {
  let tabN = 0;
  const calls = [];
  const server = http.createServer((req, res) => {
    if (req.url === "/json/version") { res.end(JSON.stringify({ Browser: "FakeChrome/1.0" })); return; }
    if (req.method === "PUT" && req.url.startsWith("/json/new")) {
      const id = `TAB${++tabN}`;
      res.end(JSON.stringify({ id, webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/${id}` }));
      return;
    }
    if (req.url.startsWith("/json/close/")) { res.end("Target is closing"); return; }
    res.statusCode = 404; res.end();
  });
  server.on("upgrade", (req, socket) => {
    const tab = +(/TAB(\d+)/.exec(req.url) || [0, 1])[1];
    const acts = script[Math.min(tab - 1, script.length - 1)];
    let vnow = 1000; // fake virtual clock: at "load" already; advances move it
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKeyFor(req.headers["sec-websocket-key"])}\r\n\r\n`);
    const state = { buf: Buffer.alloc(0) };
    socket.on("data", (chunk) => {
      const frames = [];
      decodeClientFrames(state, chunk, frames);
      for (const f of frames) {
        if (f.opcode === 0x8) { socket.end(); continue; }
        if (f.opcode !== 0x1) continue;
        const msg = JSON.parse(f.data.toString());
        const reply = (result) => socket.write(serverFrame(0x1, JSON.stringify({ id: msg.id, result })));
        const event = (method, params) => socket.write(serverFrame(0x1, JSON.stringify({ method, params: params || {} })));
        const value = (v) => reply({ result: { type: typeof v, value: v } });
        if (msg.method === "Emulation.setVirtualTimePolicy") {
          const p = msg.params || {};
          if (p.policy === "advance" && typeof p.budget === "number") vnow += p.budget;
          calls.push({ tab, key: `vt:${p.policy}`, budget: p.budget });
          reply({ virtualTimeTicksBase: 0 });
          if (p.policy === "advance" || p.policy === "pauseIfNetworkFetchesPending") event("Emulation.virtualTimeBudgetExpired");
        } else if (msg.method === "HeadlessExperimental.beginFrame") {
          socket.write(serverFrame(0x1, JSON.stringify({ id: msg.id, error: { message: "'HeadlessExperimental.beginFrame' wasn't found" } })));
        } else if (msg.method === "Emulation.setDeviceMetricsOverride") {
          calls.push({ tab, key: "metrics", params: msg.params });
          reply({});
        } else if (msg.method === "Page.navigate") {
          calls.push({ tab, key: "navigate", url: (msg.params || {}).url });
          reply({ frameId: "F1" });
          event("Page.loadEventFired");
        } else if (msg.method === "Runtime.evaluate") {
          const e = msg.params.expression;
          if (e.includes("__ppkProbe")) value(GOOD_PROBE);
          else if (e.includes("iw: innerWidth")) value({ iw: 1440, cw: 1440, ih: 982, dpr: 2 });
          else if (e === "typeof pxDenseRecordStart") value("function");
          else if (e.startsWith("pxDenseRecordStart(")) {
            calls.push({ tab, key: "start", expression: e });
            value({ tracking: 2, writesObserved: true, truncated: false, skipped: { agentDom: 0 } });
          } else if (e.startsWith("pxDenseRecordStep(")) {
            calls.push({ tab, key: "step", t: +/\(([\d.]+)\)/.exec(e)[1] });
            value({ frame: 1, truncated: false });
          } else if (e.startsWith("pxDenseRecordStop")) {
            value(typeof acts.record === "function" ? acts.record(tab) : acts.record);
          } else if (e.startsWith("pxOwnerProbe(")) {
            calls.push({ tab, key: "owner-probe", expression: e });
            value(acts.ownerProbe || { schema: "pingfusi/owner-probe@1", durationMs: 1000, ticks: 10, elements: 2, missing: [], ownCancelled: 0, changed: [] });
          } else if (e.startsWith("(() => { const nav = performance.getEntriesByType")) {
            value({ now: vnow, load: 1000, dcl: 900, readyState: "complete" });
          } else if (e === "performance.now()") {
            value(vnow);
          } else if (e === "window.__ppkN") {
            value(12); // the frame-drive probe: virtual time drives frames on the fake
          } else if (e.startsWith("performance.getEntriesByType")) {
            value(7);
          } else if (e.startsWith("(() => { for (const a of document.getAnimations())")) {
            calls.push({ tab, key: "waapi-drive", t: +/currentTime = ([\d.]+)/.exec(e)[1] });
            value(undefined);
          } else if (e === "document.readyState") {
            value("complete");
          } else reply({ result: { type: "undefined" } });
        } else reply({});
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => {
    server.calls = calls;
    server.tabCount = () => tabN;
    r(server);
  }));
}

// ── fixtures ──────────────────────────────────────────────────────────────────
// Live + clone records share one builder on the same 20ms grid.
//   `.hero`  translates 10px/frame and SETTLES at 30px from frame 3 — a finite clip.
//   `.fade`  ramps opacity to 0.5 and settles — finite.
//   `.belt`  moves 8px/frame through the LAST frame — ONGOING, no settle observed.
// Clone-side calls extend past the clip (framesN > 5): the hero must HOLD its committed
// settle value (heroPostVel drifts it for the never-releases case), the belt must KEEP
// MOVING (beltPostVel 0 freezes it — the encoded miss; a small value moves it at the
// wrong velocity). The belt's PHASE (beltPhase) differs from live on purpose: a looping
// player starts from its own runtime-measured geometry, so only the motion-law
// comparison can pass it.
const range = (n) => Array.from({ length: n }, (_, k) => k + 1);
const record = ({ framesN = 5, heroTx3 = 30, heroStatic = false, heroPostVel = 0, beltPhase = 0, beltVel = 8, beltPostVel = null } = {}) => ({
  frames: framesN, stepMs: 20,
  elements: [
    { selector: ".hero", samples: range(framesN).map((i) => ({ t: i * 20, values: {
      transform: heroStatic ? "none" : `matrix(1, 0, 0, 1, ${i === 3 ? heroTx3 : Math.min(i, 3) * 10 + Math.max(0, i - 5) * heroPostVel}, 0)`, opacity: "1" } })) },
    { selector: ".fade", samples: range(framesN).map((i) => ({ t: i * 20, values: {
      transform: "none", opacity: String(Math.min(i - 1, 2) * 0.25) } })) },
    { selector: ".belt", samples: range(framesN).map((i) => ({ t: i * 20, values: {
      transform: `matrix(1, 0, 0, 1, ${beltPhase + Math.min(i, 5) * beltVel + Math.max(0, i - 5) * (beltPostVel == null ? beltVel : beltPostVel)}, 0)`, opacity: "1" } })) },
  ],
  writes: [], truncated: false, skipped: { agentDom: 0 }, writesObserved: true,
});

const VIEWPORT = { width: 1440, height: 982, dpr: 2 };
const APPLY = path.join(__dirname, "motion-apply.js");
const VERIFY = path.join(__dirname, "motion-verify.js");
function run(file, args, cwd) {
  return new Promise((resolve) => {
    execFile("node", [file, ...args], { cwd }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: String(stdout) + String(stderr) });
    });
  });
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// One target with the live sampled record already merged the way `motion sample` leaves
// it: canonical doc tracks + per-item sampledTrackIds + the sample.json stimulus receipt.
// The belt track carries what the sampler's detection + lift leave behind: ongoing:true
// plus a marquee fit at the measured law (8px/frame at 50fps = 400 px/s).
function makeTarget(work, name, { items, extraTracks = [] } = {}) {
  const dir = path.join(work, "targets", name);
  fs.mkdirSync(path.join(dir, "clone"), { recursive: true });
  fs.writeFileSync(path.join(dir, "target.json"), JSON.stringify({ name, url: "http://fake-live/", width: 1440 }));
  const sampledDoc = motionDoc.fromSampled(record(), { url: "http://fake-live/", viewport: VIEWPORT, fps: 50, capturedAt: "2026-07-18T00:00:00.000Z" });
  const doc = motionDoc.emptyDoc({ url: "http://fake-live/", viewport: VIEWPORT, capturedAt: "2026-07-18T00:00:00.000Z" });
  for (const track of [...sampledDoc.tracks, ...extraTracks]) motionDoc.addTrack(doc, track);
  const heroTrack = doc.tracks.find((t) => t.target.selector === ".hero" && t.property === "transform");
  const fadeTrack = doc.tracks.find((t) => t.target.selector === ".fade" && t.property === "opacity");
  const beltTrack = doc.tracks.find((t) => t.target.selector === ".belt" && t.property === "transform");
  if (beltTrack) {
    beltTrack.ongoing = true;
    beltTrack.fit = { kind: "marquee", params: { channel: "tx", axis: "x", velocityPxPerSec: 400, direction: 1, valueFrom: 8, steadyMs: 80 }, nrmse: 0.0001 };
  }
  motionDoc.validateMotionDoc(doc);
  fs.writeFileSync(path.join(dir, "motion-doc.json"), JSON.stringify(doc, null, 2));
  fs.writeFileSync(path.join(dir, "motion-items.json"), JSON.stringify({ schema: "pingfusi/motion-items@1", items }));
  fs.writeFileSync(path.join(dir, "clone", "index.html"), "<!doctype html>\n<html><head><title>t</title></head>\n<body>\n<div class=\"hero\"></div>\n<div class=\"fade\"></div>\n<div class=\"belt\"></div>\n</body></html>\n");
  for (const item of items) {
    const receiptDir = path.join(dir, "motion", item.id);
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(path.join(receiptDir, "sample.json"), JSON.stringify({
      schema: "pingfusi/motion-sample@1", ok: true, target: name, item: item.id,
      url: "http://fake-live/", viewport: VIEWPORT,
      fps: 50, frames: 5, stepMs: 20,
      trigger: item.trigger || "load", scopes: [item.scope || "body"], props: ["transform", "opacity", "filter", "visibility"],
      virtualTime: { mode: "virtual-time", initialVirtualTime: 1700000000, beginFrame: false },
    }, null, 2) + "\n");
  }
  return { dir, heroTrack, fadeTrack, beltTrack };
}
const declaredItem = (over = {}) => ({ id: "m1", capability: "motion", kind: "raf", status: "sampled", trigger: "load", scope: ".hero", declaredBy: "manual", ...over });
const setTrackIds = (dir, byId) => {
  const manifest = readJson(path.join(dir, "motion-items.json"));
  for (const item of manifest.items) if (byId[item.id]) item.sampledTrackIds = byId[item.id];
  fs.writeFileSync(path.join(dir, "motion-items.json"), JSON.stringify(manifest, null, 2));
};

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-verify-sampled-"));

  // ── pure helpers: apply ───────────────────────────────────────────────────────
  check("replayTrigger: load starts immediately, scroll-to observes its own selector", (() => {
    const load = apply.replayTrigger("load", {});
    const to = apply.replayTrigger("scroll-to:.rail", { scope: ".hero" });
    const sweep = apply.replayTrigger("scroll-sweep", { scope: ".hero" });
    return load.start === "load" && to.start === "scroll" && to.observe === ".rail" && sweep.start === "scroll" && sweep.observe === ".hero";
  })());
  check("replayTrigger: an interactive trigger is refused by name, never degraded", (() => {
    try { apply.replayTrigger("hover:.x", {}); return false; } catch (e) { return /not replayable/.test(e.message); }
  })());
  check("waapiProperty camel-cases css property names for keyframe keys", apply.waapiProperty("background-color") === "backgroundColor" && apply.waapiProperty("transform") === "transform");
  {
    const html = "<body>\n<div class=\"keep\"></div>\n</body>";
    const first = apply.injectScriptTag(html);
    const second = apply.injectScriptTag(first.html);
    check("injectScriptTag: inserts before </body>, then replaces ONLY its own block", first.action === "inserted" && second.action === "replaced" &&
      (second.html.match(/pingfusi:motion-replay:begin/g) || []).length === 1 && second.html.includes('<div class="keep"></div>'));
    const bare = apply.injectScriptTag("<p>no body tag</p>");
    check("injectScriptTag: a body-less document gets the block appended", bare.action === "appended" && /<p>no body tag<\/p>\n<!-- pingfusi:motion-replay:begin/.test(bare.html));
  }
  {
    const kf = (values) => values.map((v, i) => ({ offset: values.length === 1 ? 1 : i / (values.length - 1), value: v }));
    const mx = (x) => `matrix(1, 0, 0, 1, ${x}, 0)`;
    const settled = { property: "transform", keyframes: kf([mx(10), mx(30), mx(30), mx(30), mx(30)]) };
    const ongoingNoFit = { property: "transform", keyframes: kf([mx(10), mx(20), mx(30), mx(40), mx(50)]) };
    const ongoingWithFit = { ...ongoingNoFit, ongoing: true, fit: { kind: "marquee", params: { channel: "tx", velocityPxPerSec: 500, direction: -1 }, nrmse: 0 } };
    const a = apply.replayMode(settled), b = apply.replayMode(ongoingNoFit), c = apply.replayMode(ongoingWithFit);
    check("replayMode: settled → clip; ongoing without a periodic fit → unloopable (re-derived from the keyframes, never trusting a missing flag); with a marquee fit → loop", a.mode === "clip" && !a.ongoing && b.mode === "unloopable" && b.ongoing === true &&
      c.mode === "loop" && c.axis === "x" && c.velocityPxPerSec === 500 && c.direction === -1);
  }

  // ── pure helpers: the sampled diff at its documented tolerance ────────────────
  const seq = [1, 2, 3, 4, 5];
  check("sampledValueMiss: translate within ±1px passes, past it fails naming both sides", (() => {
    const okv = verify.sampledValueMiss("transform", "matrix(1, 0, 0, 1, 30, 0)", "matrix(1, 0, 0, 1, 30.9, 0)");
    const bad = verify.sampledValueMiss("transform", "matrix(1, 0, 0, 1, 30, 0)", "matrix(1, 0, 0, 1, 31.5, 0)");
    return okv === null && /translate live=\(30, 0\) clone=\(31.5, 0\)/.test(bad || "") && /±1px/.test(bad);
  })());
  check("sampledValueMiss: opacity ±0.02, visibility discrete", verify.sampledValueMiss("opacity", "0.5", "0.51") === null &&
    /±0.02/.test(verify.sampledValueMiss("opacity", "0.5", "0.6") || "") &&
    /discrete/.test(verify.sampledValueMiss("visibility", "visible", "hidden") || ""));
  {
    const live = { id: "L", target: { selector: ".hero" }, property: "transform",
      keyframes: seq.map((i, n) => ({ offset: n / 4, value: `matrix(1, 0, 0, 1, ${Math.min(i, 3) * 10}, 0)` })),
      timing: { duration_ms: 100, delay_ms: 0, iterations: 1, direction: "normal", fill: "both" },
      timeline: { type: "document" }, provenance: { tier: "sampled", source: "virtual-time@50fps" } };
    const clone = JSON.parse(JSON.stringify(live));
    clone.keyframes[2].value = "matrix(1, 0, 0, 1, 60, 0)";
    const misses = verify.diffSampledTrack(live, clone);
    check("diffSampledTrack names the first offending frame with both translate values", misses.length === 1 && /^frame 2 translate live=\(30, 0\) clone=\(60, 0\)/.test(misses[0]));
    const short = JSON.parse(JSON.stringify(live));
    short.keyframes = short.keyframes.slice(0, 3);
    check("a differing frame count is its own named miss, not a partial diff", /keyframes\.length live=5 clone=3/.test(verify.diffSampledTrack(live, short)[0]));
    const cloneDocMapped = { tracks: [{ ...JSON.parse(JSON.stringify(live)), id: "C", target: { selector: "#clone-hero" } }] };
    const mapped = verify.verifySampledTracks([live], cloneDocMapped, { candidateSelectors: { ".hero": "#clone-hero" } });
    check("verifySampledTracks honors the item's candidateSelector mapping", mapped.ok && mapped.tracks[0].cloneSelector === "#clone-hero");
    const uncovered = verify.verifySampledTracks([live], { tracks: [] }, {});
    check("coverage is part of the gate: a clone with no matching sampled track fails by name", !uncovered.ok && /no sampled "transform" track on the clone for selector \.hero/.test(uncovered.firstMismatch));
  }

  // ── pure helpers: the ongoing motion-LAW diff + the post-window quadrants ─────
  {
    const beltKf = (phase, vel, n = 5) => range(n).map((i, k) => ({ offset: k / (n - 1), value: `matrix(1, 0, 0, 1, ${phase + i * vel}, 0)` }));
    const liveBelt = { id: "B", target: { selector: ".belt" }, property: "transform", ongoing: true,
      keyframes: beltKf(0, 8),
      timing: { duration_ms: 100, delay_ms: 0, iterations: 1, direction: "normal", fill: "both" },
      timeline: { type: "document" }, provenance: { tier: "sampled", source: "virtual-time@50fps" },
      fit: { kind: "marquee", params: { channel: "tx", axis: "x", velocityPxPerSec: 400, direction: 1, valueFrom: 8, steadyMs: 80 }, nrmse: 0.0001 } };
    const phased = { ...JSON.parse(JSON.stringify(liveBelt)), keyframes: beltKf(100, 8) };
    check("diffOngoingSampledTrack: a phase-shifted clone at the same velocity PASSES — the law, not the phase", verify.diffOngoingSampledTrack(liveBelt, phased).length === 0);
    const slow = { ...JSON.parse(JSON.stringify(liveBelt)), keyframes: beltKf(0, 4) };
    check("diffOngoingSampledTrack: the wrong velocity fails naming the LAW", /ongoing tx velocity .*motion LAW/.test(verify.diffOngoingSampledTrack(liveBelt, slow)[0] || ""));
    const reversed = { ...JSON.parse(JSON.stringify(liveBelt)), keyframes: beltKf(100, -8) };
    check("diffOngoingSampledTrack: the wrong direction fails by name", verify.diffOngoingSampledTrack(liveBelt, reversed).some((m) => /velocity|direction/.test(m)));

    const split = verify.splitCloneRecord(record({ framesN: 9 }), 5);
    check("splitCloneRecord: in-window keeps exactly the clip frames; the tail rides WITH the boundary sample", split.inWindow.frames === 5 &&
      split.inWindow.elements.every((el) => el.samples.length === 5) &&
      split.post[".belt"].transform.length === 5 && split.post[".belt"].transform[0] === "matrix(1, 0, 0, 1, 40, 0)");
    const frozen = verify.splitCloneRecord(record({ framesN: 9, beltPostVel: 0 }), 5);
    const postVerdict = verify.verifyPostWindow([liveBelt], frozen.post, {}, { stepMs: 20, frames: 4 });
    check("verifyPostWindow: live ongoing + clone static → named \"unterminated motion\"", !postVerdict.ok &&
      /^unterminated motion: live continues past the clip, clone froze/.test(postVerdict.firstMismatch || ""));
    const moving = verify.verifyPostWindow([liveBelt], split.post, {}, { stepMs: 20, frames: 4 });
    check("verifyPostWindow: a clone still moving at the fitted velocity passes with the law receipted", moving.ok &&
      moving.tracks[0].cloneMoving === true && moving.tracks[0].expectedPerFrame.value === 8);
  }

  // ── pxOwnerProbe: the ONE-OWNER gate's in-page half, in a mock DOM ────────────
  {
    const CAPTURE = require.resolve(path.join(__dirname, "..", "tools", "browser-capture.js"));
    const kitAnim = { id: "pingfusi:motion-replay", canceled: false, cancel() { this.canceled = true; } };
    const el = {
      attrs: { style: "" },
      computed: { transform: "matrix(1, 0, 0, 1, 0, 0)" },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    };
    global.window = global;
    global.document = { querySelectorAll: (sel) => (sel === ".hero" ? [el] : []), getAnimations: () => [kitAnim] };
    global.getComputedStyle = (e) => e.computed;
    delete require.cache[CAPTURE];
    require(CAPTURE);
    const quiet = await global.pxOwnerProbe({ selectors: [".hero", ".ghost"], durationMs: 120 });
    check("pxOwnerProbe: a quiet element reports NO change; the kit's own tagged replay is cancelled, never reported as a competitor", quiet.changed.length === 0 &&
      quiet.elements === 1 && quiet.missing.join(",") === ".ghost" && kitAnim.canceled === true && quiet.ownCancelled >= 1);
    const mover = setTimeout(() => {
      el.computed.transform = "matrix(1, 0, 0, 1, 40, 0)";
      el.attrs.style = "transform: translateX(40px)";
    }, 45);
    const busy = await global.pxOwnerProbe({ selectors: [".hero"], durationMs: 200 });
    clearTimeout(mover);
    check("pxOwnerProbe: a competing writer is reported by selector, for BOTH the inline style and the computed transform", busy.changed.length === 2 &&
      busy.changed.every((c) => c.selector === ".hero") && busy.changed.some((c) => c.prop === "transform") && busy.changed.some((c) => c.prop === "inline-style"));

    // ── THE VANTAGE RULE: a visibility-gated writer below the fold ────────────────
    // The encoded miss: the clone's belt writer only advances while its rail is in the
    // viewport (rail at document-top 13725px, seen live) — a probe watching from
    // scroll 0 reported CLEAN and the ONE-OWNER gate gave a false all-clear. The probe
    // must scroll each watched element into view before observing. This fixture FAILS
    // without that change (no scroll → the writer never arms → clean) and PASSES with it.
    {
      let beltX = -400;
      const belt = {
        attrs: { style: `transform: translate3d(${beltX}px, 0px, 0px);` },
        computed: { transform: `matrix(1, 0, 0, 1, ${beltX}, 0)` },
        getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
        getBoundingClientRect() { return { top: 5000 - global.scrollY, height: 200 }; },
      };
      global.innerHeight = 800;
      global.scrollX = 0;
      global.scrollY = 0;
      global.scrollTo = (x, y) => { global.scrollX = x; global.scrollY = y; };
      global.document.querySelectorAll = (sel) => (sel === ".hero" ? [el] : sel === ".belt" ? [belt] : []);
      const writer = setInterval(() => {
        if (global.scrollY + global.innerHeight > 5000 - 150 && global.scrollY < 5000 + 200 + 150) {
          beltX += 4; // in view: the belt advances — exactly the fixes.js §8 pattern
          belt.attrs.style = `transform: translate3d(${beltX}px, 0px, 0px);`;
          belt.computed.transform = `matrix(1, 0, 0, 1, ${beltX}, 0)`;
        }
      }, 10);
      const gated = await global.pxOwnerProbe({ selectors: [".belt"], durationMs: 200 });
      clearInterval(writer);
      check("pxOwnerProbe: a writer gated on its element being IN VIEW is caught — the probe scrolls each watched element into view before observing (the false-all-clear miss)",
        gated.changed.length >= 1 && gated.changed.every((c) => c.selector === ".belt") && gated.scrolled === true &&
        Array.isArray(gated.groups) && gated.groups.length === 1 && gated.groups[0].scrolled === true, JSON.stringify(gated).slice(0, 300));
      check("pxOwnerProbe: the original scroll position is restored after the probe", global.scrollY === 0 && global.scrollX === 0);

      // Elements beyond the group cap are UNWATCHED by name, never a silent all-clear.
      const far = [];
      global.document.querySelectorAll = (sel) => {
        const m = /^\.g(\d)$/.exec(sel);
        if (!m) return [];
        const top = +m[1] * 1000;
        if (!far[+m[1]]) far[+m[1]] = { attrs: {}, computed: {}, getAttribute() { return null; }, getBoundingClientRect() { return { top: top - global.scrollY, height: 10 }; } };
        return [far[+m[1]]];
      };
      const capped = await global.pxOwnerProbe({ selectors: [".g0", ".g1", ".g2", ".g3", ".g4", ".g5", ".g6"], durationMs: 50, maxGroups: 2 });
      check("pxOwnerProbe: elements beyond maxGroups viewport groups are reported unwatched (a partial watch cannot clear them)",
        capped.groups.length === 2 && capped.unwatched.length === 5 && capped.unwatched.every((u) => /^\.g[0-9]$/.test(u.selector)), JSON.stringify({ groups: capped.groups, unwatched: capped.unwatched }));
      delete global.innerHeight;
      delete global.scrollX;
      delete global.scrollY;
      delete global.scrollTo;
    }
    delete global.document;
    delete global.getComputedStyle;
    delete global.window;
  }

  // ── apply-sampled CLI: quarantine + missing-evidence refusals ─────────────────
  {
    const noArgs = await run(APPLY, [], work);
    check("apply: no args → usage, exit 2", noArgs.code === 2 && /usage/.test(noArgs.out));
    makeTarget(work, "tq", { items: [{ id: "auto-1", kind: "marquee", status: "sampled", scope: ".hero", source: "behavior-capture" }] });
    const undeclared = await run(APPLY, ["tq", "auto-1"], work);
    check("apply: an undeclared item is refused (exit 2) pointing at the ownership remedy", undeclared.code === 2 && /never operator-declared/.test(undeclared.out) && /motion-items\.json/.test(undeclared.out));
    makeTarget(work, "tn", { items: [declaredItem({ scope: ".ghost" })] });
    const noTracks = await run(APPLY, ["tn", "m1"], work);
    check("apply: an item without sampled tracks exits 1 pointing at motion sample", noTracks.code === 1 && /no sampled tracks/.test(noTracks.out) && /motion sample tn m1/.test(noTracks.out));
    const { dir: tcDir } = makeTarget(work, "tc", { items: [declaredItem()] });
    fs.rmSync(path.join(tcDir, "clone", "index.html"));
    const noClone = await run(APPLY, ["tc", "m1"], work);
    check("apply: a missing clone/index.html exits 1 pointing at capture-build", noClone.code === 1 && /clone\/index\.html/.test(noClone.out) && /capture-build tc/.test(noClone.out));
  }

  // ── apply-sampled CLI: a clip is NOT an implementation for ongoing motion ─────
  {
    const { dir, beltTrack } = makeTarget(work, "to", { items: [declaredItem({ scope: ".belt" })] });
    setTrackIds(dir, { m1: [beltTrack.id] });
    // strip the lifted fit: ongoing motion with nothing periodic to loop by
    const doc = readJson(path.join(dir, "motion-doc.json"));
    for (const track of doc.tracks) if (track.target.selector === ".belt") delete track.fit;
    fs.writeFileSync(path.join(dir, "motion-doc.json"), JSON.stringify(doc, null, 2));
    const r = await run(APPLY, ["to", "m1"], work); // no --attach: the refusal must come BEFORE any Chrome
    check("apply REFUSES a one-shot clip for an ongoing track with no periodic fit, by name", r.code === 1 &&
      /ongoing motion with no periodic fit — trace longer, or declare the loop form/.test(r.out), r.out.slice(0, 500));
    const receipt = readJson(path.join(dir, "motion", "m1", "apply-sampled.json"));
    check("the refusal is receipted naming the unloopable selector; nothing was written to the clone", receipt.ok === false &&
      receipt.unloopable[0].selector === ".belt" && !fs.existsSync(path.join(dir, "clone", "motion-replay.js")) &&
      !/motion-replay/.test(fs.readFileSync(path.join(dir, "clone", "index.html"), "utf8")));
    check("the item was not advanced by a refusal", readJson(path.join(dir, "motion-items.json")).items[0].status === "sampled");
  }

  // ── apply-sampled CLI: the ONE-OWNER probe refuses a competing writer ─────────
  {
    const { dir, heroTrack } = makeTarget(work, "tw", { items: [declaredItem()] });
    setTrackIds(dir, { m1: [heroTrack.id] });
    const server = await fakeChrome([{ ownerProbe: {
      schema: "pingfusi/owner-probe@1", durationMs: 1000, ticks: 10, elements: 1, missing: [], ownCancelled: 0,
      changed: [{ selector: ".hero", index: 0, prop: "transform", from: "none", to: "matrix(1, 0, 0, 1, 9, 0)", atMs: 120 }],
    } }]);
    const r = await run(APPLY, ["tw", "m1", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("apply REFUSES when the owner probe sees another implementation writing the element, naming the selector", r.code === 1 &&
      /another implementation owns \.hero/.test(r.out) && /never stacks implementations/.test(r.out), r.out.slice(0, 500));
    const receipt = readJson(path.join(dir, "motion", "m1", "apply-sampled.json"));
    check("the owner-probe refusal is receipted with the competing writer's evidence; the clone is untouched", receipt.ok === false &&
      receipt.ownerProbe.changed[0].selector === ".hero" && !fs.existsSync(path.join(dir, "clone", "motion-replay.js")) &&
      !/motion-replay/.test(fs.readFileSync(path.join(dir, "clone", "index.html"), "utf8")));
    server.close();
  }

  // ── apply-sampled CLI: the generated player + idempotent marker + receipts ────
  const t1 = makeTarget(work, "t1", { items: [
    declaredItem(),
    declaredItem({ id: "m2", scope: ".fade", trigger: "scroll-to:.fade", status: "sampled" }),
  ] });
  {
    setTrackIds(t1.dir, { m1: [t1.heroTrack.id], m2: [t1.fadeTrack.id] });
    const server = await fakeChrome([{}]);
    const addr = `127.0.0.1:${server.address().port}`;

    const r = await run(APPLY, ["t1", "m1", "--attach", addr], work);
    const replayFile = path.join(t1.dir, "clone", "motion-replay.js");
    check("apply m1 exits 0 and emits clone/motion-replay.js", r.code === 0 && /applied-sampled/.test(r.out) && fs.existsSync(replayFile), r.out.slice(0, 500));
    check("the owner probe ran against the SERVED clone before anything was written", server.calls.some((c) => c.key === "owner-probe") &&
      /^http:\/\/127\.0\.0\.1:/.test((server.calls.find((c) => c.key === "navigate") || {}).url || ""));
    let parseErr = null;
    try { execFileSync("node", ["--check", replayFile], { stdio: "pipe" }); } catch (e) { parseErr = String(e.stderr || e.message); }
    check("the generated player parses (node --check)", parseErr === null, parseErr);
    const source = fs.readFileSync(replayFile, "utf8");
    check("the player carries the header receipt: schema, doc hash, track fingerprints", /pingfusi\/motion-replay@2/.test(source) &&
      source.includes(t1.heroTrack.id) && source.includes(motionDoc.trackFingerprint(t1.heroTrack).slice(0, 16)) && /sha256_16/.test(source));
    // The clip runtime carries optional exact engine parameters for the build motion
    // pass (iterations/direction/easing); a sampled payload without them must keep the
    // old defaults — iterations resolves to 1, fill stays "none", release on finish.
    check("finite clips RELEASE: fill \"none\" + onfinish, never a fill:\"forwards\" squat", /iterations, direction: track\.direction \|\| "normal", fill: "none"/.test(source) &&
      /track\.iterations > 0 \? track\.iterations : 1/.test(source) &&
      /onfinish/.test(source) && !/fill: "forwards"/.test(source) && /"duration": 100/.test(source));
    check("every player animation is tagged as the kit's own (one owner, recognizable)", source.includes('"pingfusi:motion-replay"'));
    const html1 = fs.readFileSync(path.join(t1.dir, "clone", "index.html"), "utf8");
    check("index.html gains the marker block with the script tag, before </body>", (html1.match(/pingfusi:motion-replay:begin/g) || []).length === 1 &&
      /<script src="motion-replay\.js" defer><\/script>/.test(html1) && html1.indexOf("motion-replay:begin") < html1.toLowerCase().lastIndexOf("</body>"));
    check("other markup is untouched", html1.includes('<div class="hero"></div>') && html1.includes('<div class="fade"></div>'));

    const items1 = readJson(path.join(t1.dir, "motion-items.json")).items;
    check("item m1 → NON-terminal \"applied-sampled\" with its receipt path", items1[0].status === "applied-sampled" && /apply-sampled\.json$/.test(items1[0].applyReceipt));
    const receipt = readJson(path.join(t1.dir, "motion", "m1", "apply-sampled.json"));
    check("apply receipt: schema, replay hash, script-tag action, per-track mode, clean owner probe", receipt.schema === "pingfusi/motion-apply-sampled@1" &&
      receipt.ok === true && receipt.html.scriptTag === "inserted" && receipt.tracks.length === 1 && receipt.tracks[0].id === t1.heroTrack.id &&
      receipt.tracks[0].mode === "clip" && receipt.ownerProbe.changed.length === 0 && receipt.ownerProbe.replayHeld === false);
    const ledger = fs.readFileSync(path.join(t1.dir, "workflow.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    check("workflow.jsonl receipted the apply with the owner-probe verdict", ledger.some((l) => l.event === "motion-apply-sampled" && l.item === "m1" && /owner probe clean/.test(l.reason)));

    // applying the SECOND item regenerates one player carrying BOTH, one marker block
    const r2 = await run(APPLY, ["t1", "m2", "--attach", addr], work);
    const source2 = fs.readFileSync(replayFile, "utf8");
    const html2 = fs.readFileSync(path.join(t1.dir, "clone", "index.html"), "utf8");
    check("apply m2 regenerates the player with both items' tracks — m1's replay survives", r2.code === 0 &&
      source2.includes(t1.heroTrack.id) && source2.includes(t1.fadeTrack.id), r2.out.slice(0, 400));
    check("m2's scroll trigger arms an IntersectionObserver on its declared selector", /"start": "scroll"/.test(source2) && /"observe": "\.fade"/.test(source2) && /IntersectionObserver/.test(source2));
    check("re-running replaces its own block only — still exactly one marker, one script tag", (html2.match(/pingfusi:motion-replay:begin/g) || []).length === 1 &&
      (html2.match(/<script src="motion-replay\.js"/g) || []).length === 1 && html2.includes('<div class="hero"></div>'));
    check("the re-apply's owner probe HELD the kit's own previous replay aside (receipted, and restored after)", readJson(path.join(t1.dir, "motion", "m2", "apply-sampled.json")).ownerProbe.replayHeld === true &&
      fs.existsSync(replayFile) && !fs.existsSync(`${replayFile}.owner-probe-hold`));
    server.close();
  }

  // ── the EMITTED player, exercised in a mock DOM (the fixture-42 harness pattern) ──
  {
    const t2 = makeTarget(work, "t2", { items: [
      declaredItem(),
      declaredItem({ id: "mb", scope: ".belt" }),
    ] });
    setTrackIds(t2.dir, { m1: [t2.heroTrack.id], mb: [t2.beltTrack.id] });
    const server = await fakeChrome([{}]);
    const addr = `127.0.0.1:${server.address().port}`;
    const r1 = await run(APPLY, ["t2", "m1", "--attach", addr], work);
    const r2 = await run(APPLY, ["t2", "mb", "--attach", addr], work);
    check("apply: a finite clip and an ongoing loop coexist in one player", r1.code === 0 && r2.code === 0, (r1.out + r2.out).slice(0, 500));
    const source = fs.readFileSync(path.join(t2.dir, "clone", "motion-replay.js"), "utf8");

    const mockEl = (over = {}) => {
      const el = {
        scrollWidth: 800, scrollHeight: 640, style: {},
        _anims: [],
        animate(keyframes, timing) {
          const a = { keyframes, timing, id: null, onfinish: null, canceled: false, cancel() { this.canceled = true; } };
          el._anims.push(a);
          return a;
        },
        getAnimations() { return el._anims.filter((a) => !a.canceled); },
      };
      return Object.assign(el, over);
    };
    const exec = (els) => {
      vm.runInNewContext(source, {
        document: { readyState: "complete", addEventListener: () => {}, querySelectorAll: (sel) => (els[sel] ? els[sel].slice() : []) },
      });
      return els;
    };

    const hero = mockEl();
    const belt = mockEl({ scrollWidth: 800 });
    exec({ ".hero": [hero], ".belt": [belt] });
    const heroAnim = hero._anims[0];
    const beltAnim = belt._anims[0];
    check("EMITTED clip: element.animate one pass with fill \"none\", tagged, onfinish armed", !!heroAnim &&
      heroAnim.timing.iterations === 1 && heroAnim.timing.fill === "none" && heroAnim.timing.duration === 100 &&
      heroAnim.id === "pingfusi:motion-replay" && typeof heroAnim.onfinish === "function");
    check("EMITTED loop: iterations Infinity, linear, driven by the fitted velocity with the wrap distance from the ELEMENT (scrollWidth/2)", !!beltAnim &&
      beltAnim.timing.iterations === Infinity && beltAnim.timing.easing === "linear" && beltAnim.timing.fill === "none" &&
      beltAnim.timing.duration === 1000 && beltAnim.keyframes[0].transform === "translateX(0px)" && beltAnim.keyframes[1].transform === "translateX(400px)" &&
      beltAnim.id === "pingfusi:motion-replay");
    const wide = mockEl({ scrollWidth: 1600 });
    exec({ ".belt": [wide] });
    check("EMITTED loop measures at RUNTIME: double the scroll span → double the period (same velocity), never the clip's geometry", wide._anims[0].timing.duration === 2000 &&
      wide._anims[0].keyframes[1].transform === "translateX(800px)");
    heroAnim.onfinish();
    check("EMITTED release-on-finish: as sole owner the final frame is committed inline, then the animation is CANCELLED", hero.style.transform === "matrix(1, 0, 0, 1, 30, 0)" && heroAnim.canceled === true);
    const hero2 = mockEl();
    exec({ ".hero": [hero2] });
    hero2._anims.push({ id: "site-owned", canceled: false }); // a competing writer appears before finish
    hero2._anims[0].onfinish();
    check("EMITTED release-on-finish: with another writer present nothing is committed — released, never stacked", hero2.style.transform === undefined && hero2._anims[0].canceled === true);
    const hero3 = mockEl();
    exec({ ".hero": [hero3] });
    hero3.style.transform = "translateX(5px)"; // an inline value someone else already owns
    hero3._anims[0].onfinish();
    check("EMITTED release-on-finish: an existing inline value is never overwritten", hero3.style.transform === "translateX(5px)" && hero3._anims[0].canceled === true);
    server.close();
  }

  // ── verify-sampled CLI: quarantine before Chrome ──────────────────────────────
  {
    makeTarget(work, "vq", { items: [{ id: "auto-1", kind: "marquee", status: "applied-sampled", scope: ".hero", source: "behavior-capture" }] });
    const server = await fakeChrome([{}]);
    const r = await run(VERIFY, ["--sampled", "vq", "auto-1", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("verify: an undeclared item is refused (exit 2) before any tab is opened", r.code === 2 && /never operator-declared/.test(r.out) && server.tabCount() === 0);
    server.close();
  }
  {
    const { dir } = makeTarget(work, "vr", { items: [declaredItem({ status: "applied-sampled", sampledTrackIds: undefined })] });
    fs.rmSync(path.join(dir, "motion", "m1", "sample.json"));
    const r = await run(VERIFY, ["--sampled", "vr", "m1"], work);
    check("verify: a missing sample.json names the stimulus contract and points at motion sample", r.code === 1 && /sample\.json/.test(r.out) && /motion sample vr m1/.test(r.out));
    const badPost = await run(VERIFY, ["--sampled", "vr", "m1", "--post-window", "0"], work);
    check("verify: a malformed --post-window is refused with its meaning", badPost.code === 2 && /--post-window must be an integer/.test(badPost.out));
  }

  // ── verify-sampled CLI: green — identical stimulus + post-window, matching series ──
  const v1 = makeTarget(work, "v1", { items: [declaredItem({ status: "applied-sampled" })] });
  {
    setTrackIds(v1.dir, { m1: [v1.heroTrack.id] });
    const server = await fakeChrome([{ record: record({ framesN: 9 }) }]);
    const r = await run(VERIFY, ["--sampled", "v1", "m1", "--post-window", "4", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("a matching clone re-sample exits 0 as verified-sampled, no review round", r.code === 0 && /verified-sampled/.test(r.out) && /no review round/.test(r.out), r.out.slice(0, 600));
    const calls = server.calls;
    check("the clone was sampled under the identical virtual-time stimulus PLUS the post-window (5 in-window + 4 past the clip end, one clock)", calls.some((c) => c.key === "vt:pause") &&
      calls.filter((c) => c.key === "step").map((c) => c.t).join(",") === "20,40,60,80,100,120,140,160,180");
    check("the recorder start names the sample receipt's scope and props", /"scopes":\[".hero"\]/.test((calls.find((c) => c.key === "start") || {}).expression || "") &&
      /"props":\["transform","opacity","filter","visibility"\]/.test((calls.find((c) => c.key === "start") || {}).expression || ""));
    const item = readJson(path.join(v1.dir, "motion-items.json")).items[0];
    check("item → TERMINAL \"verified-sampled\" with its receipt path", item.status === "verified-sampled" && /verify-sampled\.json$/.test(item.verifySampledReceipt));
    const receipt = readJson(path.join(v1.dir, "motion", "m1", "verify-sampled.json"));
    check("verify receipt: schema, documented tolerance, both clock modes, per-track verdicts", receipt.schema === "pingfusi/verify-sampled@1" &&
      receipt.ok === true && receipt.tolerance.translatePx === 1 && receipt.tolerance.opacity === 0.02 &&
      receipt.virtualTime.clone.mode === "virtual-time" && receipt.virtualTime.live.mode === "virtual-time" &&
      receipt.tracks.length === 1 && receipt.tracks[0].docTrackId === v1.heroTrack.id && receipt.tracks[0].ok === true);
    check("the post-window verdict is receipted: settled track held its settle value past the clip end", receipt.postWindow.frames === 4 &&
      receipt.postWindow.ok === true && receipt.postWindow.tracks[0].cloneMoving === false && /post-window/.test(r.out));
    const cloneDoc = readJson(path.join(v1.dir, "motion-doc-clone-sampled.json"));
    check("the clone-side sampled doc holds only the IN-WINDOW frames and validates", (() => {
      try { motionDoc.validateMotionDoc(cloneDoc); } catch (_) { return false; }
      return cloneDoc.tracks.length === 3 && cloneDoc.tracks.every((t) => t.keyframes.length === 5);
    })());
    const ledger = fs.readFileSync(path.join(v1.dir, "workflow.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    check("workflow.jsonl receipted the verification including the post-window", ledger.some((l) => l.event === "motion-verify-sampled" && l.item === "m1" && /frame-by-frame/.test(l.reason) && /past the clip end/.test(l.reason)));
    server.close();
  }

  // ── sub-tolerance drift still verifies; a real miss fails naming track+frame ──
  {
    const server = await fakeChrome([{ record: record({ framesN: 9, heroTx3: 30.5 }) }]);
    const r = await run(VERIFY, ["--sampled", "v1", "m1", "--post-window", "4", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("0.5px per-frame drift is inside the documented ±1px and stays green", r.code === 0, r.out.slice(0, 400));
    server.close();
  }
  {
    const server = await fakeChrome([{ record: record({ framesN: 9, heroTx3: 60 }) }]);
    const r = await run(VERIFY, ["--sampled", "v1", "m1", "--post-window", "4", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("a 30px miss exits 1 naming the first offending track+frame with both sides", r.code === 1 &&
      /\.hero transform: frame 2 translate live=\(30, 0\) clone=\(60, 0\)/.test(r.out) && /±1px/.test(r.out), r.out.slice(0, 600));
    const item = readJson(path.join(v1.dir, "motion-items.json")).items[0];
    check("the previously green item reopens to applied-sampled — stale verification cannot survive", item.status === "applied-sampled" &&
      item.lastVerifySampled && item.lastVerifySampled.ok === false && /frame 2/.test(item.lastVerifySampled.firstMismatch));
    check("the failing diff is still receipted", readJson(path.join(v1.dir, "motion", "m1", "verify-sampled.json")).ok === false);
    server.close();
  }

  // ── a finite clip must RELEASE: a clone still animating past the clip fails ───
  {
    const server = await fakeChrome([{ record: record({ framesN: 9, heroPostVel: 5 }) }]);
    const r = await run(VERIFY, ["--sampled", "v1", "m1", "--post-window", "4", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("live settled + clone still moving past the clip → exit 1 by name (the in-window diff alone would have passed this)", r.code === 1 &&
      /keeps animating past the clip while live settled/.test(r.out), r.out.slice(0, 600));
    check("the post-window failure is receipted as such", (() => {
      const receipt = readJson(path.join(v1.dir, "motion", "m1", "verify-sampled.json"));
      return receipt.ok === false && receipt.postWindow.ok === false && receipt.tracks.every((t) => t.ok);
    })());
    server.close();
  }

  // ── a clone that does not animate fails coverage by name, status untouched ────
  {
    const server = await fakeChrome([{ record: record({ framesN: 9, heroStatic: true }) }]);
    const r = await run(VERIFY, ["--sampled", "v1", "m1", "--post-window", "4", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("a static clone series fails coverage: no sampled track on the clone, by name", r.code === 1 && /no sampled "transform" track on the clone for selector \.hero/.test(r.out) && /apply-sampled/.test(r.out));
    check("the non-terminal item keeps its applied-sampled checkpoint on failure", readJson(path.join(v1.dir, "motion-items.json")).items[0].status === "applied-sampled");
    server.close();
  }

  // ── the ONGOING belt: the encoded miss and its gate ───────────────────────────
  const vb = makeTarget(work, "vb", { items: [declaredItem({ status: "applied-sampled", scope: ".belt" })] });
  {
    setTrackIds(vb.dir, { m1: [vb.beltTrack.id] });
    // GREEN: the clone's loop runs at its own PHASE (its wrap distance is its own runtime
    // geometry) but at the fitted velocity, in-window AND past the clip end. The old
    // absolute per-frame diff could never pass this — the law comparison is what makes a
    // correct looping implementation verifiable at all.
    const server = await fakeChrome([{ record: record({ framesN: 9, beltPhase: 100 }) }]);
    const r = await run(VERIFY, ["--sampled", "vb", "m1", "--post-window", "4", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("an ongoing track verifies by MOTION LAW: phase-shifted clone loop at the fitted velocity is green", r.code === 0 && /verified-sampled/.test(r.out), r.out.slice(0, 600));
    const receipt = readJson(path.join(vb.dir, "motion", "m1", "verify-sampled.json"));
    check("the receipt marks the track ongoing and shows the clone still moving at the expected per-frame law", receipt.tracks[0].ongoing === true &&
      receipt.postWindow.tracks[0].cloneMoving === true && receipt.postWindow.tracks[0].expectedPerFrame.value === 8);
    server.close();
  }
  {
    // THE MISS, encoded: a one-shot clip replays the window perfectly and then freezes.
    // In-window passes; the post-window check is what catches the frozen belt.
    const server = await fakeChrome([{ record: record({ framesN: 9, beltPhase: 100, beltPostVel: 0 }) }]);
    const r = await run(VERIFY, ["--sampled", "vb", "m1", "--post-window", "4", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("UNTERMINATED MOTION: live continues past the clip, clone froze → exit 1 with exactly that name", r.code === 1 &&
      /unterminated motion: live continues past the clip, clone froze/.test(r.out), r.out.slice(0, 600));
    const item = readJson(path.join(vb.dir, "motion-items.json")).items[0];
    check("the previously green belt item reopens to applied-sampled; the edge failure is receipted", item.status === "applied-sampled" &&
      readJson(path.join(vb.dir, "motion", "m1", "verify-sampled.json")).postWindow.ok === false);
    server.close();
  }
  {
    // wrong velocity past the clip end: moving, but not at the fitted law
    const server = await fakeChrome([{ record: record({ framesN: 9, beltPhase: 100, beltPostVel: 3 }) }]);
    const r = await run(VERIFY, ["--sampled", "vb", "m1", "--post-window", "4", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("a clone moving past the clip at the WRONG velocity fails naming both velocities", r.code === 1 &&
      /wrong velocity/.test(r.out) && /3\.000px\/frame vs fitted 8\.000px\/frame/.test(r.out), r.out.slice(0, 600));
    server.close();
  }

  fs.rmSync(work, { recursive: true, force: true });
  console.log(failed ? `\n❌ motion-verify-selftest: ${failed} check(s) failed.` : "\n✓ motion-verify-selftest: all checks pass.");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("motion-verify-selftest crashed:", e); process.exit(1); });
