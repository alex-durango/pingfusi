# Quick question — ask a human one thing

**What it does.** One question to a real human reviewer, from any directory, with no
workspace and nothing to publish. Options make it tappable; the answer often arrives
inside the call. This is the job an agent reaches for twenty times a day: mid-task
judgment calls that would otherwise be guesses.

```sh
pingfusi ask "Which tagline reads better for a developer tool?" \
    --options "Draft first,Review everything" --context "two candidates for the launch page"
pingfusi ask result <ping_id>   # collect later, free
```

**The one rule: advisory, never an approval.** A quick question buys an answer — it
satisfies no gate, approves no work, and never substitutes for a review round with a
verdict. When the ask is "is this DONE?", that is the [Review anything](../review-anything/README.md)
job (or a specialized one), not a quick question.

**When to use it**

- Two candidates, one judgment: taglines, type directions, color moods, hero crops.
- A gut-check a machine can't score: "is this copy clear?", "does this feel premium?"
- Anywhere in ANY job's loop: mid-clone, mid-beautify, mid-render — one credit,
  one answer, keep moving.

**Reviewer surface: the generic card.** The question, optional tappable options, and a
notes field. No custom UI, no publishing step, no verdict machinery — that is what
keeps it fast.

**Where it lives.** CLI: `pingfusi ask` (state in `~/.pingfusi/asks/<ping_id>.json`).
API: `core.ping` / `core.pingResult` ([docs/CORE.md](../../docs/CORE.md)). Answers cap
at 1 result; each delivered answer costs 1 credit.
