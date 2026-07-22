---
name: pixel-perfect-clone
description: Clone, copy, or replicate a website/page pixel-perfect using pingfusi. Use when the user asks to clone a site or page with pingfusi, copy a webpage's design, replicate a page, or make a pixel-perfect copy of a URL. Drives the full enforced pipeline - capture, numeric gates, behavior reproduction, and review rounds answered by an independent reviewer on the pingfusi service - iterating until that reviewer approves.
---

# Clone a site pixel-perfect (pingfusi)

The pixel-perfect-kit is an enforced, receipt-driven pipeline: a phase is done because
its gate command exits 0, never because anyone says so. Your job is to drive it end to
end; review rounds are answered by an INDEPENDENT human reviewer on the pingfusi service —
not by the user, and never by you.

## Steps

1. **Preflight.** Run `pingfusi doctor`. If anything required fails, show the user the fix
   lines and stop until resolved. Run `pingfusi where` → KIT (the installed kit's directory;
   all docs below live there).

2. **Get the three values.** URL (ask if not given). WIDTH: default 1728 (the kit's own
   default — omit the argument) unless the user specifies; a width must be a positive
   number of pixels (`pingfusi new` refuses anything else). NAME: a short slug from the
   domain (e.g. `stripe` for stripe.com). Targets
   are created under the CURRENT working directory (`targets/<NAME>/`) — cd to the user's
   preferred workspace first.

3. **Follow the kit's own instructions exactly.** Read KIT/docs/LAUNCH-PROMPT.md (the run
   contract + environment notes) and KIT/docs/CLONE-ANY-SITE.md (the method), and execute them
   with the three values. They override any assumption you have. Key expectations:
   - Build by CAPTURE (`pingfusi capture-build`), never hand-reconstruction.
   - **Settle the page before capturing the DOM, and CHECK that it settled.**
     `await pxScrollSettle()` returns `{stable, …}` — **`stable:false` means STOP, do not
     capture**: the page was still mounting content and the DOM is one that never existed.
     Reaching the bottom is not being settled; a late-hydrating section is missing from the
     capture, so it is missing from the leaf enumeration, so *every gate goes green over a page
     with a hole in it*. After building, `clone-lint` must exit 0 — it FAILs an empty mount
     point, a frozen reveal, and the automation extension's own overlay DOM if it was captured.
   - Every phase advances only through its gate: `pingfusi advance <NAME> <phase>`. Never
     use --force. `pingfusi status <NAME>` always tells you what's next.
   - Capture: `pingfusi capture-run <NAME>` FIRST (the default) — settle + measure + DOM
     + coverage in a kit-owned INVISIBLE Chrome; artifacts land in targets/<NAME>/ directly,
     no sink, no tabs in anyone's browser, and the settle polling happens in-page instead of
     through your round-trips. `--side auto` does live until the clone exists, then both.
     FALL BACK to the interactive path only when capture-run says so (bot wall, no Chrome,
     probe refusal — its errors name the fallback): `pingfusi capture open <NAME>` (hosted
     session), ONE call per tab — `await pxCaptureAllPhased('<sink_url>')` on live,
     `{prefix:'clone'}` on the clone — then `pingfusi capture pull <NAME> --all`.
     (Phased = settle → freeze animation phase → measure: both sides must measure at a
     FIXED animation phase or never-settling animations fail gates on a correct clone.)
     Drafts are hosted too: `pingfusi draft <NAME> push`. No cloudflared needed.
   - Behavior discovery needs `document.hidden === false`. If your browser tooling reports
     tabs hidden PERMANENTLY (some automation stacks do), skip in-tab discovery — it can
     never pass the gate, and `--force` poisons `done`. Run
     `pingfusi behavior-capture <NAME>` instead (kit-owned Chrome, both sides, probe-gated;
     name marquees/hovers in `targets/<NAME>/behavior-opts.json`).
   - **Route by measured capability, not by which command you remember.** Run
     `pingfusi next <NAME>` when a gate is red or the next utility is unclear. Static
     geometry/paint stays with pixel diff and layout compare; mounted/triggered state stays
     with behavior capture. Timing, easing, springs, stagger, scroll/pointer-driven motion,
     canvas, and WebGL use the printed `pingfusi motion …` machine command; the
     side-by-side compare round is the one reviewer channel for anything visual, motion
     included.
   - Animations are DEFAULT-ON in the draft build (first-draft doctrine): capture-run
     records the live page's animations into `motion-doc.json`, and capture-build runs
     the motion pass automatically — captured CSS carries the css/transition tiers,
     gsap/waapi/sampled tiers get the generated WAAPI player (exact parameters), and
     every action or skip is a receipt (`motion-pass.json` + `motion-items.json`) with
     warnings, never failures. Re-run it standalone with `pingfusi motion pass <NAME>`
     (e.g. after a re-capture, or on a hand-built clone). Motion never blocks a gate and
     never files a review round. Never put temporal evidence in
     `behavior-deviations.json` — that file is for unsupported non-temporal
     interaction/state rows.
   - For a difficult animation, follow `pingfusi next <NAME>`: it routes the deep
     machine checks from the pass's bookkeeping — `pingfusi motion verify-introspected`
     (exact keyframe/timing diff of the page's own engine declarations, live vs clone),
     or the sampled chain `motion sample` → `motion apply-sampled` →
     `motion verify-sampled` (identical virtual-time stimulus, per-frame diff, ongoing
     motion verified by its motion law). These are commands that exit 0 or 1 — receipts,
     not gates, and no review round exists in the motion path. Scroll/pointer-linked and
     canvas/WebGL models stay engine machinery (`motion trace/loop/export`), receipted
     and never auto-applied by the pass.
   - Reviewers flag motion in the page round like any other observation (there is no
     structured temporal probe and no typed motion round): if a note says an animation
     is missing, different, or mistimed, fix it through the routed motion utilities
     (`pingfusi next <NAME>` prints the exact command), redeploy, refile.
   - **A blocked gate is a ladder, not a stop.** When a gate refuses, its message names the
     way out — try THAT first (hidden tabs → `behavior-capture` above). If a reviewer's one
     look could unstick you, that's `pingfusi assist <NAME>`. Only when the provided remedies
     are genuinely exhausted (an environment constraint you cannot fix from here): receipt it
     with `pingfusi advance <NAME> <phase> --blocked "what you tried and why it failed"`, then
     KEEP GOING — file the round; the spec documents the gap to the reviewer automatically. A
     blocked phase is not done (`done` refuses it until re-advanced with a passing gate), but
     a filed round with a named gap ships a fix list; a stopped session ships nothing.
     Motion never blocks this ladder — its receipts are informational.
   - All reviewer contact through `pingfusi review <NAME> …` (file/poll/verify) — never through
     any MCP directly. First filings carry `--context "one line: what this site/page is and
     where to look"` (the reviewer sees it); refiles carry `--changelog "what changed"`.
     Full rounds default to 1 result. Request `--results 5` for a broader read and
     `--results 15` to `--results 20` only for complex work or higher confidence. Each
     completed result costs 1 credit; undelivered results are not charged.
   - No pingfusi login (doctor shows it missing)? STOP and tell the user to run
     `pingfusi setup` — review rounds require the login; there is no offline review path.
   - If the SERVICE side blocks filing a round (login, filing errors), STOP and tell the
     user exactly what failed — never invent a substitute for independent review. A red or
     environment-blocked GATE is not that case: it has the ladder above.

4. **Tell the user how review works** (first run especially): each round goes to an
   independent reviewer on the pingfusi service — NOT to the user. The reviewer opens
   the hosted draft and the original side by side, pins comments on what looks wrong,
   and picks a verdict; the reviewer's browser rendering of the original is the ground
   truth (the reference site may serve them a different variant than yours —
   LEARNINGS #20). The user's job is simply to wait; their taste enters through the
   result and through any change requests they give you directly.

5. **Iterate until done.** The filing command owns the wait: keep that one command
   alive from send through feedback and do not launch a separate `pingfusi wait` task.
   It renews the short idle lease across server-wait legs until feedback, expiry, or
   caller interruption; passive result/verify reads do not renew it. Act on every verdict
   immediately: fix from the site's own captured artifacts (authored mechanisms, never
   invented values), re-green the gates, and refile with a changelog; that filing owns
   the next wait too.
   **When `pingfusi score` or `pingfusi status` prints STALLED, do not run another blind
   iteration**: run `pingfusi next <NAME>` first. If it reports layout, run
   `pingfusi assist <NAME> --compare` — a scoped side-by-side diagnostic round
   auto-composed from the failing gate's own artifacts; a reviewer names in one look what
   costs you three iterations. `--compare` is required: the old text-only question format
   is retired (a reviewer can't act on an element question without seeing both pages), and
   bare `pingfusi assist <NAME>` refuses with exactly this nudge. It reuses the target's
   recorded hosted draft after re-verifying it — you only re-push if the draft went stale.
   Assists don't block you: keep iterating while one is pending and re-check the answer
   (free) with the printed assist-result command between iterations. Never open a second
   ask while one is pending.
   Done = `pingfusi gate <NAME> done` exits 0 — all ten phases, including a real
   approving verdict from the reviewer. A first draft, green machine gates, or a filed
   round are NOT done: ending your turn before done, without being blocked on the
   reviewer, is an incomplete run — say exactly what remains and what will wake you.

6. **Report with receipts**: the final `pingfusi status <NAME>` table, gate outputs, the round
   history, and the clone's location (`targets/<NAME>/clone/`).
