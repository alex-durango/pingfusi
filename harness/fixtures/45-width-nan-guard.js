// fixtures/45-width-nan-guard.js — `pingfusi new <name> <url> default` WROTE NaN INTO target.json.
//
// Paid for on a real reviewed run (2026-07-20, kit 0.9.0): an agent passed the literal string
// "default" as the width argument. `+(widthArg || 1728)` coerced it to NaN, target.json shipped
// `"width": NaN → null`, and every downstream gate then compared positions against a width that
// does not exist. The scaffold never refused, so the poison was silent until a gate mis-fired.
//
// The rule this locks: a malformed width (non-numeric, zero, negative) is a USAGE ERROR at the
// door — both at the dispatcher (`pingfusi new`) and at the writers themselves (new-target.js,
// adopt.js, for direct `node harness/…` runs) — and NOTHING is scaffolded. A valid width and the
// no-width default (1728, the kit's real default) still work, and adopt.js's default now AGREES
// with new-target.js's (it used to scaffold 1512 while everything else said 1728).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const KIT = path.resolve(__dirname, "..", "..");
let bad = 0;
const check = (n, c, detail) => { console.log(`${c ? "✓" : "✗"} ${n}${!c && detail ? ` — ${detail}` : ""}`); if (!c) bad++; };

const work = fs.mkdtempSync(path.join(os.tmpdir(), "pingfusi-width-nan-"));
const run = (script, args) => {
  try { return { status: 0, out: execFileSync("node", [path.join(KIT, script), ...args], { cwd: work, stdio: "pipe" }).toString() }; }
  catch (e) { return { status: e.status, out: (e.stdout || "").toString() + (e.stderr || "").toString() }; }
};
const targetJson = (name) => {
  const p = path.join(work, "targets", name, "target.json");
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
};

// ── the dispatcher refuses BEFORE anything is scaffolded (the observed miss verbatim) ──
const d1 = run("harness/workflow.js", ["new", "wnan", "https://example.com/", "default"]);
check('`pingfusi new … default` is a usage error (exit 2), naming the width', d1.status === 2 && /width must be a positive number/.test(d1.out), d1.out);
check("…and nothing was scaffolded", !fs.existsSync(path.join(work, "targets", "wnan")));
const d2 = run("harness/workflow.js", ["new", "wzero", "https://example.com/", "0"]);
check("`pingfusi new … 0` is refused too (<=0)", d2.status === 2 && !fs.existsSync(path.join(work, "targets", "wzero")));

// ── the writers guard themselves (direct node runs bypass the dispatcher) ──
const n1 = run("harness/new-target.js", ["wnan2", "https://example.com/", "default"]);
check("new-target.js refuses a non-numeric width directly", n1.status !== 0 && /width must be a positive number/.test(n1.out), n1.out);
check("…and never writes a NaN target.json", targetJson("wnan2") === null);
const a1 = run("harness/adopt.js", ["anan", "https://example.com/", "default"]);
check("adopt.js refuses a non-numeric width directly", a1.status !== 0 && /width must be a positive number/.test(a1.out), a1.out);
check("…and never writes a NaN target.json", targetJson("anan") === null);

// ── valid widths and the default still work, and the default is ONE number (1728) ──
const ok1 = run("harness/new-target.js", ["wgood", "https://example.com/", "1440"]);
check("a numeric width scaffolds normally", ok1.status === 0 && targetJson("wgood") && targetJson("wgood").width === 1440, ok1.out);
const ok2 = run("harness/new-target.js", ["wdef", "https://example.com/"]);
check("no width → the kit default 1728", ok2.status === 0 && targetJson("wdef") && targetJson("wdef").width === 1728, ok2.out);
const ok3 = run("harness/adopt.js", ["adef", "https://example.com/"]);
check("adopt's default agrees: 1728, not the stale 1512", ok3.status === 0 && targetJson("adef") && targetJson("adef").width === 1728, ok3.out);

fs.rmSync(work, { recursive: true, force: true });
console.log(bad ? `\n❌ 45-width-nan-guard: ${bad} check(s) failed.` : "\n✓ 45-width-nan-guard: no NaN ever reaches target.json, and the width default is one number.");
process.exit(bad ? 1 : 0);
