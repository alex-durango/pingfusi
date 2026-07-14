// harness/serve.js <target-name> [port] — static server for one target's clone.
//
// Serves targets/<name>/clone/ at / AND the kit's tools/ at /tools/, so the clone
// page can `fetch('/tools/browser-capture.js')` (single source of truth — no copy to
// keep in sync). Zero deps. Pair with `node tools/sink.js` to receive snapshots.
const http = require("http"), fs = require("fs"), path = require("path");
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".ico": "image/x-icon" };

// Resolve a request URL to a real file path WITHIN one of the allowed roots, or null.
// The boundary check uses path.relative (not startsWith), so a sibling prefix like
// `<clone>-evil` or any `../` traversal is rejected — matching the canonical
// workspace-boundary guard the kit's diff tools rely on. Pure + exported so it's unit-tested
// without opening a socket.
function resolvePath(urlPath, { cloneDir, toolsDir }) {
  // A malformed percent-encoding ("/%", "/%zz") throws URIError; uncaught inside the request
  // handler it would kill the whole server mid-session — treat it as unresolvable instead.
  let u;
  try { u = decodeURIComponent(urlPath.split("?")[0]); } catch (e) { return null; }
  if (u === "/") u = "/index.html";
  const base = u.startsWith("/tools/") ? toolsDir : cloneDir;
  const rel = u.startsWith("/tools/") ? u.slice(7) : u.slice(1);
  const fp = path.resolve(base, rel);
  const within = path.relative(base, fp);
  if (within.startsWith("..") || path.isAbsolute(within)) return null; // traversal / prefix escape
  return fp;
}

// (Local review mode — the /__review page — was removed 2026-07-10: the independent
// reviewer on the review service is the only review path.)

// Returns the http.Server so a caller can bind port 0 and read the real address —
// the behavior runner self-serves the clone on an ephemeral port this way.
function serve(name, port) {
  const PKG = path.resolve(__dirname, "..");   // the installed kit: /tools/* served from here
  const WORK = process.cwd();                  // the user's dir: targets/<name>/clone lives here
  const cloneDir = path.join(WORK, "targets", name, "clone");
  const toolsDir = path.join(PKG, "tools");
  if (!fs.existsSync(cloneDir)) { console.error(`no targets/${name}/clone — run: pingfusi new ${name} <url>`); process.exit(1); }
  const server = http.createServer((req, res) => {
    const fp = resolvePath(req.url, { cloneDir, toolsDir });
    if (!fp) { res.writeHead(403); res.end("403 forbidden"); return; }
    fs.readFile(fp, (e, buf) => {
      if (e) { res.writeHead(404); res.end("404 " + req.url); return; }
      const type = MIME[path.extname(fp)] || "application/octet-stream";
      // Range support: Chromium refuses to play <video> from a server that ignores
      // Range (media loads fail with MEDIA_ERR_SRC_NOT_SUPPORTED — yc round 2, a
      // captured clone's videos rendered as blank tiles). Serve 206 slices.
      const m = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (m && (m[1] || m[2])) {
        const start = m[1] ? +m[1] : Math.max(0, buf.length - +m[2]);
        const end = Math.min(m[1] && m[2] ? +m[2] : buf.length - 1, buf.length - 1);
        if (start > end || start >= buf.length) { res.writeHead(416, { "content-range": `bytes */${buf.length}` }); res.end(); return; }
        res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${buf.length}`, "accept-ranges": "bytes", "content-length": end - start + 1, "access-control-allow-origin": "*" });
        res.end(buf.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "access-control-allow-origin": "*" });
      res.end(buf);
    });
  }).on("error", (e) => {
    // self-describing, actionable — never a raw stack for a predictable failure
    if (e.code === "EADDRINUSE") { console.error(`port ${port} is already in use — pass another: pingfusi serve ${name} <port>  (e.g. ${port + 1})`); process.exit(1); }
    console.error(`serve failed: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, () => console.log(`serving targets/${name}/clone → http://localhost:${server.address().port}   (/tools/* → kit tools)`));
  return server;
}

if (require.main === module) {
  const name = process.argv[2], port = +(process.argv[3] || 8080);
  if (!name) { console.error("usage: pingfusi serve <target-name> [port]"); process.exit(1); }
  serve(name, port);
}
module.exports = { resolvePath, serve };
