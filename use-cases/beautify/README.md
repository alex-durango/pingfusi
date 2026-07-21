# Website Beautification — use case #2

**What it does.** Takes a functioning but plain, generic, or uneven webpage and turns it
into a coherent professional design. There is no site to copy: the page's purpose,
content, brand, behavior, and accessibility are the constraints, and a real human
reviewer supplies the taste judgment prompting cannot prove.

**Its skill:** [`beautify-with-pingfusi`](../../skill/beautify-with-pingfusi/SKILL.md),
installed from `skill/` by `pingfusi setup` / `pingfusi agent-setup`.

**Reviewer surface: one current page, with sticky comments and drawing.** The native
single-page QA surface lets the reviewer judge the current page on its own purpose,
pin comments to exact elements, draw on regions that need attention, and choose
`Professionally polished` or `Needs another pass`. The round deliberately omits
`draft_url` and uses `require_evidence: "none"`; annotations are saved directly, while
the app does not upload a reviewer screenshot. The existing two-pane
compare surface calls its panes ORIGINAL/DRAFT and offers match-the-original alignment
tools, so using it for taste would falsely turn the plain before state into ground truth.
The immutable before snapshot is retained for the public before/after proof, not as a
design target.

Do **not** use `pingfusi review <name> file` for this use case. That command correctly
generates clone-fidelity questions and “identical” verdicts. Beautification files its
custom steps through `core.review.file` against a caller-owned state file.

## How the loop runs on the core API

1. **Ping.** Use `pingfusi ask` only when one consequential choice would otherwise be a
   guess: two type directions, two color moods, or two hero compositions. A ping is
   advisory; it cannot approve the page.
2. **Draft.** Before editing, publish an immutable copy of the untouched static build
   with `core.draft.push` and save its record. Publish every current static build the
   same way. For a live dev server, use the before draft URL as the bookkeeping URL for
   `pingfusi adopt <name> <before-public-url>`, then run `pingfusi tunnel <name> --url
   <local-dev-url>` and `pingfusi tunnel <name> --check`.
3. **Review.** File the current URL with `core.review.file`; omit `draft_url`. Ask about
   hierarchy, typography, spacing rhythm, alignment, color/contrast, composition,
   responsive polish, interaction states, and restrained motion. End with a tappable
   verdict step whose exact options are `Professionally polished` and
   `Needs another pass`; declare only the first as approving.
4. **Wait.** Arm `pingfusi wait <ping_id>` immediately. Fetch fresh with
   `core.review.verify`, act on every sticky comment and drawing in the draft's own source, publish a
   new immutable current draft, and refile with a visible changelog. Repeat until
   `outcome.ok === true`.

The complete round shape and iteration rules live in the installed
[`beautify-with-pingfusi` skill](../../skill/beautify-with-pingfusi/SKILL.md). Core's
wire, caps, publish-before-review rule, comment envelope, and exact-verdict handling are
documented in [docs/CORE.md](../../docs/CORE.md).

## Proof status

The use case remains **coming** until one real plain-page run has an approving human
verdict and a sanitized same-viewport before/after asset. Raw round state and reviewer
comments stay internal under `targets/`; only the proof receipt and visual ship. The
catalog selftest prevents an “available” label without both.
