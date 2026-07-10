// sink.js — a small receiver for snapshots (run: node tools/sink.js, or `pingfusi sink`)
//
// The clone (same-origin localhost, no strict CSP) can POST its capture straight
// to a file with one call — `pxSend("http://localhost:7799/clone.json")` — instead
// of the stash/read dance the live CSP site needs. This is that receiver: it writes
// the POST body to ./<name> where <name> comes from the URL path.
//
//   pingfusi sink
//   // in the clone page console / automation:
//   await pxSend("http://localhost:7799/clone.json")        // full snapshot
//   await pxSend("http://localhost:7799/el_clone.json", null) // (or stash an inspect dump)
const http = require("http"), fs = require("fs"), crypto = require("crypto");

// A snapshot is KBs; anything near this is a mistake, not a capture. Env-overridable so the
// mid-stream abort below is testable with a small limit (PPK_SINK_MAX_BYTES) and the port
// doesn't collide in tests (PPK_SINK_PORT).
const MAX_BYTES = +(process.env.PPK_SINK_MAX_BYTES || 20 * 1024 * 1024);
const PORT = +(process.env.PPK_SINK_PORT || 7799);

// Decide what to do with a received body BEFORE writing it, so we never silently persist
// garbage (an empty POST, a "[BLOCKED…]" automation sentinel, or non-JSON under a .json name).
// Pure + exported so it's unit-tested without opening a socket. Returns { status, write, message }.
function classifyBody(name, body) {
  if (!body || !body.trim()) return { status: 400, write: false, message: `empty body for ${name} — capture returned nothing (the finder/injection likely failed).` };
  if (body.length > MAX_BYTES) return { status: 413, write: false, message: `body for ${name} is ${body.length} bytes (> ${MAX_BYTES}) — that's not a snapshot; refusing.` };
  if (/^\s*\[BLOCKED/.test(body)) return { status: 422, write: false, message: `body for ${name} is a "[BLOCKED…]" automation sentinel, not a snapshot — the return was blocked; use the stash/read path (RUNBOOK).` };
  if (/\.json$/i.test(name)) { try { JSON.parse(body); } catch (e) { return { status: 200, write: true, message: `⚠ wrote ${name} but it is NOT valid JSON (${e.message}) — pixel-diff will reject it; re-capture.` }; } }
  return { status: 200, write: true, message: `ok ${name}` };
}

// A query string is transport noise, not part of the filename — strip it BEFORE sanitizing,
// or `/clone.json?t=1` would fuse into `clone.jsont1` and the artifact lands under the wrong
// name while the caller sees "ok".
function sanitizeName(url) {
  const raw = url.split("?")[0].replace(/^\//, "");
  const clean = raw.replace(/[^a-z0-9._-]/gi, "") || "snap.json";
  return { clean, renamed: clean !== raw };
}

// Senders (pxSend/pxSendDom) declare the payload's exact byte count + sha256 in the query
// string; verify BEFORE writing. Big DOMs have been silently truncated in POST transport —
// the file landed short, the sender saw "ok", and the gates certified a fraction of the
// page. A refusal here turns that half-hour silent failure into an instant, named one.
// No declaration (older callers, hand-rolled POSTs) = no integrity gate, as before.
// Both pure + exported for the selftest.
function parseDeclared(url) {
  const p = new URLSearchParams(url.split("?")[1] || "");
  const bytes = p.get("bytes");
  return { bytes: bytes != null && /^\d+$/.test(bytes) ? +bytes : null, sha256: p.get("sha256") || null };
}
function checkIntegrity(declared, buf) {
  if (declared.bytes != null && buf.length !== declared.bytes)
    return `received ${buf.length} bytes but the sender declared ${declared.bytes} — payload TRUNCATED/altered in transport; nothing written. Deliver via pxSave instead (byte-exact browser download, RUNBOOK Step 0).`;
  if (declared.sha256) {
    const got = crypto.createHash("sha256").update(buf).digest("hex");
    if (got !== declared.sha256)
      return `sha256 mismatch (declared ${declared.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…) — payload corrupted in transport; nothing written. Deliver via pxSave instead (RUNBOOK Step 0).`;
  }
  return null;
}

if (require.main === module) {
  http
    .createServer((q, s) => {
      s.setHeader("Access-Control-Allow-Origin", "*");
      if (q.method === "OPTIONS") { s.end(); return; }
      const { clean: name, renamed } = sanitizeName(q.url);
      if (renamed) console.warn(`⚠ POST path "${q.url}" sanitized to ./${name} (only a-z0-9._- kept — sub-paths are flattened).`);
      const declared = parseDeclared(q.url);
      const chunks = [];
      let received = 0, aborted = false;
      // Enforce the size bound DURING streaming — checking only at `end` would accumulate an
      // unbounded body in memory first (a runaway stream could OOM the process). Chunks stay
      // Buffers until the end: per-chunk utf8 decoding (`body += d`) corrupts any multi-byte
      // glyph that straddles a chunk boundary.
      q.on("data", (d) => {
        if (aborted) return;
        received += d.length;
        if (received > MAX_BYTES) {
          aborted = true;
          const msg = `body for ${name} exceeded ${MAX_BYTES} bytes — aborted mid-stream; that's not a snapshot.`;
          console.log(msg);
          s.writeHead(413);
          s.end(msg);
          q.destroy();
          chunks.length = 0;
        } else chunks.push(d);
      });
      q.on("end", () => {
        if (aborted) return;
        const buf = Buffer.concat(chunks);
        const broken = checkIntegrity(declared, buf);
        if (broken) {
          const msg = `${name}: ${broken}`;
          console.log(msg);
          s.writeHead(409);
          s.end(msg);
          return;
        }
        const r = classifyBody(name, buf.toString("utf8"));
        if (r.write) fs.writeFileSync(name, buf);
        console.log(r.message);
        s.writeHead(r.status);
        s.end(r.message);
      });
    })
    .on("error", (e) => {
      // self-describing, actionable — never a raw stack for a predictable failure
      if (e.code === "EADDRINUSE") { console.error(`port ${PORT} is already in use (another sink running?) — stop it, or set PPK_SINK_PORT=<n>`); process.exit(1); }
      console.error(`sink failed: ${e.message}`);
      process.exit(1);
    })
    .listen(PORT, () => console.log(`sink on http://localhost:${PORT}  (POST /<name>.json → ./<name>.json)`));
}
module.exports = { classifyBody, sanitizeName, parseDeclared, checkIntegrity, MAX_BYTES };
