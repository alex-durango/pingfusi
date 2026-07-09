# pingfusi

### ❌ Without pingfusi

AI clones 90% correctly — then you burn prompt after prompt fixing the last 10%:

- ❌ layout wrong
- ❌ fonts wrong
- ❌ colors wrong
- ❌ animation wrong
- ❌ vibes wrong

### ✅ With pingfusi

Clone any website pixel-perfect. No iteration needed.

## Installation

```sh
npx pingfusi setup        # one interactive command: install, tunnel, review login, agent skills
```

## Prompts

```
clone www.example.com. use pingfusi.
```

```
clone header of www.example.com. use pingfusi.
```

```
clone hero of www.example.com. use pingfusi.
```

## Quick start — clone a site

```sh
pingfusi new acme https://www.example.com/ 1512   # scaffold targets/acme/ (1512 = viewport width in px, measured throughout)
pingfusi sink                                     # snapshot receiver on :7799 (separate terminal)
pingfusi serve acme                               # serve the clone + capture tools on :8080
```

## Quick start — polish an existing draft

No pixel pipeline, just the review loop:

```sh
pingfusi adopt mydraft https://original-site.com/ 1512 # register your draft + the original it should match (1512 = viewport width in px)
pingfusi tunnel mydraft --url http://localhost:3000    # tunnel your own dev server
pingfusi review mydraft file                           # reviewer answers in minutes
```

## Command reference

```
pingfusi setup                          first contact — interactive onboarding
pingfusi doctor                         read-only preflight; a fix command per miss
pingfusi where                          print the installed kit's directory

pingfusi new     <name> <url> [width]   scaffold a clone target
pingfusi adopt   <name> <url> [width]   register an external draft for review-only
pingfusi capture-build <name>           build the clone from the captured live DOM
pingfusi serve   <name> [port]          serve the clone + capture tools
pingfusi tunnel  <name> [--url <dev>]   verified public HTTPS tunnel
pingfusi sink                           snapshot receiver (:7799)
pingfusi score   <name>                 live-vs-clone score + delta vs last run
pingfusi diff    <live> <clone>         raw numeric diff (--visual | strict)

pingfusi review  <name> file            file a scope-pinned review round
pingfusi review  <name> poll "q"        mid-round micro-check with a reviewer
pingfusi status  <name>                 phase table + next required action
pingfusi gate    <name> <phase>         run one gate read-only (exit 0/1)
pingfusi advance <name> <phase>         record a phase (gate must pass)
pingfusi ledger  <name>                 the audit trail
```

## License

MIT
