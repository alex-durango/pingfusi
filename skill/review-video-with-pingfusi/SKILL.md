---
name: review-video-with-pingfusi
description: Have a rendered video reviewed by a real human against the prompts that produced it, through iterative pingfusi review rounds. Use when asked to "review this video", "check the rendered video", "does this video match the prompt/brief", or after rendering a Remotion composition or AI-generated clip that no test can judge. Do not use for web pages (use fix-with-pingfusi or beautify-with-pingfusi) or for pixel-matching a site (use pixel-perfect-clone).
---

# Review a video with pingfusi

A machine can render a video; it cannot tell you whether the result lands the brief.
This skill puts the render in front of a real human reviewer who scrubs it, pins
comments to exact timestamps, draws on frames, and returns a verdict — then you fix
the source, re-render, and refile until the verdict is `Matches the prompt`.

## Non-negotiables

- Publish before review. The reviewer is remote: `video_url` must be a public,
  long-lived MP4 whose host answers Range requests with `206` + `Content-Range`
  (the service probes it at file time and refuses the round otherwise). A new
  render is a new URL — never mutate the bytes behind a URL a round already cites.
- The brief must be honest. `current_brief` is what the video must match NOW.
  Superseded prompts go into `prompt_history` marked `replaced` — never silently
  dropped; the reviewer resolves conflicts by state, not guesswork. `requirements`
  are concrete, checkable claims, each naming the `prompt_ids` it came from.
- Video rounds have a fixed public shape. The service supplies the questionnaire
  and the verdict pair `Matches the prompt` / `Needs another pass`; authored
  `steps`, `instructions`, and `verdict_options` are web-only. The richness goes
  into the brief, history, and requirements, which the reviewer sees on claim.
- Act on feedback in the SOURCE. A timestamped comment means a fix in the
  composition code, the prompt, or the asset that produced that moment — never a
  hand-patched frame or a trimmed clip to dodge the note.
- Never approve your own render, and never infer approval from prose. Done is a
  fresh `core.review.verify(stateFile)` returning `ok === true` on the declared
  verdict.

## Workflow

1. Run `pingfusi doctor`. If the review login is missing, stop and have the user
   run `pingfusi setup`; there is no offline substitute for a human verdict.
2. Assemble the review context before rendering anything final: every prompt in
   authored order (`active` / `replaced` / `context`), the distilled
   `current_brief`, and `requirements` with prompt provenance. The complete
   context caps at 250 KB.
3. Render the MP4 and publish it through Pingfusi hosting by default:

   ```sh
   pingfusi publish <render.mp4> --name <name>-round-1 \
     --record .pingfusi/video/<name>/round-1.json --json
   ```

   The command creates the player wrapper, uploads immutable bytes, and returns a direct
   `asset_url`; use that value as `video_url`. Pingfusi serves it with `206` and
   `Content-Range`, so the native player can scrub. The current hosted-video cap is 25 MB
   per render. If a render cannot fit after reasonable encoding, use another long-lived
   public host that serves Range requests; do not introduce a live-site tunnel for a file.
4. File the round against a caller-owned state file:

   ```js
   const core = require("pingfusi/packages/core");
   const { ping_id } = await core.review.file(stateFile, {
     media_type: "video",
     video_url,
     current_brief,
     prompt_history,  // [{ id, text, state: "active"|"replaced"|"context", replaced_by? }]
     requirements,    // [{ id, text, prompt_ids }]
     n_target: 1,
     approve_verdicts: ["Matches the prompt"], // local bookkeeping, stripped before the wire
   });
   ```

   `url` and `draft_url` must be absent — video mode refuses them.
5. The filing command automatically chains client-safe wait legs until feedback. If a
   raw MCP leg returns pending, immediately call `pingfusi_wait` again; never return
   pending to the user or file a duplicate. Each leg renews the short idle lease;
   passive result/verify reads do not. When results land, read the
   envelope: comments arrive sorted by `video_anchor.time_ms`, drawn annotations
   in normalized frame coordinates (0 = left/top, 1 = right/bottom), questionnaire
   answers attached to their questions. Fix every noted moment in the source,
   re-render, publish the NEW file under a new receipt/URL, and refile with the same context — update
   `current_brief`/`requirements` only if the user's ask actually changed.
6. Repeat until `core.review.verify(stateFile)` returns `ok === true` on
   `Matches the prompt`. Record the receipt; stop only on approval or when the
   user says stop.
