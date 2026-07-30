// harness/installer-selftest.js — the gate on vendor/pingfusi-review.mjs now that it is SOURCE.
//
// The installer used to be a GENERATED brand fork of the service repo's cli/index.mjs, and
// scripts/fork-vendor-selftest.js was its gate: it regenerated the file and demanded a byte
// match, which caught both an unported backend change and any hand-edit. That backend source
// is gone (the monorepo made the two trees one, then the service-side cli/ was deleted), so the
// pipeline and its gate went with it — and with them, quietly, three invariants they had been
// holding as side effects of regeneration. This file keeps them:
//
//   1. it parses. The old pipeline ran `node --check` on every write. Nothing else does: the
//      installer is spawned as a CHILD PROCESS (harness/setup.js) or dynamically imported by
//      bin/pingfusi, so a syntax error surfaces as a failed user install, never as a red test.
//      (regression.js's syntax sweep walks tools/harness/packages — not vendor/.)
//   2. VERSION tracks the kit. As a fork it kept an independent lineage (0.3.x while the kit
//      was 0.13.x) because it shipped from a different source; one repo, one version now, and
//      `pingfusi --version` vs the installer's own banner should not disagree.
//   3. SKILL_BODY still equals skill/pingfusi-review/SKILL.md. The installer writes that skill
//      into the user's agent from a template literal baked into itself, so the Markdown a human
//      edits and the payload a user receives are two copies of one text. The pipeline compared
//      them on every regeneration (via scripts/fork-overrides/skill-body.txt); with the payload
//      hand-maintained the drift is now a one-line edit away and completely silent — the user's
//      installed skill just stops matching the repo's.
//
// Plus the two shipped-surface checks harness/leak-guard-selftest.js already makes on this file.
// Cheap, and they belong to both stories: leak-guard asks "does the public tree stay de-branded",
// this asks "is the installer intact". A hand-edited banner should fail whichever one you run.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const KIT = path.resolve(__dirname, "..");
const INSTALLER = path.join(KIT, "vendor", "pingfusi-review.mjs");
const SKILL = path.join(KIT, "skill", "pingfusi-review", "SKILL.md");

let failed = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failed++; console.log(`  ✗ ${msg}`); if (detail) console.log(detail.replace(/^/gm, "      ")); }
};

console.log("installer-selftest — vendor/pingfusi-review.mjs is intact, hand-maintained source");

const src = fs.readFileSync(INSTALLER, "utf8");

// ── 1. it parses ──────────────────────────────────────────────────────────────
let parseErr = "";
try { execFileSync("node", ["--check", INSTALLER], { stdio: "pipe" }); }
catch (e) { parseErr = ((e.stdout || "") + (e.stderr || "")).toString().trim(); }
ok(!parseErr, "vendor/pingfusi-review.mjs parses (node --check)", parseErr);

// ── 2. VERSION tracks the kit's package.json ──────────────────────────────────
const pkgVersion = JSON.parse(fs.readFileSync(path.join(KIT, "package.json"), "utf8")).version;
const m = src.match(/^const VERSION = "([^"]+)";$/m);
ok(Boolean(m), "installer declares a VERSION const");
if (m) {
  ok(
    m[1] === pkgVersion,
    `installer VERSION (${m[1]}) matches package.json (${pkgVersion})`,
    `The installer no longer has its own lineage — one repo, one version.\nBump \`const VERSION\` in vendor/pingfusi-review.mjs to "${pkgVersion}".`
  );
}

// ── 3. SKILL_BODY payload === the shipped SKILL.md ────────────────────────────
// SKILL.md is authored as plain Markdown; the installer carries it inside a JavaScript
// template literal. Escape only the template-literal syntax, so evaluating the installer
// reconstructs the Markdown byte-for-byte. (Ported from the deleted scripts/fork-vendor.js,
// which is the only reason the two ever agreed.)
function templateLiteralPayload(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

// Scan for the literal's closing backtick the same way the generator did: skip \-escaped
// pairs, so an escaped backtick inside the payload does not end it early.
function extractTemplate(text, name) {
  const marker = `const ${name} = \``;
  const start = text.indexOf(marker);
  if (start < 0) return null;
  let i = start + marker.length;
  while (i < text.length) {
    if (text[i] === "\\") { i += 2; continue; }
    if (text[i] === "`") return text.slice(start + marker.length, i);
    i++;
  }
  return null;
}

const payload = extractTemplate(src, "SKILL_BODY");
ok(payload !== null, "installer carries a SKILL_BODY template literal");
if (payload !== null) {
  const expected = templateLiteralPayload(fs.readFileSync(SKILL, "utf8"));
  let detail = "";
  if (payload !== expected) {
    const a = payload.split("\n"), b = expected.split("\n");
    let d = 0;
    while (d < Math.min(a.length, b.length) && a[d] === b[d]) d++;
    detail =
      `skill/pingfusi-review/SKILL.md is the human-readable SOURCE of this text; the SKILL_BODY\n` +
      `payload in vendor/pingfusi-review.mjs is the copy the installer writes into the user's\n` +
      `agent. Edit SKILL.md, then mirror it into the payload (escape \\ \` and \${ ).\n` +
      `First difference at payload line ${d + 1} (of ${a.length}; SKILL.md has ${b.length}):\n` +
      `  installer: ${JSON.stringify((a[d] ?? "<EOF>").slice(0, 100))}\n` +
      `  SKILL.md:  ${JSON.stringify((b[d] ?? "<EOF>").slice(0, 100))}`;
  }
  ok(payload === expected, "SKILL_BODY payload byte-equals skill/pingfusi-review/SKILL.md", detail);
}

// ── 4. banner invariants (mirrors harness/leak-guard-selftest.js — cheap, keep both) ──
ok(/install the pingfusi review MCP server/.test(src), "banner says 'install the pingfusi review MCP server'");
ok(!/PingHumans/.test(src), "no standalone 'PingHumans' branding in the installer");

console.log(failed ? `\n❌ installer-selftest: ${failed} assertion(s) failed.` : "\n✓ installer-selftest: all assertions pass.");
process.exit(failed ? 1 : 0);
