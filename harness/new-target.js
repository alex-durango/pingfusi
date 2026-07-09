// harness/new-target.js <name> <url> [width=1728] — scaffold a fresh clone workspace.
//
// A "target" is a disposable instance under targets/<name>/. The KIT (tools + the .md
// instructions) is the product; targets are where you exercise it on a real site. The
// scaffold is plain HTML/CSS (no build step) so the pixel loop is instant: edit
// clone/ → refresh → capture → `node harness/score.js <name>`.
const fs = require("fs"), path = require("path");
const [, , name, url, widthArg] = process.argv;
if (!name || !url) { console.error("usage: node harness/new-target.js <name> <url> [width=1728]"); process.exit(1); }
const width = +(widthArg || 1728);
// targets/ live in the USER's current directory (WORK), not inside the installed kit (PKG).
const WORK = process.cwd();
const dir = path.join(WORK, "targets", name);
if (fs.existsSync(dir)) { console.error(`targets/${name} already exists — delete it first or pick another name`); process.exit(1); }
fs.mkdirSync(path.join(dir, "clone", "assets"), { recursive: true });

fs.writeFileSync(path.join(dir, "target.json"), JSON.stringify({ name, url, width }, null, 2) + "\n");

// Seed the ENFORCED workflow state machine (the kit's `gjc`). From here on the clone must
// pass each phase gate IN ORDER — nothing can claim "pixel-perfect" without the receipts.
require("./workflow.js").initWorkflow(name, url, width);

fs.writeFileSync(path.join(dir, "clone", "index.html"), `<!doctype html>
<!-- CHECK LIVE'S DOCTYPE FIRST: if the live page ships no doctype it renders in QUIRKS
     mode (document.compatMode === "BackCompat") and this standards-mode doctype will
     shift table-cell line boxes with every computed style identical — delete it to
     match (LEARNINGS #18). The capture records \`mode\` and the gate fails a mismatch. -->
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${name} — header clone</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <!-- DEFAULT BUILD STRATEGY: capture, don't reconstruct (LEARNINGS #19). Capture the
       live page's post-hydration DOM (pxSendDom → dom.html) and run
       \`pingfusi capture-build <name>\` — it REPLACES this whole scaffold with the captured
       markup + self-hosted CSS/fonts, inheriting live's doctype and drawing techniques
       by construction. Hand-rebuild here (to MEASUREMENTS, never guesses) only when the
       deliverable is a component in your own stack. See ../../docs/PLAYBOOK.md Phase 4. -->
  <header class="site-header">
    <!-- TODO: build to spec -->
  </header>

  <!-- Capture (with \`node tools/sink.js\` running on :7799):
       const s = await fetch('/tools/browser-capture.js').then(r => r.text()); (0, eval)(s);
       window.pxRegion = { maxY: 135 };
       window.pxTargets = [ ["logo", () => document.querySelector('.logo'), false], ... ];
       await pxSend('http://localhost:7799/clone.json'); -->
</body>
</html>
`);

fs.writeFileSync(path.join(dir, "clone", "styles.css"), `/* ${name} clone — build to measured values */
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  /* Learned default (LEARNINGS #13): most design systems ship antialiased smoothing —
     matching it up front avoids a "looks thicker" miss the gate would otherwise flag. */
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
`);

fs.writeFileSync(path.join(dir, "scores.jsonl"), "");
fs.writeFileSync(path.join(dir, "NOTES.md"), `# ${name} — ${url} @ ${width}px

## Iteration log
Record each loop: what a reviewer/you flagged, whether the **gate** caught it, and the fix.
A flag the gate MISSED is the valuable one — it becomes a tool check + fixture (see docs/DEVELOP.md).

| round | flagged | gate caught it? | fix | kit change (tool/fixture/instruction) |
|-------|---------|-----------------|-----|----------------------------------------|
|       |         |                 |     |                                        |

## Site-specific findings
(structure quirks, faux-bold, etc. — generalize the durable ones into docs/LEARNINGS.md)
`);

// Print next steps that are RUNNABLE in the invoking context: `pingfusi …` when launched via the
// installed pingfusi entrypoint (PPK_ENTRY set by its delegate), `node harness/…` when someone in
// the repo ran this script directly (they have no pingfusi on PATH).
const viaPpk = process.env.PPK_ENTRY === "1";
const c = (ppkForm, nodeForm) => (viaPpk ? ppkForm : nodeForm);
console.log(`created targets/${name}/  (url=${url}, width=${width})

next:
  ${c("pingfusi sink &", "node tools/sink.js &")}                 # snapshot receiver on :7799
  ${c(`pingfusi serve ${name}`, `node harness/serve.js ${name}`)}          # serves clone + /tools on :8080
  # 1. open the live site at ${width}px, measure it (RUNBOOK), POST live.json into targets/${name}/
  # 2. build clone/index.html — DEFAULT: capture it (RUNBOOK "Build by capture"):
  #      live tab: await pxSendDom('http://localhost:7799/dom.html')
  #      then:     ${c(`pingfusi capture-build ${name}`, `node harness/capture-build.js ${name}`)}
  #    (hand-rebuild to measurements only when the deliverable is a component in your stack)
  # 3. capture clone.json, then:
  ${c(`pingfusi score ${name}`, `node harness/score.js ${name}`)}          # scores this run vs the last (is it better?)

the enforced workflow tracks your phases (target → assets → measure → build → visual → coverage → strict → done):
  ${c(`pingfusi status ${name}`, `node harness/workflow.js status ${name}`)}                 # what's done, what's next, whether its gate passes
  ${c(`pingfusi advance ${name} <phase>`, `node harness/workflow.js advance ${name} <phase>`)}        # record a phase — refuses unless its gate exits 0`);
