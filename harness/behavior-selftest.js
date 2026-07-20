// harness/behavior-selftest.js — guards the `behavior` phase gate (harness/workflow.js's
// behaviorGate). Offline, socket-free: drives the gate purely through
// targets/<name>/behaviors-live.json / behaviors-clone.json / behavior-deviations.json
// fixtures on disk (no browser, no network) — the same file-fixture pattern
// workflow-selftest.js uses for live.json/clone.json.
//
// Asserts the contracts the design contract calls out explicitly:
//   - blocks on missing inventory (live, then clone)
//   - blocks on a live behavior absent from the clone inventory, NAMED in the reason
//   - blocks on out-of-tolerance values (speed, opacity, transform mismatch)
//   - passes on within-tolerance reproduction
//   - passes on a documented deviation
//   - fails a paint-over of "no discovery ran" (empty behaviors + no discovery metadata)
//   - passes when discovery legitimately found nothing (metadata present, behaviors empty)
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const { triggerForSweep, mutationTemporalEvidence } = require("../tools/behavior-capture.js");

const KIT = path.resolve(__dirname, "..");
const WF = path.join(KIT, "harness", "workflow.js");
let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed++; console.log(`  ✗ ${msg}`); } };

const run = (args) => { const r = cp.spawnSync(process.execPath, [WF, ...args], { encoding: "utf8", cwd: KIT }); return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }; };

const NAME = "behaviorselftest_" + process.pid;
const dir = path.join(KIT, "targets", NAME);
const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} };
process.on("exit", cleanup);
cleanup();
fs.mkdirSync(path.join(dir, "clone", "assets"), { recursive: true });

const writeJson = (f, o) => fs.writeFileSync(path.join(dir, f), JSON.stringify(o, null, 2));
const ownedMotionKeys = new Set();
const ownMotion = (...keys) => {
  keys.forEach((key) => ownedMotionKeys.add(key));
  writeJson("motion-items.json", {
    schema: "pingfusi/motion-items@1",
    items: [...ownedMotionKeys].map((key, i) => ({ id: `owned-${i + 1}`, kind: "animation", status: "done", sourceBehaviorKeys: [key] })),
  });
};

// discovery metadata that COUNTS as "discovery actually ran" — mirrors the shape
// tools/behavior-capture.js's discover() emits
const discoveryMeta = (extra) => Object.assign({
  startedAt: "2026-07-02T00:00:00.000Z", endedAt: "2026-07-02T00:00:03.000Z", durationMs: 3000,
  scrollSweep: { from: 0, to: 4000, steps: 6 },
  observeMs: 1500,
  elementsScanned: 812,
  staticCandidateCount: 5,
  keyframesFound: ["logo-belt"],
  hoverTriggersProbed: [],
  marqueeSelectorsProbed: [],
}, extra || {});

console.log("behavior-selftest — the `behavior` phase gate");
ok(triggerForSweep({ candidate: "strong", trigger: "load", kind: "css-animation" }) === "load" &&
  triggerForSweep({ candidate: "weak", trigger: "load" }) === "scroll-sweep",
  "scroll sampling preserves an already-strong load trigger and only infers scroll for weak evidence");
const reversibleMutation = mutationTemporalEvidence([
  { t: 0, atY: 0, snapshot: { opacity: 1, transform: "matrix(0,0,0,0,0,0)", filter: "none" } },
  { t: 50, atY: 400, snapshot: { opacity: 1, transform: "matrix(2,0,0,2,0,0)", filter: "none" } },
  { t: 100, atY: 800, snapshot: { opacity: 1, transform: "matrix(0,0,0,0,0,0)", filter: "none" } },
]);
ok(reversibleMutation && reversibleMutation.trigger === "scroll-sweep" && reversibleMutation.returnedToStart,
  "repeated non-candidate style mutations are measured as scroll-linked observation evidence even when they return to start");
ok(mutationTemporalEvidence([{ t: 0, atY: 0, snapshot: { opacity: 0 } }, { t: 10, atY: 0, snapshot: { opacity: 1 } }]) === null,
  "one-off non-candidate mutation remains interaction evidence, not automatic motion");

// ── QUARANTINE grading of sweep observations (rows shaped like discover()'s output) ──
// The sweep used to stamp candidate:"strong" on ANY style change at any scroll stop,
// auto-promoting ordinary reveals into the motion queue. Grading now follows
// temporalEvidence's own bar: only an engine timing signal promotes.
{
  const { classifyMotionRow } = require("./motion-items.js");
  const sweptWeak = classifyMotionRow("reveal:div.fade-in", {
    trigger: "scroll-sweep", kind: "class-toggle-or-style-mutation", selector: "div.fade-in",
    hints: ["transition-from-start-state"],
    temporal: { candidate: "weak", mechanism: "css-transition", durationMs: 300, trigger: "scroll-sweep", reason: "computed style changed during the measured scroll sweep" },
    measured: { before: { opacity: 0 }, after: { opacity: 1 }, changedDuringSweep: true, returnedToStart: false, maxChangedProperties: 1, sampleCount: 7 },
  }, "behaviors");
  ok(sweptWeak === null, "an ordinary sweep reveal (dormant transition that fired) stays OUT of the motion queue — observation recorded without promotion");
  const sweptStrong = classifyMotionRow("reveal:div.hero", {
    trigger: "load", kind: "class-toggle-or-style-mutation", selector: "div.hero",
    hints: ["animation-name:hero-in"],
    temporal: { candidate: "strong", kind: "css-animation", trigger: "load", animationName: "hero-in", durationMs: 900, reason: "named CSS animation hero-in with 900ms duration" },
    measured: { before: { opacity: 0 }, after: { opacity: 1 }, changedDuringSweep: true, returnedToStart: false, maxChangedProperties: 1, sampleCount: 7 },
  }, "behaviors");
  ok(!!sweptStrong && sweptStrong.kind === "css-animation", "a sweep reveal backed by an engine timing declaration keeps its strong candidate");
  const demotedMutation = classifyMotionRow("mutation:div.lazy", {
    trigger: "mutation", kind: "observed-mutation", selector: "div.lazy",
    measured: { before: { opacity: 0 }, after: { opacity: 1 }, during: { opacity: 0.5 }, sampleCount: 4, returnedToStart: false },
  }, "behaviors");
  ok(demotedMutation === null, "repeated content-mount mutations without an engine signal record as observed-mutation, never a motion candidate");
}
run(["init", NAME]); // seed workflow.json (harmless if it errors on a fresh dir — ignored)

// ── missing live inventory blocks ────────────────────────────────────────────
ok(run(["gate", NAME, "behavior"]).code === 1, "blocks with no behaviors-live.json");
const missLive = run(["gate", NAME, "behavior"]);
ok(/behaviors-live\.json missing/.test(missLive.out), "reason names the missing live inventory file");
ok(/behavior-capture/.test(missLive.out), "the missing-live reason offers the kit-owned Chrome runner as a path");

// ── a paint-over of "no discovery ran" fails: empty behaviors, NO discovery metadata ──
writeJson("behaviors-live.json", { url: "https://example.com/", behaviors: {} });
const paintOver = run(["gate", NAME, "behavior"]);
ok(paintOver.code === 1, "blocks when behaviors-live.json has an empty inventory but NO discovery metadata (paint-over)");
ok(/discovery pass metadata|paint-over/i.test(paintOver.out), "reason calls out the missing discovery evidence, not just 'no behaviors'");

// ── legitimate "discovery ran, found nothing" passes and cites the evidence ──
writeJson("behaviors-live.json", { url: "https://example.com/", discovery: discoveryMeta(), behaviors: {} });
const noneFound = run(["gate", NAME, "behavior"]);
ok(noneFound.code === 0, "passes when discovery metadata is present and genuinely found zero behaviors");
ok(/elements scanned/.test(noneFound.out) && /scroll swept 0.4000px/.test(noneFound.out.replace(/→/, ".")), "pass reason cites discovery metadata (elements scanned, scroll sweep) as evidence discovery ran");

writeJson("target.json", { name: NAME, url: "https://example.com/", adopted: false });
writeJson("motion-items.json", {
  schema: "pingfusi/motion-items@1",
  items: [{
    id: "linked-circle", kind: "scroll-linked", status: "done", bundleKind: "linked",
    candidateUrl: "https://pingfusi.test/d/v1", candidateSha256: "v1", candidateReceiptSource: "draft",
  }],
});
writeJson("draft.json", { url: "https://pingfusi.test/d/v1", verifiedSha256: "v1" });
ok(run(["gate", NAME, "behavior"]).code === 0, "a terminal linked receipt is valid while its verified candidate receipt matches");
writeJson("draft.json", { url: "https://pingfusi.test/d/v2", verifiedSha256: "v2" });
const driftedTerminal = run(["gate", NAME, "behavior"]);
ok(driftedTerminal.code === 0, "a newer candidate cannot block the gate — motion receipts are informational under the first-draft doctrine");
fs.rmSync(path.join(dir, "motion-items.json"));
fs.rmSync(path.join(dir, "draft.json"));

// ── a live behavior with no clone inventory at all blocks ───────────────────
writeJson("behaviors-live.json", {
  url: "https://example.com/", discovery: discoveryMeta(),
  behaviors: { "marquee:logo_belt": { trigger: "load", kind: "marquee", measured: { pxPerSec: 35.4 } } },
});
// QUARANTINE: an unowned strong candidate is ADVISORY — the gate's failure here is the
// ordinary missing-clone one, never a motion-ownership refusal.
const unownedMarquee = run(["gate", NAME, "behavior"]);
ok(unownedMarquee.code === 1 && /behaviors-clone\.json missing/.test(unownedMarquee.out) && !/motion owner/.test(unownedMarquee.out),
  "an unowned strong temporal candidate no longer blocks on ownership — the failure is the ordinary missing-clone one");
writeJson("behavior-deviations.json", { "marquee:logo_belt": { reason: "skip the moving belt" } });
writeJson("behaviors-clone.json", { url: "http://localhost:8080/", discovery: discoveryMeta(), behaviors: {} });
const excusedMarquee = run(["gate", NAME, "behavior"]);
ok(excusedMarquee.code === 0 && /documented deviation/.test(excusedMarquee.out) && /without a motion receipt/.test(excusedMarquee.out) && !/motion declare/.test(excusedMarquee.out),
  "an ordinary deviation disposes the row; the receipt-less candidate surfaces as an informational advisory, never a declare command");
fs.rmSync(path.join(dir, "behavior-deviations.json"));
fs.rmSync(path.join(dir, "behaviors-clone.json"));
ownMotion("marquee:logo_belt");
const noClone = run(["gate", NAME, "behavior"]);
ok(noClone.code === 1 && /behaviors-clone\.json missing/.test(noClone.out) && /marquee:logo_belt/.test(noClone.out), "blocks when clone inventory is entirely absent, names the live behavior waiting on it");

// ── a live behavior absent from the clone inventory blocks, NAMED ───────────
writeJson("behaviors-clone.json", { url: "http://localhost:8080/", discovery: discoveryMeta(), behaviors: {} });
const missingOne = run(["gate", NAME, "behavior"]);
ok(missingOne.code === 1 && /MISSING/.test(missingOne.out) && /marquee:logo_belt/.test(missingOne.out), "blocks when a live behavior is silently missing from the clone, and names it");

// ── out-of-tolerance speed blocks (2x speed marquee must not slip through) ──
writeJson("behaviors-clone.json", {
  url: "http://localhost:8080/", discovery: discoveryMeta(),
  behaviors: { "marquee:logo_belt": { trigger: "load", kind: "marquee", measured: { pxPerSec: 70.8 } } }, // exactly 2x live
});
const tooFast = run(["gate", NAME, "behavior"]);
ok(tooFast.code === 1 && /pxPerSec/.test(tooFast.out) && /marquee:logo_belt/.test(tooFast.out), "blocks a 2x-speed marquee (out of the ±15% pxPerSec tolerance)");

// ── within-tolerance speed passes (absorbs sampling noise) ───────────────────
writeJson("behaviors-clone.json", {
  url: "http://localhost:8080/", discovery: discoveryMeta(),
  behaviors: { "marquee:logo_belt": { trigger: "load", kind: "marquee", measured: { pxPerSec: 36.9 } } }, // ~4% off — within ±15%
});
const closeEnough = run(["gate", NAME, "behavior"]);
ok(closeEnough.code === 0, "passes a marquee sampled ~4% off live speed (within the documented ±15% tolerance)");

// ── trigger technique mismatch blocks even if the numbers happen to line up ──
writeJson("behaviors-live.json", {
  url: "https://example.com/", discovery: discoveryMeta(),
  behaviors: { "reveal:hero_heading": { trigger: "scroll", kind: "class-toggle-or-style-mutation", measured: { before: { opacity: 0, transform: "translateY(20px)", filter: "none" }, after: { opacity: 1, transform: "none", filter: "none" } } } },
});
writeJson("behaviors-clone.json", {
  url: "http://localhost:8080/", discovery: discoveryMeta(),
  behaviors: { "reveal:hero_heading": { trigger: "load", kind: "class-toggle-or-style-mutation", measured: { after: { opacity: 1, transform: "none", filter: "none" } } } },
});
const wrongTrigger = run(["gate", NAME, "behavior"]);
ok(wrongTrigger.code === 1 && /trigger/.test(wrongTrigger.out) && /reveal:hero_heading/.test(wrongTrigger.out), "blocks when the reproduction technique (trigger) differs from live, even with matching end-state numbers");

// ── out-of-tolerance end-state opacity blocks (clone frozen short of live's reveal) ──
writeJson("behaviors-clone.json", {
  url: "http://localhost:8080/", discovery: discoveryMeta(),
  behaviors: { "reveal:hero_heading": { trigger: "scroll", kind: "class-toggle-or-style-mutation", measured: { after: { opacity: 0.4, transform: "none", filter: "none" } } } },
});
const frozen = run(["gate", NAME, "behavior"]);
ok(frozen.code === 1 && /opacity/.test(frozen.out) && /hero_heading/.test(frozen.out), "blocks a reveal frozen short of live's end-state opacity");

// ── out-of-tolerance end-state transform blocks (live fully translates away, clone doesn't) ──
writeJson("behaviors-live.json", {
  url: "https://example.com/", discovery: discoveryMeta(),
  behaviors: { "reveal:hero_heading": { trigger: "scroll", kind: "class-toggle-or-style-mutation", measured: { after: { opacity: 1, transform: "translateY(-40px)", filter: "none" } } } },
});
writeJson("behaviors-clone.json", {
  url: "http://localhost:8080/", discovery: discoveryMeta(),
  behaviors: { "reveal:hero_heading": { trigger: "scroll", kind: "class-toggle-or-style-mutation", measured: { after: { opacity: 1, transform: "translateY(-10px)", filter: "none" } } } },
});
const wrongTransform = run(["gate", NAME, "behavior"]);
ok(wrongTransform.code === 1 && /transform/.test(wrongTransform.out) && /hero_heading/.test(wrongTransform.out), "blocks when the reproduced end-state transform string doesn't match live's exactly");

// ── matrix translation jitter passes (computed transforms are matrices; layout rounds them) ──
writeJson("behaviors-live.json", {
  url: "https://example.com/", discovery: discoveryMeta(),
  behaviors: { "reveal:hero_heading": { trigger: "scroll", kind: "class-toggle-or-style-mutation", measured: { after: { opacity: 1, transform: "matrix(1, 0, 0, 1, 0, -40.003)", filter: "none" } } } },
});
writeJson("behaviors-clone.json", {
  url: "http://localhost:8080/", discovery: discoveryMeta(),
  behaviors: { "reveal:hero_heading": { trigger: "scroll", kind: "class-toggle-or-style-mutation", measured: { after: { opacity: 1, transform: "matrix(1, 0, 0, 1, 0, -40.2)", filter: "none" } } } },
});
ok(run(["gate", NAME, "behavior"]).code === 0, "passes matrix transforms whose translation differs by sub-0.5px layout rounding (matrix-aware compare, not string equality)");

// ── observed-mutation (interval rotations) compare by PRESENCE, not frame snapshots ──
// A rotating hero's transform at snapshot time is whatever frame it was on — two captures of
// a continuously-mutating element can never agree on end-state floats. Presence + trigger
// match are the contract; a clone that ALSO rotates passes, one missing the key blocks.
writeJson("behaviors-live.json", {
  url: "https://example.com/", discovery: discoveryMeta(),
  behaviors: { "mutation:div.hero-rotator": { trigger: "mutation", kind: "observed-mutation", measured: { after: { opacity: 1, transform: "matrix(1, 0, 0, 1, 0, -333.2)", filter: "none" } } } },
});
writeJson("behaviors-clone.json", {
  url: "http://localhost:8080/", discovery: discoveryMeta(),
  behaviors: { "mutation:div.hero-rotator": { trigger: "mutation", kind: "observed-mutation", measured: { after: { opacity: 0.4, transform: "matrix(1, 0, 0, 1, 0, -80)", filter: "none" } } } },
});
ok(run(["gate", NAME, "behavior"]).code === 0, "passes an interval rotation whose frame snapshots differ (observed-mutation: presence+trigger are the contract, frames are nondeterministic)");
writeJson("behaviors-clone.json", { url: "http://localhost:8080/", discovery: discoveryMeta(), behaviors: {} });
ok(run(["gate", NAME, "behavior"]).code === 1, "an observed-mutation key missing from the clone still blocks (the clone must rotate at all)");

// reset live back to the simple opacity-reveal case used by the remaining assertions below
writeJson("behaviors-live.json", {
  url: "https://example.com/", discovery: discoveryMeta(),
  behaviors: { "reveal:hero_heading": { trigger: "scroll", kind: "class-toggle-or-style-mutation", measured: { before: { opacity: 0, transform: "translateY(20px)", filter: "none" }, after: { opacity: 1, transform: "none", filter: "none" } } } },
});

// ── within-tolerance reproduction passes ─────────────────────────────────────
writeJson("behaviors-clone.json", {
  url: "http://localhost:8080/", discovery: discoveryMeta(),
  behaviors: { "reveal:hero_heading": { trigger: "scroll", kind: "class-toggle-or-style-mutation", measured: { after: { opacity: 0.98, transform: "none", filter: "none" } } } }, // opacity 0.02 off — within ±0.05
});
ok(run(["gate", NAME, "behavior"]).code === 0, "passes a reveal that lands within the ±0.05 opacity tolerance with matching transform/trigger");

// ── multiple live behaviors: one within tolerance, one documented deviation ─
writeJson("behaviors-live.json", {
  url: "https://example.com/", discovery: discoveryMeta(),
  behaviors: {
    "reveal:hero_heading": { trigger: "scroll", kind: "class-toggle-or-style-mutation", measured: { after: { opacity: 1, transform: "none", filter: "none" } } },
    "generative:webgl_bg": { trigger: "load", kind: "canvas-generative", measured: { after: { opacity: 1 } } },
  },
});
writeJson("behaviors-clone.json", {
  url: "http://localhost:8080/", discovery: discoveryMeta(),
  behaviors: { "reveal:hero_heading": { trigger: "scroll", kind: "class-toggle-or-style-mutation", measured: { after: { opacity: 1, transform: "none", filter: "none" } } } },
});
const undocumented = run(["gate", NAME, "behavior"]);
writeJson("behavior-deviations.json", { "generative:webgl_bg": { reason: "WebGL generative canvas — irreproducible statically, per-frame noise procedurally generated" } });
const unownedWebgl = run(["gate", NAME, "behavior"]);
ok(undocumented.code === 1 && /generative:webgl_bg/.test(undocumented.out) && /MISSING/.test(undocumented.out) && !/motion owner/.test(undocumented.out),
  "an unowned specialist candidate falls through to the ordinary missing-behavior path (quarantine: ownership never blocks)");
ok(unownedWebgl.code === 0 && /documented deviation/.test(unownedWebgl.out) && /without a motion receipt/.test(unownedWebgl.out) && !/motion declare/.test(unownedWebgl.out),
  "a reasoned deviation disposes receipt-less WebGL motion; the candidate remains an informational advisory");
ownMotion("generative:webgl_bg");
const withDeviation = run(["gate", NAME, "behavior"]);
ok(withDeviation.code === 0 && /documented deviation/.test(withDeviation.out) && /generative:webgl_bg/.test(withDeviation.out), "after specialist convergence, behavior bookkeeping may document the unsupported inventory row");

// a deviation entry with an empty/missing reason doesn't count as documented (never a free pass)
writeJson("behavior-deviations.json", { "generative:webgl_bg": { reason: "" } });
ok(run(["gate", NAME, "behavior"]).code === 1, "an empty-reason deviation entry does NOT count as documented — still blocks");
fs.rmSync(path.join(dir, "behavior-deviations.json"));

// ── HIDDEN captures: refused by name, and the refusal carries the way OUT ────
// Some automation stacks report document.hidden=true permanently — a refusal that only
// says "foreground the tab" is a dead end there; it must point at the kit-owned Chrome
// runner (behavior-capture) that measures both sides regardless.
writeJson("behaviors-live.json", { url: "https://example.com/", discovery: discoveryMeta({ documentHidden: true }), behaviors: {} });
const hiddenLive = run(["gate", NAME, "behavior"]);
ok(hiddenLive.code === 1 && /HIDDEN/.test(hiddenLive.out), "a hidden-tab live capture is refused even with discovery metadata present");
ok(/behavior-capture/.test(hiddenLive.out), "the hidden-live refusal points at the kit-owned Chrome runner");
writeJson("behaviors-live.json", { url: "https://example.com/", discovery: discoveryMeta({ documentHidden: false }), behaviors: { "marquee:belt": { trigger: "load", kind: "marquee", measured: { pxPerSec: 46 } } } });
writeJson("behaviors-clone.json", { url: "http://localhost:8080/", discovery: discoveryMeta({ documentHidden: true }), behaviors: { "marquee:belt": { trigger: "load", kind: "marquee", measured: { pxPerSec: 46 } } } });
ownMotion("marquee:belt");
const hiddenClone = run(["gate", NAME, "behavior"]);
ok(hiddenClone.code === 1 && /behaviors-clone\.json was captured while the tab was HIDDEN/.test(hiddenClone.out) && /behavior-capture/.test(hiddenClone.out), "a hidden-tab clone capture is refused with the same way out");

// ── runner attestation: accepted and CITED when present, never required ──────
writeJson("behaviors-live.json", {
  url: "https://example.com/",
  discovery: discoveryMeta({ documentHidden: false, runner: { mode: "cdp-launched", chromeVersion: "Chrome/150.0", headless: true, profile: "temp", rafProbe: { frames: 33, ms: 702, hz: 66 }, animProbe: { expectedPxPerSec: 100, measuredPxPerSec: 99.7 } } }),
  behaviors: { "marquee:belt": { trigger: "load", kind: "marquee", measured: { pxPerSec: 46 } } },
});
writeJson("behaviors-clone.json", { url: "http://localhost:8080/", discovery: discoveryMeta({ documentHidden: false }), behaviors: { "marquee:belt": { trigger: "load", kind: "marquee", measured: { pxPerSec: 47 } } } });
const cited = run(["gate", NAME, "behavior"]);
ok(cited.code === 0 && /captured via cdp-launched Chrome\/150\.0, rAF 66Hz/.test(cited.out), "a pass cites the runner attestation (mode, version, rAF) when present");
fs.rmSync(path.join(dir, "behaviors-clone.json"), { force: true });

// ── DECLARED rows (environment-inverted runs): every supposed-to-move element needs a
//    disposition — reproduced (descriptor observed firing on the clone) or excused.
//    Silently dropping one is how a single invented animation replaces two real ones. ──
writeJson("behaviors-live.json", {
  url: "https://example.com/", discovery: discoveryMeta(),
  behaviors: {},
  declared: {
    "declared:video#intro-video": { hints: ["video:scripted:none", "attr:data-video-load-kf"], startState: { opacity: 1, transform: "none", filter: "none" }, text: null },
    "declared:span.gradient-headline": { hints: ["transition-from-start-state"], startState: { opacity: 0, transform: "none", filter: "none" }, text: "18MP Center Stage front" },
  },
});
writeJson("behaviors-clone.json", { url: "http://localhost:8080/", discovery: discoveryMeta(), behaviors: {} });
const undisposed = run(["gate", NAME, "behavior"]);
ok(undisposed.code === 1 && /DECLARED/.test(undisposed.out) && /behavior-worksheet/.test(undisposed.out), "undisposed declared rows block, pointing at the worksheet");
ok(/intro-video/.test(undisposed.out), "the blocked reason names the undisposed declared row");

// reproduced via descriptor match: the clone observed the same element firing under an
// observed prefix (reveal:) — declared:span.gradient-headline ↔ reveal:span.gradient-headline
writeJson("behaviors-clone.json", {
  url: "http://localhost:8080/", discovery: discoveryMeta(),
  behaviors: { "reveal:span.gradient-headline": { trigger: "scroll", kind: "class-toggle-or-style-mutation", measured: { after: { opacity: 1, transform: "none", filter: "none" } } } },
});
writeJson("behavior-deviations.json", { "declared:video#intro-video": { reason: "phone-screen video asset not shipped in the captured DOM — awaiting reviewer description of live playback" } });
const disposed = run(["gate", NAME, "behavior"]);
ok(disposed.code === 0 && /2 declared row\(s\) disposed \(1 reproduced, 1 excused\)/.test(disposed.out), "declared rows pass once each is reproduced (descriptor match) or excused, and the receipt counts them");

// worksheet CLI mirrors the same disposition logic + prints poll questions for unresolved
{
  const cpx = require("child_process");
  fs.rmSync(path.join(dir, "behavior-deviations.json"));
  const w1 = cpx.spawnSync(process.execPath, [path.join(KIT, "tools", "behavior-worksheet.js"), NAME], { encoding: "utf8", cwd: KIT });
  ok(w1.status === 1 && /UNRESOLVED/.test(w1.stdout + w1.stderr) && /review-qa\.js poll/.test(w1.stdout + w1.stderr), "worksheet exits 1 on unresolved rows and prints a ready-to-send one-sided poll question");
  writeJson("behavior-deviations.json", { "declared:video#intro-video": { reason: "awaiting reviewer description" } });
  const w2 = cpx.spawnSync(process.execPath, [path.join(KIT, "tools", "behavior-worksheet.js"), NAME], { encoding: "utf8", cwd: KIT });
  ok(w2.status === 0 && /worksheet clean/.test(w2.stdout), "worksheet exits 0 once every row is disposed");
}
fs.rmSync(path.join(dir, "behavior-deviations.json"), { force: true });
fs.rmSync(path.join(dir, "behaviors-live.json"), { force: true });
fs.rmSync(path.join(dir, "behaviors-clone.json"), { force: true });

// ── advance wiring: behavior sits between strict and reviewer in phaseOrder ────
{
  const { PHASES } = require(WF);
  const keys = PHASES.map((p) => p.key);
  ok(keys.indexOf("behavior") === keys.indexOf("strict") + 1, "behavior phase immediately follows strict");
  ok(keys.indexOf("review") === keys.indexOf("behavior") + 1, "review phase immediately follows behavior");
}

console.log(failed ? `\n❌ behavior-selftest: ${failed} assertion(s) failed.` : "\n✓ behavior-selftest: all assertions pass — the gate blocks when unmet and passes when met.");
process.exit(failed ? 1 : 0);
