# Command reference — the `pingfusi` CLI

Most users never need this page: `npx pingfusi setup` installs everything, and after
that your coding agent drives pingfusi through its skills and MCP tools. This is the
full command surface for operating the kit by hand.

```
pingfusi setup                          first contact — interactive onboarding
pingfusi doctor                         read-only preflight; a fix command per miss
pingfusi where                          print the installed kit's directory
pingfusi remove                         clean uninstall (also sweeps older-generation installs)

pingfusi ask "<question>" [--options "A,B,C"] [--context "…"]
                                        one advisory question to a human reviewer, from any
                                        directory. text-only: the reviewer sees just the question
                                        string — anything they must look at goes through
                                        `pingfusi publish` + a review round instead
pingfusi ask result <ping_id>           passive answer snapshot (free; does not renew)
pingfusi publish <built-dir|video.mp4>  host a self-contained site or seekable MP4
                                        (`--target`, `--record`, and `--json` available)
pingfusi publish-build <game.zip> --platform windows|macos
                                        host a GAME BUILD for a native playtest with no
                                        store page: one zip (≤1 GiB, magic-checked and
                                        sha256'd locally before any bytes move), streamed
                                        to hosting, served at the returned /b/<slug> URL —
                                        file `request_review` with that URL and the same
                                        platform:. Hosted builds are TEMPORARY: 72h unless
                                        a filed round extends them, and a handful per
                                        account — `pingfusi builds` shows what you hold and
                                        `pingfusi builds rm <slug>` frees a slot. Publishing
                                        the SAME zip twice returns the same build rather
                                        than a second copy, so a retry costs nothing.
                                        Reviewers see an unreviewed-developer-build
                                        disclosure and may stop, penalty-free. On macOS the
                                        reviewer app downloads and launches the build itself
                                        (no Gatekeeper wall). Pre-flighted at upload: the
                                        .app's main executable must be a Mach-O binary
                                        (script-main bundles are refused — unsupported on
                                        macOS), arm64 slices must be at least ad-hoc signed
                                        (linkers do this automatically; x86_64-only runs
                                        unsigned under Rosetta), and a zip that is really a
                                        WEB build is pointed at `pingfusi publish` + a web
                                        playtest instead.
                                        (`--name`, `--record`, and `--json` available)
pingfusi builds                         the hosted builds this account holds, oldest first,
                                        with each one's URL, size and expiry, and what it is
                                        doing. Builds whose upload never finished are marked
                                        safe to delete — no round can reference one (filing
                                        needs a finalized build). Builds an OPEN round is
                                        still downloading are marked IN USE: deleting one
                                        404s a playtester mid-session and burns the round.
pingfusi builds rm <slug>               delete one now, freeing its slot. Deleting a build a
                                        round is still using breaks that reviewer's download
                                        — check the listing first. (`--json` available; a
                                        slug may begin with `-` and is still read as the
                                        slug, never as an option)
pingfusi studio  [ping_id ...]          LOCAL RESULTS VIEWER (playtests first): fetches a
                                        round's results over the wire and caches them —
                                        JSON + media bytes — under <cwd>/.pingfusi/studio/
                                        (signed media urls die in ~1h and objects are
                                        retention-swept; the cache outlives both), then
                                        serves a read-only page at http://localhost:7788:
                                        per-session recording playback, think-aloud
                                        transcript (click-to-seek), questionnaire matrix
                                        with per-item means, reviewer comments, and the
                                        agent-written findings in annotations.json —
                                        rendered as a findings tab plus a per-session
                                        "key moments" rail (evidence anchors seek the
                                        recording; time_ms+end_ms anchors mark clips).
                                        The ANALYSIS IS THE AGENT'S JOB: the command
                                        prints which cached rounds have transcripts but
                                        no annotations yet, and docs/STUDIO.md is the
                                        authoring contract. `--port N`, `--open` (browser
                                        stays opt-in), `--fetch-only`, `--no-media`,
                                        `--json` (carries analysis_needed paths). No ids =
                                        refresh cached in-flight rounds + serve. Never a
                                        review surface: verdicts come from the independent
                                        reviewer; the studio only shows them.
                                        A second, purely local axis: MACHINE RUNS — the
                                        rig harness plays builds by virtual gamepad and
                                        writes .pingfusi/studio/runs/<run_id>/ (a
                                        pingfusi-rig-run/v1 receipt plus optional
                                        recording, screenshots, annotations), which the
                                        studio serves read-only. Runs appear grouped by
                                        gym: per-gym pass/fail with failure causes and an
                                        fps-across-builds chart, plus a per-run view
                                        (events, warnings, fps sparkline, recording with
                                        event seek). Machine runs are labeled as such and
                                        are never review rounds — no reviewer, no filing,
                                        no charge

pingfusi new     <name> <url> [width]   scaffold a clone target
pingfusi adopt   <name> <url> [width]   register an external draft for review-only
pingfusi capture-build <name>           build the clone from the captured live DOM
pingfusi serve   <name> [port]          serve the clone + capture tools
pingfusi draft   <name> push            upload the clone as a HOSTED draft — stable public
                                        url, survives your machine sleeping (review default)
pingfusi draft   <name> status|delete   re-verify / delete the hosted draft
pingfusi tunnel  <name> [--url <dev>]   fallback for apps that truly require a live server
                                        (named cloudflared tunnel → ngrok → anonymous quick
                                        tunnel; the last is rate-limited and says so)
pingfusi sink                           snapshot receiver (:7799)
pingfusi score   <name>                 live-vs-clone score + delta vs last run
pingfusi diff    <live> <clone>         raw numeric diff (--visual | strict)
pingfusi next    <name> [--json]        route the next failure to the right utility

pingfusi motion  pass <name>            re-run the build motion pass standalone (capture-build
                                        runs it automatically; receipts + warnings, never a gate)
pingfusi motion  install                install the motion engine's deps (lazy — the core CLI runs without them)
pingfusi motion  verify-introspected …  exact live-vs-clone diff of the page's own engine declarations
pingfusi motion  sample|apply-sampled|verify-sampled …  the deterministic sampled-tier machine chain
pingfusi motion  capture|trace …        capture CSS/WAAPI or fitted JS/canvas motion
pingfusi motion  gate|export …          replay-check and export a reusable motion entry
pingfusi motion  loop|nudge|tune …      converge difficult timing/spring/easing behavior

pingfusi review  <name> file [--results 1..20]  file a scope-pinned review round (default 1)
pingfusi review  <name> poll "q"        1-result mid-round micro-check with a reviewer
pingfusi wait    <ping_id>              continue a pending ping through client-safe wait legs
pingfusi status  <name>                 phase table + next required action
pingfusi gate    <name> <phase>         run one gate read-only (exit 0/1)
pingfusi advance <name> <phase>         record a phase (gate must pass)
pingfusi ledger  <name>                 the audit trail
```

`pingfusi next <name>` is the agent-facing dispatcher. Layout evidence stays with the
pixel diff and side-by-side layout review; interaction-state evidence stays with behavior
capture; temporal evidence (timing, easing, spring, stagger, scroll/pointer-driven,
canvas, or WebGL motion) is routed to the `pingfusi motion …` machine utilities.
