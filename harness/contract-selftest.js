// harness/contract-selftest.js — the kit's half of the wire-contract guard.
//
// packages/core/wire-contract.gen.js is generated from a file OUTSIDE this package
// (the monorepo's packages/wire-contract/contract.json) and checked in beside wire.js so
// the npm tarball stays self-contained. That split needs guarding from both ends:
//
//   - OUTSIDE, in the monorepo: contract-sync-selftest.js regenerates every consumer copy
//     and byte-compares, so a forgotten regen or a hand-edit fails there.
//   - HERE: this file. Every kit selftest ships to the public repo, so it may only read
//     files inside this package — it reads the GENERATED file, never the contract. Which
//     is exactly the right test anyway: the generated file is what a released kit has, so
//     what a released kit can check is that the file it actually ships is internally
//     coherent with the code that reads it.
//
// Three things are checked:
//   1. the generated wire names are exactly the six canonical service tool names
//   2. the caps + timing in the generated file are the ones wire.js actually exports
//      (i.e. wire.js really derives them, and did not quietly go back to literals)
//   3. DOCS DRIFT: every tool name mentioned in shipped prose is a real registered name.
//      A doc that names a tool the service does not register sends an agent to a
//      "Tool not found" it cannot diagnose — the docs are part of the wire surface.
"use strict";

const fs = require("fs");
const path = require("path");

const KIT = path.resolve(__dirname, "..");
const GEN_REL = path.join("packages", "core", "wire-contract.gen.js");

const gen = require(path.join(KIT, GEN_REL));
const wire = require(path.join(KIT, "packages", "core", "wire.js"));

let failed = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.log(`  ✗ ${msg}`);
    if (detail) console.log(`      ${detail}`);
  }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("contract-selftest — the generated wire contract, and the docs that name it");

// ── 1. the generated file is generated, and names the six canonical tools ────
const genSource = fs.readFileSync(path.join(KIT, GEN_REL), "utf8");
ok(
  /GENERATED FILE\. DO NOT EDIT\./.test(genSource) &&
    /node packages\/wire-contract\/gen\/gen-kit\.js/.test(genSource),
  "the generated file carries its DO-NOT-EDIT banner and names the command that rewrites it"
);

const CANONICAL = [
  "cpyany_check_source",
  "cpyany_poll",
  "cpyany_poll_results",
  "cpyany_test",
  "cpyany_test_results",
  "cpyany_wait",
];
const wireNames = [...gen.WIRE_TOOL_NAMES].sort();
ok(
  eq(wireNames, CANONICAL),
  `the generated file names exactly the ${CANONICAL.length} canonical service tools`,
  `got: ${wireNames.join(", ")}`
);
ok(
  eq([...new Set(Object.values(gen.TOOLS).map((t) => t.wireName))].sort(), CANONICAL),
  "…and TOOLS carries the same six, one entry per tool, no duplicates"
);
ok(
  gen.ALIAS_TOOL_NAMES.length > 0 && gen.ALIAS_TOOL_NAMES.every((n) => /^pingfusi_[a-z_]+$/.test(n)),
  `every job-named alias is a pingfusi_* name (${gen.ALIAS_TOOL_NAMES.length})`
);
ok(
  Object.values(gen.TOOLS).every((t) => t.frozen === true),
  "every tool is marked frozen — a wire name is added to, never renamed"
);

// The remap table is the kitRemap subset, and nothing else.
const expectedRemap = Object.fromEntries(
  Object.entries(gen.TOOLS).filter(([, t]) => t.kitRemap).map(([verb, t]) => [verb, t.wireName])
);
ok(eq(gen.LIVE_TOOL_NAME, expectedRemap), "LIVE_TOOL_NAME is exactly the kitRemap subset of TOOLS");

// ── 2. wire.js really reads the generated file ───────────────────────────────
ok(eq(wire.SERVICE_CAPS, gen.SERVICE_CAPS), "wire.SERVICE_CAPS is the generated caps object");
ok(
  wire.SERVICE_CAPS.maxSteps === gen.SERVICE_CAPS.maxSteps &&
    wire.SERVICE_CAPS.maxStepTextChars === gen.SERVICE_CAPS.maxStepTextChars &&
    wire.SERVICE_CAPS.maxOptionChars === gen.SERVICE_CAPS.maxOptionChars,
  `caps: ${gen.SERVICE_CAPS.maxSteps} steps / ${gen.SERVICE_CAPS.maxStepTextChars}-char step text` +
    ` / ${gen.SERVICE_CAPS.maxOptionChars}-char options`
);
ok(wire.MAX_REVIEW_RESULTS === gen.MAX_REVIEW_RESULTS, `n_target ceiling is ${gen.MAX_REVIEW_RESULTS}`);
ok(
  wire.DEFAULT_REVIEW_RESULTS === gen.DEFAULT_REVIEW_RESULTS,
  `n_target default is ${gen.DEFAULT_REVIEW_RESULTS}`
);
ok(
  gen.DEFAULT_REVIEW_RESULTS >= 1 && gen.DEFAULT_REVIEW_RESULTS <= gen.MAX_REVIEW_RESULTS,
  "the n_target default sits inside the range the service accepts"
);
// SERVICE_CAPS is the object handed to the kit's own filing-shape checker, and the
// result-count range is not part of it — never has been. Pin the shape so a widened contract
// cannot silently change what that checker iterates.
ok(
  eq(Object.keys(wire.SERVICE_CAPS).sort(), ["maxOptionChars", "maxStepTextChars", "maxSteps"]),
  "SERVICE_CAPS still carries exactly the three filing-shape caps"
);
ok(
  wire.DEFAULT_AGENT_LEASE_SECONDS === gen.DEFAULT_AGENT_LEASE_SECONDS,
  `agent lease default is ${gen.DEFAULT_AGENT_LEASE_SECONDS}s`
);
ok(
  wire.DEFAULT_WAIT_LEG_SECONDS === gen.DEFAULT_WAIT_LEG_SECONDS,
  `wait-leg default is ${gen.DEFAULT_WAIT_LEG_SECONDS}s (under common hosts' ~60s tool timeout)`
);
ok(wire.LIVE_TOOL_NAME === gen.LIVE_TOOL_NAME, "wire.LIVE_TOOL_NAME IS the generated table (not a copy)");
ok(
  wire.DEFAULT_WAIT_LEG_SECONDS < 60 && wire.DEFAULT_AGENT_LEASE_SECONDS >= wire.DEFAULT_WAIT_LEG_SECONDS,
  "a wait leg still fits inside one lease, and inside a one-minute host timeout"
);

// The search orders must lead with the CURRENT generation, or an upgrade re-reads a stale
// login before the fresh one.
ok(
  gen.CREDS_DIRS[0] === gen.LINEAGE.credsDirs.current &&
    gen.MCP_SERVER_KEYS[0] === gen.LINEAGE.mcpServerNames.current,
  `both search orders lead with the current generation (${gen.LINEAGE.credsDirs.current})`
);
ok(
  eq([...gen.CREDS_DIRS].sort(), [gen.LINEAGE.credsDirs.current, ...gen.LINEAGE.credsDirs.sweeps].sort()) &&
    eq([...gen.MCP_SERVER_KEYS].sort(),
       [gen.LINEAGE.mcpServerNames.current, ...gen.LINEAGE.mcpServerNames.sweeps].sort()),
  "each search order covers exactly the current name plus the lineage it sweeps"
);

// ── 3. docs drift: shipped prose may only name registered tools ─────────────
const KNOWN = new Set([...gen.WIRE_TOOL_NAMES, ...gen.ALIAS_TOOL_NAMES]);
const TOOL_TOKEN = /\b(?:cpyany|pingfusi)_[a-z_]+\b/g;

const docFiles = [];
const walkMd = (rel) => {
  const abs = path.join(KIT, rel);
  if (!fs.existsSync(abs)) return;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) walkMd(r);
    else if (e.name.endsWith(".md")) docFiles.push(r);
  }
};
walkMd("skill");
walkMd("use-cases");
if (fs.existsSync(path.join(KIT, "docs"))) {
  for (const f of fs.readdirSync(path.join(KIT, "docs")).sort()) {
    if (f.endsWith(".md")) docFiles.push(path.join("docs", f));
  }
}
if (fs.existsSync(path.join(KIT, "README.md"))) docFiles.push("README.md");

const unknown = [];
const seen = new Set();
for (const rel of docFiles) {
  fs.readFileSync(path.join(KIT, rel), "utf8").split("\n").forEach((line, i) => {
    for (const m of line.matchAll(TOOL_TOKEN)) {
      seen.add(m[0]);
      if (!KNOWN.has(m[0])) unknown.push(`${rel}:${i + 1}: ${m[0]} — ${line.trim().slice(0, 90)}`);
    }
  });
}

ok(docFiles.length > 0, `found shipped prose to lint (${docFiles.length} markdown files)`);
// A lint that matches nothing proves nothing. The docs DO name these tools; if they stop,
// that is a docs regression of its own and this assertion says so.
ok(seen.size > 0, `the lint is live — ${seen.size} distinct tool name(s) named in shipped prose`);
ok(
  unknown.length === 0,
  "every tool name in shipped prose is a registered wire name or job alias",
  unknown.slice(0, 20).join("\n      ")
);

console.log(
  failed ? `\n❌ contract-selftest: ${failed} assertion(s) failed.` : "\n✓ contract-selftest: all assertions pass."
);
process.exit(failed ? 1 : 0);
