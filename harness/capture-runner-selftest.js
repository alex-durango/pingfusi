// harness/capture-runner-selftest.js — guards the CDP capture runner (capture-run).
//
// OFFLINE (always runs): the full conversation against a fake Chrome — probe, unconditional
// viewport normalization, navigate, inject, value-mode capture, artifact + receipt writes —
// plus the contracts that must never soften: the settle STOP (a page still growing writes
// NOTHING), the bot-wall ladder ending in the interactive FALLBACK (never a dead end), and
// side=auto picking live-only until a clone exists. MOTION (additive, quarantined): reader
// records become a validated motion-doc.json, wire bodies are sniffed and ripped under
// sha-DERIVED names (never the remote name), oversized bodies are receipted skips, and a
// reader that throws is a WARNING — the capture itself must still exit 0.
// INTEGRATION (skip-if-absent): the real
// local Chrome headless captures a fixture clone and the snapshot's viewport must be EXACTLY
// the normalized one — width, height, and dpr 2 (the heyaristotle bug, pinned for good).
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFile } = require("child_process");
const { acceptKeyFor } = require("./cdp.js");
const { resolveChrome } = require("./chrome.js");
const { validateMotionDoc } = require("./motion-doc.js");

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
};

// ── fake Chrome (same server-half RFC6455 as behavior-runner-selftest) ────────
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

// ── tiny PNG encoder for the paint probe (filter-0 rows, CRCs zeroed — the probe reads
//    its own Chrome's bytes and does not verify CRCs; the probe MATH is fixtured in
//    harness/fixtures/43-paint-probe.js, this half proves the CDP wiring + receipts) ────
function makePng(width, height, px) {
  const zlib = require("zlib");
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA, non-interlaced — Chrome's screenshot shape
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const off = y * (stride + 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = px(x, y);
      const i = off + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PNG_BLACK = makePng(64, 64, () => [0, 0, 0]).toString("base64");
const PNG_RICH = makePng(64, 64, (x, y) => (((x >> 3) + (y >> 3)) % 2 ? [255, 255, 255] : [20, 40, 200])).toString("base64");

const GOOD_PROBE = { documentHidden: false, visibilityState: "visible", hasFocus: false, innerWidth: 1440, devicePixelRatio: 2, raf: { frames: 33, ms: 702 }, anim: { expectedPxPerSec: 100, measuredPxPerSec: 99.1 } };
const snapJson = JSON.stringify({ url: "http://fake/", viewport: { width: 1440, height: 982, dpr: 2 }, mode: "CSS1Compat", elements: { h1: {} } });
const GOOD_REPORT = (prefix) => ({
  prefix, leaves: 42, byKind: { text: 30, image: 12 }, ok: true,
  settle: { stable: true, scrolledTo: 4200, imagesPending: 0, heights: [6526, 6526, 6526] },
  delivered: [], failed: [],
  payloads: prefix === "live"
    ? { "live.json": snapJson, "coverage.json": '["h1","p"]', "dom.html": "<html>fake dom</html>" }
    : { "clone.json": snapJson },
});

function fakeChrome(script) {
  let tabN = 0;
  const metricsCalls = [];
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
    const tabIdx = +(/TAB(\d+)/.exec(req.url) || [0, 1])[1] - 1;
    const acts = script[Math.min(tabIdx, script.length - 1)];
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
        const value = (v) => reply({ result: { type: typeof v, value: v } });
        if (msg.method === "Page.navigate") {
          reply({ frameId: "F1" });
          socket.write(serverFrame(0x1, JSON.stringify({ method: "Page.loadEventFired", params: {} })));
          // Network events for the asset rip: one responseReceived + loadingFinished pair
          // per fixture entry, exactly as Chrome bursts them after load.
          for (const n of acts.network || []) {
            socket.write(serverFrame(0x1, JSON.stringify({ method: "Network.responseReceived", params: { requestId: n.id, response: { url: n.url, mimeType: n.mime || "" } } })));
            socket.write(serverFrame(0x1, JSON.stringify({ method: "Network.loadingFinished", params: { requestId: n.id, encodedDataLength: n.encodedDataLength != null ? n.encodedDataLength : Buffer.byteLength(n.body || "", "latin1") } })));
          }
        } else if (msg.method === "Network.getResponseBody") {
          const n = (acts.network || []).find((x) => x.id === (msg.params || {}).requestId);
          reply(n ? { body: n.base64 ? Buffer.from(n.body, "latin1").toString("base64") : n.body, base64Encoded: !!n.base64 } : { body: "", base64Encoded: false });
        } else if (msg.method === "Page.captureScreenshot") {
          // no acts.screenshot → an empty reply, which the paint probe must receipt as a
          // note ("returned no data"), never as a capture failure
          reply(acts.screenshot ? { data: acts.screenshot } : {});
        } else if (msg.method === "Emulation.setDeviceMetricsOverride") {
          metricsCalls.push(msg.params);
          reply({});
        } else if (msg.method === "Runtime.evaluate") {
          const e = msg.params.expression;
          if (e.includes("__ppkProbe")) value(acts.probe || GOOD_PROBE);
          else if (e.includes("iw: innerWidth")) value(acts.viewportRead || { iw: 1440, cw: 1440, ih: 982, dpr: 2 });
          else if (e === "document.title") value(acts.title || "Fake Page");
          else if (e.startsWith("typeof pxCaptureAll")) value("function"); // pxCaptureAll AND pxCaptureAllPhased
          else if (e.startsWith("pxCaptureAll")) {
            const prefix = /"prefix":"(\w+)"/.exec(e) ? /"prefix":"(\w+)"/.exec(e)[1] : "live";
            const rep = acts.report ? acts.report(prefix) : GOOD_REPORT(prefix);
            // The phased call carries the runner's known-unfreezable list; echo it back on
            // the freeze receipt the way the real in-page freeze merges opts.unfreezable —
            // so tests can assert the runner actually PASSED it in.
            if (!rep.aborted && rep.freeze === undefined) {
              let unf = [];
              const um = /"unfreezable":(\[[^\]]*\])/.exec(e);
              if (um) { try { unf = JSON.parse(um[1]); } catch (err) { unf = []; } }
              rep.freeze = acts.freeze || {
                supported: true, frozen: 2, ids: ["css:spin@.loader", "pingfusi:motion-replay"], players: [],
                alreadyPaused: 0, skipped: { finished: 0, scrollLinked: 0, agentDom: 0, kitPlayer: 0, failed: 0 },
                unfreezable: unf, stillMoving: [], watch: { ran: true, intervals: 2, intervalMs: 180, tracked: 3, writes: 0, truncated: false },
                excludedMarks: {},
              };
            }
            value(rep);
          } else if (e.startsWith("pxMarksInSubtrees(")) {
            value(acts.marks || {});
          } else if (e.startsWith("Math.max((document.documentElement.scrollHeight")) {
            value(acts.scrollMax); // undefined by default → the ongoing sweep skips, as before
          } else if (e.includes("pxDenseRecordStart")) {
            value(acts.detect || { unsupported: true });
          } else if (e.startsWith("(() => { const out = {}; for (const sel of ")) {
            value(acts.tops || {});
          } else if (e.startsWith("pxIntrospectAnimations")) {
            if (acts.introspect === "throw") reply({ result: { type: "object", subtype: "error" }, exceptionDetails: { exception: { description: "Error: getAnimations exploded on this page" } } });
            else if (acts.introspect !== undefined) value(acts.introspect);
            else reply({ result: { type: "undefined" } }); // reader absent from the injected source
          } else if (e.startsWith("pxProbeGsap")) {
            if (acts.gsap === "throw") reply({ result: { type: "object", subtype: "error" }, exceptionDetails: { exception: { description: "Error: gsap probe exploded" } } });
            else if (acts.gsap !== undefined) value(acts.gsap);
            else reply({ result: { type: "undefined" } });
          } else if (e.includes("pxCanvasDominant")) {
            value(acts.canvas !== undefined ? acts.canvas : { unsupported: true });
          } else reply({ result: { type: "undefined" } }); // injection etc.
        } else reply({});
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => { server.metricsCalls = metricsCalls; r(server); }));
}

const runnerPath = path.join(__dirname, "capture-runner.js");
function run(args, cwd, env) {
  return new Promise((resolve) => {
    execFile("node", [runnerPath, ...args], { cwd, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: String(stdout) + String(stderr) });
    });
  });
}
function makeTarget(work, name) {
  const dir = path.join(work, "targets", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "target.json"), JSON.stringify({ name, url: "http://fake-live/", width: 1440 }));
  return dir;
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-caprun-"));
  const KITV = require("../package.json").version;

  // ── CLI refusals ──────────────────────────────────────────────────────────────
  const noName = await run([], work);
  check("no name → usage", noName.code === 1 && /usage/.test(noName.out));
  check("bad --side named", /--side must be/.test((await run(["t0", "--side", "sideways"], work)).out));
  makeTarget(work, "t1");
  const noClone = await run(["t1", "--side", "clone"], work);
  check("explicit clone side without a clone points at capture-build", noClone.code === 1 && /capture-build t1|--clone-url/.test(noClone.out));

  // ── side=auto, no clone yet → live only; artifacts + receipt written ──────────
  {
    const server = await fakeChrome([{}]);
    const r = await run(["t1", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("auto side with no clone runs LIVE only, exit 0", r.code === 0 && !/clone:/.test(r.out.split("\n").find((l) => l.startsWith("· live")) || ""), r.out.slice(0, 400));
    const dir = path.join(work, "targets", "t1");
    check("live.json + coverage.json + dom.html written from payloads", fs.existsSync(path.join(dir, "live.json")) && fs.existsSync(path.join(dir, "coverage.json")) && fs.readFileSync(path.join(dir, "dom.html"), "utf8") === "<html>fake dom</html>");
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, "capture-run.json"), "utf8"));
    check("run receipt: kit version, viewport + sources, probe numbers, per-file bytes", receipt.kitVersion === KITV && receipt.viewport.dpr === 2 && receipt.viewport.sources.width === "target.json" && receipt.sides[0].probe.rafHz > 60 && receipt.sides[0].files.some((f) => f.file === "live.json"));
    check("paint probe with no screenshot data is a receipted note, never a failure", /paint probe unavailable/.test(receipt.sides[0].paint.error || "") && !receipt.paint);
    check("viewport normalized unconditionally (width+height+dsf, never dsf:0)", server.metricsCalls.length >= 1 && server.metricsCalls.every((m) => m.width === 1440 && m.height === 982 && m.deviceScaleFactor === 2));
    check("next step points at capture-build", /capture-build t1/.test(r.out));
    check("kit version printed at startup", new RegExp(`pingfusi ${KITV.replace(/\./g, "\\.")} capture-run`).test(r.out));
    server.close();
  }

  // ── side=auto with a clone → both, clone first, clone.json written ────────────
  {
    fs.mkdirSync(path.join(work, "targets", "t1", "clone"), { recursive: true });
    fs.writeFileSync(path.join(work, "targets", "t1", "clone", "index.html"), "<html></html>");
    const server = await fakeChrome([{}, {}]);
    const r = await run(["t1", "--attach", `127.0.0.1:${server.address().port}`, "--clone-url", "http://fake-clone/"], work);
    check("auto side with a clone runs BOTH, clone first", r.code === 0 && r.out.indexOf("clone:") < r.out.indexOf("live:"));
    check("clone.json written", fs.existsSync(path.join(work, "targets", "t1", "clone.json")));
    check("next step points at the visual gate", /gate t1 visual/.test(r.out));
    server.close();
  }

  // ── the settle STOP contract: a growing page writes NOTHING ───────────────────
  {
    makeTarget(work, "t2");
    const server = await fakeChrome([{ report: () => ({ prefix: "live", leaves: 0, ok: false, aborted: "settle-not-stable", hint: "the page never settled — inspect settle.heights.", settle: { stable: false, heights: [4400, 5100, 5800], imagesPending: 3, pendingImageSrcs: ["https://x/img.webp"] }, delivered: [], failed: [] }) }]);
    const r = await run(["t2", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("settle-not-stable → exit 1 with the evidence (heights, pending images)", r.code === 1 && /never settled/.test(r.out) && /5800/.test(r.out) && /3 image/.test(r.out));
    check("no artifacts written for an unsettled page (motion-doc.json included)", !fs.existsSync(path.join(work, "targets", "t2", "live.json")) && !fs.existsSync(path.join(work, "targets", "t2", "dom.html")) && !fs.existsSync(path.join(work, "targets", "t2", "motion-doc.json")));
    server.close();
  }

  // ── bot wall is an ERROR (the docs' contract: "fall back when capture-run's error
  //    says so") — artifacts stay as evidence, the exit code is the verdict ──────────
  {
    makeTarget(work, "t3");
    const server = await fakeChrome([{ title: "Just a moment..." }]);
    const r = await run(["t3", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("challenge title → exit 1, ladder + interactive fallback in the ERROR (the PHASED call — the fallback must not reintroduce phase poison)", r.code === 1 && /bot-challenge wall/.test(r.out) && /--profile/.test(r.out) && /pxCaptureAllPhased\('<sink_url>'\)/.test(r.out));
    check("wall artifacts still written as EVIDENCE, and marked as such", fs.existsSync(path.join(work, "targets", "t3", "live.json")) && /EVIDENCE of the wall/.test(r.out) && /do not capture-build from them/.test(r.out));
    server.close();
  }

  // ── environment/viewport refusals carry the fallback too ──────────────────────
  {
    makeTarget(work, "t4");
    const server = await fakeChrome([{ viewportRead: { iw: 1425, cw: 1425, ih: 982, dpr: 1 } }]);
    const r = await run(["t4", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("viewport mismatch → refused by name (innerWidth AND dpr) + fallback offered", r.code === 1 && /viewport did not normalize/.test(r.out) && /devicePixelRatio 1/.test(r.out) && /interactive in-browser capture/.test(r.out));
    server.close();
  }

  // ── payload names are REMOTE-CONTROLLED: traversal/unexpected names never hit disk ──
  {
    makeTarget(work, "t5");
    const evil = (prefix) => ({ ...GOOD_REPORT(prefix), payloads: { "live.json": snapJson, "../evil.txt": "pwn", "clone.json": "wrong side" } });
    const server = await fakeChrome([{ report: evil }]);
    const r = await run(["t5", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("unexpected payload names refused by name, allowed one still written", r.code === 0 && /refused 2 unexpected payload name/.test(r.out) && /\.\.\/evil\.txt/.test(r.out) && fs.existsSync(path.join(work, "targets", "t5", "live.json")));
    check("traversal name never hit disk (wrong-side name neither)", !fs.existsSync(path.join(work, "evil.txt")) && !fs.existsSync(path.join(work, "targets", "evil.txt")) && !fs.existsSync(path.join(work, "targets", "t5", "clone.json")));
    const allEvil = await fakeChrome([{ report: () => ({ ...GOOD_REPORT("live"), payloads: { "../a": "x" } }) }]);
    const r2 = await run(["t5", "--attach", `127.0.0.1:${allEvil.address().port}`], work);
    check("ALL names refused → hard failure naming the cause", r2.code === 1 && /not running the kit's pxCaptureAll/.test(r2.out));
    server.close(); allEvil.close();
  }

  // ── motion doc: reader records → tracks, wire bodies → sha-named assets ────────
  {
    const dir = makeTarget(work, "t6");
    // A pre-existing engine-fit artifact must be folded in as a "fitted" track.
    fs.mkdirSync(path.join(dir, "motion", "m1", "trace"), { recursive: true });
    fs.writeFileSync(path.join(dir, "motion", "m1", "trace", "fits.json"), JSON.stringify({
      url: "http://fake-live/", fits: [{ elementId: "e1", path: ".card", channel: "tx",
        fit: { kind: "tween", transition: { duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }, valueFrom: 0, valueTo: 120, nrmse: 0.03, confidence: 0.9 } }],
    }));
    const lottieBody = JSON.stringify({ v: "5.9.6", fr: 60, ip: 0, op: 120, layers: [{ ty: 4, nm: "shape" }] });
    const rivBody = "RIVE\x07\x00rive-binary-payload";
    const dotBody = "PK\x03\x04dotlottie-zip-bytes";
    const server = await fakeChrome([{
      introspect: { supported: true, total: 1, truncated: false, records: [{ type: "CSSAnimation", animationName: "spin", selector: ".loader",
        keyframes: [{ offset: 0, easing: "linear", transform: "rotate(0deg)" }, { offset: 1, transform: "rotate(360deg)" }],
        timing: { duration: 1200, delay: 0, iterations: "infinite", direction: "normal", fill: "none" } }], skipped: { noTarget: 0, agentDom: 0 } },
      gsap: { present: true, version: "3.12.5", truncated: false, tweens: 1, records: [{ selector: ".hero", vars: { opacity: 1 }, duration_s: 0.5, ease: "power2.out" }], scrollTriggers: [], skipped: {} },
      network: [
        { id: "R1", url: "http://fake-live/anim/loader.json", mime: "application/json", body: lottieBody },
        { id: "R2", url: "http://fake-live/anim/hero.riv", mime: "application/octet-stream", body: rivBody, base64: true },
        { id: "R3", url: "http://fake-live/anim/badge.lottie", mime: "application/octet-stream", body: dotBody, base64: true },
        { id: "R4", url: "http://fake-live/api/users.json", mime: "application/json", body: '{"users":[]}' },   // JSON but not Lottie — sniffed, refused, silent
        { id: "R5", url: "http://fake-live/app.js", mime: "text/javascript", body: "console.log(1)" },          // never a candidate
        { id: "R6", url: "http://fake-live/anim/huge.json", mime: "application/json", body: "{}", encodedDataLength: 6 * 1024 * 1024 }, // oversized → receipted skip
      ],
    }]);
    const r = await run(["t6", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("motion phase rides a normal capture: exit 0, doc announced", r.code === 0 && /motion-doc\.json \(3 track/.test(r.out), r.out.slice(0, 600));
    const doc = JSON.parse(fs.readFileSync(path.join(dir, "motion-doc.json"), "utf8"));
    let docErr = null; try { validateMotionDoc(doc); } catch (e) { docErr = e.message; }
    check("motion-doc.json passes validateMotionDoc", !docErr, docErr);
    check("doc carries schema + url + normalized viewport", doc.schema === "pingfusi/motion-doc@1" && doc.url === "http://fake-live/" && doc.viewport.width === 1440 && doc.viewport.height === 982 && doc.viewport.dpr === 2);
    const css = doc.tracks.find((t) => t.provenance.tier === "introspected-css");
    const gsap = doc.tracks.find((t) => t.provenance.tier === "introspected-gsap");
    const fitted = doc.tracks.find((t) => t.provenance.tier === "fitted");
    check("introspection record → css track (property, keyframes, infinite iterations)", !!css && css.property === "transform" && css.keyframes.length === 2 && css.timing.iterations === "infinite" && css.timing.duration_ms === 1200);
    check("gsap record → gsap track (ms timing, exact-ease conversion)", !!gsap && gsap.property === "opacity" && gsap.timing.duration_ms === 500 && /cubic-bezier/.test(gsap.keyframes[0].easing));
    check("fits.json merged as a fitted track", !!fitted && fitted.fit && fitted.fit.kind === "tween" && fitted.target.selector === ".card");
    const lot = doc.assets.find((a) => a.kind === "lottie");
    const riv = doc.assets.find((a) => a.kind === "riv");
    const dot = doc.assets.find((a) => a.kind === "dotlottie");
    const lotSha = crypto.createHash("sha256").update(Buffer.from(lottieBody, "utf8")).digest("hex");
    check("lottie body sniffed + recorded (sha, bytes, source url, derived file)", !!lot && lot.sha256 === lotSha && lot.bytes === Buffer.byteLength(lottieBody) && lot.url === "http://fake-live/anim/loader.json" && lot.file === `motion-assets/${lotSha.slice(0, 16)}.json`);
    check("lottie body on disk under the derived name, byte-exact", fs.readFileSync(path.join(dir, "motion-assets", `${lotSha.slice(0, 16)}.json`), "utf8") === lottieBody);
    check("riv + dotlottie sniffed by magic bytes, fixed extensions, nothing else ripped", !!riv && riv.file.endsWith(".riv") && !!dot && dot.file.endsWith(".lottie") && doc.assets.length === 3);
    check("remote names never touch the disk", !fs.readdirSync(path.join(dir, "motion-assets")).some((f) => /loader|hero|badge|huge/.test(f)));
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, "capture-run.json"), "utf8"));
    const m = receipt.sides[0].motion;
    check("receipt: motion summary + oversized skip receipted by url and cap", !!m && m.tracks === 3 && m.assets === 3 && m.warnings.some((w) => /huge\.json/.test(w) && /cap/.test(w)));
    server.close();
  }

  // ── a motion reader failure is a WARNING, never a capture failure ──────────────
  {
    const dir = makeTarget(work, "t7");
    const server = await fakeChrome([{ introspect: "throw", gsap: { present: false } }]);
    const r = await run(["t7", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("reader throwing in-page → capture still exits 0, artifacts written", r.code === 0 && fs.existsSync(path.join(dir, "live.json")), r.out.slice(0, 400));
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, "capture-run.json"), "utf8"));
    check("reader failure printed AND receipted as a warning", /⚠ motion: pxIntrospectAnimations failed/.test(r.out) && receipt.sides[0].motion.warnings.some((w) => /pxIntrospectAnimations/.test(w) && /exploded/.test(w)));
    const doc = JSON.parse(fs.readFileSync(path.join(dir, "motion-doc.json"), "utf8"));
    let docErr = null; try { validateMotionDoc(doc); } catch (e) { docErr = e.message; }
    check("doc still written + valid with zero tracks (absent engine is not a warning)", !docErr && doc.tracks.length === 0 && !receipt.sides[0].motion.warnings.some((w) => /pxProbeGsap/.test(w)));
    server.close();
  }

  // ── ongoing-motion auto-sample: skip is RECEIPTED when the page yields no record ──
  {
    const receipt = JSON.parse(fs.readFileSync(path.join(work, "targets", "t7", "capture-run.json"), "utf8"));
    check("auto-sample skip receipted (dense recorder unavailable → note, not a warning)", receipt.sides[0].motion.sampled && /detection skipped/.test(receipt.sides[0].motion.sampled.note || "") && !receipt.sides[0].motion.warnings.some((w) => /auto-sample/.test(w)));
  }

  // ── ongoing-motion detect classifier + viewport grouping (pure) ────────────────
  {
    const { moversFromDetectRecord, groupMoversByViewport } = require("./capture-runner.js");
    const mk = (txs) => txs.map((tx, i) => ({ t: i * 350, values: { transform: `matrix(1, 0, 0, 1, ${tx}, 0)`, opacity: "1" } }));
    const rec = { elements: [
      { selector: ".belt", samples: mk([0, 7, 14, 21]) },                       // moves every interval
      { selector: ".reveal", samples: [{ t: 0, values: { transform: "none", opacity: "0" } }, { t: 350, values: { transform: "none", opacity: "0.9" } }, { t: 700, values: { transform: "none", opacity: "1" } }, { t: 1050, values: { transform: "none", opacity: "1" } }] }, // settles → not ongoing
      { selector: ".spin", samples: mk([0, 7, 14, 21]) },                        // covered by a reader
      { selector: ".static", samples: mk([5, 5, 5, 5]) },
    ] };
    const movers = moversFromDetectRecord(rec, new Set([".spin"]));
    check("classifier: only the never-settling uncovered mover is detected", movers.length === 1 && movers[0].selector === ".belt" && movers[0].property === "transform", JSON.stringify(movers));
    const g = groupMoversByViewport([{ selector: "a" }, { selector: "b" }, { selector: "c" }, { selector: "gone" }], { a: 5000, b: 5400, c: 9000 }, 982);
    check("grouping: one viewport group per 0.8×height span, topmost is the anchor, missing tops dropped", g.groups.length === 2 && g.groups[0].anchor === "a" && g.groups[0].movers.length === 2 && g.groups[1].anchor === "c" && g.dropped === 1, JSON.stringify(g));
  }

  // ── the paint probe (LEARNINGS #37): pixels are the only witness painting happened ──
  {
    const dir = makeTarget(work, "t8");
    fs.mkdirSync(path.join(dir, "clone"), { recursive: true });
    fs.writeFileSync(path.join(dir, "clone", "index.html"), "<html></html>");
    const server = await fakeChrome([
      { screenshot: PNG_BLACK }, // clone captured first — the solid-black draft, as the reviewer saw it
      { screenshot: PNG_RICH, canvas: { schema: "pingfusi/canvas-dominant@1", viewport: { w: 1440, h: 982 }, canvases: 1, bestCoverage: 0.97, marksInFront: 2, dominant: true } },
    ]);
    const r = await run(["t8", "--attach", `127.0.0.1:${server.address().port}`, "--clone-url", "http://fake-clone/"], work);
    check("near-blank clone under a rich live page is a WARNING — the capture still exits 0 (first-draft doctrine)", r.code === 0 && /paints almost nothing/.test(r.out), r.out.slice(0, 600));
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, "capture-run.json"), "utf8"));
    const cSide = receipt.sides.find((s) => s.side === "clone"), lSide = receipt.sides.find((s) => s.side === "live");
    check("paintStat receipted per side (clone near-blank, live rich)", cSide.paint.stat.nearBlank === true && lSide.paint.stat.nearBlank === false && lSide.paint.stat.nonUniformRatio > 0.4, JSON.stringify({ clone: cSide.paint, live: lSide.paint }));
    check("the run receipt carries the paint warning `review file` refuses on", /paints almost nothing/.test((receipt.paint || {}).warning || ""));
    check("canvasDominant receipted on the LIVE side only (the honest capability statement)", !!lSide.canvas && lSide.canvas.dominant === true && !cSide.canvas && /CANNOT reproduce/.test(r.out));
    check("the warning names the canvas mechanism when live receipted dominance", /script-driven canvas/.test(receipt.paint.warning));
    server.close();

    // A clone-only re-run must not lose the verdict: the live stat rides in from the
    // previous receipt, clearly labeled as a previous-run measurement.
    const server2 = await fakeChrome([{ screenshot: PNG_BLACK, canvas: undefined }]);
    const r2 = await run(["t8", "--attach", `127.0.0.1:${server2.address().port}`, "--side", "clone", "--clone-url", "http://fake-clone/"], work);
    const receipt2 = JSON.parse(fs.readFileSync(path.join(dir, "capture-run.json"), "utf8"));
    check("clone-only re-run keeps the warning (live side carried from the previous run, labeled)", r2.code === 0 && /paints almost nothing/.test((receipt2.paint || {}).warning || "") && /previous run/.test(receipt2.paint.warning), (receipt2.paint || {}).warning || r2.out.slice(0, 300));
    server2.close();
  }

  // ── phase-freeze (LEARNINGS #38): known-unfreezable plumbing + the freeze receipt ──
  {
    const dir = makeTarget(work, "t9");
    // Earlier receipts on disk: a sampled-ongoing track AND a sweep-detected mover — the
    // runner must hand BOTH to the in-page freeze as known-unfreezable; declared tiers
    // (css/gsap/waapi) are pausable and must NOT ride the list.
    fs.writeFileSync(path.join(dir, "motion-doc.json"), JSON.stringify({
      schema: "pingfusi/motion-doc@1", url: "http://fake-live/", viewport: { width: 1440, height: 982, dpr: 2 }, assets: [],
      tracks: [
        { id: "tr1", target: { selector: ".belt" }, property: "transform", keyframes: [], timing: {}, provenance: { tier: "sampled" }, ongoing: true },
        { id: "tr2", target: { selector: ".spin" }, property: "transform", keyframes: [], timing: {}, provenance: { tier: "introspected-css" } },
        { id: "tr3", target: { selector: ".fin" }, property: "opacity", keyframes: [], timing: {}, provenance: { tier: "sampled" } }, // sampled but FINITE — freezable clip, not unfreezable
      ],
    }));
    fs.mkdirSync(path.join(dir, "motion"), { recursive: true });
    fs.writeFileSync(path.join(dir, "motion", "auto-sample.json"), JSON.stringify({ detected: [{ selector: ".ticker", property: "transform", depth: 0 }] }));
    {
      // The pure reader, exercised where WORK resolves to the fake workdir.
      const prevCwd = process.cwd();
      process.chdir(work);
      const runnerKey = require.resolve("./capture-runner.js");
      delete require.cache[runnerKey];
      const { sweepUnfreezableSelectors } = require("./capture-runner.js");
      const sels = sweepUnfreezableSelectors("t9");
      process.chdir(prevCwd);
      delete require.cache[runnerKey]; // leave no cwd-bound module behind for later requires
      check("sweepUnfreezableSelectors: sampled-ongoing + sweep-detected, sorted; declared tiers and finite sampled tracks excluded", sels.join(",") === ".belt,.ticker", JSON.stringify(sels));
    }
    const server = await fakeChrome([{ marks: {} }]);
    const r = await run(["t9", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("phase-freeze rides the capture: frozen count + phase 0 printed, exit 0", r.code === 0 && /phase-freeze: 2 animation\(s\) paused at phase 0/.test(r.out), r.out.slice(0, 500));
    check("known-unfreezable movers were passed IN to the in-page freeze and printed", /2 UNFREEZABLE mover\(s\)/.test(r.out));
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, "capture-run.json"), "utf8"));
    const fz = receipt.sides[0].freeze;
    check("freeze receipted on the side: counts, ids, unfreezable list, per-mark count (map lives in the snapshot)", !!fz && fz.frozen === 2 && fz.ids.length === 2 && fz.unfreezable.join(",") === ".belt,.ticker" && fz.excludedMarkCount === 0 && fz.excludedMarks === undefined, JSON.stringify(fz));
    server.close();
  }

  // ── phase-freeze, second half: the sweep's movers are noted into live.json SAME-RUN ──
  {
    const dir = makeTarget(work, "t10");
    const mkSamples = (txs) => txs.map((tx, i) => ({ t: i * 350, values: { transform: `matrix(1, 0, 0, 1, ${tx}, 0)`, opacity: "1" } }));
    const server = await fakeChrome([{
      scrollMax: 0, // one sweep depth
      detect: { record: { elements: [{ selector: ".marq", samples: mkSamples([0, 7, 14, 21]) }] } }, // moves every interval → ongoing mover
      tops: {},     // mover "vanishes" before position read → detected but never sampled (still a mover)
      marks: { div_marq: ".marq", div_evil: ".not-ours" }, // page answer is REMOTE-CONTROLLED: only selectors the runner SENT may map
    }]);
    const r = await run(["t10", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("sweep-detected mover noted into live.json same-run, printed with the mark count", r.code === 0 && /1 sweep-detected ongoing mover\(s\) noted as unfreezable in live\.json — 1 mark\(s\)/.test(r.out), r.out.slice(0, 700));
    const snap = JSON.parse(fs.readFileSync(path.join(dir, "live.json"), "utf8"));
    check("live.json freeze field: unfreezable + excludedMarks (foreign selectors from the page REFUSED)", !!snap.freeze && snap.freeze.unfreezable.includes(".marq") && snap.freeze.excludedMarks.div_marq === ".marq" && !("div_evil" in snap.freeze.excludedMarks), JSON.stringify(snap.freeze));
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, "capture-run.json"), "utf8"));
    check("the patch is receipted on the side and mirrored into the run receipt's unfreezable list", receipt.sides[0].freezePatch && receipt.sides[0].freezePatch.marks === 1 && receipt.sides[0].freeze.unfreezable.includes(".marq"), JSON.stringify(receipt.sides[0].freezePatch));
    server.close();
  }

  // ── --dry-run ──────────────────────────────────────────────────────────────────
  {
    const r = await run(["t1", "--dry-run", "--attach", "127.0.0.1:1"], work);
    check("--dry-run prints sides(auto), viewport with sources, exit 0", r.code === 0 && /auto: clone exists/.test(r.out) && /1440×982 @2x/.test(r.out));
  }

  // ── integration: real local Chrome, headless, fixture clone ───────────────────
  const bin = resolveChrome({});
  if (process.env.PPK_SKIP_CHROME_TESTS === "1" || bin.error) {
    console.log(`✓ skipped real-Chrome integration (${process.env.PPK_SKIP_CHROME_TESTS === "1" ? "PPK_SKIP_CHROME_TESTS=1" : "no Chrome found"})`);
  } else {
    const dir = makeTarget(work, "rt1");
    fs.mkdirSync(path.join(dir, "clone"), { recursive: true });
    fs.writeFileSync(path.join(dir, "clone", "index.html"), `<!doctype html><html><head><style>
      h1 { font: 700 42px sans-serif; margin: 40px; } .hero { width: 600px; height: 220px; background: #246; }
    </style></head><body><h1>Fixture Page</h1><div class="hero"></div><p style="margin:40px;height:1200px">tall body</p></body></html>`);
    const r = await run(["rt1", "--side", "clone"], work);
    if (r.code !== 0 && /environment refused/.test(r.out)) {
      console.log("✓ skipped real-Chrome integration (headless failed the probe — the designed refusal)");
    } else {
      check("real-Chrome clone capture exits 0", r.code === 0, r.out.slice(0, 600));
      const snap = JSON.parse(fs.readFileSync(path.join(dir, "clone.json"), "utf8"));
      check("snapshot viewport is EXACTLY the normalized one (the heyaristotle bug, pinned)", snap.viewport.width === 1440 && snap.viewport.height === 982 && snap.viewport.dpr === 2, JSON.stringify(snap.viewport));
      check("elements were actually enumerated and measured", Object.keys(snap.elements || {}).length >= 2);
      const receipt = JSON.parse(fs.readFileSync(path.join(dir, "capture-run.json"), "utf8"));
      check("receipt records cdp-launched + settle stable", receipt.mode === "cdp-launched" && receipt.sides[0].settle.stable === true);
    }
  }

  fs.rmSync(work, { recursive: true, force: true });
  console.log(failed ? `\n❌ capture-runner-selftest: ${failed} check(s) failed.` : "\n✓ capture-runner-selftest: all checks pass.");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("capture-runner-selftest crashed:", e); process.exit(1); });
