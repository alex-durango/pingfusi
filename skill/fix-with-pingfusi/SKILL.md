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
5. **The loop**: `pingfusi review <name> file [--region "…"]` → tell the user a review ping is
   coming (they pin what's wrong + MUST pick a verdict button). On each verdict:
   - Approved → done; report with the round history.
   - Pins → fix each in the DRAFT'S OWN source (its components/styles — match its
     idioms; derive fixes from the original site's real markup/CSS, never invent),
     verify the dev server picked them up, `pingfusi tunnel <name> --check`, refile with
     `--changelog "what changed since your last review"`. Repeat.
6. **Rules**: all review contact through `pingfusi review <name> …` (never any MCP
   directly); polls one-sided only; never submit or open a review yourself; screenshots
   for triage, never as proof of a match. If a pingfusi login exists, rounds go through
   the remote review service — never fall back to `--local` because tunnels failed (the
   tool refuses it); stop and tell the user what's blocked instead.
