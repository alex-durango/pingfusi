// fixtures/48-temporal-satisfied-by-motion.js — the behavior gate must not contradict the
// first-draft doctrine on temporal rows (reveal:/mutation:/startup:).
//
// Paid for on real reviewed runs (2026-07-20, kit 0.9.0): the behavior gate demanded temporal
// rows be reproduced in the clone or entered in behavior-deviations.json — while the doctrine
// BARS temporal evidence from that file and motion never gates. No legitimate channel existed;
// agents had to `advance --blocked` citing the doctrine at the kit's own gate. The motion pass
// ALREADY reproduces these rows in the draft (captured CSS carries the css/transition tiers,
// other tiers get generated WAAPI players) and receipts every one — motion-items@2 items per
// (selector, tier) acted on, generated from motion-doc tracks — the gate just never read its
// own receipts. Clone-side discovery does not re-observe the pass's reproduction as the same
// row, so "missing from behaviors-clone.json" was manufacturing a miss on correct drafts.
//
// The rule: a temporal row missing from the clone inventory is
//   - SATISFIED-BY-MOTION (informational, cited with the receipt id) when its element carries
//     a motion receipt: an @2 item matched by selector/scope, an item owning the behavior key
//     by lineage, or a motion-doc track for the selector;
//   - an ADVISORY routed at the motion utilities when it carries none;
//   - NEVER a demand for a behavior-deviations.json entry. Non-temporal interaction/state
//     rows keep the hard miss (deviations stays their honest channel).
// Same doctrine-honesty class in strict: the paint refusal must state that the --blocked
// receipt IS accepted (done stays red until re-earned) instead of reading as "fix or nothing".
const { execFileSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
let bad = 0; const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

const KIT = path.join(__dirname, "..", "..");
const WF = path.join(KIT, "harness", "workflow.js");

const run = (cwd, args) => {
  try { return { code: 0, out: execFileSync("node", [WF, ...args], { cwd, stdio: "pipe" }).toString() }; }
  catch (e) { return { code: e.status, out: (e.stdout || "").toString() + (e.stderr || "").toString() }; }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppk-temporal-motion-"));
const dir = path.join(tmp, "targets", "t");
fs.mkdirSync(dir, { recursive: true });
const writeJson = (f, o) => fs.writeFileSync(path.join(dir, f), JSON.stringify(o, null, 2));

writeJson("target.json", { name: "t", url: "https://x.test/", width: 1728 });
run(tmp, ["init", "t"]);

// live discovery observed three TEMPORAL phenomena; clone discovery re-observed none of
// them (the motion pass owns their reproduction — players don't re-fire the sweep's rows)
const discovery = { elementsScanned: 200, scrollSweep: { from: 0, to: 3000, steps: 5 }, observeMs: 1500, documentHidden: false };
const temporalRows = {
  "reveal:div.fade-up": { trigger: "scroll", kind: "class-toggle-or-style-mutation", selector: "div.fade-up", measured: { changed: true, after: { opacity: 1, transform: "none", filter: "none" } } },
  "startup:#loader": { trigger: "load", kind: "animation", selector: "#loader", measured: { before: { opacity: 0 }, after: { opacity: 1 }, durationMs: 900 } },
  "mutation:div.ticker": { trigger: "mutation", kind: "observed-mutation", selector: "div.ticker", measured: { after: { opacity: 1, transform: "matrix(1, 0, 0, 1, 0, -40)", filter: "none" } } },
};
writeJson("behaviors-live.json", { url: "https://x.test/", discovery, behaviors: temporalRows });
writeJson("behaviors-clone.json", { url: "http://localhost:8080/", discovery, behaviors: {} });

// ---------- 1. RECEIPTED: all three rows map to motion receipts → satisfied-by-motion ----------
// one receipt of each kind: @2 pass item by selector, lineage item by behavior key, doc track
writeJson("motion-items.json", {
  schema: "pingfusi/motion-items@2",
  items: [
    { id: "pass-css-0badcafe", selector: "div.fade-up", scope: "div.fade-up", tier: "introspected-css", action: "css-inherited", verify: "pass", source: "motion-pass", status: "pass" },
    { id: "owned-loader", kind: "animation", status: "pass", sourceBehaviorKeys: ["startup:#loader"] },
  ],
});
writeJson("motion-doc.json", { schema: "pingfusi/motion-doc@1", tracks: [{ id: "trk-ticker", target: { selector: "div.ticker" }, provenance: { tier: "sampled" } }] });
{
  const r = run(tmp, ["gate", "t", "behavior"]);
  check("behavior gate is GREEN when every missing temporal row carries a motion receipt (the miss-B fix)", r.code === 0);
  check("  …and the receipt carries the informational satisfied-by-motion line", /3 temporal row\(s\) satisfied by motion receipts/.test(r.out));
  check("  …citing each row → receipt id mapping", /reveal:div\.fade-up → pass-css-0badcafe/.test(r.out) && /startup:#loader → owned-loader/.test(r.out) && /mutation:div\.ticker → trk-ticker/.test(r.out));
  check("  …and never demands a deviations entry for them", !/document why in targets/.test(r.out) && !/MISSING/.test(r.out));
}

// ---------- 2. UNRECEIPTED: temporal rows degrade to an advisory, never an error ----------
fs.rmSync(path.join(dir, "motion-items.json"));
fs.rmSync(path.join(dir, "motion-doc.json"));
{
  const r = run(tmp, ["gate", "t", "behavior"]);
  check("temporal rows with NO motion receipt are ADVISORY — the gate still exits 0", r.code === 0);
  check("  …the advisory names them and their missing receipts", /3 temporal row\(s\) not re-observed on the clone and carrying NO motion receipt/.test(r.out) && /reveal:div\.fade-up/.test(r.out));
  check("  …and routes at the motion utilities, not the deviations file", /never require behavior-deviations\.json/.test(r.out) && /next t\b/.test(r.out) && !/document why in targets/.test(r.out));
}

// ---------- 3. CONTROL: a non-temporal interaction row missing from the clone still blocks ----------
{
  const behaviors = { ...temporalRows, "hover:.nav-menu": { trigger: "hover", kind: "hover-mount", selector: ".nav-menu", measured: { changed: true } } };
  writeJson("behaviors-live.json", { url: "https://x.test/", discovery, behaviors });
  const r = run(tmp, ["gate", "t", "behavior"]);
  check("CONTROL — a missing interaction/state row is still a hard miss (exit 1)", r.code === 1);
  check("  …named as MISSING with the deviations channel offered (correct for non-temporal rows)", /MISSING/.test(r.out) && /hover:\.nav-menu/.test(r.out) && /behavior-deviations\.json/.test(r.out));
  check("  …and the temporal rows are NOT in the miss list", !/reveal:div\.fade-up/.test(r.out) && !/startup:#loader/.test(r.out));
}

// ---------- 4. STRICT: the paint refusal states the --blocked receipt is ACCEPTED ----------
const el = (extra = {}) => ({ present: true, rect: { x: 0, y: 0, w: 10, h: 10, top: 0, right: 10, bottom: 10, fromRight: 0 }, ...extra });
const font = (color) => ({ weight: "400", size: 14, line: 20, spacing: "normal", transform: "none", color, decoration: "none", smoothing: "auto" });
const text = { x: 0, right: 5, top: 0, bottom: 5, w: 5, h: 5 };
writeJson("live.json", { viewport: { width: 1728 }, elements: { nav_first: el({ text, font: font("rgb(0,0,0)") }) } });
writeJson("clone.json", { viewport: { width: 1728 }, elements: { nav_first: el({ text, font: font("rgb(255,0,0)") }) } });
{
  const r = run(tmp, ["gate", "t", "strict"]);
  check("strict still FAILS on a paint delta (deviations.json can never document it away)", r.code === 1 && /PAINT delta/.test(r.out) && /deviations\.json/.test(r.out));
  check("  …and states the --blocked receipt IS accepted instead of implying it is refused", /--blocked/.test(r.out) && /IS accepted/.test(r.out));
  check("  …and says done stays red until the gate is re-earned (the receipt keeps done honest)", /done stays red until the phase re-earns a passing gate/.test(r.out));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad ? `\n✗ ${bad} check(s) failed` : "\n✓ 48-temporal-satisfied-by-motion: temporal rows follow the doctrine — receipts satisfy, absence advises, deviations are never demanded, and strict names the accepted escape.");
process.exit(bad ? 1 : 0);
