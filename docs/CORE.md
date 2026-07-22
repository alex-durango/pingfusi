# CORE — the plumbing every job runs on (`packages/core`)

Audience: someone BUILDING a new job over the review service. Users and agents pick
jobs from the menu ([use-cases/README.md](../use-cases/README.md)) and never need
this file.

Everything the kit says to the review service goes through `packages/core`: one wire,
a small set of verbs, zero dependencies, CommonJS. The cloning pipeline
(`harness/review-qa.js`, `harness/draft.js`) is just the biggest consumer — the core
itself never knows about `targets/`, gates, or clones. Round state lives in **a state
file path the caller provides** (the kit passes `targets/<name>/review-qa.json`; any
other caller passes its own file and gets the exact same record shape).
The shipped use-case catalog built over these verbs lives in `use-cases/` (README.md is the catalog page; `use-cases/your-own/TEMPLATE.md` defines a new one).

```js
const core = require("pingfusi/packages/core");
// core.ping / core.pingResult                          — one question
// core.review.file / core.review.wait / core.review.verify — a full round
// core.draft.push / core.draft.status / core.draft.delete  — a hosted draft
// primitives underneath: core.wire, core.rounds, core.drafts
```

The public CLI wraps `core.draft.push` as `pingfusi publish <built-dir|video.mp4>`.
Use that workspace-neutral command for Beautify, Video, and generic review artifacts;
clone targets retain `pingfusi draft <name> push` because they also record workflow state.

## The verbs

### `ping(question, { choices })` — one question, one reviewer

Files a 1-result question (up to 1 credit). The send operation stays open across
renewable server-wait legs until feedback, expiry, or caller interruption, so the answer usually comes back
inside the same call; `pingResult(ping_id)`
re-fetches the answers later for free but is a passive snapshot. The normal send call
already owns the full waiting lifecycle; no separate waiter is required.
**Advisory by doctrine:** a ping buys an answer, never an approval —
it satisfies no gate anywhere.

### `review` — file (send + wait) → verify, against a state file the caller owns

- `review.file(stateFile, spec)` files a full round and owns the renewable wait until
  feedback, expiry, or caller interruption
  (`spec` is request_review-shaped;
  `approve_verdicts` and `review_contract` are local bookkeeping, stripped before the
  wire) and appends the round record to `stateFile`.
- `review.wait(ping_id)` manually resumes an already-pending ping after an interruption;
  normal `review.file` callers do not need it. It renews the short idle lease and returns
  the current result envelope; no state write.
- `review.verify(stateFile)` re-fetches the LATEST round **fresh every time** (a cached
  approval is never trusted), persists the result envelope + receipts into `stateFile`,
  and returns a structured outcome (`{ ok, status, verdict, round, comments }`) — the
  caller owns presentation and exit codes. It is a passive snapshot and does not renew
  a pending round's lease.

### `draft` — push / status / delete a hosted public draft

- `draft.push(dir)` uploads a static bundle (`index.html` at its root) with the create →
  upload → finalize → **byte-verify** sequence: after finalizing, the served bytes are
  fetched and compared against the local `index.html` with the service's known
  `/assets/` → `/d/<slug>/assets/` rewrite applied. A push that doesn't verify throws —
  a record is returned only for a draft that provably serves.
- `draft.status(record, indexPath)` re-runs that rewrite-aware verify on a recorded draft.
- `drafts.verifyDraftRecord(record)` re-checks the recorded served-index hash when the
  original build directory is unavailable, as with a generically published artifact.
- `draft.delete(slug)` removes it.

### the wire underneath

`core.wire` is the one transport: `rpc(name, args)` (JSON-RPC tools/call against
`BASE + /api/mcp`, bearer token), `resolveToken()` (the existing `pingfusi` login:
config-dir credentials, then the MCP entry's bearer, then env), and the mirrored
service caps. A `file://` BASE serves canned responses from disk — every selftest runs
offline and socket-free through it, and so can yours.

## The contracts

- **Caps, checked locally first.** A too-big request is a *named local failure before
  any bytes move*, never a server-side rejection to decode: rounds cap at **20 steps /
  300 chars per step text / 40 chars per option** (`wire.SERVICE_CAPS`), draft bundles
  at **300 files / 25 MB per file / 100 MB total** (`drafts.MAX_*`).
- **Verdict-required.** A round passes only on an approving verdict from the round's own
  declared list. Prose that merely sounds approving never passes; the two narrow
  exceptions are exact string matches against the declared verdicts (a tapped option on
  the verdict step; a verdict-step comment equal to an approve verdict) and both receipt
  themselves via `verdict_source` so nobody later mistakes them for a real pick.
- **Publish-before-review.** A reviewer is remote: whatever they judge must be publicly
  served and byte-verified *before* a round is filed. `draft.push` refuses to return an
  unverified record; the kit's filing paths re-verify the recorded draft at file time.
- **Anchored feedback.** A reviewer's marks come back as a structured envelope — side,
  selector, target label, op, the drawn annotation (points as 0..1 fractions of the
  anchored element's box), viewport, rect, the dual-anchor `other` element — persisted
  **verbatim** in the state file, with `alignDeltas` parsed from alignment prose (null
  when unparseable, never guessed). `rounds.printCommentBlocks(dir, comments, log)`
  renders them, cross-referencing whatever measurement snapshots the caller's dir holds.

## The proof: `pingfusi ask` — a verb with zero cloning code

`ask` is the workspace-free CLI face of `ping`: no target, no `targets/`, runnable from
any directory with only a review login. State lives per-ask in
`~/.pingfusi/asks/<ping_id>.json`.

```
$ pingfusi ask "Which tagline reads better for a developer tool?" \
    --options "Draft first,Review everything" --context "two candidates for the launch page"
✓ ask filed — ping 3f2b… (1 result, advisory; recorded: ~/.pingfusi/asks/3f2b….json)
Ping complete: 1/1 responses received.
```

An agent picking between taglines uses the send-and-wait `ping` operation —
the same wire, caps, and record shape as a full clone review, with none of the pipeline. That is the
extraction's acceptance test, and `harness/bin-dispatch-selftest.js` runs it end-to-end
through the installed command against the `file://` mock transport.
