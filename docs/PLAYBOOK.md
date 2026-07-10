# PLAYBOOK — clone a site pixel-perfect, and prove it with numbers

A repeatable method for recreating a website's visual identity and verifying the
match objectively. Every phase has a **Do**, a **Verify** (an objective check), and
an **Evaluate** (the pass bar). No step is "done" because it looks right — it's done
because a command exits 0.

**The one principle** (everything below is a corollary):

> Measure the **painted mark**, not the wrapper — and measure it **completely**.
> Text → the glyph box via `Range` + all font metrics. Icons/logos → the drawn
> pixels (SVG bbox or background element + `background-position`). Colour, underline,
> shadow are painted marks too. A wrapper box, or a hand-picked subset of properties,
> will pass while the pixels are wrong.

---

## Phase 0 — Decide the target and the viewport
**Do:** Pick the exact page/section to clone and a **fixed measurement width** (e.g.
1728px). Everything is measured at that width; the diff refuses to trust x-positions
if the two snapshots differ in width.
**Verify:** you can state the width and section in one sentence.
**Evaluate:** ✅ target + width written down.

## Phase 1 — Extract the real assets (never redraw / retype)
**Do:** On the live site's DevTools console:
- `extractFonts(/family/i)` → `<host>-fonts.zip` (real `.woff2` + a `fonts.css`).
- `extractIcons('header')` → `<host>-icons.zip` (clean SVGs + `icons.css` with the
  **exact** original data-URIs + a `preview.html` + `report.json`).
- Capture any non-icon vectors (logo/wordmark `<svg>`) and rasters by their real
  `src`/`srcset` URLs.
**Verify:** every `.woff2` begins with magic bytes `wOF2`; each SVG starts with
`<svg` and matches the live path data; each raster downloads at the same URL/size.
**Evaluate:** ✅ every shipped asset is a real captured file, none hand-drawn/typed.

## Phase 2 — Measure the design spec (no guessing)
**Do:** From the live DOM, capture a deduped inventory of every rendered text style
— `weight / size / line-height / letter-spacing / text-transform / color` — plus the
logo/icon intrinsic sizes and the section's box geometry. Record in a `spec.md`.
**Verify:** the token table covers every distinct text role (hero, heading, nav,
button, label, body, caption) and each icon's intrinsic size.
**Evaluate:** ✅ the spec is measured, not inferred. **`line-height` and
`letter-spacing` are mandatory columns** — they are the two everyone skips, and they
decide where glyphs land.

## Phase 3 — Capture the breakpoints
**Do:** Sweep viewport widths and read the live stylesheet's `@media` rules to record
the exact px breakpoints and how each token shifts. Set your clone's `screens` to match.
**Verify:** every width where a measured token changes is recorded with its exact px.
**Evaluate:** ✅ breakpoints come from the live `@media`, not from eyeballing the sweep.

## Phase 4 — Build: capture by default, rebuild only to integrate
**Do (default — build by capture):** don't reconstruct the markup; capture it. The gate's
chronic blind spot is *technique* mismatches — same numbers, different construction,
different rasterisation (LEARNINGS #12/#14/#15/#17/#18) — and every one of them is
self-inflicted by hand-rebuilding. A clone built from the captured post-hydration DOM
inherits live's doctype, authored line-heights, `font-feature-settings`, and drawing
primitives **by construction** (LEARNINGS #19). Capture the settled DOM with
`pxSendDom('http://localhost:7799/dom.html')`, then:
```sh
pingfusi capture-build <name>    # self-hosts CSS+fonts, strips scripts/CSP, PRESERVES the doctype
```
See RUNBOOK "Build by capture". JS-driven behavior and animated/generative content can't
be captured statically — reproduce those separately.
**Do (rebuild — only when the deliverable is a component in your own stack):** recreate
the section driven strictly by the captured spec: self-host the woff2s, use the real icon
data-URIs, apply the measured type tokens. Reproduce quirks faithfully (e.g. a faux-bold
button that renders `font-weight:900` over a 700-max face — replicate the synthesis, don't
substitute a heavier font). Expect the technique-mismatch class to be live — every
LEARNINGS rule below was paid for on this path.
**Verify:** the page renders standalone in the self-hosted faces (no external font
request); capture-build exited 0 (a failed asset download is loud, never silent).
**Evaluate:** ✅ builds clean; assets resolve locally.

## Phase 5 — Verify with the numeric diff (the core)
**Do:** Capture both pages at the same width and diff. See `tools/RUNBOOK.md` for the
exact fast sequence. In short:
- Clone (localhost, no CSP): `pxSend("http://localhost:7799/clone.json")` — one call.
- Live (strict CSP): inject `pixel-diff.js` **source directly** (never
  `fetch(...).then(eval)` — that hangs to a 45s timeout), then `pxStash()` +
  batched `pxRead(0..n)` → reassemble as `live.json`.
```sh
node tools/pixel-diff.js live.json clone.json --visual   # "does it look identical?"  exit 0 = pass
node tools/pixel-diff.js live.json clone.json            # strict: also flags structure
```
Measure **all** of these per element (skipping any one is how a defect hides):
geometry (`x,y,w,h,top,right,bottom,fromRight`); the **text-glyph box** via `Range`
(not the element box — padding moves the box but not the glyphs); the **painted
glyph** for icons/logos (SVG bbox or bg element + `background-position`, not the
clickable wrapper); the full box-model; **font incl. `line-height`,
`letter-spacing`, `color`, `-webkit-font-smoothing`, and `underline`**; layout + the
parent's `gap`.

**Every painted mark is a box — and the gate now measures the ones that used to slip a
green sweep, so trust the diff instead of re-deriving them:** `font.smoothing`
(`-webkit-font-smoothing` — changes *perceived weight* while `font-weight` matches), the
**underline as a box** (`underline.{thickness,x,right,w,top,bottom}`, measured on
whichever element — often an **ancestor** — draws it, not a boolean), and the **painted
backdrop** (`bg` — the nearest opaque `background-color` behind a mark, a
transparent chain resolving to the white canvas; catches a wrong announcement-bar /
button / badge colour that lives on a container the text leaf never measured — #16).
`--visual` compares all three — plus the **line-box strut** (`font.strut`: the nearest
line-box *container's* line-height, often an ancestor td/div you never targeted; it
positions the glyphs vertically, and `normal` vs a number is a technique mismatch that
drifts across platforms even when the same-machine delta is sub-tolerance — #17).
Generalise the principle to any mark the tool doesn't special-case (a
`box-shadow`, an `outline`): measure the drawing element's box with `--inspect`. Set the
clone root to `antialiased` / `grayscale` by default. What the gate can *not* do —
reproducing the technique so it also rasterises identically — is Phase 6.

**`--visual` vs strict.** `--visual` compares only pixel-determining props (geometry,
text-glyph box, `font weight/size/line/spacing/transform/color/decoration/underline`,
glyph center + `background-position`) — use it to answer "does it look identical?".
Strict (default) additionally compares structure (`display`, `position`, parent
`gap`, padding, the `font-family` alias); two valid implementations legitimately
differ there — fix or **document** each structural delta, don't fail the pixel check
on it.

**Verify:** `--visual` exits 0 at every breakpoint.
**Evaluate:** ✅ only when every pixel-determining property is within tolerance
(0.5px default) at every breakpoint.

## Phase 5b — Close coverage (don't skip)
**Do:** After `--visual` is green, **auto-enumerate** every painted leaf in the
region (each element with own text, a background-image, or an `<svg>`) and require a
`pxTargets` entry for each. Add the missing ones and re-diff.
**Verify:** the count of painted elements in the region equals the count of targets;
off-region/hidden nodes (x<0, display:none, flyouts below the band) are excluded. A
**solid-colour container** (an announcement bar, a coloured button) is a painted mark
too: either target it, or rely on its text/icon child — whose `bg` now carries that
backdrop colour (#16) — but don't leave a coloured bar with no covered mark on it.
**Evaluate:** ✅ coverage list empty. *A green table only proves the elements you
measured; an uncovered element is unverified, not matched.*

## Phase 5c — Reproduce JS-driven dynamics (the `behavior` phase)
Statics are proven by Phases 5/5b before this one runs. A static capture strips `<script>`,
so anything driven by JS — animations, rotations, reveals, marquees, counters, hover-mounted
content — is frozen at its captured moment. This phase reproduces it, and the workflow's
`behavior` gate proves the reproduction by MEASURED number, never by eye. Method ported
verbatim from `lovable_dupe_html/CLONE_PLAYBOOK.md` §8/§8a — this is a port, not a
reinvention:

1. **Static pass (candidates, necessary but noisy):** grep the captured CSS for every
   `@keyframes` name; grep the DOM for `opacity-0`, `translate-x/y-*`, `blur-`,
   `will-change`, `data-[starting-style]`, `animate-*`, `data-state` markers.
   `tools/behavior-capture.js`'s `pxBehaviorDiscover()` does this scan for you.
2. **Dynamic differential pass on LIVE (authoritative):** attach a `MutationObserver`
   (watching `class`/`style`/`data-*`) across the region, snapshot each candidate's computed
   `opacity`/`transform`/`filter` before, then **scripted-scroll** the page in increments
   (dwelling at each stop) and dispatch synthetic hover events on each trigger. Record what
   changed, from what to what, and by what trigger (load/scroll/hover/mutation). A candidate
   frozen in its start state after the sweep is presentational noise, not a behavior.
   `pxBehaviorDiscover()` runs this pass and writes the result — save it as
   `targets/<name>/behaviors-live.json`.
3. **Measure, never eyeball.** A marquee's speed is a real px/sec sampled over a real
   1-second window (`pxBehaviorDiscover`'s `marqueeSelectors` option), not "looks about
   right." A reveal's end-state is its settled computed style, not a screenshot glance.
4. **Reproduce in ONE vanilla `clone/fixes.js`** (no framework, each behavior in its own
   guarded `try`). Common patterns and how to do them right (full detail + the reference
   implementation live in `lovable_dupe_html/CLONE_PLAYBOOK.md` §8 and
   `lovable_dupe_html/snapshot/fixes.js`):
   - **Marquee/logo belt:** find the actual moving wrapper (often holds *multiple* track
     copies inside an `overflow-clip` viewport) and animate that WHOLE wrapper as one unit —
     animating a single inner track gives "static + moving at the same time."
   - **Scroll reveals / gradient sweeps:** the element is usually already in the DOM, stuck
     in its start state. Re-trigger via `IntersectionObserver` on scroll-in.
   - **Hover-mounted content (mega-menus, portals):** not in the static DOM at all — capture
     the live markup on hover (dispatch `pointerover`/`pointerenter`, wait for it to settle,
     POST the panel's `outerHTML`), sanitize it, and toggle it on hover positioned by the
     MEASURED relationship to its anchor, never a guessed offset.
   - **Typewriter / rotating placeholder:** sample the live text over several seconds to
     collect the real phrases before typing/erasing them.
   `harness/capture-build.js --fixes` wires `<script src="fixes.js" defer>` before `</body>`
   and scaffolds a starter file the first time (never overwrites one you've written).
5. **Discover on the CLONE the same way**, with `fixes.js` loaded and captured AFTER the
   same settle procedure as live (so end-states genuinely match, not just at t=0) →
   `targets/<name>/behaviors-clone.json`.
6. **Gate:** `node harness/workflow.js gate <name> behavior` compares every live behavior to
   the clone's by key and measured value within a documented tolerance (docs/WORKFLOW.md). A
   behavior that's genuinely irreproducible statically (WebGL/canvas generative content) is
   documented in `targets/<name>/behavior-deviations.json` with a reason — never silently
   dropped. An empty/absent live inventory does not pass unless the discovery pass's own
   metadata proves it actually ran (scroll sweep range, observer duration, elements scanned).

## Phase 6 — The reviewer-flagged fix loop (detection → measure → fix → verify)
Detection stays with a reviewer (or a vision reviewer) — they're the best perceptual
detector. **The workflow enforces this as the `reviewer` phase**: `node harness/review-qa.js
file <name> --draft <public-url>` files a scope-pinned pingfusi side-by-side (per-leaf
steps from coverage.json; JS behavior marked informational), and the gate passes only on
a fetched approving verdict — a rejection's notes are your flag list for the loop below,
then refile. But once a reviewer points, **stop guessing the property.** Measure the whole
element:

1. **Localize the element that *paints* the mark — not the one you labelled.** A
   colour lives on the text, but an underline may be a `border-bottom` on an
   **ancestor group**, a shadow on a wrapper, a rule on a sibling. Resolve *that*
   element on **both** pages:
   ```js
   copy(pxInspect({ text: "sign in" }))   // also {aria:/cart/}, {sel:".x"}, {at:[x,y]}
   ```
   Save `el_live.json` / `el_clone.json`. (Live CSP → `pxStashInspect(resolver)` +
   batched `pxRead`.) If the paint bucket comes back empty but the reviewer still sees it,
   you inspected the wrong element — walk up to the ancestor whose box actually draws
   the mark and measure *its* box (top/height/border), because that box positions it.
2. **Measure** — diff the element's **entire computed style**, paint-first:
   ```sh
   node tools/pixel-diff.js --inspect el_live.json el_clone.json
   ```
   - **PAINT** bucket = every visible difference with exact values (colour, border,
     decoration/underline, background, transform, opacity, geometry…). *This is the
     fix list.*
   - **STRUCTURAL** = layout-technique differences, demoted (usually fine).
   - Irrelevant props (`transition`, `cursor`, …) hidden.
3. **Fix by reproducing the box model + technique, not by offsetting.** If the mark's
   position falls out of a box (a `border-bottom` sits at a group's content-bottom;
   the group's `top`+`height`+`box-sizing` decide where), build **that same box** so
   the mark *emerges* in place. A hand-tuned `top:-3.6px` that merely lands the number
   is fragile — it drifts when neighbours change and **rasterises differently** (a
   positioned `<div>` ≠ a `border`), so it fails a flicker/overlay comparison even at
   0.01px. Match the drawing element's type too.
4. **Fix the *whole* mark in one shot, not the one facet named.** A decoration has
   thickness + width + offset + colour + technique; fixing only "it's too thin" leaves
   width and Y wrong and the reviewer iterates again. Measure and set all of them together.
5. **Verify** — re-run step 2. **Done = the PAINT bucket is empty (exit 0)** — a
   measured fact, never a screenshot.

Why this beats patching the tool per bug: the measure step compares the **whole**
computed style, so a novel property (a shadow, an outline) is caught the **first**
time — you never grow an allowlist one embarrassing miss at a time.

## Phase 7 — Final evaluation
**Do:** Produce one match table straight from `pixel-diff.js` output (element →
property → live vs ours → Δ → ✅/❌), noting intentional non-matches and why.
**Verify:** `--visual` exits 0 at every breakpoint; coverage list empty; every strict
structural delta explained; every reviewer-flagged element's `--inspect` paint bucket empty.
**Evaluate:** overall pass = real assets + all pixel-determining properties of all
covered elements within tolerance + no uncovered element + every structural
difference documented. A green diff that skipped elements or properties is not a pass.

---

## Ground rules (the non-negotiables)
1. **No asset is hand-drawn or hand-typed** — fonts/icons/logos/vectors/images come
   only from the extractors or a direct live-site capture (real files, real URLs).
2. **No eyeballing.** Every "match" is a `pixel-diff.js` run. Screenshots decide only
   *what to measure*, never *whether it matches*.
3. **No silent gaps.** Every painted element in the region has a target; enumerate
   and close coverage.
4. **Match across breakpoints** — run the diff at each captured breakpoint.
5. **Document intentional deviations** (faux-bold, structural technique choices,
   accepted sub-pixel deltas) with their cause — never silent.
6. **A colour / visibility / underline delta is never "structural."** If strict shows
   `font.color` or `font.underline`, fix it — don't wave it off as noise.
7. **Reproduce the technique of a painted mark, not just its number.** A border,
   decoration, or shadow must be drawn the way the live site draws it (right element,
   right property), so it rasterises identically under a flicker/overlay compare. A
   magic offset that lands the coordinate but uses a different primitive is a defect.
8. **A mark is a box.** Decorations (underline/strike/border) and glyphs have
   thickness, width, and position — measure and match all of them, and capture
   `-webkit-font-smoothing`. "Present: true" or a matched colour is not a matched mark.
