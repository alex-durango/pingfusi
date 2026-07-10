# pingfusi

**Clone websites pixel-perfect, and polish any AI-built draft, with real reviewers in the
loop.** A framework-agnostic toolkit for cloning a website's visual identity and
proving the clone is pixel-perfect with numbers, never by eye: point it at any live
site, lift the real fonts/icons/vectors, then diff your recreation against the live
DOM property-by-property until every pixel-determining value matches — then iterate
[pingfusi](https://pingfusi.com) review rounds until a reviewer approves.

The pingfusi MCP installer is built in: `pingfusi setup` runs its device-flow login,
and `pingfusi wait|whoami|rules|remove` pass straight through to it.

The guiding rule behind everything here:

> **Measure the *painted mark*, not the wrapper — and measure it *completely*.**
> A green check is a command that exits 0, not a screenshot that "looks close."

## Start here (one line, then just talk to your agent)

```sh
npx pingfusi setup
```

One interactive pass: installs `pingfusi` globally, offers `cloudflared`, runs the
pingfusi device login + MCP install (skippable — local review mode needs no account),
checks for the optional `ditto` fast builder, and teaches your AI agent both skills.
Idempotent — re-run anytime. (Prefer the pieces? `npm i -g pingfusi`, then
`pingfusi doctor` + `pingfusi agent-setup`.)

Then, in your AI agent (e.g. Claude Code with browser access):

> **"Clone https://example.com pixel-perfect."**

The agent drives the whole pipeline — capture, numeric gates, behavior reproduction,
review rounds — and you do exactly one job:

### You are the reviewer
Review pings arrive with a **side-by-side compare UI** (original vs clone). Steer by
**pinning comments** on anything that looks wrong, in your own words — "this text sits a
bit high", "these cards should animate in". **Always pick a verdict button**: comment-only
reviews stall the pipeline (approval is never inferred from prose). Your browser's
rendering of the original is the ground truth — even when it differs from what the
agent's browser sees (LEARNINGS #20). The clone is *done* only when every machine gate
is green **and** you've pressed approve.

Two review modes, same contract:
- **Remote (default)** — rounds go to the pingfusi review service and bill small credits
  (`pingfusi setup` creates the login). Independent verdicts. The reviewer opens a HOSTED
  draft (`pingfusi draft <name> push` — stable url, survives your machine sleeping); a
  public tunnel is the fallback for adopted builds on live dev servers.
- **Local (no account, no tunnel, free)** — only when no login exists or you explicitly
  ask for it (agents can't downgrade a remote round to local on their own; the tool
  refuses): `pingfusi review <name> file --local`, then open
  `http://localhost:8080/__review`: the clone with click-to-pin, the same step list, the
  same mandatory verdict buttons. Recorded as `provider:"local"` in every receipt —
  operator-trusted by definition, so it's never mistaken for independent review.

Prerequisites doctor checks for you: Node ≥ 18 (required), plus `cloudflared` and the
pingfusi login (remote mode only — local mode needs neither) — and your agent
needs browser automation.

### Already have a draft? "Fix it with pingfusi."

Any clone that isn't quite right — a [ditto](https://github.com/ion-design/ditto.site)
build, a Lovable/v0 export, something hand-written. Builders produce **starting points
(~90% by their own framing)**; the review loop is the last 9. Open your agent
inside the draft project and say:

> **"Fix it with pingfusi."** (or "polish this clone", "make it match the original")

The agent runs your dev server, registers the draft, publishes it, and iterates reviewer
review rounds — fixing pins in *your project's own source* — until a reviewer approves.
Under the hood (builder-agnostic, no pixel gates):

```sh
pingfusi adopt mysite https://example.com          # register the external build
pingfusi tunnel mysite --url http://localhost:3000 # publish its dev server (reachability-verified)
pingfusi review mysite file                         # round 1 — then fix pins, refile with --changelog
```

Agents get this as the **fix-with-pingfusi** skill (installed by `pingfusi agent-setup`).

<details>
<summary>Driving it by hand / developing the kit (the manual quickstart)</summary>

Run `pingfusi` in any project — your clone `targets/` are created in the current directory;
the kit's tools/docs come from the installed package (`pingfusi where` prints their location).

```sh
pingfusi new aloyoga https://www.aloyoga.com/ 1728   # scaffold a target + seed the workflow
pingfusi sink &                                       # snapshot receiver (:7799)
# on the live tab: await pxSendDom('http://localhost:7799/dom.html')   ← capture the DOM
pingfusi capture-build aloyoga                        # DEFAULT build: clone FROM the capture (LEARNINGS #19)
pingfusi serve aloyoga                                # serve the clone + the kit's /tools (:8080)
# …measure live, capture the clone… (see PLAYBOOK.md + tools/RUNBOOK.md)
pingfusi score aloyoga                                # is this iteration better? (a number, not a vibe)
pingfusi status aloyoga                               # the enforced workflow: what's done / next / gated
```

The workflow is **enforced** (see `WORKFLOW.md`): `pingfusi advance <name> <phase>` refuses to mark a
phase done unless its gate exits 0, and refuses out of order — so nothing claims "pixel-perfect"
without the receipts. `pingfusi help` lists every command. Handing the run to an agent yourself?
`LAUNCH-PROMPT.md` is the canonical wrapper (the skill uses the same path).

</details>

## What's in the box

```
pixel-perfect-kit/
├── README.md          ← you are here — what it is, quickstart, tool index
├── PLAYBOOK.md        ← the method: how to clone + verify, step by step
├── WORKFLOW.md        ← the ENFORCED pipeline: hard-gated phases (the kit's `gjc`)
├── LEARNINGS.md       ← the failure catalog — read before trusting any "match"
├── DEVELOP.md         ← the META-LOOP: improve the kit by cloning real sites
├── CLONE-ANY-SITE.md        ← the ONE-SHOT template: whole page, capture-built, gated,
│                              reviewer-approved — hand it to an agent and wait
├── CLONE-ANY-HEADER.md      ← ready-to-run prompt template ({{URL}}/{{WIDTH}}/{{OUTPUT_PATH}})
├── CLONE-ALOYOGA-HEADER.md  ← the same prompt, pre-filled for aloyoga.com (example)
├── tools/
│   ├── extract-fonts.js   paste in DevTools → one zip of the real @font-face woff2s
│   ├── extract-icons.js   paste in DevTools → one zip of the real SVG/data-URI icons
│   ├── pixel-diff.js      the measure + numeric-diff engine (browser capture + Node diff)
│   ├── browser-capture.js the browser half of pixel-diff.js, split out to inject as
│   │                      PLAIN SOURCE on a strict-CSP live site (no base64/gzip)
│   ├── behavior-capture.js the browser half of the `behavior` phase: discovers + MEASURES
│   │                      JS-driven dynamics (reveals, marquees, rotations, hover menus)
│   │                      on live and clone, so reproduction is judged by number — and
│   │                      keeps declared-but-unfired candidates as inventory (no-js /
│   │                      bot-gated sites where nothing fires but everything should)
│   ├── behavior-worksheet.js one row per supposed-to-move behavior with its disposition;
│   │                      unresolved rows print ready-to-send questions for the reviewer
│   ├── sink.js            tiny POST→file receiver for delivering the clone snapshot
│   ├── merge-snapshot.js  fold a PARTIAL re-capture into a full snapshot (fast fix-loop
│   │                      iteration; the done gate demands one final full capture)
│   ├── selftest.js        guards the diff engine — asserts it still compares the
│   │                      underline box + font-smoothing (run: node tools/selftest.js)
│   └── RUNBOOK.md         the fast, verified command sequence for a live-vs-clone diff
├── bin/pingfusi            shim for the enforced workflow (→ harness/workflow.js)
├── harness/           the dev framework (see DEVELOP.md)
│   ├── new-target.js  scaffold a disposable clone workspace for a URL (+ seed the workflow)
│   ├── capture-build.js  the DEFAULT build step: clone FROM the captured live DOM —
│   │                  self-hosts CSS/fonts, strips scripts/CSP, preserves the doctype
│   │                  byte-for-byte (kills the technique-mismatch class, LEARNINGS #19)
│   ├── review-qa.js    the REVIEW phase: files a scope-pinned side-by-side round and
│   │                  gates on the fetched verdict — review iteration rounds, unattended
│   ├── draft.js       HOSTED draft (the review default): uploads clone/ to the service,
│   │                  integrity-verified + byte-verified before it's recorded — the url
│   │                  keeps serving even when this machine sleeps
│   ├── tunnel.js      public HTTPS tunnel, byte-VERIFIED to serve the clone before it's
│   │                  recorded (fallback draft; a dead tunnel burns a review round)
│   ├── workflow.js    the ENFORCED phase state machine — gates block until a check exits 0
│   ├── serve.js       static server for a target's clone (+ /tools)
│   ├── score.js       score live-vs-clone, compare to the previous run
│   ├── regression.js  selftest + workflow-selftest + every fixture + detection battery — the guardrail
│   ├── fixtures/      one file per class-of-miss, so it can never recur
│   └── benchmarks/    detection-power battery — score a gate change old-vs-new
│                      (node harness/benchmarks/detection-power.js --vs HEAD)
└── targets/           ← DISPOSABLE per-site instances; the kit is the product
```

**Developing the kit itself** (cloning sites to make the tools + instructions better) —
see **`DEVELOP.md`**. In short: `node harness/new-target.js <name> <url> <width>`, build
the clone, `node harness/score.js <name>` to loop, and turn every miss the gate didn't
catch into a tool check + a `harness/fixtures/` regression + a generalized lesson.

Zero dependencies. The extractors and the browser half of `pixel-diff.js` run by
pasting into a DevTools console (or via a browser-automation `javascript_tool`);
the diff half runs in Node (`node tools/pixel-diff.js …`), so pass/fail is
reproducible and CI-gateable.

**What the numeric gate measures** (so a green `--visual` is trustworthy): geometry,
the text-glyph box via `Range`, the painted glyph + `background-position` for
icons/logos, the full box-model, font metrics **including `line-height`,
`letter-spacing`, `color`, `-webkit-font-smoothing`, the underline as a *box***
(thickness / width / offset, measured on whichever element — often an ancestor —
draws it), **and the painted *backdrop*** (`bg` — the bar/button/badge colour behind
a mark, so a wrong announcement-bar colour can't pass a green sweep). Perceived-weight and underline-geometry misses that used to slip a green
sweep now fail on the first run; `node tools/selftest.js` locks that in. What the gate
can't do — reproduce the *drawing technique* so a mark also rasterises identically —
stays with you (see `PLAYBOOK.md` Phase 6 and `LEARNINGS.md` "the gate vs your eyes").

## The two verification modes (this is the whole point)

1. **Full-page regression sweep** — a curated `pxTargets` list (logo, each nav item,
   each icon…). Capture both pages, diff, require an all-green `--visual` table, then
   **close coverage**: every painted element in the region must have a target.
   ```sh
   node tools/pixel-diff.js live.json clone.json --visual   # exit 0 = looks identical
   node tools/pixel-diff.js live.json clone.json            # strict: also flags structure
   ```

2. **Flagged-element drill-down** — someone says *"this looks wrong here."* Resolve
   that one element and diff its **entire computed style** live-vs-clone, so **every**
   real difference surfaces (a border, a shadow, a `text-decoration`, a background)
   without adding a per-property rule. Paint differences first, structure demoted.
   ```sh
   node tools/pixel-diff.js --inspect el_live.json el_clone.json  # exit 0 = 0 paint diffs
   ```
   This is the detection→**measure**→fix→verify loop. Detection is the reviewer;
   everything after is measured, and "fixed" means the paint bucket is empty.

## Quickstart

1. **Extract assets.** On the live site's DevTools console:
   `extractFonts(/yourfont/i)` and `extractIcons('header')` → two zips → unpack into
   your project's `assets/`. (See tool sections in `PLAYBOOK.md`.)
2. **Build your recreation** in whatever stack you like, driven by measurements — not
   guesses. Load the real woff2s; use the real icon data-URIs; match the measured
   type tokens.
3. **Verify.** Start your clone dev server + `node tools/sink.js`. Follow
   `tools/RUNBOOK.md` to capture both pages at the **same viewport width** and diff.
   Loop `--visual` until it exits 0 **and** coverage is empty.
4. **When a reviewer spots something off**, run the `--inspect` loop on that element
   until its paint bucket is empty.

Start with **PLAYBOOK.md** for the full method, and read **LEARNINGS.md** first —
every rule in it was paid for by a real miss.
