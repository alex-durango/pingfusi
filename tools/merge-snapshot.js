// tools/merge-snapshot.js <full.json> <partial.json> — fold a PARTIAL re-capture into a
// full snapshot, for the fix-loop's inner iterations.
//
// WHY: the slow half of a verification round is the browser capture, not the diff — and
// after a one-element fix, re-capturing all N targets to re-run a gate wastes minutes per
// iteration (astryx: 35-target full captures for single-region fixes, dozens of times).
// Capture ONLY the affected targets instead (`pxSend(url, subsetTargets)`), then fold them
// in here: elements present in the partial overwrite their counterparts in the full file;
// everything else carries over. Gates then run on the merged file in seconds.
//
// HONESTY CONTRACT: a merged snapshot is an ITERATION artifact, not a proof — the
// carried-over elements' measurements are only as fresh as the last full capture, and a fix
// can shift things outside the subset you re-measured (astryx's bento-height fix moved the
// FOOTER). So every merge stamps `merged:{at,keys}` into the snapshot root, and the `done`
// gate REFUSES stamped snapshots: one final full capture (which clears the stamp by
// overwriting the file) is always required before a clone can claim done.
//
// Refuses on viewport-width or compat-mode mismatch (a partial captured at a different
// width/mode would silently poison x-positions — same rule as the diff itself).
//
// USAGE
//   node tools/merge-snapshot.js targets/<name>/clone.json partial.json
"use strict";

const fs = require("fs");

function mergeSnapshots(full, partial) {
  if (!partial.elements || !Object.keys(partial.elements).length) return { error: "partial snapshot has no elements — nothing to merge" };
  if (full.viewport && partial.viewport && full.viewport.width !== partial.viewport.width)
    return { error: `viewport widths differ (full=${full.viewport.width} vs partial=${partial.viewport.width}) — a partial captured at another width would poison x-positions; re-capture` };
  if (full.mode && partial.mode && full.mode !== partial.mode)
    return { error: `document modes differ (full=${full.mode} vs partial=${partial.mode}) — quirks/standards mismatch (LEARNINGS #18); re-capture` };
  const keys = Object.keys(partial.elements);
  for (const k of keys) full.elements[k] = partial.elements[k];
  const prior = (full.merged && full.merged.keys) || [];
  full.merged = { at: new Date().toISOString(), keys: [...new Set([...prior, ...keys])] };
  return { keys, carried: Object.keys(full.elements).length - keys.length };
}

function main() {
  const [fullPath, partialPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!fullPath || !partialPath) { console.error("usage: node tools/merge-snapshot.js <full.json> <partial.json>"); process.exit(2); }
  let full, partial;
  try { full = JSON.parse(fs.readFileSync(fullPath, "utf8")); } catch (e) { console.error(`cannot read ${fullPath}: ${e.message}`); process.exit(1); }
  try { partial = JSON.parse(fs.readFileSync(partialPath, "utf8")); } catch (e) { console.error(`cannot read ${partialPath}: ${e.message}`); process.exit(1); }
  const r = mergeSnapshots(full, partial);
  if (r.error) { console.error(`❌ ${r.error}`); process.exit(1); }
  fs.writeFileSync(fullPath, JSON.stringify(full, null, 2));
  console.log(`✓ merged ${r.keys.length} element(s) into ${fullPath} (${r.carried} carried over from the last full capture)
  updated: ${r.keys.join(", ")}
  ⚠ ITERATION artifact — the file is stamped merged:{at,keys}; the done gate refuses stamped
  snapshots, so take one FULL capture before advancing done (it overwrites the stamp).`);
}

if (require.main === module) main();
module.exports = { mergeSnapshots };
