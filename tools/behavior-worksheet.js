// tools/behavior-worksheet.js <name> — the BEHAVIOR WORKSHEET: one row per animation/
// dynamic the target is supposed to have, with its current disposition.
//
// WHY: when an agent doesn't know the complete list of things that are supposed to move,
// it conflates — the iphone17 run engineered ONE invented animation where live had TWO
// distinct behaviors (an intro animation + an inner phone video), and the reviewer had to
// catch it. The worksheet gives every behavior an IDENTITY up front, from three sources:
//   observed  — the dynamic pass saw it fire (behaviors in behaviors-live.json)
//   declared  — markers/keyframes/transitions say something is SUPPOSED to happen but it
//               never fired in this environment (`declared` in behaviors-live.json — the
//               environment-inverted case: no-js fallbacks, bot-gated choreography)
// and shows, per row: reproduced on the clone? excused in behavior-deviations.json? or
// UNRESOLVED — with a ready-to-send one-sided poll question for the reviewer ("something is
// supposed to happen at X — on the real page, what?"), because when the machine can't
// observe the truth, the reviewer is the measurement instrument.
//
// Exit 0 when every row has a disposition; exit 1 with the unresolved list otherwise —
// so "the worksheet is clean" is a checkable fact, and the behavior gate enforces the
// declared rows the same way (harness/workflow.js).
//
// USAGE
//   node tools/behavior-worksheet.js <name>
"use strict";

const fs = require("fs");
const path = require("path");

const WORK = process.cwd();
const dir = (name) => path.join(WORK, "targets", name);
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const descriptorOf = (key) => key.replace(/^[a-z-]+:/i, "");

// A declared row is REPRODUCED when the clone's dynamic pass observed the same element
// (by descriptor) actually firing — any observed prefix counts (reveal/mutation/hover/
// marquee): the clone made it move; which trigger class it landed under is secondary.
function dispositionOf(key, entry, cloneObserved, deviations) {
  const d = descriptorOf(key);
  const cloneKey = cloneObserved.find((k) => descriptorOf(k) === d);
  if (cloneKey) return { status: "reproduced", via: cloneKey };
  if (deviations[key] && String(deviations[key].reason || "").trim()) return { status: "excused", via: deviations[key].reason.slice(0, 80) };
  return { status: "UNRESOLVED" };
}

function main() {
  const name = process.argv[2];
  if (!name) { console.error("usage: node tools/behavior-worksheet.js <name>"); process.exit(2); }
  const livePath = path.join(dir(name), "behaviors-live.json");
  if (!fs.existsSync(livePath)) { console.error(`targets/${name}/behaviors-live.json missing — run discovery first (RUNBOOK "Behavior discovery")`); process.exit(1); }
  const live = read(livePath);
  let clone = {};
  try { clone = read(path.join(dir(name), "behaviors-clone.json")); } catch (e) {}
  let dev = {};
  try { dev = read(path.join(dir(name), "behavior-deviations.json")); } catch (e) {}
  const cloneObserved = Object.keys((clone && clone.behaviors) || {});

  const observed = Object.entries(live.behaviors || {});
  const declared = Object.entries(live.declared || {});
  console.log(`behavior worksheet — ${name}  (${observed.length} observed, ${declared.length} declared-unfired)`);

  const unresolved = [];
  const row = (key, evidence, disp) => {
    const mark = disp.status === "reproduced" ? "✓" : disp.status === "excused" ? "◦" : "✗";
    console.log(`  ${mark} ${disp.status.padEnd(10)} ${key}\n      evidence: ${evidence}${disp.via ? `\n      via: ${disp.via}` : ""}`);
    if (disp.status === "UNRESOLVED") unresolved.push(key);
  };
  for (const [key, b] of observed) row(key, `${b.trigger} | ${b.kind}${b.hints ? " | " + b.hints.join(",") : ""}`, dispositionOf(key, b, cloneObserved, dev));
  for (const [key, b] of declared) row(key, `${(b.hints || []).join(",")}${b.text ? ` | "${b.text}"` : ""}`, dispositionOf(key, b, cloneObserved, dev));

  if (unresolved.length) {
    console.log(`\n❌ ${unresolved.length} row(s) UNRESOLVED — each needs: reproduction in clone/fixes.js, a reasoned entry in behavior-deviations.json, or the reviewer's description of what live does. Ready-to-send one-sided poll questions:`);
    for (const key of unresolved.slice(0, 8)) {
      const b = (live.declared && live.declared[key]) || (live.behaviors && live.behaviors[key]) || {};
      const where = b.text ? `the element reading "${b.text}"` : descriptorOf(key);
      console.log(`  node harness/review-qa.js poll ${name} "On the real page, near ${where}: something is supposed to animate there (${(b.hints || [b.trigger]).slice(0, 2).join(", ")}). What happens as you scroll/interact?"`);
    }
    if (unresolved.length > 8) console.log(`  … and ${unresolved.length - 8} more`);
    process.exit(1);
  }
  console.log(`\n✓ worksheet clean — every supposed-to-move row is reproduced or excused.`);
}

main();
