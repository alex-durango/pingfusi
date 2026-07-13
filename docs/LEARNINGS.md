# LEARNINGS — the failure catalog (read before trusting any "match")

Every rule here was paid for by a real miss while building pixel-perfect clones. They
are all variants of one meta-lesson:

> **Measure the *visible mark*, not the wrapper — and measure it *completely*.**

A container box is a valid stand-in for what's drawn only when the content fills it
and is centered in it. Padding, line-height, a full-width bar, a tall hit-area, a
top-aligned glyph, an ancestor's border, an inherited colour — every one of these
breaks that assumption, and every time someone trusted the wrapper (or a hand-picked
subset of properties), a real pixel difference hid behind a number that said "match."

The fix is always the same shape: measure the thing that actually renders (glyph box
via `Range`; painted glyph via SVG bbox or background element + position; colour and
underline as painted marks), compare **all** of its properties numerically, and treat
any delta over tolerance as a defect to fix or explain — never eyeball a screenshot
to confirm.

---

## 1. Text shifted, but the box edges matched
Nav labels looked right of live. Each item had horizontal padding with boxes butted
together, so the box *left edges* matched while the **text** rendered 15px right.
**Lesson:** measure the **text position** (a `Range` over the text node), not the
element's box edges. Matching boxes ≠ matching glyphs.

## 2. A collapsed line-height (spot-check lied)
A badge passed an x/y/size/weight check but was visibly off: `leading-none` forced a
12px line-box vs the live 14.5px, lifting the glyphs ~1.25px.
**Lesson:** measure the **complete box**, and treat `line-height` as mandatory — it
decides where glyphs land inside the line box. A subset spot-check that agrees is not
a match.

## 3. Verification by eyeball → numeric PASS/FAIL
"Looks close" kept passing wrong things. The fix was a tool that captures the complete
box of each target and exits non-zero on any delta.
**Lesson:** "pixel-perfect" must be a **command that exits 0**, not a judgement.
Screenshots only decide *what* to measure.

## 4. Getting data off a strict-CSP live site
`fetch(...).then(eval)` **hung to a 45s timeout**; `copy()` was undefined; clipboard
needed focus. The CSP blocks runtime `eval` (`script-src`) and *sometimes* cross-origin
`fetch` (`connect-src`). **Measurement is never blocked** (`getComputedStyle`/`Range`
always work) — only **delivery** is.
**Lesson:** inject the script **source directly** (bypasses `script-src`), then
separate "can I measure" (always yes) from "can I get the bytes out" (the real problem).

**Amendment (paid for again on aloyoga, ~6 min):** *don't assume delivery is blocked —
**probe it first.*** A direct `fetch` POST to `http://localhost:7799` **succeeded** on
aloyoga; `connect-src` was looser than this note implied. Assuming it was blocked (per
the original wording above) triggered a needless 9-chunk stash/read reassembly. So:
FIRST try `pxSend('http://localhost:7799/live.json')`; if `./live.json` lands, you're
done. Only fall back to stash-to-`<textarea>` + chunked `pxRead` when the POST is
genuinely refused. (RUNBOOK Step 0.)

**Injection transport (paid for on aloyoga, ~7 min):** inject the capture code as
**plain source** — paste `tools/browser-capture.js` (the browser half of
`pixel-diff.js`, split out so it drops in whole) directly as the code to evaluate.
Do **not** base64/gzip the file to shrink the paste: those transports corrupt in
transit and/or trip the automation harness's content filter. Same rule for reading
values out — never return a URL / data-URI / base64 blob through the JS tool, or the
harness may blank it (`[BLOCKED: …]`); POST it to the sink or stash + read one dump.

## 5. The finder grabbed the same text elsewhere
`byText(/^shoes$/)` matched a body element far down the page instead of the nav item.
**Lesson:** **scope finders** to the section (`pxRegion`), and sanity-check each
target's `rect.y` is where you expect. A confident measurement of the wrong element
is worse than none.

## 6. Strict diff drowned in structural (invisible) differences
A visually-identical header showed dozens of ❌ (flex+gap vs `<ul>`+grid, padding vs
line-height, `proxima` vs `proxima-nova` alias).
**Lesson:** separate "does it look identical?" (`--visual`) from "is the DOM/CSS
identical?" (strict). Two valid implementations can render the same pixels; don't fail
the pixel check on structure — but *do* document each structural choice.

## 7. Slow verification (round-trips, not compute)
A single diff took ~20 serial browser calls + two 45s hangs.
**Lesson:** each browser call is a slow CDP round-trip — **batch** aggressively; a
blocked call costs a full 45s timeout, so avoid it entirely. Target ~2–4 calls + 1
`node` call.

## 8. Box-height chain
"The height is off" even after centers matched — main bar, nav link, and logo wrapper
each had a slightly wrong box height, and centering nudges are calibrated against the
container height (change one, re-derive all).
**Lesson:** matching centers isn't enough for structural parity — measure and match
the box **heights** too.

## 9. THE BIG ONE — icon glyphs measured at the wrapper, not the paint
Icons "needed to move up a few pixels" but measurements insisted they matched. Live
**top-aligns** each intrinsic-size glyph inside a taller control
(`background-position: 0% 0%`), so the *control* centered at 91.25 while the *visible
glyph* centered at 89. Measuring the control's `getBoundingClientRect` matched by
coincidence; the painted glyph was 2.25px off.
**Lesson:** for any background/SVG graphic, measure the **painted element** (path
bbox, or background element **plus its `background-position`**), never the clickable
wrapper. And: a user saying "it's off" against your "0 delta" means you're measuring
the wrong element — drill into what actually paints.

## 10. Invisible blue-on-blue text (`--visual` silently skipped colour)
Announcement text was painted in the **background colour** (a Tailwind token-name
collision: a colour and a font-size both named the same thing). It passed `--visual`,
because `--visual` only compared `font.color` *inside* the "both have a text box"
branch — and the finder had resolved a full-width **wrapper** whose own text node was
empty (`text: null`), so it fell through to a rect-only fallback and never compared
colour. Strict *did* flag it, but it was waved off as "structural."
**Lesson (tool):** compare `font.*` (incl. `color`) for **every** text target even
when the glyph box is null; raise a `text.present` failure when a finder resolves a
non-text wrapper. **Lesson (you):** a colour / visibility delta is **never**
structural — never wave off `font.color` in the strict table.

## 11. A missing underline (a painted mark the tool never measured)
An underline was missing. The tool measured border *widths* on the element but not
`text-decoration`, and the live underline was a `border-bottom` on an **ancestor**
wrapper — invisible to a per-element check.
**Lesson:** "measure the painted mark" applies to **decorations** too (underline /
strike), not just text and icons — and a mark can be drawn by an ancestor or a
sibling, so detect it by what's rendered near the text (`text-decoration` on
self/ancestor, a short ancestor's `border-bottom`, or a thin rule painted just below
the text), never by one property on the one element you labelled.

## 12. THE OTHER BIG ONE — an underline measured as a *boolean*, not a *box* (3 review rounds)
A sign-in label's underline was wrong **three ways in a row** — too thin (1px vs the
live 2px), too short (it spanned only the text, not the icon+text group → 185px vs
211px), and vertically drifting — yet **every `--visual` and strict run stayed green**.
Cause: the capture records `font.underline` as a **boolean** (present / absent). Both
sides had *an* underline, so the gate said "match" while the painted line differed in
thickness, width, and Y. And the underline is drawn by an **ancestor** group's
`border-bottom` (`.loyalty-name-part`), so `--inspect` on the *text* element never saw
it either. Each round I patched the one facet the reviewer named with a **hand-tuned
offset** (`bottom:-3.6px`), so the next facet surfaced and the reviewer had to point
again — and the positioned `<span>` rasterised unlike a real `border`, failing the
flicker test even when the number was ~0.01px.
**Lesson (general — this is the durable one):** *any* painted mark that isn't the text
glyph or an icon — a decoration (underline/strike), a `border`, a `box-shadow`, an
`outline`, a rule — is a **box**, drawn by **some element** (often an **ancestor**).
Measure that box (thickness, x/width, y) on the element that draws it; never a boolean,
never one property on the element you labelled.
> 🔒 **Enforced now:** the gate measures underlines this way — `underlineBox` →
> `underline.{thickness,x,right,w,top,bottom}`, compared by `--visual`. Trust the diff
> for underlines; don't re-derive them by hand. For a mark the tool doesn't
> special-case (a shadow, an outline), apply the same principle via `--inspect`.
> 👁 **Still yours:** *reproducing the technique.* The gate flags a wrong mark but never
> fixes it — redraw it the way live does (e.g. a `border-bottom` on a same-sized box) so
> its position/size **emerge** from the box model. A magic offset that lands the number
> rasterises unlike a real border and fails a flicker/overlay compare even at ~0.01px
> (→ #14, #15).

## 13. Perceived weight differed while every `font-weight` matched — `-webkit-font-smoothing`
"The text looks thicker" — but `font-weight` was 600 on both sides. Cause: live sets
`-webkit-font-smoothing: antialiased` (lighter); the clone defaulted to `auto`
(subpixel, heavier). The capture's font metrics didn't include smoothing, so the
regression sweep was **blind**; only the full-computed-style `--inspect` surfaced it —
after a reviewer pointed.
**Lesson:** `-webkit-font-smoothing` / `-moz-osx-font-smoothing` change *perceived
weight* without changing `font-weight`. Set `antialiased` / `grayscale` on the clone
root by default (most design systems do).
> 🔒 **Enforced now:** captured as `font.smoothing` and compared by `--visual`.

## 14. Patched the symptom, not the mark — one review round per facet
The pattern behind #12: when a reviewer flags a mark, the cheap move is to fix exactly the
property they named. But a mark has several painted dimensions (a decoration: thickness,
width, offset, colour, technique), and fixing one leaves the others — so the reviewer
iterates once per facet. The fixes were hand-tuned offsets that landed the number but
mismatched the *technique*.
**Lesson:** on any reviewer flag, **localise the element that actually paints the mark and
reproduce its whole box model + technique in one shot** (PLAYBOOK Phase 6) — same
element type, `height`, `border`, `box-sizing` — instead of nudging the text with magic
offsets. Detection is the reviewer; the *first* fix should be measured and complete, not a
one-property patch that guarantees another round.
> 👁 **The gate can't do this.** The diff tells you *what's* wrong on the element you
> inspected — not that you inspected the wrong element, patched one facet, or drew it
> with a different primitive. `--inspect` the **painting** element, fix its whole box.

## 15. Chasing tolerance toward 0 is the wrong knob
A mark still "looked off" while the diff read ~0.01px. The instinct — tighten tolerance
— is wrong: at that delta the numbers already say *equal*; what's left is a
**technique / rasterisation** mismatch (a positioned `<div>` vs a real `border`), which
a tolerance can't catch. And converging *every* property to 0.00 across two **different**
implementations is high-effort and often non-convergent (fractional layout falls out of
the whole box chain — each nudge perturbs neighbours; below ~0.3px you fit rounding
noise) for **zero** visual payoff (sub-0.5px is <1 device pixel, antialiased
identically).
**Lesson:** keep the gate at **0.5px**. When something reads wrong at 0.01px, the defect
is the *technique* — reproduce it (→ #12, #14) and **flicker/overlay** the two at 1:1 —
never dial the tolerance down. 0.5px is the "looks identical" threshold on purpose.

## 16. A painted BACKDROP colour the gate never measured (announcement bar / button / badge)
Found on aloyoga. The header's announcement bar is a solid `background-color`
(`rgb(113,198,235)`) — a painted mark. But it lives on a **container**, not on the
text leaf, so the per-target capture (which measured the *text's* `font.color`, never
its backdrop) had no field for it. Proof of the hole: setting the clone bar bright
**red** left `--visual` green (exit 0), and the red-bar snapshot was **byte-identical**
to the good one — the colour was nowhere in the schema. Coverage didn't catch it either:
a solid-colour container with a text child isn't enumerated as a "painted leaf."
**Lesson:** a solid `background-color` (bar, button, badge, chip) is a painted mark, and
it's usually on an ancestor of the text/icon you targeted. Measure the **effective
backdrop** behind every mark — the nearest opaque `background-color` up the ancestor
chain, resolving a fully-transparent chain to the **canvas default (white)** so an
explicit `body{background:#fff}` clone compares equal to a live canvas left transparent.
This is #10 (invisible blue-on-blue text) generalised from the glyph to its backdrop.
> 🔒 **Enforced now:** captured as `bg` (nearest painted background, canvas→white) and
> compared by `--visual` for every target — but only when a real colour is painted on
> either side, so transparent-on-white text/icons add no noise. `harness/fixtures/01-backdrop-color.js`
> locks it in. Trust the diff for bar/button/badge colours; don't re-derive by hand.
> 👁 **Still yours:** a colour-only container (a bar with no text/icon child of its own)
> won't be *targeted* by a text/icon finder — enumerate it in coverage, or target the
> mark that sits on it (its text leaf now carries the backdrop).

## 17. The STRUT positioned the text — every leaf property matched, the container's didn't
Found on the Hacker News header, flagged by a reviewer **after** a green `--visual`
(165 comparisons, 0 fails): "the text of the header is a little lower than it should be."
Live authors `line-height:12pt` (16px) **inline on the td**; the clone matched every
*measured leaf* exactly — the links' own `line-height` was 12 vs 12 ✓ — but left the td
at `normal`. The td's line-height is the **strut** of the line box that positions the
glyphs, and the td was never a target. On the capture machine the drift was 0.25px —
under the 0.5px tolerance, correctly so (#15: don't chase tolerance). But `normal`
resolves from *platform font metrics* while `16px` doesn't, so on the tester's machine
the same clone rendered visibly lower. A sub-tolerance same-machine delta plus a
technique mismatch = a cross-platform miss no tolerance tightening can catch.
**Lesson:** the glyphs' vertical position is decided by the line box's strut — the
nearest **line-box container's** line-height, usually an ancestor (td, div, flex item)
you never targeted. Measure it per text target, and treat `normal` vs a number as a
**technique mismatch** (string ≠ number → fails loudly), exactly like a hand-tuned
offset vs a real border (#14): matching today's number on one platform is not matching
the pixels everywhere. This is #12's "the ancestor draws the mark" generalised from
painting to **positioning**.
> 🔒 **Enforced now:** captured as `font.strut` (nearest block/table-cell/flex container's
> line-height, `normal` kept as a string) and compared by `--visual` for every text
> target; skipped when either snapshot predates the field, so old captures don't
> false-positive. `harness/fixtures/02-line-strut.js` locks it in; the battery scores it
> (defect caught, `normal`-vs-`normal` and old-schema controls clean).
> 👁 **Still yours:** reproduce the *authored* technique (put the line-height where live
> puts it — the td, not the leaf), and remember cross-platform rendering: a green sweep
> on your machine plus a technique mismatch can still be a visible miss on another OS.

## 18. The DOCUMENT MODE moved the pixels — every computed style was byte-identical
Found on the Hacker News header, same review round as #17's fix: after byte-matching the
markup and the strut, the login line still sat 0.25px lower — with the td, span, and
anchor **identical in every computed property** on both pages (same font, line-height,
padding, valign, rects). The cause was above CSS entirely: live HN ships **no doctype**,
so it renders in **quirks mode** (`document.compatMode === "BackCompat"`); the clone's
tidy `<!doctype html>` put it in standards mode, and quirks computes table-cell line
boxes differently. No element-level measurement could ever catch this — the difference
lives on the *document*, not on any node.
**Lesson:** the rendering mode is a pixel-determining property of the **whole page**.
Clone the doctype (or its absence) before cloning anything else, and capture
`document.compatMode` in the snapshot so a mismatch fails the sweep on run one instead
of surfacing as an unexplainable sub-pixel offset three rounds later. This is the
technique principle (#14/#17) taken to its limit: the "technique" can be the parser mode
the page opted into decades ago.
> 🔒 **Enforced now:** every capture records `mode` (quirks `BackCompat` vs standards
> `CSS1Compat`) in the snapshot root, and a mismatch is a failing `page.mode` row in both
> `--visual` and strict; skipped when either snapshot predates the field.
> `harness/fixtures/03-compat-mode.js` locks it in; the battery scores it.
> 👁 **Still yours:** copy live's doctype line (or its absence) into the clone scaffold —
> the gate can only tell you the modes differ, not which ancient parser quirk you need.

## 19. The BUILD STRATEGY determines the defect class — capture, don't reconstruct
Not one miss but the pattern behind the back half of this file, made undeniable by this
repo's own targets. Every technique mismatch the gate is structurally blind to — the
hand-tuned offset vs a real border (#12/#14), the sub-tolerance drift that's really a
rasterisation difference (#15), the strut authored on an ancestor (#17), the quirks-mode
doctype (#18), plus stripe's `font-feature-settings` and missing element — is
**self-inflicted by hand-rebuilding**: a reconstruction lands the same numbers by a
different construction. The evidence: the two hand-rebuilt targets with review burned
**3 rounds (hn)** and **8 rounds (stripe, never converged)** on exactly these misses
*after* fully green gates — while the one clone built **from the captured DOM** (github)
passed 3136 comparisons with **0 fails and 0 structural deltas in a single pipeline pass**.
A captured clone inherits live's doctype, authored line-heights, font-features, and
drawing primitives *by construction*; the whole defect class never exists.
**Lesson:** the numeric gate verifies a build; it cannot compensate for a build strategy
that manufactures defects it can't see. Capture the truth (post-hydration DOM + the site's
real CSS + self-hosted fonts); reconstruct only what capture can't express — behavior.
> 🔒 **Enforced now:** `pingfusi capture-build <name>` is the default build phase — it
> self-hosts every stylesheet + font (the assets gate checks their wOF2 magic), absolutizes
> the rest, strips scripts/CSP, and **preserves the doctype or its absence byte-for-byte**
> (#18). Failed downloads exit 1. `harness/capture-build-selftest.js` locks the contract in.
> 👁 **Still yours:** JS-driven behavior and animated/generative content (a WebGL hero, a
> marquee) can't be captured statically — reproduce them separately, and spend review
> rounds *there*, not on statics the gate proves. And when the deliverable is a component
> in your own stack, you're back on the rebuild path — every rule above applies in full.

## 20. The review tool's viewport altered the REFERENCE — the reviewer was comparing against Apple's own fallback
Found on iphone17, review round 9 — and it was the *reviewer* who solved it. For four
rounds the reviewer described the camera intro as a static two-part layout (frozen
phone still + tabs panel below) while insisting a normal browser shows a scroll-morph
(the phone rotates and *becomes* the tabs panel). Round 9 they caught the mechanism:
**resizing the window mid-scroll makes apple.com itself degrade to the static
two-part variant** — and the side-by-side compare view's iframe/viewport sizing
triggers exactly that degradation on the *reference* side. The clone had been judged
against Apple's own fallback all along ("which is probably why you weren't seeing it
on your end").
**Lesson:** the reference the reviewer compares against is not automatically the
experience the designer meant — a responsive/resize-degrading site can serve its
fallback variant *inside the review tool*, making a correct clone of the full
experience read as WRONG and a clone of the degraded variant read as RIGHT. This is
the environment-inversion doctrine (automation sees no-js; the reviewer is the live-side
instrument) extended one level: **the reviewer's instrument has an environment too.**
When a reviewer's description of live keeps contradicting what any browser you control
shows, ask which *variant* of live their tool is rendering before engineering anything.
> 🔒 **Enforced now:** nothing — this lives above the capture/diff layer entirely.
> 👁 **Still yours:** when pins describe behavior you can't reproduce in ANY
> environment, enumerate the reference site's own authored degraded variants
> (resize-triggered, no-js, reduced-motion, `no-*` feature classes in its CSS) and
> check whether the review tool's viewport lands the reference in one of them. A
> clone matching the same authored variant the compare UI shows is a disclosed
> equivalence, not a defect — document it with the reviewer's own confirmation.
> **Kit-change candidate:** review-qa's filed test could state the compare view's
> viewport size in its instructions, so the reviewer knows which variant of a
> responsive reference they're looking at.
>
> **Round-12 addendum — the reviewer's own BROWSER is an environment too:** the same
> target later revealed the sharper form: the reviewer reviews in an iOS in-app
> browser where apple.com itself serves its degraded no-scroll-animation fallback.
> Two rounds were spent building a faithful, frame-verified scroll-scrub the
> reviewer's environment can never render — then retired by owner directive
> ("just copy the fallback"). Before reproducing ANY environment-conditional
> behavior, establish which variant the reviewer's browser receives from the
> reference site; reproducing a variant the judge cannot see is unfalsifiable work,
> however correct.

---

## 21. The browser silently rations programmatic downloads — ONE per tab

Found on the 2026-07-12 fresh-user run (pingfusi.com landing clone). The pxSave
delivery path saves captures through a Blob + `<a download>` click. Chrome's
"automatic downloads" heuristic allows exactly ONE such download per tab: the first
lands in ~/Downloads, and **every later save in that tab silently no-ops** — `a.click()`
doesn't throw, the promise resolves, and pxSave still returns a success-shaped
`{bytes, sha256}` computed from the in-page payload. Isolated A/B across three tabs:
first download always lands (any size/extension), second never does, a fresh tab
resets the allowance. The permission chip that would unblock it lives in browser UI
no automation can click. An agent that trusts the return value builds and gates
against a stale or missing file — the same silent-truncation class as #18's transport
loss, wearing a different coat.

Rules: **a pxSave return value is not delivery** — the file on disk is (`shasum -a 256`
must match the returned sha). One save per tab; open a fresh tab for the next, or
better, don't download at all: the hosted capture session (`pingfusi capture open`,
RUNBOOK Step 0) delivers unlimited files with server-verified integrity and is the
default for exactly this reason.

---

## 22. `changed: false` was ABSENCE OF EVIDENCE — the hover probe could not fire the menu it was probing
Found on aloyoga, corroborated on lelabo. Both sites hide a full mega-menu behind a nav
hover; both panels are **pre-mounted** and hidden by `visibility: hidden` (opacity stays
`1` the entire time); both open on a **real pointer**. The behavior probe dispatches
synthetic `MouseEvent`s (`pointerover`/`pointerenter`/`mouseover`/`mouseenter`) — and a
synthetic event sets no CSS `:hover` pseudo-class and satisfies no trusted-event-gated JS.
So on both sites the probe observed *nothing*, wrote `changed: false`, and the gate went
green — **and `changed: false` is byte-identical to what a clone with no menu at all
produces.** The clone reproduced none of the mega-menu and the behavior phase certified it.
Two independent mechanisms, one observable failure: aloyoga toggles a class
(`navOpenOnHoverChild`) on a trusted pointer event; lelabo needs no JS at all — the reveal
is pure CSS `:hover`. Neither is reachable from in-page script, and `styleSnap` was blind
to both anyway, because it recorded `opacity`/`transform`/`filter` and the reveal moves
**only `visibility`**.
**Lesson:** a probe that cannot fire the mechanism it is probing must never be allowed to
report a *negative*. Naming a hover trigger is the operator ASSERTING that something opens
there, so a probe that observes nothing is **inconclusive**, not "no behavior" — absence of
evidence is not evidence of absence, and laundering the one into the other is how a gate
certifies a missing menu. The same rule generalises past hover: any trigger the automation
cannot authentically produce (trusted events, real pointers, gestures) yields an
inconclusive row that must be *disposed* — reproduced and confirmed in a review round, or
written down as a deviation — never silently green. And when a reveal is invisible in every
property you snapshot, the snapshot is the bug: `visibility` is a painted state, exactly as
`background-color` was in #16.
> 🔒 **Enforced now:** `tools/behavior-capture.js` — `probeHover` sets
> `inconclusive: true` + a reason whenever it could not fire a **named** trigger, and
> `styleSnap` records `visibility` alongside opacity/transform/filter. `harness/workflow.js`'s
> behavior gate REFUSES an inconclusive row instead of passing it. Locked by
> `harness/fixtures/22-css-hover-reveal.js` + `23-css-hover-capture.js`, and scored by the new
> `harness/benchmarks/behavior-battery.js` (defects `hover-probe-inconclusive`,
> `visibility-reveal-stuck`; controls `adv-fired-hover-not-inconclusive`,
> `adv-hover-mount-reproduced`, `adv-visibility-reproduced`, `adv-behavior-old-schema` —
> a hover that DID fire is never flagged inconclusive, and a reproduced reveal never flags).
> Adopted at +2 defect classes gained / 0 regressions vs HEAD.
> 👁 **Still yours:** actually *driving* the real pointer. The gate can refuse a
> non-measurement; it cannot manufacture one. Hover the trigger yourself (or put it in front
> of a reviewer), and note that a **hidden/occluded tab** (`document.hidden`) is not a
> measurement environment either — Chrome throttles its timers and freezes transitions, so
> the behavior gate refuses those captures too.

---


## 23. The gate INVENTED a delta — and the instrument could not see the fix
Found on lelabo. `rect.prevGap` is measured against `previousElementSibling` — which counts
elements that render nothing (`<script>`, `<style>`, `<link>`, `<meta>`, `<template>`,
`<noscript>`). And the default build **strips exactly those** (capture-build, #19). lelabo's
screenreader `<h1>` sits right after `<script> headerInitialize(); </script>`:

| | previous sibling | prevGap |
|---|---|---|
| live | the `<script>` (zero box, right edge 0) | **-1** |
| clone | script stripped → `<header>` (right edge 1728) | **-1729** |

A 1728px "structural delta" on a page where **nothing moved** — `--visual` was green on all 1394
comparisons. The operator's only moves were to "fix" a non-defect, or to write the noise into
`deviations.json`. Both are corrosive: **a gate that invents friction teaches you to document
noise, and a documented deviation that means nothing is how a real one stops being read.** A false
positive is not a lesser sin than a miss; it spends the same trust.
**Lesson:** a measurement must be **invariant under the kit's own transforms**. If the build
strips `<script>`, then nothing measured may depend on `<script>` being there — measure `prevGap`
against the previous **rendered** sibling. More generally: before trusting a delta, ask whether
*you* created it. The build is part of the instrument.

**The second half, and the sharper one — the instrument was blind to its own cure.** The fix
gains **zero** defects by construction (it removes a phantom; it catches nothing new), and
`detection-power` credited only defects flipping MISS→caught. A control flipping FALSE+→pass hit
no branch and scored **0**, while a *new* false positive counted as a regression. So the scorer
**punished inventing friction and paid nothing for removing it** — and since `promote-learning`
required `+N gained`, *every false-positive fix in the kit was structurally unpromotable, forever*.
Worse, the battery only ever fed pre-built snapshots to the **diff**; it never called the
**capture**, so a whole layer — the number that got *recorded*, as opposed to how it was
*compared* — had no instrument at all. The gate change was correct, provable by hand, and
**unscorable**.
**Lesson (the durable one):** when a correct improvement cannot be scored, **the instrument is the
defect** — fix the ruler, not the measurement. And check the ruler for asymmetry: a scorer that
counts one direction of error and not the other will quietly make an entire class of improvement
impossible, and it will never announce that it is doing so.
> 🔒 **Enforced now:** `tools/browser-capture.js` + `tools/pixel-diff.js` measure `prevGap` against
> the previous RENDERED sibling (schema-identical). `harness/benchmarks/capture-battery.js` is the
> new CAPTURE instrument — it drives the real `measure()` over a DOM shim and scores it with the
> STRICT diff (prevGap is structural; the visual gate never compares it), and `detection-power`
> A/Bs the baseline's OWN capture so a capture fix is scorable at all. `detection-power` now counts
> `+M false positive(s) removed` and `promote-learning` accepts `+N caught OR +M removed`, with 0
> regressions still absolute. Locked by `harness/fixtures/25-prevgap-nonrendered-sibling.js`.
> Adopted at **+0 gained / +2 false positives removed / 0 regressions** vs the pre-fix baseline —
> a verdict the old instrument could not have produced.
> 👁 **Still yours:** noticing that a delta is *phantom* in the first place. The gate cannot tell
> you that it invented one; it can only tell you the numbers differ. When a delta is enormous
> (a full viewport width) and `--visual` is green, suspect the instrument before the clone.

---

## 24. THE INSTRUMENT PAINTED ON THE PAGE — the agent's own overlay became the site's behavior
Found on gorjana, through a sweep that was green everywhere: `--visual` 1300/1300, strict
4144/4144, coverage 88/88, `clone-lint` clean. The browser-automation extension driving the
capture injects its own DOM into the page it is measuring — a glow border
(`#claude-agent-glow-border`) that **pulses** via a `@keyframes` it also injects, and a
`#claude-phantom-cursor`. Discovery scans `document.body`, so it found the glow, watched its
opacity move 0.697 → 0.609 across the scroll sweep, and recorded
**`reveal:claude-agent-glow-border-inner` as a behavior of gorjana** — alongside
`declared:claude-phantom-cursor` as site choreography awaiting reproduction, and `claude-pulse`
among the site's own keyframes. A behavior the site does not have and the clone can never
reproduce: the gate would report a miss on a page where nothing is wrong. Worse, `pxDomHtml()`
returned the overlay too, so a DOM captured while the agent was acting would have **baked the
agent's cursor and border into the clone shipped to a reviewer.**
**Lesson:** the measuring apparatus is *part of the page it measures*. Every previous instrument
lesson (#19, #23) said the BUILD transforms the artifact; this one says the **observer paints on
the subject**. Before trusting anything a capture recorded, ask which of it came from the site and
which from the thing doing the looking — and strip the latter at the source, not downstream.
> 🔒 **Enforced now:** `pxDomHtml` strips the automation's overlay (serializing a *clone*, so the
> live page is never mutated), `tools/behavior-capture.js` excludes it from discovery (`inRegion`,
> plus `keyframeNames` skipping the agent's own stylesheet **by `ownerNode`**, never by guessing at
> rule names), and `clone-lint` FAILs a built clone that still contains it — the artifact-level
> backstop. Keyed on the extension's **ID namespace** (`#claude-agent-*`, `#claude-phantom-*`),
> never a substring: a site is free to ship a class or id containing "claude" and it is untouched.
> `harness/fixtures/29-agent-dom-contamination.js` locks all three halves in; the new
> `harness/benchmarks/artifact-battery.js` scores it (defect `lint-agent-dom`; controls
> `adv-lint-site-claude-name`, `adv-lint-clean-clone`). Adopted at **+3 gained / +1 false positive
> removed / 0 regressions**. Proven on the real target: contaminants 3 → 0, the site's own 33
> keyframes and 8 hover triggers untouched.
> 👁 **Still yours:** noticing it at all. Nothing in a green table says "this row is *you*." When a
> discovered behavior has no plausible owner in the design — a pulse nobody would ship, an element
> with your tool's name on it — suspect your own instrument before you engineer a reproduction of it.

---

## 25. A gate that called faithfully-hidden content a hole
Found on gorjana. `clone-lint`'s `frozen-reveal` rule greps inline `opacity: 0` — a scroll-reveal
caught at its start state, invisible forever without JS (the aloyoga defect, #19). gorjana ships a
mobile app-download banner to desktop as `display:none; visibility:hidden; opacity:0`: invisible on
LIVE, with full JS, at the captured viewport. The capture recorded it faithfully and the clone
renders exactly what live renders — nothing. The rule failed it anyway, BLOCKING at `region: page`,
and told the operator to "re-capture after `pxScrollSettle()`" — but no amount of scrolling reveals
an element live never shows. The only moves left were to "fix" a non-defect or `--force` past a
lying gate, and a forced phase poisons the `done` gate.
**Lesson:** the distinction is mechanical, not a judgment call: **a CSS transition can never fire on
`display:none`**, so an inline style setting *both* `opacity:0` and `display:none` is *suppression*,
not a reveal frozen mid-flight. Hidden is not the same as missing. Before a gate calls something a
hole, it must be able to state what would fill it — and here nothing ever would, because live shows
nothing either. (Same family as #23: a gate that invents friction spends the same trust as one that
misses a defect.)
> 🔒 **Enforced now:** `clone-lint` exempts `opacity:0` **only** when the same inline style also sets
> `display:none`. `visibility:hidden` and bare `opacity:0` stay flagged — visibility *does*
> transition, and pre-mounted hover menus hide exactly that way (#22).
> `harness/fixtures/28-frozen-reveal-display-none.js` locks it in; the artifact battery scores both
> directions (defect `lint-visibility-hidden-reveal` must stay caught; control
> `adv-lint-display-none-suppression` must stop being flagged). Adopted at **+3 gained / +1 false
> positive removed / 0 regressions** — the false-positive removal is the point.
> 👁 **Still yours:** the same rule also matches *empty mount points*, and there the artifact alone
> cannot tell you whether a container is empty because your capture was too early (a real hole) or
> because live renders nothing into it either (gorjana's `wishlist-item-persist` / `error-dialog`,
> both zero-height on live). Check live before you "fix" one.

---

## The gate vs your eyes — the one split that keeps this general
Every lesson here is one of two kinds. Keep them apart, or you'll re-measure what the
tool guarantees and eyeball what it can't:

- 🔒 **Gate-enforced — trust `--visual`, don't re-derive by hand.** Same-width capture;
  glyph box via `Range`; painted glyph + `background-position`; full box-model; font
  incl. `line-height` / `letter-spacing` / `color` / `decoration` / **`smoothing`**; the
  **underline box**; the **painted backdrop** (`bg` — bar/button/badge colour); parent
  `gap`; presence & `text.present`. If the diff is green on
  these, they match — pushing further is fitting sub-pixel noise (#15). *When you find a
  new class of miss, add it to the tool (as underline/smoothing were added), not to a
  reviewer checklist — that's how it stops recurring.*
  Before the diff ever runs, the **capture** is gated too: the settle refuses a page still
  growing (`stable:false` — RUNBOOK "Build by capture", locked by `harness/fixtures/30-scroll-settle-stability.js`), and the automation's own overlay DOM is stripped from
  every capture and REFUSED in a built clone (`agent-dom`, **#24**). And the **artifact** is
  gated: `clone-lint` FAILs an empty mount point (incl. framework mounts — `data-vue`,
  `data-react*`), a frozen reveal, and the agent's overlay — while a `display:none` container
  live itself hides is correctly **not** a hole (**#25**).
- 👁 **Judgment — the diff can't see these; they stay on you.** *Which* element paints a
  mark (may be an ancestor — the tool special-cases underlines, not every shadow/outline);
  **reproducing the technique** vs a magic offset; **coverage** (every painted leaf has a
  target); **fixing the whole mark in one shot** (`--inspect`, not one facet); and the
  **flicker/overlay** final check that catches a technique/rasterisation mismatch the
  numbers pass. A green table only proves what you measured, drawn however you drew it.
  Two more, both learned the hard way: **is this row even the site's?** — nothing in a green
  table says "this behavior is *you*" (**#24**), so when a discovered behavior has no plausible
  owner in the design, suspect your own instrument before reproducing it. And **is this
  "hole" really a hole?** — an empty mount point looks identical whether your capture was too
  early or live renders nothing there either (**#25**); check live before you "fix" it.

## Checklist distilled from the above
1. **Text** → the text-glyph box via `Range` + **all** font metrics (incl.
   `line-height`, `letter-spacing`, `color`, `underline`). Never the element box.
   Colour and underline are painted marks — compare them even when the glyph box is null.
2. **Icons/logos** → the painted glyph (SVG bbox, or background element +
   `background-position`). Never the clickable wrapper.
3. Measure the **complete** box (geometry, box-model incl. heights, layout, parent
   `gap`) — don't spot-check a subset; let an unexpected property surface.
4. **Scope finders** to the section; verify each target's `rect.y`. A `text.present`
   failure means the finder grabbed a wrapper — fix it.
5. Diff **numerically** (exit 0), not by screenshot. `--visual` for "looks identical",
   strict for structural parity.
6. Measure both pages at the **same viewport width**.
7. On a CSP site: inject the capture as **plain source** (`browser-capture.js`, never
   base64/gzip), **probe a direct POST first** (it often works — RUNBOOK Step 0), and
   only stash/read if it's refused; never `fetch`+`eval` (it hangs). Don't return
   URLs/data-URIs/base64 through the tool — the harness may blank them.
8. **Batch** browser calls; avoid blocked calls (each costs a 45s timeout).
9. A user saying "it's still off" against your "0 delta" means you're measuring the
   wrong thing — find what actually paints.
10. **A colour / visibility / underline delta is never "structural."** Read every
    strict row; if `--visual` is green while strict shows a colour miss, `--visual`
    has a hole — a finder resolved a wrapper and the gate narrowed what it compared.
11. When a reviewer flags one element, run `--inspect` (full computed-style diff), not a
    guess — the paint bucket is the fix list, and "fixed" means it's empty. Resolve
    the element that actually **paints** the flagged mark — it may be an ancestor
    (the underline lived on `.loyalty-name-part`, not the text) — and fix the **whole
    box in one shot** (reproduce technique + box model), not the one property named.
12. **A decoration is a box, not a boolean** — 🔒 the gate measures underlines as
    `underline.*` (thickness/x/width/y, off the drawing element, ancestor included).
    👁 Your part: **reproduce the technique** (a `border-bottom` on a same-sized box, not
    a hand-tuned offset), and apply the box-not-boolean rule by hand to any mark the tool
    doesn't special-case (`box-shadow`, `outline`) via `--inspect`.
13. 🔒 **`font.smoothing` is captured and compared** — set the clone root to
    `antialiased` / `grayscale` so perceived weight matches (`font-weight` alone won't).
14. **Don't chase tolerance to 0** (#15): sub-0.5px is noise/rasterisation, not a defect
    a tighter gate catches — reproduce the *technique* and flicker-test instead.
15. 🔒 **A solid `background-color` is a painted mark** — 🔒 the gate captures `bg` (the
    nearest opaque backdrop behind each mark, transparent→white canvas) and `--visual`
    compares it, so a wrong bar/button/badge colour fails on run one (#16). 👁 A
    colour-only container with no text/icon child of its own still needs a coverage entry.
16. 🔒 **The line-box container's strut positions the glyphs** — the gate captures
    `font.strut` (the nearest block/td/flex ancestor's line-height) and compares it;
    `normal` vs a number is a technique mismatch that fails even when the same-machine
    delta is sub-tolerance (#17). 👁 Put the line-height where live authors it — a leaf
    that matches the number on your platform can still sit visibly off on another.
17. 🔒 **The document mode is a pixel-determining property** — the gate captures `mode`
    (`document.compatMode`) and fails a quirks-vs-standards mismatch on run one (#18).
    👁 Copy live's doctype (or its absence) into the clone before building anything.
18. 🔒 **Build by capture, not reconstruction** (#19) — `pingfusi capture-build` builds the
    clone from the captured post-hydration DOM (self-hosted CSS/fonts, doctype preserved),
    eliminating the technique-mismatch class the gate can't see. 👁 Rebuild by hand only
    when the deliverable is a component in your stack — and expect every rule above.
19. 🔒 **Reaching the bottom is not being settled** — `pxScrollSettle` waits for the document
    height to HOLD STILL and returns `stable`. 👁 **`stable:false` ⇒ do not capture**: the DOM
    is a page that never existed. A section that hydrates a beat after the walk passes it is
    missing from the capture, and therefore from the leaf enumeration, and therefore from every
    gate — green over half a page (gorjana: 4439 → 5877px; 88 leaves → 184).
20. 🔒 **The instrument paints on the page** (#24) — the automation extension injects its own
    overlay (`#claude-agent-*`, `#claude-phantom-*`); the capture strips it, discovery ignores
    it, and `clone-lint` REFUSES a clone that ships it. 👁 Nothing in a green table says "this
    row is *you*" — when a discovered behavior has no plausible owner in the design, suspect
    your own instrument before you reproduce it.
21. 🔒 **Hidden is not missing** (#25) — `clone-lint` FAILs empty mount points (incl. framework
    mounts: `data-vue`, `data-react*`) and frozen reveals, but a transition cannot fire on
    `display:none`, so a container live itself hides is faithful, not a hole. 👁 An empty mount
    looks identical whether your capture was too early or live renders nothing there either —
    **check live before you "fix" one.**
