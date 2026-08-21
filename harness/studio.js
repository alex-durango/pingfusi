#!/usr/bin/env node
// harness/studio.js — `pingfusi studio`: the local results viewer (playtests first).
//
// Remotion has `remotion studio`; this is ours for review rounds. The MCP results text
// is fine for an agent, but a human developer wants to WATCH a playtest session: the
// recording, the think-aloud transcript, the questionnaire answers, and the agent's
// findings, side by side. `pingfusi studio <ping_id>` fetches a round's results over
// the same wire every kit surface speaks (packages/core/wire.js), caches them under
// .pingfusi/studio/<ping_id>/, and serves a zero-dep local page to browse them.
//
// Why a cache: signed media URLs from the service die in ~1h and the objects behind
// them are retention-swept (recordings sooner than screenshots) — so the fetch step
// downloads media bytes next to the JSON, and the studio replays old rounds forever.
// The signed URL itself is never persisted; a refetch re-signs.
//
// READ-ONLY by doctrine (independent reviewers only): this is a results VIEWER. The
// server answers GET/HEAD and nothing else, there is no route that writes, and the one
// wire call is the passive `get_test_results` snapshot — a verdict is authored by the
// independent reviewer on the service, never here. `annotations.json` (agent-written
// observations, rendered read-only) carries notes and evidence anchors, no verdicts.
//
// MACHINE RUNS (a second, purely local axis): an internal rig harness plays game
// builds through a virtual gamepad and writes run directories into this same cache —
// .pingfusi/studio/runs/<run_id>/ with a `pingfusi-rig-run/v1` receipt.json plus
// optional media/recording.mp4, shots/*.png, and an annotations.json in the same
// findings schema review rounds use. The studio discovers and serves those read-only
// (no wire call — the rig writes the cache, the studio only serves). A machine run is
// a SEPARATE artifact family from a human review round — labeled so in the UI, never
// entering a ping or a response.
//
// USAGE
//   pingfusi studio [ping_id ...] [--port N] [--open] [--json] [--fetch-only] [--no-media]
//     with ids: fetch + cache those rounds (media included unless --no-media), then serve.
//     no ids:   refresh cached rounds that aren't complete yet, then serve the cache
//               (plus read-only discovery of .pingfusi/ skill receipts and ~/.pingfusi/asks).
//     --fetch-only exits after caching (--json prints the machine-readable summary);
//     --open opens the browser (opt-in — the default only prints the URL).
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { rpc, resolveToken, BASE } = require("../packages/core/wire.js");
const { PING_ID_RE } = require("./ask.js");

const CMD = process.env.PPK_ENTRY === "1" ? "pingfusi studio" : "node harness/studio.js";
const USAGE = `usage: ${CMD} [ping_id ...] [--port N] [--open] [--json] [--fetch-only] [--no-media]`;
const DEFAULT_PORT = 7788; // memorable, clear of serve's 8080 and sink's 7799
const CACHE_SCHEMA = "pingfusi-studio-cache/v1";
const RUN_RECEIPT_SCHEMA = "pingfusi-rig-run/v1";
// A run id doubles as a cache directory name — anything else is refused rather than
// spliced into a path (the PING_ID_RE doctrine, rig-run shaped).
const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;
const LARGE_MEDIA_NOTE_BYTES = 256 * 1024 * 1024;

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".ico": "image/x-icon" };

const readJsonSafe = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; } };
const listDirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (e) { return []; } };

// ── arguments ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") return { help: true };
  const out = { pingIds: [], port: DEFAULT_PORT, open: false, json: false, fetchOnly: false, noMedia: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--open") { out.open = true; continue; }
    if (arg === "--json") { out.json = true; continue; }
    if (arg === "--fetch-only") { out.fetchOnly = true; continue; }
    if (arg === "--no-media") { out.noMedia = true; continue; }
    if (arg === "--port") {
      const value = argv[++i];
      const port = Number.parseInt(value, 10);
      if (!value || !Number.isInteger(port) || String(port) !== value || port < 0 || port > 65535) {
        throw new Error(`--port needs a number 0-65535 — ${USAGE}`);
      }
      out.port = port;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown option ${arg} — ${USAGE}`);
    // The id doubles as a cache directory name — anything that isn't the service's
    // uuid shape is refused rather than spliced into a path (ask.js doctrine).
    if (!PING_ID_RE.test(arg)) throw new Error(`${JSON.stringify(arg)} is not a ping id (the 36-char id a filing printed) — ${USAGE}`);
    out.pingIds.push(arg.toLowerCase());
  }
  return out;
}

// ── cache: .pingfusi/studio/<ping_id>/{result.json, annotations.json, media/} ─
const studioDir = (workDir) => path.join(workDir, ".pingfusi", "studio");
// Machine runs live one level down, so a run dir can never shadow a round dir (and
// discoverRounds already skips the non-uuid "runs" name).
const runsDir = (workDir) => path.join(studioDir(workDir), "runs");

function atomicWriteJson(file, value) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temp = `${resolved}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(temp, resolved);
  return resolved;
}

// Media files are keyed by response index; the original basename (sanitized) is kept
// as metadata only — it carries the service's `rec-` session-recording discriminator.
function mediaNames(index, url) {
  let base = "";
  try { base = decodeURIComponent(new URL(url).pathname.split("/").pop() || ""); } catch (e) {}
  const original = base.replace(/[^A-Za-z0-9._-]/g, "_") || null;
  const extMatch = original && /\.[A-Za-z0-9]{1,5}$/.exec(original);
  const ext = extMatch ? extMatch[0].toLowerCase() : ".bin";
  return { file: `media/response-${index}${ext}`, original_name: original };
}

// The cached record is an ALLOWLIST over the service payload: results and reviewer
// feedback verbatim, agent-coaching envelope (feedback_policy, continuation, …) and
// account state (balance_after, topup_url) dropped, and the signed media_url NEVER
// persisted — it is dead within the hour; the downloaded bytes are the durable copy.
function toCacheRecord(sc, meta = {}) {
  const responses = Array.isArray(sc.responses) ? sc.responses : [];
  return {
    schema: CACHE_SCHEMA,
    ping_id: sc.ping_id || meta.pingId || null,
    fetched_at: new Date().toISOString(),
    base: meta.base || null,
    status: sc.status || "pending",
    n_received: Number(sc.n_received) || responses.length,
    n_target: Number(sc.n_target) || null,
    kind: sc.report_url ? "playtest" : sc.media_type === "video" ? "video" : "review",
    report_url: sc.report_url || null,
    poll_url: sc.poll_url || null,
    draft_url: sc.draft_url || null,
    media_type: sc.media_type || "web",
    video_url: sc.video_url || null,
    credits_charged: typeof sc.credits_charged === "number" ? sc.credits_charged : null,
    responses: responses.map((r) => ({
      choice: r.choice != null ? r.choice : r.verdict != null ? r.verdict : null,
      free_text: r.free_text || r.notes || null,
      answered_at: r.answered_at || null,
      steps_result: r.steps_result || null,
      transcript: r.transcript || null,
      media: null, // filled by the download step
    })),
    comments: Array.isArray(sc.comments) ? sc.comments : [],
    blocked_reports: Array.isArray(sc.blocked_reports) ? sc.blocked_reports : [],
  };
}

// Streamed both ways (a session recording can run to a GiB — never buffered), tmp file
// + rename so a crash never leaves a half-written file looking cached.
async function downloadMedia(url, destFile) {
  let res;
  try { res = await fetch(url); } catch (e) { return { ok: false, reason: "network-error" }; }
  if (!res.ok || !res.body) return { ok: false, reason: `http-${res.status}` };
  const declared = Number(res.headers.get("content-length")) || 0;
  if (declared > LARGE_MEDIA_NOTE_BYTES) console.log(`  large recording (~${Math.round(declared / 1e6)}MB) — streaming to disk…`);
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const temp = `${destFile}.tmp-${process.pid}`;
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(temp));
    fs.renameSync(temp, destFile);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    return { ok: false, reason: "network-error" };
  }
  return { ok: true, bytes: fs.statSync(destFile).size };
}

// One passive snapshot + media download. Downloads start right after the fetch that
// signed the URLs, so expiry-mid-download can't happen; a 403/404 here means the
// signature already lapsed or retention swept the object — recorded as a reason, and
// re-running the same command re-signs. Media objects are immutable, so an existing
// non-empty file is reused instead of re-downloaded.
async function fetchRound(pingId, opts = {}, deps = {}) {
  const call = deps.rpc || rpc;
  const workDir = path.resolve(deps.workDir || process.cwd());
  // full_transcripts: the studio caches to disk, so it asks for each response's
  // whole transcript object in structured content (the conversational default
  // carries overflow-only, to protect the waiting agent's context). An older
  // service ignores the unknown arg — the transcript is then simply absent.
  const sc = await call("get_test_results", { ping_id: pingId, full_transcripts: true });
  const record = toCacheRecord(sc, { pingId, base: deps.base || BASE });
  const dir = path.join(studioDir(workDir), record.ping_id || pingId);
  const raw = Array.isArray(sc.responses) ? sc.responses : [];
  for (let i = 0; i < raw.length; i++) {
    const url = raw[i] && raw[i].media_url;
    if (!url) continue;
    const names = mediaNames(i, url);
    const dest = path.join(dir, names.file);
    const existing = fs.existsSync(dest) ? fs.statSync(dest) : null;
    if (existing && existing.size > 0) {
      record.responses[i].media = { file: names.file, original_name: names.original_name, bytes: existing.size, downloaded_at: existing.mtime.toISOString() };
      continue;
    }
    if (opts.noMedia) { record.responses[i].media = { unavailable: "skipped" }; continue; }
    const got = await downloadMedia(url, dest);
    record.responses[i].media = got.ok
      ? { file: names.file, original_name: names.original_name, bytes: got.bytes, downloaded_at: new Date().toISOString() }
      : { unavailable: got.reason };
  }
  atomicWriteJson(path.join(dir, "result.json"), record);
  return record;
}

// ── discovery: the studio cache, plus read-only local round receipts ──────────
// Skill receipts (.pingfusi/video/*, .pingfusi/beautify/*) and ask records
// (~/.pingfusi/asks) surface in the rail as-is; the cache wins on a duplicate id.
function discoverRounds(deps = {}) {
  const workDir = path.resolve(deps.workDir || process.cwd());
  const home = deps.home || os.homedir();
  const rounds = [];
  const cacheDir = studioDir(workDir);
  for (const id of listDirs(cacheDir)) {
    if (!PING_ID_RE.test(id)) continue;
    const rec = readJsonSafe(path.join(cacheDir, id, "result.json"));
    if (!rec) continue;
    const responses = Array.isArray(rec.responses) ? rec.responses : [];
    rounds.push({
      ping_id: rec.ping_id || id,
      kind: rec.kind || "review",
      status: rec.status || "pending",
      n_received: rec.n_received || 0,
      n_target: rec.n_target || null,
      fetched_at: rec.fetched_at || null,
      label: `${rec.kind || "review"} · ${id.slice(0, 8)}`,
      has_media: responses.some((r) => r && r.media && r.media.file),
      has_transcript: responses.some((r) => r && r.transcript),
      has_annotations: fs.existsSync(path.join(cacheDir, id, "annotations.json")),
      source: "cache",
    });
  }
  for (const area of ["video", "beautify"]) {
    for (const name of listDirs(path.join(workDir, ".pingfusi", area))) {
      for (const f of ["review.json", "state.json"]) {
        const statePath = path.join(workDir, ".pingfusi", area, name, f);
        const state = readJsonSafe(statePath);
        if (!state || !Array.isArray(state.rounds)) continue;
        state.rounds.forEach((r, i) => {
          if (!r || !r.ping_id || !PING_ID_RE.test(String(r.ping_id))) return;
          if (rounds.some((x) => x.ping_id === r.ping_id)) return;
          rounds.push({
            ping_id: r.ping_id, kind: area, status: (r.last && r.last.status) || "pending",
            n_received: (r.last && r.last.n_received) || 0, n_target: r.n_target || null,
            fetched_at: r.filed_at || null, label: `${name} · round ${i + 1}`,
            has_media: false, has_transcript: false, has_annotations: false,
            source: "receipt", receipt_path: statePath,
          });
        });
        break;
      }
    }
  }
  const asksD = path.join(home, ".pingfusi", "asks");
  const askFiles = fs.existsSync(asksD) ? fs.readdirSync(asksD).filter((n) => n.endsWith(".json")) : [];
  for (const f of askFiles) {
    const rec = readJsonSafe(path.join(asksD, f));
    if (!rec || !rec.ping_id || !PING_ID_RE.test(String(rec.ping_id))) continue;
    if (rounds.some((x) => x.ping_id === rec.ping_id)) continue;
    rounds.push({
      ping_id: rec.ping_id, kind: "ask", status: (rec.last && rec.last.status) || "pending",
      n_received: (rec.last && rec.last.n_received) || 0, n_target: rec.n_target || 1,
      fetched_at: rec.asked_at || null,
      label: rec.question ? String(rec.question).slice(0, 60) : `ask · ${String(rec.ping_id).slice(0, 8)}`,
      has_media: false, has_transcript: false, has_annotations: false,
      source: "ask", receipt_path: path.join(asksD, f),
    });
  }
  rounds.sort((a, b) => String(b.fetched_at || "").localeCompare(String(a.fetched_at || "")));
  return rounds;
}

// ── discovery: machine runs the rig wrote under .pingfusi/studio/runs/ ────────
// A rig run is a SEPARATE artifact family from a review round: the machine harness
// writes it locally, nothing is filed and nothing is charged — the studio only lists
// and serves it. A malformed receipt is skipped (readJsonSafe tolerance), never a crash.

// A receipt's media references are exactly two components (media/<file> or
// shots/<file>); anything else is ignored rather than joined — same refusal shape as
// the router below.
function runFilePath(runDir, rel) {
  const m = /^(media|shots)\/([A-Za-z0-9._-]+)$/.exec(String(rel || ""));
  if (!m || m[2].startsWith(".")) return null;
  return path.join(runDir, m[1], m[2]);
}

// The rail/gym summary over one receipt — tolerant of every optional field; null on a
// receipt that isn't a JSON object at all.
function toRunSummary(rec, runDir, dirName) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  const build = rec.build && typeof rec.build === "object" ? rec.build : {};
  const perf = rec.performance && rec.performance.summary && typeof rec.performance.summary === "object" ? rec.performance.summary : {};
  const failure = rec.failure_cause && typeof rec.failure_cause === "object" ? rec.failure_cause : null;
  const recording = rec.media ? runFilePath(runDir, rec.media.recording) : null;
  return {
    run_id: dirName,
    gym_id: rec.gym && rec.gym.id != null ? String(rec.gym.id) : null,
    gym_version: rec.gym && rec.gym.version != null ? String(rec.gym.version) : null,
    build_label: build.label || build.filename || (typeof build.sha256 === "string" ? build.sha256.slice(0, 12) : null),
    build_sha256: typeof build.sha256 === "string" ? build.sha256 : null,
    platform: build.platform || null,
    mode: rec.mode || null,
    result: rec.result || (rec.ok === true ? "pass" : rec.ok === false ? "fail" : null),
    ok: typeof rec.ok === "boolean" ? rec.ok : null,
    failure_kind: failure ? failure.kind || null : null,
    failure_message: failure ? failure.message || null : null,
    at: rec.at || null,
    duration_ms: typeof rec.duration_ms === "number" ? rec.duration_ms : null,
    avg_fps: typeof perf.avg_fps === "number" ? perf.avg_fps : null,
    one_percent_low_fps: typeof perf.one_percent_low_fps === "number" ? perf.one_percent_low_fps : null,
    has_media: !!(recording && fs.existsSync(recording)),
    has_annotations: fs.existsSync(path.join(runDir, "annotations.json")),
    warnings_count: Array.isArray(rec.warnings) ? rec.warnings.length : 0,
  };
}

function discoverRuns(deps = {}) {
  const workDir = path.resolve(deps.workDir || process.cwd());
  const root = runsDir(workDir);
  const runs = [];
  for (const name of listDirs(root)) {
    if (!RUN_ID_RE.test(name)) continue;
    const dir = path.join(root, name);
    const summary = toRunSummary(readJsonSafe(path.join(dir, "receipt.json")), dir, name);
    if (summary) runs.push(summary);
  }
  // Time order, oldest first — the gym view charts fps ACROSS builds left to right.
  runs.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
  return runs;
}

// The gym axis over already-sorted summaries: per-gym run order plus the per-build
// series the fps-across-builds chart draws. Runs with no gym never form a group.
function groupRunsByGym(runs) {
  const gyms = {};
  for (const r of runs) {
    if (!r.gym_id) continue;
    const g = gyms[r.gym_id] || (gyms[r.gym_id] = { runs_in_order: [], builds: [] });
    g.runs_in_order.push(r.run_id);
    g.builds.push({ build_label: r.build_label, build_sha256: r.build_sha256, result: r.result, avg_fps: r.avg_fps, one_percent_low_fps: r.one_percent_low_fps, at: r.at, run_id: r.run_id });
  }
  return gyms;
}

// ── server: GET/HEAD only, static UI + cache JSON + Range-streamed media ──────
// Pure router + traversal guard (serve.js precedent — unit-tested without a socket).
// Every path component is validated BEFORE any join: ping ids must be the uuid shape,
// file names a single flat [A-Za-z0-9._-] component that doesn't start with a dot; the
// path.relative check stays as the belt-and-braces boundary (Windows-safe by construction).
function resolveStudioPath(urlPath, { uiDir, cacheDir }) {
  let u;
  try { u = decodeURIComponent(String(urlPath).split("?")[0]); } catch (e) { return null; } // malformed % — unresolvable, not a crash
  if (u === "/") u = "/index.html";
  if (u === "/api/rounds") return { kind: "rounds" };
  if (u === "/api/runs") return { kind: "runs" };
  let m = /^\/api\/round\/([^/]+)$/.exec(u);
  if (m) return PING_ID_RE.test(m[1]) ? { kind: "round", pingId: m[1].toLowerCase() } : null;
  m = /^\/api\/run\/([^/]+)$/.exec(u);
  if (m) return RUN_ID_RE.test(m[1]) ? { kind: "run", runId: m[1] } : null;
  // Machine-run media: exactly two components after the id (media/<file> or
  // shots/<file>), each validated before any join. "run" can never collide with the
  // round route below — a ping id is 36 chars of uuid.
  m = /^\/media\/run\/([^/]+)\/(media|shots)\/([^/]+)$/.exec(u);
  if (m) {
    if (!RUN_ID_RE.test(m[1]) || !/^[A-Za-z0-9._-]+$/.test(m[3]) || m[3].startsWith(".")) return null;
    const fp = path.resolve(cacheDir, "runs", m[1], m[2], m[3]);
    const within = path.relative(cacheDir, fp);
    if (within.startsWith("..") || path.isAbsolute(within)) return null;
    return { kind: "file", path: fp, mime: MIME[path.extname(fp).toLowerCase()] || "application/octet-stream" };
  }
  m = /^\/media\/([^/]+)\/([^/]+)$/.exec(u);
  if (m) {
    if (!PING_ID_RE.test(m[1]) || !/^[A-Za-z0-9._-]+$/.test(m[2]) || m[2].startsWith(".")) return null;
    const fp = path.resolve(cacheDir, m[1].toLowerCase(), "media", m[2]);
    const within = path.relative(cacheDir, fp);
    if (within.startsWith("..") || path.isAbsolute(within)) return null;
    return { kind: "file", path: fp, mime: MIME[path.extname(fp).toLowerCase()] || "application/octet-stream" };
  }
  const rel = u.slice(1);
  if (!/^[A-Za-z0-9._-]+$/.test(rel) || rel.startsWith(".")) return null;
  const fp = path.resolve(uiDir, rel);
  const within = path.relative(uiDir, fp);
  if (within.startsWith("..") || path.isAbsolute(within)) return null;
  return { kind: "file", path: fp, mime: MIME[path.extname(fp).toLowerCase()] || "application/octet-stream" };
}

// Range/206 on fs.stat + createReadStream — NOT serve.js's whole-file readFile, which
// would buffer a GiB recording per request. Same regex/416 semantics as serve.js
// (Chromium refuses <video> from a server that ignores Range).
function serveFileWithRange(req, res, fp, mime) {
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end("404 not found"); return; }
    const size = st.size;
    const m = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (m && (m[1] || m[2])) {
      const start = m[1] ? +m[1] : Math.max(0, size - +m[2]);
      const end = Math.min(m[1] && m[2] ? +m[2] : size - 1, size - 1);
      if (start > end || start >= size) { res.writeHead(416, { "content-range": `bytes */${size}` }); res.end(); return; }
      res.writeHead(206, { "content-type": mime, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
      if (req.method === "HEAD") { res.end(); return; }
      fs.createReadStream(fp, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { "content-type": mime, "accept-ranges": "bytes", "content-length": size });
    if (req.method === "HEAD") { res.end(); return; }
    fs.createReadStream(fp).pipe(res);
  });
}

function sendJson(req, res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(req.method === "HEAD" ? undefined : body);
}

// Returns the http.Server so the caller (main, selftest) binds the port — port 0 works.
function createStudioServer(deps = {}) {
  const workDir = path.resolve(deps.workDir || process.cwd());
  const home = deps.home || os.homedir();
  const cacheDir = studioDir(workDir);
  const uiDir = deps.uiDir || path.join(__dirname, "studio-ui");
  return http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }); res.end("405 method not allowed — the studio is a read-only viewer"); return; }
    const route = resolveStudioPath(req.url, { uiDir, cacheDir });
    if (!route) { res.writeHead(403); res.end("403 forbidden"); return; }
    if (route.kind === "rounds") return sendJson(req, res, 200, { rounds: discoverRounds({ workDir, home }) });
    if (route.kind === "runs") {
      const runs = discoverRuns({ workDir });
      return sendJson(req, res, 200, { runs, gyms: groupRunsByGym(runs) });
    }
    if (route.kind === "run") {
      const dir = path.join(runsDir(workDir), route.runId);
      const receipt = readJsonSafe(path.join(dir, "receipt.json"));
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return sendJson(req, res, 404, { error: "run not found — the rig writes machine runs under .pingfusi/studio/runs/<run_id>/" });
      return sendJson(req, res, 200, { receipt, annotations: readJsonSafe(path.join(dir, "annotations.json")) });
    }
    if (route.kind === "round") {
      const rec = readJsonSafe(path.join(cacheDir, route.pingId, "result.json"));
      if (rec) return sendJson(req, res, 200, { result: rec, annotations: readJsonSafe(path.join(cacheDir, route.pingId, "annotations.json")) });
      const entry = discoverRounds({ workDir, home }).find((r) => String(r.ping_id).toLowerCase() === route.pingId);
      if (entry && entry.receipt_path) return sendJson(req, res, 200, { receipt: readJsonSafe(entry.receipt_path), source: entry.source, label: entry.label });
      return sendJson(req, res, 404, { error: "round not cached — fetch it: pingfusi studio <ping_id>" });
    }
    serveFileWithRange(req, res, route.path, route.mime);
  });
}

// ── browser opener (opt-in via --open; the default only prints the URL) ───────
// Pure invocation builder so the Windows shape is pinnable from any host (proc.js
// doctrine: shell:true does not escape args, so the url is quoted in ONE place).
function openerInvocation(url, platform = process.platform) {
  if (platform === "win32") return { command: `start "" "${url}"`, args: null, shell: true };
  return { command: platform === "darwin" ? "open" : "xdg-open", args: [url], shell: false };
}

function openBrowser(url) {
  const inv = openerInvocation(url);
  const child = inv.shell
    ? spawn(inv.command, { shell: true, stdio: "ignore", detached: true })
    : spawn(inv.command, inv.args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); }
  catch (error) { console.error(`✗ ${error.message}`); process.exitCode = 2; return; }
  if (options.help) { console.log(USAGE); return; }
  const workDir = process.cwd();
  const cacheDir = studioDir(workDir);
  let ids = options.pingIds;
  if (!ids.length) {
    // Passive refresh of cached rounds still in flight — one snapshot each, never a wait
    // (waiting is `pingfusi wait`'s job; the studio only looks).
    const live = discoverRounds({ workDir }).filter((r) => r.source === "cache" && r.status !== "complete");
    if (live.length && !resolveToken() && !BASE.startsWith("file://")) {
      console.log("note: no review login — serving the cache as-is (run `pingfusi setup` to refresh rounds still in flight)");
    } else {
      ids = live.map((r) => r.ping_id);
    }
  }
  const fetched = [];
  let fetchFailures = 0;
  for (const id of ids) {
    try {
      const rec = await fetchRound(id, options, { workDir });
      fetched.push(rec);
      const media = rec.responses.filter((r) => r.media && r.media.file).length;
      console.log(`✓ ${rec.kind} ${id} — ${rec.status}, ${rec.n_received}/${rec.n_target == null ? "?" : rec.n_target} result(s)${media ? `, ${media} media file(s) cached` : ""}`);
    } catch (error) {
      fetchFailures++;
      const stale = fs.existsSync(path.join(cacheDir, id, "result.json"));
      console.error(`✗ ${id}: ${error.message}${stale ? " — serving the cached copy" : ""}`);
    }
  }
  // The analysis hook: a cached transcript with no annotations.json is work an agent
  // can do (the contract is docs/STUDIO.md). Printed here — on the command an agent
  // already runs — so the ask lands in its context at exactly the right moment.
  const analysisGaps = discoverRounds({ workDir }).filter((r) => r.source === "cache" && r.has_transcript && !r.has_annotations);
  if (analysisGaps.length && !options.json) {
    console.log(`${analysisGaps.length} round(s) have think-aloud transcripts but no findings yet — an agent can write the analysis:`);
    for (const r of analysisGaps) console.log(`  read ${path.join(cacheDir, r.ping_id, "result.json")} → write ${path.join(cacheDir, r.ping_id, "annotations.json")}`);
    console.log("  contract + guidance: docs/STUDIO.md in the kit install (`pingfusi where`)");
  }
  if (options.fetchOnly) {
    if (options.json) console.log(JSON.stringify({
      cache_dir: cacheDir,
      rounds: fetched,
      analysis_contract: "docs/STUDIO.md",
      analysis_needed: analysisGaps.map((r) => ({ ping_id: r.ping_id, annotations_path: path.join(cacheDir, r.ping_id, "annotations.json") })),
    }, null, 2));
    process.exitCode = fetchFailures ? 1 : 0;
    return;
  }
  const server = createStudioServer({ workDir });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") { console.error(`port ${options.port} is already in use — pass another: ${CMD} --port ${options.port + 1}`); process.exit(1); }
    console.error(`studio failed: ${e.message}`);
    process.exit(1);
  });
  server.listen(options.port, () => {
    const url = `http://localhost:${server.address().port}`;
    const known = discoverRounds({ workDir });
    const knownRuns = discoverRuns({ workDir });
    console.log(`pingfusi studio → ${url}   (${known.length} round(s)${knownRuns.length ? ` + ${knownRuns.length} machine run(s)` : ""} — read-only results viewer)`);
    if (!known.length && !knownRuns.length) console.log(`  nothing cached yet — fetch a round: ${CMD} <ping_id>`);
    if (options.open) openBrowser(url);
  });
  return server;
}

module.exports = { USAGE, DEFAULT_PORT, CACHE_SCHEMA, RUN_RECEIPT_SCHEMA, RUN_ID_RE, MIME, parseArgs, studioDir, runsDir, atomicWriteJson, mediaNames, toCacheRecord, downloadMedia, fetchRound, discoverRounds, toRunSummary, discoverRuns, groupRunsByGym, resolveStudioPath, serveFileWithRange, createStudioServer, openerInvocation, main };
if (require.main === module) void main();
