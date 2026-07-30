---
name: review-video-with-pingfusi
description: Have any video reviewed by a real human, through iterative pingfusi review rounds. Use when asked to "review this video", "check the rendered video", "does this video match the prompt/brief", "what do people think of this ad/trailer/demo", or after rendering a Remotion composition or AI-generated clip that no test can judge. Works with or without a brief behind the video, and you author the questions and the verdict wording. Do not use for web pages (use fix-with-pingfusi or beautify-with-pingfusi) or for pixel-matching a site (use pixel-perfect-clone).
---

# Review a video with pingfusi

A machine can render a video; it cannot tell you whether the result lands. This
skill puts the video in front of a real human reviewer who scrubs it, pins comments
to exact timestamps, draws on frames, answers your questions, and returns a verdict
— then you fix the source, re-render, and refile until it passes.

Two shapes, one tool. Matching your own render against a brief you wrote is the
iteration loop it was built for. But the brief is optional: point it at any video
and ask your own questions when there is no prompt behind it to match.

## Non-negotiables

- Publish before review. The reviewer is remote: `video_url` must be a public,
  long-lived MP4 whose host answers Range requests with `206` + `Content-Range`
  (the service probes it at file time and refuses the round otherwise). A new
  render is a new URL — never mutate the bytes behind a URL a round already cites.
- The brief must be honest, when there is one. `current_brief` is what the video
  must match NOW. Superseded prompts go into `prompt_history` marked `replaced` —
  never silently dropped; the reviewer resolves conflicts by state, not guesswork.
  `requirements` are concrete, checkable claims, each naming the `prompt_ids` it
  came from. All three are OPTIONAL: a video you did not generate from prompts you
  control — a competitor's ad, a tutorial, a clip someone sent you — has no brief,
  and you say what to judge with `video_intro` and `steps` instead.
- Everything except `title` is private until claim. `steps`, `verdict_options`,
  `video_headline`, `video_intro`, the brief, the history and the requirements all
  travel in a payload delivered to exactly one reviewer when they take the job, so
  a question may quote the brief it belongs to. `title` is the opposite: it is the
  PUBLIC headline on the row every reviewer sees while browsing, before anyone
  claims. Put nothing in it you would not publish.
- Ask what you actually want to know. Omit `steps` and `verdict_options` and you
  get the generic prompt-match questionnaire with `Matches the prompt` /
  `Needs another pass`, which is right for a render-against-brief loop and wrong
  for almost everything else. A round asking "would you keep watching past five
  seconds?" tells you something the generic pair cannot.
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

   Matching a render against a brief you wrote — the iteration loop:

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

   Judging any other video — no brief, your own questions:

   ```js
   const { ping_id } = await core.review.file(stateFile, {
     media_type: "video",
     video_url,
     title: "Launch video, third cut",          // PUBLIC — on the browsing row
     video_headline: "Does this ad land?",      // private, top of the reviewer's panel
     video_intro:
       "Watch it once at full speed, then scrub back to anything that made you hesitate.",
     steps: [                                    // private; your questions
       { text: "Would you keep watching past the first five seconds?", options: ["Yes", "No"] },
       { text: "What is this selling, in your words?" },
     ],
     verdict_options: ["Ready to run", "Needs another cut"],   // private
     n_target: 3,
     approve_verdicts: ["Ready to run"],
   });
   ```

   Mix them freely: keep `requirements` without a `prompt_history` when you want
   timestamped notes linked to specific claims, or send a `current_brief` with your
   own `steps`. The one rule is that the reviewer must have something to answer —
   a brief, requirements, steps, or an intro. `url` and `draft_url` must be absent;
   video mode refuses them.
5. The filing command automatically chains client-safe wait legs until feedback. If a
   raw MCP leg returns pending, immediately call `pingfusi_wait` again; never return
   pending to the user or file a duplicate. Each leg renews the short idle lease;
   passive result/verify reads do not. When results land, read the
   envelope: comments arrive sorted by `video_anchor.time_ms`, drawn annotations
   in normalized frame coordinates (0 = left/top, 1 = right/bottom), questionnaire
   answers attached to their questions. Fix every noted moment in the source,
   re-render, publish the NEW file under a new receipt/URL, and refile with the same context — update
   `current_brief`/`requirements` only if the user's ask actually changed.
6. Repeat until `core.review.verify(stateFile)` returns `ok === true` on your
   declared approving verdict — `Matches the prompt` by default, or whichever of
   your own `verdict_options` you named in `approve_verdicts`. Record the receipt;
   stop only on approval or when the user says stop.
