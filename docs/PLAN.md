# fixcrash — plan

## Status

| # | Step | Done when | Status |
|---|------|-----------|--------|
| 0 | Research, repository, CLAUDE.md | `docs/RESEARCH.md`, `CLAUDE.md`, this plan | ✅ 2026-10-07 |
| 1 | **Spike: Android testbed** | `testbed/android` has a small Kotlin app with the three seeded crashes below. Each one is reported to a Firebase project from an emulator, and read by hand through Firebase MCP in Claude Code. Open questions 1, 2, 4 and 5 in `RESEARCH.md` §9 are answered in §7 | ⬜ |
| 2 | `bin/fixcrash verify` | Fail-before / pass-after / suite-green with the "same failure" check (exception type and top app frame), a receipt bound to the commit, unit tests. Includes `commit-for-version` | ⬜ |
| 3 | Plugin skeleton | Manifest with `userConfig`, marketplace, `.mcp.json` with pinned firebase-tools, skills `triage` and `fix`, subagent `reproducer`, PR guard hook. `claude plugin validate .` passes | ⬜ |
| 4 | Eval on the testbed | Per scenario: reproduced or not, verified, PR opened, wall time, tool calls. The non-reproducible scenario ends in a report and no PR | ⬜ |
| 5 | React Native | Jest path, plus symbolication of JS stacks from source maps for the crashing commit; an RN testbed | ⬜ |
| 6 | iOS (Swift) | `swift test` and `xcodebuild test -only-testing` paths; an iOS testbed | ⬜ |
| 7 | Publish | README, MIT LICENSE, public repository, marketplace install instructions, a short demo; consider Anthropic's plugin directory | ⬜ |

## Testbed scenarios (Android, step 1)

1. **Parser:** a `!!` or NPE on an optional JSON field that the backend started to omit. Reproducible with a JVM unit test.
2. **Paging:** an `IndexOutOfBoundsException` at a page boundary. Reproducible with a JVM unit test.
3. **Lifecycle:** `IllegalStateException: Fragment not attached to a context`, from a callback after the user leaves the screen. **Not** unit-reproducible. The expected outcome is an honest report and no PR.

## Deferred

- Crash-pattern memory: faster on the second similar crash.
- Sentry as a second crash source (Sentry MCP); the issue → event → stack shape is the same.
- Headless runs in CI (`claude -p`) on new top issues.
- Real network isolation for test runs, beyond `--offline`.
- Measure the unit-reproducible share on a real production app's top crashes. This needs access to one.
