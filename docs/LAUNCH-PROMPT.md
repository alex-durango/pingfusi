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
- Capture INVISIBLY by default: `pingfusi capture-run {{NAME}}` does settle + measure +
  DOM + coverage in a kit-owned headless Chrome (probe-gated, viewport-normalized to
  width+height+dpr) and writes artifacts directly — the user is working while you clone,
  and this path never opens a tab they can see, never throttles, and needs none of your
  browser round-trips. Only fall back to your own browser-automation tooling when
  capture-run's error tells you to (bot wall, no Chrome, probe refusal).
- Interactive fallback only: use your browser-automation tooling (e.g. the
  claude-in-chrome MCP — load the core set in ONE ToolSearch call). Fresh tabs; verify
  innerWidth/devicePixelRatio before every capture; if the requested width is
  unreachable, record the actual width in target.json and measure everything at that
  width.
- Behavior discovery needs a tab where `document.hidden === false`. If your automation
  reports tabs hidden PERMANENTLY (some stacks do — verify once, not per tab), do not
  fight the environment and do not retry: run `pingfusi behavior-capture {{NAME}}`
  instead — a kit-owned Chrome measures BOTH sides (probe-gated, attestation recorded)
  and writes behaviors-*.json directly. Name marquees/hover triggers in
  targets/{{NAME}}/behavior-opts.json first. It runs INVISIBLY (headless by default,
  ephemeral ports, never touches the user's own browser) — do not pass --headful
  unless its probe-refusal error explicitly tells you to; the user is working while
  you clone, and a surprise Chrome window is an interruption.
- Long-running processes (sink, serve, tunnels, `pingfusi wait`) run as background
  Bash tasks. Sandboxed Bash may need the sandbox disabled for network commands.
- NEVER end your turn at a review-wait without a live waiter: a parked agent is not
  resumed when the verdict lands — the round then sits answered until a person notices.
  After filing a round, start `pingfusi wait <ping_id>` as a BACKGROUND task before
  doing anything else; its exit is what wakes you to act on the verdict.
- Review drafts: `pingfusi draft {{NAME}} push` is the DEFAULT (hosted, byte-verified,
  stable url — no clone tunnel needed). Tunnels remain only for adopted builds running
  their own dev server (and optionally a sink POST loop, below).
- Delivery: `pingfusi capture open {{NAME}}` FIRST (hosted capture session — the
  default), then every capture delivers in one call from any page:
  pxSend / pxSendDom / pxBehaviorSend to the printed sink_url, and
  `pingfusi capture pull {{NAME}} --all` retrieves them integrity-verified. A 409
  means truncated/corrupted transport — re-send; nothing was stored. Localhost sink,
  pxSave (ONE download per tab — fresh tab per save, verify on disk), sink tunnel,
  and stash/chunked pxRead are the fallbacks, in that order (RUNBOOK Step 0).
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
- Run `pingfusi next {{NAME}}` after behavior capture: the draft build reproduces
  animations automatically (the motion pass), and its receipts surface here as
  informational warnings with a routed machine check (verify-introspected / the sampled
  chain) — never gate failures, never review rounds. Fix what a warning names, then
  keep following `next`.
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
