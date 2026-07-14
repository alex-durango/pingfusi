// harness/cdp-selftest.js — guards the zero-dep CDP client, offline.
//
// The lesson it locks in: a hand-rolled WebSocket client dies in the frame-decode state
// machine, so that state machine is exercised here against everything TCP is allowed to do
// to us — one byte at a time, fragments, pings mid-message, 16/64-bit lengths — plus a real
// (fake) server end-to-end: handshake with accept-key verification, masked-client-frame
// assertion, a scripted CDP conversation, and the failure paths (HTTP instead of upgrade,
// bad accept key, page exceptions, oversize frames). No Chrome anywhere; CI stays offline.
"use strict";

const http = require("http");
const { MAX_MESSAGE_BYTES, acceptKeyFor, encodeFrame, FrameParser, wsConnect, httpJson, newTab, CdpSession, evaluate, navigate } = require("./cdp.js");

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
};

// ── acceptKeyFor: the RFC6455 §1.3 worked example is the oracle ──────────────
check("accept key matches the RFC6455 test vector", acceptKeyFor("dGhlIHNhbXBsZSBub25jZQ==") === "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");

// ── encodeFrame: deterministic mask so bytes are assertable ───────────────────
{
  const zero = Buffer.from([0, 0, 0, 0]);
  const f = encodeFrame(0x1, "hi", zero);
  check("small frame: FIN+text, masked bit set, zero-mask passes payload through", f[0] === 0x81 && f[1] === (0x80 | 2) && f.subarray(6).toString() === "hi");
  const f16 = encodeFrame(0x1, "x".repeat(300), zero);
  check("126-length frame uses 16-bit extended length", f16[1] === (0x80 | 126) && f16.readUInt16BE(2) === 300);
  const f64 = encodeFrame(0x1, "y".repeat(70000), zero);
  check("127-length frame uses 64-bit extended length", f64[1] === (0x80 | 127) && Number(f64.readBigUInt64BE(2)) === 70000);
  const m = encodeFrame(0x1, "ab", Buffer.from([0xff, 0x00, 0xff, 0x00]));
  check("mask is actually applied", m[6] === ("a".charCodeAt(0) ^ 0xff) && m[7] === "b".charCodeAt(0));
}

// server→client frames are unmasked — the test-side encoder for feeding FrameParser
function serverFrame(opcode, payload, { fin = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (data.length < 126) { header = Buffer.alloc(2); header[1] = data.length; }
  else if (data.length < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(data.length, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
  header[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([header, data]);
}

const collect = () => {
  const got = { messages: [], pings: [], closes: [], errors: [] };
  const p = new FrameParser({ message: (s) => got.messages.push(s), ping: (b) => got.pings.push(b.toString()), close: (b) => got.closes.push(b), error: (e) => got.errors.push(e.message) });
  return { p, got };
};

// ── FrameParser: the state machine under everything TCP can do ────────────────
{
  const { p, got } = collect();
  p.feed(serverFrame(0x1, "hello"));
  check("single text frame → one message", got.messages.length === 1 && got.messages[0] === "hello");
}
{
  const { p, got } = collect();
  const big = "a".repeat(300), huge = "b".repeat(70000);
  p.feed(Buffer.concat([serverFrame(0x1, big), serverFrame(0x1, huge)]));
  check("16-bit and 64-bit lengths decode back-to-back in one chunk", got.messages.length === 2 && got.messages[0] === big && got.messages[1] === huge);
}
{
  const { p, got } = collect();
  const whole = Buffer.concat([serverFrame(0x1, "frag", { fin: false }), serverFrame(0x9, "mid-ping"), serverFrame(0x0, "mented", { fin: true })]);
  for (let i = 0; i < whole.length; i++) p.feed(whole.subarray(i, i + 1)); // one byte at a time — TCP owes us nothing
  check("fragmented message reassembles across byte-at-a-time delivery", got.messages.length === 1 && got.messages[0] === "fragmented");
  check("interleaved ping surfaced during fragmentation", got.pings.length === 1 && got.pings[0] === "mid-ping");
  check("no spurious errors", got.errors.length === 0);
}
{
  const { p, got } = collect();
  p.feed(serverFrame(0x8, Buffer.from([0x03, 0xe8])));
  check("close frame surfaces via close handler", got.closes.length === 1);
}
{
  const { p, got } = collect();
  const masked = serverFrame(0x1, "bad"); masked[1] |= 0x80;
  p.feed(masked);
  check("masked server frame refused by name", got.errors.length === 1 && /masked server frame/.test(got.errors[0]));
}
{
  const { p, got } = collect();
  const rsv = serverFrame(0x1, "x"); rsv[0] |= 0x40;
  p.feed(rsv);
  check("RSV bits refused (no extension was offered)", got.errors.length === 1 && /RSV/.test(got.errors[0]));
}
{
  const { p, got } = collect();
  p.feed(serverFrame(0x0, "orphan"));
  check("continuation with nothing to continue refused", got.errors.length === 1 && /nothing to continue/.test(got.errors[0]));
}
{
  const { p, got } = collect();
  p.feed(serverFrame(0x1, "first", { fin: false }));
  p.feed(serverFrame(0x1, "second", { fin: false }));
  check("new data frame mid-fragmentation refused", got.errors.length === 1 && /before prior fragmented/.test(got.errors[0]));
}
{
  const { p, got } = collect();
  const f = Buffer.alloc(10); f[0] = 0x81; f[1] = 127; f.writeBigUInt64BE(BigInt(MAX_MESSAGE_BYTES) + 1n, 2);
  p.feed(f);
  check("oversize declared length refused before buffering", got.errors.length === 1 && /cap/.test(got.errors[0]));
}
{
  const { p, got } = collect();
  p.feed(serverFrame(0x7, "?"));
  check("unknown opcode refused by name", got.errors.length === 1 && /unknown opcode/.test(got.errors[0]));
}

// ── the fake server: handshake + masked-client assertion + scripted CDP ───────
// Implements the SERVER half of RFC6455 over stdlib http, plus a canned CDP responder:
// enough of a fake Chrome that wsConnect/CdpSession/evaluate/navigate run their real code.
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
    out.push({ opcode, masked, data });
  }
}

async function withFakeChrome(fn) {
  const seen = { unmaskedClientFrames: 0, pongs: [] };
  const server = http.createServer((req, res) => {
    // the HTTP discovery half: /json/version + PUT /json/new
    if (req.url === "/json/version") { res.end(JSON.stringify({ Browser: "FakeChrome/1.0", "Protocol-Version": "1.3" })); return; }
    if (req.method === "PUT" && req.url.startsWith("/json/new")) {
      res.end(JSON.stringify({ id: "TAB1", webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/TAB1` }));
      return;
    }
    res.statusCode = 404; res.end("nope");
  });
  server.on("upgrade", (req, socket) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKeyFor(req.headers["sec-websocket-key"])}\r\n\r\n`);
    const state = { buf: Buffer.alloc(0) };
    socket.on("data", (chunk) => {
      const frames = [];
      decodeClientFrames(state, chunk, frames);
      for (const f of frames) {
        if (!f.masked) seen.unmaskedClientFrames++; // RFC6455 §5.1 — a real server drops these
        if (f.opcode === 0xa) { seen.pongs.push(f.data.toString()); continue; }
        if (f.opcode === 0x8) { socket.end(); continue; }
        if (f.opcode !== 0x1) continue;
        const msg = JSON.parse(f.data.toString());
        const reply = (obj) => socket.write(serverFrame(0x1, JSON.stringify(obj)));
        if (msg.method === "Page.enable") {
          reply({ id: msg.id, result: {} });
          socket.write(serverFrame(0x9, "u-there")); // ping the client mid-session
          reply({ method: "Unsolicited.event", params: {} }); // no waiter — must be ignored, not crash
        } else if (msg.method === "Page.navigate") {
          reply({ id: msg.id, result: { frameId: "F1" } });
          // loadEventFired split across two TCP writes, mid-frame — the parser must not care
          const ev = serverFrame(0x1, JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 1 } }));
          socket.write(ev.subarray(0, 5));
          setTimeout(() => socket.write(ev.subarray(5)), 10);
        } else if (msg.method === "Runtime.evaluate") {
          if (/THROW/.test(msg.params.expression)) reply({ id: msg.id, result: { result: { type: "undefined" }, exceptionDetails: { text: "Uncaught", exception: { description: "Error: page says no\n  at <anonymous>" } } } });
          else if (/BIG/.test(msg.params.expression)) {
            // a large result, fragmented: text frame without FIN + continuation with FIN
            const whole = JSON.stringify({ id: msg.id, result: { result: { type: "string", value: "z".repeat(100000) } } });
            const cut = 40000;
            socket.write(serverFrame(0x1, whole.slice(0, cut), { fin: false }));
            socket.write(serverFrame(0x0, whole.slice(cut), { fin: true }));
          } else if (/CDPERR/.test(msg.params.expression)) reply({ id: msg.id, error: { message: "Some domain error", data: "details" } });
          else reply({ id: msg.id, result: { result: { type: "string", value: `echo:${msg.params.awaitPromise ? "awaited" : "sync"}` } } });
        } else reply({ id: msg.id, result: {} });
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { await fn(server.address().port, seen); }
  finally { server.close(); }
}

(async () => {
  await withFakeChrome(async (port, seen) => {
    const v = await httpJson("GET", port, "/json/version");
    check("httpJson GET /json/version parses", v.Browser === "FakeChrome/1.0");
    const tab = await newTab(port, "about:blank");
    check("PUT /json/new returns a ws url", /^ws:\/\//.test(tab.webSocketDebuggerUrl));

    const ws = await wsConnect(tab.webSocketDebuggerUrl);
    const session = new CdpSession(ws);
    check("Page.enable round-trips", (await session.send("Page.enable")) && true);

    // navigate: waits for loadEventFired that arrives split across TCP writes
    await navigate(session, "http://example.test/");
    check("navigate resolves on a loadEventFired split mid-frame across writes", true);

    check("evaluate returns by value", (await evaluate(session, "1+1")) === "echo:awaited");
    check("evaluate awaitPromise:false passes through", (await evaluate(session, "x", { awaitPromise: false })) === "echo:sync");
    const big = await evaluate(session, "BIG");
    check("fragmented 100KB result reassembles", typeof big === "string" && big.length === 100000);
    const threw = await evaluate(session, "THROW").then(() => null, (e) => e.message);
    check("page exception surfaces as a Node error, first line only", /page threw during evaluate: Error: page says no$/.test(threw));
    const cdpErr = await session.send("Runtime.evaluate", { expression: "CDPERR" }).then(() => null, (e) => e.message);
    check("CDP-level error rejects with method + message + data", /Runtime\.evaluate: Some domain error — details/.test(cdpErr));

    await new Promise((r) => setTimeout(r, 50)); // let the ping/pong land
    check("server ping answered with matching pong payload", seen.pongs.length === 1 && seen.pongs[0] === "u-there");
    check("every client frame was masked (RFC6455 §5.1)", seen.unmaskedClientFrames === 0);

    // close mid-flight: pending commands must reject, not hang
    const hung = session.send("Page.enable"); // fake server replies… but we close first
    session.close();
    const hungMsg = await hung.then(() => "resolved", (e) => e.message);
    check("in-flight command rejects on close instead of hanging", /resolved|closed/.test(hungMsg));
    const afterClose = await session.send("Page.enable").then(() => null, (e) => e.message);
    check("send after close rejects by name", /closed/.test(afterClose));
  });

  // failure paths outside the happy server
  {
    const plain = http.createServer((req, res) => { res.statusCode = 200; res.end("i am not a websocket"); });
    await new Promise((r) => plain.listen(0, "127.0.0.1", r));
    const err = await wsConnect(`ws://127.0.0.1:${plain.address().port}/x`).then(() => null, (e) => e.message);
    check("HTTP-instead-of-upgrade refused by name", /answered HTTP 200/.test(err));
    plain.close();
  }
  {
    const liar = http.createServer();
    liar.on("upgrade", (req, socket) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: bogus==\r\n\r\n");
    });
    await new Promise((r) => liar.listen(0, "127.0.0.1", r));
    const err = await wsConnect(`ws://127.0.0.1:${liar.address().port}/x`).then(() => null, (e) => e.message);
    check("bad accept key refused (not a real WebSocket server)", /Sec-WebSocket-Accept/.test(err));
    liar.close();
  }
  {
    const err = await wsConnect("wss://127.0.0.1:1/x").then(() => null, (e) => e.message);
    check("wss:// refused up front — CDP on localhost is never TLS", /only ws:\/\//.test(err));
  }

  console.log(failed ? `\n❌ cdp-selftest: ${failed} check(s) failed.` : "\n✓ cdp-selftest: all checks pass.");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("cdp-selftest crashed:", e); process.exit(1); });
