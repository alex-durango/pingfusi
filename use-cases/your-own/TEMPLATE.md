# Make your own job (TEMPLATE)

A job is a rules-file your agent follows: it names a judgment a machine cannot
verify, and pins it to the core API ([docs/CORE.md](../../docs/CORE.md) has the
contracts). Start by running it as [Review anything](../review-anything/README.md)
rounds; when the same pattern repeats, copy this file, fill the four sections, and
put the result where your agent reads rules — a skill, a project rules file, a
repo doc.

## The core API

| verb | face | contract |
|---|---|---|
| ping | `pingfusi ask "<question>" [--options "A,B"] [--context "…"]` | one reviewer, one answer — advisory by doctrine, never an approval |
| review | `pingfusi review <name> file` / `verify` (clone-shaped targets) or `core.review.file/verify` (any caller, own state file) | a full round: steps, pinned comments, a mandatory verdict from the round's declared list |
| draft | `pingfusi draft <name> push` or `core.draft.push(dir)` | a hosted public page, byte-verified before any round may cite it |
| wait | `pingfusi wait <ping_id>` | blocks until the round resolves — arm it immediately after filing |

**Day-one reviewer surface: the generic round.** A question, optional tappable
options, pinned comments, and a verdict — that is what a human reviewer answers for every
new use case, with no custom UI work. A specialized surface (like Copy Anything's
side-by-side compare view) is a later investment, not a prerequisite.

## The four sections every use case defines

1. **When to ping** — the moment in the agent's work where a judgment call appears
   and one advisory answer (1 credit) beats guessing.
2. **What to publish** — the reviewable artifact, and how it becomes a public
   byte-verified URL (hosted draft for static bundles, tunnel for dev servers).
   Publish-before-review is a contract: a reviewer is remote.
3. **What steps and verdicts to file** — concrete steps a reviewer can act on
   (options for judgment questions, selectors for actions), and a verdict list where
   the approving verdict is unmistakable.
4. **How to wait and act** — arm the waiter right after filing, act on every comment
   in the draft's own source, refile with a changelog, repeat until an approving
   verdict is recorded. Done is a recorded verdict, never a feeling.

---

## Worked example: "launch-copy review"

The rules below are a complete use case an agent can follow verbatim.

> **Use case: launch-copy review.** After drafting launch copy (a landing page, a
> launch post rendered as a page), never ship on self-assessment — put the draft in
> front of a reviewer and act on the verdict.
>
> **When to ping.** While drafting, settle micro-choices with one advisory question:
>
> ```sh
> pingfusi ask "Which headline reads better for a developer-tool launch?" \
>     --options "Draft first,Review everything" --context "landing page hero"
> pingfusi ask result <ping_id>        # collect later, free
> ```
>
> **What to publish.** The draft page itself. Register a review-only target once,
> then host the static bundle (index.html at its root):
>
> ```sh
> pingfusi adopt launch-copy https://your-product.example/
> cp -R dist/. targets/launch-copy/clone/      # your rendered draft page
> pingfusi draft launch-copy push              # hosted, byte-verified public URL
> ```
>
> (A live dev server publishes with `pingfusi tunnel launch-copy --url
> http://localhost:3000` instead.)
>
> **What steps and verdicts to file.** A generic round with judgment-shaped steps and
> a binary verdict list, filed through the core review verb against a state file this
> use case owns:
>
> ```js
> const core = require("pingfusi/packages/core");
> const draft = JSON.parse(require("fs").readFileSync("targets/launch-copy/draft.json", "utf8"));
> const { ping_id } = await core.review.file("launch-copy-review.json", {
>   url: draft.url,
>   instructions: "You are reading the launch page for a developer tool. Judge the copy, not the code.",
>   steps: [
>     { text: "Read the hero. Do you know what the product does?", options: ["Clear", "Vague"], check: null },
>     { text: "Read the rest. Pin a comment on anything confusing or overclaiming.", check: null },
>     { text: "Verdict.", options: ["Ship it", "Needs changes"], check: null },
>   ],
>   n_target: 3,
>   verdict_options: ["Ship it", "Needs changes"],
>   approve_verdicts: ["Ship it"],
> });
> ```
>
> **How to wait and act.** Immediately after filing, arm the waiter as a background
> task; when it exits, verify fresh (a cached approval is never trusted), fix what
> the comments pin in the draft's own source, re-push, refile with a changelog:
>
> ```sh
> pingfusi wait <ping_id>
> ```
>
> ```js
> const outcome = await core.review.verify("launch-copy-review.json");
> // outcome = { ok, status, verdict, round, comments } — ok:true only on "Ship it"
> ```
>
> Done = `outcome.ok === true` with the approving verdict recorded in
> `launch-copy-review.json`. Anything else: act on `outcome.comments`, re-push the
> draft, file the next round.

---

Whole-page cloning follows these same four sections — see
[../copy-anything/README.md](../copy-anything/README.md) for the packaged version
with its specialized compare-view surface.
