#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { motionCandidatesFromSnapshot } = require("./motion-items.js");

const BIN = path.join(__dirname, "..", "bin", "pingfusi");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-next-"));
let failed = 0;
const ok = (condition, message) => {
  if (condition) console.log(`  ✓ ${message}`);
  else { failed++; console.log(`  ✗ ${message}`); }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
};
const run = (args) => {
  const result = spawnSync(process.execPath, [BIN, "next", ...args], { cwd: work, encoding: "utf8" });
  return { code: result.status, out: result.stdout || "", err: result.stderr || "" };
};
const runBin = (args) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd: work, encoding: "utf8" });
  return { code: result.status, out: result.stdout || "", err: result.stderr || "" };
};
const treeHash = (root) => {
  const hash = crypto.createHash("sha256");
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      hash.update(path.relative(root, file));
      if (entry.isDirectory()) walk(file);
      else hash.update(fs.readFileSync(file));
    }
  };
  walk(root);
  return hash.digest("hex");
};

process.on("exit", () => fs.rmSync(work, { recursive: true, force: true }));
console.log("next-selftest — read-only target routing CLI");

const name = "demo";
const dir = path.join(work, "targets", name);
writeJson(path.join(dir, "workflow.json"), {
  name,
  url: "https://example.test",
  phaseOrder: ["target", "visual"],
  phases: { target: { status: "pass" }, visual: { status: "pending" } },
});
writeJson(path.join(dir, "target.json"), { name, url: "https://example.test", width: 1512 });
writeJson(path.join(dir, "live.json"), { viewport: { width: 1512 }, elements: {} });
writeJson(path.join(dir, "clone.json"), { viewport: { width: 1512 }, elements: {} });

const beforeLayout = treeHash(work);
const layout = run([name, "--json"]);
const afterLayout = treeHash(work);
let layoutJson = null;
try { layoutJson = JSON.parse(layout.out); } catch (_) {}
ok(layout.code === 0 && layoutJson && layoutJson.capability === "layout", "--json reports the pending layout capability");
ok(layoutJson && JSON.stringify(Object.keys(layoutJson)) === JSON.stringify(["target", "capability", "utility", "command", "reason"]), "JSON output has exactly the five public fields");
ok(beforeLayout === afterLayout, "layout routing does not change any target byte");

writeJson(path.join(dir, "motion-items.json"), {
  schema: "pingfusi/motion-items@1",
  items: [{ id: "cta", kind: "spring", status: "pending", url: "https://example.test", trigger: "hover:.cta", scope: "#hero .cta", traceDir: "targets/demo/motion/trace" }],
});
const beforeMotion = treeHash(work);
const motion = run([name, "--json"]);
const afterMotion = treeHash(work);
let motionJson = null;
try { motionJson = JSON.parse(motion.out); } catch (_) {}
ok(motion.code === 0 && motionJson && motionJson.capability === "motion" && motionJson.command.startsWith("pingfusi motion"), "motion manifest takes precedence over pending layout");
ok(motionJson && motionJson.utility === "motion-trace" && /--out targets\/demo\/motion\/trace/.test(motionJson.command), "pending motion item captures into its structured trace destination");
ok(motionJson && /--scope '#hero \.cta'/.test(motionJson.command) && /--target demo --item cta$/.test(motionJson.command), "scope and lifecycle identity survive manifest-to-command routing");
ok(motionJson && !/--compare|\balign\b/i.test(motionJson.command), "motion route never calls the side-by-side layout utility");
ok(beforeMotion === afterMotion, "motion routing does not change any target byte");

// First-draft doctrine: no review rounds in the motion path. Bundles preview locally;
// legacy review-era statuses degrade to their artifact routes; no route ever prints a
// motion review/declare command or a --mode flag.
writeJson(path.join(dir, "motion-items.json"), {
  schema: "pingfusi/motion-items@1",
  items: [{ id: "belt", kind: "marquee", status: "bundled", url: "https://example.test", trigger: "load", bundleDir: "targets/demo/motion/belt-round" }],
});
let doctrine = run([name, "--json"]);
let doctrineJson = JSON.parse(doctrine.out);
ok(doctrine.code === 0 && doctrineJson.utility === "motion-serve" && doctrineJson.command === "pingfusi motion serve targets/demo/motion/belt-round", "a fitted marquee bundle previews locally — no publish, no round");
ok(!/--mode |motion review|motion declare/.test(doctrineJson.command), "the bundle route never prints review/declare machinery");
writeJson(path.join(dir, "motion-items.json"), {
  schema: "pingfusi/motion-items@1",
  items: [{ id: "belt", kind: "marquee", status: "needs-adjust", bundleDir: "targets/demo/motion/belt-round", publicBase: "https://motion.example/belt/" }],
});
doctrine = run([name, "--json"]);
doctrineJson = JSON.parse(doctrine.out);
ok(doctrineJson.utility === "motion-serve" && !/--mode |motion review/.test(doctrineJson.command), "a legacy needs-adjust status degrades to the local bundle preview");

const plain = run([name]);
ok(plain.code === 0 && /capability:\s+motion/.test(plain.out) && /run:\s+pingfusi motion serve/.test(plain.out), "default output is concise and runnable");

fs.writeFileSync(path.join(dir, "motion-items.json"), "null\n");
const nullManifest = run([name, "--json"]);
ok(nullManifest.code === 1 && /corrupt or empty/.test(nullManifest.err) && /restore its \{schema, items\} content/.test(nullManifest.err) && !/Cannot read properties/.test(nullManifest.err), "a literal-null manifest fails with the repair hint instead of a raw TypeError");

fs.rmSync(path.join(dir, "motion-items.json"));
writeJson(path.join(dir, "workflow.json"), {
  name,
  url: "https://stale.test",
  phaseOrder: ["behavior"],
  phases: { behavior: { status: "pending" } },
});
writeJson(path.join(dir, "target.json"), { name, url: "https://canonical.test", width: 1512 });
const discovery = { elementsScanned: 2, scrollSweep: { from: 0, to: 1000, steps: 3 }, observeMs: 1200, documentHidden: false };
writeJson(path.join(dir, "behaviors-live.json"), {
  discovery,
  behaviors: {
    marquee: { kind: "raf", trigger: "load", measured: { pxPerSec: 100 } },
    menu: { kind: "hover-mount", trigger: "hover:.menu", measured: { changed: true } },
  },
});
writeJson(path.join(dir, "behaviors-clone.json"), {
  discovery,
  behaviors: { marquee: { kind: "raf", trigger: "load", measured: { pxPerSec: 100 } } },
});
let behavior = run([name, "--json"]);
let behaviorJson = JSON.parse(behavior.out);
ok(behavior.code === 0 && behaviorJson.capability === "interaction" && !/motion declare/.test(behaviorJson.command), "receipt-less temporal evidence stays advisory instead of preempting the pipeline");
ok(Array.isArray(behaviorJson.advisories) && behaviorJson.advisories.some((note) => /sweep candidate marquee/.test(note) && /informational only/.test(note) && !/declare/.test(note)), "the sweep-candidate advisory is informational and prints no declare ceremony");
writeJson(path.join(dir, "motion-items.json"), {
  schema: "pingfusi/motion-items@1",
  items: [{ id: "owned-marquee", kind: "raf", status: "done", sourceBehaviorKeys: ["marquee"] }],
});
behavior = run([name, "--json"]);
behaviorJson = JSON.parse(behavior.out);
ok(behaviorJson.capability === "interaction", "once matched temporal evidence is converged, the actual missing interaction owns the next action");

const heroBaseline = {
  discovery,
  behaviors: { hero: { kind: "transition", trigger: "hover:.card", measured: { durationMs: 500 } } },
};
writeJson(path.join(dir, "behaviors-live.json"), heroBaseline);
writeJson(path.join(dir, "behaviors-clone.json"), {
  discovery,
  behaviors: { hero: { kind: "transition", trigger: "hover:.card", measured: { durationMs: 1200 } } },
});
behavior = run([name, "--json"]);
behaviorJson = JSON.parse(behavior.out);
ok(!/^pingfusi motion (?:capture|trace)/.test(behaviorJson.command) && (behaviorJson.advisories || []).some((note) => /sweep candidate hero/.test(note)), "a newly captured transition cannot jump into a specialist command; it surfaces as an informational advisory");
writeJson(path.join(dir, "behaviors-live.json"), {
  discovery: { ...discovery, documentHidden: true },
  behaviors: { hero: { kind: "transition", trigger: "hover:.card", measured: { durationMs: 500 } } },
});
behavior = run([name, "--json"]);
behaviorJson = JSON.parse(behavior.out);
ok(behaviorJson.capability === "environment" && behaviorJson.utility === "behavior-capture", "invalid hidden evidence is reacquired before even unowned motion is declared");
writeJson(path.join(dir, "behaviors-live.json"), {
  discovery,
  behaviors: { hero: { kind: "transition", trigger: "hover:.card", measured: { durationMs: 500 } } },
});
writeJson(path.join(dir, "motion-items.json"), {
  schema: "pingfusi/motion-items@1",
  items: [
    { id: "owned-marquee", kind: "raf", status: "done", sourceBehaviorKeys: ["marquee"] },
    {
      id: "hero", kind: "transition", status: "pending", url: "https://canonical.test", trigger: "hover:.card",
      sourceBehaviorKeys: ["hero"], sourceBehaviorFingerprints: { hero: motionCandidatesFromSnapshot(heroBaseline)[0].fingerprint },
    },
  ],
});
behavior = run([name, "--json"]);
behaviorJson = JSON.parse(behavior.out);
ok(behaviorJson.utility === "motion-capture" && behaviorJson.command.includes("https://canonical.test") && !behaviorJson.command.includes("https://stale.test"), "owned behavior routing uses canonical target.json URL instead of the init snapshot");
ok(/--trigger hover:.card/.test(behaviorJson.command) && !/--trigger load/.test(behaviorJson.command), "owned behavior routing preserves the failing hover trigger");

writeJson(path.join(dir, "behaviors-live.json"), {
  discovery,
  behaviors: { hero: { kind: "transition", trigger: "hover:.card", measured: { durationMs: 1200 } } },
});
behavior = run([name, "--json"]);
behaviorJson = JSON.parse(behavior.out);
ok(behaviorJson.utility === "motion-capture" && (behaviorJson.advisories || []).some((note) => /receipts for hero predate materially changed live evidence/.test(note)),
  "materially changed source evidence surfaces as a stale-receipt advisory while the owned item keeps its machine route");

writeJson(path.join(dir, "behaviors-live.json"), {
  discovery: { ...discovery, documentHidden: true },
  behaviors: { hero: { kind: "transition", trigger: "load", measured: { durationMs: 500 } } },
});
behavior = run([name, "--json"]);
behaviorJson = JSON.parse(behavior.out);
ok(behaviorJson.capability === "environment" && behaviorJson.utility === "behavior-capture", "hidden temporal measurements route to environment reacquisition first");

writeJson(path.join(dir, "behaviors-live.json"), {
  discovery,
  behaviors: { hero: { kind: "transition", trigger: "hover:.card", measured: { durationMs: 500 } } },
});
writeJson(path.join(dir, "behaviors-clone.json"), {
  discovery,
  behaviors: { hero: { kind: "transition", trigger: "hover:.card", measured: { durationMs: 500 } } },
});
writeJson(path.join(dir, "motion-items.json"), {
  schema: "pingfusi/motion-items@1",
  items: [{ id: "hero", kind: "transition", status: "done", sourceBehaviorKeys: ["hero"] }],
});
behavior = run([name, "--json"]);
behaviorJson = JSON.parse(behavior.out);
ok(behaviorJson.utility === "workflow-advance" && behaviorJson.command === "pingfusi advance demo behavior", "a green live behavior gate advances the workflow instead of reopening specialist work");

// Real failure shape: the gate display can truncate before the only strong row. `next`
// inspects the full artifact and remains read-only while surfacing its advisory.
fs.rmSync(path.join(dir, "motion-items.json"));
const declared = {};
for (let i = 0; i < 8; i++) declared[`declared:div.weak-${i}`] = { hints: ["will-change:transform"], startState: { opacity: 1, transform: "none" } };
declared["declared:img.hero-zoom"] = { hints: ["animation-name:up-zoom"], startState: { opacity: 1, transform: "none" } };
writeJson(path.join(dir, "behaviors-live.json"), {
  discovery,
  behaviors: { "mutation:main": { kind: "observed-mutation", trigger: "mutation", measured: { after: { opacity: 1 } } } },
  declared,
});
writeJson(path.join(dir, "behaviors-clone.json"), {
  discovery,
  behaviors: { "mutation:main": { kind: "observed-mutation", trigger: "mutation", measured: { after: { opacity: 1 } } } },
});
const beforeDeclared = treeHash(work);
behavior = run([name, "--json"]);
const afterDeclared = treeHash(work);
behaviorJson = JSON.parse(behavior.out);
ok((behaviorJson.advisories || []).some((note) => /declared:img\.hero-zoom/.test(note)) && !/--compare|\balign\b/i.test(behaviorJson.command), "a strong row after eight weak rows still surfaces its informational advisory, never layout comparison");
ok(beforeDeclared === afterDeclared, "unowned-motion advisory routing remains byte-for-byte read-only");
// The declare ceremony is gone: the CLI no longer accepts a declare subcommand at all.
const declareGone = runBin(["motion", "declare", name, "--from-behaviors"]);
ok(declareGone.code !== 0 && !/declared \d+ motion owner/.test(declareGone.out), "pingfusi motion declare no longer exists — the ceremony was removed with the review machinery");

// ── capture ladder: introspected binding → exact diff → machine-verified terminal ────────
// Fixture docs on disk, no browser: the live motion-doc (written by capture-run in real
// runs) and the clone-side doc the verify command would otherwise capture itself.
writeJson(path.join(dir, "motion-doc.json"), {
  schema: "pingfusi/motion-doc@1", url: "https://canonical.test", capturedAt: "2026-07-18T00:00:00.000Z",
  viewport: { width: 1512, height: 900, dpr: 2 },
  tracks: [{
    id: "t-belt", target: { selector: "#belt .strip" }, property: "transform",
    keyframes: [
      { offset: 0, value: "translateX(0px)", easing: "linear" },
      { offset: 1, value: "translateX(-2125px)" },
    ],
    timing: { duration_ms: 12000, delay_ms: 0, iterations: "infinite", direction: "normal", fill: "both" },
    timeline: { type: "document" }, provenance: { tier: "introspected-css", source: "css-animation:belt-shift" },
  }],
  assets: [],
});
writeJson(path.join(dir, "behaviors-live.json"), { discovery, behaviors: {} });
writeJson(path.join(dir, "behaviors-clone.json"), { discovery, behaviors: {} });
writeJson(path.join(dir, "motion-items.json"), {
  schema: "pingfusi/motion-items@1",
  items: [{ id: "belt", kind: "css-animation", status: "pending", declaredBy: "manual", url: "https://canonical.test", trigger: "load", scope: "#belt .strip" }],
});
const beforeLadder = treeHash(work);
let ladder = run([name, "--json"]);
const afterLadder = treeHash(work);
let ladderJson = JSON.parse(ladder.out);
ok(ladder.code === 0 && ladderJson.utility === "motion-verify-introspected" && ladderJson.command === "pingfusi motion verify-introspected demo belt",
  "a declared item whose scope matches an introspected doc track routes to the exact-diff verification");
ok(/no review round/.test(ladderJson.reason), "the route says the machine diff replaces the review round for this provenance");
ok(beforeLadder === afterLadder, "introspected routing derives the binding read-only — next writes nothing");

// Exact pass: in-tolerance float spelling (+0.9ms, +0.004px), a keyword-vs-bezier easing,
// a different introspected engine tier, and a null offset — all normalized.
writeJson(path.join(dir, "motion-doc-clone.json"), {
  schema: "pingfusi/motion-doc@1", url: "http://127.0.0.1:8080/", capturedAt: "2026-07-18T00:01:00.000Z",
  viewport: { width: 1512, height: 900, dpr: 2 },
  tracks: [{
    id: "c-belt", target: { selector: "#belt .strip" }, property: "transform",
    keyframes: [
      { offset: null, value: "translateX(0px)", easing: "cubic-bezier(0, 0, 1, 1)" },
      { offset: 1, value: "translateX(-2125.004px)" },
    ],
    timing: { duration_ms: 12000.9, delay_ms: 0, iterations: "infinite", direction: "normal", fill: "both" },
    timeline: { type: "document" }, provenance: { tier: "introspected-waapi" },
  }],
  assets: [],
});
const verifyPass = runBin(["motion", "verify-introspected", name, "belt"]);
ok(verifyPass.code === 0 && /verified-introspected/.test(verifyPass.out) && /no review round/.test(verifyPass.out),
  "an exactly matching clone declaration verifies green with exit 0 and no review round");
const verifiedItem = JSON.parse(fs.readFileSync(path.join(dir, "motion-items.json"), "utf8")).items.find((item) => item.id === "belt");
ok(verifiedItem.status === "verified-introspected" && verifiedItem.introspectedBinding &&
  verifiedItem.introspectedBinding.docTrackId === "t-belt" && verifiedItem.introspectedBinding.provenance === "introspected" &&
  /^[0-9a-f]{64}$/.test(verifiedItem.introspectedBinding.trackFingerprint),
  "the item records its binding (docTrackId + trackFingerprint, provenance introspected) and the terminal status");
const ladderReceipt = JSON.parse(fs.readFileSync(path.join(dir, "motion", "belt", "verify-introspected.json"), "utf8"));
ok(ladderReceipt.ok === true && ladderReceipt.tolerance.durationMs === 1 && ladderReceipt.tolerance.numeric === 0.01 &&
  ladderReceipt.tracks.length === 1 && ladderReceipt.tracks[0].docTrackId === "t-belt",
  "the diff is receipted with the documented tolerance and the exact tracks compared");
const gateAfterVerify = runBin(["gate", name, "behavior"]);
ok(gateAfterVerify.code === 0 && /machine-verified/.test(gateAfterVerify.out), "the behavior gate cites the verified-introspected machine receipt informationally");
ladder = run([name, "--json"]);
ladderJson = JSON.parse(ladder.out);
ok(ladderJson.utility === "workflow-advance" && ladderJson.command === "pingfusi advance demo behavior",
  "a machine-verified item releases routing to the workflow — no round was ever filed");

// Mismatch: a genuinely different keyframe value fails, names the keyframe, reopens.
const ladderCloneMiss = JSON.parse(fs.readFileSync(path.join(dir, "motion-doc-clone.json"), "utf8"));
ladderCloneMiss.tracks[0].keyframes[1].value = "translateX(-1000px)";
writeJson(path.join(dir, "motion-doc-clone.json"), ladderCloneMiss);
const verifyFail = runBin(["motion", "verify-introspected", name, "belt"]);
ok(verifyFail.code === 1 && /keyframes\[1\]\.value/.test(verifyFail.err) && /-2125/.test(verifyFail.err) && /-1000/.test(verifyFail.err),
  "a mismatch exits 1 naming the first differing keyframe with both sides' values");
const reopenedItem = JSON.parse(fs.readFileSync(path.join(dir, "motion-items.json"), "utf8")).items.find((item) => item.id === "belt");
ok(reopenedItem.status === "pending" && reopenedItem.lastVerifyIntrospected && reopenedItem.lastVerifyIntrospected.ok === false,
  "a failed re-verification reopens the previously green item — stale machine verification cannot survive");
ladder = run([name, "--json"]);
ladderJson = JSON.parse(ladder.out);
ok(ladderJson.utility === "motion-verify-introspected", "the reopened item routes back to the same exact-diff command until the clone matches");

// Quarantine: the gate refuses items nobody declared, even with a matching doc track.
const ladderItems = JSON.parse(fs.readFileSync(path.join(dir, "motion-items.json"), "utf8"));
ladderItems.items.push({ id: "auto-sweep-x", kind: "css-animation", status: "pending", source: "behavior-capture", scope: "#belt .strip" });
writeJson(path.join(dir, "motion-items.json"), ladderItems);
const verifyUndeclared = runBin(["motion", "verify-introspected", name, "auto-sweep-x"]);
ok(verifyUndeclared.code === 2 && /never operator-declared/.test(verifyUndeclared.err) && /motion-items\.json/.test(verifyUndeclared.err),
  "verification refuses a raw sweep item — machine writes only run on owned receipts");

// ── capture ladder tier 3: sampled tracks → apply-sampled → verify-sampled → terminal ────
// Fixture artifacts on disk, no browser for routing; the apply command runs for real
// through the root CLI. Apply now runs an OWNER PROBE against the served clone in a kit
// Chrome before writing anything (one owner — see motion-apply.js); this selftest is
// synchronous (spawnSync blocks the event loop), so a separate-process fake CDP endpoint
// answers the probe path (navigate, environment probe, pxOwnerProbe → clean). The verify
// command's full run is covered by motion-verify-selftest.js with an in-process fake.
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-next-fake-"));
const portFile = path.join(fakeDir, "port");
const FAKE_CDP_SRC = `
"use strict";
const http = require("http");
const fs = require("fs");
const { acceptKeyFor } = require(${JSON.stringify(path.join(__dirname, "cdp.js"))});
const portFile = process.argv[1];
function serverFrame(opcode, payload) {
  const data = Buffer.from(payload);
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
const GOOD_PROBE = { documentHidden: false, visibilityState: "visible", hasFocus: false, innerWidth: 1512, devicePixelRatio: 2, raf: { frames: 33, ms: 702 }, anim: { expectedPxPerSec: 100, measuredPxPerSec: 99.1 } };
let tabN = 0;
const server = http.createServer((req, res) => {
  if (req.url === "/json/version") { res.end(JSON.stringify({ Browser: "FakeChrome/1.0" })); return; }
  if (req.method === "PUT" && req.url.startsWith("/json/new")) {
    const id = "TAB" + (++tabN);
    res.end(JSON.stringify({ id, webSocketDebuggerUrl: "ws://127.0.0.1:" + server.address().port + "/devtools/page/" + id }));
    return;
  }
  if (req.url.startsWith("/json/close/")) { res.end("Target is closing"); return; }
  res.statusCode = 404; res.end();
});
server.on("upgrade", (req, socket) => {
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + acceptKeyFor(req.headers["sec-websocket-key"]) + "\\r\\n\\r\\n");
  const state = { buf: Buffer.alloc(0) };
  socket.on("data", (chunk) => {
    const frames = [];
    decodeClientFrames(state, chunk, frames);
    for (const f of frames) {
      if (f.opcode === 0x8) { socket.end(); continue; }
      if (f.opcode !== 0x1) continue;
      const msg = JSON.parse(f.data.toString());
      const reply = (result) => socket.write(serverFrame(0x1, JSON.stringify({ id: msg.id, result })));
      const event = (method, params) => socket.write(serverFrame(0x1, JSON.stringify({ method, params: params || {} })));
      const value = (v) => reply({ result: { type: typeof v, value: v } });
      if (msg.method === "Page.navigate") { reply({ frameId: "F1" }); event("Page.loadEventFired"); }
      else if (msg.method === "Runtime.evaluate") {
        const e = msg.params.expression;
        if (e.includes("__ppkProbe")) value(GOOD_PROBE);
        else if (e.startsWith("pxOwnerProbe(")) value({ schema: "pingfusi/owner-probe@1", durationMs: 1000, ticks: 10, elements: 1, missing: [], ownCancelled: 0, changed: [] });
        else if (e === "document.readyState") value("complete");
        else reply({ result: { type: "undefined" } });
      } else reply({});
    }
  });
  socket.on("error", () => {});
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(server.address().port)));
`;
const fakeCdp = require("child_process").spawn(process.execPath, ["-e", FAKE_CDP_SRC, portFile], { stdio: ["ignore", "ignore", "inherit"] });
process.on("exit", () => { try { fakeCdp.kill(); } catch (_) {} });
for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 50)"]);
if (!fs.existsSync(portFile)) { console.error("fake CDP endpoint never came up"); process.exit(1); }
const fakeCdpAddr = `127.0.0.1:${fs.readFileSync(portFile, "utf8").trim()}`;
writeJson(path.join(dir, "motion-doc.json"), {
  schema: "pingfusi/motion-doc@1", url: "https://canonical.test", capturedAt: "2026-07-18T00:00:00.000Z",
  viewport: { width: 1512, height: 900, dpr: 2 },
  tracks: [{
    id: "t-hero", target: { selector: ".hero" }, property: "transform",
    // a FINITE clip: the series settles inside the window (still moving in the final
    // frames would be ONGOING motion, which apply rightly refuses as a one-shot clip)
    keyframes: [
      { offset: 0, value: "matrix(1, 0, 0, 1, 0, 0)" },
      { offset: 0.25, value: "matrix(1, 0, 0, 1, 25, 0)" },
      { offset: 0.5, value: "matrix(1, 0, 0, 1, 50, 0)" },
      { offset: 0.75, value: "matrix(1, 0, 0, 1, 50, 0)" },
      { offset: 1, value: "matrix(1, 0, 0, 1, 50, 0)" },
    ],
    timing: { duration_ms: 100, delay_ms: 0, iterations: 1, direction: "normal", fill: "both" },
    timeline: { type: "document" }, provenance: { tier: "sampled", source: "virtual-time@50fps" },
  }],
  assets: [],
});
writeJson(path.join(dir, "motion-items.json"), {
  schema: "pingfusi/motion-items@1",
  items: [{ id: "hero-raf", kind: "raf", status: "sampled", declaredBy: "manual", url: "https://canonical.test", trigger: "load", scope: ".hero", sampledTrackIds: ["t-hero"] }],
});
fs.mkdirSync(path.join(dir, "clone"), { recursive: true });
fs.writeFileSync(path.join(dir, "clone", "index.html"), "<!doctype html>\n<html><body>\n<div class=\"hero\"></div>\n</body></html>\n");
const beforeSampled = treeHash(work);
let sampled = run([name, "--json"]);
const afterSampled = treeHash(work);
let sampledJson = JSON.parse(sampled.out);
ok(sampled.code === 0 && sampledJson.utility === "motion-apply-sampled" && sampledJson.command === "pingfusi motion apply-sampled demo hero-raf",
  "a declared item with sampled tracks at status sampled routes to the clone replay");
ok(beforeSampled === afterSampled, "sampled-tier routing stays byte-for-byte read-only");
const applied = runBin(["motion", "apply-sampled", name, "hero-raf", "--attach", fakeCdpAddr]);
fakeCdp.kill();
ok(applied.code === 0 && fs.existsSync(path.join(dir, "clone", "motion-replay.js")) &&
  (fs.readFileSync(path.join(dir, "clone", "index.html"), "utf8").match(/pingfusi:motion-replay:begin/g) || []).length === 1,
  "the root CLI applies the replay: clone/motion-replay.js plus exactly one marker block in index.html");
const appliedItem = JSON.parse(fs.readFileSync(path.join(dir, "motion-items.json"), "utf8")).items[0];
ok(appliedItem.status === "applied-sampled", "apply-sampled leaves the NON-terminal applied-sampled checkpoint");
sampled = run([name, "--json"]);
sampledJson = JSON.parse(sampled.out);
ok(sampledJson.utility === "motion-verify-sampled" && sampledJson.command === "pingfusi motion verify-sampled demo hero-raf" && /no review round/.test(sampledJson.reason),
  "the applied item routes to the sampled verify gate, never a review round");
const gateActiveSampled = runBin(["gate", name, "behavior"]);
ok(gateActiveSampled.code === 0 && /hero-raf/.test(gateActiveSampled.out + gateActiveSampled.err),
  "the behavior gate stays GREEN while the sampled item awaits its verify — motion is an informational line, never a gate failure (first-draft doctrine)");
writeJson(path.join(dir, "motion-items.json"), {
  schema: "pingfusi/motion-items@1",
  items: [{ id: "hero-raf", kind: "raf", status: "verified-sampled", declaredBy: "manual", scope: ".hero", sampledTrackIds: ["t-hero"] }],
});
const gateAfterSampled = runBin(["gate", name, "behavior"]);
ok(gateAfterSampled.code === 0 && /machine-verified/.test(gateAfterSampled.out), "the behavior gate cites the verified-sampled machine receipt informationally");
sampled = run([name, "--json"]);
sampledJson = JSON.parse(sampled.out);
ok(sampledJson.utility === "workflow-advance" && sampledJson.command === "pingfusi advance demo behavior",
  "a machine-verified sampled item releases routing to the workflow — no round was ever filed");
const verifySampledUsage = runBin(["motion", "verify-sampled"]);
ok(verifySampledUsage.code === 2 && /motion verify-sampled <name> <motion-id>/.test(verifySampledUsage.err),
  "the root CLI dispatches verify-sampled to the sampled gate (usage proves the --sampled wiring)");

// ── first-draft doctrine: machine terminals end the motion story — no round suggestions ──
ok(!(sampledJson.advisories || []).some((note) => /--mode|review round|spec round|draft round/.test(note)),
  "a machine-terminal item draws no reviewer-round suggestion — the machine receipt is the whole motion story");

const absent = run(["absent", "--json"]);
ok(absent.code !== 0 && /pingfusi (?:init|new)/.test(absent.err), "missing target fails nonzero with an initialization command");
ok(!fs.existsSync(path.join(work, "targets", "absent")), "missing-target failure creates nothing");

const broken = path.join(work, "targets", "broken");
fs.mkdirSync(broken, { recursive: true });
fs.writeFileSync(path.join(broken, "workflow.json"), "{ truncated");
const corrupt = run(["broken", "--json"]);
ok(corrupt.code !== 0 && /corrupt/.test(corrupt.err) && /init broken --force/.test(corrupt.err), "corrupt workflow fails nonzero with a recovery command");

const traversal = run(["../demo", "--json"]);
ok(traversal.code === 2 && /not a path/.test(traversal.err), "target name cannot escape targets/");

console.log(failed ? `\n❌ next-selftest: ${failed} assertion(s) failed.` : "\n✓ next-selftest: all assertions pass.");
process.exit(failed ? 1 : 0);
