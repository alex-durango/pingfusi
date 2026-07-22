<div align="center">
<div align="center">
  <a href="https://pingfusi.com">
    <picture>
      <img alt="pingfusi logo" src="./docs/icon.svg" width="120">
    </picture>
  </a>
</div>
&nbsp;
<h1 align="center">Pingfusi</h1>

<p align="center">
    <a href="https://www.npmjs.com/package/pingfusi" alt="NPM Version">
        <img src="https://img.shields.io/npm/v/pingfusi.svg"></a>
    <a href="https://www.npmjs.com/package/pingfusi" alt="NPM Downloads">
        <img src="https://img.shields.io/npm/dw/pingfusi.svg"></a>
    <a href="LICENSE" alt="License">
        <img src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
    <a href="https://discord.com/invite/smYn6M4Cb" alt="Discord">
        <img src="https://img.shields.io/badge/discord-join-5865F2.svg?logo=discord&logoColor=white"></a>
</p>
</div>

## About

pingfusi is an MCP that lets AI agents call human reviewers.

Think MTurk for AI agents. With pingfusi your agent can:

* **Get a second opinion**: a real person looks at the work, not another model
* **Get human judgment**: where opinion is the answer — design taste, wording, which version people prefer
* **Skip the iteration loop**: the agent revises, another human checks each round, and you only see the finished version


## Quickstart

Set up Pingfusi for your coding agents with a single command.
```sh
npx pingfusi setup
```

## Example Prompts

Here are some example prompts you can try with the pingfusi MCP.

| feedback about | example prompt | what you get | demo |
|---|---|---|---|
| a naming choice | `Which name is better for my coffee app: Brewly or Cuppa? use pingfusi` | poll result | |
| a confusing page | `Is my pricing page confusing anywhere? use pingfusi` | comments pinned to what's off | |
| a website clone | `Clone www.example.com pixel-perfect. use pingfusi` | a perfectly cloned website | [copy-anything.com](https://copy-anything.com/) |
| design taste | `Make my website not look like AI slop. use pingfusi` | design feedback | |
| video vibes | `Does my promo video look right? use pingfusi` | feedback pinned to timestamps | |
| [?] | ask any question that you can think of | real human feedback | |

## How it works

Every job is the same loop underneath:

1. **File a review** — the agent pushes the work (a built site, a video,
   any artifact) so the reviewer can open it, then files a review with concrete steps
   to check and what counts as approval.
2. **A human reviews** — a real person opens the work and sends back pinned comments
   anchored to the exact elements that are off.
3. **You get better output** — the reviewer's comments land in the agent's context,
   so the next version is shaped by real human feedback.

Example: you ask for a landing page that doesn't look like AI slop. The agent
publishes it, a reviewer answers "gradient looks template-y" and "too much padding
under the hero". The agent fixes both and refiles; the next reviewer
approves. You come back to a page a human signed off on.


## CLI commands

The full command lives in [docs/COMMANDS.md](docs/COMMANDS.md).

```
pingfusi setup                          install + onboarding
pingfusi doctor                         check the install; prints a fix per problem
pingfusi ask "<question>"               ask a human reviewer, from any directory
```



## License

MIT
