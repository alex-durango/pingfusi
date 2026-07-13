// fixtures/24-font-formats.js — "I validated nothing" must never render as a pass.
//
// Paid for on lelabo (2026-07-12). The assets gate walked the clone for `.woff2` files and
// checked their wOF2 magic bytes. lelabo self-hosts 26 fonts and NOT ONE is a woff2 — it ships
// an older stack (.eot / .ttf / .woff). So the gate found zero files, validated zero bytes, and
// PASSED, printing "0 woff2 asset(s) validated". Every one of those fonts could have been a 404
// HTML page renamed .ttf and nothing would have said a word.
//
// Same absence-of-evidence class as LEARNINGS #22: a check that could not look must not report a
// negative. The gate now validates whatever font formats are ACTUALLY present (woff2/woff/ttf/
// otf/eot magic), refuses an empty file, and names the count per format in its receipt so it is
// visible WHAT was checked.
//
// Second class, same fixture: a self-hosted font the CSS REFERENCES but that is missing from disk
// 404s in the browser and the text silently falls back — while `font.family` still computes to the
// declared family, so --visual stays green and nothing ever says the glyphs are wrong.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path");
const { execFileSync } = require("child_process");

let bad = 0;
const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

const KIT = path.join(__dirname, "..", "..");
const WF = path.join(KIT, "harness", "workflow.js");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "ppk-fonts-"));
process.on("exit", () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) {} });

const NAME = "t";
const dir = path.join(work, "targets", NAME);
const fontsDir = path.join(dir, "clone", "assets", "fonts");
const cssDir = path.join(dir, "clone", "assets", "css");
fs.mkdirSync(fontsDir, { recursive: true });
fs.mkdirSync(cssDir, { recursive: true });
fs.writeFileSync(path.join(dir, "target.json"), JSON.stringify({ name: NAME, url: "https://example.com/", width: 1728 }));
fs.writeFileSync(path.join(dir, "clone", "index.html"), "<!DOCTYPE html><html><body>x</body></html>");

execFileSync("node", [WF, "init", NAME, "https://example.com/", "1728"], { cwd: work, stdio: "pipe" });

const gate = () => {
  try {
    return { code: 0, out: execFileSync("node", [WF, "gate", NAME, "assets"], { cwd: work, stdio: "pipe" }).toString() };
  } catch (e) { return { code: e.status, out: (e.stdout || "").toString() + (e.stderr || "").toString() }; }
};

// real magic bytes, per format
const REAL = {
  "a.woff2": Buffer.concat([Buffer.from("wOF2", "latin1"), Buffer.alloc(64)]),
  "b.woff": Buffer.concat([Buffer.from("wOFF", "latin1"), Buffer.alloc(64)]),
  "c.otf": Buffer.concat([Buffer.from("OTTO", "latin1"), Buffer.alloc(64)]),
  "d.ttf": Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.alloc(64)]),
  "e.eot": (() => { const b = Buffer.alloc(64); b[34] = 0x4c; b[35] = 0x50; return b; })(),
};

// 1) a lelabo-shaped clone: legacy fonts only, all REAL → passes, and the receipt must NAME what
//    it validated (not "0 woff2 validated", which is what the old gate said while checking nothing)
fs.writeFileSync(path.join(fontsDir, "b.woff"), REAL["b.woff"]);
fs.writeFileSync(path.join(fontsDir, "d.ttf"), REAL["d.ttf"]);
fs.writeFileSync(path.join(fontsDir, "e.eot"), REAL["e.eot"]);
{
  const r = gate();
  check("legacy fonts (.woff/.ttf/.eot) are VALIDATED, not ignored", r.code === 0 && /1\.woff/.test(r.out) && /1\.ttf/.test(r.out) && /1\.eot/.test(r.out));
  check("the receipt no longer claims '0 woff2 validated' while checking nothing", !/0 woff2/.test(r.out));
}

// 2) THE MISS: a legacy font that is NOT a font (a 404 page renamed .ttf) must FAIL.
//    The old gate never opened it — it only looked at .woff2 — so this passed silently.
fs.writeFileSync(path.join(fontsDir, "d.ttf"), Buffer.from("<!DOCTYPE html><html>404 Not Found</html>"));
{
  const r = gate();
  check("a 404 page renamed .ttf is REFUSED by name (the lelabo hole)", r.code !== 0 && /not a real ttf/.test(r.out));
}
fs.writeFileSync(path.join(fontsDir, "d.ttf"), REAL["d.ttf"]); // restore

// 3) an EMPTY font file (the download failed) must FAIL — zero bytes is not a font
fs.writeFileSync(path.join(fontsDir, "f.woff2"), Buffer.alloc(0));
{
  const r = gate();
  check("an empty (0-byte) font is REFUSED", r.code !== 0 && /EMPTY/.test(r.out));
}
fs.rmSync(path.join(fontsDir, "f.woff2"));

// 4) a woff2 with bad magic still fails (the original guard must survive)
fs.writeFileSync(path.join(fontsDir, "g.woff2"), Buffer.from("NOTAFONT........"));
{
  const r = gate();
  check("a renamed/hand-faked .woff2 still fails (original guard intact)", r.code !== 0 && /not a real woff2/.test(r.out));
}
fs.rmSync(path.join(fontsDir, "g.woff2"));

// 5) a self-hosted font the CSS references but that is MISSING from disk must FAIL —
//    it 404s and the text falls back while font.family still matches, so --visual stays green
fs.writeFileSync(path.join(cssDir, "site.css"), `@font-face{font-family:Magda;src:url('../fonts/gone.woff2') format('woff2'),url('../fonts/b.woff') format('woff');}`);
{
  const r = gate();
  check("a CSS-referenced font missing from disk is REFUSED (silent fallback, --visual stays green)", r.code !== 0 && /NOT on disk/.test(r.out) && /gone\.woff2/.test(r.out));
}

// 6) …but a REMOTE font url is a documented tradeoff, not a missing file — it must not flag
fs.writeFileSync(path.join(cssDir, "site.css"), `@font-face{font-family:Magda;src:url('https://cdn.example.com/x.woff2') format('woff2'),url('../fonts/b.woff') format('woff');}`);
{
  const r = gate();
  check("a REMOTE font url does not false-positive (it is a tradeoff, not a missing file)", r.code === 0);
}

// 7) no fonts at all (system-font site) still passes — the gate must not invent a requirement
fs.rmSync(fontsDir, { recursive: true, force: true });
fs.rmSync(path.join(cssDir, "site.css"));
{
  const r = gate();
  check("a system-font clone (no self-hosted fonts) still passes, and says so", r.code === 0 && /no self-hosted fonts/.test(r.out));
}

console.log(bad ? `\n❌ 24-font-formats: ${bad} check(s) failed.` : "\n✓ 24-font-formats: the assets gate validates every font format it ships, and never passes on a check it did not run.");
process.exit(bad ? 1 : 0);
