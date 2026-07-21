// fixtures/47-phase-freeze.js — MEASUREMENT MUST HAPPEN AT A FIXED ANIMATION PHASE ON BOTH SIDES.
//
// Paid for TWICE on mindmarket (2026-07-20, kit 0.9.0): the belts never settle by design, so
// live and clone snapshots of a CORRECT clone landed at phases determined by when each page
// happened to load — and visual/strict failed with 334–336 constant-offset deltas, both runs,
// with nothing wrong with the clone (LEARNINGS #38). The settle wait cannot fix this; the
// animation never settles. The fix is the phase-freeze in tools/browser-capture.js:
//
//   1. pxFreezeAnimations() pauses every declared (document.getAnimations) animation still
//      RUNNING and seeks it to progress 0 of its CURRENT iteration — the canonical measure
//      phase, identical on both sides regardless of load time. Kit players freeze their own
//      writers first via window.__pingfusiFreezeHooks. Finished/idle animations, page-authored
//      pauses, scroll-linked timelines and the agent overlay are left alone, receipted by count.
//   2. rAF-driven motion owns no Animation object and CANNOT be paused generically — the
//      post-freeze watch receipts those selectors as `unfreezable`, and marks inside their
//      subtrees are EXCLUDED from pixel-determining comparisons: receipted per mark in the
//      snapshot's `freeze` field, LISTED by pixel-diff and the gates, never silently dropped.
//
// This fixture pins: (a) the freeze seeks phase-shifted WAAPI to phase 0 on both sides
// (deterministic boxes); (b) the emitted motion-replay player registers the freeze hook and
// freezes ONLY its own animations; (c) unfreezable-subtree exclusion is receipted + listed at
// the tool layer; (d) the visual/strict GATES go green on a phase-shifted-but-correct pair
// that FAILS without the change — and the exclusion is named in the gate output.
"use strict";
let bad = 0;
const check = (n, c, detail) => { console.log(`${c ? "✓" : "✗"} ${n}${c || !detail ? "" : ` — ${detail}`}`); if (!c) bad++; };

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const CAPTURE = require.resolve(path.join(ROOT, "tools", "browser-capture.js"));
const { diffSnapshots, formatDiff } = require(path.join(ROOT, "tools", "pixel-diff.js"));

// ── mock DOM (the fixture 42 harness pattern) ─────────────────────────────────
const allDescendants = (node) => {
  const out = [];
  const walk = (n) => { for (const c of n.children || []) { out.push(c); walk(c); } };
  walk(node);
  return out;
};
const el = (tag, opts = {}) => {
  const e = {
    nodeType: 1, tagName: tag.toUpperCase(), id: opts.id || "",
    children: [], parentElement: null,
    computed: opts.computed || {},
    matches: opts.matches || (() => false),
    closest: () => null,
    getAttribute: () => null,
  };
  e.querySelectorAll = (q) => (q === "*" ? allDescendants(e) : []);
  return e;
};
const append = (parent, child) => { child.parentElement = parent; parent.children.push(child); return child; };

// A fake WAAPI Animation, phase-shifted by construction: currentTime is wherever the
// page's load time left it.
const fakeAnim = (over = {}) => {
  const timing = over.timing || { duration: 1000, delay: 0, iterations: Infinity, currentIteration: 0 };
  const a = {
    id: over.id || "",
    playState: over.playState || "running",
    currentTime: over.currentTime != null ? over.currentTime : 4321,
    pauseCalls: 0,
    pause() { this.pauseCalls++; this.playState = "paused"; },
    effect: { target: over.target || null, getComputedTiming: () => timing },
  };
  if (over.animationName) a.animationName = over.animationName;
  return a;
};

function loadCapture(env) {
  global.window = global;
  global.document = env.document;
  global.getComputedStyle = (e) => (e && e.computed) || {};
  if (env.ScrollTimeline) global.ScrollTimeline = env.ScrollTimeline; else delete global.ScrollTimeline;
  delete global.ViewTimeline;
  delete global.MutationObserver;
  delete global.__pingfusiFreezeHooks;
  if (env.hooks) global.__pingfusiFreezeHooks = env.hooks;
  delete require.cache[CAPTURE];
  require(CAPTURE);
}

(async () => {
  // ── 1. the freeze: phase-shifted WAAPI lands at phase 0 on BOTH sides ─────────
  // Two "sides" of the same page, loaded at different moments: same animations, different
  // currentTime/currentIteration. After the freeze both must sit paused at progress 0 of
  // their iteration — the pose a normal-direction loop renders identically every cycle.
  {
    const runSide = (currentTime, currentIteration) => {
      const belt = el("div", { id: "belt" });
      const spin = fakeAnim({
        target: belt, animationName: "drift", currentTime,
        timing: { duration: 1000, delay: 250, iterations: Infinity, currentIteration },
      });
      const finished = fakeAnim({ target: el("div", { id: "reveal" }), playState: "finished", currentTime: 600 });
      const authored = fakeAnim({ target: el("div", { id: "posed" }), playState: "paused", currentTime: 333 });
      const scrolled = fakeAnim({ target: el("div", { id: "bar" }) });
      const kit = fakeAnim({ target: el("div", { id: "replayed" }), id: "pingfusi:motion-replay", currentTime: 777 });
      const agent = fakeAnim({ target: el("div", { id: "claude-agent-glow-border", matches: (s) => s.indexOf("claude-agent-") !== -1 }) });
      const ST = class ScrollTimeline {};
      scrolled.timeline = new ST();
      loadCapture({ document: { getAnimations: () => [spin, finished, authored, scrolled, kit, agent], querySelectorAll: () => [] }, ScrollTimeline: ST });
      return { spin, finished, authored, scrolled, kit, agent, receipt: null };
    };

    const a = runSide(5250 + 617, 5);   // loaded long ago: iteration 5, 617ms into it
    a.receipt = await global.pxFreezeAnimations({ watchIntervalMs: 5, watchIntervals: 2 });
    const b = runSide(1250 + 112, 1);   // loaded just now: iteration 1, 112ms into it
    b.receipt = await global.pxFreezeAnimations({ watchIntervalMs: 5, watchIntervals: 2 });

    const phase = (anim) => (anim.currentTime - 250) % 1000; // delay 250, duration 1000
    check("a running phase-shifted animation is PAUSED and seeked to progress 0 of its iteration — on both sides",
      a.spin.pauseCalls === 1 && b.spin.pauseCalls === 1 && phase(a.spin) === 0 && phase(b.spin) === 0,
      JSON.stringify({ a: a.spin.currentTime, b: b.spin.currentTime }));
    check("…which is the SAME pose on both sides (deterministic boxes): progress 0, iteration preserved",
      a.spin.currentTime === 250 + 5 * 1000 && b.spin.currentTime === 250 + 1 * 1000);
    check("the freeze is receipted: count + ids (css:<name>@<selector>)",
      a.receipt.frozen === 1 && a.receipt.ids.length === 1 && a.receipt.ids[0] === "css:drift@#belt");
    check("a FINISHED animation is untouched — its end state IS the settled page",
      a.finished.pauseCalls === 0 && a.finished.currentTime === 600 && a.receipt.skipped.finished === 1);
    check("a page-authored PAUSED animation is untouched (a deliberate pose), counted",
      a.authored.pauseCalls === 0 && a.authored.currentTime === 333 && a.receipt.alreadyPaused === 1);
    check("a scroll-linked animation is skipped — scroll position already fixes its phase",
      a.scrolled.pauseCalls === 0 && a.receipt.skipped.scrollLinked === 1);
    check("kit-player animations are the hook's business, not the generic pass's",
      a.kit.pauseCalls === 0 && a.receipt.skipped.kitPlayer === 1);
    check("the agent's own overlay is never adjusted (the instrument must not touch itself)",
      a.agent.pauseCalls === 0 && a.receipt.skipped.agentDom === 1);
    check("no watchable DOM → the watch is receipted as unavailable-or-empty, never a throw",
      a.receipt.watch && (a.receipt.watch.ran === true || typeof a.receipt.watch.reason === "string"));
  }

  // ── 2. the hook registry + the post-freeze watch (rAF movers are UNFREEZABLE) ──
  {
    // The page: a body whose descendant .rail is driven by a rAF loop (its computed
    // transform changes on every read — no Animation object anywhere), plus a static box.
    let tick = 0;
    const body = el("body", { computed: { transform: "none", opacity: "1" } });
    const rail = append(body, el("div", { id: "rail" }));
    rail.computed = { get transform() { return `matrix(1, 0, 0, 1, ${tick++}, 0)`; }, opacity: "1" };
    const box = append(body, el("div", { id: "box", computed: { transform: "matrix(1, 0, 0, 1, 4, 0)", opacity: "1" } }));
    void box;
    const hookReceipts = [];
    const hooks = [() => { hookReceipts.push("called"); return { player: "motion-replay", frozen: 2, ids: ["pingfusi:motion-replay"] }; }];
    loadCapture({ document: { getAnimations: () => [], querySelectorAll: (sel) => (sel === "body" ? [body] : []) }, hooks });
    const receipt = await global.pxFreezeAnimations({ unfreezable: [".known-belt"], watchIntervalMs: 5, watchIntervals: 2 });
    check("registered kit-player freeze hooks are CALLED and their receipts kept",
      hookReceipts.length === 1 && receipt.players.length === 1 && receipt.players[0].player === "motion-replay" && receipt.players[0].frozen === 2);
    check("the post-freeze watch catches the rAF mover (moved every interval) — receipted stillMoving + unfreezable",
      receipt.stillMoving.length === 1 && receipt.stillMoving[0] === "#rail" && receipt.unfreezable.includes("#rail"),
      JSON.stringify(receipt.stillMoving));
    check("the static element is NOT flagged, and the caller-known list is merged in",
      !receipt.stillMoving.includes("#box") && receipt.unfreezable.includes(".known-belt"));
    check("the watch is receipted (intervals, tracked count)",
      receipt.watch.ran === true && receipt.watch.intervals === 2 && receipt.watch.tracked >= 2);

    // pxMarksInSubtrees: enumerated marks inside the mover's subtree, keyed by slug name.
    const item = append(rail, el("span", { id: "item" }));
    item.computed = { opacity: "1" };
    global.document.body = body;
    // minimal enumeration shims: rects + text for leafFacts/classifyLeaf
    for (const n of [body, rail, item, box]) {
      n.getBoundingClientRect = () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 });
      n.childNodes = [];
      n.closest = n.closest || (() => null);
    }
    item.childNodes = [{ nodeType: 3, textContent: "belt item" }];
    item.closest = (sel) => (sel === "#rail" ? rail : null);
    rail.closest = (sel) => (sel === "#rail" ? rail : null);
    body.computed = { transform: "none", opacity: "1", backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none" };
    for (const n of [rail, item, box]) n.computed.backgroundColor = "rgba(0, 0, 0, 0)";
    for (const n of [rail, item, box]) n.computed.backgroundImage = "none";
    const marks = global.pxMarksInSubtrees(["#rail"]);
    check("pxMarksInSubtrees: marks inside the unfreezable mover's subtree, keyed by the snapshot's slug names",
      Object.keys(marks).length >= 1 && Object.values(marks).every((s) => s === "#rail") && Object.keys(marks).some((k) => /item/.test(k)),
      JSON.stringify(marks));
  }

  // ── 3. the EMITTED player registers the freeze hook and freezes ONLY its own ──
  {
    const motionApply = require(path.join(ROOT, "harness", "motion-apply.js"));
    const source = motionApply.renderReplay(
      { schema: "pingfusi/motion-replay@2", at: "now", target: "fx", doc: { file: "x", sha256_16: "0" }, items: [] },
      [{ id: "m1", trigger: "load", start: "load", observe: null, tracks: [{ selector: ".hero", property: "transform", mode: "clip", keyframes: [{ offset: 0, value: "translateX(0px)" }, { offset: 1, value: "translateX(30px)" }], duration: 100, delay: 40 }] }]
    );
    const mockEl = () => {
      const e = {
        scrollWidth: 800, scrollHeight: 640, style: {}, _anims: [],
        animate(keyframes, timing) {
          const a = {
            keyframes, timing, id: null, onfinish: null, canceled: false, paused: false, currentTime: 987,
            cancel() { this.canceled = true; },
            pause() { this.paused = true; },
            effect: { getComputedTiming: () => ({ delay: timing.delay || 0 }) },
          };
          e._anims.push(a);
          return a;
        },
        getAnimations() { return e._anims.filter((a) => !a.canceled); },
      };
      return e;
    };
    const hero = mockEl();
    const siteAnim = { id: "site-owned", paused: false, currentTime: 555, pause() { this.paused = true; } };
    const sandbox = {
      document: {
        readyState: "complete", addEventListener: () => {},
        querySelectorAll: (sel) => (sel === ".hero" ? [hero] : []),
        getAnimations: () => [...hero._anims, siteAnim],
      },
    };
    sandbox.window = sandbox;
    vm.runInNewContext(source, sandbox);
    check("the emitted player registers exactly one freeze hook on window.__pingfusiFreezeHooks",
      Array.isArray(sandbox.window.__pingfusiFreezeHooks) && sandbox.window.__pingfusiFreezeHooks.length === 1);
    const hookOut = sandbox.window.__pingfusiFreezeHooks[0]();
    check("the hook pauses + seeks the player's OWN animations to phase 0 (the clip's delay) and receipts them",
      hookOut.player === "motion-replay" && hookOut.frozen === 1 &&
      hero._anims[0].paused === true && hero._anims[0].currentTime === 40,
      JSON.stringify(hookOut));
    check("a site-owned animation is NEVER touched by the player's hook",
      siteAnim.paused === false && siteAnim.currentTime === 555);
  }

  // ── 4. exclusion at the tool layer: receipted, LISTED, never a silent drop ────
  const mark = (shift = 0) => ({
    present: true,
    rect: { x: 100, y: 80 + shift, w: 180, h: 17, top: 80 + shift, right: 280, bottom: 97 + shift, fromRight: 200 },
    font: { family: "f", weight: "400", size: 14, line: 18, spacing: "normal", transform: "none",
            color: "rgb(0,0,0)", decoration: "none", smoothing: "antialiased", underline: false },
    box: {}, layout: { display: "block", position: "static" }, parent: { display: "block", gap: 0 },
    text: { x: 100, right: 280, top: 80 + shift, bottom: 97 + shift, w: 180, h: 17 },
    underline: { present: false }, bg: "rgb(255,255,255)",
  });
  const snapOf = (elements, freeze) => ({ viewport: { width: 1728, height: 982, dpr: 2 }, mode: "CSS1Compat", elements, ...(freeze ? { freeze } : {}) });
  {
    // The mindmarket shape: the belt mark is at a different phase (constant offset), the
    // rest of the page is correct.
    const live = snapOf({ nav: mark(), belt: mark(137) });
    const clone = snapOf({ nav: mark(), belt: mark() });
    const before = diffSnapshots(live, clone, { visual: true });
    check("FAILS WITHOUT THE CHANGE: the phase-shifted mark shows constant-offset deltas on a correct clone",
      before.ok === false && before.summary.failures > 0 && before.excluded.length === 0);

    const liveFrozen = snapOf({ nav: mark(), belt: mark(137) }, { frozen: 3, ids: [], unfreezable: [".rail"], excludedMarks: { belt: ".rail" } });
    const after = diffSnapshots(liveFrozen, clone, { visual: true });
    check("PASSES WITH THE RECEIPT: the mark inside the unfreezable mover's subtree is excluded",
      after.ok === true && after.summary.failures === 0 && after.summary.excluded === 1 &&
      after.excluded[0].target === "belt" && after.excluded[0].selector === ".rail" && after.excluded[0].sides.join(",") === "live");
    check("formatDiff LISTS the exclusion by mark and mover — never a silent drop",
      /EXCLUDED/.test(formatDiff(after)) && /belt {2}\(mover \.rail; receipted by live\)/.test(formatDiff(after)) && /1 mark\(s\) excluded/.test(formatDiff(after)));
    check("strict excludes the same mark on the same receipt",
      diffSnapshots(liveFrozen, clone, {}).ok === true && diffSnapshots(liveFrozen, clone, {}).excluded.length === 1);
    check("the CLONE side's receipt excludes too (either side may know the mover)",
      diffSnapshots(live, snapOf({ nav: mark(), belt: mark() }, { excludedMarks: { belt: ".rail" } }), { visual: true }).ok === true);

    // CONTROL: exclusion must not launder unrelated misses, and old snapshots change nothing.
    const liveBad = snapOf({ nav: mark(9), belt: mark(137) }, { excludedMarks: { belt: ".rail" } });
    const ctrl = diffSnapshots(liveBad, clone, { visual: true });
    check("CONTROL: an unrelated failing mark STILL fails — exclusion covers only the receipted subtree",
      ctrl.ok === false && ctrl.rows.some((r) => r.target === "nav" && !r.pass) && ctrl.excluded.length === 1);
    check("CONTROL: snapshots with no freeze field (older schema / interactive path) behave exactly as before",
      diffSnapshots(snapOf({ nav: mark() }), snapOf({ nav: mark() }), { visual: true }).ok === true);
  }

  // ── 5. the GATES: green on the phase-shifted-but-correct pair, exclusion NAMED ──
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppk-pfz-"));
    const dir = path.join(tmp, "targets", "pfz");
    fs.mkdirSync(path.join(dir, "clone"), { recursive: true });
    const WF = path.join(ROOT, "harness", "workflow.js");
    const write = (freeze) => {
      fs.writeFileSync(path.join(dir, "target.json"), JSON.stringify({ name: "pfz", url: "https://x.test/", width: 1728, region: "page" }));
      fs.writeFileSync(path.join(dir, "live.json"), JSON.stringify(snapOf({ nav: mark(), belt: mark(137) }, freeze)));
      fs.writeFileSync(path.join(dir, "clone.json"), JSON.stringify(snapOf({ nav: mark(), belt: mark() })));
      fs.writeFileSync(path.join(dir, "clone", "index.html"), "<!doctype html><html><body><p>x</p></body></html>");
      if (!fs.existsSync(path.join(dir, "workflow.json"))) execFileSync("node", [WF, "init", "pfz"], { cwd: tmp, stdio: "ignore" });
    };
    const gate = (which) => {
      try { return { code: 0, out: execFileSync("node", [WF, "gate", "pfz", which], { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
      catch (e) { return { code: e.status, out: (e.stdout || "") + (e.stderr || "") }; }
    };

    write(null);
    check("FAILS WITHOUT THE CHANGE: the visual gate is red on a phase-shifted-but-correct pair", gate("visual").code !== 0);

    write({ frozen: 3, ids: [], unfreezable: [".rail"], excludedMarks: { belt: ".rail" } });
    const v = gate("visual");
    check("PASSES WITH THE RECEIPT: the visual gate is green", v.code === 0, v.out.slice(0, 300));
    check("…and the gate output NAMES the excluded mark and its mover (listed, never silent)",
      /EXCLUDED/.test(v.out) && /belt \(\.rail\)/.test(v.out), v.out.slice(0, 300));
    const s = gate("strict");
    check("the strict gate is green on the same receipt, exclusion named there too",
      s.code === 0 && /EXCLUDED/.test(s.out) && /belt \(\.rail\)/.test(s.out), s.out.slice(0, 300));

    // The TOOL layer must agree with the gate (fixture 33's lesson: a guard that lives
    // only in the gate is a guard the operator walks around).
    const PXD = path.join(ROOT, "tools", "pixel-diff.js");
    const diffCli = () => {
      try { return { code: 0, out: execFileSync("node", [PXD, "--visual", "live.json", "clone.json"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
      catch (e) { return { code: e.status, out: (e.stdout || "") + (e.stderr || "") }; }
    };
    const cli = diffCli();
    check("pixel-diff CLI: exit 0 with the receipt, exclusion LISTED in the output",
      cli.code === 0 && /EXCLUDED/.test(cli.out) && /belt/.test(cli.out), cli.out.slice(0, 300));
    write(null);
    check("pixel-diff CLI: exit 1 without it (the tool layer agrees with the gate)", diffCli().code === 1);

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(bad ? `\n✗ ${bad} check(s) failed` : "\n✓ 47-phase-freeze: both sides measure at phase 0; what cannot freeze is excluded out loud, and the gates say so.");
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("47-phase-freeze crashed:", e); process.exit(1); });
