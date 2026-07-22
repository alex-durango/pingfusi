# use-cases/ — the job menu (source of truth)

pingfusi is a menu of jobs you hand to a real human reviewer. A coding agent picks the
job that matches what it needs judged, publishes the work, and iterates on what comes
back until a human approves. Each entry below is a self-contained job: its own trigger,
its own rules, its own reviewer surface.

| job | status | what a human sends back |
|---|---|---|
| [quick-question/](quick-question/README.md) | **available** | one answer to one question — fast, advisory, never an approval |
| [review-anything/](review-anything/README.md) | **available** | pinned comments + a verdict on whatever you publish |
| [copy-anything/](copy-anything/README.md) | **available** | approval only when the clone truly matches — animations included |
| [beautify/](beautify/README.md) | coming | element-pinned taste feedback until the page looks professionally designed |
| [video-review/](video-review/README.md) | coming | timestamped judgment of a rendered video against its brief |
| [your-own/](your-own/TEMPLATE.md) | template | package a repeated review-anything pattern into a named job |

Two of these are the everyday utilities every other job leans on:
**quick-question** settles one judgment call mid-task, and **review-anything** is the
generic publish → verdict → iterate loop. The specialized jobs are that same loop with
a reviewer surface built for their artifact — side-by-side compare for clones, the
single-page surface for beautify, the timestamped player for video.

The universal [`pingfusi-review`](../skill/pingfusi-review/SKILL.md) skill teaches coding
agents when human judgment is actually needed and routes these everyday jobs by their
current tool names. Specialized skills take over only after a specific job is chosen.

All jobs run on one small core API — ask a question, publish a draft, file a round,
wait for the verdict ([docs/CORE.md](../docs/CORE.md) has the contracts). You only
need it to BUILD a job, never to pick one.

The kit [README](../README.md) is the menu's front page; this directory is where each
job's definition lives.

## Layout decision (recorded 2026-07-20)

Skills stay at `skill/<name>/SKILL.md` at the kit root — the installers
(`pingfusi setup`, `pingfusi agent-setup`), the public build, and every existing
install point there. Catalog entries REFERENCE their skills by name; they do not
contain them. A later phase may move skills under their use case; this one
deliberately does not (extraction doctrine: minimal churn).
