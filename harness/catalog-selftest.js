// harness/catalog-selftest.js — the use-case catalog must not rot.
//
// use-cases/ is the catalog's SOURCE OF TRUTH: each entry is a rules-file over the four
// verbs (docs/CORE.md), referencing skills that live at skill/<name>/SKILL.md (layout
// decision recorded in use-cases/README.md: entries reference skills, never contain
// them). Everything a catalog page claims is mechanical, so it is gated here:
//   - every referenced skill/file actually exists (a catalog that points at nothing
//     teaches an agent commands for a use case it cannot run);
//   - every `pingfusi <verb>` a catalog page shows is a REAL dispatch case (parsed
//     from harness/workflow.js and bin/pingfusi, never from memory);
//   - the template's core API calls exist on packages/core's real export surface;
//   - the wiring that makes the catalog SHIP stays intact (package.json files,
//     build-public COPY_DIRS, leak-guard ROOTS — the latter two internal-only, so
//     they are checked only where those files exist).
"use strict";
const fs = require("fs");
const path = require("path");

const KIT = path.resolve(__dirname, "..");
let failed = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failed++; console.log(`  ✗ ${msg}${detail ? ` — ${detail}` : ""}`); }
};
const read = (rel) => fs.readFileSync(path.join(KIT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(KIT, rel));

console.log("catalog-selftest — the shipped use-case catalog stays true");

// ── structure: the catalog's fixed files ──────────────────────────────────────
const CATALOG_FILES = [
  "use-cases/README.md",
  "use-cases/quick-question/README.md",
  "use-cases/review-anything/README.md",
  "use-cases/copy-anything/README.md",
  "use-cases/beautify/README.md",
  "use-cases/video-review/README.md",
  "use-cases/your-own/TEMPLATE.md",
];
for (const f of CATALOG_FILES) ok(exists(f), `${f} exists`);
if (failed) { console.log(`\n❌ catalog-selftest: ${failed} check(s) failed.`); process.exit(1); }

const catalogTexts = CATALOG_FILES.map((f) => ({ file: f, text: read(f) }));
const README = read("README.md");

// ── referenced skills exist, and every shipped skill is cataloged ─────────────
const referencedSkills = new Set();
for (const { file, text } of catalogTexts) {
  for (const m of text.matchAll(/skill\/([A-Za-z0-9-]+)\/SKILL\.md/g)) {
    referencedSkills.add(m[1]);
    ok(exists(path.join("skill", m[1], "SKILL.md")), `${file} references a real skill: ${m[1]}`);
  }
}
for (const name of ["pixel-perfect-clone", "fix-with-pingfusi"]) {
  ok(read("use-cases/copy-anything/README.md").includes(name),
    `copy-anything names its skill ${name}`,
    "the entry's contract is its two skills by name");
}
ok(read("use-cases/beautify/README.md").includes("beautify-with-pingfusi"),
  "beautify names its skill beautify-with-pingfusi");
ok(read("use-cases/video-review/README.md").includes("review-video-with-pingfusi"),
  "video-review names its skill review-video-with-pingfusi");
const shippedSkills = fs.readdirSync(path.join(KIT, "skill"), { withFileTypes: true })
  .filter((e) => e.isDirectory() && exists(path.join("skill", e.name, "SKILL.md")))
  .map((e) => e.name);
const uncataloged = shippedSkills.filter((n) => !referencedSkills.has(n));
ok(uncataloged.length === 0,
  `every shipped skill is referenced by a catalog entry (${shippedSkills.length} skills)`,
  `${uncataloged.join(", ")} installs into agents but no use case claims it`);

// ── relative links in catalog pages + README resolve to real files ────────────
for (const { file, text } of catalogTexts.concat([{ file: "README.md", text: README }])) {
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    const target = path.normalize(path.join(path.dirname(path.join(KIT, file)), href.split(/[?&]/)[0]));
    ok(fs.existsSync(target), `${file} link resolves: ${href}`);
  }
}

// ── every `pingfusi <verb>` shown in the catalog is a real dispatch case ──────
// The truth is parsed from the dispatchers themselves: harness/workflow.js case
// labels + bin/pingfusi's MCP passthrough set (+ version). Never a hand-kept list.
const dispatch = new Set(["version"]);
for (const m of read("harness/workflow.js").matchAll(/case "([a-z][a-z-]*)":/g)) dispatch.add(m[1]);
const mcp = read("bin/pingfusi").match(/MCP_COMMANDS = new Set\(\[([^\]]*)\]/);
ok(!!mcp, "bin/pingfusi declares its MCP passthrough commands");
if (mcp) for (const m of mcp[1].matchAll(/"([a-z-]+)"/g)) dispatch.add(m[1]);
ok(dispatch.size > 10, `parsed a real dispatch surface (${dispatch.size} commands)`);

function commandVerbs(text) {
  const verbs = [];
  // inline code spans (may wrap across lines)
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const v = /^(?:npx\s+)?pingfusi\s+([a-z][a-z-]*)/.exec(m[1].trim());
    if (v) verbs.push(v[1]);
  }
  // fenced blocks, including blockquoted fences in the template
  let inFence = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*>?\s?/, "");
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (!inFence) continue;
    const v = /^\s*(?:\$\s*)?(?:npx\s+)?pingfusi\s+([a-z][a-z-]*)/.exec(line);
    if (v) verbs.push(v[1]);
  }
  return verbs;
}
for (const { file, text } of catalogTexts.concat([{ file: "README.md", text: README }])) {
  const unknown = [...new Set(commandVerbs(text).filter((v) => !dispatch.has(v)))];
  ok(unknown.length === 0, `${file} shows only real pingfusi commands`,
    `not in any dispatcher: pingfusi ${unknown.join(", pingfusi ")}`);
}

// ── the template's four verbs + core API calls are real ───────────────────────
const template = read("use-cases/your-own/TEMPLATE.md");
for (const verb of ["pingfusi ask", "pingfusi wait", "pingfusi publish", "pingfusi draft", "pingfusi review"]) {
  ok(template.includes(verb), `TEMPLATE.md covers ${verb}`);
}
const core = require(path.join(KIT, "packages", "core", "index.js"));
const CORE_CALLS = { "core.ping": core.ping, "core.review.file": core.review.file, "core.review.wait": core.review.wait, "core.review.verify": core.review.verify, "core.draft.push": core.draft.push };
for (const [name, fn] of Object.entries(CORE_CALLS)) {
  if (template.includes(name)) ok(typeof fn === "function", `TEMPLATE.md's ${name} exists on packages/core`);
}
ok(typeof core.review.file === "function" && typeof core.review.verify === "function",
  "the template's worked example rests on real core verbs (review.file / review.verify)");
const beautify = read("use-cases/beautify/README.md");
ok(beautify.includes("core.review.file") && beautify.includes("core.review.verify"),
  "beautify files and verifies through the generic core review verb");
ok(/omit[s]? `draft_url`/i.test(beautify) && /Do \*\*not\*\* use `pingfusi review/.test(beautify),
  "beautify refuses the clone-identity filing path and uses the single-page surface");
ok(/sticky comments and drawing/i.test(beautify)
  && /require_evidence: ["`]none["`]/.test(beautify),
  "beautify's single-page reviewer exposes annotations without a screenshot-upload gate");
ok(/immutable[^.]*before/i.test(beautify)
  && beautify.includes("pingfusi publish")
  && beautify.includes("Professionally polished") && beautify.includes("Needs another pass"),
  "beautify preserves the before proof and declares exact approval/rework verdicts");
const video = read("use-cases/video-review/README.md");
ok(video.includes("core.review.file") && video.includes('`media_type: "video"`'),
  "video-review files through the generic core review verb in video mode");
ok(video.includes("Matches the prompt") && video.includes("Needs another pass"),
  "video-review declares the service's fixed verdict pair");
ok(/pingfusi publish/.test(video) && /206/.test(video) && /Content-Range/.test(video),
  "video-review demands a Range-serving seekable MP4 before a round is spent");
ok(video.includes("current_brief") && video.includes("prompt_history") && video.includes("requirements"),
  "video-review carries the full review context (brief, prompt history, requirements)");
const quick = read("use-cases/quick-question/README.md");
ok(quick.includes("pingfusi ask") && /advisory, never an approval/i.test(quick),
  "quick-question is pingfusi ask, and says the advisory rule out loud");
const anything = read("use-cases/review-anything/README.md");
ok(anything.includes("core.review.file") && /[Pp]ublish before review/.test(anything)
  && /[Vv]erdict-required/.test(anything),
  "review-anything states the generic loop's contract (publish-first, verdict-required)");

// ── availability is earned by a sanitized real-run receipt + visual ──────────
// Raw reviewer transcripts stay under internal targets/. The shipped proof is the
// minimum independently-checkable receipt: an approving verdict, content hashes, and a
// shipped visual. Until those bytes exist, the entry's catalog rows must stay "coming".
function sanitizedProofReady(entry, approvingVerdict, hashFields) {
  const proofPath = path.join(KIT, "use-cases", entry, "proof.json");
  if (!fs.existsSync(proofPath)) return false;
  try {
    const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
    const asset = typeof proof.asset === "string"
      ? path.join(KIT, "use-cases", entry, proof.asset)
      : "";
    return proof.approved === true
      && proof.verdict === approvingVerdict
      && Number.isInteger(proof.rounds) && proof.rounds >= 1
      && hashFields.every((f) => /^[0-9a-f]{64}$/.test(proof[f] || ""))
      && !!asset && fs.existsSync(asset);
  } catch (_) { return false; }
}
const AVAILABILITY = [
  {
    entry: "beautify",
    proofReady: sanitizedProofReady("beautify", "Professionally polished",
      ["review_state_sha256", "before_sha256", "after_sha256"]),
    rootRe: /\| \[Website beautification\]\(use-cases\/beautify\/README\.md\)[^\n]*\| \*\*available\*\* \|/,
    catalogRe: /\| \[beautify\/\]\(beautify\/README\.md\) \| \*\*available\*\* \|/,
    proofName: "an approved receipt + before/after visual",
  },
  {
    entry: "video-review",
    proofReady: sanitizedProofReady("video-review", "Matches the prompt",
      ["review_state_sha256", "video_sha256"]),
    rootRe: /\| \[Video review\]\(use-cases\/video-review\/README\.md\)[^\n]*\| \*\*available\*\* \|/,
    catalogRe: /\| \[video-review\/\]\(video-review\/README\.md\) \| \*\*available\*\* \|/,
    proofName: "an approved receipt + reviewed-render visual",
  },
];
for (const a of AVAILABILITY) {
  const rootAvailable = a.rootRe.test(README);
  const catalogAvailable = a.catalogRe.test(read("use-cases/README.md"));
  ok(rootAvailable === catalogAvailable, `root and source catalog agree on ${a.entry} availability`);
  ok(a.proofReady ? rootAvailable : !rootAvailable,
    a.proofReady
      ? `approved ${a.entry} proof unlocks the available label`
      : `${a.entry} stays coming until ${a.proofName} exist`);
}

// ── shipping wiring: the catalog actually leaves the building ─────────────────
const pkg = JSON.parse(read("package.json"));
ok((pkg.files || []).includes("use-cases/"), 'package.json "files" ships use-cases/');
ok(read("docs/CORE.md").includes("use-cases/"), "docs/CORE.md points at the catalog");
if (exists("scripts/build-public.js")) {
  ok(/COPY_DIRS = \[[^\]]*"use-cases"/.test(read("scripts/build-public.js")),
    "build-public COPY_DIRS ships use-cases/");
}
if (exists("harness/leak-guard-selftest.js")) {
  ok(/ROOTS = \[[^\]]*"use-cases"/.test(read("harness/leak-guard-selftest.js")),
    "leak-guard ROOTS scans use-cases/ (shipped-surface vocabulary applies)");
}

console.log(failed ? `\n❌ catalog-selftest: ${failed} check(s) failed — the catalog no longer describes the kit.` : "\n✓ catalog-selftest: every entry's skills/files exist, every shown command dispatches, the wiring ships.");
process.exit(failed ? 1 : 0);
