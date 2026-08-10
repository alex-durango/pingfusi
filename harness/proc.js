// harness/proc.js — cross-platform child-process invocation for the two spawn shapes
// that break on Windows. npm ships no npm.exe: it is npm.cmd, a batch file, and Node
// refuses to spawn .cmd/.bat without a shell (EINVAL since the CVE-2024-27980 hardening,
// 18.20+) — so every bare `spawnSync("npm", …)` fails before npm even starts. And
// `command -v` is a shellism run through `sh`, which Windows doesn't have — so the PATH
// probe answered null right after the user's own `npm i -g pingfusi@latest` succeeded.
// Found live 2026-08-10 on a Windows first-run of `npx pingfusi setup` (LEARNINGS #42).
//
// shell:true does NOT escape args, so any arg that can carry a space (a --prefix path
// under C:\Users\<name with a space>\…) is quoted here, in ONE place. The *Invocation
// builders are pure and take an explicit platform so selftests can pin the Windows
// shape from any host.
"use strict";

const { spawnSync } = require("child_process");

function npmInvocation(args, platform = process.platform) {
  if (platform !== "win32") return { command: "npm", args, shell: false };
  const command = ["npm", ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  return { command, args: null, shell: true };
}

function spawnNpmSync(args, options = {}, platform = process.platform) {
  const inv = npmInvocation(args, platform);
  return inv.shell
    ? spawnSync(inv.command, { ...options, shell: true })
    : spawnSync(inv.command, inv.args, options);
}

function whichInvocation(cmd, platform = process.platform) {
  return platform === "win32"
    ? { command: "where", args: [cmd] }
    : { command: "sh", args: ["-c", `command -v ${cmd}`] };
}

// Resolve WHERE a command lives, or null. `where` prints every match one per line;
// the first is the one PATH actually resolves.
function whichSync(cmd, platform = process.platform) {
  const inv = whichInvocation(cmd, platform);
  try {
    const r = spawnSync(inv.command, inv.args, { stdio: "pipe", timeout: 10_000 });
    const first = String(r.stdout || "").split(/\r?\n/)[0].trim();
    return r.status === 0 && first ? first : null;
  } catch (e) {
    return null;
  }
}

module.exports = { npmInvocation, spawnNpmSync, whichInvocation, whichSync };
