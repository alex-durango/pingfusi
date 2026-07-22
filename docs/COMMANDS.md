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
                                        one advisory question to a human reviewer, from any directory
pingfusi ask result <ping_id>           passive answer snapshot (free; does not renew)
pingfusi publish <built-dir|video.mp4>  host a self-contained site or seekable MP4
                                        (`--target`, `--record`, and `--json` available)

pingfusi new     <name> <url> [width]   scaffold a clone target
pingfusi adopt   <name> <url> [width]   register an external draft for review-only
pingfusi capture-build <name>           build the clone from the captured live DOM
pingfusi serve   <name> [port]          serve the clone + capture tools
pingfusi draft   <name> push            upload the clone as a HOSTED draft — stable public
                                        url, survives your machine sleeping (review default)
pingfusi draft   <name> status|delete   re-verify / delete the hosted draft
pingfusi tunnel  <name> [--url <dev>]   fallback for apps that truly require a live server
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
