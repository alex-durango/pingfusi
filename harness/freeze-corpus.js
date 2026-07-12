#!/usr/bin/env node
// freeze-corpus.js — promote a real clone's captures into the committed real-site corpus
// (harness/benchmarks/corpus/), so the detection instrument is scored against reality and
// not just synthetic cases. See harness/benchmarks/corpus.js.
//
// Two uses in the meta-loop (see .claude/commands/develop-loop.md):
//   • After a clone goes GREEN, freeze it as a CONTROL — the gate must keep passing it, so
//     no future gate change can regress this real page:
//       node harness/freeze-corpus.js <NAME> <slug> --control "aloyoga header, went green"
//   • When a real MISS is found, freeze the PRE-fix pair as a DEFECT — the gate must catch
//     it forever (freeze the wrong clone.json BEFORE you fix it):
//       node harness/freeze-corpus.js <NAME> <slug> --defect "underline measured as boolean"
//
// It copies targets/<NAME>/live.json + clone.json into corpus/<slug>/ with a label.json.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const [name, slug, kindFlag, ...noteParts] = process.argv.slice(2);
const kind = kindFlag === "--defect" ? "defect" : kindFlag === "--control" ? "control" : null;

if (!name || !slug || !kind) {
  console.error("usage: node harness/freeze-corpus.js <target-name> <corpus-slug> --control|--defect \"note\"");
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  console.error(`✗ slug "${slug}" must be kebab-case ([a-z0-9-]).`);
  process.exit(2);
}

const tgt = path.join(ROOT, "targets", name);
const live = path.join(tgt, "live.json"), clone = path.join(tgt, "clone.json");
for (const f of [live, clone]) {
  if (!fs.existsSync(f)) { console.error(`✗ ${path.relative(ROOT, f)} not found — capture the target first.`); process.exit(2); }
}

const dest = path.join(ROOT, "harness", "benchmarks", "corpus", slug);
if (fs.existsSync(dest)) { console.error(`✗ corpus/${slug} already exists — pick a new slug or delete it first.`); process.exit(2); }
fs.mkdirSync(dest, { recursive: true });
fs.copyFileSync(live, path.join(dest, "live.json"));
fs.copyFileSync(clone, path.join(dest, "clone.json"));
fs.writeFileSync(path.join(dest, "label.json"),
  JSON.stringify({ kind, note: noteParts.join(" ") || "", from: name }, null, 2) + "\n");

console.log(`✓ froze corpus/${slug} as a ${kind.toUpperCase()} case (from target "${name}").`);
console.log(`  Now run  node harness/benchmarks/detection-power.js  — the gate must ${kind === "defect" ? "CATCH" : "PASS"} it.`);
