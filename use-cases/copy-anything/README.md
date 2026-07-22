
## Copy Anything

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
<summary><b>How the agent runs it</b></summary>

**Its two skills** (installed from `skill/` at the kit root by `pingfusi setup` /
`pingfusi agent-setup` — see the catalog's layout decision in
[../README.md](../README.md)):

- [`pixel-perfect-clone`](../../skill/pixel-perfect-clone/SKILL.md) — the full
  enforced pipeline: capture the live page, pass the numeric gates, reproduce
  behavior, file review rounds, iterate until an approving verdict.
- [`fix-with-pingfusi`](../../skill/fix-with-pingfusi/SKILL.md) — the review loop
  alone, for an existing draft from any builder (ditto, lovable, v0, hand-written).

**Reviewer surface: the compare view.** Every round lands as a side-by-side compare —
the reviewer opens the hosted draft and the original next to each other, pins
comments (drawn/sticky annotations anchored to elements), and picks a verdict from
the round's declared list. It is the one reviewer channel for anything visual, motion
included; `pingfusi assist <name> --compare` files the scoped diagnostic form of it
when a gate stalls.

**The core API underneath** ([docs/CORE.md](../../docs/CORE.md)):
`pingfusi draft <name> push` hosts the clone as a byte-verified public page,
`pingfusi review <name> file` sends the round and automatically chains client-safe
wait legs, `verify` records the fresh verdict, `pingfusi wait <ping_id>` continues a
pending ping, and `pingfusi ask` settles one-off judgment calls mid-run.

</details>
