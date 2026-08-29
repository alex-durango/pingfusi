// packages/core/builds.js — the hosted game-build client: local pre-flight,
// streamed sha256, the create → PUT → finalize wire sequence, and a retry
// ladder that can re-mint an expired signed upload URL. harness/publish-build.js
// is the CLI consumer.
//
// A build zip can be a GIGABYTE — three rules follow, all different from
// draftPush (which readFileSync's 25 MB files):
//   1. NEVER buffer the file: hash and upload via fs.createReadStream (the
//      studio.js "streamed both ways, never buffered" doctrine).
//   2. No fixed total timeout: 1 GiB at 1 Mbps is ~2.4h. Instead an
//      INACTIVITY watchdog (no forward progress for 120s aborts, retryable)
//      under a 4h hard ceiling.
//   3. Signed upload tokens live a fixed 2 hours — shorter than a slow
//      upload — so a 400/403 mid-ladder re-mints a fresh URL via
//      POST /api/build/<slug>/upload-url instead of retrying a dead token.
//
// Hosted builds are TEMPORARY on purpose, on two clocks: an unfinished upload
// is a short-lived RESERVATION, and finalize promotes it to the 72-hour build
// TTL a filed round extends further. The receipt carries the expiry FINALIZE
// reported — never create's reservation stamp — and every printed surface
// says so.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Transform } = require("stream");
const { BASE } = require("./wire.js");
const { api, fetchOrExplain } = require("./drafts.js");
const { MAX_BUILD_BYTES } = require("./wire-contract.gen.js");

// Zip local-file-header magic. The service can't magic-check without
// downloading the object, so the kit is where a mislabeled file becomes a
// named local failure before any bytes move.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const PUT_ATTEMPTS = 4;
const REMINT_LIMIT = 3;
const INACTIVITY_MS = 120_000;
const HARD_CEILING_MS = 4 * 60 * 60 * 1000;

/** Local pre-flight: every refusal is a named failure naming the remedy. */
function preflightBuildZip(file) {
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist`);
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error(`${file} is not a file — zip the build first (zip -r game.zip <dir>)`);
  if (!/\.zip$/i.test(file)) throw new Error(`${file} is not a .zip — builds are zip-only; pack it with \`zip -r game.zip <build dir>\``);
  if (st.size === 0) throw new Error(`${file} is empty`);
  if (st.size > MAX_BUILD_BYTES) throw new Error(`${file} is ${st.size} bytes (> ${MAX_BUILD_BYTES} hosted-build cap) — trim the build or ship a smaller slice`);
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    if (!head.equals(ZIP_MAGIC)) throw new Error(`${file} does not look like a zip (bad magic bytes) — pack it with \`zip -r game.zip <build dir>\``);
  } finally {
    fs.closeSync(fd);
  }
  return { bytes: st.size, filename: path.basename(file) };
}

// ── deep preflight: what's IN the zip ──────────────────────────────────────
// Two named local failures before any bytes move, mirroring preflightBuildZip:
//  1. A WEB build (index.html at the root, no native app inside) — hosted-build
//     playtests are for native executables; a web game already has a better,
//     cross-platform path (`pingfusi publish <dir>` + a plain web playtest).
//  2. A completely UNSIGNED Mac app (darwin hosts only, --platform macos):
//     Apple-silicon Macs refuse unsigned Mach-O at the kernel, so the reviewer
//     app cannot launch it no matter what — better a one-line fix here than a
//     dead session there. Ad-hoc is enough; every mainstream export signs.
// Both checks FAIL OPEN on machinery limits (zip64 listing, missing codesign):
// they exist to catch obvious mistakes, not to gate exotic-but-valid uploads.

/** List a zip's entry names via its central directory. Returns null when the
 * listing can't be trusted (zip64, malformed EOCD) — callers must fail open. */
function listZipEntryNames(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65_557); // max comment + EOCD
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return null; // zip64
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const names = [];
    let at = 0;
    for (let n = 0; n < total; n++) {
      if (at + 46 > cdSize || cd.readUInt32LE(at) !== 0x02014b50) return null;
      const nameLen = cd.readUInt16LE(at + 28);
      const extraLen = cd.readUInt16LE(at + 30);
      const commentLen = cd.readUInt16LE(at + 32);
      names.push(cd.toString("utf8", at + 46, at + 46 + nameLen));
      at += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Refuse a zip that is plainly a web build, naming the better path. */
function refuseWebBuildZip(file) {
  const names = listZipEntryNames(file);
  if (!names) return; // unlistable — fail open, the service still magic-checks size
  const hasRootIndex = names.some((n) => /^(?:[^/]+\/)?index\.html$/.test(n));
  const looksNative = names.some((n) => /\.app\//.test(n) || /\.exe$/i.test(n));
  if (hasRootIndex && !looksNative) {
    throw new Error(
      `${file} looks like a WEB build (index.html inside, no .app or .exe) — hosted-build playtests are for native executables. A web game has a better path that any reviewer on any OS can play in a browser: 'pingfusi publish <built-dir>' to host it, then file the playtest with that url and est_minutes (no platform).`
    );
  }
}

/** Parse the arch slices of a possible Mach-O file head. Returns
 * { machO: bool, arm64: bool } — enough to apply the platform rules:
 * arm64 slices MUST carry a signature (the kernel SIGKILLs unsigned arm64);
 * x86_64-only binaries run unsigned under Rosetta. Fat headers are
 * big-endian by spec; thin headers little-endian on every modern Mac. */
function machOSlices(buf) {
  if (buf.length < 8) return { machO: false, arm64: false };
  const ARM64 = 0x0100000c; // CPU_TYPE_ARM64
  const beMagic = buf.readUInt32BE(0);
  if (beMagic === 0xcafebabe || beMagic === 0xcafebabf) {
    // fat/universal: nfat_arch entries of 20 (fat32) / 32 (fat64) bytes
    const entrySize = beMagic === 0xcafebabe ? 20 : 32;
    const count = buf.readUInt32BE(4);
    let arm64 = false;
    for (let i = 0; i < count && 8 + (i + 1) * entrySize <= buf.length; i++) {
      if (buf.readUInt32BE(8 + i * entrySize) === ARM64) arm64 = true;
    }
    return { machO: true, arm64 };
  }
  const leMagic = buf.readUInt32LE(0);
  if (leMagic === 0xfeedfacf || leMagic === 0xfeedface) {
    return { machO: true, arm64: buf.readUInt32LE(4) === ARM64 };
  }
  return { machO: false, arm64: false };
}

/** darwin + macos only: refuse an .app whose bundle shape or signature state
 * means reviewers' Macs cannot launch it. Grounded in the 2026-08-20 research
 * pass (Apple DTS + live A/B):
 *  - a NON-Mach-O main executable (shell/python script) is an unsupported
 *    bundle shape — Launch Services misbehaves, and a script cannot carry a
 *    real code signature (it lands in brittle xattrs a zip round-trip loses;
 *    ad-hoc signing one actively BREAKS launching, hit live);
 *  - an UNSIGNED arm64 slice is SIGKILLed by the kernel (ad-hoc suffices,
 *    and clang/ld ad-hoc-sign automatically — only stripped/mutated binaries
 *    fail this);
 *  - x86_64-only binaries run unsigned under Rosetta and pass freely. */
function refuseUnsignedMacApp(file) {
  if (process.platform !== "darwin") return; // no tooling off-mac — fail open
  const { execFileSync } = require("child_process");
  const os = require("os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-build-check-"));
  try {
    try {
      execFileSync("/usr/bin/ditto", ["-x", "-k", file, tmp], { stdio: "pipe" });
    } catch {
      return; // extraction hiccup — the size/magic preflight already passed; fail open
    }
    const findApp = (dir, depth) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const full = path.join(dir, e.name);
        if (e.name.endsWith(".app") && fs.existsSync(path.join(full, "Contents/Info.plist"))) return full;
        if (depth > 0) { const found = findApp(full, depth - 1); if (found) return found; }
      }
      return null;
    };
    const app = findApp(tmp, 1);
    if (!app) return; // no .app found — the reviewer-side named failure covers it

    // Resolve the main executable from Info.plist (plutil ships with macOS).
    let execName = "";
    try {
      execName = execFileSync("/usr/bin/plutil", [
        "-extract", "CFBundleExecutable", "raw", "-o", "-",
        path.join(app, "Contents/Info.plist"),
      ], { stdio: "pipe" }).toString().trim();
    } catch {
      return; // unreadable plist — the launcher reports it as a named failure
    }
    const mainExec = path.join(app, "Contents/MacOS", execName);
    if (!fs.existsSync(mainExec)) {
      throw new Error(
        `the app inside ${path.basename(file)} declares CFBundleExecutable "${execName}" but Contents/MacOS/${execName} is missing — reviewers' Macs cannot launch it. Fix the bundle and re-zip.`
      );
    }

    let head;
    try {
      const fd = fs.openSync(mainExec, "r");
      head = Buffer.alloc(4096);
      fs.readSync(fd, head, 0, 4096, 0);
      fs.closeSync(fd);
    } catch {
      return; // unreadable — fail open
    }
    const slices = machOSlices(head);
    if (!slices.machO) {
      throw new Error(
        `the app inside ${path.basename(file)} uses a script as its main executable (CFBundleExecutable "${execName}" is not a Mach-O binary) — an unsupported bundle shape on macOS: Launch Services misbehaves and the bundle cannot hold a real code signature. Make the main executable a small compiled binary that runs your script from Contents/Resources, then re-zip.`
      );
    }
    if (!slices.arm64) return; // x86_64-only runs unsigned under Rosetta — fine

    try {
      execFileSync("/usr/bin/codesign", ["-dv", app], { stdio: "pipe" });
      return; // signed (ad-hoc or better) — good to go
    } catch (e) {
      const out = String(e.stderr || e.stdout || e.message || "");
      if (/not signed at all/.test(out)) {
        throw new Error(
          `the app inside ${path.basename(file)} has an arm64 binary with no code signature — Apple-silicon Macs kill unsigned arm64 at the kernel, so reviewers cannot play it. Normal builds are signed automatically by the linker; re-sign after any post-build mutation: codesign --force -s - "${path.basename(app)}" (ad-hoc is enough), then re-zip.`
        );
      }
      // codesign failed some other way (weird bundle, tool quirk) — fail open.
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** sha256 of a file, streamed — never buffered. */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

// Is this PUT failure the signed-URL-died shape (expired/invalid token)?
// Storage answers 400/401/403 for those; anything else 4xx is a real refusal.
function looksLikeDeadToken(status) {
  return status === 400 || status === 401 || status === 403;
}

/**
 * The upload body, wrapped so bytes can be counted on their way past.
 *
 * NEVER count with `counter.on("data", …)`. Attaching a 'data' listener puts
 * the stream into FLOWING mode the instant it is attached — so every byte that
 * arrives before fetch attaches its own reader is handed to the counter and
 * then DISCARDED. The request body ends short of the declared content-length
 * and undici rejects it with UND_ERR_REQ_CONTENT_LENGTH_MISMATCH, while the
 * progress meter — which saw those bytes — reads a confident 100%. It is a
 * race, so it looks like a flaky network: reproduced here at 1/60 uploads with
 * the server receiving ZERO bytes, and reported from the field as four failed
 * attempts in a row on one machine (Windows, node 24, a 682 MB zip).
 *
 * Counting inside transform() keeps the stream paused and back-pressured, so
 * nothing moves until fetch pulls it — which also makes the progress meter
 * honest: it now measures bytes actually consumed by the request, not bytes
 * read off the disk ahead of it.
 */
function countingBody(file, onChunk) {
  const source = fs.createReadStream(file);
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      onChunk(chunk.length);
      cb(null, chunk);
    },
  });
  return { source, body: source.pipe(counter) };
}

/** One streaming PUT attempt with the inactivity watchdog. */
async function putOnce(file, bytes, url, onProgress) {
  const controller = new AbortController();
  const started = Date.now();
  let loaded = 0;
  let watchdog = null;
  const rearm = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => controller.abort(new Error(`no upload progress for ${INACTIVITY_MS / 1000}s`)), INACTIVITY_MS);
  };
  const ceiling = setTimeout(() => controller.abort(new Error("upload exceeded the 4h ceiling")), HARD_CEILING_MS);
  const { source, body } = countingBody(file, (n) => {
    loaded += n;
    if (onProgress) onProgress(loaded, bytes, started);
    rearm();
  });
  rearm();
  // pipe() only forwards errors for the DESTINATION. An unhandled 'error' on
  // the source read stream (the zip deleted mid-upload, a disk fault) is an
  // uncaught exception that kills the process outright — past the ladder,
  // past publish-build's own catch, and past the rollback that frees this
  // build's cap slot. Route it into the abort signal so it is just another
  // named upload failure.
  source.on("error", (e) => controller.abort(e instanceof Error ? e : new Error(String(e))));
  try {
    const r = await fetchOrExplain("upload build", url, {
      method: "PUT",
      headers: { "content-type": "application/zip", "content-length": String(bytes) },
      body,
      duplex: "half",
      signal: controller.signal,
    });
    return r;
  } finally {
    if (watchdog) clearTimeout(watchdog);
    clearTimeout(ceiling);
  }
}

/**
 * Did the bytes actually land? finalize is the only honest oracle — it counts
 * the object in storage against the declared byte count — and it is safe to
 * ask more than once (finalizing an already-finalized build is a no-op 200).
 *
 * This exists because of the 2026-08-28 QA dead-end: a streamed PUT can move
 * every byte and then lose its RESPONSE (the far side closes the socket and
 * node reports EPIPE / UND_ERR_SOCKET), so "upload failed" and "upload
 * succeeded" look identical from the client. Retrying a landed upload is
 * merely wasteful; reporting a landed upload as a failure is what sent an
 * agent round the retry loop that filled its build cap.
 */
function finalizeBuild(slug) {
  return api(`/api/build/${slug}/finalize`, { method: "POST" });
}

async function landedAlready(slug) {
  try {
    // The payload carries the PROMOTED expiry (finalize moves the row off the
    // short reservation clock), which is the life the caller must report.
    return (await finalizeBuild(slug)) || {};
  } catch {
    return null; // 409 (nothing/partial landed), 404, offline — keep trying
  }
}

/**
 * PUT with the full ladder: up to PUT_ATTEMPTS tries with backoff, retrying
 * network errors / 5xx / 429 / watchdog aborts; a dead-token 4xx re-mints
 * (up to REMINT_LIMIT) and does NOT consume an attempt; any other 4xx throws
 * immediately. The stream restarts cleanly from disk on every try.
 *
 * Returns the finalize record when the build turned out to be FINALIZED
 * already (the landed-response-lost case above) so the caller can skip its own
 * finalize and still report the real expiry; null when the caller must
 * finalize itself.
 */
async function putBuildWithRetry(file, bytes, slug, firstUrl, onProgress) {
  let url = firstUrl;
  let remints = 0;
  let lastFailure = "unknown";
  for (let attempt = 1; attempt <= PUT_ATTEMPTS; attempt++) {
    let r = null;
    try {
      r = await putOnce(file, bytes, url, onProgress);
    } catch (e) {
      lastFailure = e.message;
      // A connection-level failure is exactly the shape a lost response takes.
      // Ask the service what actually landed before spending another upload.
      const landed = await landedAlready(slug);
      if (landed) return landed;
    }
    if (r) {
      if (r.ok) return null;
      lastFailure = `HTTP ${r.status}`;
      if (looksLikeDeadToken(r.status)) {
        if (remints >= REMINT_LIMIT) throw new Error(`upload build → ${lastFailure} after ${remints} re-minted URLs — the upload window keeps dying; retry on a steadier connection`);
        remints++;
        let fresh;
        try {
          fresh = await api(`/api/build/${slug}/upload-url`, { method: "POST" });
        } catch (e) {
          // 409 = "build already finalized". Reachable without any concurrency:
          // a landedAlready probe can finalize the build server-side and lose
          // ITS response too, and the next attempt then trades a dead token for
          // this refusal. Treating it as an upload failure would send a LANDED,
          // finalized build into the caller's rollback and delete it mid-round.
          // Fall back to the build's own status for the expiry — never to
          // create's reservation stamp, which is not this build's life.
          if (e.status === 409) {
            const confirmed = await landedAlready(slug);
            if (confirmed) return confirmed;
            try { return await buildStatus(slug); } catch { return {}; }
          }
          throw e;
        }
        if (!fresh.url) throw new Error("re-mint returned no upload url");
        url = fresh.url;
        attempt--; // a token refresh is not an upload failure
        continue;
      }
      if (r.status < 500 && r.status !== 429) {
        throw new Error(`upload build → ${lastFailure}`);
      }
    }
    if (attempt < PUT_ATTEMPTS) {
      await new Promise((res) => setTimeout(res, 1000 * 2 ** (attempt - 1)));
    }
  }
  const late = await landedAlready(slug); // a late-landing final attempt
  if (late) return late;
  throw new Error(`upload build failed after ${PUT_ATTEMPTS} attempts: ${lastFailure}`);
}

const fmtBuildMb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/** Render a cap refusal into something a caller can ACT on. The service sends
 * the live builds with its 429 (they are what the cap is counting); this turns
 * them into the two commands that free a slot, oldest first, and says plainly
 * which ones no round can be using.
 *
 * It names a CONCRETE slug only when deleting that slug is provably safe — a
 * never-finished upload, which no round can reference, or a finished build the
 * service says no open round is pointing at. Otherwise the remedy stays a
 * placeholder and says to look first: the oldest finished build may be the one
 * a playtester is downloading right now, and a remedy that silently burns a
 * paid round is worse than one that costs a second command. */
function explainBuildCap(payload, brandRoot) {
  const builds = Array.isArray(payload && payload.builds) ? payload.builds : [];
  if (!builds.length) return null;
  const lines = builds.map((b) => {
    const when = b.expires_at ? ` — expires ${b.expires_at}` : "";
    const what = b.reclaimable
      ? " [never finished uploading — safe to delete]"
      : b.in_round
        ? " [IN USE by an open round — do not delete]"
        : "";
    return `    ${b.slug}  ${b.filename} (${fmtBuildMb(b.bytes || 0)})${when}${what}`;
  });
  const free = builds.find((b) => b.reclaimable) || builds.find((b) => b.in_round === false);
  return [
    "  your live builds:",
    ...lines,
    free
      ? `  free a slot: ${brandRoot} builds rm ${free.slug}    (list them any time: ${brandRoot} builds)`
      : `  every one is finished and may still be serving a round — check with \`${brandRoot} builds\`, then free the one you are done with: ${brandRoot} builds rm <slug>`,
  ].join("\n");
}

/** Release a reservation this invocation created and could not turn into a
 * build. Three refusals, each one a bug we already shipped once:
 *   - never a build we did not create (a REUSED row predates this call and may
 *     have another publish streaming into it right now);
 *   - never a FINALIZED build (it is playable, and a round may be on it);
 *   - never without positive evidence — an outage, or a 2xx body we could not
 *     parse, is not proof of garbage, and the reservation clock frees the slot
 *     on its own within hours.
 * Returns a note to append to the caller's error, or "". */
async function releaseReservation(slug, { ours, brandRoot }) {
  const leave = (why) =>
    ` (its reservation ${slug} was left in place — ${why}; free it with \`${brandRoot} builds rm ${slug}\` if it is not wanted)`;
  if (!ours) return leave("it was an existing build, not one this upload created");
  let status;
  try {
    status = await buildStatus(slug);
  } catch {
    return leave("the service did not answer when asked whether it landed");
  }
  // POSITIVE evidence only. api() returns {} for any 2xx body it cannot parse
  // (a captive portal, a proxy interstitial), and the ABSENCE of finalized:true
  // is not the same as knowing the build did not land.
  if (status && status.finalized === true) return ""; // it landed — leave it, say nothing
  if (!status || status.finalized !== false) {
    return leave("the service did not clearly say whether it landed");
  }
  try {
    await buildDelete(slug);
    return "";
  } catch {
    return leave("it could not be deleted");
  }
}

// ── build.push — upload one zip, verify via finalize, return the record ─────
// opts.platform is REQUIRED ('windows' | 'macos'): it routes the round to the
// right reviewer pool and the service refuses a mismatched filing.
// opts.brandRoot names the command in printed remedies ('pingfusi' | 'qaping').
async function buildPush(file, { name, platform, onProgress, brandRoot = "pingfusi" } = {}) {
  if (platform !== "windows" && platform !== "macos") {
    throw new Error("platform is required: 'windows' or 'macos' — the reviewer pool the build is for");
  }
  const { bytes, filename } = preflightBuildZip(file);
  refuseWebBuildZip(file);
  if (platform === "macos") refuseUnsignedMacApp(file);
  const sha256 = await sha256File(file);

  let created;
  try {
    created = await api("/api/build", {
      method: "POST",
      // reuse:true is the opt-in that lets the service hand back an identical
      // build it already holds instead of minting a second one. Older services
      // ignore the field; older CLIs never send it and keep the old contract.
      body: { filename, bytes, sha256, platform, reuse: true, ...(name ? { name } : {}) },
    });
  } catch (e) {
    // The live-builds cap. The service already sent the list; without this the
    // caller sees a number it cannot act on and starts guessing (the
    // 2026-08-28 dead-end, where an agent stopped and asked a human).
    if (e.status === 429) {
      const detail = explainBuildCap(e.payload, brandRoot);
      if (detail) throw new Error(`${e.message}\n${detail}`);
    }
    throw e;
  }
  if (!created.slug) throw new Error("build create returned no slug");

  // A row this call created is ours to release on failure; a REUSED one is not.
  const ours = created.reused !== true;

  // The same zip, already hosted and verified: the service handed back the
  // existing build rather than a second copy of it. Nothing to upload.
  let done = created.reused === true && created.finalized === true ? {} : null;
  if (!done) {
    if (!created.upload || !created.upload.url) {
      throw new Error("build create returned no upload url");
    }
    try {
      done = await putBuildWithRetry(file, bytes, created.slug, created.upload.url, onProgress);
    } catch (e) {
      // ROLLBACK. A create reserves a cap slot before a byte moves, so a dead
      // upload that leaves its row behind costs the account a slot it can't
      // see or name — five of those in a row is how the cap filled with
      // nothing in it.
      throw new Error(`${e.message}${await releaseReservation(created.slug, { ours, brandRoot })}`);
    }
  }
  // Finalize verifies the landed byte count exactly — a truncated upload is a
  // named 409 here, never a broken download in front of a reviewer. Skipped
  // only when the build is finalized already (reused, or landed on a PUT whose
  // response was lost).
  if (!done) {
    try {
      done = (await finalizeBuild(created.slug)) || {};
    } catch (e) {
      // Only a DEFINITE refusal means the bytes are garbage: 409 (they do not
      // match what was declared), 404/410 (the row is gone). A 500 or a
      // timeout says nothing about the object, and deleting on one throws away
      // an upload that may only need finalizing again — up to a gigabyte of it.
      const definite = e.status === 409 || e.status === 404 || e.status === 410;
      if (definite) throw new Error(`${e.message}${await releaseReservation(created.slug, { ours, brandRoot })}`);
      throw e;
    }
  }
  // The expiry the caller reports must be the one the row actually has.
  // Create stamps the SHORT reservation clock; finalize promotes it. Printing
  // create's value would tell a developer their build dies this afternoon.
  const expiresAt = done.expires_at || created.expires_at || null;
  // Serve urls are built from OUR base, not the server's echo (BASE override
  // consistency — the draftPush precedent).
  return {
    url: `${BASE}/b/${created.slug}`,
    slug: created.slug,
    filename,
    bytes,
    sha256,
    platform,
    reused: created.reused === true,
    expires_at: expiresAt,
    pushedAt: new Date().toISOString(),
  };
}

// ── build.list — every live build this account holds ───────────────────────
// The half that was missing when the cap bit: nothing reachable from a CLI or
// an agent could even name the builds occupying the five slots.
async function buildList() {
  const r = await api("/api/build");
  return {
    builds: Array.isArray(r.builds) ? r.builds : [],
    live: typeof r.live === "number" ? r.live : (r.builds || []).length,
    cap: r.cap ?? null,
  };
}

// ── build.status — owner-side metadata for a hosted build ──────────────────
async function buildStatus(slug) {
  return api(`/api/build/${slug}`);
}

// ── build.delete — remove a hosted build now (frees the live-builds slot) ──
async function buildDelete(slug) {
  return api(`/api/build/${slug}`, { method: "DELETE" });
}

module.exports = {
  buildPush,
  buildStatus,
  buildDelete,
  buildList,
  countingBody,
  explainBuildCap,
  releaseReservation,
  preflightBuildZip,
  listZipEntryNames,
  refuseWebBuildZip,
  refuseUnsignedMacApp,
  sha256File,
  putBuildWithRetry,
  MAX_BUILD_BYTES,
};
