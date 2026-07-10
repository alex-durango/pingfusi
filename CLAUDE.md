# pingfusi — distribution repository

This repository is the released form of the pingfusi kit (published to npm as `pingfusi`).
Releases are assembled and verified by the maintainers' release tooling, so commits here are
release-granular and PRs cannot be merged directly — open an issue or PR and a maintainer
ports the change into the next release with authorship credit.

- `npm test` runs the full offline selftest suite (harness/regression.js) — keep it green.
- Start with README.md; WORKFLOW.md documents the gated pipeline, PLAYBOOK.md the method.
- The CLI is `pingfusi` (`npx pingfusi setup` to onboard); review rounds are filed with
  `pingfusi review <name> file` and verified with `pingfusi review <name> verify`.
