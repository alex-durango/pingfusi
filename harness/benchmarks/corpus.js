// corpus.js — the REAL-SITE half of the detection instrument. The synthetic battery.js
// is fast and deterministic but hand-built; a gate can score +N/0 there yet still
// misbehave on an actual captured page. This scores the gate against FROZEN real
// captures — the exact live.json/clone.json snapshot pairs a real clone produced — so
// "does this gate change help?" is answered against reality too, not just synthetic cases.
//
// Layout — one directory per case under corpus/, committed so it travels with the kit:
//   corpus/<slug>/live.json     (frozen live capture, diff-ready snapshot)
//   corpus/<slug>/clone.json    (frozen clone capture)
//   corpus/<slug>/label.json    { "kind": "control"|"defect", "note": "...", "from": "target" }
//
//   • control → a clone that went GREEN on a real site. The gate MUST pass it; a flag is a
//     REAL false positive (it would have regressed a shipped-green clone).
//   • defect  → a real captured pair that is genuinely wrong (freeze the PRE-fix clone).
//     The gate MUST fail it; a pass is a REAL miss that a review round would have paid for.
//
// Freeze cases with harness/freeze-corpus.js. Snapshots are numeric boxes / font props /
// colours (no page text), so they commit cleanly; the shipped-surface leak-guard still
// scans them, which is the correct safety net if a family/class name ever trips it.

const fs = require("fs");
const path = require("path");

const CORPUS_DIR = path.join(__dirname, "corpus");

function loadCorpus() {
  let dirs = [];
  try { dirs = fs.readdirSync(CORPUS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()); }
  catch { return []; } // no corpus yet — starts empty, grows as clones are frozen
  const cases = [];
  for (const d of dirs) {
    const base = path.join(CORPUS_DIR, d.name);
    const lp = path.join(base, "live.json"), cp = path.join(base, "clone.json"), lb = path.join(base, "label.json");
    if (!fs.existsSync(lp) || !fs.existsSync(cp) || !fs.existsSync(lb)) {
      console.error(`⚠ corpus/${d.name} is incomplete (need live.json + clone.json + label.json) — skipping`);
      continue;
    }
    try {
      const live = JSON.parse(fs.readFileSync(lp, "utf8"));
      const clone = JSON.parse(fs.readFileSync(cp, "utf8"));
      const label = JSON.parse(fs.readFileSync(lb, "utf8"));
      const kind = label.kind === "defect" ? "defect" : "control";
      cases.push({ name: `real:${d.name}`, kind, live, clone, note: label.note || "" });
    } catch (e) { console.error(`⚠ corpus/${d.name}: ${e.message} — skipping`); }
  }
  return cases;
}

// Score the gate over the real corpus. Mirrors battery.scoreGate's return shape so the
// two can be summed and the same A/B loop handles both.
function scoreCorpus(diffSnapshots) {
  let caught = 0, defects = 0, falsePos = 0, controls = 0;
  const rows = loadCorpus().map(({ name, kind, live, clone, note }) => {
    const pass = diffSnapshots(live, clone, { visual: true }).ok;
    if (kind === "defect") { defects++; if (!pass) caught++; }
    else { controls++; if (!pass) falsePos++; }
    return { name, kind, pass, note, correct: kind === "defect" ? !pass : pass };
  });
  return { rows, caught, defects, falsePos, controls };
}

module.exports = { loadCorpus, scoreCorpus, CORPUS_DIR };
