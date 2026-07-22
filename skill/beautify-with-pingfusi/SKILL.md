---
name: beautify-with-pingfusi
description: Beautify or redesign an existing website through iterative pingfusi review rounds with a real human reviewer. Use when asked to "beautify this website," "make this page look professional," "polish this UI/design," "improve the visual design," or finish an AI-built page when there is no reference site to match. Do not use for pixel-matching a known original; use fix-with-pingfusi for that.
---

# Beautify a website with pingfusi

Turn an existing page into a professionally designed version, then keep iterating on
element-pinned feedback until a human reviewer approves it. Treat the page's purpose,
content, brand, and behavior as constraints; there is no ground-truth design to copy.

## Non-negotiables

- Edit the project's own components and styles. Preserve product intent, working
  behavior, semantic structure, accessibility, and user-provided copy unless the user
  asked to change them.
- Freeze the exact pre-edit build before changing source. Keep its public draft record
  and same-viewport screenshot as the before proof; never let a mutable dev URL stand in
  for the baseline.
- Publish the current build before every round. A remote reviewer cannot inspect
  localhost, and an unverified/dead URL burns the round.
- File a custom single-page round with `core.review.file`; omit `draft_url`. Its reviewer
  surface is the current page only, with sticky comments and drawing. Do not run
  `pingfusi review <name> file`: that command is for clone fidelity and asks whether a
  draft is identical to an original.
- Never approve your own work or infer approval from prose. Finish only when a fresh
  `core.review.verify(stateFile)` returns `ok === true` on the declared verdict.

## Workflow

1. Run `pingfusi doctor`. Locate the real source, build/test commands, responsive
   breakpoints, and any brand constraints. If review login is missing, stop and have the
   user run `pingfusi setup`; there is no offline review substitute.
2. Build the untouched page. Publish that static output through Pingfusi hosting and
   save the immutable receipt, then capture a screenshot at the viewport(s) the final
   proof will use:

   ```sh
   pingfusi publish <built-dir> --name <name>-before \
     --record .pingfusi/beautify/<name>/before.json --json
   ```
3. Improve the page in its own source. Work in this order: hierarchy and composition;
   typography; spacing and alignment rhythm; color, contrast, and surfaces; responsive
   behavior; states and finishing details. Prefer one coherent visual idea over a pile of
   effects. If motion materially helps, add one restrained, purposeful beat and honor
   `prefers-reduced-motion`.
4. Build and test at desktop and phone widths. Publish the current static output through
   Pingfusi hosting, using a new URL for every round:

   ```sh
   pingfusi publish <built-dir> --name <name>-current \
     --record .pingfusi/beautify/<name>/current.json --json
   ```

   Use a verified tunnel only if the production app genuinely requires a live server
   and cannot produce a self-contained build. Never tunnel merely because development
   happens through `npm run dev`.

5. File one custom round against the current public URL. Keep it within the service caps
   (20 steps; 300 characters per step; 40 per option). Use one result for the normal
   loop; use more only when the user explicitly wants higher-confidence review.

   ```js
   const fs = require("node:fs");
   const path = require("node:path");
   const { execFileSync } = require("node:child_process");
   const kit = execFileSync("pingfusi", ["where"], { encoding: "utf8" }).trim();
   const core = require(path.join(kit, "packages/core"));
   const stateFile = path.resolve(".pingfusi/beautify/<name>/review.json");
   fs.mkdirSync(path.dirname(stateFile), { recursive: true });
   const currentDraft = JSON.parse(fs.readFileSync(".pingfusi/beautify/<name>/current.json", "utf8"));
   const currentPublicUrl = currentDraft.url; // the just-published, verified record
   const verdicts = ["Professionally polished", "Needs another pass"];
   const { ping_id } = await core.review.file(stateFile, {
     url: currentPublicUrl,
     title: "Is this page professionally designed?",
     instructions: "Judge the current page on its own purpose. Add sticky comments or draw on exact current-page regions that still feel generic, messy, inconsistent, or hard to use.",
     steps: [
       { text: "First impression: does this feel intentionally and professionally designed?", options: ["Clearly polished", "Almost there", "Still rough"], check: null },
       { text: "Check hierarchy, typography, spacing, alignment, color, and contrast. Pin a sticky comment or draw on every current-page region that needs a specific change.", check: null },
       { text: "Check desktop and phone layouts, interaction states, and any motion. Note clipping, awkward wrapping, weak affordances, or distracting effects.", check: null },
       { text: "FINAL REQUIRED STEP — verdict. Pick one exactly.", options: verdicts, check: null },
     ],
     verdict_options: verdicts,
     approve_verdicts: [verdicts[0]],
     n_target: 1,
     deadline_seconds: 86400,
     // The single-page reviewer stores sticky comments and drawings directly;
     // it does not upload a reviewer screenshot.
     require_evidence: "none",
   });
   ```

6. Immediately arm `pingfusi wait <ping_id>` as a background task. If the environment
   cannot wake itself, tell the user to answer the round and ask you to continue.
7. Fetch fresh with `core.review.verify(stateFile)`. Read every structured comment and
   selector, fix each pin in the project's own source, rebuild, republish to a new
   immutable current URL, and file another round. Put a concise “changed since the last
   review” step near the start of each refile. Re-arm the waiter every time.
8. After approval, rerun the project's tests and capture the after screenshot at exactly
   the before viewport(s). Keep raw round state and comments private; publish only a
   sanitized before/after visual and approval receipt.

Use `pingfusi ask` only for a consequential mid-build choice with 2–3 concrete options.
It is advisory and never replaces the approving round.
