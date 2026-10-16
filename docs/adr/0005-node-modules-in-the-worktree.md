# ADR-0005: node_modules in fixcrash's worktree

**Status:** Accepted
**Date:** 2026-10-16
**Deciders:** Ilya Seliverstov

## Context

- `reproduce` and `verify` run tests in fixcrash's own worktree, `.git/fixcrash/worktree`, at the crashing commit, the fix's parent and the fix (`docs/RESEARCH.md` §6). Between runs it is reset with `git checkout --force` and `git clean -fd`, which leave ignored files: Gradle's and Xcode's build caches survive there.
- A React Native app's Jest tests and its bundle build (ADR-0004) need the app's `node_modules` at that commit. `node_modules` is ignored, so a fresh worktree has none.
- What the testbed showed (step 6.4): `npm ci --offline` in a copy at another path took 3 s and wrote 481 MB, all from npm's cache, which the developer's own installs fill. npm 11 skips packages' install scripts unless they are approved, and the tests and the bundle didn't need them.
- Rule 8: tests run offline where the build tool allows.

## Decision

**Option B: `npm ci --offline` in the worktree, kept while the lockfile is the same.**

1. Before a JS run, fixcrash compares the hash of the commit's `package-lock.json` with the one it recorded for the worktree's `node_modules`. If they differ, or there is no `node_modules`, it runs `npm ci --offline` in the app's directory and records the new hash.
2. A failed offline install stops the run with a hint: run `npm ci` once in your checkout, which fills npm's cache, then try again. fixcrash doesn't go to the network itself.
3. Only npm for now. A Yarn or pnpm lockfile stops the run with a message that says so.

## Options considered

### A: A symlink to the checkout's node_modules

| Dimension | Assessment |
|-----------|------------|
| Cost | None |
| Risk | The crashing commit runs against today's dependencies when the lockfile changed in between: a version-exact rule (rule 3) that isn't |

**Cons:** silent and wrong exactly when it matters. Rejected.

### B: `npm ci --offline` per lockfile (chosen)

| Dimension | Assessment |
|-----------|------------|
| Cost | Seconds with a warm cache, once per lockfile: the crashing commit, the fix's parent and the fix usually share one |
| Disk | One more `node_modules` (481 MB for the testbed) |
| Risk | A cache missing a package, which the hint covers |
| Fit with the rules | Full: the commit's own lockfile, offline |

### C: `npm ci` with the network

Always works, and breaks rule 8's default. A user who wants it runs `npm ci` in the checkout first (B's hint), which fills the cache.

### D: A node_modules cache per lockfile hash in `${CLAUDE_PLUGIN_DATA}`

Saves the reinstall when a run moves between lockfiles and back, at hundreds of megabytes per entry. Not needed until a real app shows the reinstall matters.

## Consequences

- Easier: Jest and the bundle build see exactly the crashing commit's dependencies.
- Harder: Yarn and pnpm apps wait for their own commands (`yarn install --frozen-lockfile --offline`, `pnpm install --frozen-lockfile --offline`).
- Revisit: with the first Yarn or pnpm app, and if a monorepo hoists `node_modules` above the app's directory.

## Action items

1. [ ] The Jest runner installs `node_modules` in the worktree as above, records the lockfile hash, and hints on a failed offline install.
2. [ ] Unit tests: the hash check, the reinstall, the unsupported lockfile message.
