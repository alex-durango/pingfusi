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

> **Capture invisibly first: `pingfusi capture-run <name>`.** It runs THIS ENTIRE section
> (settle → enumerate → measure → DOM → coverage) in a kit-owned headless Chrome —
> probe-gated, viewport-normalized (width AND height AND dpr; a headless tab otherwise
> renders dpr 1 with a short viewport, a genuinely different page), artifacts written
> directly to `targets/<name>/`, zero tabs in anyone's browser, zero settle-polling
> round-trips (the loop runs in-page on unthrottled timers). `--side auto` captures live
> until a clone exists, then both. The steps below are the INTERACTIVE FALLBACK — reach
> for them only when capture-run's error names them (bot wall, no Chrome, probe refusal):
> your agent-driven tab rides a real logged-in session, which is the one thing a launched
> profile cannot fake.

1. Inject `tools/browser-capture.js` as plain source on the live tab (same rules as
   measurement — never fetch+eval), then let the page **settle mechanically** — do not
   hand-scroll and hope:
   ```js
   await pxScrollSettle()   // → {scrolledTo, frozenOpacity0, stable, sweeps, heights, imagesPending, lazyPromoted, lazyPromotedSrcs, pendingImageSrcs}
   ```
   It walks the full page **scrolling instantly** (a plain `scrollTo(0, y)` obeys the page's own
   `scroll-behavior: smooth` and becomes an rAF animation that never lands in a background tab —
   the sweep then visits nothing while the height sits perfectly still; locked by
   `harness/fixtures/34-settle-instant-scroll.js`), firing IntersectionObservers + lazy loaders;
   then it **waits for the document height to HOLD STILL**, re-sweeping if it grew, waits for every
   rendered image to finish loading, and returns to top. The load-bearing fields:

   - **`stable: false` ⇒ STOP. Do not capture.** Either the page was still growing (read `heights`
     and find out what is still mounting), or an image is still in flight (read `imagesPending` /
     `pendingImageSrcs`). Either way the DOM you take now is a page that never existed.
   - `imagesPending > 0` ⇒ a rendered `<img>` has not landed. An unloaded image is a **zero-width
     box** that reflows its row when it arrives, so live.json would record a layout no user ever
     sees — and the gate would then blame the *clone* for the difference (chrono24's footer QR
     shifted two app-store badges 90px). Locked by `harness/fixtures/32-settle-image-readiness.js`.
     A genuine 404 is `complete:true` and does **not** block: its zero box is the site's real
     rendering, and the clone must reproduce it.
   - `lazyPromoted > 0` ⇒ the settle **intervened**: that many `loading="lazy"` images were still
     in flight after the wait bound and were promoted to eager so they could load at all (a
     zero-width lazy image never intersects, so its loader never fires — mindmarket's logo belt
     deadlocked every capture this way; LEARNINGS #34). `lazyPromotedSrcs` names them. The
     `loading` attribute is restored after the bytes land, so dom.html ships byte-identical —
     but if a promoted src is content a visitor must *click* to reveal, exclude it deliberately.
     Locked by `harness/fixtures/39-lazy-image-promotion.js`.
   - `frozenOpacity0 > 0` ⇒ some scroll-reveals still haven't fired — inspect them first.

   *Reaching the bottom is not the same as being settled* — a section that hydrates a beat after
   the walk passes it is missing from the capture, hence from the leaf enumeration, hence from
   every gate (LEARNINGS #19; locked by `harness/fixtures/30-scroll-settle-stability.js`). And
   *height holding still is not the same as the page being ready* — nothing is mounting, but the
   images may still be arriving.
   **The tool checks this; your job is to believe it and not capture anyway.**
2. **Or do steps 1–2 (and the measurement capture) as ONE call** — with a hosted
   session open (Step 0), on the live tab:
   ```js
   await pxCaptureAll('<sink_url>')                    // settle → enumerate → live.json + coverage.json + dom.html
   ```
   and later on the clone tab: `await pxCaptureAll('<sink_url>', {prefix:'clone'})`.
   READ the returned report before advancing: `aborted:"settle-not-stable"` means the
   page never settled and NOTHING was captured (the one-call path enforces step 1's
   STOP contract — drop to the granular steps and inspect settle.heights /
   settle.imagesPending); `ok:false`/non-empty `failed` means a
   delivery didn't land; `settle.frozenOpacity0 > 0` means reveals never fired;
   `leaves`/`byKind` should be plausible for the page (a media-heavy page with
   byKind.media of 0 is under-enumeration). Then `pingfusi capture pull <name> --all`.
   Prefer this path; the granular steps here and in Step 2/3 below remain for sites
   that need manual intervention. Delivering the DOM by hand instead:
   ```js
   await pxSendDom('<sink_url>/dom.html')   // hosted session (Step 0) — or
   await pxSendDom('http://localhost:7799/dom.html')   // local sink, when localhost works
   ```
   CSP-blocked POST → `pxStash(null, 900, pxDomHtml())` + batched `pxRead` (Step 3 below).
   Big page (> ~500 KB DOM) or a 409 from the sink → `pxSaveDom('dom.html')` (Step 0).

   **The automation's own DOM is not the site's DOM** (LEARNINGS #24): the extension driving the
   capture paints overlay nodes into the page it is measuring. `pxDomHtml()` strips them and
   discovery ignores them — but only in a CURRENT `browser-capture.js`. You inject this file as
   plain source, so *the copy you pasted is the code that runs*: **re-paste after pulling**, or
   `clone-lint` will FAIL the build with `agent-dom`.
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

> **If your tabs are PERMANENTLY hidden, do not run discovery in them.** Some
> browser-automation stacks report `document.hidden === true` for every tab, always —
> fresh tabs, reconnects, foreground attempts — and the gate refuses every capture such a
> tab can produce (rightly: the compositor there is frozen; a moving marquee samples as
> 0 px/s). The way out is the kit-owned Chrome runner:
> ```sh
> pingfusi behavior-capture <name>     # both sides, probe-gated, writes behaviors-*.json directly
> ```
> It injects THIS SAME `behavior-capture.js` into a Chrome it launches with throttling
> disabled (or attaches to with `--attach <port>`), PROVES the compositor is advancing
> with a measured probe before any capture, records repeated startup style changes from
> before navigation (so an 800ms rAF effect survives the settle delay), and returns snapshots by value over CDP — no
> sink, no CSP dance. Name marquees/hovers once in `targets/<name>/behavior-opts.json`
> (string selectors — the same opts go to both sides mechanically). Steps 1/3 below stay
> the interactive path for a tab you can genuinely foreground.
>
> **It is invisible by default**: headless=new launch, probe-gated per run — no window, no
> focus steal, safe while the user keeps working. A window appears ONLY on explicit
> `--headful`, and the probe-refusal error tells you when that's actually needed. It never
> attaches to a browser it didn't launch unless you pass `--attach` — popping tabs into the
> user's own Chrome is an interruption, and concurrent runs in one window would fight over
> the single visible tab. Ports are collision-free by construction (the debug port and the
> clone server are both OS-assigned per run — concurrent clones of different sites can't
> cross-serve each other here).

1. **On the LIVE tab:** inject `tools/behavior-capture.js`, set `pxRegion`, name what you
   can see moving — `opts = { marqueeSelectors: [["logo_belt", ".belt-wrapper"]],
   hoverTriggers: [["nav_product", "nav a[href*=product]"]] }` — then
   `await pxBehaviorSend('http://localhost:7799/behaviors-live.json', opts)`. The pass
   greps `@keyframes` + markers for candidates, then confirms and MEASURES what actually
   fires across a scripted scroll sweep. A candidate that never fires stays in declared
   inventory until it is measured or explicitly dispositioned; its own sweep metadata is
   recorded — that's the gate's evidence discovery ran.
2. **Reproduce** each inventoried behavior in one vanilla `clone/fixes.js` (each in its own
   guarded `try`), using the MEASURED values. Rebuild: `pingfusi capture-build <name> --fixes`.
3. **On the CLONE tab:** same discovery, same opts → `behaviors-clone.json`.
4. Run `pingfusi next <name>`. Motion is DEFAULT-ON in the draft build (first-draft
   doctrine): the build motion pass already reproduced what the capture recorded in
   `motion-doc.json` (capture-run folds in introspected/GSAP declarations AND
   auto-samples unexplained ongoing movers found by its scroll-depth detect sweep —
   receipt: `targets/<name>/motion/auto-sample.json`), and its bookkeeping
   (`motion-items.json@2`) plus temporal
   candidates surface here as informational warnings with a routed machine check
   (`motion verify-introspected` / `motion sample` → `apply-sampled` →
   `verify-sampled`) — never gate failures, never review rounds. Temporal evidence
   never goes in `behavior-deviations.json`; that file is only an honest disposition
   for unsupported non-temporal interaction/state rows.
5. `node harness/workflow.js gate <name> behavior` — misses are named with exact deltas;
   motion receipts ride along as informational lines and never fail the gate.
6. **The worksheet — the complete "supposed to move" list.** Discovery keeps
   declared-but-unfired candidates (markers, keyframes, transitions-from-hidden, videos)
   as `declared` inventory instead of discarding them — critical on sites that gate their
   choreography behind no-js/bot detection, where NOTHING fires for automation but
   everything is still supposed to. `pingfusi behavior-worksheet <name>` prints one
   row per behavior (observed + declared) with its disposition; every UNRESOLVED row gets
   a ready-to-send one-sided poll question so the reviewer describes what live does before
   you engineer anything. Each behavior having an identity up front is what prevents two
   real behaviors merging into one invented hybrid — the gate refuses undisposed declared
   rows for the same reason.

## Step 0 — open the delivery path (do this before anything else)
> **The hosted session is the default, but it is NOT universal — PROBE IT.** A site with a
> strict `connect-src` blocks a POST to the service's origin exactly as it blocks localhost.
> Measured on lelabofragrances.com (2026-07-12): `fetch('https://pingfusi.com/…', {method:'POST'})`
> → **`TypeError: Failed to fetch` in 285ms**. Note the signature — a **CSP-blocked cross-origin
> POST fails FAST (~300ms)**, while a blackholed **localhost** POST **hangs the full 45s**. Same
> outcome, different tell. When the hosted origin is blocked too, drop to the relay at the bottom
> of this section; do not burn a session assuming "hosted works from any page."

**Default: a hosted capture session** — one-call, integrity-verified delivery from any
page whose CSP permits the service origin; no tunnels, no downloads, unlimited calls:
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

### The POPUP RELAY — when the page can reach NO sink (CSP blocks every origin)
Paid for on lelabo, where all three normal paths were shut at once: localhost **hung 45s**
(connect-src), the hosted origin **failed fast** (same), and downloads gave exactly **one save
per tab** (#21) before Chrome blocked the origin outright — including a download behind a real
trusted click.

**`postMessage` is not governed by CSP.** So relay through a window on an origin you already
control (your clone server, `harness/serve.js`), and let THAT page do the POST:

1. serve a tiny receiver page from the clone origin (`clone/__recv.html`) that listens for
   `message`, then `fetch`es the payload into the sink (`http://localhost:7799/<file>?bytes=…&sha256=…`);
2. on the live page, `const w = window.open('http://localhost:8080/__recv.html')` **from a real
   click handler** (a popup opened without user activation is blocked), then
   `w.postMessage({name, body}, '*')` on an interval until it acknowledges.

It carries the full payload byte-exactly (a 616 KB `{dom, live, paths}` bundle went through
whole), and it works **inbound** too: have the popup `fetch` the kit's real tool source from
`/tools/…` and `postMessage` it back for the live page to `eval` — that way the artifact is
produced by the kit's ACTUAL code, never a hand transcription.

**Delete the receiver before the draft is pushed** — anything left in `clone/` ships to the
reviewer. And note the relay depends on OS focus (below), which makes it the last resort, not a
default.

### The window is part of the instrument (three stalls on lelabo)
- **A minimized / fullscreen-on-another-Space window reports `document.hidden === true`.** Chrome
  then throttles its timers and does not advance CSS transitions, so a behavior discovery run
  either never finishes or returns frame-noise. The behavior gate REFUSES such a capture
  (`discovery.documentHidden`) and is right to — but you can waste an hour before noticing.
  **Check `document.hidden === false` before any behavior capture**, and never trust a number
  measured in a hidden tab. And know the terminal form: some automation stacks report hidden
  PERMANENTLY (verified 2026-07-12/13 — every tab, after real clicks, after screenshots, with
  the compositor genuinely suspended). That is not a window to fix; it is an environment to
  replace — `pingfusi behavior-capture <name>` (above) measures both sides in a kit-owned
  Chrome and refuses ITS OWN tab too unless a probe shows the compositor advancing.
- **Trusted clicks and ⌘C stop landing when Chrome is not the frontmost app.** The popup relay,
  the download-behind-a-click path, and the clipboard path all die silently that way.
- **`resize_window` is a no-op on a macOS-fullscreen window** — `innerWidth` stays at the screen
  width and `(width: 1440px)` never matches. If you need an exact viewport, take the window out
  of fullscreen FIRST; otherwise you will measure at the wrong width, and `target.json` will be
  a lying receipt (the `measure` gate catches the mismatch, but only after you have done the work).

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
- **Micro-polls before full rounds.** With a responsive reviewer, ask a 1-result question
  (up to 1 credit)
  mid-round instead of spending a whole test round discovering the answer:
  `node harness/review-qa.js poll <name> "do the 3 template tiles look right now?"
  --choices "Yes,No"` (draft+original urls auto-appended; blocks up to ~5 min; answers
  recorded in review-qa.json). Polls are ADVISORY — the review gate still requires an
  approving verdict on a full scope-pinned round. Use them to decide, not to certify.
- **Stalled? The kit composes the poll for you.** When `score`/`status` print STALLED
  (3 iterations with no progress on one gate), run `pingfusi assist <name>` — it picks the
  worst failing mark from the gate's own artifacts and files the one-sided question a
  reviewer can answer in one look. `--compare` files a scoped side-by-side diagnostic
  round instead (5 results by default — poll first; never satisfies the review gate). One open
  assist per target; re-check answers free with the printed poll-result/assist-result
  command between iterations.

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
