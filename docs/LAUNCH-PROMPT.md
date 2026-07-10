# Launch prompt — hand a fresh agent a pingfusi clone run

Fill the three values and give this to any agent with browser automation + shell access.
The kit's docs carry the method; this wrapper carries only what lives outside the repo
(the environment) and the run contract. Refined across the astryx + iphone17 runs.

---

You are driving the pixel-perfect-kit (`pingfusi` on PATH; run `pingfusi where` to locate the
installed kit's directory — every doc referenced below lives there; run `pingfusi doctor`
first and surface any failure to the user before starting). Targets are created under
the CURRENT working directory (`targets/<name>/`).

Your task: follow the kit's one-shot template at <KIT>/docs/CLONE-ANY-SITE.md with these values:
- {{URL}} = <the page to replicate>
- {{WIDTH}} = <fixed measurement viewport width, e.g. 1512>
- {{NAME}} = <target name, e.g. acme>

The template names the docs to read first (docs/PLAYBOOK.md, tools/RUNBOOK.md, docs/LEARNINGS.md,
docs/WORKFLOW.md — their rules override any assumption you have) and defines done:
`node harness/workflow.js gate {{NAME}} done` exits 0 — which includes the `behavior`
phase (every JS-driven dynamic reproduced with measured values or excused with a
reviewer-readable reason) and the `reviewer` phase (a real reviewer's approving verdict,
filed and verified through the kit's tooling). The reviewer answers within minutes —
keep the loop tight and act on every verdict immediately.

Environment notes (operational, not workflow):
- Use your browser-automation tooling (e.g. the claude-in-chrome MCP — load the core
  set in ONE ToolSearch call). Fresh tabs; verify innerWidth/devicePixelRatio before
  every capture; if the requested width is unreachable, record the actual width in
  target.json and measure everything at that width.
- Long-running processes (sink, serve, tunnels, `pingfusi wait`) run as background
  Bash tasks. Sandboxed Bash may need the sandbox disabled for network commands.
- NEVER end your turn at a review-wait without a live waiter: a parked agent is not
  resumed when the verdict lands — the round then sits answered until a person notices.
  After filing a round, start `pingfusi wait <ping_id>` as a BACKGROUND task before
  doing anything else; its exit is what wakes you to act on the verdict.
- Review drafts: `pingfusi draft {{NAME}} push` is the DEFAULT (hosted, byte-verified,
  stable url — no clone tunnel needed). Tunnels remain only for the capture sink and
  for adopted builds running their own dev server.
- Delivery: start `node tools/sink.js` and `node harness/tunnel.js --sink` FIRST — the
  automation extension blocks page→localhost fetch (a clean ~4s abort), and the sink
  tunnel restores one-call delivery for every capture (pxSend / pxSendDom /
  pxBehaviorSend). A `text/plain` form POST to the sink also works when the site's CSP
  has no form-action directive. Stash + chunked pxRead is the LAST resort.
  Large captures (> ~500 KB) or any 409 from the sink: use `pxSaveDom`/`pxSave` (browser
  download → ~/Downloads, byte-exact — RUNBOOK Step 0); a 409 means the delivery was
  truncated/corrupted in transport — switch method, don't retry it.
- If a tunnel verify fails, do NOT kill + re-run tunnel.js in a loop — each run mints a
  new hostname and re-races DNS propagation. Its probes already fall back to pinned
  public DNS; a run that still fails is genuinely broken (dead cloudflared, wrong port,
  sandboxed network).
- Do the work directly — NO sub-agents (their results orphan when you stop). If a
  session limit kills you, the receipts carry the state: your successor orients from
  disk, so keep NOTES.md, FINDERS.md, and the ledgers current as you go.

Rules the kit ENFORCES — don't fight the refusals, they are the method:
- ALL reviewer contact through `pingfusi review {{NAME}} …` (the MCP contact tools are
  permission-denied). Polls may reference ONE side only; anything naming both clone and
  live is a comparison and must be a filed test. Filing requires every pre-review gate
  green. Every refile carries `--changelog "what changed since your last review"`.
- Never --force. Never invent: values come from measurements, mechanisms from the
  site's own captured CSS/markup/config (a guessed attribute value is an invention; an
  honest static frame beats fabricated motion). When a behavior's mechanism is
  unknowable from artifacts, the worksheet prints the question to ask the reviewer —
  ask it before you build.
- Screenshots triage and smoke-check; they never certify a match. Numbers certify what
  numbers reach; the reviewer certifies the rest — through the platform, never out of
  band.

If {{NAME}} already exists (resuming): orient from disk before touching anything —
`pingfusi status {{NAME}}`, run the pre-review gates read-only, read NOTES.md fully (history,
protocols, environment findings), FINDERS.md (persisted selectors + decoys), and
review-qa.json (round history). Trust receipts over any prior agent's claims.

Your final message is a factual run report: each phase with its real gate output, the
behavior worksheet summary (observed/declared/how disposed), review round history
(ping ids, verdicts, what you fixed), kit friction — a flag the gates MISSED is the
most valuable output of the whole run — and the exact commands a reviewer runs to
re-verify. Raw facts over prose polish.
