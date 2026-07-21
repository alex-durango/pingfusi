// harness/adopt.js — `pingfusi adopt <name> <url> [width]`: register an EXTERNALLY-BUILT
// draft for the kit's review loop.
//
// WHY: the review loop (scope-pinned compare rounds, changelogs on refiles, mandatory
// verdicts, deviations disclosure, the fix-loop discipline) is useful to ANY builder —
// ditto's capture-to-code output, a Lovable build, a hand-written recreation. Those
// builders get you most of the way; the loop with real review closes the gap. Adopt
// creates just enough target state for `pingfusi tunnel` + `pingfusi review <name> …` to run,
// WITHOUT the pixel pipeline (no workflow gates — there's no captured live.json/clone.json
// pair to verify; the review verdict is the whole check).
//
// USAGE:  pingfusi adopt <name> <url> [width=1728]
//   then: pingfusi tunnel <name> --url http://localhost:3000     (your dev server)
//         pingfusi review <name> file [--region "…"]              (the loop begins)
"use strict";

const fs = require("fs");
const path = require("path");

const WORK = process.cwd();

function main() {
  const [name, url, widthArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!name || !url) { console.error("usage: pingfusi adopt <name> <url> [width=1728]"); process.exit(2); }
  // Same guard as new-target.js: `+"default"` is NaN, and a NaN width in target.json
  // poisons every later comparison. Default matches the kit's real default (1728).
  const width = widthArg === undefined || widthArg === "" ? 1728 : +widthArg;
  if (!Number.isFinite(width) || width <= 0) { console.error(`width must be a positive number of pixels, got "${widthArg}" — usage: pingfusi adopt <name> <url> [width=1728]`); process.exit(2); }
  let parsed;
  try { parsed = new URL(url); } catch (e) { console.error(`"${url}" is not a valid url`); process.exit(2); }
  const dir = path.join(WORK, "targets", name);
  if (fs.existsSync(path.join(dir, "target.json"))) {
    console.error(`targets/${name} already exists — pick another name, or continue its loop: pingfusi review ${name} verify`);
    process.exit(1);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "target.json"), JSON.stringify({ name, url: parsed.href, width, adopted: true }, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "NOTES.md"), `# ${name} — ${parsed.href} (ADOPTED external build — review loop only)

Built by an external tool (ditto / other); the kit runs the review loop, not the
pixel gates. Record each round: what the reviewer flagged, the root cause, the fix.

| round | flagged | root cause | fix |
|-------|---------|------------|-----|
|       |         |            |     |
`);
  console.log(`✓ adopted targets/${name}  (original: ${parsed.href})

next:
  1. run your build's dev server (e.g. ditto output: npm i && npm run dev)
  2. pingfusi tunnel ${name} --url http://localhost:3000     # public, reachability-verified
  3. pingfusi review ${name} file [--region "…"]              # first review round
  loop: fix what the reviewer pins → refile with --changelog "…" → until the verdict approves.`);
}

main();
