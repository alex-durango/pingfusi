# RUNBOOK — the fast live-vs-clone diff sequence

The verified fast path. Target: **~2–4 browser round-trips + 1 local `node` call**,
not ~20. Every browser-automation call is a slow CDP round-trip, and a blocked
`fetch`/`eval` on a strict-CSP live site doesn't error — it *hangs to a 45s timeout*.
So the rules below are about avoiding slow/blocked paths, not compute.

## Golden rules (these are what make it fast)
- **Probe the delivery path FIRST — don't assume it's blocked** (see Step 0). On many
  "strict-CSP" sites a direct `fetch` POST to `http://localhost:7799` actually
  succeeds; `connect-src` is often looser than expected. If it works you skip the
  entire stash/read chunking dance. *Measured cost of assuming-blocked-without-testing
  on the aloyoga run: the whole 9-chunk manual reassembly, ~6 min wasted.*
- **Inject the capture code as PLAIN SOURCE, never base64/gzip.** Paste
  `tools/browser-capture.js` (the browser half of `pixel-diff.js`, extracted so it
  drops in as-is) directly as the code to evaluate. CDP-injected source isn't gated by
  `script-src`. Base64/gzip transports of the whole file are fragile — they corrupt or
  trip the automation harness's content filter. **Never `fetch(...).then(eval)`** on a
  strict-CSP origin — that path *is* gated and hangs to a 45s timeout.
- **Don't return URLs / data-URIs / base64 through the JS tool.** The automation
  harness may silently blank the result (`[BLOCKED: …]`). Deliver payloads by POSTing
  to the sink, or stash to a `window` var and read one clean dump — never inline them
  in a return value.
- **Batch.** Fold independent calls into one `browser_batch` (both page captures
  together; all chunk reads together).
- **One capture per page, all targets at once.** Not one call per element.
- **Same viewport width on both**, or the diff won't trust x-positions.
- **Check `~/Downloads` before re-running `extractFonts`/`extractIcons`.** They dump
  zips to disk; a prior run's `<host>-fonts.zip` / `<host>-icons.zip` may already be
  there (`ls ~/Downloads/*<host>*`).

## Prereqs
- Your clone dev server running (note its port).
- A delivery path from Step 0: the hosted capture session (default), or the local
  sink (`node tools/sink.js`, :7799) for the fast inner loop where localhost works.

## Build by capture (the DEFAULT build step — do once, before the diff loop)
Don't hand-rebuild the markup: capture it (LEARNINGS #19 — a reconstruction manufactures
exactly the technique mismatches the gate is blind to; a capture inherits live's doctype,
authored line-heights, and drawing primitives by construction).

1. Inject `tools/browser-capture.js` as plain source on the live tab (same rules as
   measurement — never fetch+eval), then let the page **settle mechanically** — do not
   hand-scroll and hope:
   ```js
   await pxScrollSettle()   // → {scrolledTo, frozenOpacity0}
   ```
   It walks the full page (firing IntersectionObservers + lazy loaders, re-reading
   scrollHeight as sections mount), waits for reveal transitions to land, and returns to
   top so sticky-header state matches what the gates measure. **Check the return value:**
   `frozenOpacity0 > 0` means some scroll-reveals STILL haven't fired — inspect those
   elements before capturing. Paid for on aloyoga: a top-of-page capture shipped a clone
   with one section missing entirely (lazy, never rendered — its content lived only in a
   `<script>` the build strips) and four blocks frozen invisible at inline `opacity:0`.
   This step existed here as prose ("scroll to the bottom and back") and was skipped —
   which is why it is now a command with a checkable result, not an instruction.
2. Deliver the doctype-exact post-hydration DOM:
   ```js
   await pxSendDom('<sink_url>/dom.html')   // hosted session (Step 0) — or
   await pxSendDom('http://localhost:7799/dom.html')   // local sink, when localhost works
   ```
   CSP-blocked POST → `pxStash(null, 900, pxDomHtml())` + batched `pxRead` (Step 3 below).
   Big page (> ~500 KB DOM) or a 409 from the sink → `pxSaveDom('dom.html')` (Step 0).
3. Build the standalone clone from it:
   ```sh
   pingfusi capture-build <name>          # or: node harness/capture-build.js <name>
   ```
   Downloads + self-hosts every stylesheet and font, absolutizes other asset refs, strips
   scripts/CSP/`<base>`, and **preserves the doctype or its absence byte-for-byte**. A
   `file://` url in `target.json` also works (build from a saved page). Failed downloads
   exit 1 — fix them before advancing the `build` phase.
4. The gates run unchanged from here: measure live, capture the clone, `--visual`,
   coverage, strict. What capture can NOT give you — JS-driven behavior, animated or
   generative content — you reproduce separately, and spend review rounds only there.

## Behavior discovery (the `behavior` phase — after the pixel gates are green)
Same injection + delivery rules as everything else here (plain source, probe the POST,
stash/read fallback). `tools/behavior-capture.js` provides `pxBehaviorDiscover(opts)` /
`pxBehaviorSend(url, opts)` / `pxBehaviorStash(opts)` + `pxBehaviorRead(i)`.

1. **On the LIVE tab:** inject `tools/behavior-capture.js`, set `pxRegion`, name what you
   can see moving — `opts = { marqueeSelectors: [["logo_belt", ".belt-wrapper"]],
   hoverTriggers: [["nav_product", "nav a[href*=product]"]] }` — then
   `await pxBehaviorSend('http://localhost:7799/behaviors-live.json', opts)`. The pass
   greps `@keyframes` + markers for candidates, then confirms and MEASURES what actually
   fires across a scripted scroll sweep (a candidate that never moves is noise, not a
   behavior). Its own sweep metadata is recorded — that's the gate's evidence discovery ran.
2. **Reproduce** each inventoried behavior in one vanilla `clone/fixes.js` (each in its own
   guarded `try`), using the MEASURED values. Rebuild: `pingfusi capture-build <name> --fixes`.
3. **On the CLONE tab:** same discovery, same opts → `behaviors-clone.json`.
4. `node harness/workflow.js gate <name> behavior` — misses are named with exact deltas;
   irreproducible content goes in `behavior-deviations.json` with a reason, never silent.
5. **The worksheet — the complete "supposed to move" list.** Discovery keeps
   declared-but-unfired candidates (markers, keyframes, transitions-from-hidden, videos)
   as `declared` inventory instead of discarding them — critical on sites that gate their
   choreography behind no-js/bot detection, where NOTHING fires for automation but
   everything is still supposed to. `node tools/behavior-worksheet.js <name>` prints one
   row per behavior (observed + declared) with its disposition; every UNRESOLVED row gets
   a ready-to-send one-sided poll question so the reviewer describes what live does before
   you engineer anything. Each behavior having an identity up front is what prevents two
   real behaviors merging into one invented hybrid — the gate refuses undisposed declared
   rows for the same reason.

## Step 0 — open the delivery path (do this before anything else)
**Default: a hosted capture session** — one-call, integrity-verified delivery from any
page; no tunnels, no downloads, unlimited calls:
```sh
pingfusi capture open <name>      # → sink_url (24h session on the review service)
```
then on any page, live or clone: `await pxSendDom('<sink_url>/dom.html')` /
`await pxSend('<sink_url>/live.json')` / `pxBehaviorSend('<sink_url>/behaviors-live.json')`.
Each call answers `ok <file> — N bytes, sha256 …`; a **409 means the payload was
truncated/corrupted in transport and NOTHING was stored** — re-send, never ignore.
Retrieve everything with `pingfusi capture pull <name> --all` — each file is re-verified
against the service-recorded bytes+sha256 before it lands in `targets/<name>/`.

**Faster inner loop (optional):** a direct localhost POST to `node tools/sink.js`
(run it from `targets/<name>/` — files land in the sink's cwd) skips the network
round-trip WHEN the environment allows page→localhost fetch. Probe once:
```js
fetch('http://localhost:7799/probe.json',{method:'POST',body:'{"probe":1}'})
  .then(r=>r.text()).then(t=>window.__post=t).catch(e=>window.__post='ERR:'+e.message)
```
Diagnose a refusal by its signature: a **clean ~4s abort**, OR a **45s hang with no
entry in the sink log even though the site sends no CSP header**, is the automation
extension blackholing page→localhost (environment-level — both signatures seen live);
a 45s hang on a site that DOES ship a strict `connect-src` is the site's CSP. Either
way: use the hosted session above.

**Offline / no login:** `pxSave('live.json')` / `pxSaveDom('dom.html')` (browser
download → ~/Downloads) is byte-exact BUT silently rationed: Chrome allows ONE
programmatic download per tab — every later save no-ops while still returning a
success-shaped `{bytes, sha256}` (LEARNINGS #21). Use a FRESH TAB per save and
confirm each file landed (`shasum -a 256` matches the returned sha) before building
from it.

**Last resorts:** the sink tunnel (`node harness/tunnel.js --sink`, needs cloudflared)
for POST loops in blocked environments; stash + chunked `pxRead` (Step 3) only when
outbound HTTPS itself is blocked (a real site CSP with a strict `connect-src`).

## Step 1 — both windows to the same width
Resize the clone tab and the live tab to the same width (e.g. 1728). Confirm
`innerWidth` matches on both (scrollbars/devtools can shrink it).

## Step 2 — capture BOTH pages in ONE browser_batch
- **Clone (same-origin localhost, no CSP → 1-call send):** load the capture code
  (`eval(await fetch('/browser-capture.js').then(r=>r.text()))` works on localhost — no
  strict CSP there; copy `browser-capture.js` into the clone's served dir), set
  `pxRegion`, define `pxTargets`, then:
  ```js
  await pxSend('http://localhost:7799/clone.json')   // capture + POST, returns "ok clone.json"
  ```
- **Live:** inject `tools/browser-capture.js` **source directly** as plain text (paste
  the whole file — do NOT fetch+eval, do NOT base64/gzip it), set `pxRegion` +
  `pxTargets`. Then **prefer the direct POST from Step 0** (`pxSend('…/live.json')`).
  Only if that's blocked, stash:
  ```js
  pxStash(null, 900)   // compact capture into a hidden <textarea>; returns {bytes, chunks}
  ```
  (900-char chunks fit a typical ~1KB automation result cap; a reviewer DevTools console
  has no cap → just `copy(pxCapture())`.)

## Step 3 — read all live chunks in ONE browser_batch *(only if POST was blocked)*
Issue `pxRead(0) … pxRead(chunks-1)` as separate actions in a single `browser_batch`,
save each slice to its own file (zero-padded: `chunk-00.txt`, `chunk-01.txt`, …), then
**reassemble with the validator — never hand-concatenate** (a dropped character at a chunk
boundary silently corrupts the snapshot and only surfaces rounds later as unexplainable diffs):
```sh
node tools/reassemble.js live.json --bytes <bytes-from-pxStash> chunk-*.txt
```
It verifies the byte count against pxStash's report, JSON-parses, and checks the snapshot
shape before writing — any mismatch names the broken chunk instead of writing garbage.

## Step 4 — diff locally
```sh
node tools/pixel-diff.js live.json clone.json --visual   # "does it look identical?" exit 0 = pass
node tools/pixel-diff.js live.json clone.json            # strict: also flags structural CSS
```

## Sanity checks
- Each target's `rect.y` lands where you expect (catches a finder grabbing the same
  text elsewhere — that's why `pxRegion` exists).
- The diff warns and refuses x-comparisons if the two snapshots' widths differ.
- A `present:false` on either side is a finder failure, not a match — fix the finder.
- A **`text.present` failure** means a finder resolved a non-text *wrapper* (its own
  text node is empty), which nearly skipped `font.color`/size. Fix the finder to land
  on the text element — use `byText(/…/)` (own-text match), not a hand-rolled
  `children.length<=1` filter that can match a full-width container.
- **Read the strict table for colour/underline rows before declaring a pass.**
  `font.color`, `font.decoration`, `font.underline` are *visible* marks, not
  structure — a strict `font.color … ❌` under a green `--visual` is a real defect.

## Coverage (don't skip)
After `--visual` is green, enumerate every painted element in the region (own text,
background-image, or `<svg>`) that has **no** `pxTargets` entry, and add one. A green
diff only proves the elements you measured.

**Coverage is elements *and* the marks on them.** The gate now measures the marks that
used to slip a green sweep — `font.smoothing`, the **underline box** (`underline.*`,
taken off whichever element draws it, ancestor included), and the **painted backdrop**
(`bg` — the bar/button/badge colour behind a mark, transparent chain → white canvas) —
and `--visual` compares them, so you don't re-derive them by hand. What's still on you: **enumerate
every painted leaf** (own text / background-image / `<svg>`) so each has a target, and
for a mark the tool doesn't special-case (a `box-shadow`, an `outline`) measure the
drawing element's box with `--inspect`. Set the clone root to `antialiased` / `grayscale`.

## The fast fix loop (incremental re-verify + micro-polls)
Two tools that keep iteration at seconds/minutes instead of full-round scale:

- **Partial re-capture + merge.** After a scoped fix, don't re-capture all N targets —
  capture just the affected ones (`pxSend('<sink-url>/partial.json', subsetTargets)`) and
  fold them in: `node tools/merge-snapshot.js targets/<name>/clone.json partial.json`.
  Gates re-run instantly on the merged file. The merge stamps the snapshot and **the done
  gate refuses stamped snapshots** — one final FULL capture is always required (a fix can
  displace things outside your subset: astryx's bento-height fix moved the footer).
- **Micro-polls before full rounds.** With a responsive reviewer, ask the ~$0.05 question
  mid-round instead of spending a whole test round discovering the answer:
  `node harness/review-qa.js poll <name> "do the 3 template tiles look right now?"
  --choices "Yes,No"` (draft+original urls auto-appended; blocks up to ~5 min; answers
  recorded in review-qa.json). Polls are ADVISORY — the review gate still requires an
  approving verdict on a full scope-pinned round. Use them to decide, not to certify.

## A flagged element → exhaustive drill-down (`--inspect`)
When a reviewer says "*this* looks wrong" (not a full sweep), don't guess the property —
measure the whole element **that paints the mark** (which may be an ancestor):

1. On **both** pages resolve the flagged element and dump its full computed style:
   ```js
   copy(pxInspect({ text: "sign in" }))   // {aria}, {sel}, {at:[x,y]} also work
   ```
   (live CSP → `pxStashInspect(resolver)` + batched `pxRead`; clone → `copy()` or POST to sink.)
   **If the paint bucket is empty but the reviewer still sees it, you inspected the wrong
   element** — the mark is drawn by an ancestor/sibling (e.g. an underline that's a
   `border-bottom` on a wrapping group). Resolve that element (`{sel:".loyalty-name-part"}`)
   and measure **its box**: `top`, `height`, `box-sizing`, `border-bottom` — that box
   positions the mark.
2. Diff, paint-first:
   ```sh
   node tools/pixel-diff.js --inspect el_live.json el_clone.json
   ```
   **PAINT** = the fix list (colour, border, decoration/underline, background,
   transform, geometry…); **STRUCTURAL** demoted; irrelevant props hidden.
3. **Fix by reproducing the box model + technique, and fix the whole mark at once.**
   Rebuild the same drawing element (same `border`, `height`, `box-sizing`) so the
   mark's position/size *emerge* — don't nudge the text with a magic offset (it drifts
   and rasterises unlike a real border, failing a flicker compare even at ~0.01px). A
   decoration has thickness + width + offset + technique; set them together, or the
   reviewer iterates once per facet.
4. **Re-run step 2** — done = PAINT bucket empty (exit 0). Then flicker/overlay the two
   at 1:1 as a final check: a technique mismatch survives a green number.

## Manual shortcut (no automation)
At the keyboard: paste `pxCapture()` (or `pxInspect(resolver)`) into the real DevTools
console on each page (no CSP-on-console, no truncation, `copy()` works), save the two
files, and run Step 4 / `--inspect`. This skips injection, the sink, and chunking.
