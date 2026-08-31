// harness/skill-provenance.js — tell OUR own older skill from the user's hand edit.
//
// `pingfusi setup` (and every brand riding the kit, e.g. `qaping setup`) PRESERVES
// an installed SKILL.md whose bytes differ from the shipped one: a plain re-run must
// never clobber a local edit. Nothing on disk said WHICH kind of difference it was,
// so that rule also froze every existing install on whatever skill version first
// landed there — a package upgrade shipped new agent guidance that only `--force`
// would ever deliver. Found live on the qaping 0.1.2 → 0.1.6 upgrades, where the
// skill's new doctrine reached fresh installs only (QAPING_PLAN.md §8).
//
// Provenance closes it. Every skill root ships SHIPPED-HASHES.json beside its skill
// directories: for each skill, the sha256 of every version this package has ever
// shipped. Bytes on disk whose hash is in that list ARE ours — refresh them
// silently. Anything else is the user's, and is still preserved.
//
// The manifest is APPEND-ONLY (an entry leaving it would re-freeze exactly the
// installs that carry it) and is generated from git history + the working tree by
// `node scripts/gen-skill-hashes.js`. missingCurrentSkills() is the executable check
// that keeps it true — doctor-selftest (kit) and qaping-selftest (wrapper) fail when
// a skill's CURRENT bytes are absent, so a skill edit and its manifest entry land in
// the same commit.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MANIFEST_BASENAME = "SHIPPED-HASHES.json";

const MANIFEST_NOTE =
  "sha256 of every SKILL.md version this package has shipped (LF-normalized). " +
  "setup refreshes an installed skill whose hash is listed here — it is ours — and preserves anything else as a local edit. " +
  "APPEND-ONLY; regenerate with: node scripts/gen-skill-hashes.js [<skill-root>...]";

// Hash LF-normalized text: a checkout or copy that rewrote line endings is still our
// content, not a hand edit, and must not be mistaken for one on Windows.
function hashSkill(content) {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
  return crypto.createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function manifestPath(skillRoot) {
  return path.join(skillRoot, MANIFEST_BASENAME);
}

// Every skill a root ships: a directory holding a SKILL.md. Same listing install()
// walks, so "what is a skill" is defined once.
function skillNames(skillRoot) {
  try {
    return fs
      .readdirSync(skillRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(skillRoot, e.name, "SKILL.md")))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// Never throws. A missing or corrupt manifest degrades to "nothing on disk is ours",
// i.e. exactly the preserve-everything behavior that shipped before it existed — a
// broken manifest can only cost a refresh, never a user's edit.
function loadManifest(skillRoot) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath(skillRoot), "utf8"));
  } catch {
    return {};
  }
  const skills = parsed && typeof parsed === "object" ? parsed.skills : null;
  return skills && typeof skills === "object" && !Array.isArray(skills) ? skills : {};
}

function isShippedVersion(manifest, name, content) {
  const hashes = manifest && manifest[name];
  return Array.isArray(hashes) && hashes.includes(hashSkill(content));
}

// The executable check behind the append-only rule: skills whose CURRENT bytes are
// not in the manifest. Non-empty means the manifest is stale — the version about to
// ship would be unrecognizable to the NEXT release, re-freezing every install of it.
function missingCurrentSkills(skillRoot) {
  const manifest = loadManifest(skillRoot);
  return skillNames(skillRoot).filter((n) => {
    try {
      return !isShippedVersion(manifest, n, fs.readFileSync(path.join(skillRoot, n, "SKILL.md")));
    } catch {
      return false; // unreadable source is a broken install, not a stale manifest
    }
  });
}

module.exports = {
  MANIFEST_BASENAME,
  MANIFEST_NOTE,
  hashSkill,
  manifestPath,
  skillNames,
  loadManifest,
  isShippedVersion,
  missingCurrentSkills,
};
