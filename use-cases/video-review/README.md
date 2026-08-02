# Video review — use case #3

**What it does.** Puts a rendered video — a Remotion composition, an AI-generated
clip, any machine-made motion — in front of a real human reviewer who judges it
against the prompts that produced it. Whether the result *lands the brief* is a
judgment no gate can score; the reviewer answers it with timestamped, frame-anchored
feedback the agent acts on, render after render, until the verdict says it matches.

**Just prompt your agent:**

```txt
Render the intro animation, then have a human check it matches the brief with pingfusi.
```

The agent publishes the render, a human reviewer scrubs it and pins comments to exact
timestamps, and the agent re-renders until the reviewer says it matches. Everything
below is the machinery the agent uses.

**Its skill:** [`review-video-with-pingfusi`](../../skill/review-video-with-pingfusi/SKILL.md),
installed from `skill/` by `pingfusi setup` / `pingfusi agent-setup`.

**Reviewer surface: a native video player with timestamped comments.** The reviewer
scrubs the video, pins comments to exact moments (every comment comes back carrying
`video_anchor.time_ms`, sorted by time), draws on the frame (normalized 0..1 frame
coordinates), answers the questionnaire, and picks a verdict.

Author the questionnaire and the verdict wording with `steps` and
`verdict_options`, exactly as in a web round; omit them and the round falls back to
the generic prompt-match pair `Matches the prompt` / `Needs another pass`, with
`approve_verdicts: ["Matches the prompt"]` declared locally. Everything except
`title` is private: `steps`, `verdict_options`, `video_headline`, `video_intro`,
the brief, the prompt history and the requirements are all revealed only to the one
reviewer who claims the task, so a question is free to quote the brief it belongs
to. `title` is the public headline on the browsing row — write it accordingly.

`current_brief`, `prompt_history` and `requirements` are optional. Reviewing your
own render against a brief you wrote is the loop this was built for, but any video
works: point it at an ad, a trailer, a competitor's demo, and use `video_intro`
plus your own `steps` to say what you want judged. The one rule is that the
reviewer must have something to answer — a brief, requirements, steps, or an intro.

Do **not** use `pingfusi review <name> file` for this use case. That path files
clone-fidelity rounds against an original site; a video has no original — it has a
brief. Video rounds file through `core.review.file` against a caller-owned state file.

## How the loop runs on the core API

1. **Ping.** `pingfusi ask` settles one-off judgment mid-render — but only for calls
   expressible in words (title wording, a VO script line, which brief requirement to
   prioritize). A ping is text-only: the reviewer cannot open a URL in the question, so
   "which cut is better?" is never a ping — publish each cut and file a review round
   per cut (a video round carries exactly one MP4; to compare in one round,
   concatenate the cuts into a single MP4 first). Advisory; never an approval.
2. **Draft.** Publish the render as a public, long-lived, SEEKABLE MP4. The service
   probes `video_url` at file time and refuses the round unless the host answers
   Range requests with `206` + `Content-Range` — no burned rounds on a dead or
   unseekable link. Use `pingfusi publish <render.mp4> --record <file> --json` by
   default; it creates the wrapper and returns the hosted `asset_url` to use as
   `video_url` (25 MB per-file cap). Only oversized renders need another
   Range-serving public file host; a live-site tunnel is not appropriate for an MP4.
3. **Review.** `core.review.file(stateFile, spec)` with `media_type: "video"`,
   `video_url`, and whatever context the reviewer needs. For a render you own that
   is `current_brief` (the one source of truth the video must match NOW),
   `prompt_history` (every prompt in authored order, `active`/`replaced`/`context`
   — superseded prompts stay in, marked, never silently dropped), and
   `requirements` (concrete checkable claims, each naming the `prompt_ids` it came
   from). For a video you did not generate, skip all three and send `video_intro`
   plus `steps` instead. Add `steps` and `verdict_options` whenever the generic
   prompt-match pair is not the question you actually have. The whole context caps
   at 250 KB. `url` and `draft_url` must be absent — video mode refuses them.
4. **Wait.** Filing automatically chains client-safe wait legs until feedback. If a raw
   MCP leg returns pending, immediately call `pingfusi_wait` again and never return
   pending to the user. Passive result/verify reads do not renew the lease. Then fetch fresh with `core.review.verify`, act
   on every timestamped comment in the video's SOURCE —
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
