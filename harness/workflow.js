#!/usr/bin/env node
/**
 * workflow.js — the `pingfusi` enforced-workflow state machine (the kit's `gjc`).
 *
 * WHY THIS EXISTS
 * The kit already had the *verification primitive* (pixel-diff.js exits 0 or 1) and
 * the *method* (PLAYBOOK phases 0–7). What it did NOT have was ENFORCEMENT: nothing
 * stopped an agent from skipping Phase 5b coverage, hand-waving a strict delta, or
 * declaring "pixel-perfect" without ever running the gate. The PLAYBOOK was prose the
 * agent was *asked* to follow.
 *
 * This turns the documented phases into a hard-gated state machine — the same shape as
 * gajae-code's `gjc` (deep-interview → ralplan → ultragoal), reimplemented natively with
 * zero dependencies. Each phase has an OBJECTIVE gate: a check that must exit 0 before the
 * phase can be marked done, and phases must complete IN ORDER. A phase you can't machine-
 * check (e.g. "assets are real, not hand-drawn") is recorded as an ATTESTATION with
 * evidence and flagged as such — honest about what's proven vs. asserted.
 *
 * Every advance appends a receipt to targets/<name>/workflow.jsonl (ts, phase, runId,
 * sha256 of the artifact, gate result, evidence) — a durable audit trail, like gjc's
 * index.jsonl. State lives in targets/<name>/workflow.json.
 *
 * The rule the whole kit is built on holds here too:
 *   A phase is done because its gate exited 0 — never because prose says so.
 *
 * USAGE
 *   node harness/workflow.js init    <name> [url] [width]   # seed state (new-target.js calls this)
 *   node harness/workflow.js status  <name>                 # phase table + the next required action
 *   node harness/workflow.js gate    <name> <phase>         # run ONE gate read-only (exit 0/1) — no state change
 *   node harness/workflow.js advance <name> <phase> [--evidence "..."] [--force] [--blocked "..."]
 *   node harness/workflow.js assist  <name> [--compare]     # STALLED? reviewer ask composed from the failing gate (delegates to review-qa.js)
 *   node harness/workflow.js ledger  <name>                 # print the audit trail
 *
 * `advance` refuses if (a) an earlier phase isn't done, or (b) the gate fails — unless
 * --force is passed, which records forced:true in the receipt (an escape hatch that is
 * itself auditable, like gjc's force override). `--blocked "reason"` is the OTHER receipted
 * escape: an environment constraint the gate's own named remedy couldn't fix (recorded as
 * blocked:true; review can then be filed with the gap documented; done refuses it until the
 * phase is re-advanced with a passing gate). Three consecutive gate-failure refusals on one
 * phase print a STALLED hint pointing at `assist` — derived from the ledger, never stored.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { diffSnapshots } = require("../tools/pixel-diff.js");

// PKG = where the kit is installed (its own tools/docs/harness live here, read-only when
// installed globally). WORK = the user's current directory, where their clone `targets/`
// are created. In the kit's own repo the two are the same, so the DEVELOP meta-loop is
// unchanged; installed globally, PKG is node_modules/... and WORK is the user's project.
const PKG = path.resolve(__dirname, "..");
const WORK = process.cwd();
// How to spell this tool in printed guidance so the hint is RUNNABLE in the invoking context:
// `pingfusi` when launched via the installed bin (or a pingfusi delegate), `node harness/workflow.js`
// when someone in the repo ran this script directly.
const VIA_PPK = process.env.PPK_ENTRY === "1" || /(^|\/)pingfusi$/.test(process.argv[1] || "");
const CMD = VIA_PPK ? "pingfusi" : "node harness/workflow.js";
const targetDir = (name) => path.join(WORK, "targets", name);
const statePath = (name) => path.join(targetDir(name), "workflow.json");
const ledgerPath = (name) => path.join(targetDir(name), "workflow.jsonl");

// ── small helpers ────────────────────────────────────────────────────────────
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const exists = (p) => fs.existsSync(p);
// Hash a file's bytes, or — for a directory — every file's relative name AND contents in
// sorted order. Names alone would let a same-named swap (fake woff2 over the validated one)
// keep the receipt hash identical, so the ledger wouldn't actually pin what was verified.
function sha256OfFile(p) {
  if (!exists(p)) return null;
  const h = crypto.createHash("sha256");
  if (fs.statSync(p).isDirectory()) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp);
        else { h.update(path.relative(p, fp)); h.update(fs.readFileSync(fp)); }
      }
    };
    walk(p);
  } else {
    h.update(fs.readFileSync(p));
  }
  return h.digest("hex").slice(0, 16);
}
const runId = () => crypto.randomBytes(5).toString("hex");

// ── stall detection ──────────────────────────────────────────────────────────
// STALL_AFTER: consecutive failed advances on the SAME phase before the kit says
// "stop iterating blind, ask a reviewer". Rationale: the run history shows the misses that
// burn rounds (an underline wrong three ways in a row, four rounds on one camera intro, 93
// visual fails chasing a font) are mechanisms a reviewer names in ONE look (~$0.05 poll) —
// while two failures are still normal fix-loop turnaround. Three failures with no reviewer
// input in between is the earliest point where the poll is cheaper than the next blind try.
const STALL_AFTER = 3;
// The streak is DERIVED from the append-only ledger — no new mutable state to corrupt or
// migrate. Walk workflow.jsonl from the tail: gate-failure refusals for this phase count;
// a recorded advance (earned or forced), a reset, or reviewer input (an `assist` receipt,
// review-qa.js appends it when an assist is FILED) terminates the streak; everything else
// (other phases, out-of-order refusals) is neutral — re-advancing `measure` mid-flail must
// not launder a `visual` streak.
function stallInfo(name, phaseKey) {
  const p = ledgerPath(name);
  if (!exists(p)) return { fails: 0 };
  let lines;
  try { lines = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean); } catch (e) { return { fails: 0 }; }
  let fails = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    let r; try { r = JSON.parse(lines[i]); } catch (e) { continue; }
    if (r.event === "reset" || r.event === "assist") break;
    if (r.phase !== phaseKey) continue;
    if (r.gate === "refused") {
      if (/^gate failed for /.test(r.reason || "")) fails++;
      continue; // ordering/evidence refusals are neutral — they aren't fix-loop iterations
    }
    if (r.gate === "pass" || r.gate === "failed") break; // a recorded advance ends the streak
  }
  return { fails };
}
// One line, printed by status/gate/advance wherever a stalled phase surfaces — the hint is
// advisory (nothing blocks), so it must be loud and RUNNABLE everywhere the agent looks.
const stallHint = (name, fails) =>
  `⚠ STALLED — ${fails} consecutive failed advances with no reviewer input. A reviewer often names the mechanism in one look (~$0.05): ${CMD} assist ${name}   (side-by-side: ${CMD} assist ${name} --compare)`;

// A gate returns { ok, reason, artifact? }. `ok:true` means the phase may be marked done.
// `artifact` (a file path) is hashed into the receipt as evidence of WHAT was verified.

// ── behavior gate — compares behaviors-live.json vs behaviors-clone.json ────────────────
// Ported from lovable_dupe_html/CLONE_PLAYBOOK.md §8/§8a: static candidates + a dynamic
// differential pass on live are AUTHORITATIVE for what's a real behavior; reproduction in
// clone/fixes.js is judged by MEASURED values, never presence alone (a marquee that exists
// but runs at 2x speed is not "reproduced").
//
// TOLERANCES (documented here, and in the failure messages, same as pixel-diff's 0.5px):
//   - pxPerSec (marquee/scroll speed): ±15% relative. Rationale: two independent 1-second
//     samples of a CSS transition/rAF-driven animation carry timer/paint-scheduling jitter
//     (observed ~3-8% on a quiet machine); 15% comfortably absorbs that noise while a
//     genuinely wrong speed (a common miss is exactly 2x or 0.5x, from copying the wrong
//     keyframe duration or belt width) still fails by a wide margin.
//   - durationMs / settle timings: ±25% relative, floor 150ms absolute. Rationale: wall-clock
//     durations for reveals/typewriters are measured across a network+paint round-trip on
//     BOTH captures, so they carry more jitter than a same-machine transform sample; a floor
//     avoids flagging noise on very short (<600ms) transitions where 25% would be under a
//     frame's worth of time.
//   - opacity: ±0.05 absolute (a fully-revealed 1.0 vs a stuck 0.92 is a real miss; 0.05
//     absorbs float rounding across engines).
//   - transform / filter / trigger / kind: exact string match. These aren't measurements
//     with sampling noise — a live end-state of `translateX(-2125px)` reproduced as
//     `translateX(-1000px)` is simply wrong, and `trigger` describes the reproduction
//     TECHNIQUE (scroll vs hover vs load), which the playbook says must match, not just land
//     on the right pixels by accident.
const BEHAVIOR_TOL = { pxPerSecRelative: 0.15, durationRelative: 0.25, durationFloorMs: 150, opacityAbs: 0.05, transformTranslatePx: 0.5, transformLinearAbs: 0.001 };

function relWithin(live, clone, relTol, floor) {
  if (typeof live !== "number" || typeof clone !== "number" || !isFinite(live) || !isFinite(clone)) return live === clone;
  const tol = Math.max(Math.abs(live) * relTol, floor || 0);
  return Math.abs(live - clone) <= tol;
}

// getComputedStyle normalizes `transform` to none|matrix(...)|matrix3d(...), and the matrix
// TRANSLATION components inherit layout subpixel rounding — exact string equality would flake
// on jitter the pixel gate itself tolerates. Compare matrices numerically: 0.5px on the
// translation part (mirroring --visual's tolerance), 0.001 absolute on the linear part
// (scale/rotate/skew aren't layout-rounded). Anything non-matrix compares exact.
function transformsMatch(a, b) {
  if (a === b) return true;
  const pa = /^matrix(3d)?\(([^)]+)\)$/.exec(a || ""), pb = /^matrix(3d)?\(([^)]+)\)$/.exec(b || "");
  if (!pa || !pb || pa[1] !== pb[1]) return false;
  const na = pa[2].split(",").map(Number), nb = pb[2].split(",").map(Number);
  if (na.length !== nb.length || na.some(isNaN) || nb.some(isNaN)) return false;
  const isTranslate = (i) => (pa[1] ? i >= 12 && i <= 14 : i >= 4);
  return na.every((v, i) => Math.abs(v - nb[i]) <= (isTranslate(i) ? BEHAVIOR_TOL.transformTranslatePx : BEHAVIOR_TOL.transformLinearAbs));
}

// Compare one behavior's `measured` block. Returns { ok, detail } — detail names the exact
// field(s) that missed and by how much, so a failure is actionable, not "values differ".
function compareMeasured(key, kind, liveM, cloneM) {
  const misses = [];
  const num = (v) => (typeof v === "number" ? v : NaN);
  // marquee/scroll speed
  if (liveM && typeof liveM.pxPerSec === "number") {
    if (!cloneM || typeof cloneM.pxPerSec !== "number") misses.push(`pxPerSec: live=${liveM.pxPerSec} clone=missing`);
    else if (!relWithin(liveM.pxPerSec, cloneM.pxPerSec, BEHAVIOR_TOL.pxPerSecRelative))
      misses.push(`pxPerSec: live=${liveM.pxPerSec} clone=${cloneM.pxPerSec} (outside ±${BEHAVIOR_TOL.pxPerSecRelative * 100}%)`);
  }
  // duration-style fields (durationMs, sampledMs) — informational only if live lacks them
  for (const f of ["durationMs"]) {
    if (liveM && typeof liveM[f] === "number") {
      if (!cloneM || typeof cloneM[f] !== "number") misses.push(`${f}: live=${liveM[f]} clone=missing`);
      else if (!relWithin(liveM[f], cloneM[f], BEHAVIOR_TOL.durationRelative, BEHAVIOR_TOL.durationFloorMs))
        misses.push(`${f}: live=${liveM[f]} clone=${cloneM[f]} (outside ±${BEHAVIOR_TOL.durationRelative * 100}%/${BEHAVIOR_TOL.durationFloorMs}ms floor)`);
    }
  }
  // end-state opacity/transform/filter (from `after`, or the bare measured block for mutation-style).
  // SKIPPED for kind "observed-mutation": an interval rotation's snapshot is whatever frame it
  // happened to be on — end-state floats from two independent captures of a continuously-mutating
  // element are not comparable; for those, key presence + trigger match ARE the contract (the
  // clone rotates too), and anything stronger is fiction dressed as a measurement.
  const frameNondeterministic = kind === "observed-mutation";
  const liveEnd = !frameNondeterministic && liveM && (liveM.after || liveM);
  const cloneEnd = cloneM && (cloneM.after || cloneM);
  if (liveEnd && typeof liveEnd.opacity === "number") {
    if (!cloneEnd || typeof cloneEnd.opacity !== "number") misses.push(`opacity: live=${liveEnd.opacity} clone=missing`);
    else if (Math.abs(liveEnd.opacity - cloneEnd.opacity) > BEHAVIOR_TOL.opacityAbs)
      misses.push(`opacity: live=${liveEnd.opacity} clone=${cloneEnd.opacity} (outside ±${BEHAVIOR_TOL.opacityAbs})`);
  }
  if (liveEnd && liveEnd.transform && liveEnd.transform !== "none") {
    if (!cloneEnd || !transformsMatch(liveEnd.transform, cloneEnd.transform))
      misses.push(`transform: live="${liveEnd.transform}" clone="${cloneEnd ? cloneEnd.transform : "missing"}" (matrix compare: ±${BEHAVIOR_TOL.transformTranslatePx}px translation)`);
  }
  if (liveEnd && liveEnd.filter && liveEnd.filter !== "none") {
    if (!cloneEnd || cloneEnd.filter !== liveEnd.filter)
      misses.push(`filter: live="${liveEnd.filter}" clone="${cloneEnd ? cloneEnd.filter : "missing"}"`);
  }
  // visibility: exact match, same rationale as filter — `hidden` vs `visible` is not a
  // measurement with sampling noise, it is the whole state of a visibility-driven reveal.
  if (liveEnd && liveEnd.visibility) {
    if (!cloneEnd || !cloneEnd.visibility) misses.push(`visibility: live="${liveEnd.visibility}" clone=missing`);
    else if (cloneEnd.visibility !== liveEnd.visibility)
      misses.push(`visibility: live="${liveEnd.visibility}" clone="${cloneEnd.visibility}"`);
  }
  // display: exact match, for the same reason as visibility — and it is the ONLY property that
  // moves on a display-driven reveal. chrono24's header flyouts are pre-mounted panels toggled by
  // `.header-flyout.active { display: block }`: opacity/transform/filter/visibility sit at their
  // open values the whole time, so a snapshot without `display` reads a shut 0px panel and an open
  // 543px one as the SAME STATE (LEARNINGS #22's rule, second instance — record every property a
  // reveal can move). Old-schema safe: a capture taken before `display` existed simply skips.
  if (liveEnd && liveEnd.display && cloneEnd && cloneEnd.display) {
    if (cloneEnd.display !== liveEnd.display)
      misses.push(`display: live="${liveEnd.display}" clone="${cloneEnd.display}" — a display-driven reveal (a pre-mounted panel toggled none↔block) moves NOTHING else`);
  }
  // An INCONCLUSIVE hover probe (see tools/behavior-capture.js): the operator named this trigger,
  // so something is claimed to open there, but a synthetic pointer can neither set `:hover` nor
  // satisfy trusted-event-gated JS — so "nothing moved" proves nothing. aloyoga's mega-menu is
  // exactly this: pre-mounted, `visibility: hidden`, opened by a JS class-toggle on a real
  // pointer. Passing it green would be laundering absence of evidence into evidence of absence —
  // a clone with no menu at all produces the identical row. It must be DISPOSED: reproduced and
  // confirmed in a review round, or written down in behavior-deviations.json.
  if (liveM && liveM.inconclusive === true) {
    misses.push(`hover probe INCONCLUSIVE on live — ${liveM.inconclusiveReason || "the synthetic probe cannot fire this trigger"}. "changed:false" here is absence of evidence, not evidence of absence (a clone with no menu produces the same row). Dispose it: verify the reveal in a review round and document it in behavior-deviations.json`);
  }
  // hover-mount / reveal: live observed a real change — clone must too (a frozen start state
  // reproduces nothing, even if the numbers above happen to be absent on both sides)
  if (liveM && liveM.changed === true && !(cloneM && cloneM.changed === true)) misses.push(`changed: live=true clone=${cloneM ? cloneM.changed : "missing"} (clone never mounted/toggled the content)`);
  void num;
  return { ok: misses.length === 0, detail: misses.join("; ") };
}

function behaviorGate(name) {
  const dir = targetDir(name);
  const livePath = path.join(dir, "behaviors-live.json");
  const clonePath = path.join(dir, "behaviors-clone.json");
  if (!exists(livePath))
    return { ok: false, reason: `targets/${name}/behaviors-live.json missing — run the discovery pass on the LIVE site with tools/behavior-capture.js (pxBehaviorSend or pxBehaviorStash), see tools/RUNBOOK.md "Behavior discovery" — or capture both sides in a kit-owned Chrome: ${CMD} behavior-capture ${name}` };
  let live; try { live = readJson(livePath); } catch (e) { return { ok: false, reason: `behaviors-live.json is not valid JSON: ${e.message}` }; }
  // "discovery ran" must be EVIDENCED, not inferred from an empty behaviors object (docs/WORKFLOW.md:
  // an absent/empty inventory must be an explicit gate result, never a free pass). The evidence
  // is the discovery pass's own metadata — without it we cannot tell "nothing dynamic here" from
  // "the script never fired".
  const d = live.discovery;
  if (!d || typeof d.elementsScanned !== "number" || !d.elementsScanned || !d.scrollSweep || typeof d.observeMs !== "number")
    return { ok: false, reason: `behaviors-live.json has no discovery pass metadata (elementsScanned/scrollSweep/observeMs) — this looks like a paint-over, not a real discovery run. Re-capture with pxBehaviorDiscover()/pxBehaviorSend() from tools/behavior-capture.js.` };
  if (!live.behaviors || typeof live.behaviors !== "object")
    return { ok: false, reason: `behaviors-live.json missing a "behaviors" object (even an empty {} is required to prove discovery ran)` };

  // A capture taken in a HIDDEN (background) tab is not a measurement: Chrome throttles its
  // timers and does not advance CSS transitions, so every duration/opacity in it is an artifact
  // of the capture environment. Refuse it rather than compare it — a live-foregrounded vs
  // clone-hidden diff invents misses that do not exist on the page.
  if (live.discovery && live.discovery.documentHidden === true)
    return { ok: false, reason: `behaviors-live.json was captured while the tab was HIDDEN (background) — Chrome throttles timers and freezes CSS transitions there, so its durations/opacities are artifacts of the capture, not the page. Re-capture with the tab visible and in the foreground — or, if this environment can NEVER foreground a tab (some automation stacks report document.hidden=true permanently), run ${CMD} behavior-capture ${name}: it measures both sides in a kit-owned Chrome and refuses its own environment unless a probe proves the compositor is advancing.` };
  // Runner attestation (behavior-runner.js splices discovery.runner into snapshots it
  // captured over CDP): accepted and CITED when present — receipts culture — but never
  // required, because a genuinely-foregrounded interactive tab is still a valid instrument.
  const cite = (snap) => {
    const r = snap && snap.discovery && snap.discovery.runner;
    return r ? `; captured via ${r.mode} ${r.chromeVersion}${r.rafProbe && r.rafProbe.hz ? `, rAF ${r.rafProbe.hz}Hz` : ""}` : "";
  };
  const liveKeys = Object.keys(live.behaviors);
  // Declared-but-unfired rows (schema-gated: absent on pre-worksheet inventories). In an
  // environment-inverted run (no-js / bot-gated choreography) NOTHING fires live, yet the
  // markers still declare what is SUPPOSED to move — each declared row needs a disposition.
  const declaredKeys = live.declared && typeof live.declared === "object" ? Object.keys(live.declared) : [];
  if (!liveKeys.length && !declaredKeys.length) {
    // Legitimate pass: discovery ran (evidenced above) and found nothing dynamic. Cite the
    // discovery metadata IN the pass reason so the receipt itself is the evidence trail.
    return {
      ok: true,
      reason: `no dynamic behaviors discovered — discovery ran: ${d.elementsScanned} elements scanned, scroll swept ${d.scrollSweep.from}→${d.scrollSweep.to}px in ${d.scrollSweep.steps} steps, observed ${d.observeMs}ms` + (d.hoverTriggersProbed && d.hoverTriggersProbed.length ? `, hover-probed [${d.hoverTriggersProbed.join(", ")}]` : "") + cite(live),
      artifact: livePath,
    };
  }

  if (!exists(clonePath))
    return { ok: false, reason: `targets/${name}/behaviors-clone.json missing — capture the clone (with clone/fixes.js loaded) the SAME way: ${liveKeys.length} observed live behavior(s) [${liveKeys.join(", ")}]${declaredKeys.length ? ` + ${declaredKeys.length} declared` : ""} have nothing to compare against` };
  let clone; try { clone = readJson(clonePath); } catch (e) { return { ok: false, reason: `behaviors-clone.json is not valid JSON: ${e.message}` }; }
  if (clone.discovery && clone.discovery.documentHidden === true)
    return { ok: false, reason: `behaviors-clone.json was captured while the tab was HIDDEN (background) — throttled timers and frozen CSS transitions make its durations/opacities meaningless. Re-capture with the clone tab visible and in the foreground — or run ${CMD} behavior-capture ${name} (kit-owned Chrome, both sides).` };
  const cloneBehaviors = (clone && clone.behaviors) || {};

  const devPath = path.join(dir, "behavior-deviations.json");
  const dev = exists(devPath) ? readJson(devPath) : {};

  const missing = [], outOfTolerance = [], documented = [];
  for (const key of liveKeys) {
    if (dev[key] && typeof dev[key].reason === "string" && dev[key].reason.trim()) { documented.push(key); continue; }
    if (!(key in cloneBehaviors)) { missing.push(key); continue; }
    const liveB = live.behaviors[key], cloneB = cloneBehaviors[key];
    if (liveB.trigger && cloneB.trigger && liveB.trigger !== cloneB.trigger) {
      outOfTolerance.push(`${key} (trigger: live="${liveB.trigger}" clone="${cloneB.trigger}")`);
      continue;
    }
    const cmp = compareMeasured(key, liveB.kind, liveB.measured, cloneB.measured);
    if (!cmp.ok) outOfTolerance.push(`${key} (${cmp.detail})`);
  }

  if (missing.length)
    return { ok: false, reason: `${missing.length} live behavior(s) MISSING from the clone (silently unreproduced, undocumented): ${missing.join(", ")} — reproduce in clone/fixes.js or document why in targets/${name}/behavior-deviations.json` };
  if (outOfTolerance.length)
    return { ok: false, reason: `${outOfTolerance.length} behavior(s) reproduced but OUT OF TOLERANCE: ${outOfTolerance.join("; ")}` };

  // Declared rows: reproduced when the CLONE's dynamic pass observed the same element
  // firing (descriptor match under any observed prefix — the clone made it move; which
  // trigger class it landed under is secondary), else they need a reasoned deviation.
  // Never silently dropped — that's how one invented animation quietly replaces two.
  let declaredExcused = 0;
  if (declaredKeys.length) {
    const descriptorOf = (k) => k.replace(/^[a-z-]+:/i, "");
    const cloneDescriptors = new Set(Object.keys(cloneBehaviors).map(descriptorOf));
    const undisposed = [];
    for (const k of declaredKeys) {
      if (dev[k] && typeof dev[k].reason === "string" && dev[k].reason.trim()) { declaredExcused++; continue; }
      if (!cloneDescriptors.has(descriptorOf(k))) undisposed.push(k);
    }
    if (undisposed.length)
      return { ok: false, reason: `${undisposed.length} DECLARED behavior(s) with NO disposition — markers say these are supposed to move; nothing reproduces or excuses them: ${undisposed.slice(0, 6).join(", ")}${undisposed.length > 6 ? ` … +${undisposed.length - 6} more` : ""} — run: node tools/behavior-worksheet.js ${name} (it prints ready-to-send poll questions for the reviewer)` };
  }

  const summary = `${liveKeys.length} live behavior(s) verified — ${liveKeys.length - documented.length} reproduced within tolerance` + (documented.length ? `, ${documented.length} documented deviation(s) [${documented.join(", ")}]` : "") + (declaredKeys.length ? `; ${declaredKeys.length} declared row(s) disposed (${declaredKeys.length - declaredExcused} reproduced, ${declaredExcused} excused)` : "") + cite(live);
  return { ok: true, reason: summary, artifact: clonePath };
}

// ── PHASES — ordered; each with an objective gate ────────────────────────────
// kind: "machine"  → fully verified by the gate (exit 0 is a fact)
//       "attested" → can't be fully machine-checked; requires --evidence and is flagged
const PHASES = [
  {
    key: "target",
    title: "Target + viewport fixed",
    kind: "machine",
    gate(name) {
      const tp = path.join(targetDir(name), "target.json");
      if (!exists(tp)) return { ok: false, reason: `targets/${name}/target.json missing — run new-target.js first` };
      const t = readJson(tp);
      if (!t.url || !t.width) return { ok: false, reason: "target.json needs both url and width" };
      return { ok: true, reason: `target ${t.url} @ ${t.width}px`, artifact: tp };
    },
  },
  {
    key: "assets",
    title: "Real assets extracted (fonts/icons/logo)",
    kind: "attested", // "not hand-drawn" isn't machine-provable; we light-check woff2 magic + require evidence
    gate(name) {
      // Light machine check: every shipped FONT must have real magic bytes (catches a
      // renamed/hand-faked font). We do NOT require fonts to exist (some sites use system
      // fonts), so a clean pass here still needs an --evidence attestation at advance time.
      //
      // THE HOLE THIS CLOSES (lelabo, 2026-07-12): the check walked for `.woff2` ONLY. lelabo
      // self-hosts 26 fonts and NONE are woff2 — they are .eot/.ttf/.woff (an older stack). So
      // the gate validated ZERO files and passed, printing "0 woff2 asset(s) validated". Every
      // one of those fonts could have been a 404 HTML page renamed .ttf and nothing would have
      // said so. "I checked nothing" must never render as a pass — same absence-of-evidence
      // class as #22. Validate whatever formats are actually present, and say the count per
      // format so the receipt shows WHAT was checked.
      const cloneDir = path.join(targetDir(name), "clone");
      if (!exists(cloneDir)) return { ok: false, reason: `targets/${name}/clone/ missing` };

      // magic-byte validators, by extension. eot has no leading magic — its MagicNumber (0x504C)
      // sits at offset 34, little-endian.
      const FONT_MAGIC = {
        ".woff2": (b) => b.subarray(0, 4).toString("latin1") === "wOF2",
        ".woff": (b) => b.subarray(0, 4).toString("latin1") === "wOFF",
        ".otf": (b) => b.subarray(0, 4).toString("latin1") === "OTTO",
        ".ttf": (b) => {
          const m = b.subarray(0, 4);
          return (m[0] === 0x00 && m[1] === 0x01 && m[2] === 0x00 && m[3] === 0x00) ||
            m.toString("latin1") === "true" || m.toString("latin1") === "ttcf";
        },
        ".eot": (b) => b.length > 35 && b[34] === 0x4c && b[35] === 0x50,
      };
      const fonts = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const fp = path.join(d, e.name);
          if (e.isDirectory()) walk(fp);
          else { const ext = path.extname(e.name).toLowerCase(); if (FONT_MAGIC[ext]) fonts.push([fp, ext]); }
        }
      };
      walk(cloneDir);
      const byExt = {};
      for (const [f, ext] of fonts) {
        const buf = fs.readFileSync(f);
        if (!buf.length) return { ok: false, reason: `${path.relative(WORK, f)} is EMPTY (0 bytes) — the download failed; re-extract it` };
        if (!FONT_MAGIC[ext](buf))
          return { ok: false, reason: `${path.relative(WORK, f)} is not a real ${ext.slice(1)} (bad magic bytes — a 404 page or a renamed file?) — extract it, don't rename` };
        byExt[ext] = (byExt[ext] || 0) + 1;
      }

      // A self-hosted font the CSS REFERENCES but that is not on disk 404s in the browser and the
      // text silently falls back — while `font.family` still computes to the declared family, so
      // --visual stays green and nothing ever says the glyphs are wrong. Only relative refs are
      // checked; an absolute URL is a documented remote-origin tradeoff, not a missing file.
      const missing = [];
      const cssDir = path.join(cloneDir, "assets", "css");
      if (exists(cssDir)) {
        for (const f of fs.readdirSync(cssDir)) {
          if (!f.endsWith(".css")) continue;
          const css = fs.readFileSync(path.join(cssDir, f), "utf8");
          for (const m of css.matchAll(/url\(\s*['"]?([^'")]+\.(?:woff2|woff|ttf|otf|eot))(?:[?#][^'")]*)?['"]?\s*\)/gi)) {
            const ref = m[1];
            if (/^(https?:)?\/\//i.test(ref) || ref.startsWith("data:")) continue; // remote/inline — not ours to verify
            // A ref is a URL the BROWSER resolves against the serve root, not a filesystem path.
            // capture-build writes root-relative refs (/assets/fonts/x), which serve.js maps to
            // clone/assets/fonts/x — but path.resolve(cssDir, "/assets/…") discards cssDir and
            // probes the FILESYSTEM root, flagging every such font as missing. Measured: 50
            // phantom "missing" fonts on lelabo, a target fully green with all fonts on disk.
            const abs = ref.startsWith("/") ? path.join(cloneDir, ref) : path.resolve(cssDir, ref);
            if (!exists(abs)) missing.push(`${f} → ${ref}`);
          }
        }
      }
      if (missing.length)
        return { ok: false, reason: `${missing.length} self-hosted font(s) referenced by the clone's CSS are NOT on disk — they 404 and the text silently falls back while font.family still matches (--visual stays green): ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` … +${missing.length - 3} more` : ""}` };

      const summary = fonts.length
        ? Object.entries(byExt).map(([e, n]) => `${n}${e}`).join(" + ") + " font(s) validated"
        : "no self-hosted fonts (system fonts?) — nothing to validate";
      return { ok: true, reason: `${summary}; attest icons/logo are captured (not redrawn)`, artifact: cloneDir };
    },
  },
  {
    key: "measure",
    title: "Live site measured at the fixed width",
    kind: "machine",
    gate(name) {
      const lp = path.join(targetDir(name), "live.json");
      if (!exists(lp)) return { ok: false, reason: `targets/${name}/live.json missing — measure the live site (RUNBOOK)` };
      let live; try { live = readJson(lp); } catch (e) { return { ok: false, reason: `live.json is not valid JSON: ${e.message}` }; }
      const t = readJson(path.join(targetDir(name), "target.json"));
      if (!live.elements || !Object.keys(live.elements).length) return { ok: false, reason: "live.json has no measured elements" };
      if (live.viewport && t.width && live.viewport.width !== t.width)
        return { ok: false, reason: `live.json measured at ${live.viewport.width}px, target is ${t.width}px — re-measure at the fixed width` };
      return { ok: true, reason: `${Object.keys(live.elements).length} live elements measured @ ${live.viewport && live.viewport.width}px`, artifact: lp };
    },
  },
  {
    key: "build",
    title: "Clone built to spec + captured",
    kind: "machine",
    gate(name) {
      const html = path.join(targetDir(name), "clone", "index.html");
      if (!exists(html)) return { ok: false, reason: "clone/index.html missing" };
      if (/TODO: build to spec/.test(fs.readFileSync(html, "utf8"))) return { ok: false, reason: "clone/index.html still has the scaffold TODO — build the header first" };
      const cp = path.join(targetDir(name), "clone.json");
      if (!exists(cp)) return { ok: false, reason: `targets/${name}/clone.json missing — capture the clone (RUNBOOK)` };
      let clone; try { clone = readJson(cp); } catch (e) { return { ok: false, reason: `clone.json is not valid JSON: ${e.message}` }; }
      if (!clone.elements || !Object.keys(clone.elements).length) return { ok: false, reason: "clone.json has no measured elements" };
      return { ok: true, reason: `${Object.keys(clone.elements).length} clone elements captured`, artifact: cp };
    },
  },
  {
    key: "visual",
    title: "--visual gate green (pixels match)",
    kind: "machine",
    gate(name) {
      const lp = path.join(targetDir(name), "live.json"), cp2 = path.join(targetDir(name), "clone.json");
      if (!exists(lp) || !exists(cp2)) return { ok: false, reason: "live.json / clone.json missing — measure + build first" };
      const live = readJson(lp);
      const clone = readJson(cp2);
      if (live.viewport && clone.viewport && live.viewport.width !== clone.viewport.width)
        return { ok: false, reason: `viewport widths differ (${live.viewport.width} vs ${clone.viewport.width}) — x-positions not comparable` };
      // …and the same is true DOWN the page, which the gate used to ignore. getBoundingClientRect
      // is viewport-relative: a position:fixed element (a chat bubble, a sticky footer bar) is
      // anchored to the viewport's BOTTOM, so its y is `innerHeight - offset`. Measure live in a
      // tab of one height and the clone in a tab of another and the gate reports a y delta for an
      // element that did not move — a delta the KIT manufactured, on a page where nothing is wrong
      // (LEARNINGS #23). Measured on chrono24: two tabs 997px vs 941px tall, and the support-chat
      // button "moved" by exactly the 56px difference. Unequal heights also silently change any
      // vh-based layout, so the honest answer is to refuse the comparison, not to patch one symptom.
      if (live.viewport && clone.viewport && live.viewport.height && clone.viewport.height &&
          live.viewport.height !== clone.viewport.height)
        return { ok: false, reason: `viewport heights differ (${live.viewport.height} vs ${clone.viewport.height}) — y-positions of viewport-anchored (position:fixed) elements and any vh-based layout are not comparable. Capture live and the clone in the SAME tab (identical browser chrome ⇒ identical innerHeight), then re-capture both.` };
      const v = diffSnapshots(live, clone, { visual: true });
      if (!v.ok) return { ok: false, reason: `${v.summary.failures}/${v.summary.comparisons} --visual comparisons over ${v.summary.tol}px — run score.js for the fix list` };
      return { ok: true, reason: `--visual PASS — ${v.summary.comparisons} comparisons, 0 fails`, artifact: path.join(targetDir(name), "clone.json") };
    },
  },
  {
    key: "coverage",
    title: "Coverage closed (every painted leaf targeted)",
    kind: "machine",
    gate(name) {
      // Requires targets/<name>/coverage.json: the enumerated painted leaves in the region.
      // Accepts ["logo","nav_first",...] or {leaves:[...]}. The gate verifies every enumerated
      // leaf has a MEASURED target on BOTH pages — a green --visual only proves the elements you
      // measured, so an uncovered painted leaf is unverified, not matched (PLAYBOOK 5b).
      const covPath = path.join(targetDir(name), "coverage.json");
      if (!exists(covPath)) return { ok: false, reason: `targets/${name}/coverage.json missing — enumerate every painted leaf in the region (own text / background-image / <svg>) and list them` };
      let cov; try { cov = readJson(covPath); } catch (e) { return { ok: false, reason: `coverage.json is not valid JSON: ${e.message}` }; }
      const leaves = Array.isArray(cov) ? cov : cov.leaves;
      if (!Array.isArray(leaves) || !leaves.length) return { ok: false, reason: "coverage.json must be a non-empty array of painted-leaf names" };
      const live = readJson(path.join(targetDir(name), "live.json")).elements || {};
      const clone = readJson(path.join(targetDir(name), "clone.json")).elements || {};
      const uncovered = leaves.filter((n) => !(live[n] && live[n].present && clone[n] && clone[n].present));
      if (uncovered.length) return { ok: false, reason: `${uncovered.length} painted leaf/leaves have no measured target on both pages: ${uncovered.join(", ")}` };
      return { ok: true, reason: `all ${leaves.length} enumerated painted leaves are covered`, artifact: covPath };
    },
  },
  {
    key: "strict",
    title: "Strict deltas fixed or documented",
    kind: "machine",
    gate(name) {
      // Strict mode also flags structural CSS (display/position/gap/padding/font-family alias).
      // Two valid implementations can legitimately differ there — but each such delta must be
      // DOCUMENTED, never silent (PLAYBOOK ground rule 5). Pass when strict fails are 0, OR every
      // failing (target, prop) is listed in targets/<name>/deviations.json:
      //   { "nav_first": { "layout.display": "flex vs inline-block — same pixels", ... }, ... }
      const lp = path.join(targetDir(name), "live.json"), cp2 = path.join(targetDir(name), "clone.json");
      if (!exists(lp) || !exists(cp2)) return { ok: false, reason: "live.json / clone.json missing — earlier phases first" };
      const live = readJson(lp);
      const clone = readJson(cp2);
      const s = diffSnapshots(live, clone, {});
      const fails = s.rows.filter((r) => !r.pass);
      if (!fails.length) return { ok: true, reason: "strict PASS — 0 structural deltas", artifact: cp2 };
      // A delta that ALSO fails --visual is a painted mark, not structure — it can never be
      // "documented away" (PLAYBOOK ground rule 6: a colour/underline delta is never structural).
      const v = diffSnapshots(live, clone, { visual: true });
      const paintKeys = new Set(v.rows.filter((r) => !r.pass).map((r) => r.target + "\u0000" + r.prop));
      const paint = fails.filter((r) => paintKeys.has(r.target + "\u0000" + r.prop));
      if (paint.length)
        return { ok: false, reason: `${paint.length} PAINT delta(s) — visible marks can never be documented away, fix them: ` + paint.map((r) => `${r.target}.${r.prop}`).join(", ") };
      const devPath = path.join(targetDir(name), "deviations.json");
      const dev = exists(devPath) ? readJson(devPath) : {};
      const undocumented = fails.filter((r) => !(dev[r.target] && dev[r.target][r.prop]));
      if (undocumented.length)
        return { ok: false, reason: `${undocumented.length} strict delta(s) undocumented — fix them or explain each in deviations.json: ` + undocumented.map((r) => `${r.target}.${r.prop}`).join(", ") };
      return { ok: true, reason: `${fails.length} structural delta(s), all documented in deviations.json`, artifact: devPath };
    },
  },
  {
    key: "behavior",
    title: "JS-driven dynamics reproduced (measured, not eyeballed)",
    kind: "machine",
    gate(name) { return behaviorGate(name); },
  },
  {
    key: "review",
    title: "Review approved (side-by-side verdict)",
    kind: "machine",
    gate(name) {
      // The gates prove what the tool measures; a review proves the measured set is what a
      // viewer actually SEES (the LEARNINGS gate-vs-eyes split). A review verdict is
      // machine-checkable, so this is a machine gate: verify re-fetches the LATEST round's
      // verdict from the API (a cached approval is never trusted) and exits 0 only on
      // approval. Scope-pinned review template + refile loop: harness/review-qa.js.
      const hq = path.join(targetDir(name), "review-qa.json");
      if (!exists(hq)) return { ok: false, reason: `no review round recorded — push the clone as a hosted draft (node harness/draft.js push ${name}), then: node harness/review-qa.js file ${name}` };
      const r = require("child_process").spawnSync(
        process.execPath, [path.join(PKG, "harness", "review-qa.js"), "verify", name],
        { encoding: "utf8", cwd: WORK, timeout: 30_000 }
      );
      const line = ((r.stdout || "") + (r.stderr || "")).trim().split("\n")[0] || "verify produced no output";
      if (r.status !== 0) return { ok: false, reason: line };
      return { ok: true, reason: line, artifact: hq };
    },
  },
  {
    key: "done",
    title: "Pixel-perfect — verified end to end",
    kind: "machine",
    gate(name) {
      // Default-FAIL final verification: a recorded pass is NOT trusted — every earlier gate is
      // RE-RUN against the current artifacts, so a pass can't survive later edits to what it
      // certified (e.g. re-capturing the clone to close coverage and regressing the visuals).
      // Merged snapshots (tools/merge-snapshot.js) are ITERATION artifacts: elements outside
      // the re-captured subset carry stale measurements a fix may have displaced (astryx's
      // bento-height fix moved the footer). done demands one final FULL capture of each —
      // a full re-capture overwrites the file and clears the stamp.
      for (const f of ["live.json", "clone.json"]) {
        const p = path.join(targetDir(name), f);
        if (exists(p)) {
          try {
            const snap = readJson(p);
            if (snap.merged) return { ok: false, reason: `${f} is a MERGED iteration snapshot (partial re-capture folded in at ${snap.merged.at}) — take one full capture before claiming done` };
          } catch (e) { /* unreadable snapshots fail their own gates */ }
        }
      }
      const st = loadState(name);
      const missing = [], stale = [], forcedPhases = [], blockedPhases = [];
      for (const p of PHASES.slice(0, -1)) {
        const ph = st.phases[p.key];
        if (ph.status !== "pass") { missing.push(p.key); continue; }
        // A blocked phase's gate is EXPECTED to fail (that is what blocked means) — re-running
        // it here would report it as "stale", which misnames the problem. The dedicated
        // refusal below says precisely what it is: receipted, never verified.
        if (ph.blocked) { blockedPhases.push(p.key); continue; }
        if (ph.forced) forcedPhases.push(p.key);
        const g = safeGate(p, name);
        if (!g.ok) stale.push(`${p.key} — ${g.reason}`);
      }
      if (missing.length) return { ok: false, reason: `earlier phases not done: ${missing.join(", ")}` };
      if (stale.length) return { ok: false, reason: `recorded pass(es) are STALE against current artifacts — fix and re-advance: ${stale.join("; ")}` };
      if (forcedPhases.length) return { ok: false, reason: `phase(s) were forced past enforcement: ${forcedPhases.join(", ")} — re-advance each with a passing gate before claiming done` };
      // A blocked phase let the run reach a reviewer despite the environment — that was the
      // point — but it is an override, not a verification: done stays red until it is earned.
      if (blockedPhases.length) return { ok: false, reason: `phase(s) were receipted as environment-BLOCKED, not verified: ${blockedPhases.join(", ")} — re-advance each with a passing gate (in an environment that can run it) before claiming done` };
      return { ok: true, reason: "every phase gate re-verified green against current artifacts, in order, none forced" };
    },
  },
];
const PHASE_BY_KEY = Object.fromEntries(PHASES.map((p) => [p.key, p]));
const phaseIndex = (key) => PHASES.findIndex((p) => p.key === key);

// ── state ─────────────────────────────────────────────────────────────────────
function initWorkflow(name, url, width, opts) {
  const dir = targetDir(name);
  if (!exists(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  const sp = statePath(name);
  // Re-seeding destroys recorded phase state — never silent. Refuse unless --force, and
  // receipt the reset in the ledger so the audit trail can explain an all-pending workflow.
  if (exists(sp)) {
    if (!(opts && opts.force)) {
      console.error(`❌ workflow for "${name}" already exists — refusing to reset recorded phase state.\n   Re-seed (e.g. after corruption) with: ${CMD} init ${name} --force — the reset is receipted in the ledger.`);
      process.exit(1);
    }
    appendLedger(name, { ts: new Date().toISOString(), event: "reset", phase: null, runId: runId(), gate: null, forced: true, reason: "pingfusi init --force re-seeded workflow.json (prior phase state discarded; ledger retained)" });
  }
  // prefer target.json for canonical url/width if it exists
  const tp = path.join(dir, "target.json");
  if (exists(tp)) { const t = readJson(tp); url = url || t.url; width = width || t.width; }
  const state = {
    name, url: url || null, width: width || null,
    createdAt: new Date().toISOString(),
    phaseOrder: PHASES.map((p) => p.key),
    phases: Object.fromEntries(PHASES.map((p) => [p.key, { status: "pending", kind: p.kind, runId: null, sha256: null, evidence: null, ts: null, forced: false }])),
  };
  fs.writeFileSync(sp, JSON.stringify(state, null, 2) + "\n");
  return state;
}
function loadState(name) {
  const p = statePath(name);
  if (!exists(p)) { console.error(`no workflow for "${name}" — run: ${CMD} init ${name}`); process.exit(1); }
  // State-corruption recovery: a truncated/hand-edited state file gets a self-describing
  // error + the recovery command, never a raw parse stack. The ledger stays intact either way.
  let st;
  try { st = readJson(p); } catch (e) {
    console.error(`❌ targets/${name}/workflow.json is corrupt: ${e.message}\n   The audit ledger (workflow.jsonl) is untouched. Re-seed state with: ${CMD} init ${name} --force (receipted as a reset), then re-advance each phase — gates re-verify from the artifacts.`);
    process.exit(1);
  }
  const broken = !st || typeof st !== "object" || !st.phases;
  if (!broken) {
    // Schema MIGRATION, not corruption: a workflow seeded before the kit gained a phase
    // (e.g. `review`) is missing that key. Hydrate it as pending IN MEMORY — recorded
    // receipts stay valid, the new phase simply isn't done yet. Persisted naturally by
    // the next advance's saveState; reads (status/gate) stay side-effect-free.
    for (const p of PHASES) {
      if (!st.phases[p.key]) st.phases[p.key] = { status: "pending", kind: p.kind, runId: null, sha256: null, evidence: null, ts: null, forced: false };
    }
    st.phaseOrder = PHASES.map((p) => p.key);
  }
  const invalid = broken || PHASES.some((ph) => typeof st.phases[ph.key].status !== "string");
  if (invalid) {
    console.error(`❌ targets/${name}/workflow.json has an invalid shape (missing/unknown phase state — older schema or manual edit).\n   Re-seed with: ${CMD} init ${name} --force (receipted as a reset), then re-advance each phase.`);
    process.exit(1);
  }
  return st;
}
const saveState = (name, st) => fs.writeFileSync(statePath(name), JSON.stringify(st, null, 2) + "\n");
const appendLedger = (name, rec) => fs.appendFileSync(ledgerPath(name), JSON.stringify(rec) + "\n");

// ── commands ────────────────────────────────────────────────────────────────
// `--assert-done` turns status into a GATE, not a report. Paid for on aloyoga: the
// workflow correctly refused `advance done` (behavior + review pending) and said so the
// whole time — but nothing READ the ledger before the iteration wrote "green, converged,
// pixel-perfect". The gates never lied; the summary did. workflow.js is a ledger, not a
// driver: it can refuse a bad advance, it cannot compel an agent to finish. So the claim
// of success now has to be backed by an exit code, per the kit's own rule — never claim
// "pixel-perfect" or "caught" from anything but a command that exits 0.
// Forced phases do NOT count as done: --force is a legitimate escape hatch, but a forced
// gate and an earned one must never read the same in a final report. --allow-forced opts
// back in, deliberately and visibly.
function cmdStatus(name, opts = {}) {
  const st = loadState(name);
  // target.json is the CANONICAL url/width (the target gate reads it); workflow.json only
  // snapshots them at init. Display the live values so a legitimately re-targeted width
  // (e.g. a browser that couldn't hit the requested viewport) isn't shown stale mid-run.
  let cur = { url: st.url, width: st.width };
  try { const t = readJson(path.join(targetDir(name), "target.json")); cur = { url: t.url || cur.url, width: t.width || cur.width }; } catch (e) { /* fall back to the init snapshot */ }
  console.log(`\nworkflow — ${name}  (${cur.url || "?"} @ ${cur.width || "?"}px)`);
  let nextRequired = null;
  for (const p of PHASES) {
    const ph = st.phases[p.key];
    const mark = ph.status === "pass" ? (ph.blocked ? "⚠ blocked" : ph.forced ? "⚠ forced" : (p.kind === "attested" ? "✓ attested" : "✓ pass")) : "· pending";
    console.log(`  ${mark.padEnd(11)} ${p.key.padEnd(9)} ${p.title}`);
    if (!nextRequired && ph.status !== "pass") nextRequired = p;
  }
  const pending = PHASES.filter((p) => st.phases[p.key].status !== "pass");
  const blocked = PHASES.filter((p) => st.phases[p.key].status === "pass" && st.phases[p.key].blocked);
  const forced = PHASES.filter((p) => st.phases[p.key].status === "pass" && st.phases[p.key].forced && !st.phases[p.key].blocked);

  if (nextRequired) {
    const g = safeGate(nextRequired, name);
    console.log(`\n  next: ${nextRequired.key} — ${nextRequired.title}`);
    console.log(`  gate: ${g.ok ? "READY (gate passes) → advance it" : "blocked — " + g.reason}`);
    if (nextRequired.key === "review" && !g.ok) {
      // A filed-and-pending round means WAIT (re-filing burns a credit and re-enters the
      // queue); no round at all means the file ritual hasn't happened — say which.
      const pend = /pending[^(]*\(ping ([0-9a-f-]{36})\)/.exec(g.reason);
      if (pend) {
        console.log(`  run:  pingfusi wait ${pend[1]}   (BACKGROUND task — round already filed; the verdict wakes you, do NOT refile)`);
      } else {
        console.log(`  run:  ${CMD} draft ${name} push   →   ${CMD} review ${name} file   →   pingfusi wait <ping_id> (background)`);
        console.log(`        (green machine gates are NOT done — a reviewer's approving verdict is the gate)`);
        if (blocked.length) console.log(`        file it NOW despite the blocked gate(s) — the round documents the gap to the reviewer automatically; a reviewer look at a partial clone beats no look.`);
      }
    } else {
      console.log(`  run:  ${CMD} advance ${name} ${nextRequired.key}` + (nextRequired.kind === "attested" ? ' --evidence "…"' : ""));
      const s = stallInfo(name, nextRequired.key);
      if (!g.ok && s.fails >= STALL_AFTER) console.log(`  ${stallHint(name, s.fails)}`);
    }
  } else if (forced.length || blocked.length) {
    // every phase "passed", but some were forced/blocked — that is NOT a verified clone.
    if (forced.length) console.log(`\n  ⚠ all phases passed, but ${forced.length} was/were FORCED: ${forced.map((p) => p.key).join(", ")}`);
    if (blocked.length) console.log(`\n  ⚠ all phases passed, but ${blocked.length} was/were environment-BLOCKED: ${blocked.map((p) => p.key).join(", ")}`);
    console.log(`    an overridden gate is not a verification — do not report this as pixel-perfect.`);
  } else {
    console.log(`\n  ✓ all phases passed — this clone is verified pixel-perfect end to end.`);
  }

  // Surface the latest assist (review-qa.js records them) so the answer is never missed
  // between iterations — checking is free, and a pending ask means DON'T open a second one.
  try {
    const hq = readJson(path.join(targetDir(name), "review-qa.json"));
    const asks = [...(hq.polls || []), ...(hq.diagnostics || [])].filter((e) => e && e.assist);
    const a = asks[asks.length - 1];
    if (a) {
      const answers = (a.last && a.last.responses) || [];
      if (answers.length) {
        const first = answers[0].text || (answers[0].choice != null ? `[${answers[0].choice}]` : "") || "(see full result)";
        console.log(`\n  assist answered (phase ${a.assist.phase}): ${String(first).split("\n")[0]}`);
      } else {
        const check = a.kind === "diagnostic" ? `${CMD} review ${name} assist-result ${a.ping_id}` : `${CMD} review ${name} poll-result ${a.ping_id}`;
        console.log(`\n  assist pending (phase ${a.assist.phase}, ping ${a.ping_id}) — keep iterating; re-check free: ${check}`);
      }
    }
  } catch (e) { /* no review-qa.json yet — nothing to surface */ }

  if (opts.assertDone) {
    const reasons = [];
    if (pending.length) reasons.push(`${pending.length} phase(s) never ran: ${pending.map((p) => p.key).join(", ")}`);
    if (forced.length && !opts.allowForced) reasons.push(`${forced.length} phase(s) were --force'd: ${forced.map((p) => p.key).join(", ")}`);
    if (blocked.length && !opts.allowForced) reasons.push(`${blocked.length} phase(s) were receipted as environment-blocked, never verified: ${blocked.map((p) => p.key).join(", ")}`);
    if (reasons.length) {
      console.error(`\n❌ assert-done FAILED — "${name}" is NOT a finished iteration:`);
      for (const r of reasons) console.error(`   • ${r}`);
      console.error(`   Do not report this clone as green, converged, or pixel-perfect.`);
      process.exit(1);
    }
    console.log(`\n✓ assert-done — every phase earned (none pending, none forced).`);
  }
}

function safeGate(phase, name) {
  try { return phase.gate(name); } catch (e) { return { ok: false, reason: `gate errored: ${e.message}` }; }
}

function cmdGate(name, phaseKey) {
  const phase = PHASE_BY_KEY[phaseKey];
  if (!phase) { console.error(`unknown phase "${phaseKey}". phases: ${PHASES.map((p) => p.key).join(", ")}`); process.exit(2); }
  loadState(name); // ensure workflow exists
  const g = safeGate(phase, name);
  console.log(`${g.ok ? "✓ PASS" : "❌ FAIL"}  ${phaseKey} — ${g.reason}`);
  if (!g.ok) {
    // Probes stay read-only (they never count toward the streak) — but when failed ADVANCES
    // already crossed the threshold, the probe is where the agent is looking, so say it here too.
    const s = stallInfo(name, phaseKey);
    if (s.fails >= STALL_AFTER) console.log(`   ${stallHint(name, s.fails)}`);
  }
  process.exit(g.ok ? 0 : 1);
}

function cmdAdvance(name, phaseKey, opts) {
  const phase = PHASE_BY_KEY[phaseKey];
  if (!phase) { console.error(`unknown phase "${phaseKey}". phases: ${PHASES.map((p) => p.key).join(", ")}`); process.exit(2); }
  const st = loadState(name);
  const idx = phaseIndex(phaseKey);

  // A refused advance is receipted too — the audit trail records rejected overrides and
  // failed attempts, not just successes (an agent probing the gates leaves a trace).
  const refuse = (why, hint) => {
    appendLedger(name, { ts: new Date().toISOString(), phase: phaseKey, runId: runId(), gate: "refused", forced: !!opts.force, reason: why });
    console.error(`❌ ${why}`);
    if (hint) console.error(`   ${hint}`);
    process.exit(1);
  };

  // `forced` means "--force actually bypassed an enforcement" — ANY of the three checks
  // (ordering, attestation evidence, the gate itself), not only a failing gate. Each bypass
  // is named in `overrode` so the ledger shows exactly what was skipped.
  const overrode = [];

  const earlierPending = PHASES.slice(0, idx).filter((p) => st.phases[p.key].status !== "pass").map((p) => p.key);
  if (earlierPending.length) {
    if (!opts.force) refuse(`cannot advance "${phaseKey}" — earlier phase(s) not done: ${earlierPending.join(", ")}`, `do them in order, or override with --force (recorded in the audit log).`);
    overrode.push("order");
  }

  if (phase.kind === "attested" && !opts.evidence && !opts.blocked) {
    if (!opts.force) refuse(`"${phaseKey}" is an attestation phase — pass --evidence "what you verified" (its gate can't fully prove it).`);
    overrode.push("evidence");
  }

  const g = safeGate(phase, name);
  if (opts.blocked) {
    // --blocked is the receipted LAST RUNG for an environment the agent cannot fix (auth wall,
    // geo-block, tooling limit with no kit runner yet) — never a shortcut past a satisfiable
    // gate. Its reason must say which provided remedy was tried and how it failed; the gate's
    // own refusal names that remedy (LEARNINGS #32: a gate that refuses an environment must
    // come with a way to PROVIDE one).
    if (g.ok) refuse(`--blocked refused for "${phaseKey}" — the gate PASSES (${g.reason}); advance it normally.`);
    overrode.push("blocked-env");
  } else if (!g.ok) {
    if (!opts.force) {
      const streak = stallInfo(name, phaseKey).fails + 1; // + this refusal, receipted below
      const hint = `fix it, or override with --force (recorded as forced in the audit log).` +
        (streak >= STALL_AFTER ? `\n   ${stallHint(name, streak)}` : "");
      refuse(`gate failed for "${phaseKey}": ${g.reason}`, hint);
    }
    overrode.push("gate");
  }

  const rec = {
    ts: new Date().toISOString(),
    phase: phaseKey,
    runId: runId(),
    gate: g.ok ? "pass" : "failed",
    forced: overrode.length > 0,
    blocked: !!opts.blocked,
    overrode,
    sha256: g.artifact ? sha256OfFile(g.artifact) : null,
    artifact: g.artifact ? path.relative(WORK, g.artifact) : null,
    evidence: opts.evidence || opts.blocked || null,
    reason: g.reason,
  };
  st.phases[phaseKey] = { status: "pass", kind: phase.kind, runId: rec.runId, sha256: rec.sha256, evidence: rec.evidence, ts: rec.ts, forced: rec.forced, blocked: rec.blocked, overrode };
  saveState(name, st);
  appendLedger(name, rec);

  console.log(`${rec.blocked ? "⚠ BLOCKED" : rec.forced ? "⚠ FORCED" : "✓"} ${phaseKey} recorded  (runId ${rec.runId}${rec.sha256 ? ", sha256 " + rec.sha256 : ""})`);
  console.log(`  ${g.reason}`);
  if (rec.blocked) {
    console.log(`  ⚠ environment constraint receipted (${opts.blocked}) — NOT a verification; the done gate refuses blocked phases until each is re-advanced with a passing gate.`);
    console.log(`  → push to review with what you have — the round documents the gap to the reviewer automatically:`);
    console.log(`    1. ${CMD} draft ${name} push       2. ${CMD} review ${name} file       3. pingfusi wait <ping_id> (background)`);
  } else if (rec.forced) console.log(`  ⚠ enforcement bypassed (${overrode.join(", ")}) — flagged in workflow.jsonl; the done gate refuses forced phases.`);
  const next = PHASES.find((p) => st.phases[p.key].status !== "pass");
  // The most dangerous moment in the pipeline is the LAST machine gate going green:
  // "0 fails" reads like completion, the agent declares victory, and no round is ever
  // filed (seen in the field). The breadcrumb for the review hop is therefore explicit
  // and unmissable, not a generic "advance".
  if (!next) console.log(`  ✓ workflow complete — verified pixel-perfect.`);
  else if (next.key === "review") {
    console.log(`  next: REVIEW — green machine gates are NOT done. The clone needs a reviewer's approving verdict:`);
    console.log(`    1. ${CMD} draft ${name} push       (hosted draft url for the round)`);
    console.log(`    2. ${CMD} review ${name} file      (files the round — the reviewer gets a side-by-side)`);
    console.log(`    3. pingfusi wait <ping_id>  as a BACKGROUND task — the verdict wakes you; fix + refile until approved.`);
  } else console.log(`  next: ${CMD} advance ${name} ${next.key}`);
}

function cmdLedger(name) {
  const p = ledgerPath(name);
  if (!exists(p)) { console.log(`no ledger yet for "${name}".`); return; }
  const lines = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
  console.log(`\naudit trail — ${name}  (${lines.length} events)`);
  for (const l of lines) {
    const r = JSON.parse(l);
    const kind = r.event === "reset" ? "RESET" : r.event === "assist" ? "assist" : r.gate === "refused" ? "refused" : r.blocked ? "BLOCKED" : r.forced ? "FORCED" : r.gate;
    const what = r.event === "reset" ? "(state)" : r.phase;
    const extra = (r.overrode && r.overrode.length ? `  overrode: ${r.overrode.join(",")}` : "") + (r.sha256 ? ` sha=${r.sha256}` : "") + (r.evidence ? `  ev: ${r.evidence}` : "") + (r.event === "assist" && r.reason ? `  ${r.reason}` : "");
    console.log(`  ${r.ts}  ${String(kind).padEnd(7)} ${String(what).padEnd(9)} runId=${r.runId}${extra}`);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseOpts(args) {
  const opts = { force: args.includes("--force"), evidence: null, blocked: null };
  // never let a flag or nothing become permanent text in the append-only ledger
  const takeValue = (flag, hint) => {
    const i = args.indexOf(flag);
    if (i < 0) return null;
    const v = args[i + 1];
    if (v == null || v.startsWith("--")) {
      console.error(`${flag} needs a value (got ${v == null ? "nothing" : `"${v}"`}) — quote it: ${flag} "${hint}"`);
      process.exit(2);
    }
    return v;
  };
  opts.evidence = takeValue("--evidence", "what you verified");
  opts.blocked = takeValue("--blocked", "which provided remedy you tried and how the environment refused it");
  if (opts.blocked && opts.force) {
    // Two different claims: blocked receipts a constraint you cannot fix; force bypasses a
    // gate you could satisfy. Conflating them would launder one into the other in the ledger.
    console.error(`--blocked and --force are mutually exclusive — pick the one that is true.`);
    process.exit(2);
  }
  return opts;
}

// Delegate to a bundled harness/tools script, running it in the USER's cwd (so targets/
// land there) with the SAME runtime that launched pingfusi (node or bun → process.execPath).
function delegate(relScript, args) {
  const cp = require("child_process");
  // PPK_ENTRY tells the child it was invoked via the installed `pingfusi` command, so its
  // printed next-step guidance can use `pingfusi …` (runnable) instead of `node harness/…`.
  const r = cp.spawnSync(process.execPath, [path.join(PKG, relScript), ...args], { stdio: "inherit", cwd: WORK, env: { ...process.env, PPK_ENTRY: "1" } });
  process.exit(r.status == null ? 1 : r.status);
}

const HELP = `pingfusi — clone a site pixel-perfect, and prove it with an enforced, gated workflow

  pingfusi setup                                     FIRST CONTACT — one interactive command: global
                                                     install, cloudflared, the review login (required
                                                     for review rounds), agent skills.
                                                     Also: npx pingfusi setup
  pingfusi doctor                                    read-only preflight re-check, fix command per miss
  pingfusi agent-setup [--force]                     teach your AI agent: installs the clone-site skill
                                                     into ~/.claude/skills — then just ask your agent
                                                     to "clone https://example.com pixel-perfect"
  pingfusi where                                     print the installed kit's directory (docs live there)

  pingfusi new     <name> <url> [width]              scaffold a target + seed the workflow
  pingfusi adopt   <name> <original-url> [width]     register an EXTERNALLY-BUILT draft (ditto, lovable,
                                                     hand-built) for the review loop — no pixel
                                                     pipeline, the review verdict is the whole check;
                                                     then: pingfusi tunnel <name> --url <dev-url> → pingfusi review file
  pingfusi capture-build <name> [domFile]            build the clone FROM the captured live DOM (default
                                                     build strategy — LEARNINGS #19; needs targets/<name>/dom.html,
                                                     captured with pxSendDom, see RUNBOOK "Build by capture")
  pingfusi serve   <name> [port]                     serve the clone + the kit's /tools
  pingfusi draft   <name> push                       upload the clone as a HOSTED draft (stable public
                                                     url, byte-verified, survives this machine — the
                                                     review DEFAULT; records targets/<name>/draft.json)
  pingfusi draft   <name> status|delete              re-verify / delete the hosted draft
  pingfusi tunnel  <name> [port] [--check]           public HTTPS tunnel (cloudflared), VERIFIED to serve
                                                     clone/index.html byte-identically before it's recorded
                                                     (fallback draft when a hosted push isn't possible)
  pingfusi tunnel  <name> --url <http://localhost:3000>   tunnel an adopted build's own dev server
                                                     (reachability-verified; ditto/next/vite etc. — live
                                                     dev servers can't be pushed as static drafts)
  pingfusi capture open <name>                       hosted capture session (remote sink, 24h): pages
                                                     deliver with pxSend/pxSendDom to the printed sink_url
  pingfusi capture pull <name> --all                 pull delivered captures back, integrity-verified
  pingfusi tunnel  --sink [port]                     tunnel the snapshot SINK: live pages deliver captures
                                                     with one pxSend call even when the environment blocks
                                                     page→localhost (replaces the stash/chunk fallback)
  pingfusi sink                                      run the snapshot receiver (:7799)
  pingfusi behavior-capture <name> [--side both|live|clone] [--dry-run]   behavior discovery in a
                                                     kit-owned Chrome over CDP — REQUIRED when your
                                                     automation's tabs are permanently hidden (the
                                                     behavior gate refuses hidden captures); probe-gated,
                                                     injects the same tools/behavior-capture.js and
                                                     writes behaviors-*.json directly (no sink).
                                                     Invisible by default (headless, ephemeral ports);
                                                     --headful only if the probe refuses your headless
  pingfusi score   <name>                            score live-vs-clone vs the last run
  pingfusi diff    <live.json> <clone.json> [--visual|--inspect|--all|--tol N]   raw numeric diff

  pingfusi review  <name> file [--draft <url>]       file a scope-pinned review round (the "review"
                                                     phase gate — verify/template/record via the same command;
                                                     --draft defaults to the hosted draft, then the tunnel)
  pingfusi review  <name> poll "question" [--choices "A,B"]   ~$0.05 mid-round micro-check with a
                                                     reviewer (advisory — never satisfies the review gate)
  pingfusi assist  <name> [--compare]                STALLED on a gate? file a reviewer ask AUTO-COMPOSED
                                                     from the failing gate's own artifacts (~$0.05 poll;
                                                     --compare files a scoped side-by-side diagnostic
                                                     round instead — advisory, never the review gate)
  pingfusi status  <name>                            phase table + the next required action
  pingfusi gate    <name> <phase>                    run ONE gate read-only (exit 0/1)
  pingfusi advance <name> <phase> [--evidence "…"] [--force]   record a phase (gate must pass)
  pingfusi advance <name> <phase> --blocked "…"      receipt an ENVIRONMENT constraint the gate's own
                                                     remedy couldn't fix, so review can still be filed
                                                     (the round documents the gap; done refuses blocked
                                                     phases until each is re-advanced with a passing gate)
  pingfusi ledger  <name>                            the audit trail (receipts)

phases (in order): ${PHASES.map((p) => p.key).join(" → ")}
docs: docs/PLAYBOOK.md (method) · docs/WORKFLOW.md (the gates) · RUNBOOK.md (fast capture)`;

function main() {
  const [cmd, name, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { console.log(HELP); process.exit(cmd ? 0 : 2); }

  // delegating subcommands make `pingfusi` the single entrypoint for installed users
  switch (cmd) {
    case "new": { if (!name || !rest[0]) { console.error("usage: pingfusi new <name> <url> [width]"); process.exit(2); } return delegate("harness/new-target.js", [name, ...rest]); }
    case "capture-build": { if (!name) { console.error("usage: pingfusi capture-build <name> [domFile] [--fixes]"); process.exit(2); } return delegate("harness/capture-build.js", [name, ...rest]); }
    case "behavior-capture": { if (!name) { console.error("usage: pingfusi behavior-capture <name> [--side both|live|clone] [--attach <port>] [--headful] [--profile] [--dry-run]"); process.exit(2); } return delegate("harness/behavior-runner.js", [name, ...rest]); }
    case "capture": { if (!name || !rest[0]) { console.error("usage: pingfusi capture open <name> | pingfusi capture pull <name> <file>|--all"); process.exit(2); } return delegate("harness/capture-remote.js", [name, ...rest]); }
    case "review": { if (!name || !rest[0]) { console.error("usage: pingfusi review <name> file|template|record|verify [args]"); process.exit(2); } return delegate("harness/review-qa.js", [rest[0], name, ...rest.slice(1)]); }
    case "assist": { if (!name) { console.error('usage: pingfusi assist <name> [--phase <key>] [--ask "…"] [--compare]'); process.exit(2); } return delegate("harness/review-qa.js", ["assist", name, ...rest]); }
    case "serve": { if (!name) { console.error("usage: pingfusi serve <name> [port]"); process.exit(2); } return delegate("harness/serve.js", [name, ...rest]); }
    case "draft": { if (!name || !rest[0]) { console.error("usage: pingfusi draft <name> push|status|delete"); process.exit(2); } return delegate("harness/draft.js", [rest[0], name]); }
    case "tunnel": { if (!name) { console.error("usage: pingfusi tunnel <name> [port] [--check]"); process.exit(2); } return delegate("harness/tunnel.js", [name, ...rest]); }
    case "score": { if (!name) { console.error("usage: pingfusi score <name>"); process.exit(2); } return delegate("harness/score.js", [name, ...rest]); }
    case "sink": return delegate("tools/sink.js", []);
    case "setup": return delegate("harness/setup.js", [name, ...rest].filter((a) => a != null));
    case "doctor": return delegate("harness/doctor.js", []);
    case "adopt": { if (!name || !rest[0]) { console.error("usage: pingfusi adopt <name> <original-url> [width]"); process.exit(2); } return delegate("harness/adopt.js", [name, ...rest]); }
    case "agent-setup": return delegate("harness/agent-setup.js", [name, ...rest].filter((a) => a != null));
    case "where": { console.log(PKG); process.exit(0); }
    case "diff": return delegate("tools/pixel-diff.js", [name, ...rest].filter((a) => a != null)); // raw diff / --inspect (paths are cwd-relative)
  }

  if (!name) { console.error(`"${cmd}" needs a <name>`); process.exit(2); }
  switch (cmd) {
    case "init": { const [url, width] = rest.filter((a) => !a.startsWith("--")); initWorkflow(name, url, width ? +width : undefined, { force: rest.includes("--force") }); console.log(`✓ workflow initialized for ${name} — ${CMD} status ${name}`); break; }
    case "status": cmdStatus(name, { assertDone: rest.includes("--assert-done"), allowForced: rest.includes("--allow-forced") }); break;
    case "gate": cmdGate(name, rest[0]); break;
    case "advance": cmdAdvance(name, rest[0], parseOpts(rest)); break;
    case "ledger": cmdLedger(name); break;
    default: console.error(`unknown command "${cmd}". run: pingfusi help`); process.exit(2);
  }
}

if (require.main === module) main();
// compareMeasured is exported so the behavior gate can be SCORED like the visual one
// (harness/benchmarks/behavior-battery.js + detection-power's A/B). Without this the
// behavior gate had no instrument at all, so no behavior-class miss could ever be promoted.
// stallInfo/STALL_AFTER/appendLedger/runId/safeGate are exported for review-qa.js's `assist`
// (streak at ask time, the assist receipt that resets it, the failing gate's reason) — one
// authority for the ledger record shape and the stall arithmetic.
module.exports = { PHASES, initWorkflow, loadState, targetDir, main, sha256OfFile, compareMeasured, STALL_AFTER, stallInfo, appendLedger, runId, safeGate };
