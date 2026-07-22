# Review anything — a verdict on whatever you publish

**What it does.** The general-purpose review round: publish an artifact at a public
URL, tell a real human reviewer what to check, and get back structured feedback — per
step answers, pinned comments, and a verdict from a list you declared. Iterate until
the verdict is an approval. Every specialized job on the menu is this loop with a
tailored reviewer surface; this row is the loop itself, for everything that doesn't
have a specialized surface yet.

**When to use it**

- The artifact is a web page, doc, or build that none of the specialized jobs cover.
- You are prototyping a NEW kind of review — run it generic first, specialize after
  it proves out ([Make your own](../your-own/TEMPLATE.md) is the packaging step).
- The work needs a real DONE/NOT-DONE from someone who isn't its author.

**The contract** (the doctrine every job inherits — details in [docs/CORE.md](../../docs/CORE.md)):

1. **Publish before review.** A reviewer is remote: host self-contained websites and
   MP4s with `pingfusi publish`; use a verified tunnel only for an app that genuinely
   requires a live server. An unviewable draft burns the round.
2. **File structured asks, not prose.** Steps a reviewer can act on (≤20 steps,
   ≤300 chars each), inline options for judgment questions (≤40 chars each), and a
   verdict list where the approving verdict is unmistakable.
3. **Verdict-required.** The round passes only on an approving verdict from its own
   declared list — prose that merely sounds approving never passes.
4. **Wait, fix, refile.** The filing command owns the wait from send through feedback;
   do not call `pingfusi wait` separately. It renews the short idle lease while waiting,
   while passive result/verify reads do not. Act on every comment in the artifact's
   own source, refile, repeat. Done is a recorded verdict, never a feeling.

**How to run it.** `core.review.file(stateFile, spec)` (send + wait) →
`core.review.verify(stateFile)`, against a state file you own — no target workspace
needed. The installed generic review skill drives this loop for coding agents; the
worked example in [Make your own](../your-own/TEMPLATE.md) is a complete recipe.

**Reviewer surface: the generic round.** A question, steps with tappable options,
pinned/drawn comments, and a verdict — answered with no custom UI work. That is
exactly why it is the day-one surface for every new job.
