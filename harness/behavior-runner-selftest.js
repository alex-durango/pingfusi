// harness/behavior-runner-selftest.js — guards the CDP behavior runner.
//
// Two halves. OFFLINE (always runs): the full runner conversation against a fake Chrome —
// attach, probe, navigate, inject, capture, attestation splice, artifact write — plus the
// refusal paths: a hidden/throttled environment refused BEFORE any capture, and a capture
// that comes back hidden dumped to .rejected.json with the real artifact untouched.
// INTEGRATION (skip-if-absent): launches the real local Chrome headless against a fixture
// clone with a CSS marquee at a known 100px/s and asserts the measured px/sec — the one
// test that proves the whole point: documentHidden=false, compositor at wall-clock rate.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFile } = require("child_process");
const { acceptKeyFor } = require("./cdp.js");
const { resolveChrome } = require("./chrome.js");

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
};

// ── the fake Chrome (server half of RFC6455 + a scripted CDP responder) ───────
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
const GOOD_SNAP = {
  url: "http://fake/", viewport: { width: 1440, height: 900, dpr: 2 }, mode: "CSS1Compat",
  discovery: { startedAt: "t0", endedAt: "t1", durationMs: 5000, documentHidden: false, scrollSweep: { from: 0, to: 3000, steps: 6, positions: [0] }, observeMs: 1500, elementsScanned: 1200, staticCandidateCount: 4, keyframesFound: ["ticker"], hoverTriggersProbed: [], marqueeSelectorsProbed: ["belt"] },
  behaviors: { "marquee:belt": { trigger: "load", kind: "marquee", measured: { pxPerSec: 46.0, axis: "x", from: 0, to: -46, sampledMs: 1000 } } },
  declared: {},
};

// script = { probe, snap } per tab-open order — lets one server serve clone-then-live runs.
function fakeChrome(script) {
  let tabN = 0;
  const metricsCalls = []; // every Emulation.setDeviceMetricsOverride — the viewport fix is asserted on these
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
    let probeCalls = 0;
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
        } else if (msg.method === "Emulation.setDeviceMetricsOverride") {
          metricsCalls.push(msg.params);
          reply({});
        } else if (msg.method === "Runtime.evaluate") {
          const e = msg.params.expression;
          if (e.includes("__ppkProbe")) value((acts.probes && acts.probes[Math.min(probeCalls++, acts.probes.length - 1)]) || acts.probe || GOOD_PROBE);
          else if (e === "document.title") value(acts.title || "Fake Page");
          else if (e.includes("iw: innerWidth")) value(acts.viewportRead || { iw: 1440, cw: 1440, ih: 982, dpr: 2 });
          else if (e === "typeof pxBehaviorCapture") value("function");
          else if (e.startsWith("pxBehaviorCapture(")) value(JSON.stringify(acts.snap || GOOD_SNAP, null, 2));
          else reply({ result: { type: "undefined" } }); // injection, pxRegion, etc.
        } else reply({});
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => { server.metricsCalls = metricsCalls; r(server); }));
}

const runnerPath = path.join(__dirname, "behavior-runner.js");
// async, NOT execFileSync — the fake Chrome lives in THIS process, and a sync child would
// block the event loop it needs to answer on (found live: every CDP call timed out at 5s).
function run(args, cwd, env) {
  return new Promise((resolve) => {
    execFile("node", [runnerPath, ...args], { cwd, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: String(stdout) + String(stderr) });
    });
  });
}
function makeTarget(work, name, extra = {}) {
  const dir = path.join(work, "targets", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "target.json"), JSON.stringify({ name, url: "http://fake-live/", width: 1440 }));
  fs.writeFileSync(path.join(dir, "behavior-opts.json"), JSON.stringify({ settleMs: 0, ...extra }));
  return dir;
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-runner-"));

  // ── CLI refusals, no server needed ──────────────────────────────────────────
  const noName = await run([], work);
  check("no name → usage", noName.code === 1 && /usage/.test(noName.out));
  check("bad --side named", /--side must be/.test((await run(["t0", "--side", "sideways"], work)).out));
  check("unknown flag named", /unknown flag --frob/.test((await run(["t0", "--frob"], work)).out));
  makeTarget(work, "t1");
  const noClone = await run(["t1", "--side", "clone"], work);
  check("clone side without a clone points at capture-build", noClone.code === 1 && /capture-build t1|--clone-url/.test(noClone.out));

  // ── happy path: both sides against the fake Chrome, clone first ─────────────
  {
    const server = await fakeChrome([
      { snap: { ...GOOD_SNAP, discovery: { ...GOOD_SNAP.discovery, elementsScanned: 1180 } } }, // clone tab
      { title: "Fake Live Page", snap: GOOD_SNAP },                                            // live tab
    ]);
    const port = server.address().port;
    const r = await run(["t1", "--side", "both", "--attach", `127.0.0.1:${port}`, "--clone-url", "http://fake-clone/"], work);
    check("both-sides run exits 0", r.code === 0, r.out.slice(0, 400));
    check("clone captured before live (wall-heuristic baseline)", r.out.indexOf("clone:") < r.out.indexOf("live:"));
    const live = JSON.parse(fs.readFileSync(path.join(work, "targets", "t1", "behaviors-live.json"), "utf8"));
    const clone = JSON.parse(fs.readFileSync(path.join(work, "targets", "t1", "behaviors-clone.json"), "utf8"));
    check("both artifacts written with behaviors intact", live.behaviors["marquee:belt"].measured.pxPerSec === 46.0 && clone.discovery.elementsScanned === 1180);
    check("attestation spliced: mode + version + probe receipts", live.discovery.runner && live.discovery.runner.mode === "cdp-attached" && live.discovery.runner.chromeVersion === "FakeChrome/1.0" && live.discovery.runner.rafProbe.hz > 60 && live.discovery.runner.animProbe.measuredPxPerSec === 99.1);
    check("documentHidden recorded as measured (false)", live.discovery.documentHidden === false);
    check("next step printed", /gate t1 behavior/.test(r.out));
    check("kit version printed at startup and recorded in the attestation", new RegExp(`pingfusi ${require("../package.json").version.replace(/\./g, "\\.")} behavior-capture`).test(r.out) && live.discovery.runner.kitVersion === require("../package.json").version);
    // the viewport bug (measured on heyaristotle): headless renders dpr 1 + short viewport
    // unless normalized UNCONDITIONALLY — every tab must get the full override, exact dpr
    check("viewport normalized unconditionally on BOTH tabs (width+height+dsf, never dsf:0)", server.metricsCalls.length >= 2 && server.metricsCalls.every((m) => m.width === 1440 && m.height === 982 && m.deviceScaleFactor === 2 && m.mobile === false));
    check("attestation records the viewport + sources", live.discovery.runner.viewport && live.discovery.runner.viewport.dpr === 2 && live.discovery.runner.viewport.sources.width === "target.json");
    server.close();
  }

  // ── a viewport that refuses to normalize is a refusal, not a shrug ───────────
  {
    makeTarget(work, "t6");
    const server = await fakeChrome([{ viewportRead: { iw: 1425, cw: 1425, ih: 982, dpr: 2 } }]);
    const r = await run(["t6", "--side", "live", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("viewport mismatch after normalize → refused by name", r.code === 1 && /viewport did not normalize/.test(r.out) && /innerWidth 1425/.test(r.out));
    server.close();
  }

  // ── a throttled environment is refused BEFORE any capture ───────────────────
  {
    makeTarget(work, "t2");
    const server = await fakeChrome([{ probe: { ...GOOD_PROBE, documentHidden: true } }]);
    const r = await run(["t2", "--side", "live", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("hidden environment → exit 1 before capture, refused by name", r.code === 1 && /environment refused before any capture/.test(r.out) && /document\.hidden/.test(r.out));
    check("no artifact written for a refused environment", !fs.existsSync(path.join(work, "targets", "t2", "behaviors-live.json")));
    server.close();
  }
  {
    makeTarget(work, "t3");
    const server = await fakeChrome([{ probe: { ...GOOD_PROBE, anim: { expectedPxPerSec: 100, measuredPxPerSec: 3 } } }]);
    const r = await run(["t3", "--side", "live", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("frozen compositor → refused by name", r.code === 1 && /compositor/.test(r.out));
    server.close();
  }

  // ── a capture that COMES BACK hidden lands in .rejected.json, artifact untouched ──
  {
    makeTarget(work, "t4");
    fs.writeFileSync(path.join(work, "targets", "t4", "behaviors-live.json"), JSON.stringify({ prior: "artifact" }));
    const hiddenSnap = { ...GOOD_SNAP, discovery: { ...GOOD_SNAP.discovery, documentHidden: true } };
    const server = await fakeChrome([{ snap: hiddenSnap }]);
    const r = await run(["t4", "--side", "live", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("mid-run hide → exit 1, dumped to .rejected.json as evidence", r.code === 1 && /went HIDDEN during capture/.test(r.out) && fs.existsSync(path.join(work, "targets", "t4", "behaviors-live.rejected.json")));
    check("the real artifact is untouched", JSON.parse(fs.readFileSync(path.join(work, "targets", "t4", "behaviors-live.json"), "utf8")).prior === "artifact");
    server.close();
  }

  // ── bot wall is an ERROR — the snapshot stays as evidence, the exit code is the
  //    verdict (a challenge page's "behaviors" are junk the gate would compare in earnest) ──
  {
    makeTarget(work, "t5");
    const server = await fakeChrome([{ title: "Just a moment...", snap: { ...GOOD_SNAP, discovery: { ...GOOD_SNAP.discovery, elementsScanned: 19 } } }]);
    const r = await run(["t5", "--side", "live", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("challenge title → exit 1, ladder in the ERROR (profile → attach → worksheet)", r.code === 1 && /bot-challenge wall/.test(r.out) && /--profile/.test(r.out) && /behavior-worksheet/.test(r.out));
    check("wall snapshot still written, marked as EVIDENCE", fs.existsSync(path.join(work, "targets", "t5", "behaviors-live.json")) && /EVIDENCE of the wall/.test(r.out));
    server.close();
  }

  // ── --dry-run prints the decision without touching a browser ─────────────────
  {
    const r = await run(["t1", "--dry-run", "--attach", "127.0.0.1:1"], work);
    check("--dry-run: attach decision printed, exit 0, nothing launched", r.code === 0 && /dry run/.test(r.out) && /attach to 127\.0\.0\.1:1/.test(r.out));
  }
  // launch-mode dry runs need a resolvable Chrome (path only — nothing is launched)
  if (!resolveChrome({}).error) {
    const r = await run(["t1", "--dry-run"], work);
    check("--dry-run default is INVISIBLE: headless=new, probe-gated, no window", r.code === 0 && /headless=new — invisible, probe-gated/.test(r.out));
    const rh = await run(["t1", "--dry-run", "--headful"], work);
    check("--headful is the only path that announces a window", /a window WILL appear/.test(rh.out) && !/window WILL appear/.test(r.out));
  }

  // ── integration: the real local Chrome, headless, against a known marquee ────
  const bin = resolveChrome({});
  if (process.env.PPK_SKIP_CHROME_TESTS === "1" || bin.error) {
    console.log(`✓ skipped real-Chrome integration (${process.env.PPK_SKIP_CHROME_TESTS === "1" ? "PPK_SKIP_CHROME_TESTS=1" : "no Chrome found"})`);
  } else {
    const dir = makeTarget(work, "rt1", { settleMs: 300, scrollSteps: 2, dwellMs: 50, marqueeSelectors: [["belt", ".track"]] });
    fs.mkdirSync(path.join(dir, "clone"), { recursive: true });
    // 600px path over 6s linear = 100px/s — the oracle the runner must measure
    fs.writeFileSync(path.join(dir, "clone", "index.html"), `<!doctype html><html><head><style>
      @keyframes belt { from { transform: translateX(0); } to { transform: translateX(-600px); } }
      .track { width: 1200px; height: 40px; background: #ddd; animation: belt 6s linear infinite; }
    </style></head><body><div class="track"></div><p style="height:2000px">tall</p></body></html>`);
    const r = await run(["rt1", "--side", "clone"], work); // default path: headless launch (no silent attach exists to interfere)
    if (r.code !== 0 && /environment refused/.test(r.out)) {
      console.log("✓ skipped real-Chrome integration (headless is not a measurement environment on this Chrome — the probe refused it, which is the designed behavior)");
    } else {
      check("real-Chrome clone capture exits 0", r.code === 0, r.out.slice(0, 600));
      const snap = JSON.parse(fs.readFileSync(path.join(dir, "behaviors-clone.json"), "utf8"));
      check("documentHidden is false in a launched Chrome", snap.discovery.documentHidden === false);
      check("attestation: cdp-launched + probe receipts", snap.discovery.runner.mode === "cdp-launched" && snap.discovery.runner.animProbe.measuredPxPerSec > 60);
      const speed = snap.behaviors["marquee:belt"] && snap.behaviors["marquee:belt"].measured.pxPerSec;
      check(`known 100px/s marquee measured within ±40% (got ${speed})`, speed > 60 && speed < 140);
    }
  }

  fs.rmSync(work, { recursive: true, force: true });
  console.log(failed ? `\n❌ behavior-runner-selftest: ${failed} check(s) failed.` : "\n✓ behavior-runner-selftest: all checks pass.");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("behavior-runner-selftest crashed:", e); process.exit(1); });
