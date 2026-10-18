# ADR-0006: The plugin in a folder of its own, `plugin/`

**Status:** Accepted
**Date:** 2026-10-18
**Deciders:** Ilya Seliverstov

## Context

- An install copies the plugin folder, the one that holds `.claude-plugin/plugin.json`, into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` and loads that copy. Files outside the folder aren't copied. When the folder has a `package.json` and a lockfile, Claude Code also runs a frozen package install there, and nothing turns it off (`RESEARCH.md` §7, 2026-10-17 and 2026-10-18).
- Until step 7.1 the plugin folder was the repository root. The plugin's files sat beside the tests, the testbeds, the docs, the eval, and the dev-only `package.json` and `package-lock.json`.
- Anthropic's directory reads the plugin folder:
  - it requires a README of 40 words or more and a license in that folder;
  - it holds for a reviewer files of 256 KiB or more, binaries other than images and fonts, and a lockfile install;
  - it always holds a pinned `npx` package, and fixcrash's Firebase MCP server is one, so every version gets a human review;
  - for a plugin in a subfolder of its repository, it also holds a hook script it can't follow, such as a shell script that runs another file. `hooks/run.sh` runs `src/hook.ts`.
- **The spike** (2026-10-18, Claude Code 2.1.302) installed three layouts from a local marketplace into an isolated Claude Code configuration:

| | A: the repository root | B: `plugin/` | C: a release branch with the plugin at its root |
|---|---|---|---|
| Files in the install | 229 | 29 | 29 |
| Size of the install | 35 MB, of which 33 MB is `node_modules` (TypeScript and Node's types, installed from the dev lockfile) | 256 KB | 256 KB |
| `claude plugin validate` | a warning: `CLAUDE.md` at the plugin root | no warnings, `--strict` too | no warnings |
| Directory holds besides `npx` | the lockfile install; two `gradle-wrapper.jar` and a keystore; the RN testbed's 474 KiB lockfile | the hook script | none, presumably |
| What it adds to a release | nothing | nothing | a branch built and pushed on every release |

- Each install's copy behaved the same. The hook denied a write to `.git/fixcrash` and a `gh pr create` without a receipt, and allowed the pull request once there was one. `fixcrash receipt` ran from the copy's `bin/`.
- B's copy then ran end to end:
  - its PostToolUse hook recorded the RN testbed's parser event and redacted the user id;
  - `fixcrash verify` on the parser fix said VERIFIED in 11 s, and the receipt names the plugin version from `plugin.json`;
  - `/fixcrash:triage` with the copy loaded produced the right table (46 s, $0.62).
- Node 24 runs `src/*.ts` as ES modules by syntax detection when no `package.json` says otherwise. If a `package.json` without `"type"` sits above the plugin (a user's `~/package.json` is enough), every run prints a `MODULE_TYPELESS_PACKAGE_JSON` warning.

## Decision

**Option B: the plugin lives in `plugin/`, which the marketplace entry points at. Everything else stays at the repository root.**

1. **`plugin/` holds what an install needs:**
   - `.claude-plugin/plugin.json`, `.mcp.json`, `skills/`, `agents/`, `hooks/`, `bin/` and `src/`;
   - a `package.json` with `"type": "module"` and nothing else, so Node never guesses and Claude Code has nothing to install.
2. **The root keeps the rest:** `.claude-plugin/marketplace.json` with `"source": "./plugin"`, the tests, the testbeds, the docs, the eval, and the dev `package.json`, lockfile and `tsconfig.json`.
3. **Nothing in `plugin/` reaches outside it.** `test/layout.test.ts` checks this: no import or file URL that leaves the folder, no lockfile, no symbolic link, no binary, no file of 256 KiB or more.
4. **One version.** The receipt's fixcrash version comes from `plugin.json`, and the root `package.json` has none. A release raises `plugin.json` alone.
5. **The plugin folder gets its own `README.md` and `LICENSE`** in step 7.2: the directory reads them there, and installs carry the license.

## Options considered

### A: The repository root (the layout before 7.1)

| Dimension | Assessment |
|-----------|------------|
| Install | Every file of the repository plus the dev dependencies, installed from the network when npm's cache lacks them |
| Directory | Three holds of its own (lockfile install, binaries, a large file) |
| Workflow | `--plugin-dir .`, as before |

**Cons:** users get what they don't need, and an install depends on a package install that can fail or time out. Slimming the root (testbeds to their own repository, no committed lockfile) would trade one problem for others. Rejected.

### B: `plugin/` (chosen)

| Dimension | Assessment |
|-----------|------------|
| Install | 29 files, 256 KB, no package install |
| Directory | One hold of its own: the hook script, reviewed anyway because of the `npx` hold |
| Workflow | `--plugin-dir plugin`, `plugin/bin/fixcrash`; tests import `../plugin/src/` |

### C: A release branch built from `plugin/`

`git subtree split --prefix plugin` makes a branch whose root is the plugin, in 0.4 s; the marketplace entry would point at it with a `github` source and `ref`.

| Dimension | Assessment |
|-----------|------------|
| Install | The same 29 files as B |
| Directory | Presumably no hold of its own: the plugin is at the root of what it reads |
| Workflow | A CI job with write access pushes the branch on each release. Users install a tree that tests never ran in, at a second ref to keep in step |

### D: The plugin in a repository of its own, development in another

Tests and testbeds would live away from the code they check. Rejected.

## Trade-off analysis

A loses on the install itself. B and C install the same files. C buys one fewer reviewer hold with a release pipeline and a second ref. That hold doesn't matter much: the `npx` hold puts every version in front of a reviewer anyway. B gives users the same plugin with nothing to keep in step.

## Consequences

- Easier: an install carries 29 files and no package install. `claude plugin validate --strict` passes for the plugin and the marketplace, with no warnings.
- Harder:
  - commands change: `claude --plugin-dir plugin`, `plugin/bin/fixcrash`;
  - docs written before 7.1 name the plugin's files from the root (`src/hook.ts` is `plugin/src/hook.ts`);
  - two READMEs and two LICENSE files from 7.2 on.
- Unchanged: users who add the marketplace still clone the whole repository (1.5 MiB in 231 files, plus 0.6 MiB of history) into `~/.claude/plugins/marketplaces/fixcrash/`. Claude Code doesn't load it. `--sparse .claude-plugin plugin` would limit the clone; untried.
- Revisit: switch to C if the directory's review of the hook script delays releases, or if the directory turns it into a block.

## Action items

1. [x] Move the plugin into `plugin/`. Point the marketplace entry at it, add the plugin's `package.json`, and read the receipt's version from `plugin.json`. Add `test/layout.test.ts`, and update CLAUDE.md and README.
2. [x] `plugin/README.md` and `plugin/LICENSE` (step 7.2).
3. [ ] Install from the GitHub repository with and without `--sparse .claude-plugin plugin`, and measure the marketplace clone (step 7.4).
