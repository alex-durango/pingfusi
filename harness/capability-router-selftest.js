#!/usr/bin/env node
"use strict";

const { routeCapability, nextAction, shellArg } = require("./capability-router.js");

let failed = 0;
const ok = (condition, message) => {
  if (condition) console.log(`  ✓ ${message}`);
  else { failed++; console.log(`  ✗ ${message}`); }
};

console.log("capability-router-selftest — evidence-based specialist dispatch");

const structuredLayout = routeCapability({ target: "demo", kind: "layout", phase: "behavior", reason: "animation duration differs" });
ok(structuredLayout.capability === "layout" && structuredLayout.utility === "pixel-diff", "explicit structured kind wins over prose");

for (const signal of [
  "animation timing differs", "spring overshoots", "wrong easing", "duration is 2x",
  "stagger is late", "scroll-driven section drifts", "pointer-follow lags", "rAF loop jitters",
  "GSAP timeline differs", "WebGL intro is slow", "canvas shader motion differs",
]) {
  const route = routeCapability({ target: "demo", phase: "behavior", reason: signal, url: "https://example.test" });
  ok(route.capability === "motion" && route.command.startsWith("pingfusi motion") && !/--compare|\balign\b/i.test(route.command), `temporal signal routes only to motion: ${signal}`);
}

const measured = routeCapability({
  target: "demo",
  phase: "behavior",
  url: "https://example.test",
  artifacts: { behaviorsLive: { behaviors: { marquee: { measured: { pxPerSec: 120 } } } } },
});
ok(measured.capability === "motion" && measured.utility === "motion-trace", "measured temporal fields outrank generic behavior phase");

const interaction = routeCapability({ target: "demo", phase: "behavior", reason: "click toggles the menu open state" });
ok(interaction.capability === "interaction" && interaction.command === "pingfusi behavior-capture demo" && !/motion|--compare/.test(interaction.command), "state interaction uses behavior capture and neither specialist");

const environment = routeCapability({ target: "demo", phase: "behavior", artifacts: { behaviorsLive: null, behaviorsClone: null } });
ok(environment.capability === "environment" && environment.utility === "behavior-capture", "missing behavior artifacts route to environment reacquisition");
const hiddenMotion = routeCapability({
  target: "demo",
  phase: "behavior",
  kind: "spring",
  url: "https://example.test",
  artifacts: { behaviorsLive: { discovery: { documentHidden: true } }, behaviorsClone: {} },
});
ok(hiddenMotion.capability === "environment", "hidden capture evidence outranks an apparent motion kind");

const hoverMotion = routeCapability({
  target: "demo",
  phase: "behavior",
  url: "https://example.test",
  behavior: { kind: "transition", trigger: "hover:.card", measured: { durationMs: 500 } },
  behaviorRows: [{ key: "card", kind: "transition", trigger: "hover:.card", measured: { durationMs: 500 } }],
});
ok(hoverMotion.utility === "motion-capture" && /--trigger hover:.card/.test(hoverMotion.command) && !/--trigger load/.test(hoverMotion.command), "selected behavior kind and trigger survive motion routing");

const layout = routeCapability({ target: "demo", phase: "visual", status: "pending" });
ok(layout.capability === "layout" && layout.utility === "pixel-diff" && / --visual$/.test(layout.command), "visual phase uses the pixel-diff loop");
const stalledLayout = routeCapability({ target: "demo", phase: "strict", status: "stalled" });
ok(stalledLayout.capability === "layout" && stalledLayout.command === "pingfusi assist demo --compare", "stalled layout uses side-by-side diagnosis");

const unknown = routeCapability({ target: "demo", reason: "something seems off" });
ok(unknown.capability === "unknown" && unknown.utility === "inspect" && unknown.command === "pingfusi status demo", "ambiguous evidence fails closed to inspect/clarify");

const itemFirst = nextAction({
  target: "demo",
  workflow: { url: "https://example.test", phaseOrder: ["visual"], phases: { visual: { status: "pending" } } },
  motionItems: { items: [{ id: "hero-gl", kind: "webgl", status: "pending", url: "https://example.test", trigger: "load" }] },
  artifacts: {},
});
ok(itemFirst.capability === "motion" && itemFirst.command.startsWith("pingfusi motion trace") && /--gl(?:\s|$)/.test(itemFirst.command), "active motion item takes precedence over workflow layout and enables GL tracing");
ok(JSON.stringify(Object.keys(itemFirst)) === JSON.stringify(["target", "capability", "utility", "command", "reason"]), "next action has exactly the stable five-field contract");

const completedItem = nextAction({
  target: "demo",
  workflow: { phaseOrder: ["visual"], phases: { visual: { status: "pending" } } },
  motionItems: [{ id: "hero", kind: "spring", status: "complete", url: "https://example.test" }],
});
ok(completedItem.capability === "layout", "completed motion items do not mask the general workflow");

// First-draft doctrine: candidate drift/publication machinery is gone — a terminal
// linked receipt is terminal, and changed candidate bytes never resurrect review work.
const terminalLinked = nextAction({
  target: "demo",
  workflow: { phaseOrder: ["visual"], phases: { visual: { status: "pending" } } },
  motionItems: [{
    id: "linked-circle", kind: "scroll-linked", status: "done", bundleKind: "linked",
    candidateUrl: "https://pingfusi.test/d/v1", candidateSha256: "v1",
  }],
  artifacts: { target: { adopted: false }, draft: { url: "https://pingfusi.test/d/v2", verifiedSha256: "v2" }, tunnel: null },
});
ok(terminalLinked.capability === "layout" && !/motion review|prepare-linked/.test(terminalLinked.command), "a terminal linked receipt stays terminal — no drift machinery reopens review work");

const advisoryLive = {
  discovery: { documentHidden: false },
  behaviors: { belt: { kind: "marquee", trigger: "load", measured: { pxPerSec: 90 } } },
};
const advisoryNext = nextAction({
  target: "demo",
  workflow: { phaseOrder: ["visual"], phases: { visual: { status: "pending" } } },
  motionItems: [],
  artifacts: { behaviorsLive: advisoryLive },
});
ok(advisoryNext.capability === "layout" && Array.isArray(advisoryNext.advisories) && advisoryNext.advisories.length === 1, "a receipt-less sweep candidate stays advisory and cannot preempt pipeline routing");
ok(/sweep candidate belt \(marquee, load\)/.test(advisoryNext.advisories[0]) && /informational only/.test(advisoryNext.advisories[0]) && !/declare/.test(advisoryNext.advisories[0]), "the advisory is informational and never prints a declare ceremony");
ok(JSON.stringify(Object.keys(advisoryNext)) === JSON.stringify(["target", "capability", "utility", "command", "reason", "advisories"]), "advisories are the single optional sixth field on the action contract");
const staleDeclaredNext = nextAction({
  target: "demo",
  workflow: { phaseOrder: ["visual"], phases: { visual: { status: "pending" } } },
  motionItems: [{
    id: "belt", kind: "marquee", status: "done", declaredBy: "manual",
    sourceBehaviorKeys: ["belt"], sourceBehaviorFingerprints: { belt: "stale-fingerprint" },
  }],
  artifacts: { behaviorsLive: advisoryLive },
});
ok(staleDeclaredNext.capability === "layout" && (staleDeclaredNext.advisories || []).some((note) => /receipts for belt predate materially changed live evidence/.test(note)), "a materially changed source surfaces as a stale-receipt advisory — informational, never a routed reconciliation");
const sweepItemNext = nextAction({
  target: "demo",
  workflow: { phaseOrder: ["visual"], phases: { visual: { status: "pending" } } },
  motionItems: [{ id: "auto-marquee-11112222", kind: "marquee", status: "pending", source: "behavior-capture", sourceBehaviorKeys: ["belt"], url: "https://example.test" }],
  artifacts: {},
});
ok(sweepItemNext.capability === "layout" && sweepItemNext.advisories.some((note) => /auto-marquee-11112222/.test(note) && /informational/.test(note)), "a sweep-manufactured active item never preempts routing and stays an informational note");
const placeholderNext = nextAction({
  target: "demo",
  workflow: { phaseOrder: ["visual"], phases: { visual: { status: "pending" } } },
  motionItems: [{ id: "review-1-temporal", status: "needs-declaration", source: "page-review", sourceReview: { pingId: "ping-9" } }],
  artifacts: {},
});
ok(placeholderNext.capability === "layout" && !/declare/.test(placeholderNext.command), "a legacy review placeholder no longer routes a declaration step — the ceremony is gone");

const bundle = routeCapability({ target: "demo", motionItem: { id: "hero", kind: "spring", status: "bundled", bundleDir: "targets/demo/motion/bundle" } });
ok(bundle.utility === "motion-serve" && bundle.command === "pingfusi motion serve targets/demo/motion/bundle", "a bundle previews locally — no publish, no review round");
const marqueeTraced = routeCapability({ target: "demo", motionItem: { id: "belt", kind: "marquee", status: "traced", traceDir: "targets/demo/motion/belt-trace" } });
ok(marqueeTraced.utility === "motion-loop" && marqueeTraced.command === "pingfusi motion loop targets/demo/motion/belt-trace --target demo --item belt", "a marquee trace routes to the fitting loop, not the linked-export path");
// First-draft doctrine's hard line: NO route may print a motion review/declare command
// or a --mode flag — legacy review-era statuses degrade to their artifact-driven routes.
for (const motionItem of [
  { id: "a", kind: "spring", status: "bundled", bundleDir: "/tmp/b" },
  { id: "b", kind: "marquee", status: "bundled", bundleDir: "/tmp/b" },
  { id: "c", kind: "scroll-linked", status: "bundled", bundleKind: "linked", bundleDir: "/tmp/b" },
  { id: "d", kind: "spring", status: "needs-publish-2afc", bundleDir: "/tmp/b" },
  { id: "e", kind: "spring", status: "mystery-status", bundleDir: "/tmp/b" },
  { id: "f", kind: "spring", status: "needs-diagnosis", bundleDir: "/tmp/b", publicBase: "https://x.example/" },
  { id: "g", kind: "marquee", status: "needs-adjust", bundleDir: "/tmp/b", publicBase: "https://x.example/" },
  { id: "h", kind: "webgl", status: "review", bundleDir: "/tmp/b" },
  { id: "i", kind: "spring", status: "review-pending", pingId: "ping-1" },
  { id: "j", kind: "spring", status: "review-ready", pingId: "ping-1" },
  { id: "k", kind: "spring", status: "needs-2afc", bundleDir: "/tmp/b", publicBase: "https://x.example/" },
]) {
  const route = routeCapability({ target: "demo", motionItem });
  ok(!/motion review|motion declare|--mode /.test(route.command), `no route prints review/declare machinery (${motionItem.kind}/${motionItem.status} → ${route.utility})`);
}
const trace = routeCapability({ target: "demo", motionItem: { kind: "spring", status: "traced", traceDir: "targets/demo/motion/trace" } });
ok(trace.utility === "motion-loop" && trace.command === "pingfusi motion loop targets/demo/motion/trace", "trace path advances to convergence-loop generation");
for (const kind of ["webgl", "canvas", "pointer-follow", "scroll-linked"]) {
  const specialized = routeCapability({ target: "demo", motionItem: { id: `special-${kind}`, kind, status: "traced", traceDir: "targets/demo/motion/trace" } });
  ok(specialized.utility === "motion-export" && specialized.command.startsWith("pingfusi motion export") && !/ motion loop |--compare|\balign\b/.test(specialized.command), `${kind} trace exports its fitted runtime instead of entering the time-based DOM loop`);
}
const genericScrollTrace = routeCapability({
  target: "demo",
  motionItem: {
    id: "generic-scroll", kind: "animation", status: "traced",
    trigger: "scroll-through:#stage/80/16", traceDir: "targets/demo/motion/generic-scroll-trace",
  },
});
ok(genericScrollTrace.utility === "motion-export" && !genericScrollTrace.command.includes(" motion loop "), "a structured scroll-through trigger preserves linked routing even when the declared kind is generic animation");
const exportedLinked = routeCapability({ target: "demo", motionItem: { id: "hero-gl", kind: "webgl", status: "exported-needs-linked-review", traceDir: "targets/demo/motion/trace", libraryDir: "targets/demo/motion/library" } });
ok(exportedLinked.utility === "motion-export" && !/motion review|prepare-linked/.test(exportedLinked.command), "a legacy exported-needs-linked-review status degrades to its artifact route — the linked review path is gone");
const directTrace = routeCapability({ name: "demo", kind: "GSAP", status: "traced", traceDir: "targets/demo/motion/trace" });
ok(directTrace.utility === "motion-loop" && directTrace.command === "pingfusi motion loop targets/demo/motion/trace", "direct structured trace path and name alias route without prose inference");
const missingStatus = routeCapability({ target: "demo", motionItem: { id: "hero", kind: "spring", url: "https://example.test", traceDir: "targets/demo/motion/trace" } });
ok(missingStatus.utility === "motion-trace" && /--out targets\/demo\/motion\/trace/.test(missingStatus.command), "a missing status defaults to pending like isTerminalMotionItem, so named dirs stay destinations");
const missingStatusNoUrl = routeCapability({ target: "demo", motionItem: { id: "hero", kind: "spring", traceDir: "targets/demo/motion/trace" } });
ok(missingStatusNoUrl.utility === "motion-inspect", "a missing status never lets a destination path masquerade as captured evidence");
const capture = routeCapability({ target: "demo", motionItem: { kind: "css-animation", status: "captured", captureDir: "targets/demo/motion/capture" } });
ok(capture.utility === "motion-gate" && capture.command === "pingfusi motion gate targets/demo/motion/capture", "capture path advances to the motion replay gate");
const gatedCapture = routeCapability({ target: "demo", motionItem: { id: "cta", kind: "css-animation", status: "gated", captureDir: "targets/demo/motion/capture" } });
ok(gatedCapture.utility === "motion-export" && /motion export targets\/demo\/motion\/capture .*--target demo --item cta$/.test(gatedCapture.command), "a passed verbatim replay gate advances to managed export instead of repeating forever");
const pending = routeCapability({ target: "demo", motionItem: { kind: "spring", status: "pending", url: "https://example.test", traceDir: "targets/demo/motion/trace" } });
ok(pending.utility === "motion-trace" && /--out targets\/demo\/motion\/trace/.test(pending.command), "pending traceDir is treated as a destination, not an already-captured trace");

const proseGl = routeCapability({
  target: "demo",
  motionItem: { id: "hero", kind: "spring", status: "pending", url: "https://example.test" },
  reason: "the hero canvas section mentions a webgl shader in its copy",
});
ok(proseGl.utility === "motion-trace" && !/--gl/.test(proseGl.command), "prose that merely mentions canvas/webgl never adds a GL trace");
const flaggedGl = routeCapability({ target: "demo", motionItem: { id: "hero", kind: "spring", status: "pending", gl: true, url: "https://example.test" } });
ok(/--gl(?:\s|$)/.test(flaggedGl.command), "an explicit structured gl flag enables GL tracing without a rendered kind");

const placeholder = routeCapability({
  target: "demo",
  motionItem: { id: "review-1-temporal", kind: "review-discovered", status: "needs-declaration", sourceReview: { pingId: "ping-9" } },
});
ok(!/motion declare|motion review/.test(placeholder.command), "a legacy review placeholder never prints declare/review machinery — it degrades to inspection");

ok(shellArg("plain-token_1") === "plain-token_1" && shellArg("a'b c") === `'a'"'"'b c'`, "exported shellArg passes safe tokens through and quotes everything else");

const scoped = routeCapability({
  target: "demo",
  motionItem: {
    id: "circle",
    kind: "scroll-linked",
    status: "pending",
    url: "https://example.test",
    trigger: "scroll-sweep",
    scope: "#story .expanding circle[data-name='hero']",
    traceDir: "targets/demo/motion/circle-trace",
  },
});
ok(scoped.utility === "motion-trace" && scoped.command.includes("--scope '#story .expanding circle[data-name='\"'\"'hero'\"'\"']'"), "a motion-item scope is shell-quoted into the specialist trace command");
ok(scoped.command.endsWith("--target demo --item circle") && !/--compare|\balign\b/i.test(scoped.command), "managed scoped trace carries lifecycle identity and never calls layout review");

// ── capture ladder: introspected bindings route to the exact-diff gate, no round ─────────
const ladderDoc = {
  schema: "pingfusi/motion-doc@1", url: "https://example.test", capturedAt: null, viewport: null,
  tracks: [{
    id: "t-belt", target: { selector: "#belt .strip" }, property: "transform",
    keyframes: [{ offset: 1, value: "translateX(-2125px)" }],
    timing: { duration_ms: 12000, delay_ms: 0, iterations: "infinite", direction: "normal", fill: "both" },
    timeline: { type: "document" }, provenance: { tier: "introspected-css", source: "css-animation:belt-shift" },
  }],
  assets: [],
};
const boundVerify = routeCapability({
  target: "demo",
  motionItem: {
    id: "belt", kind: "css-animation", status: "pending", declaredBy: "manual", scope: "#belt .strip",
    url: "https://example.test", trigger: "load",
    introspectedBinding: { provenance: "introspected", docTrackId: "t-belt", trackFingerprint: "f".repeat(64) },
  },
});
ok(boundVerify.utility === "motion-verify-introspected" && boundVerify.command === "pingfusi motion verify-introspected demo belt",
  "a recorded introspected binding routes to the exact-diff verification, not capture or review");
ok(/no review round/.test(boundVerify.reason) && /±1ms/.test(boundVerify.reason) && /±0\.01/.test(boundVerify.reason),
  "the verify route names the documented tolerance and the no-round doctrine");
const derivedVerify = nextAction({
  target: "demo",
  workflow: { phaseOrder: ["visual"], phases: { visual: { status: "pending" } } },
  motionItems: [{ id: "belt", kind: "css-animation", status: "pending", declaredBy: "manual", scope: "#belt .strip", url: "https://example.test", trigger: "load" }],
  artifacts: { motionDoc: ladderDoc },
});
ok(derivedVerify.utility === "motion-verify-introspected" && derivedVerify.command === "pingfusi motion verify-introspected demo belt",
  "an unrecorded binding is derived read-only from the live motion doc for routing");
const fittedTierDoc = JSON.parse(JSON.stringify(ladderDoc));
fittedTierDoc.tracks[0].provenance = { tier: "fitted", source: "fit:tween" };
const fittedTierRoute = nextAction({
  target: "demo",
  workflow: { phaseOrder: ["visual"], phases: { visual: { status: "pending" } } },
  motionItems: [{ id: "belt", kind: "css-animation", status: "pending", declaredBy: "manual", scope: "#belt .strip", url: "https://example.test", trigger: "load" }],
  artifacts: { motionDoc: fittedTierDoc },
});
ok(fittedTierRoute.utility === "motion-capture" && !/verify-introspected/.test(fittedTierRoute.command),
  "a fitted-tier track never triggers the exact-diff route — that provenance keeps the existing path");
const verifiedTerminal = nextAction({
  target: "demo",
  workflow: { phaseOrder: ["visual"], phases: { visual: { status: "pending" } } },
  motionItems: [{
    id: "belt", kind: "css-animation", status: "verified-introspected", declaredBy: "manual", scope: "#belt .strip",
    introspectedBinding: { provenance: "introspected", docTrackId: "t-belt", trackFingerprint: "f".repeat(64) },
  }],
  artifacts: { motionDoc: ladderDoc },
});
ok(verifiedTerminal.capability === "layout", "verified-introspected is terminal: the item releases routing to the general workflow");
const undeclaredWithDoc = nextAction({
  target: "demo",
  workflow: { phaseOrder: ["visual"], phases: { visual: { status: "pending" } } },
  motionItems: [{ id: "auto-css-11112222", kind: "css-animation", status: "pending", source: "behavior-capture", scope: "#belt .strip", sourceBehaviorKeys: ["belt"] }],
  artifacts: { motionDoc: ladderDoc },
});
ok(undeclaredWithDoc.capability === "layout" && !/verify-introspected/.test(undeclaredWithDoc.command) &&
  (undeclaredWithDoc.advisories || []).some((note) => /auto-css-11112222/.test(note)),
  "an undeclared sweep item never reaches the exact-diff gate even when the doc matches its scope — quarantine holds");
const boundLegacyReviewStatus = routeCapability({
  target: "demo",
  motionItem: {
    id: "belt", kind: "css-animation", status: "review-pending", pingId: "ping-7", declaredBy: "manual", scope: "#belt .strip",
    introspectedBinding: { provenance: "introspected", docTrackId: "t-belt", trackFingerprint: "f".repeat(64) },
  },
});
ok(boundLegacyReviewStatus.utility === "motion-verify-introspected" && boundLegacyReviewStatus.command === "pingfusi motion verify-introspected demo belt",
  "a legacy review-pending status no longer parks a bound item — the machine diff owns it");

// ── capture ladder tier 3: sampled tracks walk sample → apply-sampled → verify-sampled ───
const sampledDoc = {
  schema: "pingfusi/motion-doc@1", url: "https://example.test", capturedAt: null, viewport: null,
  tracks: [{
    id: "t-hero", target: { selector: ".hero" }, property: "transform",
    keyframes: [{ offset: 0, value: "matrix(1, 0, 0, 1, 0, 0)" }, { offset: 1, value: "matrix(1, 0, 0, 1, 50, 0)" }],
    timing: { duration_ms: 100, delay_ms: 0, iterations: 1, direction: "normal", fill: "both" },
    timeline: { type: "document" }, provenance: { tier: "sampled", source: "virtual-time@50fps" },
  }],
  assets: [],
};
const sampledItem = (over = {}) => ({ id: "hero-raf", kind: "raf", status: "pending", declaredBy: "manual", scope: ".hero", url: "https://example.test", trigger: "load", ...over });
const sampleRoute = routeCapability({ target: "demo", motionItem: sampledItem(), artifacts: { motionDoc: sampledDoc } });
ok(sampleRoute.utility === "motion-sample" && sampleRoute.command === "pingfusi motion sample demo hero-raf",
  "a pending declared item whose evidence is sampled-tier tracks routes to virtual-time re-sampling");
const applyRoute = routeCapability({ target: "demo", motionItem: sampledItem({ status: "sampled", sampledTrackIds: ["t-hero"] }) });
ok(applyRoute.utility === "motion-apply-sampled" && applyRoute.command === "pingfusi motion apply-sampled demo hero-raf" && /WAAPI/.test(applyRoute.reason),
  "status sampled routes to the clone replay (apply-sampled)");
const verifySampledRoute = routeCapability({ target: "demo", motionItem: sampledItem({ status: "applied-sampled", sampledTrackIds: ["t-hero"] }) });
ok(verifySampledRoute.utility === "motion-verify-sampled" && verifySampledRoute.command === "pingfusi motion verify-sampled demo hero-raf",
  "status applied-sampled routes to the sampled verify gate");
ok(/no review round/.test(verifySampledRoute.reason) && /±1px/.test(verifySampledRoute.reason) && /±0\.02/.test(verifySampledRoute.reason),
  "the sampled verify route names the documented per-frame tolerance and the no-round doctrine");
const sampledTerminal = nextAction({
  target: "demo",
  workflow: { phaseOrder: ["visual"], phases: { visual: { status: "pending" } } },
  motionItems: [sampledItem({ status: "verified-sampled", sampledTrackIds: ["t-hero"] })],
  artifacts: { motionDoc: sampledDoc },
});
ok(sampledTerminal.capability === "layout", "verified-sampled is terminal: the item releases routing to the general workflow");
const undeclaredSampled = nextAction({
  target: "demo",
  workflow: { phaseOrder: ["visual"], phases: { visual: { status: "pending" } } },
  motionItems: [{ id: "auto-raf-11112222", kind: "raf", status: "pending", source: "behavior-capture", scope: ".hero", sourceBehaviorKeys: ["hero"] }],
  artifacts: { motionDoc: sampledDoc },
});
ok(undeclaredSampled.capability === "layout" && !/sample|apply-sampled|verify-sampled/.test(undeclaredSampled.command) &&
  (undeclaredSampled.advisories || []).some((note) => /auto-raf-11112222/.test(note)),
  "an undeclared sweep item never enters the sampled chain even when the doc matches its scope — quarantine holds");
const undeclaredSampledStatus = routeCapability({
  target: "demo",
  motionItem: { id: "auto-raf-11112222", kind: "raf", status: "sampled", source: "behavior-capture", scope: ".hero", sampledTrackIds: ["t-hero"] },
});
ok(undeclaredSampledStatus.utility !== "motion-apply-sampled" && undeclaredSampledStatus.utility !== "motion-verify-sampled",
  "even a sampled STATUS on an undeclared row cannot route the apply/verify chain");
// fitted-tier path: a bundled item with sampled doc tracks still previews its bundle
// locally, and a fitted-tier doc never triggers the sampled chain.
const bundledWithSampledDoc = routeCapability({
  target: "demo",
  motionItem: sampledItem({ status: "bundled", bundleDir: "targets/demo/motion/bundle", sampledTrackIds: ["t-hero"] }),
  artifacts: { motionDoc: sampledDoc },
});
ok(bundledWithSampledDoc.utility === "motion-serve" && !/--mode/.test(bundledWithSampledDoc.command),
  "a bundled fitted item serves its bundle locally even when sampled doc tracks exist — no publish, no round");
const fittedDocOnly = JSON.parse(JSON.stringify(sampledDoc));
fittedDocOnly.tracks[0].provenance = { tier: "fitted", source: "fit:tween" };
fittedDocOnly.tracks[0].fit = { kind: "tween", params: {}, nrmse: 0.02 };
const fittedNoSample = routeCapability({ target: "demo", motionItem: sampledItem(), artifacts: { motionDoc: fittedDocOnly } });
ok(fittedNoSample.utility === "motion-trace" && !/motion sample/.test(fittedNoSample.command),
  "a fitted-tier doc track never routes the sampled chain — pending falls through to the existing capture path");
const introspectedOverSampled = routeCapability({
  target: "demo",
  motionItem: sampledItem({ status: "sampled", sampledTrackIds: ["t-hero"], introspectedBinding: { provenance: "introspected", docTrackId: "t-x", trackFingerprint: "f".repeat(64) } }),
});
ok(introspectedOverSampled.utility === "motion-verify-introspected",
  "the ladder's top rung keeps precedence: an introspected binding outranks the sampled chain");

// ── first-draft doctrine: machine terminals draw NO reviewer-round suggestion ────────────
const machineTerminalQuiet = nextAction({
  target: "demo",
  workflow: { phaseOrder: ["visual"], phases: { visual: { status: "pending" } } },
  motionItems: [{ id: "belt", kind: "raf", status: "verified-sampled", declaredBy: "manual", scope: ".hero" }],
  artifacts: {},
});
ok(machineTerminalQuiet.capability === "layout" &&
  !(machineTerminalQuiet.advisories || []).some((note) => /--mode|review round|spec round|draft round/.test(note)),
  "a machine-terminal item releases routing with no reviewer-round suggestion — the machine receipt is the whole motion story");

console.log(failed ? `\n❌ capability-router-selftest: ${failed} assertion(s) failed.` : "\n✓ capability-router-selftest: all assertions pass.");
process.exit(failed ? 1 : 0);
