# ADR-0001: Test libraries the module lacks

**Status:** Accepted
**Date:** 2026-10-08
**Deciders:** Ilya Seliverstov

## Context

- fixcrash proves a fix with a JVM unit test that fails at the crashing commit. `reproduce` and `verify` put the test source files on that commit; its build files stay as they were.
- Lifecycle crashes, such as "Fragment not attached to a context" or a transaction after `onSaveInstanceState`, are among the most common Android crashes. Without Robolectric, a JVM test can't even construct a fragment whose field needs `Looper.getMainLooper()`, let alone run its lifecycle.
- In the eval (`docs/EVAL.md`), the testbed's lifecycle crash ended in a report. An earlier run reached it by building the fragment without its constructor; `reproduce` and `verify` now refuse that.
- Robolectric with `fragment-testing` reaches such a crash the way the app does: open the fragment, move it to `DESTROYED`, advance the main looper past the delayed callback.
- The crashing commit is a past release. A test setup added on `main` today isn't there, so a test that needs it doesn't compile at the crashing commit. Adding the setup on `main` alone helps only crashes from releases built after it.
- Constraints: proof is enforced in code (rule 1); tests run offline where the build tool allows (rule 8); the plugin works in someone else's repository, so every dependency it adds is a supply-chain and review cost for that team.
- Unknown: the share of a real app's crashes that need a test library its modules lack.

## Decision

**Option A for now.** The agent uses only the test libraries the module has at the crashing commit. When one it lacks would reach the crash, the report gives that setup as a build-file diff: described, never applied.

Revisit after the first real app shows how many of its crashes need a missing test library. If enough do, implement option B as designed below.

## Options considered

### A: Only what the module has; the report carries the setup

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: one field in the reproducer's answer and one line in the report |
| Crashes it fixes | None that need a missing library: they end in a report |
| Risk to the user's project | None: no build change |
| Fit with the rules | Full: the crashing commit is used as it is, runs stay offline |

**Pros:** nothing new to trust or maintain; the report tells the team exactly what to add.
**Cons:** lifecycle crashes stay reports even when the cause is clear; once the team adds the setup, only crashes from later releases become reproducible.

### B: A setup commit with the user's consent, applied at the crashing commit

- A separate setup commit, made only after the user agrees.
- `reproduce --setup <commit>` and `verify --setup <commit>` apply its diff at the crashing commit and at the fix parent, or fail saying it doesn't apply. The receipt and the PR body name it, so a reviewer sees the build change on its own.
- A check in code: the commit touches only Gradle files and the version catalog, and adds only `testImplementation`, `testRuntimeOnly`, `testOptions`/`unitTests` and catalog entries, plus `debugImplementation` of `fragment-testing-manifest`.
- An allowlist of artifacts: `org.robolectric:*`, `androidx.test:*`, `androidx.fragment:fragment-testing*`, `androidx.arch.core:core-testing`.
- An exception to offline runs for the first one, which downloads the dependencies and Robolectric's android-all jar.
- A testbed scenario that stays out of reach even with Robolectric, such as a thread race, since lifecycle would no longer be one.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: two or three sessions, mostly in `reproduce`, `verify` and their tests |
| Crashes it fixes | Lifecycle and other framework-bound crashes, from any release |
| Risk to the user's project | A build change in the PR, as its own commit; a test-scope check that reads text; Robolectric may lag the newest SDK and need `@Config(sdk = …)` |
| Fit with the rules | The crashing commit gets a build change, app code untouched; the first run needs the network |

**Pros:** an honest proof for the most common crash family; the test exercises the real fix (cancel the callback), not a defensive guard.
**Cons:** build changes in someone else's project; heuristic checks to maintain; network on the first run.

### C: The agent adds the setup on its own

Option B without asking.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium, as B |
| Crashes it fixes | As B |
| Risk to the user's project | High: dependencies an agent chose, pulled in without review |
| Fit with the rules | Poor: nobody agreed to the build change |

**Pros:** no interruption.
**Cons:** no team would accept it. Rejected.

## Trade-off analysis

B's value hangs on a number we don't have: how many real crashes need a test library the module lacks. Many mature apps already have Robolectric, and option A uses it there. A costs nothing and keeps every rule intact. B costs a few sessions and bends two rules: the crashing commit is no longer used as it is, and the first run needs the network. Taking A now and B with data keeps B open, at the price of lifecycle crashes in modules without Robolectric ending in reports meanwhile.

## Consequences

- Easier: nothing new in `reproduce` and `verify`, no dependency policy to keep current.
- Harder: in modules without Robolectric, a lifecycle crash ends in a report even when its cause is clear.
- Revisit: after the first real app ([known limits](../LIMITS.md#android)).

## Action items

1. [x] The reproducer's NOT REPRODUCED answer and the fix skill's report carry the setup as a build-file diff.
2. [ ] On a real app, count the top crashes that need a test library the module lacks.
3. [ ] If enough do, implement option B as designed above.
