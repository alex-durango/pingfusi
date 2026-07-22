# Copy Anything — use case #1

**What it does.** Produces the best machine-made first draft of any site — layout,
type, color, behavior, and animations (motion reproduction is default-on in the draft
build) — then iterates on review rounds until a human reviewer approves. The same loop also
finishes drafts built by any other tool (adopt → tunnel → review), closing the last
10% that prompting alone never lands.

**Its two skills** (referenced here, installed from `skill/` at the kit root by
`pingfusi setup` / `pingfusi agent-setup` — see the catalog's layout decision in
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
`pingfusi review <name> file` sends the round and automatically chains client-safe wait
legs, `verify` records the fresh verdict, `pingfusi wait <ping_id>` continues a pending ping, and
`pingfusi ask` settles one-off judgment
calls mid-run.

Quick starts and the full command reference live on the catalog page:
[README.md](../../README.md).
