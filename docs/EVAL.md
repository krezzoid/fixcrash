# fixcrash — eval

`/fixcrash:fix` on the three seeded crashes of the Android testbed (`docs/PLAN.md`, step 4). The details behind each finding are in `docs/RESEARCH.md` §7.

## Setup

- **The app.** `testbed/copy-android.sh <dest>` copies `testbed/android` into a git repository of its own. The agent can't read the scenario descriptions there, and the Gradle root is the git root. Tag `v1.0` is the crashing release, and a later commit on `main` starts version 1.1, so the crashing commit is not `HEAD`.
- **The crashes.** The `v1.0` release APK, installed on an emulator, crashed once per scenario through `testbed/android/trigger-crash.sh`. Every event carries the `v1.0` commit in its build stamp.
- **Pull requests** go to a private GitHub repository holding the copy.
- **A run** is one fresh Claude Code session in auto mode, in the copy, on `main`: `claude --plugin-dir <fixcrash checkout>`, then `/fixcrash:fix <issue id>`.
- **Metrics** come from the session transcripts: `node eval/metrics.ts <copy dir>`. Agent time leaves out the waits for the user, including answers to the agent's questions. Cost is what Claude Code records.

## Results, 2026-10-08

Claude Code 2.1.294, `claude-opus-5-5`, firebase-tools 15.32.1, AGP 9.4.1, Gradle 9.6.

| Scenario | Crash | Expected | Outcome | `reproduce` runs | Verified | PR | Agent time | Tool calls | Cost |
|----------|-------|----------|---------|------------------|----------|----|------------|------------|------|
| parser | `NullPointerException` at `ProfileParser.parse` | PR | ✅ PR | 1 | yes | yes | 1m 41s | 20 (6 in the reproducer) | $0.73 |
| paging | `IndexOutOfBoundsException` at `FeedPager.page` | PR | ✅ PR | 1 | yes | yes | 1m 24s | 21 (5 in the reproducer) | $0.65 |
| lifecycle | `IllegalStateException` at `DetailsFragment.onDetailsLoaded` | report, no PR | ✅ report, no PR | 0 | - | no | 1m 11s | 13 (3 in the reproducer) | $0.59 |

Earlier runs, before fixes they led to:

| Scenario | Outcome | Agent time | Tool calls | Cost | What changed |
|----------|---------|------------|------------|------|--------------|
| parser | ✅ PR | 4m 03s | 29 (7 in the reproducer) | $1.75 | On Claude Code 2.1.293, which switched from `claude-opus-5` to `claude-sonnet-5` mid-run while updating itself. Four tool calls went to looking for the plugin options: the skills now give each option's default |
| lifecycle | ❌ PR on a false proof | 1m 58s | 20 (5 in the reproducer) | $0.77 | The test built the fragment with `Unsafe.allocateInstance` and called the private callback through reflection. `reproduce` and `verify` now refuse such shortcuts |

## Findings

1. **"Same exception, same top frame" is necessary, not sufficient.** Reflection and constructor bypass reach any frame from a state the app is never in. `reproduce` and `verify` now refuse a test whose new lines build an object without its constructor or open a private member; the reproducer is told to reach the crash the way the app does, and to name what's missing (Robolectric) when it can't.
2. **The honest path works.** Without a shortcut, the lifecycle run ended in a report: the cause, why a JVM test can't reach it, the test setup that would, and a defensive change described and not committed.
3. **Unset plugin options stay as placeholders.** With `--plugin-dir`, `${user_config.*}` isn't substituted and the manifest defaults aren't applied. The skills now carry each default.
4. **A reproducing test checks the crash, not always the behavior after the fix.** Both parser tests assert only the profile id, so they show the crash is gone, not what the profile holds without an avatar; the two runs chose different fixes (an empty URL, a nullable one). The paging test asserts the last page's items.
5. **The agent doesn't always ask in prose.** On Claude Code 2.1.294 it asked before pushing with the `AskUserQuestion` tool. In the false-proof run it said the test was narrow only after opening the PR; the fix skill now asks it to say what the test covers before it asks to push.

## Open

Tracked in `docs/PLAN.md`, deferred list:

- Robolectric in a module without it: for now the report carries the setup as a build-file diff (`docs/adr/0001-test-libraries-the-module-lacks.md`).
- A NOT REPRODUCED answer with no `fixcrash reproduce` run. Fine with a concrete reason, as here; a lazy answer looks the same.
- `claude plugin eval` (`RESEARCH.md` §9, question 7): this eval ran by hand, with `eval/metrics.ts`.
- The share of a real app's top crashes a unit test can reproduce (`RESEARCH.md` §9, question 3).
