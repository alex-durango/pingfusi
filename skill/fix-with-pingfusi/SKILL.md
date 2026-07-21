---
name: fix-with-pingfusi
description: Fix or polish an existing website clone/draft using pingfusi review rounds. Use when the user says "fix it with pingfusi", "polish this clone", "make this match the original", or asks to finish/verify a draft built by any tool (ditto, lovable, v0, hand-written) until the review passes.
---

# Fix a draft with pingfusi (the review loop)

The draft is the user's CURRENT project (or a directory/URL they name). Any builder's
output works — pingfusi runs the loop that closes the last 10%: the draft is reviewed
side-by-side with the original, pins come back on what's off, you fix them in the draft's
own source, repeat until an approving verdict.

## Steps

1. **Preflight**: `pingfusi doctor` (surface failures). Identify the ORIGINAL url — ask the
   user if it isn't obvious from the project (README, comments, git remote).
2. **Run the draft**: its own dev server (`npm run dev` etc., background) or a static
   server for plain HTML. Note the local URL.
3. **Register**: `pingfusi adopt <name> <original-url>` (name = short slug). This is the
   reviewer-loop-only path — no pixel gates, the review verdict is the check.
4. **Publish**: `pingfusi tunnel <name> --url http://localhost:<port>` (byte-verified public
   URL for the reviewer).
5. **The loop**: `pingfusi review <name> file [--region "…"] [--context "one line: what
   this site/page is"] [--results 1..20]` → tell the user the round is
   filed with an independent human reviewer on the pingfusi service (the reviewer pins what's
   wrong + picks a verdict — the user does not review). Immediately after filing,
   start `pingfusi wait <ping_id>` as a BACKGROUND task — a parked agent is not resumed
   when the verdict lands, and the loop dies silently at round 1 (the most common failure).
   Can't run self-waking background tasks? Tell the user: "answer the ping, then tell me
   to continue." On each verdict:
   - Approved → done; report with the round history.
   - Pins → fix each in the DRAFT'S OWN source (its components/styles — match its
     idioms; derive fixes from the original site's real markup/CSS, never invent),
     verify the dev server picked them up, `pingfusi tunnel <name> --check`, refile with
     `--changelog "what changed since your last review"`, re-arm the waiter. Repeat —
     the run is not complete until an approving verdict is recorded. Full rounds default
     to 1 result; request 5 for a broader read and 15–20 only for complex work or when
     higher confidence is worth it. Each completed result costs 1 credit; undelivered
     results are not charged.
   - If a pin is temporal (timing, easing, spring, stagger, scroll/pointer-driven,
     canvas, or WebGL motion), run `pingfusi next <name>` and follow its
     `pingfusi motion …` machine route (first-draft doctrine: the draft build reproduces
     animations automatically; motion checks are build receipts and warnings — never
     gates, never review rounds). Fix with the routed utility — `motion pass` to re-run
     the build pass, `verify-introspected` for the exact engine-declaration diff, or the
     sampled chain `sample` → `apply-sampled` → `verify-sampled` — then redeploy and
     refile the page round. Motion never blocks filing or refiling; the reviewer's
     side-by-side look IS the motion review.
6. **Rules**: all review contact through `pingfusi review <name> …` (never any MCP
   directly); polls one-sided only; never submit or open a review yourself; screenshots
   for triage, never as proof of a match. No login? Stop and have the user run
   `pingfusi setup` — review rounds require it; there is no offline review path. If
   anything else blocks a round, stop and tell the user what failed.
