#!/usr/bin/env node
/**
 * reassemble.js — join pxRead() chunks into a validated snapshot file.
 *
 * Hand-concatenating pxStash/pxRead chunks is the single most error-prone step in the
 * capture loop: a dropped character at a chunk boundary produced a silently-corrupt
 * live.json that only surfaced rounds later as unexplainable diffs (found during the
 * HN dogfood run). This makes reassembly a verified operation instead:
 *   1. joins the chunk files IN THE ORDER GIVEN,
 *   2. checks the total byte count against pxStash's reported `bytes` (pass --bytes),
 *   3. JSON-parses the result and requires the snapshot shape (.elements),
 * and only then writes the output. Any failure names the exact problem and exits 2.
 *
 * usage: node tools/reassemble.js <out.json> [--bytes N] <chunk-file> [<chunk-file>…]
 *   Save each pxRead(i) result to its own file (chunk-00.txt, chunk-01.txt, …), then:
 *   node tools/reassemble.js targets/hn/live.json --bytes 18342 chunk-*.txt
 *   (shell glob order is lexicographic — zero-pad chunk indexes so it matches read order.)
 */
"use strict";
const fs = require("fs");

const argv = process.argv.slice(2);
const files = [];
let out = null, bytes = null, bytesRaw;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--bytes") { bytesRaw = argv[++i]; bytes = parseInt(bytesRaw, 10); }
  else if (a.startsWith("--")) { console.error(`unknown flag "${a}". valid: --bytes <n>`); process.exit(2); }
  else if (out === null) out = a;
  else files.push(a);
}
if (!out || !files.length) {
  console.error("usage: node tools/reassemble.js <out.json> [--bytes N] <chunk-file> [<chunk-file>…]\n  --bytes  the `bytes` value pxStash() reported — verifies nothing was lost in transit");
  process.exit(2);
}
if (bytesRaw !== undefined && !(Number.isInteger(bytes) && bytes > 0)) {
  console.error(`--bytes needs a positive integer (got "${bytesRaw}").`);
  process.exit(2);
}

let joined = "";
for (const f of files) {
  if (!fs.existsSync(f)) { console.error(`chunk file ${f} not found — save each pxRead(i) result to its own file first.`); process.exit(2); }
  joined += fs.readFileSync(f, "utf8");
}

if (bytes !== null && joined.length !== bytes) {
  console.error(`byte count mismatch: pxStash reported ${bytes}, chunks join to ${joined.length} (${joined.length < bytes ? "missing" : "extra"} ${Math.abs(joined.length - bytes)} bytes).\n  A chunk was dropped, duplicated, or truncated — re-run the pxRead(i) that looks short and check the file order (zero-pad indexes so glob order matches).`);
  process.exit(2);
}

let snap;
try { snap = JSON.parse(joined); } catch (e) {
  console.error(`joined chunks are not valid JSON: ${e.message}\n  A chunk boundary is corrupt — re-read the chunk around the reported position; do not hand-edit the JSON.`);
  process.exit(2);
}
if (!snap || !snap.elements) {
  console.error(`joined JSON has no "elements" — this isn't a pxCapture() snapshot (a pxInspect() dump is fine to save directly, no reassembly needed).`);
  process.exit(2);
}

fs.writeFileSync(out, joined);
console.log(`✓ ${out} written — ${joined.length} bytes, ${Object.keys(snap.elements).length} elements, JSON valid${bytes !== null ? ", byte count matches pxStash" : ""}.`);
