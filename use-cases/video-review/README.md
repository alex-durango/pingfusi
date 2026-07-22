# Video review — use case #3

**What it does.** Puts a rendered video — a Remotion composition, an AI-generated
clip, any machine-made motion — in front of a real human reviewer who judges it
against the prompts that produced it. Whether the result *lands the brief* is a
judgment no gate can score; the reviewer answers it with timestamped, frame-anchored
feedback the agent acts on, render after render, until the verdict says it matches.

**Its skill:** [`review-video-with-pingfusi`](../../skill/review-video-with-pingfusi/SKILL.md),
installed from `skill/` by `pingfusi setup` / `pingfusi agent-setup`.

**Reviewer surface: a native video player with timestamped comments.** The reviewer
scrubs the video, pins comments to exact moments (every comment comes back carrying
`video_anchor.time_ms`, sorted by time), draws on the frame (normalized 0..1 frame
coordinates), answers the match questionnaire, and picks a verdict. Video rounds use
the service's FIXED verdict pair — `Matches the prompt` / `Needs another pass` —
so the round declares `approve_verdicts: ["Matches the prompt"]` locally. Authored
`steps`, `instructions`, and custom `verdict_options` are web-only: the public ping
row stays generic, and the brief, prompt history, and requirements are revealed to
the reviewer only when they claim the task.

Do **not** use `pingfusi review <name> file` for this use case. That path files
clone-fidelity rounds against an original site; a video has no original — it has a
brief. Video rounds file through `core.review.file` against a caller-owned state file.

## How the loop runs on the core API

1. **Ping.** `pingfusi ask` settles one-off judgment mid-render — two cuts, two
   pacings — with the candidate URLs in the question context. Advisory; never an
   approval.
2. **Draft.** Publish the render as a public, long-lived, SEEKABLE MP4. The service
   probes `video_url` at file time and refuses the round unless the host answers
   Range requests with `206` + `Content-Range` — no burned rounds on a dead or
   unseekable link. Use `pingfusi publish <render.mp4> --record <file> --json` by
   default; it creates the wrapper and returns the hosted `asset_url` to use as
   `video_url` (25 MB per-file cap). Only oversized renders need another
   Range-serving public file host; a live-site tunnel is not appropriate for an MP4.
3. **Review.** `core.review.file(stateFile, spec)` with `media_type: "video"`,
   `video_url`, and the full review context: `current_brief` (the one source of
   truth the video must match NOW), `prompt_history` (every prompt in authored
   order, `active`/`replaced`/`context` — superseded prompts stay in, marked, never
   silently dropped), and `requirements` (concrete checkable claims, each naming
   the `prompt_ids` it came from). The whole context caps at 250 KB. `url` and
   `draft_url` must be absent — video mode refuses them.
4. **Wait.** Arm `pingfusi wait <ping_id>` immediately. Fetch fresh with
   `core.review.verify`, act on every timestamped comment in the video's SOURCE —
   composition code, prompts, assets, never the frames — re-render, publish the new
   render at a new URL, refile. Done is `outcome.ok === true` on
   `Matches the prompt`, never a feeling.

The complete round shape and iteration rules live in the installed
[`review-video-with-pingfusi` skill](../../skill/review-video-with-pingfusi/SKILL.md).
Core's wire, caps, publish-before-review rule, and exact-verdict handling are
documented in [docs/CORE.md](../../docs/CORE.md).

## Proof status

The use case remains **coming** until one real render run has an approving human
verdict (`Matches the prompt`) and a sanitized receipt with a shipped visual. Raw
round state and reviewer comments stay internal under `targets/`; the catalog
selftest refuses an "available" label without the proof.
