// harness/merge-snapshot-selftest.js — guards the incremental-capture merge
// (tools/merge-snapshot.js) and its honesty contract with the done gate. Offline.
//   - partial elements overwrite; untouched elements carry over; merged stamp accumulates keys
//   - width / compat-mode mismatch refused (would poison x-positions / #18)
//   - the done gate refuses a merged (stamped) snapshot; a full re-capture (no stamp) clears it
// Run: node harness/merge-snapshot-selftest.js   (regression.js runs it too)
"use strict";
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { mergeSnapshots } = require("../tools/merge-snapshot.js");

const KIT = path.resolve(__dirname, "..");
let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed++; console.log(`  ✗ ${msg}`); } };

console.log("merge-snapshot-selftest — incremental capture merge + done-gate honesty");

// ── merge semantics (pure) ────────────────────────────────────────────────────
const snap = (els, width, mode) => ({ viewport: { width }, mode: mode || "CSS1Compat", elements: els });
{
  const full = snap({ a: { present: true, v: 1 }, b: { present: true, v: 1 }, c: { present: true, v: 1 } }, 1512);
  const r = mergeSnapshots(full, snap({ b: { present: true, v: 2 } }, 1512));
  ok(!r.error && full.elements.b.v === 2 && full.elements.a.v === 1 && r.carried === 2, "partial overwrites its keys; others carry over");
  ok(full.merged && full.merged.keys.join() === "b", "merge stamps merged:{at,keys}");
  mergeSnapshots(full, snap({ c: { present: true, v: 2 } }, 1512));
  ok(full.merged.keys.sort().join() === "b,c", "successive merges ACCUMULATE stamped keys");
  ok(mergeSnapshots(full, snap({ a: {} }, 1280)).error.includes("width"), "viewport-width mismatch refused");
  ok(mergeSnapshots(full, snap({ a: {} }, 1512, "BackCompat")).error.includes("modes differ"), "compat-mode mismatch refused (#18)");
  ok(mergeSnapshots(full, snap({}, 1512)).error.includes("no elements"), "empty partial refused");
}

// ── done-gate refusal of merged snapshots (through the real workflow) ────────
{
  const run = (args) => { const r = cp.spawnSync(process.execPath, [path.join(KIT, "harness", "workflow.js"), ...args], { encoding: "utf8", cwd: KIT }); return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }; };
  const NAME = "mergeselftest_" + process.pid;
  const dir = path.join(KIT, "targets", NAME);
  process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "clone"), { recursive: true });
  fs.writeFileSync(path.join(dir, "target.json"), JSON.stringify({ name: NAME, url: "https://example.com/", width: 1512 }));
  run(["init", NAME]);
  const el = { present: true, rect: { x: 0, y: 0, w: 10, h: 10, top: 0, right: 10, bottom: 10, fromRight: 0 } };
  const clean = snap({ logo: el }, 1512);
  fs.writeFileSync(path.join(dir, "clone.json"), JSON.stringify(clean));
  const stamped = { ...clean, merged: { at: "2026-07-05T00:00:00.000Z", keys: ["logo"] } };
  fs.writeFileSync(path.join(dir, "live.json"), JSON.stringify(stamped));
  const refused = run(["gate", NAME, "done"]);
  ok(refused.code === 1 && /MERGED iteration snapshot/.test(refused.out) && /live\.json/.test(refused.out), "done gate refuses a merged-stamped snapshot, naming the file");
  fs.writeFileSync(path.join(dir, "live.json"), JSON.stringify(clean));
  const after = run(["gate", NAME, "done"]);
  ok(!/MERGED iteration snapshot/.test(after.out), "a full re-capture (stamp gone) clears the refusal (done then blocks on ordinary pending phases only)");
}

console.log(failed ? `\n❌ merge-snapshot-selftest: ${failed} assertion(s) failed.` : "\n✓ merge-snapshot-selftest: all assertions pass.");
process.exit(failed ? 1 : 0);
