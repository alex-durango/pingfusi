// harness/cdp.js — a zero-dep Chrome DevTools Protocol client: RFC6455 WebSocket framing
// over the stdlib, plus the half-dozen CDP commands the capture runner needs.
//
// WHY hand-rolled: the kit ships in the public npm package with five tiny CLI deps and no
// browser driver. playwright-core would add tens of MB for the ~2% of it we'd use, and its
// failure modes can't be fixtured offline — this client's can (harness/cdp-selftest.js runs
// a fake WebSocket server through pathological chunking). Scope is deliberately narrow:
// localhost only, no TLS, no extensions offered (so none negotiated — no permessage-deflate),
// text frames in, text frames out.
//
// WHY HTTP endpoints instead of Target.attachToTarget: one WebSocket per page target via
// PUT /json/new means no sessionId multiplexing — half the protocol surface, half the risk.
const http = require("http");
const crypto = require("crypto");

// A behaviors payload is KBs; anything huge is a bug, not a snapshot (same philosophy as
// tools/sink.js MAX_BYTES — a named, actionable refusal beats an OOM).
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"; // RFC6455 §1.3 — fixed by the spec

function acceptKeyFor(secKey) {
  return crypto.createHash("sha1").update(secKey + WS_GUID).digest("base64");
}

// Encode one client→server frame. Client frames MUST be masked (RFC6455 §5.1 — servers
// drop unmasked client frames). `maskBytes` is injectable so the selftest is deterministic.
function encodeFrame(opcode, payload, maskBytes) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || "", "utf8");
  const mask = maskBytes || crypto.randomBytes(4);
  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | data.length;
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = 0x80 | opcode; // FIN — we never fragment outgoing (largest send is the injected capture source, well under one frame)
  const masked = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

// Incremental server→client frame decoder. Fed arbitrary chunks (1 byte at a time in the
// selftest — TCP owes us nothing), emits complete MESSAGES (fragments reassembled), answers
// pings, surfaces close. This state machine is where every hand-rolled ws client dies,
// which is exactly why it's a standalone class with no socket in sight.
class FrameParser {
  constructor(handlers) {
    this.h = handlers; // { message(str), ping(payload), close(payload), error(err) }
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentedOpcode = null;
  }
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (true) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f;
      if (b0 & 0x70) return this.h.error(new Error("ws: RSV bits set — an extension was negotiated that we never offered"));
      if (b1 & 0x80) return this.h.error(new Error("ws: masked server frame — protocol violation (RFC6455 §5.1)"));
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) return this.h.error(new Error(`ws: ${big}-byte frame exceeds the ${MAX_MESSAGE_BYTES}-byte cap — a CDP result this size is a bug, not a payload`));
        len = Number(big); off = 10;
      }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (opcode === 0x9) { this.h.ping(payload); continue; }        // ping → caller pongs
      if (opcode === 0x8) { this.h.close(payload); continue; }       // close handshake
      if (opcode === 0xa) continue;                                  // pong — we never ping, ignore
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        // Fragmentation: first frame carries the opcode, continuations carry 0x0, FIN ends it.
        if (opcode !== 0x0 && this.fragments.length) return this.h.error(new Error("ws: new data frame before prior fragmented message finished"));
        if (opcode === 0x0 && !this.fragments.length) return this.h.error(new Error("ws: continuation frame with nothing to continue"));
        this.fragments.push(payload);
        const total = this.fragments.reduce((n, f) => n + f.length, 0);
        if (total > MAX_MESSAGE_BYTES) return this.h.error(new Error(`ws: fragmented message exceeds the ${MAX_MESSAGE_BYTES}-byte cap`));
        if (fin) {
          const whole = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
          this.fragments = [];
          this.h.message(whole.toString("utf8"));
        }
        continue;
      }
      return this.h.error(new Error(`ws: unknown opcode 0x${opcode.toString(16)}`));
    }
  }
}

// Dial ws://host:port/path, complete the upgrade handshake (verifying the accept key —
// a proxy or wrong port answering 200 must fail loudly here, not hang later), resolve a
// small socket wrapper: { send(text), close(), onMessage, onClose }.
function wsConnect(wsUrl, { timeoutMs = 10000 } = {}) {
  const u = new URL(wsUrl);
  if (u.protocol !== "ws:") return Promise.reject(new Error(`ws: only ws:// is supported (got ${u.protocol}//) — CDP on localhost is never TLS`));
  const secKey = crypto.randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port: u.port || 80, path: u.pathname + u.search, timeout: timeoutMs,
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": 13, "Sec-WebSocket-Key": secKey },
    });
    req.on("timeout", () => { req.destroy(); reject(new Error(`ws: no upgrade from ${u.host} within ${timeoutMs}ms`)); });
    req.on("error", (e) => reject(new Error(`ws: connect to ${u.host} failed: ${e.message}`)));
    req.on("response", (res) => reject(new Error(`ws: ${u.host} answered HTTP ${res.statusCode} instead of upgrading — wrong port, or the tab is gone`)));
    req.on("upgrade", (res, socket) => {
      if ((res.headers["sec-websocket-accept"] || "") !== acceptKeyFor(secKey)) {
        socket.destroy();
        return reject(new Error("ws: bad Sec-WebSocket-Accept — the endpoint is not a real WebSocket server"));
      }
      socket.setNoDelay(true);
      const ws = {
        onMessage: null, onClose: null, closed: false,
        send(text) { if (!this.closed) socket.write(encodeFrame(0x1, text)); },
        close() {
          if (this.closed) return;
          this.closed = true;
          try { socket.write(encodeFrame(0x8, Buffer.from([0x03, 0xe8]))); } catch (e) {} // 1000 normal closure
          socket.end();
        },
      };
      const parser = new FrameParser({
        message: (s) => ws.onMessage && ws.onMessage(s),
        ping: (p) => { if (!ws.closed) socket.write(encodeFrame(0xa, p)); },
        close: () => { const was = ws.closed; ws.close(); socket.destroy(); if (!was && ws.onClose) ws.onClose(); },
        error: (err) => { ws.close(); socket.destroy(); if (ws.onClose) ws.onClose(err); },
      });
      socket.on("data", (c) => parser.feed(c));
      socket.on("close", () => { const was = ws.closed; ws.closed = true; if (!was && ws.onClose) ws.onClose(); });
      socket.on("error", () => {}); // surfaced via onClose; a raw ECONNRESET must not crash the runner
      resolve(ws);
    });
    req.end();
  });
}

// --- Chrome's HTTP discovery endpoints (the non-WebSocket half of CDP) -----------------

function httpJson(method, port, pathname, { host = "127.0.0.1", timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ method, host, port, path: pathname, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`CDP http ${method} ${pathname} → ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(body ? JSON.parse(body) : null); } catch (e) { resolve(body); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error(`CDP http ${method} ${pathname} timed out after ${timeoutMs}ms`)); });
    req.on("error", (e) => reject(new Error(`CDP http ${method} ${pathname} failed: ${e.message} — is Chrome's debugging port up?`)));
    req.end();
  });
}

const version = (port, opts) => httpJson("GET", port, "/json/version", opts);
// PUT, not GET — GET /json/new was removed in modern Chrome (~111); PUT is the supported verb.
const newTab = (port, url, opts) => httpJson("PUT", port, "/json/new?" + encodeURIComponent(url || "about:blank"), opts);
const closeTab = (port, id, opts) => httpJson("GET", port, `/json/close/${id}`, opts).catch(() => {}); // teardown must never throw

// --- The CDP session: JSON-RPC over one page-target WebSocket ---------------------------

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();   // id → {resolve, reject, method}
    this.eventWaiters = [];     // {event, resolve, timer}
    this.closedErr = null;
    ws.onMessage = (text) => {
      let msg; try { msg = JSON.parse(text); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`CDP ${p.method}: ${msg.error.message}${msg.error.data ? ` — ${msg.error.data}` : ""}`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        const matched = this.eventWaiters.filter((w) => w.event === msg.method);
        if (matched.length) {
          this.eventWaiters = this.eventWaiters.filter((w) => w.event !== msg.method);
          for (const w of matched) { clearTimeout(w.timer); w.resolve(msg.params || {}); }
        }
      }
    };
    ws.onClose = (err) => {
      // Chrome died or the tab closed mid-command: every in-flight promise must reject with
      // something actionable, never hang the runner.
      this.closedErr = err || new Error("CDP connection closed — Chrome exited or the tab was closed mid-command");
      for (const [, p] of this.pending) p.reject(new Error(`CDP ${p.method}: ${this.closedErr.message}`));
      this.pending.clear();
      for (const w of this.eventWaiters.splice(0)) { clearTimeout(w.timer); w.reject(this.closedErr); }
    };
  }
  send(method, params) {
    if (this.closedErr) return Promise.reject(new Error(`CDP ${method}: ${this.closedErr.message}`));
    // ws.close() is synchronous but the socket's close event is not — without this check a
    // send in that window would be silently dropped and its promise would hang forever.
    if (this.ws.closed) return Promise.reject(new Error(`CDP ${method}: connection closed`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  waitFor(event, { timeoutMs = 30000 } = {}) {
    if (this.closedErr) return Promise.reject(this.closedErr);
    return new Promise((resolve, reject) => {
      const w = { event, resolve, reject };
      w.timer = setTimeout(() => {
        this.eventWaiters.splice(this.eventWaiters.indexOf(w), 1);
        reject(new Error(`CDP: no ${event} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.eventWaiters.push(w);
    });
  }
  close() { this.ws.close(); }
}

// Open a fresh tab on a debugging port and return an attached, Page-enabled session.
async function openPage(port, { host, url } = {}) {
  const tab = await newTab(port, url || "about:blank", { host });
  if (!tab || !tab.webSocketDebuggerUrl) throw new Error(`CDP: /json/new returned no webSocketDebuggerUrl — Chrome too old for PUT /json/new? (${JSON.stringify(tab).slice(0, 200)})`);
  const ws = await wsConnect(tab.webSocketDebuggerUrl);
  const session = new CdpSession(ws);
  await session.send("Page.enable");
  return { session, targetId: tab.id };
}

// Navigate and wait for load. On timeout, consult document.readyState: a page that reached
// "complete" but never fired loadEventFired to us (event raced the enable) proceeds with a
// warning instead of failing a run that actually loaded.
async function navigate(session, url, { timeoutMs = 30000, warn = () => {} } = {}) {
  const loaded = session.waitFor("Page.loadEventFired", { timeoutMs }).then(() => "load", () => null);
  const nav = await session.send("Page.navigate", { url });
  if (nav.errorText) throw new Error(`CDP: navigation to ${url} failed: ${nav.errorText}`);
  if (await loaded) return;
  const state = await evaluate(session, "document.readyState", { awaitPromise: false }).catch(() => "unknown");
  if (state === "complete" || state === "interactive") { warn(`no load event within ${timeoutMs}ms but document.readyState=${state} — proceeding`); return; }
  throw new Error(`CDP: ${url} did not finish loading within ${timeoutMs}ms (readyState=${state}) — slow site? raise --nav-timeout`);
}

// Runtime.evaluate with the runner's defaults: await promises, return by value, surface
// page-side exceptions as Node errors (never a silent undefined).
async function evaluate(session, expression, { awaitPromise = true, timeoutMs } = {}) {
  const r = await session.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, ...(timeoutMs ? { timeout: timeoutMs } : {}) });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || "unknown page exception";
    throw new Error(`CDP: page threw during evaluate: ${String(desc).split("\n")[0]}`);
  }
  return r.result ? r.result.value : undefined;
}

module.exports = { MAX_MESSAGE_BYTES, acceptKeyFor, encodeFrame, FrameParser, wsConnect, httpJson, version, newTab, closeTab, CdpSession, openPage, navigate, evaluate };
