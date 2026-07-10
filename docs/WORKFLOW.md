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
| 8 | `behavior` | every JS-driven dynamic discovered on the LIVE page (animation, rotation, reveal, marquee, counter, hover-mounted content) either reproduces on the clone within a documented tolerance, or is explicitly excused in `behavior-deviations.json` — an empty/absent discovery pass is never a free pass (see "The `behavior` phase" below) | machine |
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
node harness/review-qa.js file    <name> --draft <public-url> [--region "the header"]   # file the review round
```

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
   scroll sweep and hover probes) confirms which candidates actually fire and MEASURES them
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
   tolerances below. A behavior that's genuinely irreproducible statically (e.g. a WebGL
   generative background) is documented in `targets/<name>/behavior-deviations.json` —
   `{ "<key>": { "reason": "WebGL generative — irreproducible statically" } }` — the same
   escape hatch `strict`'s `deviations.json` uses, with the same rule: a behavior that ALSO
   changes what `--visual` would see (a frozen, still-mid-transition end state) is a paint
   delta in spirit and should be fixed, not excused.

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

### The `reviewer` phase (harness/review-qa.js)
Two providers, one contract (an explicit review verdict + pins, machine-checkably
recorded): **remote** (pingfusi, the default — independent reviewers open a hosted
draft url pushed with `pingfusi draft <name> push`, or a verified tunnel for adopted
builds) and **local** (`file --local` — the kit's own serve hosts the
review page at `/__review`: the clone in a same-origin iframe with click-to-pin, the
same generated step list, the same mandatory verdict buttons; no account, no tunnel).
The trust model is explicit and travels in the receipts: local rounds record
`provider:"local"` and verify prints "operator-trusted" — an agent with browser control
*could* forge a local submission, which is exactly why remote review exists and why
agents are forbidden from ever opening or submitting `/__review` themselves.

The gates prove what the tool measures; a reviewer proves the measured set is what a person
actually *sees* (LEARNINGS "the gate vs your eyes"). The verdict is machine-checkable, so
this is a **machine** gate: `review-qa.js verify` re-fetches the latest round's verdict from
the pingfusi API (same authenticated JSON-RPC transport as `pingfusi wait`; the
designer's existing cpyany login is reused) and exits 0 only on approval. The generated
test is **scope-pinned** — the reviewer judges only the cloned region, per-leaf compare
steps come from `coverage.json`, and JS behavior is marked *informational* in the reviewer
template (the `behavior` phase gate is what PROVES dynamics now; the informational step is a
reviewer backstop for taste/feel and anything intentionally excused in `behavior-deviations.json`,
not a substitute for the gate) — encoding the lessons stripe's 8 unconverged rounds paid for.
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
- **Refusals are receipted too.** A rejected advance (out of order, missing evidence, failing
  gate) appends a `gate:"refused"` line to the ledger, so probing the gates leaves a trace.

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
- `behavior-deviations.json` — **you create this** to document behaviors that are
  genuinely irreproducible statically, e.g.
  `{ "mutation:div.hero-canvas": { "reason": "WebGL generative — irreproducible statically" } }`.
- `review-qa.json` — the review rounds (ping_id, approve verdicts, latest fetched
  result per round), written by `harness/review-qa.js`.
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
- **Micro-polls**: `review-qa.js poll` puts a ~$0.05 single question in front of a reviewer
  mid-round (recorded under `polls` in `review-qa.json`). Advisory only — the `reviewer`
  gate never reads polls; it requires an approving verdict on a full round.

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
