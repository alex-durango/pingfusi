# benchmarks — score the gate's detection power (the scientific instrument)

Fixtures lock in *one* past miss each. This battery scores the gate across *all* known
defect classes at once, so a proposed change to the gate can be judged objectively:
**did it catch more without inventing false positives?**

- **`battery.js`** — a fixed, labelled corpus of snapshot pairs: DEFECTS (a correct gate
  must FAIL) and CONTROLS incl. adversarial false-positive hunters (a correct gate must
  PASS). Each case traces to a `LEARNINGS.md` entry. Extend it whenever a new class of
  miss — or a new false-positive risk — is found.
- **`detection-power.js`** — the runner, two modes:

```sh
# ABSOLUTE (CI guard, run by harness/regression.js): the current gate must catch every
# defect and flag no control. Exit 0 = clean.
node harness/benchmarks/detection-power.js

# A/B: compare a baseline gate to the working-tree gate, case by case. Run this BEFORE
# adopting a gate change — it isolates exactly what the change adds or breaks.
node harness/benchmarks/detection-power.js --vs HEAD
node harness/benchmarks/detection-power.js --vs path/to/old/pixel-diff.js
```

## The rule for changing the gate (the method)

Never adopt a gate change on "looks better." Score it:

1. Add the new defect (and any false-positive risk it introduces) as cases in `battery.js`.
2. `--vs HEAD` — the bar is **+N defect classes gained, 0 regressions** (0 missed defects,
   0 new false positives). A single-variable diff is ideal.
3. If it shows a regression (e.g. an adversarial control now flags), fix the gate and
   re-run until the A/B is clean — *then* commit. The backdrop-colour gate (`bg`, #16) was
   adopted this way: the naive version false-positived on translucent/whitespace controls;
   the battery caught it before commit.
