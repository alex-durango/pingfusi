// Shared Node runtime floor. The root CLI directly depends on @inquirer/prompts, whose
// supported range intentionally skips odd Node 21 and early 20/22/23 releases.
"use strict";

const RANGE = "^20.17.0 || ^22.13.0 || >=23.5.0";
const DISPLAY_RANGE = "Node 20.17+, 22.13+, or 23.5+";

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value || ""));
  return match ? match.slice(1).map(Number) : null;
}

function supportsNode(value) {
  const parsed = parseVersion(value);
  if (!parsed) return false;
  const [major, minor] = parsed;
  if (major === 20) return minor >= 17;
  if (major === 22) return minor >= 13;
  if (major === 23) return minor >= 5;
  return major >= 24;
}

module.exports = { RANGE, DISPLAY_RANGE, parseVersion, supportsNode };
