// harness/capture-runner-selftest.js — guards the CDP capture runner (capture-run).
//
// OFFLINE (always runs): the full conversation against a fake Chrome — probe, unconditional
// viewport normalization, navigate, inject, value-mode capture, artifact + receipt writes —
// plus the contracts that must never soften: the settle STOP (a page still growing writes
// NOTHING), the bot-wall ladder ending in the interactive FALLBACK (never a dead end), and
// side=auto picking live-only until a clone exists. INTEGRATION (skip-if-absent): the real
// local Chrome headless captures a fixture clone and the snapshot's viewport must be EXACTLY
// the normalized one — width, height, and dpr 2 (the heyaristotle bug, pinned for good).
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
        } else if (msg.method === "Emulation.setDeviceMetricsOverride") {
          metricsCalls.push(msg.params);
          reply({});
        } else if (msg.method === "Runtime.evaluate") {
          const e = msg.params.expression;
          if (e.includes("__ppkProbe")) value(acts.probe || GOOD_PROBE);
          else if (e.includes("iw: innerWidth")) value(acts.viewportRead || { iw: 1440, cw: 1440, ih: 982, dpr: 2 });
          else if (e === "document.title") value(acts.title || "Fake Page");
          else if (e === "typeof pxCaptureAll") value("function");
          else if (e.startsWith("pxCaptureAll(")) {
            const prefix = /"prefix":"(\w+)"/.exec(e) ? /"prefix":"(\w+)"/.exec(e)[1] : "live";
            value(acts.report ? acts.report(prefix) : GOOD_REPORT(prefix));
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
    check("no artifacts written for an unsettled page", !fs.existsSync(path.join(work, "targets", "t2", "live.json")) && !fs.existsSync(path.join(work, "targets", "t2", "dom.html")));
    server.close();
  }

  // ── bot wall is an ERROR (the docs' contract: "fall back when capture-run's error
  //    says so") — artifacts stay as evidence, the exit code is the verdict ──────────
  {
    makeTarget(work, "t3");
    const server = await fakeChrome([{ title: "Just a moment..." }]);
    const r = await run(["t3", "--attach", `127.0.0.1:${server.address().port}`], work);
    check("challenge title → exit 1, ladder + interactive fallback in the ERROR", r.code === 1 && /bot-challenge wall/.test(r.out) && /--profile/.test(r.out) && /pxCaptureAll\('<sink_url>'\)/.test(r.out));
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
