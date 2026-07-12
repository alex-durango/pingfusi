# corpus — frozen REAL-SITE captures the gate is scored against

The synthetic `../battery.js` is fast and deterministic but hand-built. This corpus is the
reality check: each case is a **frozen real capture** (the exact `live.json` / `clone.json`
a real clone produced), scored by the same `diffSnapshots` gate via `../corpus.js`. Both
halves are summed into one scorecard by `../detection-power.js`, so every regression run
and every `promote-learning.js` A/B is judged against real pages too — not only synthetic
cases.

## Layout — one directory per case (committed, travels with the kit)

```
corpus/<slug>/live.json     frozen live capture
corpus/<slug>/clone.json    frozen clone capture
corpus/<slug>/label.json    { "kind": "control"|"defect", "note": "...", "from": "<target>" }
```

- **control** — a clone that went GREEN on a real site. The gate MUST pass it; a flag here
  is a **real false positive** (a gate change that would regress a shipped-green clone).
- **defect** — a real captured pair that is genuinely wrong (freeze the PRE-fix clone). The
  gate MUST catch it; a pass here is a **real miss** a review round would have paid for.

## Adding a case

Don't hand-write these — freeze them from a real target:

```sh
node harness/freeze-corpus.js <target> <slug> --control "went green"        # after --visual PASS
node harness/freeze-corpus.js <target> <slug> --defect  "the miss, pre-fix" # before you fix a miss
```

Snapshots are numeric boxes / font props / colours (no page text), so they commit cleanly.
The shipped-surface leak-guard still scans them — if a family or class name ever trips it,
drop that case; the guard is doing its job.
