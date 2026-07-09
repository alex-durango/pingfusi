# Prompt template — clone a whole site (or page), one shot, reviewer-approved

The ONE-SHOT pipeline: hand this to an agent and wait; the deliverable comes back
pixel-perfect **with receipts** — every gate green, in order, and a real reviewer's
approval recorded as the `reviewer` phase. The operator's only job is to have run
`pingfusi setup` once (pingfusi auth) and have `cloudflared` installed.

**Fill in:**
- `{{URL}}` — the live page to clone, e.g. `https://www.example.com/`
- `{{WIDTH}}` — the measurement viewport width in px, e.g. `1512`
- `{{NAME}}` — the target name, e.g. `example`

---

Produce a **pixel-perfect, reviewer-approved clone of the page at {{URL}}** at
**{{WIDTH}}px**, as the standalone target `targets/{{NAME}}/clone/`. Work
unattended until `pingfusi gate {{NAME}} done` exits 0 — that is the definition of
done, and it now includes a pingfusi review approval. Do not stop at "the
numbers match": stop when the receipts say a reviewer agreed.

**Before writing any code, read and follow exactly:** `PLAYBOOK.md`,
`tools/RUNBOOK.md`, `LEARNINGS.md`, `WORKFLOW.md`. Their rules override any
assumption you have.

**Work the FAST loop (RUNBOOK "The fast fix loop") — the reviewer answers in
minutes, so the agent is the bottleneck, not the reviewer:**
- Start `node tools/sink.js` and `node harness/tunnel.js --sink` (background)
  FIRST — every capture (pxSend/pxSendDom/pxBehaviorSend) then delivers in one
  call through the sink tunnel; stash/chunked-read is a last resort.
- After a scoped fix, re-capture only the affected targets and fold them in with
  `node tools/merge-snapshot.js` — full N-target re-captures are for the final
  pass only (the done gate enforces one clean full capture at the end).
- When a fix's acceptability is uncertain (contested content, blur quality,
  "is this what they meant?"), spend a ~$0.05 micro-poll —
  `pingfusi review {{NAME}} poll "…" --choices "Yes,No"` — BEFORE burning a full test
  round on it. Polls advise; only full rounds satisfy the review gate.
- **On every REFILE, pass `--changelog "what changed since the last review"`** —
  a reviewer who isn't told what changed reviews blind ("did you fix
  anything?" is a wasted round). And **never escalate a reviewer's comment
  out of the loop**: respond with a fix or an in-round explanation and
  refile — the verdict is the only decision channel.
- **ALL reviewer contact goes through `pingfusi review {{NAME}} …` — NEVER call the
  the review MCP tools directly.** Direct calls are invisible to the
  workflow (no recorded round → the review gate can't verify the answer) and
  skip the kit's template. And know the two shapes: **a poll may reference ONE
  side only** (a live-observation or taste question — "on the real page, does
  X scrub?"); any question naming BOTH the clone and the live page is a
  COMPARISON and must be a **filed test** (`pingfusi review {{NAME}} file
  [--region "…"]`) so the reviewer gets the side-by-side + align view +
  pinned comments. The poll command refuses comparison-shaped questions.
- Before every `reviewer file`: self-QA the dynamics (overlay/flicker-compare the
  clone vs live at 2–3 rotation/reveal states) — a defect you catch yourself
  costs seconds; one the reviewer catches costs a round.

**The sequence (each step's gate must pass before the next — `pingfusi status {{NAME}}`
always tells you what's next):**

1. **Scaffold + pin the target.** `pingfusi new {{NAME}} {{URL}} {{WIDTH}}` → advance
   `target`. If your browser can't reach exactly {{WIDTH}}px, record the real
   width in `target.json` and measure everything at that width.

2. **Build by capture — never hand-rebuild** (LEARNINGS #19; PLAYBOOK Phase 4).
   Settle the live page (load, scroll bottom-and-back, confirm stable
   scrollHeight + node count twice), capture the doctype-exact DOM
   (`pxSendDom('http://localhost:7799/dom.html')`, sink running in
   `targets/{{NAME}}/`), then `pingfusi capture-build {{NAME}} --qa-toolbar`.
   Delivery blocked? Fall back per RUNBOOK (stash/chunked `pxRead`; or curl the
   SSR HTML **only after verifying** its structure matches the hydrated DOM —
   element-count comparison minimum). Attest `assets` with real evidence.

3. **Measure BOTH pages at the same width** (RUNBOOK). Full-page `pxTargets`:
   every distinct painted element; for long repeats (cards, rows) sample
   first + last + a spread (the 37signals precedent) and say so in NOTES.md.
   Enumerate coverage with `element.checkVisibility({checkVisibilityCSS:true,
   checkOpacity:true})` — per-node `getComputedStyle` lies inside closed
   `<details>` (opendesign lesson).

4. **Gate loop:** `--visual` until 0 fails → close `coverage` → `strict` (fix or
   document every structural delta — a colour/underline row is NEVER structural).

5. **Reproduce the dynamics (`behavior` phase — PLAYBOOK Phase 5c).** Inject
   `tools/behavior-capture.js` on the live tab, name the marquees/hover triggers you
   can see, and run the discovery pass (`pxBehaviorSend` → `behaviors-live.json`) —
   it greps `@keyframes` + markers for candidates, then a MutationObserver +
   scripted scroll sweep confirms and MEASURES what actually fires. Reproduce each
   inventoried behavior in one vanilla `clone/fixes.js` (values from the
   measurements, never eyeballed), rebuild with `pingfusi capture-build {{NAME}}
   --fixes`, run the same discovery on the clone (`behaviors-clone.json`), and loop
   until `pingfusi gate {{NAME}} behavior` passes. Genuinely irreproducible content
   (WebGL/canvas generative) is documented in `behavior-deviations.json` — never
   silently frozen. Re-run the pixel gates after: `done` re-verifies everything.

6. **Review rounds — driven by you.** `pingfusi serve {{NAME}}` →
   `pingfusi tunnel {{NAME}}` (it refuses to record a tunnel that isn't serving the
   clone byte-identically — trust that check) → `pingfusi review {{NAME}} file`
   (scope-pinned template auto-generated from your coverage list; the draft url
   defaults to the verified tunnel). Wake on results with
   `pingfusi wait <ping_id>` as a background task. On flags: run the
   PLAYBOOK Phase 6 `--inspect` drill-down on the element that PAINTS the
   flagged mark, fix the whole mark in one shot, re-run the gates, then
   `pingfusi review {{NAME}} file` again — the refile loop is the product working,
   not a failure. The gate passes only on an explicit approving verdict pick;
   comments alone never pass, however positive.

7. **Finish.** `pingfusi advance {{NAME}} reviewer`, then `pingfusi advance {{NAME}} done` —
   done re-runs every gate against the artifacts on disk. Paste the final
   `pingfusi status {{NAME}}` table, the passing `--visual` output, the behavior gate's
   verified-inventory line, and the approving round from
   `targets/{{NAME}}/review-qa.json` in your report.

**Dynamics honesty:** the captured HTML/CSS stay byte-exact; `fixes.js` is the ONLY
script and only re-drives what discovery measured. Anything excused in
`behavior-deviations.json` must also be noted in NOTES.md — the review round template
marks behavior steps INFORMATIONAL as a backstop for taste/feel and documented
deviations, not as a substitute for the behavior gate.

**Keep `targets/{{NAME}}/NOTES.md` current** (iteration-log table: what was
flagged, whether the gate caught it, the fix, the kit-change candidate). A miss
the gates didn't catch is the most valuable output of the run — flag it loudly
in your final report (DEVELOP.md meta-loop).
