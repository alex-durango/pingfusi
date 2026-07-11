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
   - Every phase advances only through its gate: `pingfusi advance <NAME> <phase>`. Never
     use --force. `pingfusi status <NAME>` always tells you what's next.
   - Sink + `node <KIT>/harness/tunnel.js --sink` first for one-call capture delivery.
   - All reviewer contact through `pingfusi review <NAME> …` (file/poll/verify) — never through
     any MCP directly. Refiles carry `--changelog "what changed"`.
   - No pingfusi login (doctor shows it missing)? STOP and tell the user to run
     `pingfusi setup` — review rounds require the login; there is no offline review path.
   - If anything blocks filing a round, STOP and tell the user exactly what failed —
     never invent a substitute for independent review.

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
   Done = `pingfusi gate <NAME> done` exits 0 — all ten phases, including a real
   approving verdict from the user. A first draft, green machine gates, or a filed
   round are NOT done: ending your turn before done, without being blocked on the
   reviewer, is an incomplete run — say exactly what remains and what will wake you.

6. **Report with receipts**: the final `pingfusi status <NAME>` table, gate outputs, the round
   history, and the clone's location (`targets/<NAME>/clone/`).
