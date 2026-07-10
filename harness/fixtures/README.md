# fixtures — one file per class of miss, so it can never come back

When cloning a real site surfaces a defect that a **green `--visual` didn't catch**, the
fix is two-part (see `../../docs/DEVELOP.md` → the miss protocol):

1. Teach the **tool** to measure it (extend `browser-capture.js` + `pixel-diff.js`).
2. Add a **fixture here** that fails *without* that tool change — locking it in forever.

`node harness/regression.js` runs `tools/selftest.js` + every `*.js` in this folder.

## Template

```js
// fixtures/NN-short-name.js — <one line: the class of miss, and which target found it>
const { diffSnapshots } = require("../../tools/pixel-diff.js");
let bad = 0; const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

// A minimal snapshot pair. The "bad" side reproduces the real defect; assert the gate
// FAILS on the named property (i.e. the property you just taught it to compare).
const el = (over = {}) => ({ present: true, rect: {}, font: {}, /* ...the fields that matter... */ ...over });
const snap = (e) => ({ viewport: { width: 1728 }, elements: { x: e } });

const res = diffSnapshots(snap(el()), snap(el({ /* the defect */ })), { visual: true });
check("gate catches <the miss>", !res.ok && res.rows.some((r) => !r.pass && r.prop === "<the.prop>"));

process.exit(bad ? 1 : 0);
```

Keep fixtures tiny and synthetic (no browser, no network) — they guard the *diff
engine's guarantees*, not any one site. The underline-box and font-smoothing guarantees
already live in `tools/selftest.js`; add the *next* lesson here.
