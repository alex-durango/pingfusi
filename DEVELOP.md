# DEVELOP — how to make the kit better by cloning real sites

This is the **meta-loop**: you clone real sites to *exercise* the kit, and every miss
you hit becomes a permanent improvement to the kit — a tool check, a regression fixture,
and a generalized instruction. The **kit** (`tools/` + the `.md` instructions) is the
product; **targets** (`targets/<name>/`) are disposable instances you build and throw
away. Site B inherits everything site A taught, because the lessons live in the shared
kit, not in a per-site checklist.

Two nested loops:

```
OUTER (improve the kit) ── for each target site ──▶ INNER (clone it to green)
        ▲                                                   │
        └──────── every MISS the gate didn't catch ─────────┘
                  becomes: tool check + fixture + generalized instruction
```

---

## Inner loop — clone one site to green

Per target, this is just PLAYBOOK.md + RUNBOOK.md, made turn-key:

```sh
node harness/new-target.js siteA https://www.example.com/ 1728   # scaffold targets/siteA/
node tools/sink.js &                                             # snapshot receiver :7799
node harness/serve.js siteA                                      # serve clone + /tools :8080
```

Then, driven by measurements (never guesses):
1. **Measure the live site** at the target width (RUNBOOK) → save `targets/siteA/live.json`.
2. **Build** `targets/siteA/clone/` — **default: by capture** (LEARNINGS #19):
   `pxSendDom('http://localhost:7799/dom.html')` on the live tab, then
   `node harness/capture-build.js siteA` (self-hosted CSS/fonts, doctype preserved).
   Hand-rebuild to measurements only when exercising the rebuild path is the point of
   the run — that's where the technique-mismatch lessons came from.
3. **Capture** the clone → `targets/siteA/clone.json`, then score:
   ```sh
   node harness/score.js siteA      # visual PASS/FAIL, fix list, and Δ vs the last run
   ```
4. Fix each ❌, re-capture, re-score. `score.js` records every run to `scores.jsonl` and
   prints whether you got **better** (visual fails ↓). Done = `--visual` green **and**
   coverage empty (every painted leaf has a target) **and** strict deltas fixed-or-documented.

`score.js` turns "is this iteration better?" into a number instead of a vibe — that's the
inner-loop progress signal.

---

## Outer loop — the miss protocol (this is the engine)

The valuable event is a reviewer (or your own eyes) flagging something **that a green
`--visual` did not catch**. Don't just patch that one clone — that's how you iterate once
per site forever. Convert the miss into a kit improvement so it's caught *everywhere, next
time, automatically*:

1. **Localize the element that actually *paints* the mark** — it may be an ancestor.
   `node tools/pixel-diff.js --inspect el_live.json el_clone.json`. If the paint bucket is
   empty but it still looks wrong, you inspected the wrong element (PLAYBOOK Phase 6).
2. **Make it a MEASURED failure.** Teach the capture to record it as a number/box
   (`tools/browser-capture.js` **and** `tools/pixel-diff.js`, kept schema-identical) and
   `--visual` to compare it. The test: would the sweep now fail on the defect? (This is
   how `font.smoothing` and the underline **box** were added — LEARNINGS #12/#13.)
3. **Lock it in with a fixture — and score the change.** Add `harness/fixtures/NN-name.js`
   that fails *without* your tool change (see `harness/fixtures/README.md`); now it can
   never silently return. Then add the defect **and any false-positive it risks** to
   `harness/benchmarks/battery.js` and prove the change is a real improvement:
   `node harness/benchmarks/detection-power.js --vs HEAD` — the bar is **+N defect classes
   caught, 0 regressions** (0 missed defects, 0 new false positives). A change that
   false-positives a control is *not* an improvement, even if it catches the new defect.
   (The `bg` backdrop gate — #16 — was adopted exactly this way: the naive version
   false-positived on translucent/whitespace controls; the battery caught it *before*
   commit, and the gate was narrowed to opaque-only until the A/B came back clean.)
4. **Re-score every existing target.** `node harness/score.js siteA` (and siteB, …) — a
   tool change must not regress a clone that was already green. And
   `node harness/regression.js` must stay green.
5. **Generalize the instruction.** Write the durable lesson in `LEARNINGS.md`, tagged
   🔒 (gate-enforced — trust the diff) or 👁 (judgment — the diff can't see it). Compress
   the how-to in `PLAYBOOK.md` / `RUNBOOK.md` to "the gate checks this; your job is the
   technique." **Grow the tool, not a per-site checklist.**

If a miss genuinely *can't* be measured (a taste/technique call — e.g. "reproduce the
drawing technique so it rasterises identically"), it stays a 👁 judgment lesson. Name it
explicitly in LEARNINGS' "gate vs your eyes" list so it isn't forgotten — but prefer
pushing misses down into 🔒 whenever they can be measured.

---

## Cloning site B (and C, …)

Run the **same inner loop** on a new target. Because A's misses became tool checks, B
starts with a stronger gate — a wrong-thickness underline or a heavier smoothing fails on
B's first score without anyone re-noticing. B's *new* misses feed the same outer loop.
Over several sites the pattern converges: fewer review rounds per site, because the gate
keeps absorbing what used to need eyes.

Pick diverse targets on purpose — a site with `text-decoration` underlines, one with
`box-shadow` dividers, one with a sticky/scrolled header, one RTL — each stresses a
different corner and surfaces a different class of miss to absorb.

---

## What "better" means (the scoreboard)

- **Per target:** `scores.jsonl` — `visualFails` trending to 0, then coverage empty, then
  strict deltas each fixed-or-documented. A later run with fewer visual fails is better.
- **Per kit:** `node harness/regression.js` stays green (no known class of miss can
  recur), and the **number of review rounds to green trends down** across successive
  targets. That downward trend *is* the kit getting better.
- **Per gate change:** `node harness/benchmarks/detection-power.js` scores the gate at
  **all-defects-caught / 0-false-positives** (absolute mode, run by regression), and a
  *proposed* change is judged by `--vs HEAD` — **+N caught, 0 regressions** or it's not
  adopted. This turns "does this gate change help?" into a number, the same way `score.js`
  does for a clone. See `harness/benchmarks/README.md`.
- **Guardrail:** a kit change that makes any previously-green target regress, or turns
  regression red, is not an improvement — revert or fix.

---

## Layout

```
pixel-perfect-kit/
├── README.md PLAYBOOK.md LEARNINGS.md CLONE-ANY-HEADER.md   ← the product: instructions
├── DEVELOP.md                                               ← you are here (the meta-loop)
├── tools/            pixel-diff.js browser-capture.js extract-*.js sink.js
│   └── selftest.js   guards the gate's guarantees (underline box + smoothing)
├── harness/          the dev framework
│   ├── new-target.js  scaffold targets/<name>/
│   ├── capture-build.js  DEFAULT build: clone from the captured live DOM (LEARNINGS #19)
│   ├── review-qa.js    the review phase: scope-pinned pingfusi rounds as a gate
│   ├── serve.js       static server (clone + /tools)
│   ├── score.js       score live-vs-clone, compare to last run
│   ├── regression.js  selftest + every fixture + the detection battery
│   ├── fixtures/      one file per class-of-miss (can never recur)
│   └── benchmarks/    detection-power battery — score a gate change old-vs-new (--vs HEAD)
└── targets/          ← DISPOSABLE per-site instances (git-ignored); the kit is the product
    └── <name>/  target.json  clone/  live.json  clone.json  scores.jsonl  NOTES.md
```

Rule of thumb: if a change only helps one site, it belongs in `targets/<name>/`. If it
helps the *next* site, it belongs in the kit — as a tool check first, an instruction
second.
