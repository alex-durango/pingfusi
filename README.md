# pingfusi

<p>
  <a href="https://www.npmjs.com/package/pingfusi"><img src="https://img.shields.io/npm/v/pingfusi.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/pingfusi"><img src="https://img.shields.io/npm/dw/pingfusi.svg" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT"></a>
</p>

**pingfusi is the human review layer for AI coding agents.** Your agent publishes its
draft and files a review round; a real human reviewer looks at it the way you would
have, and sends back pinned comments on the exact elements that are wrong, plus a
verdict the agent can't argue with. The agent fixes, refiles, and repeats until a human
approves. You stop being your agent's QA department, and you see one thing: the
finished version.

### Using Claude Code, Codex, or Cursor?

> **One command teaches your agent everything:**
>
> ```sh
> npx pingfusi setup
> ```
>
> It installs the agent skills, the review login, and the motion runtime. After that,
> you just talk to your agent. It can recognize when work needs human judgment, choose
> the matching review job, and keep deterministic checks local:
>
> ```
> clone www.example.com. use pingfusi.
> ```
>
> Or simply ask it to build normally—the universal Pingfusi skill also triggers when
> the agent reaches a subjective or real-world check it cannot verify itself.

## Quickstart

Ask a human reviewer anything, from any directory:

```sh
pingfusi ask "Which tagline reads better for a developer tool?" --options "Draft first,Review everything"
```

That is the first job on the menu — **Quick question**: one human, one answer, from
any directory, advisory by contract. Every other job is the same human loop with more
structure: publish the work, file a review round, wait for the verdict, iterate until
a human approves. (The plumbing they all share is a small core API —
[docs/CORE.md](docs/CORE.md) — you only need it to build a new job, never to pick one.)

## The menu

pingfusi is a menu of jobs you hand to a real human reviewer. Your agent picks the job
that matches what it needs judged; the reviewer answers on a surface built for that
job. Definitions live in [`use-cases/`](use-cases/README.md).

| job | what a human sends back | status |
|---|---|---|
| [Quick question](use-cases/quick-question/README.md) | one answer to one question — fast, advisory, never an approval | **available** |
| [Review anything](use-cases/review-anything/README.md) | pinned comments + a verdict on whatever you publish | **available** |
| [Copy Anything](#copy-anything) | approval only when the clone truly matches, animations included | **available** |
| [Website beautification](use-cases/beautify/README.md) | element-pinned taste feedback until the page looks designed | coming |
| [Video review](use-cases/video-review/README.md) | timestamped judgment of rendered video against its brief | coming |
| [Make your own](use-cases/your-own/TEMPLATE.md) | your task, your rules, the same human loop | template |

## Copy Anything

Definition: [use-cases/copy-anything/README.md](use-cases/copy-anything/README.md)

### ❌ Without pingfusi

AI clones 90% correctly, then you burn prompt after prompt fixing the last 10%:

- ❌ layout wrong
- ❌ fonts wrong
- ❌ colors wrong
- ❌ animation wrong
- ❌ vibes wrong

### ✅ With pingfusi

Clone any website pixel-perfect through one evidence-driven iteration loop: numeric
gates prove what machines can prove, human review rounds judge the rest.

```
clone www.example.com. use pingfusi.
```

```
clone header of www.example.com. use pingfusi.
```

```
clone hero of www.example.com. use pingfusi.
```

Credits work like API usage: each completed result costs 1 credit. Every review defaults
to 1 result; request 5 for a broader read or 15–20 for complex or high-confidence work
with `--results`. You are charged only for results delivered.

<details>
<summary><b>Quick start by hand (without an agent)</b></summary>

### Clone a site

```sh
pingfusi new acme https://www.example.com/ 1728   # scaffold targets/acme/ (1728 = viewport width in px — the default; measured throughout)
pingfusi sink                                     # snapshot receiver on :7799 (separate terminal)
pingfusi serve acme                               # serve the clone + capture tools on :8080
pingfusi next acme                                # run the exact command printed; repeat after each step
```

`next` will not file the final page round early: it first routes capture, layout,
interaction, and motion through their owning gates, then directs hosting and review.

### Polish an existing draft

No pixel pipeline, just the review loop:

```sh
pingfusi adopt mydraft https://original-site.com/ 1728 # register your draft + the original it should match (1728 = viewport width in px — the default)
pingfusi publish dist --target mydraft                 # host the production build with Pingfusi
pingfusi review mydraft file                           # a human reviewer answers in minutes
```

Use `pingfusi tunnel mydraft --url http://localhost:3000` only if the app truly
requires a live server and cannot produce a self-contained build.

</details>

<details>
<summary><b>Animations</b></summary>

Animation reproduction is DEFAULT-ON in the draft build. `capture-run` records what the
live page's animations ARE into `targets/<name>/motion-doc.json` (per-track provenance:
engine declarations read verbatim, virtual-time samples, fitted models), and
`capture-build` runs the motion pass automatically: CSS/transition tiers are already
carried by the captured stylesheets (statically verified), engine/sampled tiers are
replayed as a small self-contained WAAPI player with exact parameters, ongoing motion
loops by its fitted law, and a one-owner probe keeps implementations from stacking.
Everything the pass does or refuses is a receipt (`motion-pass.json`,
`motion-items.json@2` bookkeeping, a `workflow.jsonl` line) and every problem is a
warning — the build never fails because of motion, and no gate blocks on it.
`--no-motion` skips the pass; `pingfusi motion pass <name>` re-runs it standalone.

The deep machine checks stay operator utilities, routed by `pingfusi next` from the
pass's receipts: `verify-introspected` (exact keyframe/timing diff of the page's own
engine declarations, live vs clone) and the sampled chain `sample` → `apply-sampled` →
`verify-sampled` (identical virtual-time stimulus, per-frame diff). They exit 0 or 1 —
receipts, never gates. There are no review rounds in the motion path: the side-by-side
compare round is the one reviewer channel, and the reviewer flags motion that looks
missing, different, or mistimed like any other observation.

</details>

<details>
<summary><b>Command reference</b></summary>

```
pingfusi setup                          first contact — interactive onboarding
pingfusi doctor                         read-only preflight; a fix command per miss
pingfusi where                          print the installed kit's directory
pingfusi remove                         clean uninstall (also sweeps older-generation installs)

pingfusi ask "<question>" [--options "A,B,C"] [--context "…"]
                                        one advisory question to a human reviewer, from any directory
pingfusi ask result <ping_id>           passive answer snapshot (free; does not renew)
pingfusi publish <built-dir|video.mp4>  host a self-contained site or seekable MP4
                                        (`--target`, `--record`, and `--json` available)

pingfusi new     <name> <url> [width]   scaffold a clone target
pingfusi adopt   <name> <url> [width]   register an external draft for review-only
pingfusi capture-build <name>           build the clone from the captured live DOM
pingfusi serve   <name> [port]          serve the clone + capture tools
pingfusi draft   <name> push            upload the clone as a HOSTED draft — stable public
                                        url, survives your machine sleeping (review default)
pingfusi draft   <name> status|delete   re-verify / delete the hosted draft
pingfusi tunnel  <name> [--url <dev>]   fallback for apps that truly require a live server
pingfusi sink                           snapshot receiver (:7799)
pingfusi score   <name>                 live-vs-clone score + delta vs last run
pingfusi diff    <live> <clone>         raw numeric diff (--visual | strict)
pingfusi next    <name> [--json]        route the next failure to the right utility

pingfusi motion  pass <name>            re-run the build motion pass standalone (capture-build
                                        runs it automatically; receipts + warnings, never a gate)
pingfusi motion  install                install the motion engine's deps (lazy — the core CLI runs without them)
pingfusi motion  verify-introspected …  exact live-vs-clone diff of the page's own engine declarations
pingfusi motion  sample|apply-sampled|verify-sampled …  the deterministic sampled-tier machine chain
pingfusi motion  capture|trace …        capture CSS/WAAPI or fitted JS/canvas motion
pingfusi motion  gate|export …          replay-check and export a reusable motion entry
pingfusi motion  loop|nudge|tune …      converge difficult timing/spring/easing behavior

pingfusi review  <name> file [--results 1..20]  file a scope-pinned review round (default 1)
pingfusi review  <name> poll "q"        1-result mid-round micro-check with a reviewer
pingfusi wait    <ping_id>              continue a pending ping through client-safe wait legs
pingfusi status  <name>                 phase table + next required action
pingfusi gate    <name> <phase>         run one gate read-only (exit 0/1)
pingfusi advance <name> <phase>         record a phase (gate must pass)
pingfusi ledger  <name>                 the audit trail
```

`pingfusi next <name>` is the agent-facing dispatcher. Layout evidence stays with the
pixel diff and side-by-side layout review; interaction-state evidence stays with behavior
capture; temporal evidence (timing, easing, spring, stagger, scroll/pointer-driven,
canvas, or WebGL motion) is routed to the `pingfusi motion …` machine utilities.

</details>

## How it's verified

A claim in pingfusi is a command that exits 0, never a screenshot or a promise. Every
clone walks a hard-gated pipeline (capture, pixel, coverage, strict, behavior, review),
every gate leaves a receipt, and the final `done` re-runs everything from scratch. The
enforcement contract lives in [docs/WORKFLOW.md](docs/WORKFLOW.md); the verb contracts
live in [docs/CORE.md](docs/CORE.md).

## License

MIT
