---
name: pingfusi-review
description: Use Pingfusi proactively whenever a coding agent reaches a question it cannot settle with code, automated tests, documentation or search, or a local browser and needs real human judgment or real-world verification. Trigger even when the user does not mention Pingfusi for subjective choices about copy, design, clarity, or taste; rendered UI or animation quality; real-device behavior; inaccessible third-party effects such as OAuth, emails, or payments; or an independent approval verdict on published work. Route by what the reviewer must see: text-only judgments to the quick question; websites, builds, and artifacts to a website review against a published URL; clone comparisons and video reviews to their matching Pingfusi utilities. Do not use for objective questions the agent can verify directly. Specialized Pingfusi clone, beautify, and video skills take precedence when their explicit workflow applies.
---

# Route human judgment through Pingfusi

Use Pingfusi as the real-human verification layer inside an agent's normal work. Ask a
reviewer only for the part that requires perception, judgment, a real device, or external
reach. Keep deterministic verification in code, tests, documentation or search, and the
local browser.

## Choose the job

Use the smallest job whose reviewer can actually see the subject:

| Need | Use |
|---|---|
| One subjective answer, fully expressible in text, with nothing to look at | MCP `pingfusi_quick_question`, or shell `pingfusi ask` |
| Verdict and pinned feedback on a website, build, document, or other artifact the reviewer must see — publish it first | MCP `pingfusi_review_website` |
| Clone compared side by side with its original (the reviewer opens both) | Managed clone CLI when present; otherwise MCP `pingfusi_compare_clone` |
| Rendered video judged against its current brief and prompt history (the reviewer watches the MP4) | MCP `pingfusi_review_video` |

A quick question is advisory. Never use it to declare work finished. Work that needs a
real DONE/NOT-DONE decision requires a review round with an explicit verdict.

A quick question is also blind: the reviewer receives only the question text and options —
no URL opens, no image renders, and a pasted link is dead text on their device. The moment
there is anything to look at (a page, build, design, or draft), publish it and file a
review round instead, however small or subjective the question. A reviewer cannot act on a
question about something they cannot see.

Use one reviewer by default. Increase the reviewer count only when the user asks for
broader confidence or the decision's risk clearly justifies the extra cost.

## Respect specialized workflows

When `targets/<name>/workflow.json` exists, run `pingfusi next <name>` and follow the
managed clone workflow. Do not call raw review MCP tools for that target because they
bypass its gates. Use the specialized installed skills for pixel-perfect cloning,
repairing an existing clone, beautifying a website, and reviewing a video whenever one
of those explicit jobs applies.

For a generic review outside a managed target:

1. Publish the current artifact at a publicly reachable URL. Prefer `pingfusi publish`
   for a self-contained build or file. Use a tunnel only when the real app requires a
   live server. A remote reviewer cannot open localhost.
2. File focused, actionable steps. Attach deterministic checks where possible and
   short options to judgment questions. Declare an unmistakable approving verdict.
3. Act on every result in the artifact's own source, publish the new version, and file a
   new round. Stop only after an approving verdict or when the user cancels.

## Keep pending work alive

Filing begins the wait automatically. The CLI and core library hide the continuation
loop. When using raw MCP tools, if filing or a later leg returns `pending`, immediately
call `pingfusi_wait` with the same ping ID and repeat while it remains pending. This is
one review, not a new request.

Never report `pending` as a timeout, ask the user to retry, or resend the original ping.
Passive result tools (`pingfusi_quick_question_results` and
`pingfusi_review_results`) are snapshots and do not keep an idle review alive.
A lapsed lease only pulls the round from the feed for new claims — a reviewer
already mid-review can still finish, and their result is still charged.

## Handle feedback honestly

Treat reviewer comments, drawings, timestamps, step answers, and verdicts as structured
input. Do not infer approval from friendly prose, approve your own work, or ignore an
unresolved comment. A completed quick question informs the next decision; a completed
review round must still satisfy its declared approval verdict.
