# Prompt template — clone a whole site (or page), one shot, reviewer-approved

The ONE-SHOT pipeline: hand this to an agent and wait; the deliverable comes back
pixel-perfect **with receipts** — every gate green, in order, and a real reviewer's
approval recorded as the `reviewer` phase. The operator's only job is to have run
`pingfusi setup` once (pingfusi auth).

**Fill in:**
- `{{URL}}` — the live page to clone, e.g. `https://www.example.com/`
- `{{WIDTH}}` — the measurement viewport width in px, e.g. `1728` (the kit default)
- `{{NAME}}` — the target name, e.g. `example`

---

Produce a **pixel-perfect, reviewer-approved clone of the page at {{URL}}** at
**{{WIDTH}}px**, as the standalone target `targets/{{NAME}}/clone/`. Work
unattended until `pingfusi gate {{NAME}} done` exits 0 — that is the definition of
done, and it now includes a pingfusi review approval. Do not stop at "the
numbers match": stop when the receipts say a reviewer agreed.

**Before writing any code, read and follow exactly:** `docs/PLAYBOOK.md`,
`tools/RUNBOOK.md`, `docs/LEARNINGS.md`, `docs/WORKFLOW.md`. Their rules override any
assumption you have.

**Work the FAST loop (RUNBOOK "The fast fix loop") — the reviewer answers in
minutes, so the agent is the bottleneck, not the reviewer:**
- Capture INVISIBLY by default: `pingfusi capture-run {{NAME}}` (settle + measure + DOM +
  coverage in a kit-owned headless Chrome, artifacts written directly — no tabs the user
  can see, no delivery hop, no settle-polling round-trips). Its errors name the fallback
  when the invisible path can't see the real page (bot wall, no Chrome, probe refusal).
- Interactive fallback only: open the delivery path with `pingfusi capture open {{NAME}}`
  (hosted session) — every in-tab capture (pxSend/pxSendDom/pxBehaviorSend) then delivers
  in one call to its sink_url, and `pingfusi capture pull {{NAME}} --all` retrieves them
  verified.
- After a scoped fix, re-capture only the affected targets and fold them in with
  `node tools/merge-snapshot.js` — full N-target re-captures are for the final
  pass only (the done gate enforces one clean full capture at the end).
- When a fix's acceptability is uncertain (contested content, blur quality,
  "is this what they meant?"), use a 1-result micro-poll (up to 1 credit) —
  `pingfusi review {{NAME}} poll "…" --choices "Yes,No"` — BEFORE burning a full test
  round on it. Polls advise; only full rounds satisfy the review gate.
- Stalled on a gate (score/status print STALLED after 3 no-progress iterations)?
  `pingfusi assist {{NAME}} --compare` composes the question FOR you from the failing
  gate's own artifacts and files a scoped side-by-side diagnostic round (1 result by
  default) — a reviewer names in one look what costs you three blind iterations.
  `--compare` is required: the text-only poll format is retired (a reviewer cannot act
  on an element question without seeing both pages; bare `assist` refuses with the
  nudge). The recorded hosted draft is reused after a byte re-verify — re-push only if
  it reports the draft stale. Keep iterating while the ask is pending; never open a
  second one.
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

Full review rounds default to 1 result. Request `--results 5` for a broader read and
`--results 15` to `--results 20` only for complex work or higher confidence. Each completed
result costs 1 credit; filing and undelivered results are free.

**The sequence (each step's gate must pass before the next — `pingfusi status {{NAME}}`
always tells you what's next):**

1. **Scaffold + pin the target.** `pingfusi new {{NAME}} {{URL}} {{WIDTH}}` → advance
   `target`. If your browser can't reach exactly {{WIDTH}}px, record the real
   width in `target.json` and measure everything at that width.

2. **Build by capture — never hand-rebuild** (LEARNINGS #19; PLAYBOOK Phase 4).
   `pingfusi capture-run {{NAME}}` captures the settled live page invisibly (the settle
   STOP contract is enforced in-runner: a page still growing writes NOTHING) and lands
   `dom.html` + `live.json` + `coverage.json` directly; then
   `pingfusi capture-build {{NAME}}`. INTERACTIVE FALLBACK (only when capture-run's
   error names it): settle the live tab yourself, capture the doctype-exact DOM
   (`pxSendDom` to the hosted sink_url or `http://localhost:7799/dom.html`), and if
   delivery is blocked fall back per RUNBOOK (stash/chunked `pxRead`; or curl the
   SSR HTML **only after verifying** its structure matches the hydrated DOM —
   element-count comparison minimum). Attest `assets` with real evidence.

3. **Measure BOTH pages at the same viewport.** `pingfusi capture-run {{NAME}}` does this
   for you once the clone exists (`--side auto` → both sides, identical normalized
   viewport — width AND height AND dpr — cited in capture-run.json). INTERACTIVE
   FALLBACK (RUNBOOK): full-page `pxTargets`: every distinct painted element; for long
   repeats (cards, rows) sample first + last + a spread (the 37signals precedent) and
   say so in NOTES.md. Enumerate coverage with
   `element.checkVisibility({checkVisibilityCSS:true, checkOpacity:true})` —
   per-node `getComputedStyle` lies inside closed `<details>` (opendesign lesson).

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
   through `pingfusi next {{NAME}}` until `pingfusi gate {{NAME}} behavior` passes.
   Animations are DEFAULT-ON in the draft build: the build motion pass already
   reproduced what `capture-run` recorded in `motion-doc.json` (captured CSS carries the
   css/transition tiers; engine/sampled tiers get the generated WAAPI player), with
   receipts in `motion-pass.json` + `motion-items.json` and warnings that never fail a
   gate. `pingfusi next {{NAME}}` routes the deep machine checks
   (verify-introspected / sample → apply-sampled → verify-sampled) from those receipts.
   Temporal evidence never goes in `behavior-deviations.json` (that file is for
   unsupported non-temporal interaction/state rows). Re-run the pixel gates after:
   `done` re-verifies everything.

6. **Review rounds — driven by you.** `pingfusi draft {{NAME}} push` (uploads the
   clone as a hosted draft — stable public url, byte-verified before it's recorded,
   keeps serving even if this machine sleeps) → `pingfusi review {{NAME}} file`
   (scope-pinned template auto-generated from your coverage list; the draft url
   defaults to the hosted draft). The filing command owns the wait and renews the
   round's short idle lease; do not start a separate `pingfusi wait` task. Passive
   verify/result reads do not renew it. On flags: run the
   PLAYBOOK Phase 6 `--inspect` drill-down on the element that PAINTS the
   flagged mark, fix the whole mark in one shot, re-run the gates, then
   `pingfusi review {{NAME}} file` again — the refile loop is the product working,
   not a failure. The gate passes only on an explicit approving verdict pick;
   comments alone never pass, however positive.

   **A pre-review gate blocked by the ENVIRONMENT never ends the run unfiled.** The
   ladder, in order: (1) the remedy the gate's refusal names (e.g. hidden tabs →
   `pingfusi behavior-capture {{NAME}}`); (2) `pingfusi assist {{NAME}} --compare` when a
   reviewer observation could unstick you; (3) receipt the constraint —
   `pingfusi advance {{NAME}} <phase> --blocked "what you tried and why it failed"` —
   and file the round anyway: the spec documents the gap to the reviewer automatically,
   and a reviewer look at a partial clone catches what the gates structurally can't.
   Motion never holds a round up — its receipts are informational.
   `done` still refuses the blocked phase until it is genuinely earned — a filed round
   with a named gap is progress; a stopped session ships nothing.

7. **Finish.** `pingfusi advance {{NAME}} reviewer`, then `pingfusi advance {{NAME}} done` —
   done re-runs every gate against the artifacts on disk. Paste the final
   `pingfusi status {{NAME}}` table, the passing `--visual` output, the behavior gate's
   verified-inventory line, and the approving round from
   `targets/{{NAME}}/review-qa.json` in your report.

**Dynamics honesty:** the captured HTML/CSS stay byte-exact; the only scripts are
`fixes.js` (re-driving what discovery measured) and the generated `motion-replay.js`
(the motion pass's WAAPI player, parameters verbatim from `motion-doc.json`).
Non-temporal interaction/state rows excused in `behavior-deviations.json` must also be
noted in NOTES.md. Reviewers flag motion in the page round like any other observation —
fix through the routed motion utilities and refile.

**Keep `targets/{{NAME}}/NOTES.md` current** (iteration-log table: what was
flagged, whether the gate caught it, the fix, the kit-change candidate). A miss
the gates didn't catch is the most valuable output of the run — flag it loudly
in your final report (docs/DEVELOP.md meta-loop).
