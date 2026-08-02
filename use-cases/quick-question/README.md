# Quick question — ask a human one thing

**What it does.** One question to a real human reviewer, from any directory, with no
workspace and nothing to publish. Options make it tappable; the answer often arrives
inside the call. This is the job an agent reaches for twenty times a day: mid-task
judgment calls that would otherwise be guesses.

**Just prompt your agent:**

```txt
Which name sounds better for a coffee shop app: BeanThere or SipHappens? use pingfusi
```

The agent files the question, a human answers, and the answer lands back in the
agent's context.

**Or by hand, from the CLI:**

```sh
pingfusi ask "Which tagline reads better for a developer tool?" \
    --options "Draft first,Review everything" --context "two candidates for the launch page"
```

The ask command automatically chains client-safe wait legs until an answer arrives or
the caller cancels; the user never has to request a separate wait.

**The one rule: advisory, never an approval.** A quick question buys an answer — it
satisfies no gate, approves no work, and never substitutes for a review round with a
verdict. When the ask is "is this DONE?", that is the [Review anything](../review-anything/README.md)
job (or a specialized one), not a quick question.

**The other rule: text-only.** The reviewer receives ONLY the question string and the
tappable options — no URL opens, no image renders, no page loads. A question about
anything a reviewer would need to SEE (a page, design, build, or video) is not a quick
question: publish it (`pingfusi publish`) and file [Review anything](../review-anything/README.md)
or the specialized job instead, however small the question.

**When to use it**

- Two candidates, one judgment — when both fit in the question text: taglines, names,
  copy angles, error-message wording, pricing-tier labels.
- A gut-check a machine can't score and words can carry: "which of these two intros
  reads clearer?", "is $12/mo a believable price for this?"
- NOT: two hero crops, color directions, or "does this feel premium?" about a page —
  the reviewer can't see them. Publish the variants and file a review round.
- Anywhere in ANY job's loop — for questions answerable from the text alone; mid-loop
  questions about how the draft LOOKS go through the loop's own review or compare
  channel.

**Reviewer surface: the generic card.** The question, optional tappable options, and a
notes field. No custom UI, no publishing step, no verdict machinery — that is what
keeps it fast. "No publishing step" also means the reviewer sees nothing but your
words: a question that needs eyes on the work is a review, not a quick question.

**Where it lives.** CLI: `pingfusi ask` (state in `~/.pingfusi/asks/<ping_id>.json`).
API: `core.ping` / `core.pingResult` ([docs/CORE.md](../../docs/CORE.md)). `core.ping`
automatically chains the wait; `core.pingResult` is only a passive snapshot. Answers cap at
1 result; each delivered answer costs 1 credit.

**Its routing skill:** [`pingfusi-review`](../../skill/pingfusi-review/SKILL.md), which
teaches the agent that this job is advisory and selects it proactively for one human-only
judgment call even when the user did not name Pingfusi.
