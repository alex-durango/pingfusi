#!/usr/bin/env node
// builds-selftest — the hosted-build LIFECYCLE the 2026-08-28 QA dead-end
// exposed: what happens when an upload dies, when the same zip is published
// twice, and when the live-builds cap is already full.
//
// Every scenario runs against a real local HTTP server playing the service,
// so the streaming PUT, the landed-probe, the rollback DELETE and the cap
// refusal are exercised for real rather than mocked. No network, no token.
//
// The incident, for the record: an agent's `publish-build` printed "EPIPE
// upload failed" while the build was registered server-side; it retried; each
// retry reserved another cap slot; the fifth was refused with a REST verb the
// agent had no command for, and the QA loop stopped and asked a human. The
// four properties asserted below are the four halves of never doing that
// again — probe before retrying, roll back what failed, reuse identical
// bytes, and hand back a refusal a caller can act on.
"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

let failed = 0;
const ok = (condition, label) => {
  console.log(`${condition ? "✓" : "✗"} ${label}`);
  if (!condition) failed++;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-builds-test-"));
const ZIP_HEAD = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const SLUG = "slug12345678";
// A reservation is stamped with the SHORT clock at create; finalize promotes
// it. These two must never be confused in what the caller is told.
const RESERVATION_AT = "2026-08-28T15:00:00.000Z";
const FULL_TTL_AT = "2026-08-31T09:00:00.000Z";

function writeZip(name, bytes) {
  const p = path.join(root, name);
  fs.writeFileSync(p, Buffer.concat([ZIP_HEAD, crypto.randomBytes(Math.max(bytes - 4, 0))]));
  return p;
}

const liveBuild = (slug, over = {}) => ({
  slug,
  url: `https://pingfusi.com/b/${slug}`,
  filename: "game.zip",
  name: null,
  bytes: 47_185_920,
  sha256: "a".repeat(64),
  platform: "macos",
  created_at: "2026-08-27T10:00:00.000Z",
  expires_at: "2026-08-30T10:00:00.000Z",
  finalized: true,
  reclaimable: false,
  ...over,
});

(async () => {
  let mode = "lost";
  let finalizeOk = true;
  let statusFinalized = false;
  let statusDown = false;
  let lastCreateBody = null;
  let statusShape = null;
  let seen = [];
  let port = 0;

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/build") {
      let bodyText = "";
      req.setEncoding("utf8");
      req.on("data", (c) => { bodyText += c; });
      req.on("end", () => { try { lastCreateBody = JSON.parse(bodyText); } catch { lastCreateBody = null; } });
    }
    const json = (status, body) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    seen.push(`${req.method} ${req.url}`);

    if (req.method === "PUT" && req.url === "/upload/lost") {
      // Every byte arrives; the RESPONSE never does. This is the shape a
      // dropped socket takes mid-PUT, and the one that looked like failure.
      req.on("data", () => {});
      req.on("end", () => { req.socket.destroy(); });
      return;
    }
    if (req.method === "PUT" && req.url === "/upload/clean") {
      req.resume();
      req.on("end", () => json(200, {}));
      return;
    }
    if (req.method === "PUT" && req.url === "/upload/dead-token") {
      // 403 = the signed URL died. The ladder re-mints — and the re-mint route
      // answers 409 because the build finalized under it.
      req.resume();
      req.on("end", () => { res.statusCode = 403; res.end("token expired"); });
      return;
    }
    if (req.method === "PUT" && req.url === "/upload/gone") {
      req.resume();
      req.on("end", () => json(404, { error: "no such object" })); // terminal, no retry ladder
      return;
    }
    if (req.method === "POST" && req.url === "/api/build") {
      if (mode === "cap") {
        return json(429, {
          error: "you already have 5 live builds (cap 5).",
          builds: [
            liveBuild("aaaaaaaaaaaa"),
            liveBuild("bbbbbbbbbbbb", { finalized: false, reclaimable: true }),
          ],
          reclaimable: ["bbbbbbbbbbbb"],
          cap: 5,
        });
      }
      if (mode === "reuse-unfinalized") {
        // The dangerous shape: an existing reservation handed back to us, which
        // another publish of the same zip may be streaming into right now.
        return json(200, {
          slug: SLUG,
          url: `http://127.0.0.1:${port}/b/${SLUG}`,
          expires_at: RESERVATION_AT,
          reused: true,
          finalized: false,
          upload: { path: `${SLUG}/game.zip`, url: `http://127.0.0.1:${port}/upload/gone` },
        });
      }
      if (mode === "reuse") {
        // The real shape of a finalized reuse: no upload object at all, because
        // there is nothing to upload and the service refuses to mint a write
        // token over a finalized build.
        return json(200, {
          slug: SLUG,
          url: `http://127.0.0.1:${port}/b/${SLUG}`,
          expires_at: FULL_TTL_AT,
          reused: true,
          finalized: true,
        });
      }
      return json(201, {
        slug: SLUG,
        url: `http://127.0.0.1:${port}/b/${SLUG}`,
        expires_at: RESERVATION_AT,
        upload: { path: `${SLUG}/game.zip`, url: `http://127.0.0.1:${port}/upload/${mode}` },
        finalize: `http://127.0.0.1:${port}/api/build/${SLUG}/finalize`,
      });
    }
    if (req.method === "POST" && req.url === `/api/build/${SLUG}/finalize`) {
      if (finalizeOk === "500") return json(500, { error: "could not inspect uploaded file" });
      return finalizeOk
        ? json(200, { ok: true, expires_at: FULL_TTL_AT })
        : json(409, { error: "uploaded build does not match what was declared", missing: ["game.zip"] });
    }
    if (req.method === "POST" && req.url === `/api/build/${SLUG}/upload-url`) {
      return json(409, { error: "build already finalized — upload a new build instead" });
    }
    if (req.method === "GET" && req.url === `/api/build/${SLUG}`) {
      if (statusDown) return json(500, { error: "could not read build" });
      if (statusShape) return json(200, statusShape);
      return json(200, { slug: SLUG, finalized: statusFinalized, expires_at: FULL_TTL_AT });
    }
    if (req.method === "DELETE" && req.url === `/api/build/${SLUG}`) return json(200, { ok: true });
    if (req.method === "GET" && req.url === "/api/build") {
      return json(200, { builds: [liveBuild("aaaaaaaaaaaa")], live: 1, cap: 5 });
    }
    json(404, {});
  });

  try {
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    port = server.address().port;
    process.env.PINGFUSI_TOKEN = "ph_selftest";
    process.env.PPK_PINGHUMANS_URL = `http://127.0.0.1:${port}`;
    for (const mod of ["../packages/core/wire.js", "../packages/core/drafts.js", "../packages/core/builds.js"]) {
      delete require.cache[require.resolve(mod)];
    }
    const core = require("../packages/core/builds.js");
    const zip = writeZip("game.zip", 64 * 1024);

    // ── 1. a PUT that lands and loses its response is a SUCCESS ────────────
    mode = "lost";
    finalizeOk = true;
    seen = [];
    statusFinalized = false;
    const landed = await core.buildPush(zip, { platform: "windows" });
    ok(landed.slug === SLUG, "a PUT whose response is lost still returns the hosted build");
    ok(landed.expires_at === FULL_TTL_AT,
      "the reported expiry is finalize's PROMOTED one, never create's short reservation clock");
    ok(seen.filter((s) => s.startsWith("PUT")).length === 1,
      "the lost response is probed, not re-uploaded (one PUT, not four)");
    ok(seen.includes(`POST /api/build/${SLUG}/finalize`),
      "finalize is the oracle for whether the bytes landed");
    ok(!seen.some((s) => s.startsWith("DELETE")),
      "a build that actually landed is never rolled back");

    // ── 2. a terminal upload failure RELEASES its reservation ──────────────
    // A create reserves a cap slot before a byte moves. Leaving that row
    // behind on failure is what filled the cap with nothing.
    mode = "gone";
    finalizeOk = false;
    statusFinalized = false;
    seen = [];
    let threw = null;
    try { await core.buildPush(zip, { platform: "windows" }); }
    catch (e) { threw = e; }
    ok(threw && /HTTP 404/.test(threw.message), "a terminal upload refusal is reported by name");
    ok(seen.includes(`DELETE /api/build/${SLUG}`),
      "the failed upload's reservation is deleted, freeing its cap slot");

    // ── 2b. an ordinary success reports the PROMOTED expiry ────────────────
    mode = "clean";
    finalizeOk = true;
    statusFinalized = false;
    seen = [];
    const clean = await core.buildPush(zip, { platform: "windows" });
    ok(clean.expires_at === FULL_TTL_AT && clean.reused === false,
      "a plain successful publish reports finalize's 72h expiry, not create's 6h reservation");
    ok(seen.filter((s) => s.startsWith("PUT")).length === 1
      && seen.filter((s) => s.endsWith("/finalize")).length === 1,
      "the ordinary path is still exactly one upload and one finalize");

    // ── 2c. a build that finalized under us is NEVER rolled back ───────────
    // The dangerous shape: the PUT's signed URL dies, the ladder asks for a
    // fresh one, and the service answers "already finalized" because a lost
    // response finalized it. Deleting here would tombstone a playable build a
    // round may be running against.
    mode = "dead-token";
    finalizeOk = true;
    statusFinalized = true;
    seen = [];
    const rescued = await core.buildPush(zip, { platform: "windows" });
    ok(rescued.slug === SLUG && rescued.expires_at === FULL_TTL_AT,
      "a 409 from the upload-URL re-mint is read as 'already finalized', not as failure");
    ok(!seen.some((s) => s.startsWith("DELETE")),
      "a finalized build is never deleted by the rollback path");

    // ── 2d. an unreadable status is not evidence of garbage ────────────────
    // A service that cannot answer must not be taken as permission to delete;
    // the reservation clock frees the slot on its own within hours.
    mode = "gone";
    finalizeOk = false;
    statusFinalized = false;
    statusDown = true;
    seen = [];
    let downErr = null;
    try { await core.buildPush(zip, { platform: "windows", brandRoot: "qaping" }); }
    catch (e) { downErr = e; }
    statusDown = false;
    ok(downErr && !seen.some((s) => s.startsWith("DELETE")),
      "when the service cannot say whether the build landed, nothing is deleted");
    ok(downErr && /qaping builds rm/.test(downErr.message),
      "…and the error hands the developer the command to clear it themselves");

    // ── 2e. a transient finalize failure must NOT throw away the upload ────
    // The PUT landed a gigabyte. A 500 or a timeout from finalize says nothing
    // about the object; deleting on one costs the whole upload again.
    mode = "clean";
    finalizeOk = "500";
    statusFinalized = false;
    seen = [];
    let softErr = null;
    try { await core.buildPush(zip, { platform: "windows" }); }
    catch (e) { softErr = e; }
    ok(softErr && !seen.some((s) => s.startsWith("DELETE")),
      "a 500 from finalize leaves the landed build alone — only a definite refusal is garbage");

    // …but a 409 IS definite: the bytes do not match what was declared.
    mode = "clean";
    finalizeOk = false;
    seen = [];
    let hardErr = null;
    try { await core.buildPush(zip, { platform: "windows" }); }
    catch (e) { hardErr = e; }
    ok(hardErr && seen.includes(`DELETE /api/build/${SLUG}`),
      "a 409 from finalize does release the reservation — those bytes are unusable");

    // ── 2f. a build we did not create is never ours to delete ──────────────
    // The reuse path can hand back an UNFINALIZED row another publish is
    // streaming into right now. Failing our own upload must not tombstone it.
    mode = "reuse-unfinalized";
    finalizeOk = false;
    seen = [];
    let notOurs = null;
    try { await core.buildPush(zip, { platform: "windows", brandRoot: "qaping" }); }
    catch (e) { notOurs = e; }
    ok(notOurs && !seen.some((s) => s.startsWith("DELETE")),
      "a reused build is never deleted by our rollback — another upload may be streaming into it");
    ok(notOurs && /was left in place/.test(notOurs.message),
      "…and the error says so, rather than implying the slot was freed");

    // ── 2g. an ambiguous status is not permission to delete ────────────────
    // api() returns {} for any 2xx body it cannot parse (a captive portal, a
    // proxy interstitial). Absence of finalized:true is not evidence of garbage.
    mode = "gone";
    finalizeOk = false;
    statusShape = { slug: SLUG }; // 200, but no `finalized` field
    seen = [];
    let vague = null;
    try { await core.buildPush(zip, { platform: "windows" }); }
    catch (e) { vague = e; }
    statusShape = null;
    ok(vague && !seen.some((s) => s.startsWith("DELETE")),
      "a status body with no `finalized` field is treated as unknown, never as safe to delete");

    // ── 3. the same zip twice is the same build ────────────────────────────
    mode = "reuse";
    seen = [];
    const again = await core.buildPush(zip, { platform: "windows" });
    ok(again.reused === true && again.slug === SLUG, "re-publishing identical bytes reuses the build");
    ok(lastCreateBody && lastCreateBody.reuse === true,
      "the client asks for reuse explicitly — without the flag an older CLI keeps the old contract");
    ok(!seen.some((s) => s.startsWith("PUT")), "a reused build moves no bytes at all");
    ok(again.expires_at === FULL_TTL_AT, "a reused build reports the life the service refreshed it to");

    // ── 4. the cap refusal names the builds AND the command that frees one ──
    mode = "cap";
    seen = [];
    let capErr = null;
    try { await core.buildPush(zip, { platform: "windows", brandRoot: "qaping" }); }
    catch (e) { capErr = e; }
    ok(capErr && /cap 5/.test(capErr.message), "the cap refusal keeps the service's own wording");
    ok(capErr && capErr.message.includes("bbbbbbbbbbbb"),
      "the refusal names the builds holding the slots");
    ok(capErr && /never finished uploading/.test(capErr.message),
      "reservations no round can be using are called out as safe to delete");
    ok(capErr && capErr.message.includes("qaping builds rm bbbbbbbbbbbb"),
      "the remedy is a command in the caller's OWN brand, not a bare REST verb");
    ok(capErr && !/pingfusi builds/.test(capErr.message),
      "a qaping user is never told to run pingfusi");

    // When every live build is FINALIZED — the normal state of a working loop
    // — the oldest may be the one a playtester is downloading right now. The
    // remedy must not name it.
    const allUnknown = core.explainBuildCap(
      { builds: [liveBuild("aaaaaaaaaaaa"), liveBuild("cccccccccccc")] },
      "qaping"
    );
    ok(!/builds rm (aaaaaaaaaaaa|cccccccccccc)/.test(allUnknown)
      && /builds rm <slug>/.test(allUnknown) && /may still be serving a round/.test(allUnknown),
      "with nothing reclaimable and no round information, the remedy stays a placeholder");

    // With the in-round flag present, a finished build NO round is using is
    // safe to name — the flag is what turns "ask a human" back into an action.
    const withRounds = core.explainBuildCap(
      {
        builds: [
          liveBuild("aaaaaaaaaaaa", { in_round: true }),
          liveBuild("cccccccccccc", { in_round: false }),
        ],
      },
      "qaping"
    );
    ok(/builds rm cccccccccccc/.test(withRounds)
      && /IN USE by an open round/.test(withRounds)
      && !/builds rm aaaaaaaaaaaa/.test(withRounds),
      "a build an open round is using is marked and never named as the one to free");

    // ── 4b. a slug that begins with "-" is still a slug ────────────────────
    // ~1 in 64 slugs does (9 random bytes, base64url). Reading it as an option
    // would make the cap remedy unrunnable for exactly those builds.
    ok(require("./builds.js").parseArgs(["rm", "-Xy9_abc1234"]).slug === "-Xy9_abc1234",
      "a leading-dash slug is read as the slug, not refused as an unknown option");
    ok(require("./builds.js").parseArgs(["rm", "--", "-Xy9_abc1234"]).slug === "-Xy9_abc1234",
      "…and `--` works too, for anyone who reaches for it");

    // ── 4c. the upload body must not leak bytes before fetch reads it ──────
    // The 2026-08-28 field failure (Windows, node 24, a 682 MB zip: four
    // attempts, all UND_ERR_REQ_CONTENT_LENGTH_MISMATCH, progress at 100%).
    // Counting with counter.on("data") switches the stream to FLOWING mode
    // immediately, so every byte that arrives before fetch attaches its own
    // reader is counted and then DISCARDED — the request sends short, undici
    // refuses it, and the meter still says 100%. It is a race, so assert the
    // property instead of the symptom: build the body, let the event loop turn
    // (which is exactly what drains a flowing stream into nowhere), and only
    // THEN read it. Every byte must still be there.
    const bodyProbe = path.join(root, "probe.bin");
    const probeBytes = 512 * 1024;
    fs.writeFileSync(bodyProbe, crypto.randomBytes(probeBytes));
    let counted = 0;
    const { body } = core.countingBody(bodyProbe, (n) => { counted += n; });
    await new Promise((r) => setTimeout(r, 25)); // a flowing stream empties here
    let received = 0;
    for await (const chunk of body) received += chunk.length;
    ok(received === probeBytes,
      `the upload body survives a delay before it is read (${received}/${probeBytes} bytes) — a flowing counter would have dropped them`);
    ok(counted === probeBytes,
      "…and the progress counter saw exactly the bytes that were sent, so 100% means 100%");

    // ── 5. the management command itself ───────────────────────────────────
    const builds = require("./builds.js");
    ok(builds.parseArgs([]).action === "list", "no argument lists — never a usage error");
    ok(builds.parseArgs(["rm", "abc"]).slug === "abc", "rm takes one slug");
    for (const [argv, why] of [
      [["rm"], "rm with no slug is refused"],
      [["nonsense"], "an unknown subcommand is refused rather than guessed at"],
      [["rm", "a", "b"], "rm refuses two slugs rather than deleting the first"],
    ]) {
      let rejected = false;
      try { builds.parseArgs(argv); } catch { rejected = true; }
      ok(rejected, why);
    }
    const rendered = builds.renderList(
      { builds: [liveBuild("aaaaaaaaaaaa"), liveBuild("bbbbbbbbbbbb", { finalized: false, reclaimable: true })], live: 5, cap: 5 },
      "qaping builds"
    ).join("\n");
    ok(/at the cap/.test(rendered) && /qaping builds rm bbbbbbbbbbbb/.test(rendered),
      "a full account is told which build to free first — a reclaimable one");

    seen = [];
    const listing = await core.buildList();
    ok(listing.live === 1 && listing.cap === 5 && listing.builds[0].slug === "aaaaaaaaaaaa",
      "build.list reads the account's live builds");
    await core.buildDelete(SLUG);
    ok(seen.includes(`DELETE /api/build/${SLUG}`), "build.delete frees one by slug");
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(failed ? `\n❌ builds-selftest: ${failed} check(s) failed.` : "\n✓ builds-selftest: all checks pass.");
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
