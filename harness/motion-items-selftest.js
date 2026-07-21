#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  activeMotionItems,
  advisoryMotionCandidates,
  bindIntrospectedItems,
  introspectedBindingFor,
  introspectedTracksForScope,
  isDeclaredItem,
  isTemporalBehaviorKey,
  isTerminalMotionItem,
  motionCandidatesFromSnapshot,
  motionReceiptForBehaviorRow,
  normalizeMotionItems,
  readMotionDoc,
  readMotionItems,
  sampledTracksForItem,
  syncMotionItemsFromBehaviors,
  unownedMotionCandidates,
  updateMotionItem,
} = require("./motion-items.js");
const motionDocApi = require("./motion-doc.js");
const motionVerify = require("./motion-verify.js");
const { assertMotionLifecycleBinding, finalMotionLifecyclePatch, motionLifecycleSpec } = require("./workflow.js");
const { meaningfulTransform, styleSweepEvidence, temporalEvidence } = require("../tools/behavior-capture.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-motion-items-"));
let failed = 0;
const ok = (condition, message) => {
  if (condition) console.log(`  ✓ ${message}`);
  else { failed++; console.log(`  ✗ ${message}`); }
};
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

console.log("motion-items-selftest — canonical specialist lifecycle");
ok(!meaningfulTransform("matrix(1, 0, 0, 1, 0, 0)") && meaningfulTransform("matrix(1, 0, 0, 1, 0, 20)"), "capture ignores identity matrices but retains meaningful transform start states");
const cssTemporal = temporalEvidence({
  animationName: "up-zoom", animationDuration: "750ms", animationDelay: "0s",
  animationTimingFunction: "ease-out", animationIterationCount: "1",
}, ["animation-name:up-zoom"]);
ok(cssTemporal && cssTemporal.candidate === "strong" && cssTemporal.kind === "css-animation" && cssTemporal.durationMs === 750 && cssTemporal.trigger === "load", "capture emits structured timing for a named nonzero CSS animation");
const scrollStart = { opacity: 1, transform: "matrix(1, 0, 0, 1, 0, 0)", filter: "none", visibility: "visible", display: "block" };
const reversibleSweep = styleSweepEvidence(scrollStart, [
  { atY: 0, snapshot: { ...scrollStart } },
  { atY: 500, snapshot: { ...scrollStart, transform: "matrix(1, 0, 0, 1, 0, -120)" } },
  { atY: 1000, snapshot: { ...scrollStart, opacity: 0.4, transform: "matrix(1, 0, 0, 1, 0, -240)" } },
], { ...scrollStart });
ok(reversibleSweep.changed && reversibleSweep.changedDuringSweep && reversibleSweep.returnedToStart && reversibleSweep.representative.atY === 1000 && reversibleSweep.maxChangedProperties === 2, "capture preserves the strongest in-sweep delta when reversible scroll motion returns to its start state");
ok(readMotionItems(root).items.length === 0, "an absent manifest is optional");
updateMotionItem(root, "hero", { kind: "spring", status: "review-pending", pingId: "p1" });
let manifest = readMotionItems(root);
ok(manifest.exists && manifest.items.length === 1 && manifest.items[0].id === "hero", "review state creates a canonical manifest item");
ok(activeMotionItems(manifest.raw).length === 1, "a pending legacy status reads as an open receipt (informational — nothing gates on it)");
updateMotionItem(root, "hero", { status: "done" });
manifest = readMotionItems(root);
ok(activeMotionItems(manifest.raw).length === 0 && manifest.items[0].kind === "spring", "convergence terminates the item without losing its metadata");
ok(activeMotionItems([
  { id: "exported-linked", status: "exported-needs-linked-review" },
  { id: "linked-bundle", status: "bundled" },
  { id: "candidate-fix", status: "needs-candidate-update" },
]).length === 3, "legacy linked-motion statuses all read as open receipts — advisory routing only, nothing gates");
ok(normalizeMotionItems({ intro: { status: "pending" } })[0].id === "intro", "legacy object maps normalize deterministically");
try {
  normalizeMotionItems([{ id: "dup" }, { id: "dup" }]);
  ok(false, "duplicate ids are rejected");
} catch (error) { ok(/duplicate/.test(error.message), "duplicate ids are rejected"); }

const autoDir = path.join(root, "auto");
const live = {
  url: "https://example.test/work",
  behaviors: {
    marquee: { kind: "marquee", trigger: "load", measured: { pxPerSec: 96 } },
    mutation: { kind: "observed-mutation", trigger: "mutation", measured: { after: { opacity: 0.4 } } },
  },
  declared: {
    "declared:img.hero": { hints: ["animation-name:up-zoom"], startState: { opacity: 1, transform: "none" } },
    "declared:div.dormant": { hints: ["transition-from-start-state", "will-change:transform"], startState: { opacity: 0, transform: "none" } },
  },
};
const candidates = motionCandidatesFromSnapshot(live);
ok(candidates.length === 2 && candidates.some((candidate) => candidate.behaviorKey === "declared:img.hero") && candidates.some((candidate) => candidate.behaviorKey === "marquee"), "classifier keeps named/measured motion and rejects a generic frame plus weak dormant markers");
ok(candidates.every((candidate) => /^auto-[a-z0-9-]+-[0-9a-f]{8}$/.test(candidate.suggestedId)), "every sweep candidate carries a stable safe suggested declare id");

ok(isDeclaredItem({ id: "m", declaredBy: "manual" }) && isDeclaredItem({ id: "r", declaredBy: "review-signal", source: "page-review" }) && isDeclaredItem({ id: "b", declaredBy: "from-behaviors", source: "behavior-capture" }), "declare provenance (manual, --from-review, --from-behaviors) counts as declared");
ok(!isDeclaredItem({ id: "a", source: "behavior-capture", status: "pending" }), "a sweep-manufactured legacy item stays advisory");
ok(!isDeclaredItem({ id: "p", status: "needs-declaration", source: "page-review" }) && !isDeclaredItem(null), "an undeclared review placeholder is not yet declared");
ok(isDeclaredItem({ id: "legacy", kind: "spring", status: "review-pending" }), "legacy items without sweep provenance count as owned (machine-chain routing only — nothing gates)");
ok(advisoryMotionCandidates(live, []).length === 2 && advisoryMotionCandidates(live, []).every((candidate) => candidate.suggestedId), "advisory candidates expose the unowned sweep analysis for suggestion display");

const dryRun = syncMotionItemsFromBehaviors(autoDir, live, { name: "demo", url: "https://canonical.test/work" });
ok(dryRun.created.length === 0 && dryRun.updated.length === 0 && dryRun.unowned.length === 2, "sweep reconciliation never creates manifest items; unowned candidates return as suggestions");
ok(!fs.existsSync(path.join(autoDir, "motion-items.json")), "reconciliation with nothing declared writes no manifest at all");

// Adopt both suggestions the way an explicit operator write (updateMotionItem with owner
// provenance) would — the machine chain routes only owned rows.
updateMotionItem(autoDir, "belt", { capability: "motion", kind: "marquee", trigger: "load", status: "pending", url: "https://canonical.test/work", sourceBehaviorKeys: ["marquee"], declaredBy: "manual", traceDir: "targets/demo/motion/belt/trace" });
updateMotionItem(autoDir, "hero-zoom", { capability: "motion", kind: "css-animation", trigger: "load", status: "pending", url: "https://canonical.test/work", sourceBehaviorKeys: ["declared:img.hero"], declaredBy: "manual", captureDir: "targets/demo/motion/hero-zoom/capture" });
const firstSync = syncMotionItemsFromBehaviors(autoDir, live, { name: "demo", url: "https://canonical.test/work" });
ok(firstSync.created.length === 0 && firstSync.unowned.length === 0 && firstSync.items.length === 2, "declared owners claim their candidates without any auto-created sibling");
ok(firstSync.items.every((item) => item.sourceBehaviorFingerprints && Object.keys(item.sourceBehaviorFingerprints).length === 1 && item.status === "pending"), "reconciliation establishes fingerprint baselines on declared owners without reopening them");
const ids = firstSync.items.map((item) => item.id).sort();
const secondSync = syncMotionItemsFromBehaviors(autoDir, live, { name: "demo", url: "https://canonical.test/work" });
ok(secondSync.created.length === 0 && secondSync.updated.length === 0 && secondSync.items.map((item) => item.id).sort().join("|") === ids.join("|"), "reconciliation is idempotent and does not touch owned rows");
updateMotionItem(autoDir, "hero-zoom", { status: "done" });
syncMotionItemsFromBehaviors(autoDir, live, { name: "demo", url: "https://canonical.test/work" });
ok(readMotionItems(autoDir).items.find((item) => item.id === "hero-zoom").status === "done", "recapture preserves a converged owner's lifecycle state");
ok(unownedMotionCandidates(live, readMotionItems(autoDir).items).length === 0, "terminal declared ownership still disposes its source behavior without recreating work");

const marqueeOwner = readMotionItems(autoDir).items.find((item) => item.sourceBehaviorKeys.includes("marquee"));
updateMotionItem(autoDir, marqueeOwner.id, { status: "done" });
const priorMarqueeFingerprint = readMotionItems(autoDir).items.find((item) => item.id === marqueeOwner.id).sourceBehaviorFingerprints.marquee;
const jitterLive = JSON.parse(JSON.stringify(live));
jitterLive.behaviors.marquee.measured = { pxPerSec: 96.1, from: -22.1, to: -118.2, sampledMs: 1001 };
const jitterSync = syncMotionItemsFromBehaviors(autoDir, jitterLive, { name: "demo", url: "https://canonical.test/work" });
ok(jitterSync.updated.length === 0 && readMotionItems(autoDir).items.find((item) => item.id === marqueeOwner.id).status === "done", "sub-percent speed and sample-phase jitter preserves a converged owner");
ok(readMotionItems(autoDir).items.find((item) => item.id === marqueeOwner.id).sourceBehaviorFingerprints.marquee === priorMarqueeFingerprint, "jitter-normalized evidence keeps the stored material fingerprint stable");
const changedLive = JSON.parse(JSON.stringify(live));
changedLive.behaviors.marquee.measured.pxPerSec = 144;
ok(unownedMotionCandidates(changedLive, readMotionItems(autoDir).items).some((row) => row.behaviorKey === "marquee"), "materially mismatched live evidence is unowned until its stored fingerprint is reconciled");
ok(unownedMotionCandidates(changedLive, [{
  id: "sink-owner", status: "pending", sourceArtifact: "interaction-sink.json", sourceBehaviorKeys: ["marquee"],
  sourceBehaviorFingerprints: { marquee: priorMarqueeFingerprint },
}]).some((row) => row.behaviorKey === "marquee"), "interactive or sink ownership cannot bypass a mismatched source fingerprint");
const changedSync = syncMotionItemsFromBehaviors(autoDir, changedLive, { name: "demo", url: "https://canonical.test/work" });
const reopenedMarquee = readMotionItems(autoDir).items.find((item) => item.id === marqueeOwner.id);
ok(changedSync.updated.includes(marqueeOwner.id) && reopenedMarquee.status === "pending", "a material temporal recapture reopens its existing terminal owner instead of accepting stale convergence");
ok(reopenedMarquee.sourceBehaviorFingerprints.marquee !== priorMarqueeFingerprint && unownedMotionCandidates(changedLive, readMotionItems(autoDir).items).length === 0, "reconciliation replaces the owned source fingerprint without manufacturing duplicate ownership");
const stableChangedSync = syncMotionItemsFromBehaviors(autoDir, changedLive, { name: "demo", url: "https://canonical.test/work" });
ok(stableChangedSync.updated.length === 0 && readMotionItems(autoDir).items.find((item) => item.id === marqueeOwner.id).status === "pending", "the reopened fingerprint is idempotent on an identical recapture");
const changedMechanism = JSON.parse(JSON.stringify(live));
changedMechanism.behaviors.marquee = {
  kind: "css-animation", trigger: "load", selector: "#real-belt", hints: ["animation-name:belt-shift"],
  temporal: { candidate: "strong", kind: "css-animation", trigger: "load", animationName: "belt-shift", durationMs: 900 },
};
const mechanismSync = syncMotionItemsFromBehaviors(autoDir, changedMechanism, { name: "demo", url: "https://canonical.test/work" });
const mechanismOwner = readMotionItems(autoDir).items.find((item) => item.id === marqueeOwner.id);
ok(mechanismSync.updated.includes(marqueeOwner.id) && mechanismOwner.kind === "css-animation" && mechanismOwner.captureDir && mechanismOwner.traceDir == null, "a changed mechanism reopens the same id and refreshes the utility-specific artifact destination");
ok(mechanismOwner.scope === "#real-belt", "same-id reconciliation refreshes the owner with the capture's actual selector");

const groupingDir = path.join(root, "grouping");
const groupingLive = {
  url: "https://example.test/groups",
  behaviors: {
    "marquee:left": { kind: "marquee", trigger: "load", selector: "#actual-left-belt", measured: { pxPerSec: 96 } },
    "marquee:right": { kind: "marquee", trigger: "load", measured: { pxPerSec: 96 } },
    "spring:card-a": { kind: "spring", trigger: "load", motionGroup: "shared-card-spring", measured: { durationMs: 480 } },
    "spring:card-b": { kind: "spring", trigger: "load", motionGroup: "shared-card-spring", measured: { durationMs: 480 } },
  },
  declared: {
    "declared:div.logo-a": { hints: ["animation-name:logo-rise"], temporal: { candidate: "strong", kind: "css-animation", trigger: "load", durationMs: 700 } },
    "declared:div.logo-b": { hints: ["animation-name:logo-rise"], temporal: { candidate: "strong", kind: "css-animation", trigger: "load", durationMs: 700 } },
  },
};
const groupedCandidates = motionCandidatesFromSnapshot(groupingLive);
const byKey = (key) => groupedCandidates.find((candidate) => candidate.behaviorKey === key);
ok(byKey("marquee:left").suggestedId !== byKey("marquee:right").suggestedId, "unrelated unnamed effects with the same kind and trigger suggest separate owners");
ok(byKey("marquee:left").scope === "#actual-left-belt" && byKey("marquee:right").scope == null, "capture preserves an actual selector but never fabricates one from a logical marquee name");
ok(byKey("declared:div.logo-a").suggestedId === byKey("declared:div.logo-b").suggestedId, "a genuinely shared named CSS animation suggests one shared owner id");
ok(byKey("spring:card-a").suggestedId === byKey("spring:card-b").suggestedId, "an explicit motion group intentionally suggests one shared owner id");
const grouped = syncMotionItemsFromBehaviors(groupingDir, groupingLive, { name: "groups" });
ok(grouped.created.length === 0 && grouped.unowned.length === 6 && !fs.existsSync(path.join(groupingDir, "motion-items.json")), "six sweep candidates yield six suggestions and zero auto-created items");
// First-draft doctrine: there is no declare ceremony. Unowned candidates remain
// receipt-less informational suggestions; nothing in this module manufactures owners.
ok(unownedMotionCandidates(groupingLive, grouped.items).length === 6, "unowned strong candidates stay informational — nothing auto-creates owning receipts");

const bareHover = { behaviors: { "menu:main": { kind: "transition", trigger: "hover", measured: { durationMs: 300 } } } };
try {
  motionCandidatesFromSnapshot(bareHover);
  ok(false, "a strong bare-hover trigger is an explicit error, not a silent load capture");
} catch (error) {
  ok(/hover:<selector>/.test(error.message) && /menu:main/.test(error.message), "a strong bare-hover trigger is an explicit error, not a silent load capture");
}
ok(motionCandidatesFromSnapshot({ behaviors: { m: { kind: "transition", trigger: "hover:.menu", measured: { durationMs: 300 } } } })[0].trigger === "hover:.menu", "a selector-qualified hover survives classification unchanged");
ok(motionCandidatesFromSnapshot({ behaviors: { m: { kind: "spring", trigger: "mutation", measured: { durationMs: 300 } } } })[0].trigger === "scroll-sweep", "the documented mutation-to-sweep stimulus mapping is preserved");
ok(motionCandidatesFromSnapshot({ behaviors: { menu: { kind: "hover-mount", trigger: "hover", measured: { changed: true } } } }).length === 0, "a weak hover-mount probe row never reaches trigger validation");

const managedTrace = motionLifecycleSpec([
  "trace", "https://example.test", "--scope", "#story .circle", "--out", "targets/demo/motion/trace",
  "--target", "demo", "--item", "circle",
]);
ok(managedTrace.target === "demo" && managedTrace.item === "circle" && managedTrace.patch.status === "traced" && managedTrace.patch.traceDir === "targets/demo/motion/trace", "managed trace maps an exit-0 command to the traced lifecycle receipt");
ok(!managedTrace.childArgs.includes("--target") && !managedTrace.childArgs.includes("--item") && managedTrace.childArgs.includes("--scope"), "wrapper-only lifecycle flags are stripped while motion-engine flags survive");
ok(assertMotionLifecycleBinding(managedTrace, {
  id: "circle", url: "https://example.test", traceDir: "targets/demo/motion/trace",
}), "managed trace evidence binds to the declared source URL and trace output path");
try {
  assertMotionLifecycleBinding(managedTrace, {
    id: "circle", url: "https://example.test", traceDir: "targets/demo/motion/someone-elses-trace",
  });
  ok(false, "managed trace rejects an unrelated output path");
} catch (error) { ok(/output path/.test(error.message), "managed trace rejects an unrelated output path"); }
const managedExport = motionLifecycleSpec(["export", "targets/demo/motion/trace", "--out", "targets/demo/motion/library", "--target", "demo", "--item", "circle"]);
ok(managedExport.patch.status === "exported" && managedExport.patch.libraryDir.endsWith("/library"), "managed export first records the emitted library path");
ok(assertMotionLifecycleBinding(managedExport, {
  id: "circle", traceDir: "targets/demo/motion/trace", libraryDir: "targets/demo/motion/library",
}), "terminal export binds both its input evidence and declared library destination");
const linkedExportPatch = finalMotionLifecyclePatch(managedExport, {
  id: "circle", traceDir: "targets/demo/motion/trace", libraryDir: "targets/demo/motion/library",
  bundleDir: "targets/demo/motion/stale-bundle",
});
ok(linkedExportPatch.status === "exported" && !linkedExportPatch.reviewConstraint, "a fitted trace export is a terminal machine receipt — no review round is left to park it for");
ok(linkedExportPatch.bundleDir === null && linkedExportPatch.bundleKind === null, "a fresh trace export still invalidates the stale bundle receipt");
ok(finalMotionLifecyclePatch(motionLifecycleSpec(["export", "targets/demo/motion/capture", "--out", "targets/demo/motion/library", "--target", "demo", "--item", "circle"]), {
  id: "circle", captureDir: "targets/demo/motion/capture", libraryDir: "targets/demo/motion/library",
}).status === "exported", "a verbatim capture export remains terminal after its replay gate");
try {
  assertMotionLifecycleBinding(managedExport, {
    id: "circle", traceDir: "targets/demo/motion/unrelated-trace", libraryDir: "targets/demo/motion/library",
  });
  ok(false, "terminal export rejects unrelated input evidence");
} catch (error) { ok(/input path/.test(error.message), "terminal export rejects unrelated input evidence"); }
try {
  motionLifecycleSpec(["trace", "https://example.test", "--target", "../escape", "--item", "circle"]);
  ok(false, "managed target traversal is rejected");
} catch (error) { ok(/not a path/.test(error.message), "managed target traversal is rejected"); }
try {
  motionLifecycleSpec(["trace", "https://example.test", "--target", "demo"]);
  ok(false, "partial lifecycle identity is rejected");
} catch (error) { ok(/supplied together/.test(error.message), "partial lifecycle identity is rejected"); }

// ── capture ladder: introspected provenance binding + the exact-diff gate ────────────────
ok(isTerminalMotionItem({ id: "x", status: "verified-introspected" }) &&
  activeMotionItems([{ id: "x", status: "verified-introspected" }]).length === 0,
  "verified-introspected is a terminal machine-verified status honored by active/done gates");
ok(isTerminalMotionItem({ id: "x", status: "verified-sampled" }) &&
  activeMotionItems([{ id: "x", status: "verified-sampled" }]).length === 0,
  "verified-sampled is a terminal machine-verified status honored by active/done gates");
ok(!isTerminalMotionItem({ id: "x", status: "sampled" }) && !isTerminalMotionItem({ id: "x", status: "applied-sampled" }) &&
  activeMotionItems([{ id: "a", status: "sampled" }, { id: "b", status: "applied-sampled" }]).length === 2,
  "sampled and applied-sampled are NON-terminal checkpoints — the item stays enforced until verify-sampled exits 0");

// ── capture ladder tier 3: the sampled-track binding helper ──────────────────────────────
{
  const sampledDoc = motionDocApi.emptyDoc({ url: "https://example.test", capturedAt: "2026-07-18T00:00:00.000Z" });
  const mkSampled = (selector, property, value) => motionDocApi.addTrack(sampledDoc, {
    target: { selector }, property,
    keyframes: [{ offset: 0, value }, { offset: 1, value: `${value} ` }],
    timing: { duration_ms: 100, delay_ms: 0, iterations: 1, direction: "normal", fill: "both" },
    timeline: { type: "document" },
    provenance: { tier: "sampled", source: "virtual-time@50fps" },
  });
  const heroTx = mkSampled(".hero", "transform", "matrix(1, 0, 0, 1, 10, 0)");
  const heroOp = mkSampled(".hero", "opacity", "0.5");
  const beltTx = mkSampled("#belt", "transform", "matrix(1, 0, 0, 1, 5, 0)");
  motionDocApi.addTrack(sampledDoc, {
    target: { selector: ".hero" }, property: "opacity",
    keyframes: [{ offset: 0, value: "0" }, { offset: 1, value: "1" }],
    timing: { duration_ms: 400, delay_ms: 0, iterations: 1, direction: "normal", fill: "both" },
    timeline: { type: "document" },
    provenance: { tier: "fitted", source: "fit:tween" },
    fit: { kind: "tween", params: {}, nrmse: 0.02 },
  });
  const byIds = sampledTracksForItem({ id: "m", sampledTrackIds: [heroTx.id, beltTx.id] }, sampledDoc);
  ok(byIds.length === 2 && byIds.some((t) => t.id === heroTx.id) && byIds.some((t) => t.id === beltTx.id),
    "the sampler's recorded sampledTrackIds are the authoritative sampled-track binding");
  const byScope = sampledTracksForItem({ id: "m", scope: ".hero" }, sampledDoc);
  ok(byScope.length === 2 && byScope.some((t) => t.id === heroTx.id) && byScope.some((t) => t.id === heroOp.id) &&
    !byScope.some((t) => t.provenance.tier !== "sampled"),
    "the scope fallback matches exact trimmed selectors and returns ONLY sampled-tier tracks — fitted/introspected keep their own paths");
  ok(sampledTracksForItem({ id: "m", scope: "#nothing" }, sampledDoc).length === 0 &&
    sampledTracksForItem({ id: "m" }, sampledDoc).length === 0 &&
    sampledTracksForItem({ id: "m", scope: ".hero" }, null).length === 0,
    "no scope, no matching selector, or no doc is a silent empty binding, never an error");
}

const ladderDir = path.join(root, "ladder");
ok(readMotionDoc(ladderDir).exists === false && readMotionDoc(ladderDir).doc === null, "an absent motion doc is a silent no-binding, never an error");
fs.mkdirSync(ladderDir, { recursive: true });
fs.writeFileSync(path.join(ladderDir, "motion-doc.json"), "{ not json");
ok(readMotionDoc(ladderDir).exists === true && readMotionDoc(ladderDir).doc === null, "a corrupt motion doc is quarantined to doc:null instead of throwing");

const ladderDoc = motionDocApi.fromIntrospection([{
  type: "CSSAnimation",
  animationName: "belt-shift",
  selector: "#belt .strip",
  keyframes: [
    { offset: 0, easing: "linear", transform: "translateX(0px)" },
    { offset: 1, transform: "translateX(-2125px)" },
  ],
  timing: { duration: 12000, delay: 0, iterations: "infinite", direction: "normal", fill: "both" },
}], { url: "https://example.test", capturedAt: "2026-07-18T00:00:00.000Z", viewport: { width: 1512, height: 900, dpr: 2 } });
fs.writeFileSync(path.join(ladderDir, "motion-doc.json"), JSON.stringify(ladderDoc, null, 2));
const beltTrack = ladderDoc.tracks[0];
ok(introspectedTracksForScope(ladderDoc, "#belt .strip").length === 1 && introspectedTracksForScope(ladderDoc, "#other").length === 0, "scope-to-track matching is an exact trimmed selector match");
const beltBinding = introspectedBindingFor({ id: "belt-css", scope: "#belt .strip" }, ladderDoc);
ok(beltBinding && beltBinding.provenance === "introspected" && beltBinding.docTrackId === beltTrack.id &&
  beltBinding.trackFingerprint === motionDocApi.trackFingerprint(beltTrack),
  "a scope matching an introspected track binds with docTrackId + trackFingerprint under provenance introspected");
ok(introspectedBindingFor({ id: "no-scope" }, ladderDoc) === null, "an item without a scope never binds");
const fittedDoc = motionDocApi.emptyDoc({ url: "https://example.test", capturedAt: "2026-07-18T00:00:00.000Z" });
motionDocApi.addTrack(fittedDoc, {
  target: { selector: "#belt .strip" }, property: "opacity",
  keyframes: [{ offset: 0, value: "0" }, { offset: 1, value: "1" }],
  timing: { duration_ms: 400, delay_ms: 0, iterations: 1, direction: "normal", fill: "both" },
  timeline: { type: "document" },
  provenance: { tier: "fitted", source: "fit:tween" },
  fit: { kind: "tween", params: {}, nrmse: 0.02 },
});
ok(introspectedBindingFor({ id: "belt-css", scope: "#belt .strip" }, fittedDoc) === null, "a fitted-tier track never binds — introspected binding is exact-diff provenance only; fitted stays receipt-only");

updateMotionItem(ladderDir, "belt-css", { kind: "css-animation", trigger: "load", status: "pending", scope: "#belt .strip", declaredBy: "manual" });
updateMotionItem(ladderDir, "sweep-belt", { kind: "marquee", trigger: "load", status: "pending", scope: "#belt .strip", source: "behavior-capture" });
const boundResult = bindIntrospectedItems(ladderDir);
const boundBelt = readMotionItems(ladderDir).items.find((item) => item.id === "belt-css");
const unboundSweep = readMotionItems(ladderDir).items.find((item) => item.id === "sweep-belt");
ok(boundResult.bound.includes("belt-css") && boundBelt.introspectedBinding && boundBelt.introspectedBinding.docTrackId === beltTrack.id, "binding is recorded on the declared item");
ok(!boundResult.bound.includes("sweep-belt") && !unboundSweep.introspectedBinding, "a sweep-manufactured undeclared item never binds — quarantine holds");
ok(bindIntrospectedItems(ladderDir).bound.length === 0, "re-binding an unchanged doc is idempotent");

const ladderDeclareDir = path.join(root, "ladder-declare");
fs.mkdirSync(ladderDeclareDir, { recursive: true });
fs.writeFileSync(path.join(ladderDeclareDir, "motion-doc.json"), JSON.stringify(ladderDoc, null, 2));
const ladderLive = {
  behaviors: {
    belt: {
      kind: "css-animation", trigger: "load", selector: "#belt .strip", hints: ["animation-name:belt-shift"],
      temporal: { candidate: "strong", kind: "css-animation", trigger: "load", animationName: "belt-shift", durationMs: 12000 },
    },
  },
};
updateMotionItem(ladderDeclareDir, "belt-owner", { kind: "css-animation", trigger: "load", status: "pending", scope: "#belt .strip", sourceBehaviorKeys: ["belt"] });
const ladderSync = syncMotionItemsFromBehaviors(ladderDeclareDir, ladderLive, { name: "ladder" });
const declaredBound = ladderSync.items.find((item) => item.id === "belt-owner");
ok(declaredBound.introspectedBinding &&
  declaredBound.introspectedBinding.docTrackId === beltTrack.id && declaredBound.introspectedBinding.provenance === "introspected",
  "sync-time reconciliation records the introspected binding on the owning receipt");

// The pure exact-diff core (harness/motion-verify.js): fixture tracks, no browser.
ok(JSON.stringify(motionVerify.normalizedOffsets([{ offset: null }, { offset: null }, { offset: null }])) === "[0,0.5,1]" &&
  JSON.stringify(motionVerify.normalizedOffsets([{ offset: null }])) === "[1]",
  "null keyframe offsets normalize with the WAAPI distribution before comparison");
const cloneExact = {
  id: "clone-belt", target: { selector: "#belt .strip" }, property: "transform",
  keyframes: [
    { offset: null, value: "translateX(0px)", easing: "cubic-bezier(0, 0, 1, 1)" },
    { offset: 1, value: "translateX(-2125.004px)" },
  ],
  timing: { duration_ms: 12000.9, delay_ms: 0, iterations: "infinite", direction: "normal", fill: "both" },
  timeline: { type: "document" },
  provenance: { tier: "introspected-waapi" },
};
ok(motionVerify.diffIntrospectedTrack(beltTrack, cloneExact).length === 0, "sub-tolerance float spelling, a keyword-vs-bezier easing, and a null offset all normalize to an exact match");
const cloneDocExact = { schema: motionDocApi.SCHEMA_ID, url: null, capturedAt: null, viewport: null, tracks: [cloneExact], assets: [] };
const exactVerdict = motionVerify.verifyIntrospectedScope(ladderDoc, cloneDocExact, "#belt .strip");
ok(exactVerdict.ok && exactVerdict.tracks.length === 1 && exactVerdict.tracks[0].docTrackId === beltTrack.id && exactVerdict.firstMismatch === null,
  "an exactly matching clone declaration verifies even through a different introspected engine tier");
const cloneWrongValue = JSON.parse(JSON.stringify(cloneExact));
cloneWrongValue.keyframes[1].value = "translateX(-1000px)";
const wrongValueMisses = motionVerify.diffIntrospectedTrack(beltTrack, cloneWrongValue);
ok(wrongValueMisses.length === 1 && /keyframes\[1\]\.value/.test(wrongValueMisses[0]) && /-2125/.test(wrongValueMisses[0]) && /-1000/.test(wrongValueMisses[0]),
  "a wrong keyframe value is named with both sides, first differing keyframe first");
const cloneSlow = JSON.parse(JSON.stringify(cloneExact));
cloneSlow.timing.duration_ms = 12005;
ok(motionVerify.diffIntrospectedTrack(beltTrack, cloneSlow).some((miss) => /timing\.duration_ms/.test(miss) && /±1ms/.test(miss)),
  "a 5ms duration drift is outside the documented ±1ms tolerance");
const missingVerdict = motionVerify.verifyIntrospectedScope(ladderDoc, { tracks: [] }, "#belt .strip");
ok(!missingVerdict.ok && /no introspected "transform" track on the clone/.test(missingVerdict.firstMismatch),
  "an undeclared clone animation fails with the declaration requirement named");
ok(!motionVerify.verifyIntrospectedScope(ladderDoc, cloneDocExact, "#nothing-here").ok, "an empty binding scope can never verify green");

// ── first-draft bookkeeping: statuses are receipts, terminal or not, never gates ─────────
ok(isTerminalMotionItem({ id: "x", status: "approved" }) && isTerminalMotionItem({ id: "x", status: "exported" }),
  "legacy terminal statuses stay closed receipts");
ok(!isTerminalMotionItem({ id: "x", status: "needs-fix" }) && !isTerminalMotionItem({ id: "x", status: "edited-applied" }),
  "unknown/legacy non-terminal statuses read as open receipts (informational only — nothing gates on them)");

// ── behavior-gate receipt lookup: temporal-row classification + receipt matching ─────────
ok(isTemporalBehaviorKey("reveal:div.hero") && isTemporalBehaviorKey("mutation:div.ticker") && isTemporalBehaviorKey("startup:#loader"),
  "reveal:/mutation:/startup: rows classify as temporal (the motion pass's jurisdiction)");
ok(!isTemporalBehaviorKey("hover:nav") && !isTemporalBehaviorKey("marquee:belt") && !isTemporalBehaviorKey("generative:webgl_bg") && !isTemporalBehaviorKey(null),
  "interaction/state and measured-inventory prefixes stay out of the temporal class");
{
  const passItem = { id: "pass-css-12345678", selector: "div.fade-up", scope: "div.fade-up", tier: "introspected-css", action: "css-inherited", verify: "pass", source: "motion-pass", status: "pass" };
  const lineageItem = { id: "owned-loader", kind: "raf", status: "pass", sourceBehaviorKeys: ["startup:#loader"] };
  const doc = { schema: "doc", tracks: [{ id: "trk-ticker", target: { selector: "div.ticker" }, provenance: { tier: "sampled" } }] };
  const bySelector = motionReceiptForBehaviorRow("reveal:div.fade-up", { selector: "div.fade-up" }, [passItem, lineageItem], doc);
  ok(bySelector && bySelector.via === "selector" && bySelector.id === "pass-css-12345678",
    "a pass-written @2 item matching the row's element selector is a motion receipt");
  const byLineage = motionReceiptForBehaviorRow("startup:#loader", { selector: "#loader" }, [passItem, lineageItem], doc);
  ok(byLineage && byLineage.via === "behavior-key" && byLineage.id === "owned-loader",
    "behavior-key lineage on an item is a motion receipt regardless of selector spelling");
  const byTrack = motionReceiptForBehaviorRow("mutation:div.ticker", {}, [passItem, lineageItem], doc);
  ok(byTrack && byTrack.via === "doc-track" && byTrack.id === "trk-ticker",
    "a motion-doc track for the key-derived selector is a motion receipt (players are generated from these tracks)");
  ok(motionReceiptForBehaviorRow("reveal:hero_heading", {}, [passItem, lineageItem], doc) === null,
    "a logical probe name never invents a selector — no receipt without a real element match");
  ok(motionReceiptForBehaviorRow("reveal:div.fade-up", { selector: "div.fade-up" }, [{ bad: "item" }], null) === null,
    "an unreadable manifest degrades to no-receipt, never a throw (the gate stays runnable)");
}

console.log(failed ? `\n❌ motion-items-selftest: ${failed} assertion(s) failed.` : "\n✓ motion-items-selftest: all assertions pass.");
process.exit(failed ? 1 : 0);
