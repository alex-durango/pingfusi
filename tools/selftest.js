// selftest.js — guards the DIFF ENGINE itself (run: node tools/selftest.js)
//
// The kit's whole promise is "a green --visual means it looks identical." That promise
// is only as good as the properties the diff actually compares. Two classes of miss
// (an underline measured as a boolean; -webkit-font-smoothing not measured) each cost
// several operator rounds before they were added to the gate (LEARNINGS #12, #13). This
// file locks those in: it feeds diffSnapshots synthetic snapshots and asserts that
//   (a) an identical pair PASSES, and
//   (b) the exact defects that used to slip a green sweep now FAIL, on the named props.
// If someone later refactors pixel-diff.js and drops one of these comparisons, this
// test goes red — the guarantee can't silently regress. Zero deps.

const { diffSnapshots } = require("./pixel-diff.js");

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? "✓" : "✗"} ${name}`); if (!cond) failures++; };

// A minimal text target (the "sign in" label) with the marks the gate must compare.
const signin = (over = {}) => ({
  present: true,
  rect: { x: 1395, y: 81, w: 186, h: 17, top: 81, right: 1581, bottom: 98, fromRight: 147 },
  font: {
    family: "proxima-nova", weight: "600", size: 14, line: 18.2, spacing: 0.7,
    transform: "uppercase", color: "rgb(0, 0, 0)", decoration: "none",
    smoothing: "antialiased", underline: true,
    ...(over.font || {}),
  },
  box: {}, layout: {}, parent: { display: "flex", gap: 8 },
  text: { x: 1395, right: 1581, top: 81, bottom: 98, w: 186, h: 17 },
  // the underline as a BOX (drawn by an ancestor border-bottom), not a boolean:
  underline: { present: true, thickness: 2, x: 1369, right: 1581, w: 212, top: 100, bottom: 102,
    ...(over.underline || {}) },
});

const snap = (el) => ({ viewport: { width: 1728 }, elements: { signin: el } });
const failedProps = (res) => res.rows.filter((r) => !r.pass).map((r) => r.prop);

// 1) identical → --visual PASSES
{
  const res = diffSnapshots(snap(signin()), snap(signin()), { visual: true });
  check("identical pair passes --visual", res.ok);
}

// 2) the ORIGINAL defects (LEARNINGS #12/#13) → --visual FAILS on the named props
{
  const bad = signin({
    font: { smoothing: "auto" },                                   // #13 perceived weight
    underline: { thickness: 1, x: 1395, w: 186, top: 98, bottom: 99 }, // #12 thin / text-only / wrong Y
  });
  const res = diffSnapshots(snap(signin()), snap(bad), { visual: true });
  const props = failedProps(res);
  check("smoothing regression fails", !res.ok && props.includes("font.smoothing"));
  check("underline thickness fails", props.includes("underline.thickness"));
  check("underline width fails", props.includes("underline.w"));
  check("underline x-offset fails", props.includes("underline.x"));
  check("underline vertical fails", props.includes("underline.top") || props.includes("underline.bottom"));
}

// 3) a present underline on one side only is caught (not silently skipped)
{
  const noUnderline = signin({ font: { underline: false }, underline: { present: false } });
  const res = diffSnapshots(snap(signin()), snap(noUnderline), { visual: true });
  check("missing underline is caught", !res.ok && failedProps(res).includes("underline.present"));
}

console.log(failures ? `\n❌ selftest: ${failures} check(s) failed — the diff gate has a hole.` : "\n✓ selftest: the gate compares underline-box + smoothing as required.");
process.exit(failures ? 1 : 0);
