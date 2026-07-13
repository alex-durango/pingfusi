// harness/enumerate-selftest.js — guards the leaf-classification rules behind
// pxEnumerateLeaves/pxCaptureAll (tools/browser-capture.js).
//
// The lesson it locks in: enumeration used to be a prose instruction each agent
// improvised per run, and an ad-hoc enumerator that under-included <video> is
// exactly how yc round 1's card-height mismatch slipped every pixel gate ("a
// gate cannot see what was never enumerated"). The rules are pure + exported
// so each class the catalog paid for is fixtured here in node — no browser.
"use strict";

const { classifyLeaf, slugName, captureAllShouldAbort } = require("../tools/browser-capture.js");

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed++; console.log(`  ✗ ${msg}`); } };

console.log("enumerate-selftest — painted-leaf classification (pure rules)");

const F = (over) => ({ tag: "div", w: 100, h: 40, hasOwnText: false, bgImage: false, bgColorDiffers: false, borderPaints: false, leafDescendants: false, hint: "", ...over });

// media tags are ALWAYS their own leaf — the yc <video> gate miss
for (const tag of ["video", "canvas", "img", "svg", "iframe"]) {
  ok(classifyLeaf(F({ tag })).leaf === true && classifyLeaf(F({ tag })).kind === "media", `<${tag}> always enumerates as a media leaf`);
}
ok(classifyLeaf(F({ tag: "video", leafDescendants: true })).leaf === true, "a media tag stays a leaf even inside a counted subtree");

// text leaves
ok(classifyLeaf(F({ hasOwnText: true })).text === true, "own text → text leaf (measured with the text/strut/underline set)");

// painted containers/boxes — the announcement-bar class
ok(classifyLeaf(F({ bgColorDiffers: true })).kind === "painted-box", "solid background with no leaf descendants → painted box");
ok(classifyLeaf(F({ bgColorDiffers: true, leafDescendants: true })).kind === "painted-container", "solid background WITH leaf descendants still enumerates (coverage: 0 missed solid-color containers)");
ok(classifyLeaf(F({ borderPaints: true })).leaf === true, "a painted border is a painted mark");
ok(classifyLeaf(F({ bgImage: true })).kind === "bg-image", "background-image paints → leaf");

// exclusions
ok(classifyLeaf(F({ tag: "script", hasOwnText: true })).leaf === false, "script never enumerates even with text content");
ok(classifyLeaf(F({ w: 0, hasOwnText: true })).leaf === false, "zero-width renders nothing → not a leaf");
ok(classifyLeaf(F({})).leaf === false, "an unpainted pass-through container is not a leaf");

// slugName: stable, hinted, collision-free
{
  const used = new Set();
  ok(slugName({ tag: "video", hint: "" }, used) === "video", "bare tag when no hint");
  ok(slugName({ tag: "a", hint: "See all jobs" }, used) === "a_see_all_jobs", "hint slugs into the name");
  ok(slugName({ tag: "a", hint: "See all jobs" }, used) === "a_see_all_jobs_2", "collision gets a deterministic ordinal");
  ok(slugName({ tag: "a", hint: "See all jobs" }, used) === "a_see_all_jobs_3", "…and the next one increments");
  ok(slugName({ tag: "div", hint: "◆◆◆" }, used) === "div", "non-alphanumeric hint falls back to the tag");
}

// pxCaptureAll honors the settle STOP contract — enforcement, not narration
ok(captureAllShouldAbort({ stable: false }) === true, "stable:false settle ABORTS the one-call capture");
ok(captureAllShouldAbort({ stable: true }) === false, "stable settle proceeds");
ok(captureAllShouldAbort("skipped") === false, "explicit settle:false skip proceeds (caller took responsibility)");

console.log(failed ? `\n❌ enumerate-selftest: ${failed} check(s) failed.` : "\n✓ enumerate-selftest: all checks pass.");
process.exit(failed ? 1 : 0);
