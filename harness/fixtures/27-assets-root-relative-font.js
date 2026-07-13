// fixtures/27-assets-root-relative-font.js — the assets gate resolved a URL as a filesystem path.
//
// Paid for on gorjana (2026-07-13), corroborated on lelabo. The missing-font check treats a CSS
// `url(...)` ref as a path relative to the css file: `path.resolve(cssDir, ref)`. But a ref is a
// URL the BROWSER resolves against the SERVE ROOT — and capture-build writes root-relative refs
// (`/assets/fonts/x.woff`), which serve.js maps to `clone/assets/fonts/x.woff`. To
// `path.resolve`, a leading "/" means "discard cssDir, probe the filesystem root": the gate went
// looking for /assets/fonts/dk-icons-old.woff on the MACHINE, found nothing, and reported a font
// that was sitting exactly where the browser would load it from as "NOT on disk".
//
// Measured blast radius: gorjana blocked on 1 phantom; lelabo — a target that went fully green
// with every font on disk — reports 50 phantom missing fonts under the pre-fix gate. Same class
// as LEARNINGS #23: the instrument inventing friction, this time in a workflow gate rather than
// the diff. The operator's only moves were to "fix" a non-defect or --force past a lying gate —
// and a forced phase poisons the done gate. A false positive spends the same trust as a miss.
//
// The fix must NOT cost the real detection: a font that genuinely is not on disk — by either
// ref shape — must still fail. That's what the controls below hold.
"use strict";
const cp = require("child_process"), fs = require("fs"), os = require("os"), path = require("path");
let bad = 0; const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

const KIT = path.join(__dirname, "..", "..");
const WORKFLOW = path.join(KIT, "harness", "workflow.js");

// A minimal real wOFF header (magic + padding) — enough for the magic-byte validator.
const WOFF = Buffer.concat([Buffer.from("wOFF"), Buffer.alloc(44)]);

// Scaffold a disposable target whose clone css references fonts by the given refs, with the
// given files actually on disk. Returns the gate's {status, output}.
function gateWith(tag, refs, files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ppk-fix27-${tag}-`));
  const tdir = path.join(tmp, "targets", "t");
  const cssDir = path.join(tdir, "clone", "assets", "css");
  const fontDir = path.join(tdir, "clone", "assets", "fonts");
  fs.mkdirSync(cssDir, { recursive: true });
  fs.mkdirSync(fontDir, { recursive: true });
  fs.writeFileSync(path.join(tdir, "target.json"), JSON.stringify({ name: "t", url: "https://x.test/", width: 1728 }));
  fs.writeFileSync(path.join(cssDir, "main.css"), refs.map((r) => `@font-face{font-family:f;src:url(${r})}`).join("\n"));
  for (const f of files) fs.writeFileSync(path.join(tdir, "clone", f), WOFF);
  const init = cp.spawnSync(process.execPath, [WORKFLOW, "init", "t"], { encoding: "utf8", cwd: tmp, timeout: 30000 });
  if (init.status !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error(`workflow init failed: ${(init.stdout || "") + (init.stderr || "")}`); }
  const r = cp.spawnSync(process.execPath, [WORKFLOW, "gate", "t", "assets"], { encoding: "utf8", cwd: tmp, timeout: 30000 });
  fs.rmSync(tmp, { recursive: true, force: true });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

// 1) THE FALSE POSITIVE — a root-relative ref whose font IS on disk (where serve.js serves it
//    from) must pass. Pre-fix this reported "NOT on disk" for a file the browser loads fine.
{
  const r = gateWith("rootrel", ["/assets/fonts/a.woff"], ["assets/fonts/a.woff"]);
  check("root-relative ref + font on disk → PASS (the phantom is gone)", /PASS/.test(r.out) && !/NOT on disk/.test(r.out));
}

// 2) css-relative refs keep working — both shapes resolve to the same file.
{
  const r = gateWith("cssrel", ["../fonts/b.woff"], ["assets/fonts/b.woff"]);
  check("css-relative ref (../fonts/…) + font on disk → still PASS", /PASS/.test(r.out) && !/NOT on disk/.test(r.out));
}

// 3) CONTROL — a root-relative ref with NO file must still FAIL (the fix must not blind the
//    gate to genuinely missing fonts of the very shape it used to false-positive on).
{
  const r = gateWith("rootmiss", ["/assets/fonts/gone.woff"], []);
  check("CONTROL: root-relative ref, font NOT on disk → still FAIL", /FAIL/.test(r.out) && /gone\.woff/.test(r.out));
}

// 4) CONTROL — a css-relative ref with no file still fails too (unchanged behaviour).
{
  const r = gateWith("cssmiss", ["../fonts/alsogone.woff"], []);
  check("CONTROL: css-relative ref, font NOT on disk → still FAIL", /FAIL/.test(r.out) && /alsogone\.woff/.test(r.out));
}

// 5) remote and inline refs stay out of scope — an absolute URL is a documented remote-origin
//    tradeoff, not a missing file (unchanged; guards against the fix widening the check).
{
  const r = gateWith("remote", ["https://cdn.x.test/c.woff", "//cdn.x.test/d.woff"], []);
  check("remote refs (https://, //) are not checked → PASS", /PASS/.test(r.out) && !/NOT on disk/.test(r.out));
}

console.log(bad ? `\n❌ 27-assets-root-relative-font: ${bad} check(s) failed.` : "\n✓ 27-assets-root-relative-font: the missing-font check resolves refs the way the BROWSER does (root-relative → serve root) — no phantom missing fonts, and genuinely missing fonts of both shapes still fail.");
process.exit(bad ? 1 : 0);
