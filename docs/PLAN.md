# fixcrash — plan

## Status

| # | Step | Done when | Status |
|---|------|-----------|--------|
| 0 | Research, repository, CLAUDE.md | `docs/RESEARCH.md`, `CLAUDE.md`, this plan | ✅ 2026-10-07 |
| 1 | **Spike: Android testbed** | `testbed/android` has a small Kotlin app with the three seeded crashes below. Each one is reported to a Firebase project from an emulator, and read by hand through Firebase MCP in Claude Code. Open questions 1, 2, 4 and 5 in `RESEARCH.md` §9 are answered in §7 | ✅ 2026-10-07 |
| 2 | `bin/fixcrash verify` | Fail-before / pass-after / suite-green with the "same failure" check (exception type and top app frame), a receipt bound to the commit, unit tests. Includes `commit-for-version` | ✅ 2026-10-07: `verify` (base, fix parent, head, in its own worktree), receipt, `commit-for-version`, `receipt`; 36 unit tests. Parser and paging verified end to end with Gradle on a copy of the testbed |
| 3 | Plugin skeleton | Manifest with `userConfig`, marketplace, `.mcp.json` with pinned firebase-tools, skills `triage` and `fix`, subagent `reproducer`, PR guard hook. `claude plugin validate .` passes | ✅ 2026-10-08: plugin files; one hook process: redaction of Crashlytics results before the model sees them, expected failures recorded from events, PR guard, `.git/fixcrash` write ban, test-only reproducer; `fixcrash reproduce` with attempt and hypothesis budgets in code; 74 unit tests. Hook checked live in a Claude Code session; reproduce, verify and pr-body end to end with Gradle on a testbed copy. `/fixcrash:fix` as a whole runs in step 4 |
| 4 | Eval on the testbed | Per scenario: reproduced or not, verified, PR opened, wall time, tool calls. The non-reproducible scenario ends in a report and no PR. The agent works on a copy of `testbed/android` made its own git repository: it can't read the scenario descriptions, and AGP can write the commit into release builds (`RESEARCH.md` §7) | ✅ 2026-10-08: parser and paging end in a verified PR, lifecycle in a report and no PR, each in under two minutes of agent time for under $1 (`docs/EVAL.md`). A first lifecycle run passed the "same failure" check with a test that bypassed the constructor and used reflection: `reproduce` and `verify` now refuse such shortcuts. Copy: `testbed/copy-android.sh`; metrics: `eval/metrics.ts` |
| 5 | React Native | Jest path, plus symbolication of JS stacks from source maps for the crashing commit; an RN testbed | ⬜ |
| 6 | iOS (Swift) | `swift test` and `xcodebuild test -only-testing` paths; an iOS testbed | ⬜ |
| 7 | Publish | README, MIT LICENSE, public repository, marketplace install instructions, a short demo; consider Anthropic's plugin directory | ⬜ |

## Testbed scenarios (Android, step 1)

1. **Parser:** a `!!` or NPE on an optional JSON field that the backend started to omit. Reproducible with a JVM unit test.
2. **Paging:** an `IndexOutOfBoundsException` at a page boundary. Reproducible with a JVM unit test.
3. **Lifecycle:** `IllegalStateException: Fragment not attached to a context`, from a callback after the user leaves the screen. **Not** reproducible by a JVM unit test. The expected outcome is an honest report and no PR. Risk: Robolectric with `FragmentScenario` and a paused main looper can probably reproduce it. Step 4 decides whether the agent may add Robolectric to a project that doesn't have it. If it may, `verify` has to apply that build-file change at the crashing commit too: today it overlays test sources only. In the first eval run the reproducer took another way: it built the fragment with `Unsafe.allocateInstance` and called the private callback by reflection, which passed the "same failure" check. `reproduce` and `verify` now refuse such shortcuts (`RESEARCH.md` §7).

The app, triggers and setup: `testbed/android/README.md`.

## Deferred

- Crash-pattern memory: faster on the second similar crash.
- Sentry as a second crash source (Sentry MCP); the issue → event → stack shape is the same.
- Headless runs in CI (`claude -p`) on new top issues.
- Real network isolation for test runs, beyond `--offline`.
- Measure the unit-reproducible share on a real production app's top crashes. This needs access to one.
- From step 3:
  - `--base` is the agent's word. `verify` could check it against the build stamp revision recorded from the event, when there is one.
  - The hook spots state writes and PR commands by their text. A command that builds the path or the command in a variable gets past it; so does a pull request opened on the web after `git push`. The threat is a careless agent, not a hostile one.
  - The reproducer's Bash can still edit app code (`sed -i`); only Write and Edit are held to test files.
  - The guard turns on per repository, for sessions that read crash events and for `fixcrash/` branches. A PR from another branch in a later session isn't checked.
  - A Robolectric test counts as a JVM test, but adding Robolectric to a module is a build change, which `reproduce` and `verify` don't apply at the crashing commit (see the lifecycle scenario).
- From step 4:
  - Robolectric in a module that doesn't have it: for now the report carries the setup as a build-file diff. Revisit after the first real app; the options and the design for applying it with the user's consent are in `docs/adr/0001-test-libraries-the-module-lacks.md`.
  - The reproducer may answer NOT REPRODUCED without a single `fixcrash reproduce` run. Fine with a concrete reason, as in the lifecycle run, but a lazy answer looks the same. Requiring one run would put tool output in every report.
  - `claude plugin eval` (`RESEARCH.md` §9, question 7) wasn't tried: the eval ran by hand, measured with `eval/metrics.ts`.
  - The shortcut check (`src/shortcut.ts`) reads the new lines of the changed test files. A mock of the class under test (Mockito and MockK build it without its constructor) is caught by the reproducer's rules only, not in code. A shortcut in a helper outside the changed test files, or written another way, gets past it.
- From step 2: the Gradle unit test task is fixed to `testDebugUnitTest`. Flavored apps need `test<Flavor>DebugUnitTest`, and plain JVM modules (task `test`) are left out of the suite. Make it configurable when a real app needs it.
