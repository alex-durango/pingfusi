# WORKFLOW — the enforced pixel-perfect pipeline (`pingfusi`)

The PLAYBOOK describes the method. This describes the **enforcement**: a hard-gated state
machine that makes an agent (or you) walk the phases **in order**, and **refuses to let a
clone claim "pixel-perfect" until every gate has exited 0.** The method was prose the agent
was *asked* to follow; this is a machine that *won't advance* until the objective condition
is met.

It's modeled on [gajae-code](https://github.com/Yeachan-Heo/gajae-code)'s `gjc` workflow
(`deep-interview → ralplan → ultragoal`), reimplemented natively with zero dependencies —
see **Benchmark vs gajae-code** below for what we borrowed and what we deliberately didn't.

> The kit's one rule holds here too: **a phase is done because its gate exited 0, never
> because prose says so.**

---

## The phases (in order)

| # | phase      | gate — the objective condition that must hold | kind |
|---|------------|-----------------------------------------------|------|
| 1 | `target`   | `target.json` has a url + a fixed width | machine |
| 2 | `assets`   | any shipped `.woff2` has real `wOF2` magic bytes; icons/logo attested captured, not redrawn | attested |
| 3 | `measure`  | `live.json` exists, is valid, has elements, measured **at the fixed width** | machine |
| 4 | `build`    | `clone/index.html` built (no scaffold TODO) + a valid `clone.json` captured | machine |
| 5 | `visual`   | `pixel-diff --visual` is green (0 pixel-determining fails, matching widths) | machine |
| 6 | `coverage` | every painted leaf in `coverage.json` has a measured target on **both** pages | machine |
| 7 | `strict`   | strict deltas are **0**, or every *structural* one is documented in `deviations.json` — a **paint** delta (one that also fails `--visual`) can never be documented away | machine |
| 8 | `behavior` | every JS-driven dynamic discovered on the LIVE page reproduces or has an honest disposition — an empty/absent discovery pass is never a free pass. Motion bookkeeping (`motion-items.json`) rides along as informational receipt lines only: motion checks are build receipts and warnings, never gate results | machine |
| 9 | `reviewer`    | the **latest** pingfusi side-by-side round is reviewer-approved — the verdict is re-fetched from the API on every check (a cached approval is never trusted); a rejection surfaces the reviewer's flags as the fix list | machine |
| 10 | `done`     | **default-FAIL final verification:** every earlier gate is **re-run** against the current artifacts (a recorded pass is not trusted — it must still hold), in order, and no phase may be forced | machine |

**machine** = the gate fully proves it (exit 0 is a fact). **attested** = it can't be fully
machine-checked ("this icon is the real one, not hand-drawn"), so the gate does what light
checks it can and then requires an `--evidence` string, recorded in the audit log and flagged
`attested` so nobody mistakes an assertion for a proof.

The gates are **build-strategy agnostic** — they verify the artifacts, not how you made
them. The **default** way to satisfy `build` is `pingfusi capture-build <name>`: build the clone
*from the captured live DOM* (self-hosted CSS/fonts, doctype preserved byte-for-byte), which
eliminates the technique-mismatch defect class the gates are structurally blind to
(LEARNINGS #19). Hand-rebuild only when the deliverable is a component in your own stack.

---

## Commands

```sh
node harness/workflow.js status  <name>            # phase table + the next required action
node harness/workflow.js gate    <name> <phase>    # run ONE gate read-only (exit 0/1) — no state change
node harness/workflow.js advance <name> <phase> [--evidence "…"] [--force]
node harness/workflow.js ledger  <name>            # the audit trail (receipts)
node harness/capture-build.js    <name> [domFile]  # the default build step: clone FROM the captured DOM
node harness/review-qa.js file    <name> --draft <public-url> [--region "the header"] [--results 1..20]   # file the review round (default 5)
```

Review depth is explicit: a quick check targets 1 result, a standard round defaults to 5,
and complex or high-confidence work can target 15–20. Each completed result costs 1 credit;
filing and undelivered results are free.

## Capability dispatch: one command, specialist utilities

Run `pingfusi next <name>` whenever the next step is unclear, or
`pingfusi next <name> --json` when another agent is consuming the result. The dispatcher
uses workflow state and measured artifacts; it does not choose a utility from a vague
prompt alone.

| evidence category | utility | review contract |
|---|---|---|
| layout, typography, spacing, paint | `pingfusi diff …` / `pingfusi assist <name> --compare` | aligned side-by-side layout evidence |
| interaction state, mount, hover/click content | `pingfusi behavior-capture <name>` | state/trigger evidence |
| timing, easing, spring, stagger, scroll/pointer-driven, canvas/WebGL motion | the build motion pass + `pingfusi motion pass|sample|apply-sampled|verify-sampled|verify-introspected|capture|trace|gate|export|loop …` | none — machine receipts and warnings; the side-by-side compare round is the one reviewer channel for anything visual, motion included |
| browser/auth/capture environment | `pingfusi doctor` or the gate's named remedy | no review spend |

The categories are intentionally separate. The layout compare/align utility can diagnose
where a box or glyph sits, but it cannot judge a temporal curve. Conversely, the motion
engine isolates motion shape and should not replace the pixel gate for static geometry.
An unknown category fails closed and asks for more evidence instead of filing the wrong
review task.

Motion is **default-on in the draft build** (the first-draft doctrine, owner decision
2026-07-19): the product is the best machine-made FIRST DRAFT of any site, animations
included. There is no declare ceremony, no typed motion review round, and no motion
gate. `capture-run` records what the live page's animations ARE into
`targets/<name>/motion-doc.json` (`pingfusi/motion-doc@1` — additive, never blocking a
capture): the introspection readers and the GSAP probe fold in every DECLARED animation,
and then a dense-recorder sweep probes every scroll depth for elements still moving on
their own that no reader explained (a hand-rolled rAF belt declares nothing, and
viewport-gated motion is invisible at y=0 — LEARNINGS #32); any such ongoing mover is
sampled automatically under the stepped clock (the sampler's own `captureOnce`, one
scroll-to-anchored run per viewport group, receipted in
`targets/<name>/motion/auto-sample.json`). `capture-build` then runs the **motion pass**
(`harness/motion-pass.js`)
automatically after writing the clone. Everything the pass does or refuses is a receipt
plus, at worst, a warning — **the build NEVER fails because of motion**.
`--no-motion` skips the pass; `pingfusi motion pass <name>` re-runs it standalone
(hand-built clones, re-captures).

What the pass does per provenance tier (recorded on every doc track):

- **`introspected-css` / `introspected-transition` → css-inherited.** A capture-built
  clone self-hosts the very stylesheets that declare these animations, so the
  reproduction shipped BY CONSTRUCTION. The pass verifies statically that the clone's
  CSS still carries the declaration (`@keyframes` name / transition property — a failed
  stylesheet download silently de-animates a clone while every pixel gate stays green)
  and receipts pass/warn. The deep engine-level check stays an operator utility:
  `pingfusi motion verify-introspected <name> <item>` reads the CLONE side's own engine
  declarations over CDP (into `motion-doc-clone.json`) and diffs keyframes/timing/
  timeline exactly (±1ms duration/delay, ±0.01 numeric).
- **`introspected-gsap` / `introspected-waapi` → player-applied.** The clone has no GSAP
  runtime and no page scripts (capture-build strips them), so the page's own engine
  declarations are replayed as a small self-contained WAAPI player
  (`clone/motion-replay.js`, schema `pingfusi/motion-replay@2`, wired into
  `clone/index.html` through an idempotent marker block) with EXACT parameters —
  keyframes, duration, delay, iterations (incl. infinite), direction, easing verbatim
  from the doc. GSAP property channels (x/y/rotation/scale/…) are mapped to their CSS
  transform forms and one tween's channels merge into ONE transform clip; a channel with
  no CSS form is skipped by name.
- **`sampled` → player-applied from the recorded evidence.** Finite (settling) tracks
  replay as release-on-finish clips (fill `"none"` + an `onfinish` that commits the
  final frame only when no other writer owns the element — never a permanent
  `fill:"forwards"` squat). Ongoing tracks (no settle observed — the sampler's
  `ongoing: true`) loop by their fitted marquee LAW: WAAPI `iterations: Infinity` at the
  fit's velocity/direction, wrap distance measured from the element at RUNTIME — a clip
  that stops is a fabricated ending, so an ongoing track with no periodic fit is skipped
  WITH a warning instead. Sampled tracks normally arrive from capture-run's automatic
  ongoing-motion stage; if a capture still didn't sample (detect found nothing, or the
  sweep was refused), that is a receipted skip — the pass never launches a live-side
  sampler from the build; acquire the record with `pingfusi motion sample` when the
  draft needs it.
- **`fitted` → receipt only** (model reconstructions stay engine-bundle machinery:
  `pingfusi motion loop/export/serve`).
- **Assets (Lottie/dotLottie/RIVE)** ripped by capture-run into
  `targets/<name>/motion-assets/` are receipted; auto-embedding is a future item.

**One owner still guards the players.** Before writing, the owner probe
(harness/motion-apply.js) watches the target elements' inline style + computed transform
in the served clone; a selector another implementation writes is skipped with a warning
naming it, and two applied tracks never stack on one (selector, property) — for
css-inherited properties the captured CSS is itself the writer and wins. A probe that
cannot run here is receipted as unavailable (the players still apply — a silently
motionless draft would be the dishonest outcome).

**Receipts, all the way down:** `targets/<name>/motion-pass.json` (the pass receipt), a
`motion-pass` event line in `workflow.jsonl`, and per-element bookkeeping in
`targets/<name>/motion-items.json` (`pingfusi/motion-items@2` — auto-written, gates
NOTHING):

```json
{
  "schema": "pingfusi/motion-items@2",
  "items": [
    {
      "id": "pass-css-6564ab92",
      "selector": ".hero",
      "scope": ".hero",
      "tier": "introspected-css",
      "action": "css-inherited",
      "verify": "pass",
      "receipt": "1 track(s) carried by the captured CSS; @keyframes fadeIn present …",
      "source": "motion-pass",
      "status": "pass"
    }
  ]
}
```

`action` is what the pass did (`css-inherited` | `player-applied` | `skipped`), `verify`
is its machine check result (`pass` | `warn` | `skipped`), and `status` mirrors verify —
`pass` and a receipted `skipped` are terminal bookkeeping; anything else stays `pending`
so `pingfusi next` can route the deep machine check (verify-introspected for engine
declarations, sample → apply-sampled → verify-sampled for the sampled tier) from the
item's `scope`. These routes are machine utilities that exit 0 or 1 — no review round
exists anywhere in the motion path.

**The reviewer channel for motion is the compare round — the same one as for
everything visual.** The reviewer sees the draft side by side with the original
(`pingfusi review <name> file`, or a scoped `pingfusi assist <name> --compare`
diagnostic) and flags motion that is missing, different, or mistimed like any other
observation; the fix loop is the pass's machine utilities, then a refile. There are no
typed motion rounds, no spec/draft motion surfaces, and no 2AFC anywhere in the
default path.

The integrated temporal engine lives under `packages/motion/` and is invoked only
through the root command (operator utilities — machine receipts, never gates):

```sh
pingfusi motion pass <name> [--no-probe]        # re-run the build motion pass standalone
pingfusi motion verify-introspected <name> <item>
pingfusi motion sample <name> <item> [--fps 60] [--frames 240]
pingfusi motion apply-sampled <name> <item>
pingfusi motion verify-sampled <name> <item>
pingfusi motion capture <url> --trigger 'hover:.card' --out targets/<name>/motion/card-capture
pingfusi motion trace <url> --trigger 'scroll-through:#stage/80/16' --out targets/<name>/motion/circle-trace
pingfusi motion loop targets/<name>/motion/open-trace --out targets/<name>/motion/open-round
pingfusi motion export targets/<name>/motion/circle-trace --out targets/<name>/motion/library
```

### The capture ladder: provenance decides the machine check

Motion acquisition is a ladder of provenance tiers, recorded per track in
`targets/<name>/motion-doc.json` — written by `capture-run` alongside the behavior
artifacts. Each track records what moves (`target.selector` + `property`), how it moves
(keyframes/timing/timeline), and how it was ACQUIRED (`provenance.tier`):
`introspected-css` / `introspected-transition` / `introspected-waapi` are read verbatim
from `document.getAnimations()`, `introspected-gsap` from the GSAP timeline API,
`sampled` from virtual-time samples, and `fitted` from engine-fit models.

The tier decides the deep machine check — an introspected track is never re-fit, and a
fitted track is never certified by equality:

- **`introspected-*` → exact diff.** `pingfusi motion verify-introspected` reads the
  clone side's own engine declarations the same way and diffs live vs clone track:
  keyframes (offset/value/easing normalized), timing, and timeline type — duration/delay
  ±1ms, numeric values ±0.01. A match exits 0 and receipts `verified-introspected`; a
  mismatch exits 1 naming the first differing keyframe. GSAP tweens are recorded
  verbatim in GSAP semantics; an ease with no exact CSS form keeps its GSAP name — an
  approximate curve under an exact-sounding name would be a dishonest receipt.
- **`sampled` → deterministic replay + per-frame diff.** When a page declares nothing an
  introspection reader can see but pixels still move (a hand-rolled rAF loop writing
  inline styles), `pingfusi motion sample` steps a kit-owned clock over CDP
  (`Emulation.setVirtualTimePolicy`, hooked-clock fallback — the mode is receipted) and
  merges the record as sampled-tier tracks (keyframes at uniform offsets 0..1,
  `timing.duration_ms` = frames × step, fps in `provenance.source`
  `"virtual-time@<fps>fps"`). Frame-rate honesty: a site animating px-per-rAF-frame is
  recorded exactly as it behaves at the declared fps, and the time-based replay
  NORMALIZES that dependence — receipted in the doc and the player header, never hidden.
  **Ongoing motion is detected, not assumed away**: a series still changing in its final
  frames observed NO settle, the track is marked `ongoing: true`, and ongoing beats
  finite in the fit tie-break (a full-window linear tween fits a forever-belt exactly as
  well as a marquee on a short window — `ongoing` settles what the fitters only
  estimate). `pingfusi motion verify-sampled` re-runs the IDENTICAL virtual-time
  stimulus against the served clone and diffs every live track within the documented
  tolerance (translate ±1px per frame, opacity ±0.02), finite tracks frame-by-frame,
  ongoing tracks by their MOTION LAW, plus the POST-WINDOW check at the clip's edge
  (live ongoing + clone frozen fails by name: "unterminated motion").
- **`fitted` → the engine's own replay/convergence machinery** (`motion gate`,
  `motion loop`, `motion export`) — model reconstructions of a trajectory, receipted,
  never auto-applied by the pass and never a gate.

Nothing on this ladder can block a clone: a missing or unreadable `motion-doc.json` is a
receipted no-op for the pass, and every check above is receipts + warnings routed by
`pingfusi next`.

### The `behavior` phase (tools/behavior-capture.js + the gate in harness/workflow.js)
Statics are proven by `visual`/`coverage`/`strict` before this phase runs; `behavior` proves
the clone's JS-driven dynamics — animations, rotations, reveals, marquees, counters,
hover-mounted content — reproduce the live page's actual measured behavior, not just its
static end-state. Method ported verbatim from `lovable_dupe_html/CLONE_PLAYBOOK.md` §8/§8a —
see `docs/PLAYBOOK.md`'s behavior section for the full technique writeup. In short:

1. **Discover on LIVE** with `tools/behavior-capture.js` (`pxBehaviorDiscover()` /
   `pxBehaviorSend(url)` / `pxBehaviorStash()` — same injection + delivery rules as
   `browser-capture.js`, RUNBOOK.md "Golden rules"): a static pass greps `@keyframes` +
   class/data-attribute markers for CANDIDATES, then a dynamic differential pass (a
   `MutationObserver` + per-element opacity/transform/filter snapshots across a scripted
   scroll sweep and hover probes) confirms which candidates actually fire and MEASURES them;
   repeated mutations are sampled even without a static marker, including reversible motion
   (marquee px/sec, reveal end-states, hover-mount deltas). Save the result as
   `targets/<name>/behaviors-live.json`.
2. **Reproduce** in one vanilla `clone/fixes.js` (no framework — `harness/capture-build.js
   --fixes` wires `<script src="fixes.js" defer>` before `</body>` and scaffolds a starter
   file the first time; it never overwrites one you've already written). Each behavior gets
   its own guarded `try` block, per the playbook.
3. **Discover on the CLONE** the same way (with `fixes.js` loaded, captured AFTER the same
   settle procedure as live — scroll sweep + dwell — so end-states match) →
   `targets/<name>/behaviors-clone.json`.
4. The gate (`harness/workflow.js`, phase `behavior`) compares every live behavior against
   the clone's inventory by KEY (see "Behavior keys" below) and MEASURED value, within the
   tolerances below. `behavior-deviations.json` is the honest disposition for unsupported
   interaction/state inventory. Motion bookkeeping rides along as INFORMATIONAL receipt
   lines on the gate's pass reason (first-draft doctrine): temporal candidates and motion
   items without a green machine receipt surface as warnings plus a `pingfusi next`
   route — never gate failures.

**A hidden tab is not a measurement environment — and the kit can bring its own.** The gate
refuses any snapshot whose `discovery.documentHidden` is `true` (throttled timers + a frozen
compositor make every duration/speed an artifact of the capture, not the page). When the
automation environment can never foreground a tab — some stacks report `document.hidden=true`
permanently, which would otherwise deadlock behavior → review → done — run
`pingfusi behavior-capture <name>`: it executes the SAME `tools/behavior-capture.js` in a
kit-owned Chrome (launched with throttling disabled, or attached via `--attach`), refuses its
own environment unless a measured probe shows rAF and a known-rate CSS animation advancing,
installs a pre-navigation recorder so short startup rAF motion is not lost during settle,
and writes both `behaviors-*.json` files directly with a `discovery.runner` attestation that
the gate cites in its pass reason (cited when present, never required — a genuinely
foregrounded interactive tab remains a valid instrument).

**"Discovery ran" is itself evidenced**, not inferred from an empty inventory (a
`behaviors-live.json` with `behaviors: {}` and no `discovery` metadata is indistinguishable
from a script that silently no-oped, so the gate refuses it as a paint-over). Every capture
records its own discovery pass metadata — `elementsScanned`, `scrollSweep: {from,to,steps}`,
`observeMs`, `keyframesFound`, which hover triggers/marquee selectors were probed — and a
page with genuinely zero dynamic behaviors passes with that metadata cited as the reason.

**Behavior keys.** Each discovered behavior gets a stable string key so live and clone
inventories compare by identity, not by set overlap: `<prefix>:<descriptor>` where prefix is
`reveal` (scroll/class-toggle reconciled against a static candidate), `mutation` (an observed
change with no static marker — pure-JS timed rotations), `marquee` (an explicitly-probed
translating belt), or `hover` (an explicitly-probed hover-mounted panel/menu); descriptor
prefers `id`/`data-testid`/`aria-label`, falling back to `tag.class1.class2`, falling back to
a shallow structural path. Stability matters more than prettiness — the gate does an exact
key match between live and clone.

**Tolerances** (documented here so a failure message is self-explanatory, the same way
`--visual`'s 0.5px is):
- **speed (`pxPerSec`, marquees/scroll-linked motion): ±15% relative.** Two independent
  1-second `transform` samples carry timer/paint-scheduling jitter (~3–8% observed on a quiet
  machine); 15% absorbs that while a genuinely wrong speed — the common miss is copying the
  wrong keyframe duration or belt width, landing at exactly 2x or 0.5x — still fails by a wide
  margin.
- **duration (`durationMs`): ±25% relative, 150ms floor.** Wall-clock durations are measured
  across a network+paint round-trip on BOTH captures (more jitter than a same-machine
  transform sample); the floor keeps that noise from flagging very short (<600ms)
  transitions, where 25% would be under a frame's worth of time.
- **opacity: ±0.05 absolute.** Absorbs float-rounding differences across engines; a
  fully-revealed `1.0` reproduced as a stuck `0.92` is still a real, visible miss.
- **transform: matrix-aware compare — ±0.5px on the translation components, ±0.001 on the
  linear part; non-matrix strings exact.** Computed `transform` normalizes to
  `none|matrix(...)`, and matrix *translation* inherits layout subpixel rounding — exact
  string equality would flake on jitter `--visual` itself tolerates, while a genuinely wrong
  end-state (`-2125px` reproduced as `-1000px`) still fails by three orders of magnitude.
- **filter / trigger: exact string match.** Not measurements with sampling noise; `trigger`
  (load/scroll/hover/mutation) records the reproduction TECHNIQUE, which the playbook
  requires to match, not just land on the right pixels by luck.
- **`observed-mutation` behaviors (interval rotations) compare by KEY PRESENCE + trigger
  only.** A continuously-mutating element's snapshot is whatever frame it was on — end-state
  floats from two independent captures can never agree, so comparing them would be fiction
  dressed as measurement. The contract is: the clone rotates too (key present, same trigger);
  its per-frame states are for the review round to judge.
- **motion replay check (verbatim CSS/WAAPI captures — the `pingfusi motion gate` operator utility; a receipt, never a workflow gate):
  overall diff ratio ≤ 0.02 (`maxRatio`), worst aligned-frame window ≤ 0.35
  (`maxWindowRatio`), per-pixel threshold 0.1 (`pixelThreshold`).** Both sides are frozen
  at the same animation fractions and diffed as stills inside the element's padded box,
  so any delta is replay infidelity, not page noise (thresholds pinned in
  `packages/motion/src/replay/gate.js`).

### The `reviewer` phase (harness/review-qa.js)
One provider, one contract: every round goes to an INDEPENDENT reviewer on the pingfusi
service, who opens the hosted draft url (pushed with `pingfusi draft <name> push`; a
verified tunnel for adopted builds) side by side with the original, pins what looks
wrong, and picks an explicit verdict — machine-checkably recorded. Neither the operator
nor the agent ever answers a round: independence is the point (a self-supplied verdict
would be forgeable, and the service refuses self-review). Requires the pingfusi login;
there is no offline review path.

The gates prove what the tool measures; a reviewer proves the measured set is what a person
actually *sees* (LEARNINGS "the gate vs your eyes"). The verdict is machine-checkable, so
this is a **machine** gate: `review-qa.js verify` re-fetches the latest round's verdict from
the pingfusi API (same authenticated JSON-RPC transport as `pingfusi wait`; the
reviewer's existing review login is reused) and exits 0 only on approval. The generated
test is **scope-pinned** — the reviewer judges only the cloned region and per-leaf compare
steps come from `coverage.json`. Motion is not reviewed by a structured probe anymore
(first-draft doctrine): animation reproduction is default-on in the draft build and the
machine motion checks are build receipts, so the reviewer simply notes motion that looks
missing, different, or mistimed like any other observation — the fix loop is the motion
pass's machine utilities (`pingfusi next` routes them), then a refile.
A rejection prints the reviewer's notes as the fix list (PLAYBOOK Phase 6), and after fixing you
**refile**; verify always judges the latest round, so a stale approval can't carry a
regressed clone. Rounds and verdicts live in `targets/<name>/review-qa.json` — the receipt
pins ping_id + verdict content.

Or via the shim: `./bin/pingfusi status <name>` (symlink `bin/pingfusi` onto your PATH for `pingfusi status <name>`).

`new-target.js` seeds the workflow automatically, so a fresh target starts at phase 1.

### What `advance` enforces
- **In order.** Advancing phase N is refused while any earlier phase is still pending.
- **On a passing gate only.** If the gate fails, the advance is refused with the exact reason.
- **Attestation needs evidence.** An attested phase refuses to advance without `--evidence`
  (and the evidence value must be real text, never a flag).
- **`--force` is the escape hatch — and it's never silent.** *Any* enforcement it bypasses —
  ordering, missing attestation evidence, or a failing gate — records `forced:true` plus an
  `overrode:[…]` list naming exactly what was skipped. The `done` gate refuses a workflow
  containing any forced phase until it is cleanly re-advanced.
- **`--blocked "reason"` is the OTHER receipted escape — for the environment, not the gate.**
  When a gate cannot run here at all (and the remedy its refusal names has been tried), an
  advance with `--blocked` records the phase as `blocked:true` / `overrode:["blocked-env"]`
  with the reason as evidence. It exists so the run still reaches a reviewer: `review file`
  accepts blocked phases and the round spec documents the gap automatically (a KNOWN GAP
  step). It is refused when the gate actually passes, is mutually exclusive with `--force`,
  and — like forced — the `done` gate refuses blocked phases until each is re-advanced with
  a passing gate. Motion never holds a round up: its receipts are informational.
- **Refusals are receipted too.** A rejected advance (out of order, missing evidence, failing
  gate) appends a `gate:"refused"` line to the ledger, so probing the gates leaves a trace.
- **Three failed advances on one phase print STALLED.** The streak is derived from the
  ledger's gate-failure refusals (nothing new is stored) and surfaces in `status`, failing
  `gate` probes, and the refusal itself, with the runnable escalation: `pingfusi assist
  <name>` — a 1-result reviewer question auto-composed from the failing gate's own artifacts
  (`--compare` files a 5-result scoped diagnostic round by default). Advisory: nothing blocks. The
  streak resets when an assist is FILED (the ledger `assist` receipt), not when it is
  answered — one ask buys more iterations while the answer arrives.

### Receipts / audit trail
Every advance appends one line to `targets/<name>/workflow.jsonl`:

```json
{"ts":"…","phase":"visual","runId":"a1b2c3d4e5","gate":"pass","forced":false,"overrode":[],"sha256":"…","artifact":"targets/x/clone.json","evidence":null,"reason":"--visual PASS — 128 comparisons, 0 fails"}
```

The `sha256` pins the exact artifact that was verified — a file's bytes, or for a directory
artifact every file's relative name **and contents** (so a same-named swap changes the hash).
The receipt proves *what* passed, not just *that* something did. And because `done` re-runs
every gate, a receipt going stale (artifact edited after certification) is caught before the
workflow can complete.

### State corruption & recovery
`workflow.json` is validated on every load. If it's truncated/corrupt/invalid-shape, every
command fails with the recovery instruction instead of a stack trace: re-seed with
`pingfusi init <name> --force`. A forced re-seed **appends a `reset` receipt to the ledger** (the
ledger itself is append-only and survives), then each phase re-advances by re-running its
gate against the artifacts on disk — nothing green can be claimed that isn't re-proven.

---

## Files the workflow reads/writes (per target)

- `target.json` — url + fixed width (written by `new-target.js`).
- `workflow.json` — phase state (status / runId / sha256 / evidence per phase).
- `workflow.jsonl` — the append-only audit trail.
- `live.json` / `clone.json` — the measured snapshots (from the RUNBOOK).
- `coverage.json` — **you create this**: the enumerated painted leaves in the region, e.g.
  `["logo","nav_first","cart_icon",…]`. The coverage gate checks each has a measured target.
- `deviations.json` — **you create this** to document accepted structural deltas, e.g.
  `{ "nav_first": { "layout.display": "flex vs inline-block — identical pixels" } }`.
- `behaviors-live.json` / `behaviors-clone.json` — the discovered + measured JS-driven
  dynamics on each page (from `tools/behavior-capture.js`'s `pxBehaviorDiscover()`), each
  including the discovery pass's own metadata (scroll sweep range, observer duration,
  elements scanned) as evidence the pass actually ran.
- `behavior-deviations.json` — **you create this** for unsupported non-temporal
  interaction/state rows. It cannot dispose strong temporal evidence.
- `motion-doc.json` — the canonical motion record (`pingfusi/motion-doc@1`), written by
  `capture-run` on the live side: one track per animated property with provenance tier,
  plus ripped animation assets. Input to the build motion pass.
- `motion-pass.json` — the motion pass's receipt (what was css-inherited, player-applied,
  or skipped, the owner-probe verdict, every warning). Informational, never a gate.
- `motion-items.json` — machine BOOKKEEPING (`pingfusi/motion-items@2`), auto-written by
  the motion pass: one item per (selector, tier) with `action`/`verify`/`receipt`.
  Statuses gate nothing; `pingfusi next` routes the deep machine checks from them.
- `review-qa.json` — the review rounds (ping_id, approve verdicts, latest fetched
  result per round), written by `harness/review-qa.js`. Also holds `polls` (micro-polls,
  including assist asks with their `assist:{phase,…}` metadata) and `diagnostics`
  (scoped diagnostic rounds — kept OUT of `rounds` so `verify` and round numbering
  never see them; a diagnostic can never satisfy the review gate).
- `draft.json` — the HOSTED draft url (`harness/draft.js push` uploads `clone/` to the
  review service, integrity-verifies the bundle server-side, byte-verifies the served
  page, then records this); `review-qa.js file` uses it as the default `--draft` and
  re-verifies at file time. Drafts expire after ~7 days; each push mints a new url.
- `tunnel.json` — a public tunnel url (`harness/tunnel.js` records it only after
  byte-verifying it serves `clone/index.html`); the `--draft` fallback when no hosted
  draft exists — mainly adopted builds, whose live dev servers can't be pushed.
- `sink-tunnel.json` (workspace-level, not per-target) — a public url in front of the
  snapshot sink (`harness/tunnel.js --sink`, verified by the sink's own empty-POST
  signature), so live pages deliver captures with one `pxSend` call even when the
  automation environment blocks page→localhost fetch.
- **Merged snapshots**: `tools/merge-snapshot.js` folds a partial re-capture into
  `live.json`/`clone.json` for fast fix-loop iteration, stamping `merged:{at,keys}`.
  The `done` gate refuses stamped snapshots — a fix can displace elements outside the
  re-captured subset, so one final full capture is always required.
- **Micro-polls**: `review-qa.js poll` puts one question in front of a reviewer and targets
  1 completed result (up to 1 credit)
  mid-round (recorded under `polls` in `review-qa.json`). Advisory only — the `reviewer`
  gate never reads polls; it requires an approving verdict on a full round.
- **Assists**: `pingfusi assist <name>` is the stall escalation — it auto-composes the
  question from the failing phase's own artifacts (worst failing diff row, uncovered leaf,
  behavior row) and files a micro-poll, or with `--compare` a scoped diagnostic round
  (side-by-side compare UI; recorded under `diagnostics`). At most ONE open assist per
  target — a second unanswered ask multiplies credits without resolving the first. A filed
  assist appends an `event:"assist"` receipt to `workflow.jsonl` (this is what resets the
  stall streak); answers are re-fetched free with `poll-result` / `assist-result`, and
  `status` surfaces the pending/answered ask. Assist refuses phases a reviewer can't help
  with: mechanical artifacts, and environment-shaped behavior failures (those steer to
  `pingfusi behavior-capture`).

---

## Benchmark vs gajae-code (`gjc`)

gajae-code is the closest existing reference for "an enforced coding-agent workflow." We
studied its skills (`deep-interview`, `ralplan`, `ultragoal`) as a **pattern reference only** —
no runtime dependency on `gjc`. How the kit's workflow compares:

| dimension | gajae-code (`gjc`) | pixel-perfect-kit (`pingfusi`) |
|---|---|---|
| Gated pipeline | `deep-interview → ralplan → ultragoal → execute` | `target → assets → measure → build → visual → coverage → strict → behavior → reviewer → done` |
| Refuses to advance | ambiguity must drop below a resolved threshold; mutation blocked pre-approval | each phase gate must exit 0; advances refused out-of-order or on a failing gate |
| Definition of done | checkpoint with `--evidence` + `--quality-gate-json` | a gate command that exits 0 (`--visual` green, coverage closed, strict documented) |
| Audit trail | `index.jsonl` with `run_id` / `path` / `sha256` per stage | `workflow.jsonl` with `runId` / `artifact` / content-`sha256` per advance — including **refused** advances and forced **resets** |
| Override | explicit force override, recorded | `--force` records `forced:true` + `overrode:[order\|evidence\|gate]`; `done` refuses forced phases until cleanly re-advanced |
| State corruption recovery | `gjc state clear --force --mode <skill>` re-seeds scoped state | corrupt `workflow.json` → self-describing error + `pingfusi init <name> --force` (receipted reset; ledger survives) |
| Objectivity | mathematical ambiguity score (partly heuristic) | **fully numeric** — the "done" signal is a pixel diff exiting 0, not a heuristic score |

**What we borrowed:** the gated-pipeline shape, receipt-based audit trail, and the
"can't-advance-until-the-gate-passes" discipline.

**What we deliberately didn't:** `gjc`'s multi-agent consensus roles (Planner/Architect/Critic)
and the mathematical ambiguity scorer. This domain has something `gjc`'s general workflow can't:
a **fully objective** done-signal (the pixel diff). We don't need a panel to argue about whether
the clone is right — the numbers decide. The one place reviewer/vision judgment stays in the loop
is *detection* (PLAYBOOK Phase 6), and that already feeds the DEVELOP meta-loop.

**Possible future step (not built):** run the kit as a `gjc` skill so it becomes a domain
plugin on top of gajae-code's harness. Left out on purpose to keep the kit zero-dependency.
