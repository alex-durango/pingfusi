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

// ── LOCAL review mode (/__review) ─────────────────────────────────────────────
// The no-login path: the review page renders the latest LOCAL round's spec (same
// scope-pin/steps/changelog the remote round would carry), shows the clone in a
// same-origin iframe with click-to-pin, and enforces the SAME contract — a verdict
// button pick is mandatory; comments alone can't pass the gate. The submission is
// written into review-qa.json where `review-qa.js verify` reads it. Trust model: local
// verdicts are operator-trusted and recorded as provider:"local" — agents never open
// or submit this page themselves.
function latestLocalRound(hq) {
  const r = (hq && hq.rounds || [])[Math.max(0, (hq.rounds || []).length - 1)];
  return r && r.provider === "local" ? r : null;
}

// Pure: apply a review submission to the hq state. Returns {ok, message}.
function applySubmission(hq, body) {
  const round = latestLocalRound(hq);
  if (!round) return { ok: false, message: "no LOCAL round is latest — file one: pingfusi review <name> file --local" };
  if (round.raw_response && round.raw_response.n_received) return { ok: false, message: "this round is already answered — file a new round for another review" };
  if (!body || (body.choice == null && !(body.comments || []).length && !(body.free_text || "").trim())) return { ok: false, message: "empty submission" };
  const comments = (body.comments || []).filter((c) => c && c.text);
  const free = comments.length
    ? `${comments.length} comment(s): ` + comments.map((c) => `<${c.selector || "?"}> — ${c.text}`).join(" | ") + ((body.free_text || "").trim() ? " | " + body.free_text.trim() : "")
    : (body.free_text || "").trim() || null;
  round.raw_response = { status: "complete", n_received: 1, n_target: 1, responses: [{ choice: body.choice != null ? body.choice : null, free_text: free }], comments };
  round.answered_at = new Date().toISOString();
  return { ok: true, message: `recorded — verdict: ${body.choice != null ? JSON.stringify(body.choice) : "NONE (comments only — the gate will refuse; pick a verdict button)"}` };
}

function renderReviewPage(hq, name) {
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const round = latestLocalRound(hq);
  if (!round) return `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:2rem">No local review round is pending for <b>${esc(name)}</b>.<br>File one: <code>pingfusi review ${esc(name)} file --local</code></body>`;
  if (round.raw_response && round.raw_response.n_received) return `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:2rem">This round is already answered (${esc((round.raw_response.responses[0] || {}).choice || "no verdict")}).<br>File a new round for another review.</body>`;
  const spec = round.spec || { title: "Review", instructions: "", steps: [], verdict_options: round.approve_verdicts || ["Approve"] };
  return `<!doctype html><meta charset="utf-8"><title>${esc(spec.title)}</title>
<body style="margin:0;font:14px/1.45 system-ui;display:grid;grid-template-columns:minmax(340px,28%) 1fr;height:100vh">
<div style="overflow:auto;padding:16px;border-right:1px solid #ddd;background:#fafafa">
  <h2 style="margin:0 0 8px;font-size:16px">${esc(spec.title)} <span style="color:#888;font-weight:normal">(local review)</span></h2>
  <p style="color:#444">${esc(spec.instructions)}</p>
  <ol style="padding-left:18px;color:#333">${(spec.steps || []).map((s) => `<li style="margin:6px 0">${esc(s.text)}</li>`).join("")}</ol>
  <p><button id="pin" style="padding:6px 10px">📌 Pin mode: OFF</button> <span style="color:#888">— toggle, then click anything in the clone that looks wrong</span></p>
  <ul id="pins" style="padding-left:18px"></ul>
  <p><textarea id="free" placeholder="anything else?" style="width:100%;height:56px"></textarea></p>
  <p><b>Verdict (required):</b><br>${(spec.verdict_options || []).map((v) => `<label style="display:block;margin:4px 0"><input type="radio" name="v" value="${esc(v)}"> ${esc(v)}</label>`).join("")}</p>
  <p><button id="go" style="padding:8px 14px;font-weight:600">Submit review</button> <span id="msg" style="color:#c00"></span></p>
</div>
<iframe id="clone" src="/" style="border:0;width:100%;height:100%"></iframe>
<script>
var pins=[],mode=false;
var pinBtn=document.getElementById('pin');
pinBtn.onclick=function(){mode=!mode;pinBtn.textContent='📌 Pin mode: '+(mode?'ON':'OFF')};
document.getElementById('clone').addEventListener('load',function(){
  var doc=this.contentDocument;
  doc.addEventListener('click',function(e){
    if(!mode)return;e.preventDefault();e.stopPropagation();
    var el=e.target;
    var sel=el.id?('#'+el.id):(el.tagName.toLowerCase()+(el.className&&typeof el.className==='string'?'.'+el.className.trim().split(/\\s+/).slice(0,2).join('.'):''));
    var txt=prompt('What looks wrong here? ('+sel+')');
    if(txt){pins.push({selector:sel,text:txt});
      var li=document.createElement('li');li.textContent=sel+' — '+txt;document.getElementById('pins').appendChild(li);}
  },true);
});
document.getElementById('go').onclick=function(){
  var v=document.querySelector('input[name=v]:checked');
  if(!v){document.getElementById('msg').textContent='pick a verdict button — comments alone cannot pass the gate';return;}
  fetch('/__review/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({choice:v.value,free_text:document.getElementById('free').value,comments:pins})})
    .then(r=>r.json()).then(function(r){document.body.innerHTML='<div style="font:16px system-ui;padding:2rem">'+(r.ok?'✓ recorded. You can close this tab — the agent picks it up via verify.':'❌ '+r.message)+'</div>'});
};
</script></body>`;
}

function serve(name, port) {
  const PKG = path.resolve(__dirname, "..");   // the installed kit: /tools/* served from here
  const WORK = process.cwd();                  // the user's dir: targets/<name>/clone lives here
  const cloneDir = path.join(WORK, "targets", name, "clone");
  const toolsDir = path.join(PKG, "tools");
  const hqPath = path.join(WORK, "targets", name, "review-qa.json");
  const readHq = () => { try { return JSON.parse(fs.readFileSync(hqPath, "utf8")); } catch (e) { return { rounds: [] }; } };
  if (!fs.existsSync(cloneDir)) { console.error(`no targets/${name}/clone — run: pingfusi new ${name} <url>`); process.exit(1); }
  http.createServer((req, res) => {
    const u = req.url.split("?")[0];
    if (u === "/__review" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderReviewPage(readHq(), name));
      return;
    }
    if (u === "/__review/submit" && req.method === "POST") {
      let body = "";
      req.on("data", (d) => { body += d; if (body.length > 1e6) req.destroy(); });
      req.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) {}
        const hq = readHq();
        const r = applySubmission(hq, parsed);
        if (r.ok) fs.writeFileSync(hqPath, JSON.stringify(hq, null, 2) + "\n");
        console.log(`local review submission: ${r.message}`);
        res.writeHead(r.ok ? 200 : 400, { "content-type": "application/json" });
        res.end(JSON.stringify(r));
      });
      return;
    }
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
  }).listen(port, () => console.log(`serving targets/${name}/clone → http://localhost:${port}   (/tools/* → kit tools)`));
}

if (require.main === module) {
  const name = process.argv[2], port = +(process.argv[3] || 8080);
  if (!name) { console.error("usage: pingfusi serve <target-name> [port]"); process.exit(1); }
  serve(name, port);
}
module.exports = { resolvePath, serve, applySubmission, renderReviewPage };
