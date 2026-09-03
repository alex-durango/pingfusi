#!/usr/bin/env node
// List and free the hosted game builds this account holds.
//
// WHY THIS EXISTS. A hosted build occupies one of a small number of live
// slots, and until 2026-08-28 nothing a developer — or their agent — could
// reach from a terminal could even NAME the builds occupying them. A publish
// that hit the cap printed a number and a bare REST verb, so the loop stopped
// and asked a human, which is the one thing an automatic QA loop must not do.
// This is the missing half: see what you are holding, and free one.
//
//   pingfusi builds                 what is live, oldest first
//   pingfusi builds rm <slug>       delete one now (frees its slot)
//
// Deleting a build breaks the /b/<slug> download for anyone who has it, so a
// build a review round is still using must be left alone. Builds that never
// finished uploading can never be in a round (filing requires a finalized
// build) and are marked as safe to delete.
"use strict";

const core = require("../packages/core");

const usageFor = (brandCommand) =>
  `usage: ${brandCommand} [--json]   |   ${brandCommand} rm <slug> [--json]`;
const BRAND_COMMAND = "pingfusi builds";

const fmtMb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

const RM_VERBS = ["rm", "delete", "remove"];

function parseArgs(argv, usage = usageFor(BRAND_COMMAND)) {
  const out = { action: "list", slug: null, json: false, help: false };
  const rest = [];
  let positionalOnly = false;
  for (const arg of argv) {
    // A slug is 9 random bytes base64url, so ~1 in 64 of them BEGINS WITH "-".
    // Read the token after `rm` as the operand whatever it looks like, or the
    // remedy this whole command exists to provide is unrunnable for those
    // builds — the exact shape of dead-end it was written to close. `--` works
    // too, for anyone who reaches for it.
    if (!positionalOnly && arg === "--") { positionalOnly = true; continue; }
    const expectingSlug = rest.length === 1 && RM_VERBS.includes(rest[0]);
    if (!positionalOnly && !expectingSlug) {
      if (arg === "--json") { out.json = true; continue; }
      if (arg === "--help" || arg === "-h") { out.help = true; continue; }
      if (arg.startsWith("-")) throw new Error(`unknown option ${arg} — ${usage}`);
    }
    rest.push(arg);
  }
  if (out.help) return out;
  if (rest.length === 0) return out;
  const verb = rest[0];
  if (RM_VERBS.includes(verb)) {
    out.action = "rm";
    out.slug = rest[1] || null;
    if (!out.slug) throw new Error(`which build? — ${usage}`);
    if (rest.length > 2) throw new Error(`one slug at a time — ${usage}`);
    return out;
  }
  // A bare slug is a common slip; name the real command rather than guessing
  // at a destructive action from an ambiguous argument.
  throw new Error(`unknown builds command "${verb}" — ${usage}`);
}

/** One line per build, plus the header and the remedy. Pure so the selftest
 * can assert the rendering without a network. */
function renderList({ builds, live, cap }, brandCommand) {
  if (!builds.length) {
    return [`no live builds${cap ? ` (cap ${cap})` : ""} — publish one with \`${brandCommand.replace(/ builds$/, " publish-build")} <game.zip> --platform windows|macos\``];
  }
  const lines = [`${live} live build${live === 1 ? "" : "s"}${cap ? ` of ${cap}` : ""}, oldest first:`];
  for (const b of builds) {
    const label = b.name ? ` "${b.name}"` : "";
    // expires_at is null for a permanent build (kept until deleted — the
    // default since service migration 061).
    const life = b.expires_at ? `expires ${b.expires_at}` : "kept until deleted";
    const state = b.reclaimable
      ? "never finished uploading — safe to delete"
      : b.in_round
        ? `IN USE by an open round — deleting it 404s the download mid-session. ${life}`
        : life;
    lines.push(`  ${b.slug}  ${b.filename}${label} (${fmtMb(b.bytes || 0)}, ${b.platform})`);
    lines.push(`    ${b.url}`);
    lines.push(`    ${state}`);
  }
  if (cap && live >= cap) {
    // Name a slug only when deleting it is provably safe. The oldest finalized
    // build is the likeliest one a playtester is downloading right now.
    const free = builds.find((b) => b.reclaimable) || builds.find((b) => b.in_round === false);
    lines.push(free
      ? `  at the cap — free a slot: ${brandCommand} rm ${free.slug}`
      : `  at the cap — every one is finished and in use by an open round; wait for a round to end, or delete one deliberately: ${brandCommand} rm <slug>`);
  } else {
    lines.push(`  free a slot any time: ${brandCommand} rm <slug>`);
  }
  return lines;
}

// opts is the wrapper-brand seam: {brandCommand} — absent, stock pingfusi.
async function main(argv = process.argv.slice(2), opts = {}) {
  const brandCommand = opts.brandCommand || BRAND_COMMAND;
  const usage = usageFor(brandCommand);
  let options;
  try { options = parseArgs(argv, usage); }
  catch (error) { console.error(`✗ ${error.message}`); process.exitCode = 2; return; }
  if (options.help) { console.log(usage); return; }

  try {
    if (options.action === "rm") {
      await core.build.delete(options.slug);
      if (options.json) console.log(JSON.stringify({ deleted: options.slug }, null, 2));
      else console.log(`✓ deleted build ${options.slug} — its slot is free and /b/${options.slug} no longer downloads`);
      return;
    }
    const listing = await core.build.list();
    if (options.json) { console.log(JSON.stringify(listing, null, 2)); return; }
    for (const line of renderList(listing, brandCommand)) console.log(line);
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
module.exports = { parseArgs, renderList, main, usageFor };
