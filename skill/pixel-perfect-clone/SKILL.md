---
name: pixel-perfect-clone
description: Clone, copy, or replicate a website/page pixel-perfect using pingfusi. Use when the user asks to clone a site or page with pingfusi, copy a webpage's design, replicate a page, or make a pixel-perfect copy of a URL. Drives the full enforced pipeline - capture, numeric gates, behavior reproduction, and review rounds answered by an independent reviewer on the pingfusi service - iterating until that reviewer approves.
---

# Clone a site pixel-perfect (pingfusi)

The pixel-perfect-kit is an enforced, receipt-driven pipeline: a phase is done because
its gate command exits 0, never because anyone says so. Your job is to drive it end to
end; review rounds are answered by an INDEPENDENT reviewer on the pingfusi service —
not by the user, and never by you.

## Steps

1. **Preflight.** Run `pingfusi doctor`. If anything required fails, show the user the fix
   lines and stop until resolved. Run `pingfusi where` → KIT (the installed kit's directory;
   all docs below live there).

2. **Get the three values.** URL (ask if not given). WIDTH: default 1512 unless the user
   specifies. NAME: a short slug from the domain (e.g. `stripe` for stripe.com). Targets
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
     session), ONE call per tab — `await pxCaptureAll('<sink_url>')` on live,
     `{prefix:'clone'}` on the clone — then `pingfusi capture pull <NAME> --all`.
     Drafts are hosted too: `pingfusi draft <NAME> push`. No cloudflared needed.
   - Behavior discovery needs `document.hidden === false`. If your browser tooling reports
     tabs hidden PERMANENTLY (some automation stacks do), skip in-tab discovery — it can
     never pass the gate, and `--force` poisons `done`. Run
     `pingfusi behavior-capture <NAME>` instead (kit-owned Chrome, both sides, probe-gated;
     name marquees/hovers in `targets/<NAME>/behavior-opts.json`).
   - **A blocked gate is a ladder, not a stop.** When a gate refuses, its message names the
     way out — try THAT first (hidden tabs → `behavior-capture` above). If a reviewer's one
     look could unstick you, that's `pingfusi assist <NAME>`. Only when the provided remedies
     are genuinely exhausted (an environment constraint you cannot fix from here): receipt it
     with `pingfusi advance <NAME> <phase> --blocked "what you tried and why it failed"`, then
     KEEP GOING — file the round; the spec documents the gap to the reviewer automatically. A
     blocked phase is not done (`done` refuses it until re-advanced with a passing gate), but
     a filed round with a named gap ships a fix list; a stopped session ships nothing.
   - All reviewer contact through `pingfusi review <NAME> …` (file/poll/verify) — never through
     any MCP directly. First filings carry `--context "one line: what this site/page is and
     where to look"` (the reviewer sees it); refiles carry `--changelog "what changed"`.
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

5. **Iterate until done — and never park without a waiter.** The single most common way
   a run dies is HERE: the agent files a round, ends its turn "waiting", and nothing
   wakes it when the verdict lands — the user sees a first draft and then silence.
   So: immediately after FILING any round, start `pingfusi wait <ping_id>` as a
   BACKGROUND task, before anything else — its exit is what wakes you to act. If your
   environment can't run background tasks that re-invoke you, say so and tell the user
   plainly: "answer the ping, then tell me to continue." Act on every verdict
   immediately: fix from the site's own captured artifacts (authored mechanisms, never
   invented values), re-green the gates, refile with a changelog, re-arm the waiter.
   **When `pingfusi score` or `pingfusi status` prints STALLED, do not run another blind
   iteration**: run `pingfusi assist <NAME>` — a ~$0.05 poll auto-composed from the failing
   gate's own artifacts; a reviewer names in one look what costs you three iterations. If
   the question is inherently two-sided, `pingfusi assist <NAME> --compare` files a scoped
   diagnostic round instead (full credit, slower — poll first). Assists don't block you:
   keep iterating while one is pending and re-check the answer (free) with the printed
   poll-result/assist-result command between iterations. Never open a second ask while
   one is pending.
   Done = `pingfusi gate <NAME> done` exits 0 — all ten phases, including a real
   approving verdict from the reviewer. A first draft, green machine gates, or a filed
   round are NOT done: ending your turn before done, without being blocked on the
   reviewer, is an incomplete run — say exactly what remains and what will wake you.

6. **Report with receipts**: the final `pingfusi status <NAME>` table, gate outputs, the round
   history, and the clone's location (`targets/<NAME>/clone/`).
