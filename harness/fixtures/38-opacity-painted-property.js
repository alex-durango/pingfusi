// fixtures/38-opacity-painted-property.js — THE FOOTER WAS INVISIBLE AND EVERY GATE WAS GREEN.
//
// Paid for on dtf (2026-07-13). `measure()` recorded rect, font, box, layout, parent, bg,
// underline and glyph — and no opacity. So an element at opacity 0 is BYTE-IDENTICAL in the
// snapshot to the same element at opacity 1, on any site. The gate could not see the difference
// between a painted page and an invisible one.
//
// dtf is what made it bite. Its authored hidden state is a CSS CLASS on the container —
// `.AnimateContainer { opacity: 0.0001 }` — with GSAP writing an inline `opacity: 1` when the
// container scrolls into view. A DOM serialized before a reveal bakes no inline opacity, so the
// static clone renders that section at 0.0001: invisible forever. Ten sections, INCLUDING THE
// WHOLE FOOTER. Every guard missed it, each for its own reason:
//   --visual / strict  no opacity in the schema → nothing to compare
//   coverage           the leaves have real boxes and real text → all 132 enumerate clean
//   clone-lint         its frozen-reveal regex is /opacity:\s*0(?:\.0+)?\s*[;"']/ — "0.0001"
//                      does not match, and the value lives in a CSS class, not an inline style
//   behavior-capture   its reveal hint gates on `parseFloat(cs.opacity) === 0`, and 0.0001 !== 0,
//                      so the 14 AnimateContainers never entered the inventory at all
// The stealth zero is not a trick — it is a real technique (a non-zero opacity keeps the
// compositor painting and lazy content loading). The fix must not special-case 0.0001.
//
// TWO THINGS THIS LOCKS, and the second is the one that would have shipped broken:
//   1. The capture records the EFFECTIVE (composited) opacity — the product up the ancestor
//      chain — not the element's own. A reveal hides the CONTAINER; its painted leaves each still
//      compute `opacity: 1`. An own-opacity implementation reads 1 on every leaf of an invisible
//      section and sees nothing. Check 1 fails such an implementation.
//   2. Opacity does NOT ride the PIXEL tolerance. Every other number in the schema is in px and
//      `tol` is a px budget (0.5, and operator-tunable via --tol). Opacity is unitless, 0..1.
//      On the px tolerance, an element at 1.0 vs 0.5 — half transparent, unmistakable — has
//      |Δ| = 0.5 and PASSES, and `--tol 1` blinds the check completely. It gets OPACITY_TOL
//      (0.01), which is deliberately not operator-tunable (#15: never widen a tolerance until the
//      miss fits through). Check 4 is that trap, and it passes on a naive implementation.
"use strict";
const path = require("path");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const ROOT = path.resolve(__dirname, "..", "..");
let bad = 0; const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

// ── 1. THE CAPTURE — measure() must record the EFFECTIVE opacity ─────────────────────
// Drives the REAL measure() over a DOM shim, with the 0 on the CONTAINER and the measured leaf
// at its own opacity 1 — exactly dtf's shape.
{
  const BASE = {
    fontFamily: "x", fontWeight: "400", fontSize: "16px", lineHeight: "20px", letterSpacing: "normal",
    textTransform: "none", color: "rgb(0,0,0)", textDecorationLine: "none", textDecorationThickness: "auto",
    webkitFontSmoothing: "auto", paddingTop: "0px", paddingRight: "0px", paddingBottom: "0px", paddingLeft: "0px",
    marginTop: "0px", marginRight: "0px", marginBottom: "0px", marginLeft: "0px",
    borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px",
    borderBottomStyle: "none", boxSizing: "border-box", display: "block", position: "static",
    top: "auto", left: "auto", verticalAlign: "baseline", gap: "0px",
    backgroundColor: "rgb(255,255,255)", backgroundImage: "none", opacity: "1",
    getPropertyValue() { return ""; },
  };
  const rect = { x: 0, y: 10, width: 200, height: 20, top: 10, right: 200, bottom: 30, left: 0 };
  const node = (style, parent) => ({
    tagName: "P", nodeType: 1, __style: { ...BASE, ...style },
    getBoundingClientRect: () => rect, parentElement: parent || null,
    previousElementSibling: null,
    childNodes: [{ nodeType: 3, textContent: "footer" }],
    querySelectorAll: () => [], querySelector: () => null, closest: () => null,
  });

  const prevWindow = global.window, prevGCS = global.getComputedStyle, prevDoc = global.document;
  const shimWindow = { innerWidth: 1728, innerHeight: 900, devicePixelRatio: 2 };
  global.window = shimWindow;
  global.getComputedStyle = (n) => (n && n.__style) || BASE;
  global.document = { compatMode: "CSS1Compat", createRange: () => ({ selectNodeContents() {}, getBoundingClientRect: () => rect }) };
  delete require.cache[require.resolve(path.join(ROOT, "tools", "browser-capture.js"))];
  require(path.join(ROOT, "tools", "browser-capture.js"));
  const measure = shimWindow.pxMeasure;

  const leafUnder = (containerOpacity) => node({ opacity: "1" }, node({ opacity: containerOpacity }));

  const revealed = measure(leafUnder("1"), { text: true });
  const hidden = measure(leafUnder("0.0001"), { text: true }); // container left at its authored stealth zero

  check("measure() records an `opacity` field at all (it recorded none before)",
    revealed.opacity !== undefined);
  check("…as the EFFECTIVE opacity: a leaf under a stealth-zero CONTAINER reads ~0, not its own 1",
    hidden.opacity !== undefined && hidden.opacity < 0.01);
  check("…and a leaf under a visible container reads 1",
    revealed.opacity === 1);

  global.window = prevWindow; global.getComputedStyle = prevGCS; global.document = prevDoc;
}

// ── 2–4. THE GATE — pixel-diff must compare it, on its OWN tolerance ─────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "px-opacity-"));
  const PXD = path.join(ROOT, "tools", "pixel-diff.js");
  const el = (opacity) => ({
    present: true,
    rect: { x: 0, y: 10, w: 200, h: 20, top: 10, right: 200, bottom: 30, fromRight: 1528 },
    font: { family: "x", weight: "400", size: 16, line: 20, spacing: "normal", transform: "none", color: "rgb(0,0,0)", decoration: "none", smoothing: "auto" },
    box: { padT: 0, padR: 0, padB: 0, padL: 0, marT: 0, marR: 0, marB: 0, marL: 0, bT: 0, bR: 0, bB: 0, bL: 0, sizing: "border-box" },
    layout: { display: "block", position: "static", top: "auto", left: "auto", vAlign: "baseline" },
    parent: { display: "block", gap: 0 },
    bg: "rgb(255,255,255)",
    glyph: { present: true, cx: 100, cy: 20, w: 200, h: 20 },
    ...(opacity === undefined ? {} : { opacity }),
  });
  const snap = (opacity) => ({ url: "https://x/", viewport: { width: 1728, height: 900, dpr: 2 }, mode: "CSS1Compat", elements: { t: el(opacity) } });
  const run = (liveOp, cloneOp, extraArgs = []) => {
    fs.writeFileSync(path.join(tmp, "live.json"), JSON.stringify(snap(liveOp)));
    fs.writeFileSync(path.join(tmp, "clone.json"), JSON.stringify(snap(cloneOp)));
    try {
      const out = execFileSync("node", [PXD, "--visual", ...extraArgs, "live.json", "clone.json"], { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, out };
    } catch (e) { return { code: e.status, out: (e.stdout || "") + (e.stderr || "") }; }
  };

  // THE DEFECT: identical in every other recorded property; only the composited opacity differs.
  const r = run(1, 0.0001);
  check("--visual FAILS a pair whose effective opacity differs (1 vs 0.0001) — the invisible footer",
    r.code === 1 && /opacity/.test(r.out));

  // CONTROL: a legitimately translucent mark, matching on both sides (dtf's own hero scrim at 0.2).
  check("CONTROL: a translucent mark at 0.2 on BOTH sides passes — the rule catches DIVERGENCE, not translucency",
    run(0.2, 0.2).code === 0);

  // THE TOLERANCE TRAP. A naive `add("opacity", …)` rides the PIXEL tolerance and PASSES this:
  // |1.0 − 0.5| = 0.5 ≤ tol(0.5). Half-transparent, and the gate calls it green.
  check("a half-transparent element (1.0 vs 0.5) FAILS — opacity must not ride the 0.5px tolerance",
    run(1, 0.5).code === 1);

  // …and it must not be tunable away: --tol widens a PIXEL budget, never the opacity budget.
  check("…and `--tol 2` does NOT blind it — the px budget must not widen the opacity budget (#15)",
    run(1, 0.5, ["--tol", "2"]).code === 1);

  // CONTROL: float/compositor noise below OPACITY_TOL is not a defect.
  check("CONTROL: 0.999 vs 1.0 passes — float noise is not a visible mark",
    run(1, 0.999).code === 0);

  // CONTROL: old snapshots predate the field → skipped, never retro-failed (#23).
  check("CONTROL: a snapshot with no `opacity` (older schema) is compared, not refused or failed",
    run(undefined, undefined).code === 0);
  check("CONTROL: a one-sided old schema (live has it, clone predates it) is skipped, not failed",
    run(1, undefined).code === 0);

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(bad ? `\n✗ ${bad} check(s) failed` : "\n✓ 38-opacity-painted-property: opacity is a painted mark, measured as COMPOSITED and judged on its own scale.");
process.exit(bad ? 1 : 0);
