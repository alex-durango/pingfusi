// harness/studio-selftest.js — guards `pingfusi studio`, the local results viewer.
//
// Four sections: pure units (args, router/traversal guard, cache mapping, the machine-
// run summary), the fetch path end-to-end over the file:// mock transport (media
// downloaded from an in-test fixture server — the child is spawned ASYNC because a
// spawnSync child fetching from an in-process server would deadlock the blocked event
// loop), the HTTP server against a seeded cache (Range slices included, plus the runs
// axis: rig-written receipts under .pingfusi/studio/runs/, gym grouping, run media),
// and the doctrine pins: the studio is a READ-ONLY viewer — its one wire verb is the
// passive results snapshot, its server answers GET/HEAD only (the rig writes the runs
// cache; the studio only serves it), and no shipped studio surface says a banned
// vocabulary word. All fixtures are generated in tmpdirs at runtime — nothing
// committed, so the packed tarball's machine-path scan has nothing to find here.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const studio = require("./studio.js");

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed++; console.log(`  ✗ ${msg}`); } };
const throwsMsg = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
const runNode = (args, opts) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, opts);
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});

console.log("studio-selftest — the local results viewer");

const ID = "00000000-0000-4000-8000-0000000057d1";
const ID2 = "00000000-0000-4000-8000-0000000057d2";
const ID3 = "00000000-0000-4000-8000-0000000057d3";
const ID4 = "00000000-0000-4000-8000-0000000057d4";

// ── parseArgs ─────────────────────────────────────────────────────────────────
ok(studio.parseArgs(["--help"]).help === true && studio.parseArgs(["help"]).help === true, "--help / help short-circuit");
{
  const p = studio.parseArgs([ID.toUpperCase(), "--port", "7789", "--open", "--json", "--fetch-only", "--no-media"]);
  ok(p.pingIds.length === 1 && p.pingIds[0] === ID, "ping ids are validated and lowercased");
  ok(p.port === 7789 && p.open && p.json && p.fetchOnly && p.noMedia, "every flag parses");
  ok(studio.parseArgs([]).port === studio.DEFAULT_PORT, "default port applies");
  ok(studio.parseArgs(["--port", "0"]).port === 0, "--port 0 (ephemeral) is allowed for tests");
}
ok(/unknown option/.test(throwsMsg(() => studio.parseArgs(["--bogus"]))), "an unknown flag is a named refusal");
ok(/not a ping id/.test(throwsMsg(() => studio.parseArgs(["not-a-uuid"]))), "a non-uuid id is refused before any path join");
ok(/--port needs/.test(throwsMsg(() => studio.parseArgs(["--port", "banana"]))), "a non-numeric --port is refused");

// ── openerInvocation (pure; --open stays opt-in and Windows-safe) ─────────────
{
  const win = studio.openerInvocation("http://localhost:7788", "win32");
  ok(win.shell === true && win.command === 'start "" "http://localhost:7788"', "win32 opener goes through the shell with the url quoted");
  const mac = studio.openerInvocation("http://localhost:7788", "darwin");
  ok(mac.shell === false && mac.command === "open" && mac.args[0] === "http://localhost:7788", "darwin opener is a plain `open` spawn");
  ok(studio.openerInvocation("x", "linux").command === "xdg-open", "everything else uses xdg-open");
}

// ── mediaNames ────────────────────────────────────────────────────────────────
{
  const rec = studio.mediaNames(0, "https://x.supabase.co/sign/qa-media/p/r/rec-1.mp4?token=abc123");
  ok(rec.file === "media/response-0.mp4" && rec.original_name === "rec-1.mp4", "media file is keyed by response index; original basename kept (rec- discriminator), query stripped");
  ok(studio.mediaNames(1, "https://x.co/p/r/noext").file === "media/response-1.bin", "no extension falls back to .bin");
  const weird = studio.mediaNames(2, "https://x.co/p/r/rec%20fi&le.MOV?t=1");
  ok(weird.file === "media/response-2.mov" && weird.original_name === "rec_fi_le.MOV", "names sanitize to [A-Za-z0-9._-]; extension lowercases");
  ok(studio.mediaNames(3, "::not a url::").file === "media/response-3.bin", "an unparseable url still yields a safe name");
}

// ── toCacheRecord: an ALLOWLIST over the service payload ─────────────────────
{
  const sc = {
    ping_id: ID, status: "complete", n_received: 1, n_target: 3,
    report_url: `https://pingfusi.com/playtest/p/${ID}`, poll_url: `https://pingfusi.com/p/${ID}`,
    credits_charged: 20, balance_after: 98, topup_url: "https://pingfusi.com/dashboard",
    feedback_policy: { authority: "ground_truth" }, qa_iteration_policy: { loop: "x" }, continuation: { required: true },
    responses: [{ choice: "Fun", free_text: "loved it", media_url: "https://signed.example/rec-1.mp4?token=SECRET",
      steps_result: [{ text: "Play", done: true, via: "manual", answer: null }],
      transcript: { schema: "playtest-transcript/v1", locale: "en-US", transcript_status: "ok", segments: [{ t_ms: 0, end_ms: 900, text: "hm" }], markers: [] },
      answered_at: "2026-08-10T00:00:00Z" }],
    comments: [{ text: "stuck", video_anchor: { time_ms: 4200, x: 0.4, y: 0.6 } }],
  };
  const rec = studio.toCacheRecord(sc, { pingId: ID, base: "https://pingfusi.com" });
  const raw = JSON.stringify(rec);
  ok(rec.schema === studio.CACHE_SCHEMA && rec.kind === "playtest", "record carries the cache schema; report_url ⇒ kind playtest");
  ok(!raw.includes("media_url") && !raw.includes("token=") && !raw.includes("SECRET"), "the signed media url is NEVER persisted");
  ok(!raw.includes("feedback_policy") && !raw.includes("continuation") && !raw.includes("balance_after") && !raw.includes("topup_url"), "agent-coaching and account fields are dropped");
  ok(JSON.stringify(rec.responses[0].steps_result) === JSON.stringify(sc.responses[0].steps_result)
    && JSON.stringify(rec.responses[0].transcript) === JSON.stringify(sc.responses[0].transcript)
    && JSON.stringify(rec.comments) === JSON.stringify(sc.comments), "steps_result / transcript / comments ride verbatim");
  const receiptShape = studio.toCacheRecord({ responses: [{ verdict: "Pass", notes: "clean" }] }, { pingId: ID });
  ok(receiptShape.responses[0].choice === "Pass" && receiptShape.responses[0].free_text === "clean", "verdict/notes response shapes map to choice/free_text");
}

// ── resolveStudioPath: the traversal guard, socket-free ──────────────────────
{
  const uiDir = path.join(__dirname, "studio-ui");
  const cacheDir = path.join(os.tmpdir(), "studio-guard-fixture"); // never touched — pure routing
  const ctx = { uiDir, cacheDir };
  ok(studio.resolveStudioPath("/", ctx).path === path.join(uiDir, "index.html"), "/ serves the studio page");
  ok(studio.resolveStudioPath("/app.js?v=1", ctx).mime === "text/javascript", "static files resolve with the query stripped");
  ok(studio.resolveStudioPath("/api/rounds", ctx).kind === "rounds", "/api/rounds routes");
  ok(studio.resolveStudioPath(`/api/round/${ID.toUpperCase()}`, ctx).pingId === ID, "/api/round/<id> validates and lowercases the id");
  ok(studio.resolveStudioPath("/api/round/not-a-uuid", ctx) === null, "a malformed round id is unresolvable");
  const media = studio.resolveStudioPath(`/media/${ID}/response-0.mp4`, ctx);
  ok(media.path === path.join(cacheDir, ID, "media", "response-0.mp4") && media.mime === "video/mp4", "media resolves inside the round's media dir");
  ok(studio.resolveStudioPath(`/media/${ID}/response-0.mov`, ctx).mime === "video/quicktime", ".mov gets its real MIME (session recordings)");
  for (const bad of [
    `/media/${ID}/../result.json`, `/media/${ID}/%2e%2e%2fresult.json`, `/media/${ID}/.hidden`,
    "/media/not-a-uuid/f.mp4", "/..%2fstudio.js", "/%zz", "/nested/path.js", "/.git",
  ]) ok(studio.resolveStudioPath(bad, ctx) === null, `${JSON.stringify(bad)} is unresolvable (traversal/shape guard)`);

  // machine-run routes: same refusal doctrine, run-shaped ids, exactly-two-component media
  const RUN = "run-20260819-1432-ab12c";
  ok(studio.RUN_ID_RE.test(RUN) && !studio.RUN_ID_RE.test("Run-X") && !studio.RUN_ID_RE.test("short")
    && !studio.RUN_ID_RE.test("-leads") && !studio.RUN_ID_RE.test("a".repeat(65)),
    "RUN_ID_RE: lowercase run-shaped ids only (8-64 chars, no leading dash, no uppercase)");
  ok(studio.resolveStudioPath("/api/runs", ctx).kind === "runs", "/api/runs routes");
  ok(studio.resolveStudioPath(`/api/run/${RUN}`, ctx).runId === RUN, "/api/run/<run_id> validates the id");
  ok(studio.resolveStudioPath("/api/run/NOT-a-run", ctx) === null, "a malformed run id is unresolvable");
  const runMedia = studio.resolveStudioPath(`/media/run/${RUN}/media/recording.mp4`, ctx);
  ok(runMedia.path === path.join(cacheDir, "runs", RUN, "media", "recording.mp4") && runMedia.mime === "video/mp4",
    "run media resolves inside the run's own media dir");
  ok(studio.resolveStudioPath(`/media/run/${RUN}/shots/000061.png`, ctx).mime === "image/png", "run screenshots resolve under shots/");
  for (const bad of [
    `/media/run/${RUN}/media/../receipt.json`, `/media/run/${RUN}/media/%2e%2e%2freceipt.json`,
    `/media/run/${RUN}/media/a/b.mp4`, `/media/run/${RUN}/logs/x.txt`, `/media/run/${RUN}/media/.hidden`,
    `/media/run/${RUN}/media/%2Fabs.mp4`, "/media/run/NOT-a-run/media/f.mp4", `/media/run/${RUN}`,
  ]) ok(studio.resolveStudioPath(bad, ctx) === null, `${JSON.stringify(bad)} is unresolvable (run traversal/shape guard)`);
}

// ── toRunSummary: tolerant derivation over one rig receipt ────────────────────
{
  const nowhere = path.join(os.tmpdir(), "studio-run-fixture-none"); // never created — pure derivation
  const s = studio.toRunSummary({
    schema: studio.RUN_RECEIPT_SCHEMA, ok: false, result: "fail", at: "2026-08-19T14:32:00Z", duration_ms: 1830000,
    failure_cause: { kind: "crash", message: "boom", at_ms: 61234 },
    gym: { id: "collision_alley", version: "0.1.0" },
    build: { sha256: "deadbeef".repeat(8), platform: "windows" }, mode: "replay",
    performance: { source: "presentmon", summary: { avg_fps: 96.4, one_percent_low_fps: 41.5 } },
    warnings: ["replay diverged after 61s"],
  }, nowhere, "run-20260819-1432-ab12c");
  ok(s.run_id === "run-20260819-1432-ab12c" && s.gym_id === "collision_alley" && s.gym_version === "0.1.0",
    "a run summary carries the gym identity");
  ok(s.build_label === "deadbeefdead" && s.build_sha256 === "deadbeef".repeat(8),
    "no label/filename ⇒ the build label falls back to the sha256 prefix");
  ok(s.result === "fail" && s.ok === false && s.failure_kind === "crash" && s.failure_message === "boom",
    "result + failure cause derive from the receipt");
  ok(s.avg_fps === 96.4 && s.one_percent_low_fps === 41.5 && s.warnings_count === 1
    && s.has_media === false && s.has_annotations === false,
    "perf numbers and counts derive; media/annotations flags stay honest without files");
  const bare = studio.toRunSummary({ ok: true }, nowhere, "run-20260819-0000-bare0");
  ok(bare && bare.result === "pass" && bare.gym_id === null && bare.build_label === null && bare.avg_fps === null,
    "a minimal receipt still summarizes: ok:true ⇒ pass, every optional field null");
  ok(studio.toRunSummary(null, nowhere, "x") === null && studio.toRunSummary([1], nowhere, "x") === null,
    "a receipt that isn't a JSON object summarizes to null (skipped, never a crash)");
}

// ── async sections ────────────────────────────────────────────────────────────
(async () => {
  const MOCK = fs.mkdtempSync(path.join(os.tmpdir(), "ppk-studio-mock-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ppk-studio-home-"));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ppk-studio-work-"));
  const STUDIO = path.join(__dirname, "studio.js");
  const MEDIA_BYTES = Buffer.from("MOVDATA-0123456789abcdef");

  const mediaServer = http.createServer((req, res) => {
    if (req.url === "/rec-1.mp4") { res.writeHead(200, { "content-type": "video/mp4", "content-length": MEDIA_BYTES.length }); res.end(MEDIA_BYTES); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => mediaServer.listen(0, "127.0.0.1", resolve));
  const mediaPort = mediaServer.address().port;

  let studioServer = null;
  try {
    // downloadMedia: streams to a tmp file + rename; a swept/expired object is a reason
    {
      const dest = path.join(work, "dl", "a.mp4");
      const got = await studio.downloadMedia(`http://127.0.0.1:${mediaPort}/rec-1.mp4`, dest);
      ok(got.ok && got.bytes === MEDIA_BYTES.length && fs.readFileSync(dest).equals(MEDIA_BYTES), "downloadMedia streams the bytes to disk");
      const gone = await studio.downloadMedia(`http://127.0.0.1:${mediaPort}/gone.mp4`, path.join(work, "dl", "b.mp4"));
      ok(!gone.ok && gone.reason === "http-404" && !fs.existsSync(path.join(work, "dl", "b.mp4")), "a swept/expired object is a recorded reason, never a half-written file");
    }

    // fetch path end-to-end: file:// transport for results, real HTTP for media
    const payload = {
      ping_id: ID, status: "complete", n_received: 2, n_target: 3,
      report_url: `https://pingfusi.com/playtest/p/${ID}`, poll_url: `https://pingfusi.com/p/${ID}`,
      credits_charged: 40, balance_after: 60, feedback_policy: { authority: "ground_truth" }, continuation: { required: false },
      responses: [
        { choice: "Fun overall", free_text: "got confused once, kept playing", media_url: `http://127.0.0.1:${mediaPort}/rec-1.mp4`,
          answered_at: "2026-08-10T01:00:00Z",
          steps_result: [
            { text: "Play the game for about 10 minutes, thinking aloud.", done: true, via: "manual", answer: null },
            ...Array.from({ length: 11 }, (_, k) => ({ text: `Statement ${k + 1}`, done: true, via: "manual", answer: k % 3 === 0 ? "-1 · slightly disagree" : "+2 · agree" })),
            { text: "What would you change first?", done: true, via: "manual", answer: "the tutorial" },
          ],
          transcript: { schema: "playtest-transcript/v1", locale: "en-US", transcript_status: "ok",
            segments: [{ t_ms: 0, end_ms: 1500, text: "okay let me try this" }, { t_ms: 1500, end_ms: 5200, text: "why did I turn purple?" }],
            markers: [{ t_ms: 4200, label: "confused" }] } },
        { choice: "Confusing", free_text: null, media_url: null, answered_at: "2026-08-10T02:00:00Z",
          steps_result: [{ text: "Play the game for about 10 minutes, thinking aloud.", done: true, via: "manual", answer: null }] },
      ],
      comments: [{ step_index: null, text: "stuck at the gate", video_anchor: { time_ms: 4200, x: 0.4, y: 0.6, category: "confusion" } }],
    };
    fs.writeFileSync(path.join(MOCK, `get_test_results-${ID}.json`), JSON.stringify(payload));
    fs.writeFileSync(path.join(MOCK, `get_test_results-${ID2}.json`), JSON.stringify({ ping_id: ID2, status: "pending", n_received: 0, n_target: 1, responses: [] }));
    const env = { ...process.env, HOME: home, USERPROFILE: home, PPK_PINGHUMANS_URL: "file://" + MOCK };

    let r = await runNode([STUDIO, ID, "--fetch-only", "--json"], { cwd: work, env });
    ok(r.status === 0 && /✓ playtest/.test(r.stdout), "fetching a playtest round over the mock transport succeeds");
    const resultPath = path.join(work, ".pingfusi", "studio", ID, "result.json");
    const raw = fs.existsSync(resultPath) ? fs.readFileSync(resultPath, "utf8") : "";
    const rec = raw ? JSON.parse(raw) : null;
    ok(rec && rec.schema === studio.CACHE_SCHEMA && rec.kind === "playtest" && rec.n_received === 2, "result.json lands under .pingfusi/studio/<ping_id>/");
    ok(rec && rec.responses[0].media && rec.responses[0].media.file === "media/response-0.mp4"
      && rec.responses[0].media.original_name === "rec-1.mp4" && rec.responses[1].media === null,
      "media metadata records the cached file and the rec- discriminator; a media-less response stays null");
    const mediaFile = path.join(work, ".pingfusi", "studio", ID, "media", "response-0.mp4");
    ok(fs.existsSync(mediaFile) && fs.readFileSync(mediaFile).equals(MEDIA_BYTES), "the recording's bytes are cached beside the JSON (outliving the 1h signed url)");
    ok(!raw.includes("media_url") && !raw.includes("feedback_policy") && !raw.includes("balance_after"), "the cached record persists no signed url and no coaching/account fields");
    const jsonOut = r.stdout.slice(r.stdout.indexOf("\n{") + 1);
    let parsed = null;
    try { parsed = JSON.parse(jsonOut); } catch (e) {}
    ok(parsed && parsed.rounds && parsed.rounds[0] && parsed.rounds[0].ping_id === ID, "--json prints the machine-readable summary");
    ok(parsed && parsed.analysis_contract === "docs/STUDIO.md" && Array.isArray(parsed.analysis_needed)
      && parsed.analysis_needed.some((x) => x.ping_id === ID && /annotations\.json$/.test(x.annotations_path)),
      "--json names the analysis gap: transcripts cached, annotations.json not yet written");

    r = await runNode([STUDIO, ID2, "--fetch-only"], { cwd: work, env });
    ok(r.status === 0 && fs.existsSync(path.join(work, ".pingfusi", "studio", ID2, "result.json")), "a pending round caches its snapshot (exit 0 — pending is not a failure)");
    ok(/transcripts but no findings yet/.test(r.stdout) && /docs\/STUDIO\.md/.test(r.stdout)
      && r.stdout.includes(path.join("studio", ID, "annotations.json")),
      "the analysis hook prints on the command an agent already runs (read result.json → write annotations.json)");

    // logged out, no ids: the studio serves the cache as-is instead of failing
    const loggedOut = { ...process.env, HOME: home, USERPROFILE: home, PINGFUSI_TOKEN: "" };
    delete loggedOut.PPK_PINGHUMANS_URL; delete loggedOut.PPK_PINGHUMANS_TOKEN;
    delete loggedOut.PINGFUSI_APP_URL; delete loggedOut.PINGHUMANS_APP_URL;
    r = await runNode([STUDIO, "--fetch-only"], { cwd: work, env: loggedOut });
    ok(r.status === 0 && /no review login/.test(r.stdout + r.stderr), "logged out with no ids: one note, cache served as-is, no crash");

    // an unknown id against the mock transport fails the fetch but names the id
    r = await runNode([STUDIO, ID4, "--fetch-only"], { cwd: work, env });
    ok(r.status === 1 && new RegExp(ID4).test(r.stderr), "a fetch failure is a named error and a nonzero --fetch-only exit");

    // ── the server, against the now-seeded cache ─────────────────────────────
    fs.writeFileSync(path.join(work, ".pingfusi", "studio", ID, "annotations.json"), JSON.stringify({
      schema: "pingfusi-studio-annotations/v1", ping_id: ID, summary: "One theme dominates.",
      findings: [{ id: "f1", created_at: "2026-08-10T03:00:00Z", author: "agent", title: "Unclear status feedback",
        sentiment: "negative", body: "Both sessions hesitated at the status change.", tags: ["usability"],
        evidence: [{ response_index: 0, time_ms: 4200, quote: "why did I turn purple?" }] }],
    }));
    fs.mkdirSync(path.join(home, ".pingfusi", "asks"), { recursive: true });
    fs.writeFileSync(path.join(home, ".pingfusi", "asks", `${ID3}.json`), JSON.stringify({
      ping_id: ID3, question: "Which tagline reads better?", options: ["A", "B"], n_target: 1,
      asked_at: "2026-08-09T00:00:00Z", last: { status: "complete", n_received: 1, responses: [{ choice: "A", text: "cleaner" }] },
    }));

    // machine runs: rig-written receipts under .pingfusi/studio/runs/ — two builds of
    // one gym (one a failure with a cause), one ad-hoc recorded run with media +
    // annotations, one malformed receipt that must be skipped, one bad dir name.
    const RUN_A = "run-20260818-1200-aaa01";
    const RUN_B = "run-20260819-1432-bbb02";
    const RUN_C = "run-20260819-1600-ccc03";
    const RUN_BAD = "run-20260819-1700-bad04";
    const runsRoot = path.join(work, ".pingfusi", "studio", "runs");
    const writeRun = (id, receipt) => {
      fs.mkdirSync(path.join(runsRoot, id), { recursive: true });
      fs.writeFileSync(path.join(runsRoot, id, "receipt.json"), typeof receipt === "string" ? receipt : JSON.stringify(receipt));
    };
    writeRun(RUN_A, {
      schema: studio.RUN_RECEIPT_SCHEMA, run_id: RUN_A, at: "2026-08-18T12:00:00Z", duration_ms: 900000,
      ok: true, result: "pass", gym: { id: "collision_alley", version: "0.1.0" },
      build: { label: "build-41", sha256: "a1".repeat(32), platform: "windows" }, mode: "replay",
      performance: { source: "presentmon", summary: { avg_fps: 141.2, one_percent_low_fps: 88.1, series_1s: [141, 139, 140] } },
    });
    writeRun(RUN_B, {
      schema: studio.RUN_RECEIPT_SCHEMA, run_id: RUN_B, at: "2026-08-19T14:32:00Z", duration_ms: 1830000,
      ok: false, result: "fail", failure_cause: { kind: "expectation", message: "rung 7 unreachable", at_ms: 61234 },
      gym: { id: "collision_alley", version: "0.1.0" },
      build: { label: "build-42", sha256: "b2".repeat(32), platform: "windows" }, mode: "replay",
      performance: { source: "presentmon", summary: { avg_fps: 96.4, one_percent_low_fps: 41.5, series_1s: [141, 90, 60] } },
      warnings: ["replay diverged after 61s"],
    });
    writeRun(RUN_C, {
      schema: studio.RUN_RECEIPT_SCHEMA, run_id: RUN_C, at: "2026-08-19T16:00:00Z", duration_ms: 300000,
      ok: true, result: "pass", build: { filename: "Game.zip", platform: "windows" }, mode: "record",
      media: { recording: "media/recording.mp4", screenshots: [{ t_ms: 61234, file: "shots/000061.png", why: "stutter" }] },
      events: [{ t_ms: 300, kind: "load_stall", detail: "7.4s gap" }],
    });
    fs.mkdirSync(path.join(runsRoot, RUN_C, "media"), { recursive: true });
    fs.writeFileSync(path.join(runsRoot, RUN_C, "media", "recording.mp4"), MEDIA_BYTES);
    fs.mkdirSync(path.join(runsRoot, RUN_C, "shots"), { recursive: true });
    fs.writeFileSync(path.join(runsRoot, RUN_C, "shots", "000061.png"), Buffer.from("PNGBYTES"));
    fs.writeFileSync(path.join(runsRoot, RUN_C, "annotations.json"), JSON.stringify({
      schema: "pingfusi-studio-annotations/v1", summary: "One stall dominates.",
      findings: [{ id: "f1", title: "Long load stall", sentiment: "negative", evidence: [{ time_ms: 300, quote: "loading hangs" }] }],
    }));
    writeRun(RUN_BAD, "{ not json");
    fs.mkdirSync(path.join(runsRoot, "NOT-a-valid-RUN"), { recursive: true });
    fs.writeFileSync(path.join(runsRoot, "NOT-a-valid-RUN", "receipt.json"), JSON.stringify({ ok: true }));

    studioServer = studio.createStudioServer({ workDir: work, home });
    await new Promise((resolve) => studioServer.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${studioServer.address().port}`;

    let res = await fetch(`${base}/`);
    ok(res.status === 200 && /text\/html/.test(res.headers.get("content-type")) && (await res.text()).includes("pingfusi studio"), "GET / serves the studio page");
    res = await fetch(`${base}/api/rounds`);
    const rounds = (await res.json()).rounds;
    const entry = rounds.find((x) => x.ping_id === ID);
    ok(entry && entry.kind === "playtest" && entry.has_media && entry.has_transcript && entry.has_annotations && entry.source === "cache",
      "/api/rounds flags media, transcript, and annotations on the cached round");
    ok(rounds.some((x) => x.ping_id === ID2 && x.status === "pending"), "…lists the pending round");
    ok(rounds.some((x) => x.ping_id === ID3 && x.source === "ask"), "…and discovers ask records read-only");
    res = await fetch(`${base}/api/round/${ID}`);
    const round = await res.json();
    ok(round.result && round.result.ping_id === ID && round.annotations && round.annotations.findings.length === 1,
      "/api/round/<id> carries the cached result and the agent's annotations");
    res = await fetch(`${base}/api/round/${ID3}`);
    const askRound = await res.json();
    ok(res.status === 200 && askRound.source === "ask" && askRound.receipt && askRound.receipt.question === "Which tagline reads better?",
      "an ask surfaces as a read-only receipt");
    res = await fetch(`${base}/api/round/${ID4}`);
    ok(res.status === 404 && /not cached/.test((await res.json()).error || ""), "an uncached id is a 404 with the fetch remedy");

    // media: full, Range slice, suffix, past-EOF, HEAD
    res = await fetch(`${base}/media/${ID}/response-0.mp4`);
    ok(res.status === 200 && Number(res.headers.get("content-length")) === MEDIA_BYTES.length
      && Buffer.from(await res.arrayBuffer()).equals(MEDIA_BYTES), "full media GET streams the cached bytes");
    res = await fetch(`${base}/media/${ID}/response-0.mp4`, { headers: { range: "bytes=2-5" } });
    ok(res.status === 206 && res.headers.get("content-range") === `bytes 2-5/${MEDIA_BYTES.length}`
      && Buffer.from(await res.arrayBuffer()).toString() === "VDAT", "Range slices are exact 206s (video seeking depends on this)");
    res = await fetch(`${base}/media/${ID}/response-0.mp4`, { headers: { range: "bytes=-4" } });
    ok(res.status === 206 && Buffer.from(await res.arrayBuffer()).toString() === "cdef", "suffix ranges serve the tail");
    res = await fetch(`${base}/media/${ID}/response-0.mp4`, { headers: { range: "bytes=999-" } });
    ok(res.status === 416 && res.headers.get("content-range") === `bytes */${MEDIA_BYTES.length}`, "a past-EOF range is a 416");
    res = await fetch(`${base}/media/${ID}/response-0.mp4`, { method: "HEAD" });
    ok(res.status === 200 && Number(res.headers.get("content-length")) === MEDIA_BYTES.length && (await res.text()) === "", "HEAD answers headers only");
    res = await fetch(`${base}/media/${ID}/nope.mp4`);
    ok(res.status === 404, "a missing media file is a 404");
    res = await fetch(`${base}/media/${ID}/%2e%2e%2fresult.json`);
    ok(res.status === 403, "traversal is forbidden at the router");
    res = await fetch(`${base}/api/rounds`, { method: "POST" });
    ok(res.status === 405 && res.headers.get("allow") === "GET, HEAD", "the studio server is read-only: non-GET/HEAD is a 405");

    // ── the runs axis: rig-written machine runs, served read-only ─────────────
    res = await fetch(`${base}/api/runs`);
    const machine = await res.json();
    ok(res.status === 200 && Array.isArray(machine.runs) && machine.runs.length === 3,
      "/api/runs lists the three well-formed machine runs (malformed receipt + bad dir name skipped silently)");
    ok(machine.runs.map((r) => r.run_id).join(",") === [RUN_A, RUN_B, RUN_C].join(","),
      "runs come back in time order, oldest first — the chart's x axis");
    const runB = machine.runs.find((r) => r.run_id === RUN_B);
    ok(runB && runB.gym_id === "collision_alley" && runB.result === "fail" && runB.failure_kind === "expectation"
      && runB.failure_message === "rung 7 unreachable" && runB.avg_fps === 96.4 && runB.one_percent_low_fps === 41.5
      && runB.build_label === "build-42" && runB.warnings_count === 1,
      "a run summary derives result, failure cause, build label, and the perf numbers");
    const runC = machine.runs.find((r) => r.run_id === RUN_C);
    ok(runC && runC.gym_id === null && runC.build_label === "Game.zip" && runC.mode === "record"
      && runC.has_media === true && runC.has_annotations === true,
      "an ad-hoc run (no gym) labels by filename and flags its media + annotations");
    const gym = machine.gyms && machine.gyms.collision_alley;
    ok(gym && gym.runs_in_order.join(",") === `${RUN_A},${RUN_B}` && gym.builds.length === 2
      && gym.builds[0].build_label === "build-41" && gym.builds[0].result === "pass"
      && gym.builds[1].result === "fail" && gym.builds[1].avg_fps === 96.4,
      "the gym groups its runs in time order with the per-build pass/fail + fps series");
    ok(Object.keys(machine.gyms).length === 1, "ad-hoc runs never form a gym group");

    res = await fetch(`${base}/api/run/${RUN_C}`);
    const runFull = await res.json();
    ok(res.status === 200 && runFull.receipt && runFull.receipt.mode === "record"
      && runFull.receipt.media.recording === "media/recording.mp4"
      && runFull.annotations && runFull.annotations.findings.length === 1,
      "/api/run/<id> carries the full receipt and the run's annotations");
    res = await fetch(`${base}/api/run/${RUN_A}`);
    ok(res.status === 200 && (await res.json()).annotations === null, "a run without annotations serves them as null");
    res = await fetch(`${base}/api/run/${RUN_BAD}`);
    ok(res.status === 404, "a malformed receipt is a 404, never a crash");
    res = await fetch(`${base}/api/run/run-20260819-9999-zzz99`);
    ok(res.status === 404 && /\.pingfusi\/studio\/runs/.test((await res.json()).error || ""),
      "an unknown run is a 404 naming where the rig writes");

    // run media: full, Range slice, screenshots, refusals, and read-only doctrine
    res = await fetch(`${base}/media/run/${RUN_C}/media/recording.mp4`);
    ok(res.status === 200 && Buffer.from(await res.arrayBuffer()).equals(MEDIA_BYTES),
      "a run recording streams from the run's own media dir");
    res = await fetch(`${base}/media/run/${RUN_C}/media/recording.mp4`, { headers: { range: "bytes=2-5" } });
    ok(res.status === 206 && res.headers.get("content-range") === `bytes 2-5/${MEDIA_BYTES.length}`
      && Buffer.from(await res.arrayBuffer()).toString() === "VDAT", "run media honors Range/206 (video seeking)");
    res = await fetch(`${base}/media/run/${RUN_C}/shots/000061.png`);
    ok(res.status === 200 && /image\/png/.test(res.headers.get("content-type")), "run screenshots serve from shots/");
    for (const bad of [
      `/media/run/${RUN_C}/media/%2e%2e%2freceipt.json`, `/media/run/${RUN_C}/logs/receipt.json`,
      `/media/run/${RUN_C}/media/a/b.mp4`, `/media/run/NOT-VALID/media/f.mp4`, `/media/run/${RUN_C}/media/%2Fabs.mp4`,
    ]) {
      res = await fetch(`${base}${bad}`);
      ok(res.status === 403, `${JSON.stringify(bad)} is forbidden at the router (run traversal/shape guard)`);
    }
    res = await fetch(`${base}/api/runs`, { method: "POST" });
    ok(res.status === 405, "the runs axis is read-only too: the rig writes the cache, the studio only serves it");
  } finally {
    if (studioServer) await new Promise((resolve) => studioServer.close(resolve));
    await new Promise((resolve) => mediaServer.close(resolve));
    for (const d of [MOCK, home, work]) fs.rmSync(d, { recursive: true, force: true });
  }

  // ── doctrine pins (drift tripwires on the shipped sources) ──────────────────
  const studioSrc = fs.readFileSync(path.join(__dirname, "studio.js"), "utf8");
  ok(studioSrc.includes('"get_test_results"'), "the studio's one wire verb is the passive results snapshot");
  ok(/full_transcripts:\s*true/.test(studioSrc), "the fetch asks for full transcript objects (disk cache, not a context window)");
  ok(!/"(?:request_review|quick_poll|wait_for_results|get_ping)"/.test(studioSrc), "no filing or waiting verb can ride along (read-only doctrine)");
  const uiDir = path.join(__dirname, "studio-ui");
  const appSrc = fs.readFileSync(path.join(uiDir, "app.js"), "utf8");
  ok(!/XMLHttpRequest|method\s*:/.test(appSrc), "the page never issues a write — plain GET fetches only");
  ok(appSrc.includes('"machine run"') && appSrc.includes("machine-tag"),
    "a rig run is labeled a machine run everywhere — never confusable with a human session");
  const contractDoc = fs.readFileSync(path.join(__dirname, "..", "docs", "STUDIO.md"), "utf8");
  ok(contractDoc.includes("pingfusi-studio-annotations/v1") && contractDoc.includes("end_ms"),
    "docs/STUDIO.md carries the annotations contract (schema id + clip anchors)");
  const banned = ["wor" + "ker", "market" + "place", "cpy" + "any", "ping" + "humans"];
  for (const file of ["../harness/studio.js", "studio-ui/index.html", "studio-ui/app.js", "studio-ui/style.css", "../docs/STUDIO.md"]) {
    const lower = fs.readFileSync(path.join(__dirname, file), "utf8").toLowerCase();
    ok(banned.every((w) => !lower.includes(w)), `${path.basename(file)} ships no banned vocabulary`);
  }

  console.log(failed ? `\n❌ studio-selftest: ${failed} assertion(s) failed.` : "\n✓ studio-selftest: all assertions pass.");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(`studio-selftest crashed: ${e && e.stack || e}`); process.exit(1); });
