# Motion engine boundary

This package is the temporal-fidelity engine behind the root `pingfusi motion …`
commands. It is an ESM package (the root kit stays CommonJS) and is invoked by the root
CLI as a child process — never `require()`d into the CommonJS side. It needs Node
20.17+, 22.13+, or 23.5+ (the same engines range the root package declares).

## Install and test

The core CLI runs with none of this package's dependencies present; they install lazily,
on demand — there is no npm postinstall:

```sh
pingfusi motion install                  # install this package's node deps
npm --prefix packages/motion test        # the engine's own selftests (from the repo root)
```

## Browser resolution

Capture/trace/replay resolve a browser in this order: Playwright's Chromium when
installed → a system Chrome pinned by `PPK_MOTION_CHROME` or `PPK_CHROME` → neither
found, the error names the fix: `pingfusi motion install-browser` installs the
package-owned Chromium + FFmpeg runtime once.

## Artifact ownership

Generated captures, traces, bundles, and motion-library entries belong to the invoking
clone workspace (`targets/<name>/motion/…`), never to this source package. The engine
stays target-agnostic; the root CLI supplies the workspace paths.
