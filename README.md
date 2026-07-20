# pingfusi

### ❌ Without pingfusi

AI clones 90% correctly — then you burn prompt after prompt fixing the last 10%:

- ❌ layout wrong
- ❌ fonts wrong
- ❌ colors wrong
- ❌ animation wrong
- ❌ vibes wrong

### ✅ With pingfusi

Clone any website pixel-perfect through one evidence-driven iteration loop.

## Installation

```sh
npx pingfusi setup        # one interactive command: install, motion runtime, review login, agent skills
```

## Prompts

```
clone www.example.com. use pingfusi.
```

```
clone header of www.example.com. use pingfusi.
```

```
clone hero of www.example.com. use pingfusi.
```

## Quick start — clone a site

```sh
pingfusi new acme https://www.example.com/ 1512   # scaffold targets/acme/ (1512 = viewport width in px, measured throughout)
pingfusi sink                                     # snapshot receiver on :7799 (separate terminal)
pingfusi serve acme                               # serve the clone + capture tools on :8080
pingfusi next acme                                # run the exact command printed; repeat after each step
```

`next` will not file the final page round early: it first routes capture, layout,
interaction, and motion through their owning gates, then directs hosting and review.

## Quick start — polish an existing draft

No pixel pipeline, just the review loop:

```sh
pingfusi adopt mydraft https://original-site.com/ 1512 # register your draft + the original it should match (1512 = viewport width in px)
pingfusi tunnel mydraft --url http://localhost:3000    # tunnel your own dev server
pingfusi review mydraft file                           # reviewer answers in minutes
```

Credits work like API usage: each completed result costs 1 credit. Quick checks target
1 result, standard review rounds default to 5, and complex or high-confidence work can
target 15–20 with `--results`. You are charged only for results delivered.

## Command reference

```
pingfusi setup                          first contact — interactive onboarding
pingfusi doctor                         read-only preflight; a fix command per miss
pingfusi where                          print the installed kit's directory
pingfusi remove                         clean uninstall (also sweeps older-generation installs)

pingfusi new     <name> <url> [width]   scaffold a clone target
pingfusi adopt   <name> <url> [width]   register an external draft for review-only
pingfusi capture-build <name>           build the clone from the captured live DOM
pingfusi serve   <name> [port]          serve the clone + capture tools
pingfusi draft   <name> push            upload the clone as a HOSTED draft — stable public
                                        url, survives your machine sleeping (review default)
pingfusi draft   <name> status|delete   re-verify / delete the hosted draft
pingfusi tunnel  <name> [--url <dev>]   verified public HTTPS tunnel (adopted dev servers)
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

pingfusi review  <name> file [--results 1..20]  file a scope-pinned review round (default 5)
pingfusi review  <name> poll "q"        1-result mid-round micro-check with a reviewer
pingfusi wait    <ping_id>              block until a review round resolves (wake-on-verdict)
pingfusi status  <name>                 phase table + next required action
pingfusi gate    <name> <phase>         run one gate read-only (exit 0/1)
pingfusi advance <name> <phase>         record a phase (gate must pass)
pingfusi ledger  <name>                 the audit trail
```

`pingfusi next <name>` is the agent-facing dispatcher. Layout evidence stays with the
pixel diff and side-by-side layout review; interaction-state evidence stays with behavior
capture; temporal evidence (timing, easing, spring, stagger, scroll/pointer-driven,
canvas, or WebGL motion) is routed to the `pingfusi motion …` machine utilities.

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

## License

MIT
