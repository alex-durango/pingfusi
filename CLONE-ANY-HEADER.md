# Prompt template — clone any site's header, pixel-perfect

Reusable template. Fill in the three placeholders below (or tell the agent their
values), then hand the file to an agent that has this kit's `tools/` available and a
browser it can drive (or DevTools access). It is otherwise self-contained.

**Fill in:**
- `{{URL}}` — the live page to clone, e.g. `https://www.example.com/`
- `{{WIDTH}}` — the measurement viewport width in px, e.g. `1728`
- `{{OUTPUT_PATH}}` — where to create the component, e.g. `components/Header.tsx`

---

Build a **pixel-perfect clone of the header at {{URL}}**, measured at **{{WIDTH}}px**
viewport width, as `{{OUTPUT_PATH}}` (create it from scratch). This is a study/clone
build — header **typography and iconography** are the target.

> **Pick the build strategy first (LEARNINGS #19).** If `{{OUTPUT_PATH}}` is a standalone
> clone page (e.g. `targets/<name>/clone/index.html`), **build by capture** — capture the
> settled live DOM (`pxSendDom`) and run `pingfusi capture-build <name>`; it inherits live's
> doctype and drawing techniques by construction, then verify with the gates below as
> usual. The measured-rebuild method that follows is for when the output is a **component
> in your own stack** (like a `.tsx` file) that capture can't express.

**Before writing any code, read these and follow them exactly:**
`PLAYBOOK.md`, `tools/RUNBOOK.md`, `README.md`, and `LEARNINGS.md`. The rules there
override any assumption you have.

**Method — measure the LIVE site, match what it actually renders:**

1. **Discover the fonts — don't assume any family.** First read the live DOM to find
   what the header actually uses: on {{URL}}'s DevTools console inspect the computed
   `font-family` of the header text elements (e.g.
   `getComputedStyle(document.querySelector('header a')).fontFamily`) and list the
   `@font-face` families the page loads. Then extract exactly those:
   `extractFonts(/<family-you-found>/i)` (or `extractFonts()` for all, then keep the
   header ones). Do not hard-code a font name from memory — the family is whatever the
   live site reports.

2. **Extract the rest of the real assets (never redraw or retype).** Run
   `extractIcons('header')`; capture the logo/wordmark `<svg>` and any header rasters
   by their real URLs. Self-host the woff2s; use the icons' **exact** captured
   data-URIs. If a header element renders a `font-weight` **heavier than any real face
   the site shipped** (a synthesized/faux-bold), reproduce that synthesis over the
   real max-weight face — do not substitute a different/heavier font.

3. **Measure the live DOM, not a spec doc.** Capture every header element's complete
   box at {{WIDTH}}px: geometry; the **text-glyph box via `Range`** (not the element
   box); the **painted glyph** for icons/logo (SVG bbox, or the background element
   **plus its `background-position`** — never the clickable wrapper); the full
   box-model; and the font **including `line-height`, `letter-spacing`, `color`,
   `-webkit-font-smoothing`, and `underline`**. The visible marks don't co-center —
   measure where each one paints. The diff engine already captures the two marks that
   used to slip a green sweep — **`font.smoothing`** (`-webkit-font-smoothing`:
   `antialiased` vs `auto` changes perceived weight while `font-weight` matches) and the
   **underline as a box** (`underline.{thickness,x,width,top,bottom}`, taken off whichever
   element draws it — often an **ancestor** `border-bottom`, not the text) — and
   `--visual` compares both; trust the diff on them. Set your clone root to
   `antialiased`/`grayscale`. What you still own: **reproduce the drawing technique**
   (redraw the underline as that same `border-bottom` on a same-sized box so its Y
   *emerges* from the box model — never a hand-tuned offset, which rasterises unlike a
   real border and fails a flicker compare even at ~0.01px), and apply the same
   box-not-boolean principle by hand to any mark the tool doesn't special-case
   (`box-shadow`, `outline`).

4. **Build to those measurements**, then verify — never from a screenshot.

**Verification is the gate (this is what "done" means):**

- Capture both pages at the **same {{WIDTH}}px width** (see `tools/RUNBOOK.md` for the
  fast sequence: clone → `pxSend`; live CSP → inject source directly + `pxStash`/`pxRead`,
  never `fetch`+`eval`).
- Loop:
  ```sh
  node tools/pixel-diff.js live.json clone.json --visual
  ```
  Fix each ❌ and re-run **until it exits 0**. Then run strict
  (`node tools/pixel-diff.js live.json clone.json`) and **fix or explicitly document**
  every structural delta (Ground rule 4) — a colour / `underline` / `visibility` row
  is never "structural."
- **Close coverage:** auto-enumerate every painted element in the header band (own
  text, background-image, or `<svg>`) and add a `pxTargets` entry for each one that
  has none; re-diff. Exclude off-screen (x<0), `display:none`, and flyout panels below
  the bar. The coverage list must end **empty** — a green table only proves the
  elements you measured.

**If a reviewer (or you) later spots something off** — a wrong colour, a missing
underline, a shifted glyph — do **not** guess the property. Run the reviewer-flagged
loop from `PLAYBOOK.md` Phase 6:
```sh
# pxInspect({text:"..."}) on live + clone → el_live.json / el_clone.json
node tools/pixel-diff.js --inspect el_live.json el_clone.json
```
The **PAINT** bucket is the exact fix list; apply those values and re-run until the
paint bucket is empty (exit 0). Two rules that turn a multi-round flag into one fix:
**resolve the element that actually *paints* the mark** (if the paint bucket is empty
but it still looks wrong, you inspected the text when an **ancestor** draws it — inspect
the ancestor's box: `top`/`height`/`box-sizing`/`border-bottom`), and **fix the whole
mark by reproducing its box model + technique in one shot** (a decoration's thickness,
width, offset, and drawing element together) rather than nudging the one facet named.
Then flicker/overlay the two at 1:1 — a technique mismatch survives a green number.

**Definition of done — paste the proof:** `--visual` exits 0 with every header
element covered, the strict run's structural deltas are each fixed or documented, and
you paste the final passing diff output (real measured numbers, not prose). Do not
claim "pixel-perfect" from anything but a diff that exits 0.
