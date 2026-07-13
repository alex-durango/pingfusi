// docs-selftest.js — the docs must not quietly start lying.
//
// PAID FOR on the 2026-07-13 gorjana run, twice, and both times silently — nothing failed, no
// command exited nonzero, the prose just stopped being true:
//
//   1. `pxScrollSettle` gained a `stable` field — the one that means "this DOM is NOT the page,
//      do not capture it". tools/RUNBOOK.md still documented `// → {scrolledTo, frozenOpacity0}`
//      and told the operator to check frozenOpacity0. An operator following the RUNBOOK would
//      have reproduced the exact miss the fix was written to prevent: capture a page that is
//      still mounting, ship a clone with a hole in it, watch every gate go green over half a page.
//      A lesson that lives only in the tool is one the next operator re-learns by being bitten.
//
//   2. A citation pointed at a lesson that does not exist (`#30`, when LEARNINGS ends at #25 —
//      it meant the FIXTURE, not the lesson). Citing a lesson number that resolves to nothing is
//      how a catalog rots: renumber or retire an entry and every stale reference silently points
//      somewhere wrong, and no one finds out.
//
// Both are mechanical, so both are gated here rather than left to a reviewer's memory (the kit's
// own rule: a new class of miss goes into the TOOL, not into a checklist someone must remember).
//
// What this canNOT check — and it is the interesting half — is whether the prose is any GOOD:
// clear, in the right document, an instruction rather than a post-mortem. That stays 👁 judgment
// (DEVELOP.md step 5: "compress the how-to… to 'the gate checks this; your job is the technique'").
"use strict";
const fs = require("fs");
const path = require("path");

const KIT = path.resolve(__dirname, "..");
let bad = 0;
const check = (n, c, detail) => { console.log(`${c ? "✓" : "✗"} ${n}${detail && !c ? ` — ${detail}` : ""}`); if (!c) bad++; };

const read = (p) => fs.readFileSync(path.join(KIT, p), "utf8");
const walk = (dir, re, out = []) => {
  const abs = path.join(KIT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, re, out);
    else if (re.test(e.name)) out.push(rel);
  }
  return out;
};

// ── GATE 1 — every documented return shape must match what the function ACTUALLY returns ──────
//
// The docs write a contract as:   await pxScrollSettle()   // → {scrolledTo, frozenOpacity0, …}
// We parse that annotation, RUN the real function against a DOM shim, and compare the key SETS.
// A key the tool returns but the docs omit is the gorjana bug; a key the docs promise but the tool
// never returns is the same rot facing the other way. Both fail.
//
// REQUIRED_SHAPES exists so the gate cannot be dodged by deleting the comment: a function listed
// here MUST carry a `// → {…}` annotation somewhere in the docs, or that is itself a failure.
const REQUIRED_SHAPES = ["pxScrollSettle"];

// Run a px* function against a shim and return its actual key set. Add a case here when a new
// function's return shape becomes load-bearing enough to document.
async function actualKeys(fnName) {
  if (fnName !== "pxScrollSettle") return null;   // nothing else is exercised yet
  const prevWindow = global.window, prevDoc = global.document;
  try {
    global.window = global;
    global.document = {
      get documentElement() { return { get scrollHeight() { return 2000; } }; },   // a static page
      querySelectorAll: () => [],
    };
    global.innerHeight = 900;
    global.scrollTo = () => {};
    const src = require.resolve(path.join(KIT, "tools", "browser-capture.js"));
    delete require.cache[src];
    require(src);
    const r = await global.pxScrollSettle({ pause: 1, settle: 1, stableGapMs: 1, stableChecks: 2, maxSweeps: 2 });
    return Object.keys(r).sort();
  } finally { global.window = prevWindow; global.document = prevDoc; }
}

const DOC_FILES = ["docs", "skill"].flatMap((d) => walk(d, /\.md$/)).concat(["tools/RUNBOOK.md", "README.md"].filter((f) => fs.existsSync(path.join(KIT, f))));

async function gateReturnShapes() {
  const ANNOT = /\b(px[A-Za-z]+)\s*\([^)]*\)\s*(?:\/\/|#)?\s*→\s*\{([^}]*)\}/g;
  const documented = new Map(); // fn → { keys, file }
  for (const f of DOC_FILES) {
    const text = read(f);
    for (const m of text.matchAll(ANNOT)) {
      const keys = m[2].split(",").map((s) => s.trim().replace(/…|\.\.\./g, "")).filter(Boolean).sort();
      documented.set(m[1], { keys, file: f });
    }
  }

  for (const fn of REQUIRED_SHAPES) {
    const doc = documented.get(fn);
    check(`${fn}'s return shape is documented (a load-bearing contract must be written down)`,
      !!doc, `no "${fn}(…) // → {…}" annotation in any doc — add one`);
    if (!doc) continue;

    const real = await actualKeys(fn);
    if (!real) continue;
    const missing = real.filter((k) => !doc.keys.includes(k));
    const invented = doc.keys.filter((k) => !real.includes(k));
    check(`${doc.file} documents every field ${fn} returns (no silent new contract)`,
      missing.length === 0,
      `${fn} returns ${missing.join(", ")} but the docs never mention it — this is exactly how the settle's \`stable\` field went undocumented while it meant "do not capture"`);
    check(`${doc.file} promises no field ${fn} does not return`,
      invented.length === 0,
      `the docs promise ${invented.join(", ")}, which ${fn} never returns`);
  }
}

// ── GATE 2 — every LEARNINGS #NN citation must resolve to a lesson that exists ─────────────────
//
// `(?<!&)` skips HTML entities: `&#39;` inside a decoder in clone-lint.js is not a citation, and a
// gate that cannot tell those apart would cry wolf on its first run.
function gateCitations() {
  const learnings = read("docs/LEARNINGS.md");
  const existing = new Set([...learnings.matchAll(/^## (\d+)\./gm)].map((m) => Number(m[1])));
  const maxLesson = Math.max(...existing);

  const SRC = DOC_FILES
    .concat(walk("tools", /\.js$/))
    .concat(walk("harness", /\.js$/))
    .filter((f) => !f.endsWith("docs-selftest.js"));   // this file quotes #30 while EXPLAINING it

  const CITE = /(?<!&)#(\d{1,2})(?![\d;])/g;
  const dangling = [];
  for (const f of SRC) {
    for (const m of read(f).matchAll(CITE)) {
      const n = Number(m[1]);
      if (!existing.has(n)) dangling.push(`${f} cites #${n}`);
    }
  }
  check(`every "#NN" citation resolves to a real lesson (LEARNINGS has 1–${maxLesson})`,
    dangling.length === 0,
    `${dangling.length} dangling: ${[...new Set(dangling)].slice(0, 4).join("; ")}. NOTE: "#NN" means LEARNINGS #NN — to cite a FIXTURE, name its file (harness/fixtures/NN-name.js), or the reference is ambiguous and rots`);
}

// ── GATE 3 (cheap half) — a 🔒 "Enforced now" claim must name a fixture that EXISTS ────────────
// A lesson still claiming enforcement after its fixture was renamed or deleted is worse than no
// lesson: it tells you to trust a gate that is not there.
function gateEnforcementClaims() {
  const learnings = read("docs/LEARNINGS.md");
  const cited = [...learnings.matchAll(/harness\/fixtures\/([0-9A-Za-z._-]+\.js)/g)].map((m) => m[1]);
  const missing = [...new Set(cited)].filter((f) => !fs.existsSync(path.join(KIT, "harness", "fixtures", f)));
  check(`every fixture LEARNINGS claims as its lock actually exists (${new Set(cited).size} cited)`,
    missing.length === 0,
    `${missing.join(", ")} — a lesson claiming a gate that is not there is worse than no lesson`);
}

(async () => {
  await gateReturnShapes();
  gateCitations();
  gateEnforcementClaims();
  console.log(bad ? `\n❌ docs-selftest: ${bad} check(s) failed — the docs no longer describe the tools.` : "\n✓ docs-selftest: documented return shapes match the real ones, every #NN citation resolves, every claimed fixture exists.");
  process.exit(bad ? 1 : 0);
})();
