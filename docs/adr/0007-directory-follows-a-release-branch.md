# ADR-0007: Anthropic's directory follows a `release` branch

**Status:** Accepted
**Date:** 2026-10-18
**Deciders:** Ilya Seliverstov

## Context

- A plugin in Anthropic's directory is submitted from a repository, a plugin path (`plugin`) and a tracked branch or tag. The directory scans every new commit there, on a schedule and, with GitHub's push webhook, on push, and publishes each one that passes (claude.com/docs `plugins/submit`, 2026-10-18).
- Claude Code updates an installed plugin only when `version` in `plugin.json` changes. fixcrash raises it only in a release, from the Release workflow.
- `master` gets the plugin's changes as they land, between releases, under the last release's version.

## Decision

**The directory follows a `release` branch, which the Release workflow moves to each release commit.**

1. The workflow's push step pushes the release commit to `master` and to `release`, with the tag, in one atomic push. The branch only moves forward: a push that isn't a fast-forward fails, and so does the release.
2. Nothing else pushes to `release`.
3. The submission's tracked branch is `release`.

## Options considered

| Option | What the directory sees | Cost |
|--------|-------------------------|------|
| **A: `master`** | Every commit, so unreleased changes are listed under the last version's number, and new installs get code that no release or tag holds | None |
| **B: a tag, such as `v0.1.0`** | Exactly one release | The tag is changed in the portal on every release, by hand |
| **C: a `release` branch (chosen)** | Each release commit, as soon as the workflow pushes it | One more ref in the workflow's push |

## Consequences

- Easier: the listed plugin is always a release, its version matches its tag and its zip, and a release reaches the directory with no step in the portal.
- Harder: the branch appears with the first release after this decision; until then there is nothing to submit with it.
- Revisit: if the directory starts following tags or releases by itself.
