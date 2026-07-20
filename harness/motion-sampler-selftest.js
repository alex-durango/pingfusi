// harness/motion-sampler-selftest.js — guards the SAMPLED tier's virtual-time runner
// (`pingfusi motion sample`).
//
// OFFLINE (always runs): the full command against a fake Chrome — the virtual-time calls
// asserted IN ORDER (pause before navigation, a bounded load budget, one advance per
// settle/dwell/frame), dense records becoming sampled-tier tracks merged into
// motion-doc.json, the static-element drop receipted, style writes merged as provenance
// evidence, the tier-3 fit LIFT riding on the track, --verify-determinism running the
// whole capture twice (identical → receipt; differing → named refusal, nothing merged),
// the hooked-clock fallback when the target refuses virtual time, and the quarantine line:
// an item that was never operator-declared is refused before Chrome is even contacted.
"use strict";

// The fake Chrome has no wall-side races to absorb — zero out the wall barrier and the
// freeze-step so the offline suite stays fast; the receipt assertion below proves the
// override plumbing (and therefore the receipt honesty) instead.
process.env.PPK_MOTION_BARRIER_MS = "0";
process.env.PPK_MOTION_FREEZE_MS = "0";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFile } = require("child_process");
const { acceptKeyFor } = require("./cdp.js");
const { validateMotionDoc } = require("./motion-doc.js");
const sampler = require("./motion-sampler.js");

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
};

// ── fake Chrome (same server-half RFC6455 as capture-runner-selftest) ─────────
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

// The canned pxDenseRecordStop() record: `.hero` moves on transform (its other props are
// static — 3 drops), `.backdrop` never changes (4 drops). One inline-style write hits the
// moving track; the recorder skipped one agent-overlay element.
const MOVING = (i) => `matrix(1, 0, 0, 1, ${i * 10}, 0)`;
const denseRecord = (txAt3 = 30) => ({
  frames: 5, stepMs: 20,
  elements: [
    { selector: ".hero", samples: [1, 2, 3, 4, 5].map((i) => ({ t: i * 20, values: {
      transform: MOVING(i === 3 ? txAt3 / 10 : i), opacity: "1", filter: "none", visibility: "visible" } })) },
    { selector: ".backdrop", samples: [1, 2, 3, 4, 5].map((i) => ({ t: i * 20, values: {
      transform: "none", opacity: "0.5", filter: "none", visibility: "visible" } })) },
  ],
  writes: [{ t: 40, selector: ".hero", prop: "transform", value: "translateX(20px)" }],
  truncated: false, skipped: { agentDom: 1 }, writesObserved: true,
});
const STATIC_RECORD = {
  frames: 5, stepMs: 20,
  elements: [{ selector: ".hero", samples: [1, 2, 3, 4, 5].map((i) => ({ t: i * 20, values: { transform: "none", opacity: "1" } })) }],
  writes: [], truncated: false, skipped: { agentDom: 0 }, writesObserved: true,
};

function fakeChrome(script) {
  let tabN = 0;
  const calls = []; // ordered {tab, key, ...} log of everything the selftest asserts on
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
    let stepCount = 0;
    let vnow = 1000; // fake virtual clock: at "load" already; advances/clock-steps move it
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
        const replyError = (message) => socket.write(serverFrame(0x1, JSON.stringify({ id: msg.id, error: { message } })));
        const event = (method, params) => socket.write(serverFrame(0x1, JSON.stringify({ method, params: params || {} })));
        const value = (v) => reply({ result: { type: typeof v, value: v } });
        if (msg.method === "Emulation.setVirtualTimePolicy") {
          const p = msg.params || {};
          if (acts.vt === "refuse") { calls.push({ tab, key: `vt:${p.policy}(refused)` }); replyError("'Emulation.setVirtualTimePolicy' wasn't found"); continue; }
          if (p.policy === "advance" && typeof p.budget === "number") vnow += p.budget;
          calls.push({ tab, key: `vt:${p.policy}`, budget: p.budget, initial: p.initialVirtualTime, waitForNavigation: p.waitForNavigation });
          reply({ virtualTimeTicksBase: 0 });
          if (p.policy === "advance" || p.policy === "pauseIfNetworkFetchesPending") event("Emulation.virtualTimeBudgetExpired");
        } else if (msg.method === "HeadlessExperimental.beginFrame") {
          replyError("'HeadlessExperimental.beginFrame' wasn't found"); // the normal case — budget-advance only
        } else if (msg.method === "Page.addScriptToEvaluateOnNewDocument") {
          calls.push({ tab, key: "hook-install", source: String((msg.params || {}).source || "") });
          reply({ identifier: "s1" });
        } else if (msg.method === "Emulation.setDeviceMetricsOverride") {
          calls.push({ tab, key: "metrics", params: msg.params });
          reply({});
        } else if (msg.method === "Network.setCacheDisabled") {
          calls.push({ tab, key: "cache-disabled", params: msg.params });
          reply({});
        } else if (msg.method === "Fetch.enable") {
          calls.push({ tab, key: "fetch-enable", params: msg.params });
          reply({});
        } else if (msg.method === "Page.navigate") {
          calls.push({ tab, key: "navigate", url: (msg.params || {}).url });
          reply({ frameId: "F1" });
          event("Page.loadEventFired");
        } else if (msg.method === "Runtime.evaluate") {
          const e = msg.params.expression;
          if (e.includes("__ppkProbe")) value(acts.probe || GOOD_PROBE);
          else if (e.includes("iw: innerWidth")) value(acts.viewportRead || { iw: 1440, cw: 1440, ih: 982, dpr: 2 });
          else if (e === "typeof pxDenseRecordStart") value("function");
          else if (e.startsWith("pxDenseRecordStart(")) {
            calls.push({ tab, key: "start", expression: e });
            value(acts.start || { tracking: 2, writesObserved: true, truncated: false, skipped: { agentDom: 1 } });
          } else if (e.startsWith("pxDenseRecordStep(")) {
            calls.push({ tab, key: "step", t: +/\(([\d.]+)\)/.exec(e)[1] });
            value({ frame: ++stepCount, truncated: false });
          } else if (e.startsWith("pxDenseRecordStop")) {
            value(typeof acts.record === "function" ? acts.record(tab) : acts.record || denseRecord());
          } else if (e.startsWith("__ppkClockStep(")) {
            calls.push({ tab, key: "clock-step", ms: +/\(([\d.]+)\)/.exec(e)[1] });
            value(0);
          } else if (e.includes("getBoundingClientRect")) {
            value({ top: 120, height: 600 });
          } else if (e.startsWith("Math.max((document.documentElement.scrollHeight")) {
            value(0);
          } else if (e.startsWith("performance.getEntriesByType")) {
            value(acts.resources == null ? 7 : acts.resources); // the record-start telemetry read
          } else if (e.startsWith("(() => { const nav = performance.getEntriesByType")) {
            value({ now: vnow, load: 1000, dcl: 900, readyState: "complete" }); // load fired at 1000, on-grid
          } else if (e === "performance.now()") {
            value(vnow);
          } else if (e === "window.__ppkN") {
            value(acts.frameDrive == null ? 12 : acts.frameDrive); // the frame-drive probe: 12 → virtual time drives frames
          } else if (e === "document.readyState") {
            value(acts.readyState || "complete");
          } else reply({ result: { type: "undefined" } }); // injection, instant scrolls, …
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

const samplerPath = path.join(__dirname, "motion-sampler.js");
function run(args, cwd) {
  return new Promise((resolve) => {
    execFile("node", [samplerPath, ...args], { cwd }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: String(stdout) + String(stderr) });
    });
  });
}
function makeTarget(work, name, items) {
  const dir = path.join(work, "targets", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "target.json"), JSON.stringify({ name, url: "http://fake-live/", width: 1440 }));
  fs.writeFileSync(path.join(dir, "motion-items.json"), JSON.stringify({ schema: "pingfusi/motion-items@1", items }));
  return dir;
}
const declaredItem = (over = {}) => ({ id: "m1", capability: "motion", kind: "raf", status: "pending", trigger: "load", scope: ".hero", declaredBy: "manual", ...over });

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-sampler-"));

  // ── pure helpers ──────────────────────────────────────────────────────────────
  check("parseTrigger: scroll-through parses selector/steps/dwell from the end", (() => {
    const t = sampler.parseTrigger("scroll-through:.rail/3/100");
    return t.kind === "scroll-through" && t.selector === ".rail" && t.steps === 3 && t.dwellMs === 100;
  })());
  check("parseTrigger: interactive triggers refused by name, never degraded to load", (() => {
    try { sampler.parseTrigger("hover:.x"); return false; } catch (e) { return /not samplable/.test(e.message); }
  })());
  check("parseTrigger: malformed scroll-through refused with the expected shape", (() => {
    try { sampler.parseTrigger("scroll-through:.rail/3"); return false; } catch (e) { return /steps.*dwell|<selector>\/<steps>\/<dwellMs>/.test(e.message); }
  })());
  const ch = sampler.parseTransformChannels("matrix(1, 0, 0, 1, 12, -4)");
  check("parseTransformChannels: 2d matrix decomposes to tx/ty/sx/sy/rot", ch && ch.tx === 12 && ch.ty === -4 && ch.sx === 1 && ch.sy === 1 && ch.rot === 0);
  check("parseTransformChannels: none is identity, non-matrix is null (never guessed)", (() => {
    const id = sampler.parseTransformChannels("none");
    return id.tx === 0 && id.sx === 1 && sampler.parseTransformChannels("translateX(3px)") === null;
  })());
  const series = sampler.sampledSeries(denseRecord());
  check("sampledSeries: one numeric series per changing channel, static props skipped", series.length === 1 && series[0].channel === "tx" && series[0].samples.length === 5 && series[0].samples[0].t === 20 && series[0].samples[4].v === 50);
  check("firstDiff names the first differing path", /elements\.0\.samples\.2\.values\.transform/.test(sampler.firstDiff(denseRecord(), denseRecord(35)) || ""));

  // ── ongoing detection + the marquee tie-break (pure) ──────────────────────────
  const kfTrack = (values, property = "transform") => ({
    property,
    keyframes: values.map((v, i) => ({ offset: values.length === 1 ? 1 : i / (values.length - 1), value: v })),
  });
  const movingAll = kfTrack(Array.from({ length: 20 }, (_, i) => `matrix(1, 0, 0, 1, ${i * 5}, 0)`));
  const settling = kfTrack(Array.from({ length: 20 }, (_, i) => `matrix(1, 0, 0, 1, ${Math.min(i, 16) * 5}, 0)`));
  check("trackIsOngoing: motion through the final frames = ONGOING (no settle was observed)", sampler.trackIsOngoing(movingAll) === true);
  check("trackIsOngoing: a settled tail is finite; sub-noise jitter never qualifies", sampler.trackIsOngoing(settling) === false &&
    sampler.trackIsOngoing(kfTrack(Array.from({ length: 20 }, (_, i) => `matrix(1, 0, 0, 1, ${80 + (i % 2) * 0.01}, 0)`))) === false);
  check("trackIsOngoing: an ongoing discrete blinker (visibility) counts — inequality is motion", sampler.trackIsOngoing(kfTrack(Array.from({ length: 20 }, (_, i) => (i % 2 ? "visible" : "hidden")), "visibility")) === true);
  const linSeries = (slope) => ({ channel: "tx", samples: [1, 2, 3, 4, 5].map((i) => ({ t: i * 20, v: 10 + (i - 1) * slope })) });
  const mq = sampler.marqueeFromSeries(linSeries(10));
  check("marqueeFromSeries: constant velocity → marquee (velocity px/s, direction, axis, window receipt)", !!mq && mq.kind === "marquee" &&
    mq.params.velocityPxPerSec === 500 && mq.params.direction === 1 && mq.params.axis === "x" && mq.params.valueFrom === 10 && mq.params.steadyMs === 80 && mq.nrmse <= 0.1);
  check("marqueeFromSeries: the gates hold — curvature, sub-floor drift, and non-translate channels are refused", (() => {
    const curved = { channel: "tx", samples: [1, 2, 3, 4, 5].map((i) => ({ t: i * 20, v: Math.pow(2, i) * 10 })) };
    const drift = { channel: "tx", samples: [1, 2, 3, 4, 5].map((i) => ({ t: i * 20, v: 10 + i * 0.00005 })) };
    const rot = { channel: "rot", samples: [1, 2, 3, 4, 5].map((i) => ({ t: i * 20, v: i * 10 })) };
    return sampler.marqueeFromSeries(curved) === null && sampler.marqueeFromSeries(drift) === null && sampler.marqueeFromSeries(rot) === null;
  })());

  // ── CLI refusals ──────────────────────────────────────────────────────────────
  const noArgs = await run([], work);
  check("no args → usage, exit 2", noArgs.code === 2 && /usage/.test(noArgs.out));
  makeTarget(work, "t0", [declaredItem()]);
  check("bad --fps named", /--fps must be/.test((await run(["t0", "m1", "--fps", "0"], work)).out));
  check("--frames past the recorder cap named", /--frames must be an integer in 1\.\.2000/.test((await run(["t0", "m1", "--frames", "9999"], work)).out));
  check("missing item named", /has no item "mX"/.test((await run(["t0", "mX"], work)).out));

  // ── the quarantine line: undeclared items are refused before Chrome exists ────
  {
    makeTarget(work, "tq", [{ id: "auto-1", kind: "marquee", trigger: "load", scope: ".belt", source: "behavior-capture" }]);
    const server = await fakeChrome([{}]);
    const r = await run(["tq", "auto-1", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("undeclared item refused (exit 2) pointing at the ownership remedy", r.code === 2 && /never operator-declared/.test(r.out) && /motion-items\.json/.test(r.out));
    check("refusal happens before any tab is opened", server.tabCount() === 0);
    server.close();
  }

  // ── happy path: virtual time in order, records → tracks, receipts everywhere ──
  {
    const dir = makeTarget(work, "t1", [declaredItem()]);
    // a pre-existing doc must be MERGED into, never replaced
    fs.writeFileSync(path.join(dir, "motion-doc.json"), JSON.stringify({
      schema: "pingfusi/motion-doc@1", url: "http://fake-live/", capturedAt: "2026-07-18T00:00:00.000Z",
      viewport: { width: 1440, height: 982, dpr: 2 },
      tracks: [{ id: "css-1", target: { selector: ".loader" }, property: "transform",
        keyframes: [{ offset: 0, value: "rotate(0deg)" }, { offset: 1, value: "rotate(360deg)" }],
        timing: { duration_ms: 1200, delay_ms: 0, iterations: "infinite", direction: "normal", fill: "none" },
        timeline: { type: "document" }, provenance: { tier: "introspected-css", source: "css-animation:spin" } }],
      assets: [],
    }));
    const server = await fakeChrome([{ record: denseRecord() }]);
    const r = await run(["t1", "m1", "--fps", "50", "--frames", "5", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("sample exits 0 and announces the merge", r.code === 0 && /1 track\(s\) merged/.test(r.out), r.out.slice(0, 800));

    // The record tab is tab 1; the frame-drive probe rides its own throwaway tab (2) —
    // the clock/navigation ordering assertions apply to the RECORD tab's calls.
    const allCalls = server.calls;
    const calls = allCalls.filter((c) => c.tab === 1);
    const at = (key) => calls.findIndex((c) => c.key === key);
    check("the frame-drive probe ran on its own tab (pause + a 200ms advance, never the record tab)", allCalls.some((c) => c.tab === 2 && c.key === "vt:advance" && c.budget === 200) && !calls.some((c) => c.key === "vt:advance" && c.budget === 200));
    check("virtual time paused BEFORE navigation; advances begin only after the commit (pause, navigate, then chunked advances)", at("vt:pause") >= 0 && at("navigate") > at("vt:pause") && at("vt:advance") > at("navigate"));
    check("pause pins a fixed virtual epoch; every post-commit advance is a stepMs-chunked plain budget (never pauseIfNetworkFetchesPending — the fetch-batch drains own the wire)", calls[at("vt:pause")].initial === 1700000000 && calls[at("vt:advance")].budget === 20 && !allCalls.some((c) => c.key === "vt:pauseIfNetworkFetchesPending"));
    const seq = calls.filter((c) => (c.key === "vt:advance" && c.budget === 20) || c.key === "step").map((c) => (c.key === "step" ? "s" : "a")).join("");
    check("advance/step cadence: load-anchored pre-trigger (4000ms at 50fps = 200) + 120 post-trigger settle frames, then one advance per recorded frame", seq === "a".repeat(320) + "as".repeat(5), seq.length > 40 ? `${seq.slice(0, 20)}…${seq.slice(-16)} (${seq.length})` : seq);
    check("the cache is disabled and the request interception armed before navigation", at("cache-disabled") >= 0 && at("cache-disabled") < at("navigate") && at("fetch-enable") >= 0 && at("fetch-enable") < at("navigate") && calls[at("fetch-enable")].params.patterns[0].requestStage === "Request");
    check("Step(t) carries uniform virtual timestamps", calls.filter((c) => c.key === "step").map((c) => c.t).join(",") === "20,40,60,80,100");
    check("the recorder Start names the declared scope and the default props", /"scopes":\[".hero"\]/.test(calls[at("start")].expression) && /"props":\["transform","opacity","filter","visibility"\]/.test(calls[at("start")].expression));
    check("viewport normalized unconditionally (width+height+dsf)", calls.some((c) => c.key === "metrics" && c.params.width === 1440 && c.params.height === 982 && c.params.deviceScaleFactor === 2));

    const doc = JSON.parse(fs.readFileSync(path.join(dir, "motion-doc.json"), "utf8"));
    let docErr = null; try { validateMotionDoc(doc); } catch (e) { docErr = e.message; }
    check("merged motion-doc.json still validates and keeps the pre-existing track", !docErr && doc.tracks.length === 2 && doc.tracks[0].id === "css-1", docErr);
    const sampled = doc.tracks.find((t) => t.provenance.tier === "sampled");
    check("sampled track: uniform offsets, matrix values verbatim, frames x stepMs duration", !!sampled && sampled.property === "transform" && sampled.keyframes.length === 5 && sampled.keyframes[0].offset === 0 && sampled.keyframes[4].offset === 1 && sampled.keyframes[1].value === "matrix(1, 0, 0, 1, 20, 0)" && sampled.timing.duration_ms === 100 && sampled.timeline.type === "document");
    check("provenance carries the declared fps AND the merged style-write evidence", sampled.provenance.source === "virtual-time@50fps+style-writes:1");
    // The record moves through its final frames — no settle was observed, so the track is
    // ONGOING, and the tie-break re-classifies the engine's full-window linear tween as a
    // marquee (ongoing beats finite when ongoing:true). This is the exact miss being
    // encoded: a forever belt lifted as a finite tween shipped a clip that froze.
    check("a series still moving in its final frames is marked ongoing:true on the merged track", sampled.ongoing === true);
    check("the ongoing tie-break re-classifies the full-window linear lift as MARQUEE at the measured velocity", sampled.fit && sampled.fit.kind === "marquee" &&
      sampled.fit.params.channel === "tx" && sampled.fit.params.velocityPxPerSec === 500 && sampled.fit.params.direction === 1 && sampled.fit.nrmse <= 0.1, JSON.stringify(sampled.fit || null).slice(0, 200));

    const receipt = JSON.parse(fs.readFileSync(path.join(dir, "motion", "m1", "sample.json"), "utf8"));
    check("sample.json receipt: mode, static drop count, agent-DOM skip, fit lift, ok", receipt.ok === true && receipt.virtualTime.mode === "virtual-time" && receipt.sampling.staticDropped === 7 && receipt.recorder.skipped.agentDom === 1 && receipt.fit.attached.length === 1 && receipt.determinism.runs === 1);
    check("the receipt counts the ongoing tracks and names the tie-break re-classification", receipt.sampling.ongoing === 1 &&
      receipt.fit.reclassified.length === 1 && receipt.fit.reclassified[0].to === "marquee" && receipt.fit.attached[0].kind === "marquee");
    check("the ongoing mark and the tie-break are announced", /1 track\(s\) marked ongoing/.test(r.out) && /re-classified marquee/.test(r.out));
    const items = JSON.parse(fs.readFileSync(path.join(dir, "motion-items.json"), "utf8")).items;
    check("item advanced to NON-terminal \"sampled\" with its track ids", items[0].status === "sampled" && items[0].sampledTrackIds.length === 1 && items[0].sampledTrackIds[0] === sampled.id);
    const ledger = fs.readFileSync(path.join(dir, "workflow.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    check("workflow.jsonl receipted the intervention", ledger.some((l) => l.event === "motion-sample" && l.item === "m1" && /virtual-time @ 50fps/.test(l.reason)));
    check("static drop and next steps printed", /7 static series dropped/.test(r.out) && /apply-sampled t1 m1/.test(r.out) && /verify-sampled t1 m1/.test(r.out));
    server.close();
  }

  // ── scroll-through trigger + --verify-determinism (identical runs) ────────────
  {
    const dir = makeTarget(work, "t2", [declaredItem({ trigger: "scroll-through:.rail/3/100" })]);
    const server = await fakeChrome([{ record: denseRecord() }]);
    const r = await run(["t2", "m1", "--fps", "50", "--frames", "4", "--verify-determinism", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("determinism flag runs the whole capture twice and verifies it (2 record tabs + 1 frame-drive probe tab)", r.code === 0 && /determinism verified/.test(r.out) && server.tabCount() === 3, r.out.slice(0, 600));
    // record tab A = 1, frame-drive probe = 2, record tab B = 3
    const dwells = server.calls.filter((c) => c.key === "vt:advance" && c.budget === 100);
    check("scroll-through dwells are virtual-time advances (3 per run, both runs)", dwells.length === 6 && dwells.filter((c) => c.tab === 1).length === 3, JSON.stringify(dwells));
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, "motion", "m1", "sample.json"), "utf8"));
    check("determinism receipted: 2 runs, identical", receipt.determinism.runs === 2 && receipt.determinism.identical === true);
    check("the wall barrier and freeze-step values that actually ran ride in the receipt (env override honored)", receipt.virtualTime.wallBarrierMs === 0 && receipt.virtualTime.freezeMs === 0);
    server.close();
  }

  // ── nondeterministic samples are a named refusal — nothing merged ─────────────
  {
    const dir = makeTarget(work, "t3", [declaredItem()]);
    const server = await fakeChrome([{ record: denseRecord() }, { record: denseRecord(35) }]);
    const r = await run(["t3", "m1", "--fps", "50", "--frames", "5", "--verify-determinism", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("differing runs → exit 1 naming the first differing sample", r.code === 1 && /did not produce identical samples/.test(r.out) && /elements\.0\.samples\.2\.values\.transform/.test(r.out), r.out.slice(0, 600));
    check("nothing merged, item not advanced, refusal receipted", !fs.existsSync(path.join(dir, "motion-doc.json")) &&
      JSON.parse(fs.readFileSync(path.join(dir, "motion-items.json"), "utf8")).items[0].status === "pending" &&
      JSON.parse(fs.readFileSync(path.join(dir, "motion", "m1", "sample.json"), "utf8")).ok === false);
    server.close();
  }

  // ── hooked-clock fallback when the target refuses virtual time ────────────────
  {
    const dir = makeTarget(work, "t4", [declaredItem()]);
    const server = await fakeChrome([{ vt: "refuse", record: denseRecord() }]);
    const r = await run(["t4", "m1", "--fps", "50", "--frames", "5", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("fallback still samples (exit 0) and names its mode", r.code === 0 && /hooked-clock/.test(r.out), r.out.slice(0, 600));
    const calls = server.calls;
    const hook = calls.find((c) => c.key === "hook-install" && /__ppkClockStep/.test(c.source));
    check("clock hook installed BEFORE navigation via addScriptToEvaluateOnNewDocument", !!hook && /performance\.now/.test(hook.source) && calls.indexOf(hook) < calls.findIndex((c) => c.key === "navigate"));
    check("steps advance the hooked clock, never CDP budgets", calls.filter((c) => c.key === "clock-step" && c.ms === 20).length === 245 && !calls.some((c) => c.key === "vt:advance"));
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, "motion", "m1", "sample.json"), "utf8"));
    check("receipt names the fallback mode and why", receipt.virtualTime.mode === "hooked-clock" && /wasn't found/.test(receipt.virtualTime.fallbackReason));
    server.close();
  }

  // ── a page where nothing moves is a refusal, not a fabricated artifact ────────
  {
    const dir = makeTarget(work, "t5", [declaredItem()]);
    const server = await fakeChrome([{ record: STATIC_RECORD }]);
    const r = await run(["t5", "m1", "--fps", "50", "--frames", "5", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("all-static record → exit 1 by name, no doc, item not advanced", r.code === 1 && /every sampled series was static/.test(r.out) && !fs.existsSync(path.join(dir, "motion-doc.json")) &&
      JSON.parse(fs.readFileSync(path.join(dir, "motion-items.json"), "utf8")).items[0].status === "pending");
    check("the refusal is still receipted", JSON.parse(fs.readFileSync(path.join(dir, "motion", "m1", "sample.json"), "utf8")).ok === false);
    server.close();
  }

  // ── a SETTLING series stays finite: no ongoing mark, no marquee re-classification ──
  {
    const dir = makeTarget(work, "t7", [declaredItem()]);
    const settlingRecord = {
      frames: 5, stepMs: 20,
      elements: [{ selector: ".hero", samples: [1, 2, 3, 4, 5].map((i) => ({ t: i * 20, values: {
        transform: MOVING(Math.min(i, 3)), opacity: "1", filter: "none", visibility: "visible" } })) }],
      writes: [], truncated: false, skipped: { agentDom: 0 }, writesObserved: true,
    };
    const server = await fakeChrome([{ record: settlingRecord }]);
    const r = await run(["t7", "m1", "--fps", "50", "--frames", "5", "--attach", `127.0.0.1:${server.address().port}`], work);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, "motion-doc.json"), "utf8"));
    const sampled = doc.tracks.find((t) => t.provenance.tier === "sampled");
    check("a ramp that settles inside the window is NOT ongoing and keeps its finite fit", r.code === 0 && !!sampled &&
      sampled.ongoing === undefined && (!sampled.fit || sampled.fit.kind !== "marquee"), JSON.stringify({ ongoing: sampled && sampled.ongoing, fit: sampled && sampled.fit && sampled.fit.kind }));
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, "motion", "m1", "sample.json"), "utf8"));
    check("the receipt records zero ongoing tracks and zero re-classifications for a settling record", receipt.sampling.ongoing === 0 && receipt.fit.reclassified.length === 0);
    server.close();
  }

  // ── an empty scope is refused by the recorder's own tracking count ────────────
  {
    makeTarget(work, "t6", [declaredItem({ scope: ".ghost" })]);
    const server = await fakeChrome([{ start: { tracking: 0, writesObserved: true, truncated: false, skipped: { agentDom: 0 } } }]);
    const r = await run(["t6", "m1", "--fps", "50", "--frames", "5", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("scope matching nothing → exit 1 pointing at the scope remedy", r.code === 1 && /matched no recordable element/.test(r.out) && /motion-items\.json/.test(r.out));
    server.close();
  }

  fs.rmSync(work, { recursive: true, force: true });
  console.log(failed ? `\n❌ motion-sampler-selftest: ${failed} check(s) failed.` : "\n✓ motion-sampler-selftest: all checks pass.");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("motion-sampler-selftest crashed:", e); process.exit(1); });
