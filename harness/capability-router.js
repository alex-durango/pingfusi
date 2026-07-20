/**
 * capability-router.js — choose the utility that owns the next clone problem.
 *
 * Classification is deliberately conservative. Structured evidence (an explicit kind,
 * measured temporal fields, or a motion-items entry) wins over prose. Text is only a
 * fallback for older artifacts. An ambiguous issue never gets sent to a specialist on a
 * guess: it is returned as `unknown` with an inspect command.
 */
"use strict";

const path = require("path");
const {
  activeMotionItems,
  advisoryMotionCandidates,
  behaviorKeysOf,
  introspectedBindingFor,
  isDeclaredItem,
  isTerminalMotionItem,
  normalizeMotionItems,
  sampledTracksForItem,
} = require("./motion-items.js");

const DONE = new Set(["pass", "passed", "complete", "completed", "approved", "done", "exported"]);
const LAYOUT_PHASES = new Set(["visual", "coverage", "strict"]);
const ENVIRONMENT_PHASES = new Set(["target", "assets", "measure", "build", "review", "done"]);

const TEMPORAL_KEYS = new Set([
  "duration", "durationms", "delay", "delayms", "easing", "ease", "keyframes",
  "timeline", "timelineoffset", "pxpersec", "velocity", "stiffness", "damping",
  "mass", "settlems", "fps", "trajectory", "stagger", "staggerms", "raf",
]);

const TEMPORAL_TEXT = /\b(?:animat(?:e|ed|es|ing|ion)|timing|spring|easing|duration(?:ms)?|stagger(?:ed)?|scroll[- ]driven|scroll[- ]linked|pointer[- ]follow|requestanimationframe|raf|gsap|webgl|canvas|shader|keyframes?|tween|velocity|trajectory|frame rate|settle(?:d|s| time)?|pxpersec)\b/i;
const ENVIRONMENT_TEXT = /\b(?:missing|unreadable|corrupt|invalid json|hidden tab|background tab|browser|capture environment|cdp|viewport mismatch|network|permission|no chrome|artifact|404|timed out)\b/i;
const INTERACTION_TEXT = /\b(?:interaction|click|hover|focus|toggle|menu|open|close|reveal|state|active|visibility|display|form|submit|keyboard|pointer event)\b/i;
const LAYOUT_TEXT = /\b(?:layout|pixel|visual|paint|geometry|spacing|position|width|height|font|color|border|coverage|strict delta)\b/i;

function shellArg(value) {
  const s = String(value == null ? "" : value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

function textOf(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (typeof value === "object") return Object.entries(value).map(([k, v]) => `${k} ${textOf(v)}`).join(" ");
  return "";
}

function explicitCapability(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return null;
  if (/^(?:layout|visual|paint|pixel|geometry|style)$/.test(v)) return "layout";
  if (/^(?:interaction|state|state-change|navigation|form)$/.test(v)) return "interaction";
  if (/^(?:environment|mechanical|artifact|capture|setup|browser|network)$/.test(v)) return "environment";
  if (/^(?:motion|animation|temporal|spring|tween|timeline|scroll-driven|scroll-linked|pointer-follow|raf|gsap|webgl|canvas|shader|css-animation|css-transition|waapi)$/.test(v)) return "motion";
  return null;
}

function hasTemporalFields(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((v) => hasTemporalFields(v, seen));
  for (const [key, child] of Object.entries(value)) {
    if (TEMPORAL_KEYS.has(key.toLowerCase())) return true;
    if (hasTemporalFields(child, seen)) return true;
  }
  return false;
}

function behaviorEntries(artifacts) {
  const live = artifacts && artifacts.behaviorsLive;
  if (!live || typeof live !== "object") return [];
  const rows = [];
  for (const bucket of [live.behaviors, live.declared]) {
    if (!bucket || typeof bucket !== "object") continue;
    for (const [key, value] of Object.entries(bucket)) rows.push({ key, ...(value && typeof value === "object" ? value : { value }) });
  }
  return rows;
}

function behaviorEnvironmentProblem(evidence) {
  if (String(evidence.phase || "").toLowerCase() !== "behavior") return false;
  const artifacts = evidence.artifacts || {};
  const knowsLive = Object.prototype.hasOwnProperty.call(artifacts, "behaviorsLive");
  const knowsClone = Object.prototype.hasOwnProperty.call(artifacts, "behaviorsClone");
  const live = artifacts.behaviorsLive;
  const clone = artifacts.behaviorsClone;
  if ((knowsLive && !live) || (knowsClone && !clone)) return true;
  if ((live && live.unreadable) || (clone && clone.unreadable)) return true;
  if ((live && live.discovery && live.discovery.documentHidden === true) ||
      (clone && clone.discovery && clone.discovery.documentHidden === true)) return true;
  return /(?:captured while the tab was hidden|background tab|capture environment|no chrome|not valid json|no discovery pass metadata|behaviors-(?:live|clone)\.json missing)/i.test(String(evidence.reason || ""));
}

function motionRoute(evidence) {
  const behavior = evidence.behavior && typeof evidence.behavior === "object" ? evidence.behavior : {};
  const item = {
    status: evidence.status,
    kind: evidence.kind || behavior.kind,
    traceDir: evidence.traceDir,
    captureDir: evidence.captureDir,
    bundleDir: evidence.bundleDir,
    url: evidence.url,
    trigger: evidence.trigger || behavior.trigger,
    scope: evidence.scope || behavior.scope,
    ...(evidence.motionItem || {}),
  };
  const target = evidence.target || evidence.name || "<name>";
  const kind = String(item.kind || evidence.kind || "").toLowerCase();
  // bundleDir/traceDir/captureDir are DESTINATIONS recorded before any capture happens, so
  // their presence proves nothing; align with isTerminalMotionItem and default to pending.
  const status = String(item.status || "pending").toLowerCase();
  const trigger = item.trigger || evidence.trigger || "load";
  const url = item.url || evidence.url || (evidence.artifacts && evidence.artifacts.target && evidence.artifacts.target.url) || null;
  const lifecycle = item.id ? ` --target ${shellArg(target)} --item ${shellArg(item.id)}` : "";

  const bundleReady = new Set(["bundle-ready", "bundled", "review", "needs-review", "ready-for-review", "diagnose", "adjust"]).has(status);
  const traceReady = new Set(["trace-ready", "traced", "fit", "fitted"]).has(status);
  const captureReady = new Set(["capture-ready", "captured", "gate"]).has(status);
  const captureGated = new Set(["gated", "gate-passed", "replay-passed"]).has(status);
  const linkageOrRendered = /(?:webgl|canvas|shader|pointer-follow|scroll-driven|scroll-linked|scroll-linear)/.test(kind) ||
    /^scroll-through:/.test(String(trigger || ""));

  // Capture-ladder top rung (provenance-aware): an item bound to an introspected-*
  // motion-doc track is verified by KEYFRAME DIFF — the page's own engine declaration
  // read on both sides — never by trajectory re-fit and never by a review round. The
  // binding may already be recorded on the item, or is derived READ-ONLY here from the
  // live motion doc; sampled/fitted tiers carry no binding and fall through below.
  const motionDocArtifact = evidence.artifacts && evidence.artifacts.motionDoc;
  const liveMotionDoc = motionDocArtifact && typeof motionDocArtifact === "object" &&
    !motionDocArtifact.unreadable && Array.isArray(motionDocArtifact.tracks) ? motionDocArtifact : null;
  const introspectedBinding = item.introspectedBinding && item.introspectedBinding.docTrackId
    ? item.introspectedBinding
    : (liveMotionDoc && isDeclaredItem(item) ? introspectedBindingFor(item, liveMotionDoc) : null);
  if (introspectedBinding && item.id && !isTerminalMotionItem(item)) {
    return {
      capability: "motion",
      utility: "motion-verify-introspected",
      command: `pingfusi motion verify-introspected ${shellArg(target)} ${shellArg(item.id)}`,
      reason: `This item is bound to introspected track ${introspectedBinding.docTrackId} (provenance "introspected"): the live page's own engine declaration was read verbatim, so the exact keyframe/timing diff (±1ms duration/delay, ±0.01 numeric) is the whole gate — a matching diff terminates it as verified-introspected with no review round; a mismatch names the first differing keyframe.`,
    };
  }
  // Capture-ladder tier 3 (SAMPLED): an OWNED item whose motion evidence is sampled-tier
  // tracks (virtual-time samples of a page that declares nothing an introspection reader
  // can see) walks the machine chain sample → apply-sampled → verify-sampled. Determinism
  // is what makes the tier checkable: the identical virtual-time stimulus re-sampled
  // against the clone must match the live series frame-by-frame within the documented
  // tolerance, so no review round is spent. Provenance safety holds on every step — only
  // owned items route here; raw sweep rows stay advisory.
  if (item.id && isDeclaredItem(item) && !isTerminalMotionItem(item)) {
    if (status === "sampled") {
      return {
        capability: "motion",
        utility: "motion-apply-sampled",
        command: `pingfusi motion apply-sampled ${shellArg(target)} ${shellArg(item.id)}`,
        reason: "The item's sampled tracks are merged in motion-doc.json (tier \"sampled\"); replay them into the clone as the generated time-based WAAPI player (clone/motion-replay.js), then the sampled verify gate can diff both sides under the identical virtual-time stimulus.",
      };
    }
    if (status === "applied-sampled") {
      return {
        capability: "motion",
        utility: "motion-verify-sampled",
        command: `pingfusi motion verify-sampled ${shellArg(target)} ${shellArg(item.id)}`,
        reason: "The sampled replay is applied to the clone; re-sample the clone under the identical virtual-time stimulus (same fps/frames/trigger) and diff per frame (±1px translate, ±0.02 opacity) — a matching diff terminates the item as verified-sampled with no review round; a mismatch names the first offending track and frame.",
      };
    }
    if (status === "pending" && liveMotionDoc && sampledTracksForItem(item, liveMotionDoc).length) {
      return {
        capability: "motion",
        utility: "motion-sample",
        command: `pingfusi motion sample ${shellArg(target)} ${shellArg(item.id)}`,
        reason: "This declared item's motion evidence lives in sampled-tier tracks (no engine declaration to diff), but the item is not at a sampled checkpoint — re-acquire deterministic virtual-time samples so the apply/verify chain can walk it to verified-sampled.",
      };
    }
  }
  if (item.bundleDir && bundleReady) {
    // First-draft doctrine: no review rounds in the motion path. A convergence bundle is
    // a build artifact; preview it locally — the side-by-side compare tool is the one
    // reviewer channel, and it looks at the whole draft, not motion bundles.
    return {
      capability: "motion",
      utility: "motion-serve",
      command: `pingfusi motion serve ${shellArg(item.bundleDir)}`,
      reason: "A convergence bundle is ready; preview it locally. Motion checks are build receipts — nothing further is filed from a bundle.",
    };
  }
  if (item.traceDir && traceReady) {
    if (linkageOrRendered) {
      const out = item.libraryDir || path.posix.join(`targets/${target}/motion`, "library");
      return {
        capability: "motion",
        utility: "motion-export",
        command: `pingfusi motion export ${shellArg(item.traceDir)} --out ${shellArg(out)}${lifecycle}`,
        reason: "This trace is scroll/pointer-linked or rendered motion; export its fitted runtime, but keep the item active because the time-based DOM convergence loop cannot certify that linkage.",
      };
    }
    const out = item.bundleDir ? ` --out ${shellArg(item.bundleDir)}` : "";
    return {
      capability: "motion",
      utility: "motion-loop",
      command: `pingfusi motion loop ${shellArg(item.traceDir)}${out}${lifecycle}`,
      reason: "A fitted trace is available; build the motion convergence task from that temporal evidence.",
    };
  }
  if (item.captureDir && captureGated) {
    const out = item.libraryDir || path.posix.join(`targets/${target}/motion`, "library");
    return {
      capability: "motion",
      utility: "motion-export",
      command: `pingfusi motion export ${shellArg(item.captureDir)} --out ${shellArg(out)}${lifecycle}`,
      reason: "The verbatim animation replay gate passed; export that proven capture into the motion library.",
    };
  }
  if (item.captureDir && captureReady) {
    return {
      capability: "motion",
      utility: "motion-gate",
      command: `pingfusi motion gate ${shellArg(item.captureDir)}${lifecycle}`,
      reason: "A verbatim animation capture is available; replay-gate it with the motion engine.",
    };
  }

  // Unknown legacy statuses can still advance from the most-developed named artifact.
  // `pending` is intentionally excluded: its paths are destinations for the first capture.
  if (status !== "pending") {
    if (item.bundleDir) {
      return {
        capability: "motion",
        utility: "motion-serve",
        command: `pingfusi motion serve ${shellArg(item.bundleDir)}`,
        reason: `Motion status "${status}" is not canonical, but a bundle is named; preview it locally — motion checks are build receipts, no round is filed.`,
      };
    }
    if (item.traceDir) {
      if (linkageOrRendered) {
        const out = item.libraryDir || path.posix.join(`targets/${target}/motion`, "library");
        return {
          capability: "motion",
          utility: "motion-export",
          command: `pingfusi motion export ${shellArg(item.traceDir)} --out ${shellArg(out)}${lifecycle}`,
          reason: `Motion status "${status}" names a linkage/rendered trace; export its specialist fit instead of forcing it through the time-based DOM loop.`,
        };
      }
      const out = item.bundleDir ? ` --out ${shellArg(item.bundleDir)}` : "";
      return {
        capability: "motion",
        utility: "motion-loop",
        command: `pingfusi motion loop ${shellArg(item.traceDir)}${out}${lifecycle}`,
        reason: `Motion status "${status}" is not canonical, but a trace is named; rebuild its convergence task with the motion engine.`,
      };
    }
    if (item.captureDir) {
      return {
        capability: "motion",
        utility: "motion-gate",
        command: `pingfusi motion gate ${shellArg(item.captureDir)}${lifecycle}`,
        reason: `Motion status "${status}" is not canonical, but a capture is named; replay-gate it with the motion engine.`,
      };
    }
  }
  if (!url) {
    return {
      capability: "motion",
      utility: "motion-inspect",
      command: "pingfusi motion",
      reason: "Temporal evidence requires the motion engine, but no source URL or motion artifact path was supplied; inspect its usage and add the missing structured field.",
    };
  }

  const base = `targets/${target}/motion`;
  const verbatim = /(?:css|transition|keyframe|waapi)/.test(kind) && !/(?:spring|raf|gsap|webgl|canvas|shader|pointer)/.test(kind);
  if (verbatim) {
    const out = item.captureDir || path.posix.join(base, "capture");
    return {
      capability: "motion",
      utility: "motion-capture",
      command: `pingfusi motion capture ${shellArg(url)} --trigger ${shellArg(trigger)} --out ${shellArg(out)}${lifecycle}`,
      reason: "Structured animation-engine evidence identifies a verbatim CSS/WAAPI capture, so the motion capture utility owns it.",
    };
  }

  const out = item.traceDir || path.posix.join(base, "trace");
  // A GL trace is decided from structured evidence only (declared kind, or an explicit
  // gl flag on the item) — prose that merely mentions "canvas" must not add a GL capture.
  const gl = /(?:webgl|canvas|shader)/.test(kind) || item.gl === true ? " --gl" : "";
  const scope = item.scope ? ` --scope ${shellArg(item.scope)}` : "";
  return {
    capability: "motion",
    utility: "motion-trace",
    command: `pingfusi motion trace ${shellArg(url)} --trigger ${shellArg(trigger)} --out ${shellArg(out)}${scope}${gl}${lifecycle}`,
    reason: "Measured temporal behavior needs tracing and curve fitting from the motion engine, not a static comparison utility.",
  };
}

function layoutRoute(evidence) {
  const target = evidence.target || evidence.name || "<name>";
  const stalled = /^(?:failed|stalled|blocked)$/i.test(String(evidence.status || "")) || /\b(?:stalled|repeated|again)\b/i.test(String(evidence.reason || ""));
  if (stalled) {
    return {
      capability: "layout",
      utility: "side-by-side",
      command: `pingfusi assist ${shellArg(target)} --compare`,
      reason: "The layout evidence is stalled; the side-by-side diagnostic is scoped to visible placement and paint feedback.",
    };
  }
  const visual = evidence.phase === "visual" ? " --visual" : "";
  return {
    capability: "layout",
    utility: "pixel-diff",
    command: `pingfusi diff ${shellArg(`targets/${target}/live.json`)} ${shellArg(`targets/${target}/clone.json`)}${visual}`,
    reason: "Geometry and paint differences belong to the pixel-diff layout loop.",
  };
}

function interactionRoute(evidence) {
  const target = evidence.target || evidence.name || "<name>";
  return {
    capability: "interaction",
    utility: "behavior-capture",
    command: `pingfusi behavior-capture ${shellArg(target)}`,
    reason: "This is a state/trigger interaction without measured temporal evidence; capture both sides before choosing any specialist review.",
  };
}

function environmentRoute(evidence) {
  const target = evidence.target || evidence.name || "<name>";
  const phase = evidence.phase || null;
  const artifacts = evidence.artifacts || {};
  if (phase === "behavior" || /\b(?:hidden tab|background tab|capture environment|no chrome)\b/i.test(String(evidence.reason || ""))) {
    return {
      capability: "environment",
      utility: "behavior-capture",
      command: `pingfusi behavior-capture ${shellArg(target)}`,
      reason: "The blocker is capture/environment evidence, so reacquire trustworthy behavior artifacts before routing the issue.",
    };
  }
  if ((phase === "measure" || phase === "build") && (!artifacts.live || !artifacts.clone)) {
    return {
      capability: "environment",
      utility: "capture-run",
      command: `pingfusi capture-run ${shellArg(target)}`,
      reason: "Required live/clone artifacts are absent; the capture runner must establish evidence before comparison.",
    };
  }
  if (phase === "review") {
    return {
      capability: "environment",
      utility: "review-round",
      command: `pingfusi review ${shellArg(target)} file`,
      reason: "Machine gates have reached the review phase; file or inspect the recorded review round.",
    };
  }
  if (phase === "done") {
    return {
      capability: "environment",
      utility: "workflow",
      command: `pingfusi status ${shellArg(target)} --assert-done`,
      reason: "No specialist should be guessed at the terminal phase; re-verify the complete workflow ledger.",
    };
  }
  return {
    capability: "environment",
    utility: "workflow-gate",
    command: phase ? `pingfusi gate ${shellArg(target)} ${shellArg(phase)}` : `pingfusi status ${shellArg(target)}`,
    reason: "The next blocker is mechanical or environmental; inspect its objective gate before invoking a visual or motion specialist.",
  };
}

function unknownRoute(evidence) {
  const target = evidence.target || evidence.name || "<name>";
  return {
    capability: "unknown",
    utility: "inspect",
    command: `pingfusi status ${shellArg(target)}`,
    reason: "Evidence is not specific enough to choose layout, interaction, motion, or environment; inspect the workflow and clarify the issue first.",
  };
}

/**
 * Pure capability decision. Input is artifact/state data supplied by the caller; this
 * function performs no filesystem, process, clock, or network access.
 */
function routeCapability(evidence = {}) {
  const item = evidence.motionItem || null;
  const explicit = explicitCapability(evidence.capability) ||
    explicitCapability(item && item.capability) ||
    explicitCapability(item && item.kind) ||
    explicitCapability(evidence.kind);

  // Invalid capture conditions outrank the apparent motion kind: timing measured in a
  // hidden/background tab is environmental noise, not temporal evidence to fit.
  if (behaviorEnvironmentProblem(evidence)) return environmentRoute(evidence);

  if (explicit === "layout") return layoutRoute(evidence);
  if (explicit === "interaction") return interactionRoute(evidence);
  if (explicit === "environment") return environmentRoute(evidence);
  if (explicit === "motion") return motionRoute(evidence);

  // A row in motion-items.json is structured ownership even when an older row omitted kind.
  if (item) return motionRoute(evidence);
  if (evidence.traceDir || evidence.captureDir || evidence.bundleDir) return motionRoute(evidence);

  const rows = Array.isArray(evidence.behaviorRows) ? evidence.behaviorRows : behaviorEntries(evidence.artifacts || {});
  if (hasTemporalFields(evidence.metrics) || hasTemporalFields(evidence.behavior) || rows.some((row) => hasTemporalFields(row))) {
    return motionRoute({ ...evidence, behavior: evidence.behavior || rows[0] });
  }

  const phase = String(evidence.phase || "").toLowerCase();
  if (LAYOUT_PHASES.has(phase)) return layoutRoute(evidence);
  if (ENVIRONMENT_PHASES.has(phase)) return environmentRoute(evidence);

  // motionAdvisoryOnly marks evidence whose only temporal signals are undeclared sweep
  // candidates; those are quarantined to advisories, so temporal prose alone must not
  // dispatch the motion specialist here.
  const prose = [evidence.reason, evidence.hints, evidence.behavior, ...rows].map(textOf).join(" ");
  if (phase === "behavior") {
    if (!evidence.motionAdvisoryOnly && TEMPORAL_TEXT.test(prose)) return motionRoute({ ...evidence, behavior: evidence.behavior || rows[0] });
    if (behaviorEnvironmentProblem(evidence)) {
      return environmentRoute(evidence);
    }
    return interactionRoute(evidence);
  }

  if (!evidence.motionAdvisoryOnly && TEMPORAL_TEXT.test(prose)) return motionRoute(evidence);
  if (LAYOUT_TEXT.test(prose)) return layoutRoute(evidence);
  if (INTERACTION_TEXT.test(prose)) return interactionRoute(evidence);
  if (ENVIRONMENT_TEXT.test(prose)) return environmentRoute(evidence);
  return unknownRoute(evidence);
}

function scannableLive(live) {
  return !!(live && typeof live === "object" && !live.unreadable &&
    !(live.discovery && live.discovery.documentHidden === true));
}

// Unowned sweep candidates, split by whether an owning receipt claims the behavior key.
// Keys an owned item claims mean that owner's source evidence changed materially (its
// receipts are stale); every other candidate has no receipt at all. Both are
// INFORMATIONAL under the first-draft doctrine — notes, never routed steps.
function splitUnownedCandidates(live, rawItems) {
  const split = { declaredStale: [], advisory: [] };
  if (!scannableLive(live)) return split;
  let items;
  try { items = normalizeMotionItems(rawItems || []); } catch (_) { return split; }
  const declaredKeys = new Set(items.filter(isDeclaredItem).flatMap(behaviorKeysOf));
  for (const candidate of advisoryMotionCandidates(live, items)) {
    (declaredKeys.has(candidate.behaviorKey) ? split.declaredStale : split.advisory).push(candidate);
  }
  return split;
}

function quietSplitUnownedCandidates(live, rawItems) {
  try { return splitUnownedCandidates(live, rawItems); }
  catch (_) { return { declaredStale: [], advisory: [] }; } // the scan error surfaces as an advisory
}

// Motion findings are build receipts and warnings (first-draft doctrine): they ride along
// as informational advisories on whatever action routing chose — never a step the
// pipeline blocks on, never a review round.
function motionAdvisories(input) {
  const target = input.target || input.name || "<name>";
  const live = input.artifacts && input.artifacts.behaviorsLive;
  const rawItems = input.motionItems || (input.capabilities && input.capabilities.motionItems) || [];
  const notes = [];
  try {
    const split = splitUnownedCandidates(live, rawItems);
    for (const candidate of split.advisory) {
      notes.push(`sweep candidate ${candidate.behaviorKey} (${candidate.kind}, ${candidate.trigger}) has no motion receipt yet — informational only (motion checks are build receipts, never gates); evidence: targets/${target}/behaviors-live.json`);
    }
    for (const candidate of split.declaredStale) {
      notes.push(`motion receipts for ${candidate.behaviorKey} predate materially changed live evidence — informational; re-run the motion pass (pingfusi behavior-capture ${shellArg(target)}) to refresh the receipts`);
    }
  } catch (error) {
    notes.push(`behaviors-live.json cannot be scanned for motion candidates: ${error.message}`);
  }
  let items = [];
  try { items = normalizeMotionItems(rawItems); } catch (_) { return notes; }
  for (const item of activeMotionItems(items)) {
    if (isDeclaredItem(item)) continue;
    notes.push(`motion item ${item.id} has no green machine receipt — informational only; motion never blocks a gate`);
  }
  return notes;
}

function chooseNextAction(input = {}) {
  const target = input.target || input.name || "<name>";
  const live = input.artifacts && input.artifacts.behaviorsLive;
  const clone = input.artifacts && input.artifacts.behaviorsClone;
  const rawItems = input.motionItems || (input.capabilities && input.capabilities.motionItems);
  // Both halves of the unowned split are informational now (first-draft doctrine): a
  // receipt-less candidate AND an owned key whose receipts went stale are advisory notes,
  // so neither may steer capability selection into the motion engine below.
  const unownedSplit = quietSplitUnownedCandidates(live, rawItems);
  const advisoryKeys = new Set([...unownedSplit.advisory, ...unownedSplit.declaredStale].map((candidate) => candidate.behaviorKey));
  // Only owned items are routed machine work; a sweep-manufactured active item must not
  // preempt the pipeline (it stays an informational advisory).
  const motionItem = activeMotionItems(rawItems || []).find((item) => isDeclaredItem(item)) || null;
  if (motionItem) {
    const environmentEvidence = { target, phase: "behavior", artifacts: input.artifacts || {} };
    const sourceBacked = motionItem.sourceBehaviorKey || (Array.isArray(motionItem.sourceBehaviorKeys) && motionItem.sourceBehaviorKeys.length);
    if (sourceBacked && behaviorEnvironmentProblem(environmentEvidence)) {
      const route = environmentRoute(environmentEvidence);
      return { target, capability: route.capability, utility: route.utility, command: route.command, reason: route.reason };
    }
    const route = routeCapability({
      target,
      motionItem,
      kind: motionItem.kind,
      status: motionItem.status,
      url: motionItem.url || (input.artifacts && input.artifacts.target && input.artifacts.target.url) || (input.workflow && input.workflow.url),
      trigger: motionItem.trigger,
      artifacts: input.artifacts || {},
      reason: motionItem.reason,
    });
    return { target, capability: route.capability, utility: route.utility, command: route.command, reason: route.reason };
  }

  if ((live && (live.unreadable || (live.discovery && live.discovery.documentHidden === true))) ||
      (clone && (clone.unreadable || (clone.discovery && clone.discovery.documentHidden === true)))) {
    const route = environmentRoute({ target, phase: "behavior", artifacts: input.artifacts || {} });
    return { target, capability: route.capability, utility: route.utility, command: route.command, reason: route.reason };
  }

  const workflow = input.workflow;
  if (!workflow || typeof workflow !== "object" || !workflow.phases || typeof workflow.phases !== "object") {
    const route = unknownRoute({ target });
    return { target, capability: route.capability, utility: route.utility, command: route.command, reason: "workflow.json is missing or invalid; initialize or repair it before routing work." };
  }

  const order = Array.isArray(workflow.phaseOrder) && workflow.phaseOrder.length
    ? workflow.phaseOrder
    : Object.keys(workflow.phases);
  const phase = order.find((key) => {
    const state = workflow.phases[key];
    return !state || !DONE.has(String(state.status || "pending").toLowerCase());
  });

  if (!phase) {
    const route = environmentRoute({ target, phase: "done", artifacts: input.artifacts || {} });
    return { target, capability: route.capability, utility: route.utility, command: route.command, reason: "Every recorded phase passes; assert the terminal gate before declaring completion." };
  }

  const state = workflow.phases[phase] || {};
  const gate = input.gate && input.gate.phase === phase ? input.gate : null;
  if (gate && gate.ok) {
    return {
      target,
      capability: "environment",
      utility: "workflow-advance",
      command: `pingfusi advance ${shellArg(target)} ${shellArg(phase)}`,
      reason: `The live ${phase} gate already passes; record that objective result before routing any specialist work.`,
    };
  }
  const gateReason = gate && gate.reason ? gate.reason : null;
  // Rows the sweep alone put on the table are quarantined to advisory display: they must
  // not steer capability selection into the motion engine without a declared owner.
  const allRows = behaviorEntries(input.artifacts || {}).filter((row) => !advisoryKeys.has(row.key));
  const matchedRows = gateReason ? allRows.filter((row) => gateReason.includes(row.key)) : allRows;
  const behaviorRows = gateReason ? matchedRows : allRows;
  const behavior = behaviorRows[0] || null;
  const route = routeCapability({
    target,
    phase,
    status: state.status,
    kind: state.capability || state.issueKind,
    reason: gateReason || state.reason || state.failure || state.evidence,
    url: (input.artifacts && input.artifacts.target && input.artifacts.target.url) || workflow.url,
    behavior,
    behaviorRows,
    motionAdvisoryOnly: advisoryKeys.size > 0,
    artifacts: input.artifacts || {},
  });
  return { target, capability: route.capability, utility: route.utility, command: route.command, reason: route.reason };
}

/**
 * Pure next-action selector. The CLI supplies already-read JSON and artifact presence;
 * declared motion-items entries take precedence over the general workflow, while sweep-only
 * motion findings are attached as an optional `advisories` field — the stable five-field
 * action contract is unchanged when there is nothing to advise.
 */
function nextAction(input = {}) {
  const action = chooseNextAction(input);
  const advisories = motionAdvisories(input);
  return advisories.length ? { ...action, advisories } : action;
}

module.exports = {
  routeCapability,
  nextAction,
  shellArg,
};
