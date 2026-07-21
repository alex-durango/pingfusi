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

## 26. THE INSTRUMENT'S OWN COPY STEP DELETED THE PAGE — cloneNode re-runs custom-element constructors
Found on chrono24. The capture serialized the DOM from `document.documentElement.cloneNode(true)` —
a clone, so that stripping the agent's overlay (#24) would never mutate the live page. But cloning
an **upgraded custom element** *constructs a fresh one*: the browser runs its constructor, and a
framework-defined element (Vue `defineCustomElement`, Lit, Stencil) re-initialises itself there and
drops its hydrated subtree. chrono24 mounts its **main search bar** into one:

    app.outerHTML                → 1928 chars of <form>   ← faithful
    app.cloneNode(true).children → 0                      ← DESTROYED

So `pxDomHtml()` wrote `<c24-main-search-app><!----></c24-main-search-app>`, the build shipped an
empty mount point, and **no number of re-captures could fix it** — every capture destroyed it again.
The kit could not clone the page's most prominent control at all.
**Lesson:** #23's rule, turned on the capture itself: **a measurement must be invariant under the
kit's own transforms** — and *copying a page is a transform*. `outerHTML` on the live element is
faithful, so serialize FIRST and re-parse the string in a `DOMParser` document, which has **no
custom-element registry**: nothing upgrades, no constructor runs, the subtree survives, and the live
page is still never mutated. Note what this was *not*: the gate was never blind — `--visual` failed
loudly (`present live=true clone=false`). The kit was **incapable**, not deceived, and a capability
bug looks nothing like a detection bug.
> 🔒 **Enforced now:** `pxDomHtml` serializes → re-parses inert; `harness/fixtures/31-custom-element-subtree.js`
> fails without it (and proves #24's agent-strip and #18's doctype still hold on the new path).
> Battery: defect `lost-island` (a painted live leaf with no clone counterpart), control
> `adv-absent-both`.
> 👁 **Still yours:** chrono24 ships TWO mounts marked identically (`data-v-app`) and one —
> `<c24-toasts-app>` — is **faithfully empty on live too**. Only a live-vs-clone comparison can tell a
> lost island from an empty one; a single-artifact lint structurally cannot, which is why this stayed
> a capture fix and never became a `clone-lint` rule (#25's trap, avoided).

---

## 27. THE SWEEP NEVER MOVED — `scrollTo(0, y)` obeys the page's `scroll-behavior: smooth`
Found on chrono24 (`html { scroll-behavior: smooth }`). `pxScrollSettle` walked the page with
`scrollTo(0, y)`. That call **obeys the page's own CSS**: with smooth scrolling the browser turns
each step into an rAF-driven *animation*, and when rAF is throttled — a background or hidden tab,
which is the **normal** condition under browser automation — the animation never runs and the scroll
**never lands**. Measured live: with `scrollY` at 7743, `scrollTo(0, 1000)` left it at **7743**;
`scrollTo({top: 1000, behavior: "instant"})` landed at exactly 1000.

So the sweep visited nothing. No IntersectionObserver fired, no lazy image was kicked, no below-fold
section mounted. And the height watch (#19) then found the height perfectly stable — *of course it
was stable: nothing scrolled* — and returned `stable: true` over a page it had never visited.
**Lesson:** #22's rule, on a new mechanism: **a probe that cannot fire the thing it is probing must
never report success.** The instrument's scroll is not a user gesture to be animated — it is a
measurement, and a measurement must be exact. When your evidence of readiness is "nothing changed",
first prove you were *able* to change it.
> 🔒 **Enforced now:** the sweep scrolls with `behavior: "instant"` (fallback for hosts without the
> options form). `harness/fixtures/34-settle-instant-scroll.js` fails without it; battery defect
> `settle-smooth-scroll`, control `adv-settle-auto-scroll` (a page with no smooth CSS sweeps exactly
> as before). Adopted at **+3 gained / 0 regressions**.

---

## 28. HEIGHT HOLDING STILL IS NOT THE PAGE BEING READY — a lazy `<img>` is a zero-width box
Found on chrono24. The settle proves the document stopped **growing** (#19). It said nothing about
whether the page had finished **loading** — and an unloaded lazy `<img>` moves no height at all: it
is a **zero-width box** that reflows its row the moment its bytes land. chrono24's footer QR code
(`<img loading="lazy" height="90">`, no width attr) was still `complete:false` when settle returned
`stable:true`. So `live.json` recorded it at `w=0`, the two app-store badges beside it were measured
**90px to the left** of where any real user sees them — and the gate then reported a 90px defect
**against the clone**, which had loaded the image correctly. The reference was a page state that
never existed (#20), and the clone was blamed for being right.
**Lesson:** readiness has two halves — *nothing is still mounting* **and** *nothing is still
loading*. `complete` is the predicate, not `naturalWidth`: a genuine 404 settles to `complete:true`
with a zero box, and **that zero box IS the site's rendering** — the clone must reproduce it, not
wait for it.
> 🔒 **Enforced now:** settle waits for every **rendered** image and reports `imagesPending` /
> `pendingImageSrcs`; a pending image makes `stable:false`, which the RUNBOOK already tells you to
> stop on. `harness/fixtures/32-settle-image-readiness.js`; battery defect `settle-image-pending`,
> controls `adv-settle-images-loaded`, `adv-settle-hidden-pixel`, `adv-settle-image-in-closed-flyout`.
> 👁 **Still yours — and the sharpest part of this one:** "does it render" is answered by a **layout
> box** (`getClientRects().length`), *never* by `getComputedStyle(img).display`. An element inside a
> `display:none` **ancestor** still computes its own display as `"block"`. The first cut of this rule
> used the computed display and chrono24 broke it on contact: the one image that never loaded was a
> 32×32 badge inside `#js-header-security-flyout`, a closed flyout **eight levels up**. Hidden menus,
> closed flyouts and offscreen templates hold pending images on most real sites — that rule would
> have refused to capture nearly every page. The real site is the best false-positive hunter you have.

---

## 29. A 543px MENU OPENED AND THE INSTRUMENT SAW NOTHING — record every property a reveal can move
Found on chrono24; this is **#22's rule hitting its second instance**, on a property nobody had added
yet. #22 taught that a pre-mounted panel revealed by `visibility: hidden → visible` (aloyoga, lelabo)
moves none of `opacity`/`transform`/`filter`, so `visibility` had to join the snapshot. chrono24
reveals its three header flyouts a **third** way — by `display`:

    .header-navigation .header-flyout        { display: none; }
    .header-navigation .header-flyout.active { display: block; }

The panel is pre-mounted (103 descendants, open or shut) and while it is **shut** its opacity is 1,
transform `none`, filter `none`, visibility `visible` — *every property the snapshot recorded was
already at its open value*. Measured on live by applying the site's own `.active` class: the panel
went from `display:none` / **0px** to `display:block` / **543px of painted menu**, and the
four-property snapshot recorded **byte-identical** before and after. The gate was safe but blind: it
could file the row `inconclusive` forever (#22's guard) and never verify it, and a clone whose flyout
stayed shut was a missing menu nothing in the kit could see.
**Lesson:** the durable form of #22 — **the snapshot must record every property a reveal can move**:
`opacity`, `transform`, `filter`, `visibility`, `display`. A reveal mechanism the instrument does not
record is a reveal it cannot gate; and when a probe keeps coming back "inconclusive", suspect the
snapshot before you blame the trigger.
> 🔒 **Enforced now:** `styleSnap` records `display`; `compareMeasured` compares it **only when both
> captures have it** (old captures skip, never retro-fail). `harness/fixtures/35-display-driven-reveal.js`;
> behavior battery defect `display-reveal-stuck`, controls `adv-display-reveal-reproduced` +
> `adv-display-old-schema`. Adopted at **+3 gained / 0 regressions**.
> 👁 **Still yours:** a synthetic `MouseEvent` still cannot open a real hover menu (#22 stands). The
> disposition that works: measure the mechanism **directly** — apply the site's own class and record
> what moves — then reproduce *that* in `fixes.js` and put the open panel in front of a reviewer.

---

## 30. THE BOX IS NOT THE IMAGE — a reviewer saw grey holes the gate had certified
Found on chrono24, **by the reviewer**, on a clone the kit had passed end to end: `--visual`
0/5911, strict 0/18770, coverage 396/396, behavior PASS, `clone-lint` clean. Their first words were
*"the images are not rendered."* Ten watch photos in the "our most popular models" grid had failed
to load and were rendering as grey holes.

The gate could not have caught it. An `<img>` that 404s but whose size comes from **CSS** is
identical, in every property the snapshot recorded, to the real photo:

    box (rect + glyph cx,cy,w,h)   272 x 332   ← same
    bg, present, layout, font      same
    naturalWidth                   0           ← NEVER MEASURED

Re-run against the real captures, the numbers are exact: the **old gate passes the broken clone
0/6002**; the new one **fails it 10/6091**, naming `img_80 … img_101 · glyph.painted live=true
clone=false`. That pair is frozen in the corpus as `image-not-painted`.

The *cause* of the breakage is worth its own line, because it will bite again: `capture-build` did
`srcset.split(",")` — but **a srcset candidate URL may contain commas**. Every modern image CDN puts
them in the path; Cloudflare's resizer ships
`/cdn-cgi/image/f=auto,metadata=none,q=85/…`. Splitting on bare commas shattered one URL into three
fragments, each then resolved against the page origin into 404 garbage
(`https://www.chrono24.com/metadata=none`). Per spec a candidate's URL is a run of **non-whitespace**
characters — parse it, don't split it.
**Lesson:** the family of #11 (the underline) and #16 (the backdrop), and the last member nobody had
added: **an image's PIXELS are a painted mark, and the box is not the image.** Whenever the tool
measures a *container* for something that paints *inside* it, ask what would still match if the paint
never arrived. `complete && naturalWidth > 0` is the whole test.
> 🔒 **Enforced now:** `glyph.painted` is captured (schema-identical in `browser-capture.js` and
> `pixel-diff.js`) and compared by `--visual`; `capture-build` parses `srcset` per spec.
> `harness/fixtures/36-image-not-painted.js` fails without both halves. Battery defect
> `image-not-painted` + controls `adv-image-painted-both`, `adv-image-broken-both`,
> `adv-image-srcset-candidate`, `adv-image-old-schema`. Adopted at **+5 gained / 0 regressions**.
> 👁 **Still yours:** an image broken on **both** sides is a MATCH, not a hole — the clone is
> faithfully reproducing the site's own broken image (#25), and only *you* can decide whether the
> live site is meant to look like that. And `naturalW/H` are recorded but deliberately **not** gated:
> live and the clone may pick different `srcset` candidates (1x vs 2x) and still paint identically.

---

## The gate vs your eyes — the one split that keeps this general
Every lesson here is one of two kinds. Keep them apart, or you'll re-measure what the
tool guarantees and eyeball what it can't:

- 🔒 **Gate-enforced — trust `--visual`, don't re-derive by hand.** Same-width capture;
  glyph box via `Range`; painted glyph + `background-position`; full box-model; font
  incl. `line-height` / `letter-spacing` / `color` / `decoration` / **`smoothing`**; the
  **underline box**; the **painted backdrop** (`bg` — bar/button/badge colour); **whether an image
  actually PAINTED** (`glyph.painted` — the box is not the image, **#30**); parent
  `gap`; presence & `text.present`. If the diff is green on
  these, they match — pushing further is fitting sub-pixel noise (#15). *When you find a
  new class of miss, add it to the tool (as underline/smoothing were added), not to a
  reviewer checklist — that's how it stops recurring.*
  Before the diff ever runs, the **capture** is gated too: the settle sweeps with an **instant**
  scroll (a smooth-scrolling page would otherwise never move under it — **#27**), refuses a page
  still growing (`stable:false` — RUNBOOK "Build by capture", locked by
  `harness/fixtures/30-scroll-settle-stability.js`) **and one whose rendered images are still in
  flight** (`imagesPending` — **#28**); the DOM is serialized without `cloneNode`, so an upgraded
  custom element's subtree survives the capture (**#26**); and the automation's own overlay DOM is
  stripped from every capture and REFUSED in a built clone (`agent-dom`, **#24**). The **behavior**
  snapshot records every property a reveal can move — `opacity`/`transform`/`filter`/`visibility`/
  **`display`** (**#29**). And the **artifact** is gated: `clone-lint` FAILs an empty mount point
  (incl. framework mounts — `data-vue`, `data-react*`), a frozen reveal, and the agent's overlay —
  while a `display:none` container live itself hides is correctly **not** a hole (**#25**).
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
20. 🔒 **The instrument paints on the page** (#24, #31) — the automation extension injects its own
    overlay (`#claude-agent-*`, `#claude-phantom-*`, `#claude-static-*` — the namespace is a
    LIST, and #24 first enumerated only two of its three prefixes); the capture strips it,
    discovery ignores it, and `clone-lint` REFUSES a clone that ships it. 👁 Nothing in a green
    table says "this row is *you*" — when a discovered behavior has no plausible owner in the
    design, suspect your own instrument before you reproduce it, and when you find one of its
    nodes, go looking for its siblings.
21. 🔒 **Hidden is not missing** (#25) — `clone-lint` FAILs empty mount points (incl. framework
    mounts: `data-vue`, `data-react*`) and frozen reveals, but a transition cannot fire on
    `display:none`, so a container live itself hides is faithful, not a hole. 👁 An empty mount
    looks identical whether your capture was too early or live renders nothing there either —
    **check live before you "fix" one.**

## 31. THE GUARD LISTED TWO OF THREE PREFIXES, AND THE INSTRUMENT WALKED AROUND IT
Found on dtf, and it is #24 recurring **through the gap in its own guard**. #24 taught the kit that
the automation extension paints on the page it is measuring, and keyed the defence — correctly, and
narrowly — on the extension's own ID *namespace*: `#claude-agent-*`, `#claude-phantom-*`. That list
is incomplete. The same extension also ships a "Claude is active in this tab group" toast:

    #claude-static-indicator-container
      ├ #claude-static-chat-button   + #claude-static-chat-tooltip    ("Open chat")
      └ #claude-static-close-button  + #claude-static-close-tooltip   ("Dismiss")

Nothing in the kit knew that prefix, so all three halves of #24's fix failed at once, and each
failed silently:

    pxDomHtml            did not strip them → 5 nodes serialized into dom.html, and
                         capture-build BAKED THEM INTO THE SHIPPED CLONE
    clone-lint agent-dom exited 0 on the contaminated artifact — the backstop whose entire job
                         is to catch a contaminated artifact CERTIFIED one
    behavior discovery   inventoried `declared:claude-static-chat-tooltip` as a behavior OF
                         DTF.COM, awaiting reproduction; its leaves entered coverage as the
                         site's painted leaves (137 vs 132 clean)

And the sharpest detail: while `agent-dom` walked past the extension's nodes, `clone-lint`'s
*frozen-reveal* rule fired **on those same nodes** — reporting the instrument's own "Open chat" and
"Dismiss" tooltips as a defect **of dtf.com**. The gate blamed the site for the instrument's DOM.

Re-run against the frozen artifact the numbers are exact: the old lint passes the contaminated
clone (**exit 0, "no FAIL rules"**); the new one fails it **5 nodes**, and the A/B is +1 defect
gained, 0 regressions, 0 new false positives across 42 controls.
**Lesson:** #24 was right that the defence must be an ID *namespace* and never a substring — but a
namespace is a **list**, and **a guard that enumerates two of its three prefixes is a guard the
instrument walks around.** Enumerate the vendor's namespace completely, and keep every call-site
reading the same list: a prefix known to the capture but not to the lint is the same gap wearing a
different hat. 🔒 `pxAgentDomSelector`, `AGENT_DOM_SELECTOR` and `clone-lint`'s `agent-dom` rule all
carry all three prefixes; `37-agent-dom-static-namespace.js` fails without them, and its shim parses
the selector the tool *declares* rather than restating it — a fixture that hard-codes the list would
pass while the kit stayed broken. 👁 When a gate blames the site for something you cannot find in
the design, suspect your own instrument before you reproduce it — and when you find one of its
nodes, go looking for its siblings.

## 32. THE TAB WAS HIDDEN FOREVER — a gate may refuse an environment only if the kit can provide one
Found on pingfusi-landing (2026-07-12), then terminally on a mindmarket run the next day. Under one
browser-automation stack, `document.hidden` is `true` for EVERY tab, permanently — fresh tabs,
reconnects, explicit foreground attempts, even as the only open tab after a real click — and the
CSS-animation compositor is genuinely suspended: the marquee sampler read **0 px/s on a belt that
moves**, on live and clone alike. The pingfusi-landing run escaped analytically (track `scrollWidth`
÷ `animation-duration` → 45.986 px/s, matching exactly on both sides) and passed the gate — hours
before the same evening's hardening taught the gate to refuse `discovery.documentHidden` captures
outright. That refusal is correct about the physics (#22, #27: numbers sampled where the clock does
not advance are artifacts of the instrument, not the page) — and it turned this environment into a
**deadlock**: behavior can never pass, review/done are order-gated behind it, and `--force`
correctly poisons `done`. An agent in that environment cannot finish a clone at all, and retrying
is not a fix, because the environment is the defect.

**Lesson:** a gate that refuses an environment must come with a way to PROVIDE one, or it converts
an honest refusal into an unfinishable pipeline. The fix is not to relax the gate (a hidden tab
still measures nothing) and not to borrow the agent's browser harder — it is to stop depending on
the agent's browser for measurement: `pingfusi behavior-capture <name>` runs the SAME
`tools/behavior-capture.js`, byte-identical, in a Chrome the kit launches with throttling disabled
(or attaches to), and writes both `behaviors-*.json` directly over CDP — no sink, and no CSP dance,
because `Runtime.evaluate` is not subject to the page's `script-src`. And the runner does not get
trusted either: "we launched it ourselves" is a claim, so a measured probe (rAF cadence + a known
100 px/s test animation) must show the compositor advancing before a single capture, and the
snapshot carries a `discovery.runner` attestation the gate cites in its pass reason.
> 🔒 **Enforced now:** both hidden-tab refusals name the runner as the way out (a refusal that
> only says "foreground the tab" is a dead end in this environment); the runner refuses its own
> tab on a failed probe, records `documentHidden` as measured, and dumps a capture that went
> hidden mid-run to `.rejected.json` rather than overwriting the artifact. Locked by
> `cdp-selftest` / `chrome-selftest` / `behavior-runner-selftest` (the integration half measured
> a known 100 px/s fixture marquee at 101 px/s in a launched headless Chrome, `documentHidden:
> false`) and the new behavior-selftest assertions.
> 👁 **Still yours:** the bot-wall ladder. A fresh automated profile loses to a challenge wall in
> BOTH headful and headless (measured on chrono24) — the runner prints the ladder (persistent
> `--profile` → `--attach` to a Chrome you launched → worksheet rows answered by the reviewer)
> instead of climbing it for you, because logging in and clearing challenges is judgment, not
> plumbing.

## 33. THE INVISIBLE CHROME RENDERED A DIFFERENT PAGE — normalize the viewport, don't inherit it
Found on heyaristotle (2026-07-14), reported as "the window size was different from the rendered
site size" — and the report undersold it. A launched headless Chrome inherits THREE wrong
viewport properties at once: `devicePixelRatio` is **1** where every dev Mac renders at 2 (the
site serves 1x srcset images and `min-resolution` media queries never match), `innerHeight` comes
up **87px short** of the asked `--window-size` (phantom browser UI in a browser with no UI — the
fold moves, scroll-reveal triggers shift), and the width-only conditional override that was
supposed to help never fired, because width happened to be the one property that matched. The
page's own `scrollHeight` changed **6526 → 6554** under a corrected viewport: the RENDER differed,
not just the numbers a capture would report.

**Lesson:** an invisible measurement environment must be normalized, never inherited — and
"normalized" means every render-determining viewport property (width AND height AND
deviceScaleFactor — never `deviceScaleFactor: 0`, which means "keep the wrong one"), set BEFORE
first navigation so the initial render already sees the right media queries and picks the right
assets, then read back and refused by name on mismatch. A conditional fix keyed on one property is
a fix that skips the day the other two are wrong. The viewport resolves like any other comparison
contract: explicit `target.json` fields, else the viewport an existing `live.json` was measured at
(compare like with like), else the kit's canonical defaults (1440×982 @2x).
> 🔒 **Enforced now:** `chrome.js` `normalizeViewport` runs unconditionally on every runner tab
> (`behavior-capture` and `capture-run` both), `viewportMismatch` refuses a page that didn't take
> the override (naming the property), launched Chromes get `--hide-scrollbars` (classic scrollbars
> are an ENVIRONMENT property that eats ~15px of layout width the dev's overlay-scrollbar Mac
> never loses), and a remaining `clientWidth` gap is a recorded NOTE, not a refusal — after the
> flag it can only be site-authored root-scrollbar styling, which is how that page renders for
> real users too. The attestation/receipt records the viewport with per-field sources. Locked by
> `chrome-selftest` (resolution + mismatch naming + the note split) and both runner selftests (the
> integration half asserts the snapshot's viewport is EXACTLY 1440×982 @2x in a real launched
> Chrome).
> 👁 **Still yours:** picking a nonstandard viewport on purpose (a mobile-width clone, a 1x
> screenshot target) — set it in `target.json` (`width`/`height`/`dpr`) and the runners obey;
> the default only exists so that not-choosing isn't silently choosing dpr 1.

## 34. THE LAZY IMAGE THAT COULD NEVER LOAD — provide the state, don't wait for it
Found terminally on mindmarket (2026-07-17). The client-logo belt shipped `loading="lazy"`
logos whose boxes are ZERO-WIDTH until the bytes arrive (height attr only, `width:auto`) —
and the lazy loader never fires for a box it never sees intersect. So `complete` stayed
false forever, the image-readiness wait (#32's sibling, fixture 32) timed out identically
on every run, and the settle refusal became a DEADLOCK: `capture-run` could never proceed
on a page every real visitor loads fine. Same lesson as #32 on a new axis: a gate may only
demand a state the page (or environment) can actually reach — refusing forever is not
honesty, it is the instrument mistaking its own blind spot for the site's defect.

The fix intervenes instead of waiting: still-pending `loading="lazy"` images are promoted
to eager after the normal wait bound (the fetch fires immediately, no intersection needed),
the network gets one more bounded window, and the attribute is put back so `dom.html` ships
byte-identical to live (#24/#29: the instrument must not bake itself into the artifact).
The refusal is NOT weakened — a promoted image that still never completes refuses the
capture exactly as before, and non-lazy in-flight images are never touched. Every
intervention is receipted (`settle.lazyPromoted` + `lazyPromotedSrcs` in the run receipt).

🔒 **Locked in:** fixture `39-lazy-image-promotion.js` (deadlock breaks, refusal survives,
attribute restored); the promotion lives in `pxScrollSettle` so both capture paths get it.
👁 **Still yours:** a page whose lazy images are gated on user gestures (click-to-load
galleries) — promotion fetches them too, which may capture MORE than a fresh visitor sees;
if the diff shows content a visitor must click for, exclude it deliberately.

## 35. THE BELT GLIDED FOR FOUR SECONDS AND FROZE FOREVER — a finite recording of an infinite animation is not an implementation
Found on the ladder rails (2026-07-19), and it slipped through GREEN. The sampled tier did
everything it promised: it recorded a forever-running belt as a 4s virtual-time clip,
`apply-sampled` shipped the clip verbatim as the clone's implementation, and
`verify-sampled` re-ran the identical stimulus and matched every frame — because the gate
only ever compared INSIDE the window. The served clone then glided for exactly four
seconds and froze, forever. Worse: the finished clip's `fill: "forwards"` kept writing the
final frame at composite priority for the rest of the page's life, silently overriding a
coexisting implementation that was trying to animate the same element — a dead clip
squatting on a live element. Three category errors stacked: the record never distinguished
"motion that ended" from "motion the window ended on"; the apply treated a WINDOW onto
motion as the motion itself; and the verify certified a clip by checking only the frames
the clip contains — the one place a frozen clone cannot fail.

**Lesson: a finite recording of an infinite animation is not an implementation — it is a
window, and a window has edges the pipeline must prove, not assume.** The record must SAY
whether the motion ever settled (a series still changing in its final frames observed no
ending — nothing licenses inventing one). An implementation for ongoing motion must have
the same cardinality as the motion: a loop driven by the fitted LAW (velocity, direction,
wrap distance measured from the element at runtime), never a replay of the window. And a
finite clip that does end must END: release the element instead of squatting on it, and
never take an element another implementation already owns. The gate closes the circle by
looking PAST the edge it used to stop at.

> 🔒 **Locked in, four ways.** (1) ONGOING DETECTION: the sampler marks `ongoing: true`
> on any sampled track still moving in its last ~10% of frames (noise-floored), the
> motion-doc schema carries the flag, and the fit lift's tie-break re-classifies an
> ongoing track's full-window linear tween as marquee — ongoing beats finite when
> `ongoing: true` (motion-doc-selftest + motion-sampler-selftest). (2) A CLIP IS NOT AN
> IMPLEMENTATION FOR ONGOING MOTION: `apply-sampled` refuses to ship a one-shot clip for
> an ongoing track ("ongoing motion with no periodic fit — trace longer, or declare the
> loop form"); with a marquee fit it emits the LOOP — `iterations: Infinity` at the
> fitted velocity, wrap distance from the element's own `scrollWidth/2` at runtime.
> (3) RELEASE-ON-FINISH + ONE OWNER: finite clips play with `fill: "none"` and an
> explicit `onfinish` that commits the final frame only when no other writer owns the
> element, then cancels; and before writing anything, an owner probe watches the target
> elements' inline style + computed transform for ~1s in the served clone and refuses by
> selector when another implementation moves them — the kit never stacks
> implementations. Both asserted from the EMITTED player source executed in a mock DOM,
> not just unit logic (motion-verify-selftest). (4) THE POST-WINDOW GATE:
> `verify-sampled` samples extra frames past the clip end on the same virtual clock —
> live ongoing + clone static exits 1 named "unterminated motion: live continues past
> the clip, clone froze"; a looping clone must still move at the fitted velocity; a
> clone still animating where live settled fails too; and ongoing tracks diff in-window
> by motion LAW (velocity/direction), since a runtime-measured loop owes the law, not
> the phase.
> 👁 **Still yours:** ongoing motion that is periodic but not constant-velocity — a
> pulsing opacity, a spring idling in a loop, a spinner the marquee class refuses. The
> kit refuses those honestly rather than fabricating a loop form; declaring the loop (or
> tracing long enough for a better periodic fit) is a judgment about what the motion IS,
> and that stays with you.

## 36. THE PROBE WATCHED FROM THE TOP OF A PAGE WHOSE WRITERS ONLY WORK MID-SCROLL — observe at the vantage the player will run from
Found proving §35's ONE-OWNER rule end-to-end (2026-07-19). The owner probe did exactly
what it said: it watched the target elements' inline style + computed transform for a
full second in the served clone, saw nothing move, and cleared the apply. But it watched
from scroll 0 — and the competing writer was a belt that only advances while its rail is
in the viewport, at document-top 13725px on a 963px viewport. A visibility-gated writer
is not an exotic adversary; it is the DEFAULT shape of a performant page (the live site's
own rail component works the same way). The gate's question was right, its vantage was
wrong, and a wrong vantage converts "no competing writer" into "no competing writer
visible from where I happened to stand" — a false all-clear the very next scroll refutes.

**Lesson: a probe that observes conditional behavior must reproduce the condition — 
observe at the vantage the code under question runs from, or the observation is of the
vantage, not the code.** The probe now sorts watched elements by document position,
partitions them into viewport groups, scrolls each group into view, gives its writers one
settle tick to arm, and only then baselines and watches; the original scroll position is
restored afterwards. Elements beyond the group cap are reported by name as unwatched —
a partial watch refuses to become an all-clear — and the receipt carries the groups and
the scrolled flag so a clean verdict names the vantage it was earned from.

> 🔒 **Locked in:** `pxOwnerProbe` (tools/browser-capture.js) implements the vantage
> rule; `apply-sampled` budgets the probe per viewport group, hard-fails on any
> unwatched element, and receipts `groups`/`scrolled`. The fixture is a writer gated on
> its element being in view, below the fold — the pre-fix probe reports it CLEAN (the
> preserved pre-fix implementation demonstrably returns zero changes against the same
> fixture), the fixed probe reports the writer by selector and restores the scroll
> (motion-verify-selftest). Proven live the same day: the probe scrolled to the rail's
> group, caught the clone's legacy hand-written belt mid-write at +101ms, and the apply
> refused by selector — the refusal §35 promised.
> 👁 **Still yours:** writers gated on conditions a scroll cannot reproduce — hover,
> focus, media-query, time-of-day. The probe reproduces the one condition every scroll
> trigger shares (being on screen); rarer gates need the operator to stage the condition
> or resolve ownership by reading the clone's code.

## 37. THE GATES MEASURED THE SKELETON WHILE THE PAGE PAINTED IN CANVAS — pixels are the only witness that painting happened
Found on bizar.ro (2026-07-20), and it reached a reviewer. The site paints its entire
visible surface in a WebGL canvas; the DOM around it is a thin skeleton. Both snapshots
come from the same instrument (`tools/browser-capture.js`), so every property the capture
CAN see — boxes, fonts, backdrop colors, the canvas element's own rect — agreed perfectly:
visual passed **1236/1236**, the pipeline went green end to end, and the published draft
rendered **SOLID BLACK**. The filed round's one answer was "cannot see any draft" — a
whole review round spent confirming what one screenshot would have said for free. This is
the aloyoga shared-blind-spot (#20's file, clone-lint's header) one layer down: there, a
property the capture didn't measure was a property both sides agreed about; here, the
capture measured everything it knows how to measure and the page's actual PAINTING lived
in none of it. No DOM gate can close this — script-driven canvas painting is invisible to
DOM measurement by construction, and a static DOM clone cannot reproduce it at all.

**Lesson: a gate stack built on one instrument inherits that instrument's blind spot on
both sides at once — so at least one receipt must come from a different witness. For
"did the page paint", the only honest witness is the pixels themselves.** And when the
answer is "this site's painting is script-driven canvas", that is not a defect to fix but
a CAPABILITY LIMIT to state: receipt it, warn on it, and refuse to spend a reviewer round
on a draft the probe already knows is blank.

> 🔒 **Enforced now, four ways.** (1) THE PAINT PROBE: `capture-run` takes one
> `Page.captureScreenshot` per side (the CDP session is already open) and reduces it to a
> paint statistic via a dependency-honest PNG scanline reader (zlib is a Node built-in —
> no image library enters the core kit): `paintStat` per side in `capture-run.json`, and
> a clone under the documented near-blank floor while live sits above the rich floor is a
> WARNING receipt on the run — "the clone paints almost nothing" — never a capture
> failure (first-draft doctrine). The pairing is the false-positive guard: a genuinely
> minimal live page never flags its equally minimal clone
> (harness/fixtures/43-paint-probe.js). (2) THE CAPABILITY STATEMENT: `pxCanvasDominant`
> (tools/browser-capture.js) receipts `canvasDominant` on the live capture — a canvas
> covering more than ~half the viewport with fewer than a dozen painted DOM marks in
> front means this site's visible painting is script-driven canvas and a DOM clone CANNOT
> reproduce it (harness/fixtures/44-canvas-dominant.js). (3) THE STATIC RATCHET:
> clone-lint's `dead-canvas` rule fails a built clone that is a canvas plus almost
> nothing else painted — a blank sheet no reviewer should be sent
> (harness/fixtures/20-clone-lint.js). (4) THE FILING GUARD: `review-qa.js file` refuses
> — full rounds and diagnostics alike — while the run receipt's paint warning stands;
> `--anyway` overrides WITH a `paint_override` receipt on the round
> (harness/fixtures/49-paint-filing-guard.js). Never burn a reviewer round on a black
> page.
> 👁 **Still yours:** what to DO with a canvas-dominant site. The kit states the limit
> honestly; choosing between scoping the clone to the regions DOM can carry, embedding a
> poster frame of the canvas as a deliberate deviation, or declining the target is a
> judgment about what the product should promise — and a `--anyway` filing over the
> guard is that judgment made explicit, receipted on the round.

## 38. THE BELTS NEVER SETTLE, SO THE SNAPSHOTS RACED THEM — measure at a frozen phase, exclude out loud what cannot freeze
Found TWICE on mindmarket (2026-07-20, kit 0.9.0), identically. The page runs belts that never
settle by design, so live.json and clone.json each caught them at a phase determined by WHEN that
page happened to load — and visual/strict failed a CORRECT clone with hundreds of constant-offset
deltas (334 and 336, two runs, same shape). The settle wait is the wrong tool by definition: it
waits for a state this animation never reaches. Every delta was real arithmetic over numbers that
were noise by construction — the instrument was measuring its own arrival time, not the page
(#20's rule wearing a clock).

**Lesson: a measurement of animated content is only comparable at a FIXED ANIMATION PHASE — so
the capture must freeze the phase before measuring, and anything it cannot freeze must be
excluded from the comparison OUT LOUD, per mark, never silently.** Both halves matter. Declared
animation (CSS/WAAPI — everything `document.getAnimations` returns) can be paused and seeked to
the canonical phase: progress 0 of its current iteration, the pose a normal-direction loop
renders identically every cycle, on both sides, regardless of load time. rAF-driven motion owns
no Animation object and CANNOT be paused generically (GSAP's ticker included) — pretending
otherwise would trade phase poison for a fake freeze, so those movers are receipted as
`unfreezable` and the marks inside their subtrees leave the pixel comparison with their names on
the gate output. An exclusion the operator never sees is a silent drop; an exclusion LISTED is
the honest boundary of the instrument. And the freeze must not touch what the page settled into:
a finished entrance animation's end state IS the page, a page-authored pause is a deliberate
pose, and a scroll-linked timeline's phase is already fixed by scroll position.

> 🔒 **Enforced now:** `pxCaptureAllPhased` (tools/browser-capture.js) is the runner's
> one-call — settle → `pxFreezeAnimations` → measure — so capture-run measures both sides
> at phase 0 with the freeze receipted in the snapshot's `freeze` field (count, ids, what
> was skipped and why). Kit-generated players freeze their own writers first through the
> `window.__pingfusiFreezeHooks` contract (the emitted motion-replay player registers it;
> any future non-WAAPI kit player must too, or its subtree is excluded as unfreezable).
> The post-freeze watch (the dense recorder — the ongoing sampler's own instrument) plus
> the sweep's receipts (sampled-ongoing tracks, detect list) name the unfreezable movers;
> `pxMarksInSubtrees` maps their subtrees to snapshot marks, and diffSnapshots EXCLUDES
> exactly those marks — counted in the summary, listed by formatDiff, named on the visual
> and strict gate reasons, pass or fail. Locked by
> `harness/fixtures/47-phase-freeze.js` (phase-shifted WAAPI lands at phase 0 on both
> sides; the emitted player's hook freezes only its own animations; the gates go green on
> a phase-shifted-but-correct pair that fails without the change, with the exclusion
> named; an unrelated miss is NOT laundered by an exclusion; no-freeze snapshots behave
> exactly as before) and the capture-runner selftest (known-unfreezable plumbing in, sweep
> movers noted into live.json same-run, foreign selectors from the page refused).
> 👁 **Still yours:** what an excluded mark MEANS. The gate tells you which marks left the
> comparison and which mover owns them — whether the draft's reproduction of that mover
> looks right is exactly what the compare round exists for, and alternate-direction loops
> frozen at different iteration parities can still legitimately differ. The exclusion list
> on a green gate is a reading assignment, not a clean bill.

## 39. FOUR PAPER CUTS, FOUR REAL COSTS — the kit's own rough edges are misses, and they gate like misses
Found across the 2026-07-20 reviewed runs (kit 0.9.0), none of them exotic, all of them paid for:
(1) capture-build self-hosted css/fonts but hotlinked `<img>/<video>` — bizar.ro's images kept
cross-origin srcs WITH their `crossorigin` attributes, so on localhost Chrome fetched them in CORS
mode and refused to paint; the boxes are CSS-sized, so the sweep stayed green over the holes and a
hand fixup ate the session. (2) `pingfusi new <name> <url> default` coerced the width to NaN and
WROTE IT into target.json — the scaffold never refused, and every later gate compared against a
width that does not exist. (3) A bare `pingfusi assist` filed a text-only element question; the
live reviewer's entire answer was "I dont understand. Send a comparison" — a round burned on the
FORMAT — and `assist --compare` then demanded a fresh draft push while a valid draft.json sat on
disk. (4) The skill said "WIDTH: default 1512" while new-target.js scaffolds 1728 and adopt.js
scaffolded a third default of its own — an agent following the doc measured a different page than
the kit built.

**Lesson: ergonomics are correctness.** A tool edge that makes the operator hand-fix, re-push,
re-scaffold, or measure at the wrong width costs exactly what a wrong number costs — reviewer
rounds and trust — so each edge gets the same treatment as a measurement miss: a refusal or a
receipt at the point of damage, plus a fixture. Concretely: media assets self-host like css/fonts
(crossorigin dropped; a failed download is a per-asset ⚠ receipt, never a build failure, because a
visible hole is reviewer-catchable while a silent font swap is not); a malformed width is a usage
error at every door that writes target.json; the diff's `glyph.painted true→false` row now NAMES
the cross-origin/CORS cause and the capture-build remedy instead of leaving a bare boolean; bare
assist refuses with the `--compare` nudge (the compare round is the one reviewer channel — first-
draft doctrine); `assist --compare` re-verifies and REUSES the recorded draft, demanding a push
only for a missing or byte-stale one; and the width default is ONE number that the docs are gated
against.
> 🔒 **Enforced now:** capture-build-selftest (media self-hosted with real bytes, srcset/poster
> rewritten, crossorigin gone, per-asset failure receipts with exit 0);
> `harness/fixtures/45-width-nan-guard.js` (the literal "default" refused at dispatcher AND
> writers, adopt/new agree on 1728); `harness/fixtures/46-cors-unpainted-hint.js` (the CORS hint
> fires only on live-true/clone-false); assist-selftest (the retirement nudge, no receipt on
> refusal, stale-draft refusal BY NAME, byte-verified reuse); docs-selftest gate 4 (scaffold
> defaults agree, the skill's number is the scaffold's number, 1512 banned from shipped docs).
> 👁 **Still yours:** the judgment inside the nudges. Whether a stale draft means "re-push" or
> "the clone regressed — fix first", and whether a reviewer question is worth a 5-result
> diagnostic at all, stay calls the operator makes; the kit only refuses the formats and inputs
> that are ALWAYS wrong.

## 40. THE GATE DEMANDED WHAT THE DOCTRINE FORBADE — every refusal must name an exit that is actually open
Found on the 2026-07-20 reviewed runs (kit 0.9.0), on CORRECT drafts. The behavior gate counted
every live row missing from the clone inventory as one kind of miss, with one message for all of
them: "reproduce in clone/fixes.js or document why in behavior-deviations.json". For TEMPORAL
rows — the sweep's `reveal:`/`mutation:`/`startup:` observations — both named channels are barred
by the kit's own rules: the deviations file refuses temporal evidence by doctrine (it is the
honest disposition for unsupported interaction/state rows, nothing else), and the motion pass,
which ALREADY reproduces those phenomena in the draft (captured CSS carries the css/transition
tiers, other tiers get generated WAAPI players) and receipts every element it acts on
(motion-items@2 items, motion-doc tracks), never writes `behaviors-clone.json` rows — clone-side
discovery does not re-observe a player as the same row. So the gate manufactured misses on rows
the build had reproduced AND receipted, and the only legal move left was `advance --blocked`
citing the kit's own doctrine at the kit's own gate. Strict had the same disease in message form:
its paint refusal read "visible marks can never be documented away, fix them" — implying the
`--blocked` receipt was refused too, when it was always accepted — so an agent facing an
environment-made delta (a never-settling animation caught at two phases, #38's poison) stalled
on a MESSAGE, with the legitimate exit sitting unadvertised in the code.

**Lesson: a refusal is a contract, and the message is part of the contract — every demand a gate
makes must name a channel some rule actually permits, and when two of the kit's rules combine to
close every channel a message names, the kit has manufactured a deadlock, not enforced honesty.**
The fix is never to relax the gate; it is to make the gate READ THE RECEIPTS the pipeline already
writes (the miss was real bookkeeping the accounting ignored), split the demand by jurisdiction
(temporal phenomena belong to the motion pass; interaction/state rows keep the deviations
channel), and make every refusal state what is actually accepted — including the escapes.

> 🔒 **Enforced now:** temporal rows missing from the clone inventory are never misses.
> `isTemporalBehaviorKey` classifies them and `motionReceiptForBehaviorRow`
> (harness/motion-items.js) looks the row's element up in the pass's own bookkeeping — an @2
> item by exact selector/scope match, behavior-key lineage, or a motion-doc track; pure,
> throw-free, and exact-match only (a fuzzy match would attach a receipt to motion it never
> covered). Receipted → SATISFIED-BY-MOTION, an informational line on the gate's pass reason
> citing each row → receipt id; unreceipted → an ⚠ advisory that routes at `pingfusi next` and
> says outright that temporal rows never require behavior-deviations.json entries. Non-temporal
> interaction/state rows keep the hard miss and the deviations channel. Strict's paint refusal
> now states both halves: deviations.json can never document a paint delta away AND the
> `--blocked` receipt IS accepted — done stays red until the phase re-earns a passing gate, so
> the receipt keeps the final claim honest. Locked by
> `harness/fixtures/48-temporal-satisfied-by-motion.js` (all three receipt kinds satisfy, cited
> by id; unreceipted rows advise at exit 0; a missing interaction row still blocks as the
> control; the strict message names the accepted escape — every half fails without the change)
> plus matching behavior-selftest, motion-items-selftest, and workflow-selftest assertions.
> 👁 **Still yours:** whether the motion pass's reproduction is any GOOD. Satisfied-by-motion
> means "the pass acted on this element and receipted it", never "the animation looks right" —
> that judgment is exactly what the compare round exists for, and the deep machine checks
> (`verify-introspected`, sample → apply-sampled → verify-sampled) are the operator utilities
> the advisory's `next` route points at.
