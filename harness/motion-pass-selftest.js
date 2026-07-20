// harness/motion-pass-selftest.js — guards the DEFAULT-ON build motion pass
// (harness/motion-pass.js, first-draft doctrine 2026-07-19). Offline and socket-free:
// the owner probe is skipped by flag (PPK_MOTION_PASS_NO_PROBE=1) and the capture-build
// seam runs against a file:// site. Contracts:
//   - a fixture motion-doc produces players + bookkeeping IDEMPOTENTLY (re-run: one
//     marker block, same item ids, regenerated player)
//   - css tiers are css-inherited with a static CSS verify (present → pass, missing →
//     warn) — and a warn NEVER makes the pass exit nonzero
//   - gsap transform channels merge into ONE clip with exact parameters (iterations
//     "infinite", direction, easing verbatim); sampled ongoing+marquee-fit → loop;
//     sampled ongoing without a fit → skipped WITH a warning, exit still 0
//   - scroll-linked and fitted tracks are receipted skips (terminal bookkeeping)
//   - no motion-doc.json → receipted no-op; corrupt doc → warning + no-op, exit 0
//   - the capture-build seam runs the pass on EVERY build and --no-motion skips it
// Run: node harness/motion-pass-selftest.js   (regression.js runs it too)
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");

const KIT = path.resolve(__dirname, "..");
const PASS = path.join(KIT, "harness", "motion-pass.js");
const BUILD = path.join(KIT, "harness", "capture-build.js");
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.stack || e}`); }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-motion-pass-"));
const env = { ...process.env, PPK_MOTION_PASS_NO_PROBE: "1" };
const runPass = (name, args = []) => spawnSync(process.execPath, [PASS, name, ...args], { cwd: work, env, encoding: "utf8" });
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(work, rel), "utf8"));

function seedTarget(name, { doc, css } = {}) {
  const dir = path.join(work, "targets", name);
  fs.mkdirSync(path.join(dir, "clone"), { recursive: true });
  fs.writeFileSync(path.join(dir, "clone", "index.html"),
    `<!doctype html><html><head><style>${css || ""}</style></head><body><div class="hero">h</div><div class="belt">b</div><div class="card">c</div><div class="raf">r</div></body></html>`);
  if (doc) fs.writeFileSync(path.join(dir, "motion-doc.json"), JSON.stringify(doc, null, 2));
  return dir;
}

const timing = (over = {}) => ({ duration_ms: 800, delay_ms: 0, iterations: 1, direction: "normal", fill: "both", ...over });
const docTimeline = { type: "document" };

// The fixture doc: one of everything the pass dispatches on.
const fixtureDoc = {
  schema: "pingfusi/motion-doc@1",
  url: "https://example.test/",
  capturedAt: "2026-07-19T00:00:00.000Z",
  viewport: null,
  tracks: [
    // css tier, declaration PRESENT in clone css → css-inherited / pass
    { id: "t-css", target: { selector: ".hero" }, property: "opacity",
      keyframes: [{ offset: 0, value: "0" }, { offset: 1, value: "1" }],
      timing: timing({ duration_ms: 1000 }), timeline: docTimeline,
      provenance: { tier: "introspected-css", source: "css-animation:fadeIn" } },
    // css tier, declaration MISSING from clone css → css-inherited / warn (never a failure)
    { id: "t-css-missing", target: { selector: ".card" }, property: "transform",
      keyframes: [{ offset: 0, value: "scale(0.9)" }, { offset: 1, value: "scale(1)" }],
      timing: timing(), timeline: docTimeline,
      provenance: { tier: "introspected-css", source: "css-animation:popIn" } },
    // gsap x + y, same tween → merged into ONE transform clip, params exact
    { id: "t-gsap-x", target: { selector: ".belt" }, property: "x",
      keyframes: [{ offset: 1, value: "120", easing: "cubic-bezier(0.333333, 1, 0.666667, 1)" }],
      timing: timing({ delay_ms: 100, iterations: "infinite", direction: "alternate" }), timeline: docTimeline,
      provenance: { tier: "introspected-gsap", source: "gsap" } },
    { id: "t-gsap-y", target: { selector: ".belt" }, property: "y",
      keyframes: [{ offset: 1, value: "40", easing: "cubic-bezier(0.333333, 1, 0.666667, 1)" }],
      timing: timing({ delay_ms: 100, iterations: "infinite", direction: "alternate" }), timeline: docTimeline,
      provenance: { tier: "introspected-gsap", source: "gsap" } },
    // waapi scroll-linked → receipted skip (no time-based player form)
    { id: "t-scroll", target: { selector: ".hero" }, property: "transform",
      keyframes: [{ offset: 0, value: "translateY(0px)" }, { offset: 1, value: "translateY(-50px)" }],
      timing: timing({ duration_ms: 0 }), timeline: { type: "scroll" },
      provenance: { tier: "introspected-waapi", source: "waapi" } },
    // sampled finite → verbatim clip. The tail is FLAT on purpose: the sampler's
    // ongoing detector (trackIsOngoing) reads a series still changing in its final
    // frames as motion that never settled, and the pass would rightly refuse a clip.
    { id: "t-sampled", target: { selector: ".card" }, property: "opacity",
      keyframes: [{ offset: 0, value: "0" }, { offset: 0.25, value: "0.5" }, { offset: 0.5, value: "1" }, { offset: 0.75, value: "1" }, { offset: 1, value: "1" }],
      timing: timing({ duration_ms: 500 }), timeline: docTimeline,
      provenance: { tier: "sampled", source: "virtual-time@60fps" } },
    // sampled ongoing + marquee fit → LOOP by law
    { id: "t-belt", target: { selector: ".belt" }, property: "opacity", ongoing: true,
      keyframes: [{ offset: 0, value: "0.1" }, { offset: 0.5, value: "0.5" }, { offset: 1, value: "0.9" }],
      timing: timing({ duration_ms: 4000 }), timeline: docTimeline,
      fit: { kind: "marquee", params: { velocityPxPerSec: 60, direction: -1, axis: "x" }, nrmse: 0.01 },
      provenance: { tier: "sampled", source: "virtual-time@60fps" } },
    // sampled ongoing, NO periodic fit → skipped with a warning (a clip would freeze)
    { id: "t-raf", target: { selector: ".raf" }, property: "transform", ongoing: true,
      keyframes: [{ offset: 0, value: "translateX(0px)" }, { offset: 0.5, value: "translateX(-200px)" }, { offset: 1, value: "translateX(-400px)" }],
      timing: timing({ duration_ms: 4000 }), timeline: docTimeline,
      provenance: { tier: "sampled", source: "virtual-time@60fps" } },
    // fitted → receipt-only skip (engine bundle machinery owns models)
    { id: "t-fit", target: { selector: ".card" }, property: "transform",
      keyframes: [{ offset: 0, value: "translateX(0px)" }, { offset: 1, value: "translateX(80px)" }],
      timing: timing({ duration_ms: 300 }), timeline: docTimeline,
      fit: { kind: "tween", params: {}, nrmse: 0.02 },
      provenance: { tier: "fitted", source: "fit:tween" } },
  ],
  assets: [
    { kind: "lottie", url: "https://example.test/anim.json", sha256: "a".repeat(64), bytes: 42, file: "motion-assets/aaaa.json" },
  ],
};

// NOTE the loop fixture: the belt's sampled property is opacity, which replayMode only
// loops for transform — so keep one real transform loop too. (t-belt above intentionally
// uses opacity to pin the OTHER rule: ongoing + marquee fit + non-transform property is
// NOT loopable → replayMode returns unloopable.) See assertions below.

try {
  const heroCss = "@keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } } .hero { animation: fadeIn 1s; }";
  seedTarget("full", { doc: fixtureDoc, css: heroCss });
  const first = runPass("full");

  test("the pass exits 0 despite warnings (warnings are never failures)", () => {
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.match(first.stdout, /⚠ motion:/, "expected warning lines on stdout");
  });

  const receipt = readJson("targets/full/motion-pass.json");
  test("the receipt is written with schema, doc pin, and track disposition counts", () => {
    assert.equal(receipt.schema, "pingfusi/motion-pass@1");
    assert.equal(receipt.ok, true);
    assert.equal(receipt.doc.file, "targets/full/motion-doc.json");
    assert.equal(receipt.tracks.total, 9);
    assert.equal(receipt.tracks.cssInherited, 2);
    assert.ok(receipt.tracks.playersApplied >= 2, JSON.stringify(receipt.tracks));
    assert.ok(receipt.warnings.length >= 2, receipt.warnings.join(" | "));
    assert.equal(receipt.ownerProbe.mode, "disabled");
  });

  test("assets are receipted, never embedded", () => {
    assert.equal(receipt.assets.length, 1);
    assert.equal(receipt.assets[0].kind, "lottie");
    assert.ok(!fs.existsSync(path.join(work, "targets", "full", "clone", "motion-assets")));
  });

  const replaySrc = fs.readFileSync(path.join(work, "targets", "full", "clone", "motion-replay.js"), "utf8");
  test("gsap transform channels merge into ONE clip with exact parameters", () => {
    assert.match(replaySrc, /translateX\(120px\) translateY\(40px\)/, "merged transform value");
    assert.match(replaySrc, /"iterations": "infinite"/);
    assert.match(replaySrc, /"direction": "alternate"/);
    assert.match(replaySrc, /cubic-bezier\(0\.333333, 1, 0\.666667, 1\)/, "easing verbatim");
    assert.match(replaySrc, /"delay": 100/);
  });

  test("sampled finite replays as a clip; ongoing-without-fit is skipped with a warning", () => {
    assert.match(replaySrc, /"selector": "\.card"/);
    assert.doesNotMatch(replaySrc, /translateX\(-400px\)/, "the ongoing rAF series must NOT ship as a clip");
    assert.ok(receipt.warnings.some((w) => /ongoing motion with no periodic fit/.test(w)), receipt.warnings.join(" | "));
    assert.ok(receipt.skipped.some((s) => s.selector === ".raf" && /ongoing/.test(s.reason)));
  });

  test("ongoing + marquee fit on a NON-transform property is unloopable, not a loop", () => {
    // replayMode only loops transform; the belt's sampled opacity track must not
    // fabricate a loop (nor a clip) — it lands in skipped with the ongoing warning.
    assert.ok(receipt.skipped.some((s) => s.selector === ".belt" && /ongoing/.test(s.reason)), JSON.stringify(receipt.skipped));
    assert.doesNotMatch(replaySrc, /"mode": "loop"/);
  });

  test("scroll-linked and fitted tracks are receipted skips", () => {
    assert.ok(receipt.skipped.some((s) => /scroll-linked/.test(s.reason)));
    assert.ok(receipt.skipped.some((s) => /fitted model reconstruction/.test(s.reason)));
  });

  const items = readJson("targets/full/motion-items.json");
  test("bookkeeping is motion-items@2: per (selector, tier), action/verify/receipt, statuses gate nothing", () => {
    assert.equal(items.schema, "pingfusi/motion-items@2");
    const byKey = Object.fromEntries(items.items.map((i) => [`${i.selector} ${i.tier}`, i]));
    const heroCssItem = byKey[".hero introspected-css"];
    assert.ok(heroCssItem, "css-inherited item for .hero");
    assert.equal(heroCssItem.action, "css-inherited");
    assert.equal(heroCssItem.verify, "pass");
    assert.equal(heroCssItem.status, "pass"); // terminal — a clean pass leaves no pending work
    assert.match(heroCssItem.receipt, /@keyframes fadeIn present/);
    assert.match(heroCssItem.receipt, /verify-introspected full pass-css-/, "deep-check command names the real item id");
    const cardCssItem = byKey[".card introspected-css"];
    assert.equal(cardCssItem.verify, "warn"); // missing @keyframes popIn
    assert.equal(cardCssItem.status, "pending");
    const gsapItem = byKey[".belt introspected-gsap"];
    assert.equal(gsapItem.action, "player-applied");
    assert.equal(gsapItem.verify, "warn"); // probe disabled → ownership unverified, honestly
    const scrollItem = byKey[".hero introspected-waapi"];
    assert.equal(scrollItem.action, "skipped");
    assert.equal(scrollItem.status, "skipped"); // receipted disposition, terminal
    for (const item of items.items) assert.equal(item.source, "motion-pass");
  });

  test("the pass is receipted in workflow.jsonl", () => {
    const lines = fs.readFileSync(path.join(work, "targets", "full", "workflow.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const ev = lines.filter((l) => l.event === "motion-pass");
    assert.ok(ev.length >= 1);
    assert.match(ev[ev.length - 1].reason, /receipts and warnings only; motion never fails a build/);
  });

  test("re-running is idempotent: one marker block, one script tag, same item ids", () => {
    const again = runPass("full");
    assert.equal(again.status, 0, again.stderr || again.stdout);
    const html = fs.readFileSync(path.join(work, "targets", "full", "clone", "index.html"), "utf8");
    assert.equal((html.match(/pingfusi:motion-replay:begin/g) || []).length, 1);
    assert.equal((html.match(/<script src="motion-replay\.js" defer><\/script>/g) || []).length, 1);
    const itemsAgain = readJson("targets/full/motion-items.json");
    assert.deepEqual(itemsAgain.items.map((i) => i.id).sort(), items.items.map((i) => i.id).sort());
  });

  test("no motion-doc.json → receipted no-op, no player written", () => {
    seedTarget("bare", {});
    const r = runPass("bare");
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const rec = readJson("targets/bare/motion-pass.json");
    assert.equal(rec.noop, true);
    assert.match(rec.summary, /no motion-doc\.json/);
    assert.ok(!fs.existsSync(path.join(work, "targets", "bare", "clone", "motion-replay.js")));
  });

  test("a corrupt motion-doc.json is a warning + no-op, never a failure", () => {
    const dir = seedTarget("corrupt", {});
    fs.writeFileSync(path.join(dir, "motion-doc.json"), "{not json");
    const r = runPass("corrupt");
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const rec = readJson("targets/corrupt/motion-pass.json");
    assert.equal(rec.noop, true);
    assert.ok(rec.warnings.some((w) => /unreadable/.test(w)), rec.warnings.join(" | "));
  });

  // ── the capture-build seam: the pass runs on EVERY build; --no-motion skips it ────────
  const site = path.join(work, "site");
  fs.mkdirSync(site, { recursive: true });
  const origin = pathToFileURL(site).href;
  const seedBuildTarget = (name) => {
    const dir = path.join(work, "targets", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "target.json"), JSON.stringify({ url: `${origin}/`, width: 1280 }));
    fs.writeFileSync(path.join(dir, "dom.html"), "<!doctype html><html><head></head><body>ok</body></html>");
    return dir;
  };

  test("capture-build runs the motion pass automatically (receipted no-op without a doc)", () => {
    seedBuildTarget("built");
    const r = spawnSync(process.execPath, [BUILD, "built"], { cwd: work, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /motion pass: no-op — no motion-doc\.json/);
    assert.ok(fs.existsSync(path.join(work, "targets", "built", "motion-pass.json")));
  });

  test("capture-build --no-motion skips the pass (and says so)", () => {
    seedBuildTarget("skipped");
    const r = spawnSync(process.execPath, [BUILD, "skipped", "--no-motion"], { cwd: work, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /motion pass: skipped \(--no-motion\)/);
    assert.ok(!fs.existsSync(path.join(work, "targets", "skipped", "motion-pass.json")));
  });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(failed ? `\n❌ motion-pass-selftest: ${failed} check(s) failed.` : "\n✓ motion-pass-selftest: the default-on pass applies players idempotently, receipts every disposition, warns without failing, and --no-motion skips it.");
process.exit(failed ? 1 : 0);
