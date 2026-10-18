# ADR-0002: The same failure, and the crashing commit, on iOS

**Status:** Accepted
**Date:** 2026-10-15
**Deciders:** Ilya Seliverstov

## Context

- On Android, a test reproduces a crash when it fails with the crash's exception type, the event's blame frame is on that throwable's stack, and no test frame is above it. The type comes from the event's `exceptions` field; the hook records both from the event, so the agent can't choose them.
- An iOS crash event has no `exceptions` and no build stamp (the iOS testbed's crashes, 2026-10-15):
  - the type is the Mach exception in the issue subtitle, `EXC_BREAKPOINT` for every Swift runtime trap; the Swift message ("Unexpectedly found nil …") is nowhere in the event;
  - `blameFrame` has a reliable `symbol`, an unreliable `file` and `line`, and `address`, the crash's offset in the app binary;
  - Crashlytics drops inlined frames. In a Release build the crashing function is often inlined into its caller, and then the caller is the blame frame: the testbed's parser crash at `ProfileParser.parse(_:)` is blamed on `MainViewController.openProfile()`.
- A unit test runs a Debug build, without inlining. The parser crash's natural test calls `ProfileParser.parse` and never has `openProfile()` on its stack: by today's rule it doesn't reproduce the crash, though it hits the same line with the same input.
- What a failing iOS test gives, on the testbed: the trap kills the test process; `xcodebuild` says `Crash: Testbed at <some XCTest frame>`; the result bundle holds the crash log (`.ips`) as an attachment of the failed test, with the exception type and every thread's frames, each with its image. The app's code is in the image `<App>.debug.dylib`, the test's in `<TestTarget>`. Both XCTest and Swift Testing behave this way.
- `atos -i` at the blame frame's `address`, against the dSYM of a Release build of the crashing commit, gives the whole inline chain: `Swift runtime failure: Unexpectedly found nil while unwrapping an Optional value`, `ProfileParser.parse(_:) (ProfileParser.swift:10)`, `MainViewController.openProfile() (MainViewController.swift:50)`. A rebuild of the same commit at another path gets another UUID, but the same machine code (one instruction of 545,000 differed), and `atos` gave the same chains for all three testbed crashes.
- Constraints: proof is enforced in code (rule 1); the crashing version is the one tested (rule 3); crash data is untrusted (rule 4).

## Decision

**Option C: recover the inline chain at the crashing commit, fall back to the blame frame.**

The expected failure of an iOS event is the Mach exception type and an app frame:

1. The hook records from the event what Android records, plus `blameFrame.address` and the platform. The type is the issue subtitle's Mach exception type.
2. `reproduce` and `verify`, which already check out the crashing commit, build it in the Release configuration for the simulator (once, cached in fixcrash's worktree) and run `atos -i` at the recorded address against that build's dSYM.
3. If the chain's outermost frame is the event's blame frame, the expected frame is the chain's innermost app frame (`ProfileParser.parse(_:)`), skipping the `Swift runtime failure: …` pseudo-frame and Swift library frames. If it isn't (a different toolchain or configuration built the release), or the build fails, the expected frame is the blame frame, and the reason is reported.
4. A test reproduces the crash when its crash log has the same exception type, the expected frame is on the crashed thread (symbols compared without a leading `specialized `), and no frame above it is in the test target's image.

The Swift runtime message from the chain goes into the report and the PR body as a hint; it isn't compared, because the test side doesn't carry it.

**Crashing commit:** the release tag, as for Android builds without a build stamp (`{display}` is `CFBundleShortVersionString`, `{build}` is `CFBundleVersion`), or `--revision`.

## Options considered

### A: The blame frame as it is

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: the Android rule, with the type from the subtitle |
| Crashes it proves | Those whose crashing function wasn't inlined, and those whose test drives the blamed caller |
| Risk | Pushes the reproducer to reach a private caller (`openProfile()` is private): through the UI at best, through a shortcut at worst |
| Fit with the rules | Full |

**Pros:** no build. **Cons:** a correct test of the crashing function fails the check whenever the optimizer inlined it, which Release builds do to small functions all the time.

### B: Accept any frame the blame frame may have inlined

Accept a test whose stack holds a function that the blamed function calls.

| Dimension | Assessment |
|-----------|------------|
| Complexity | High: needs a call graph of the crashing commit |
| Crashes it proves | Many, including wrong ones: any callee of `openProfile()` would do |
| Fit with the rules | Weak: "same failure" turns into "somewhere below the same caller" |

**Cons:** loose where the rule has to be strict. Rejected.

### C: Recover the inline chain at the crashing commit (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: a Release build in the worktree, `atos`, a consistency check |
| Crashes it proves | All of A's, plus crashes in inlined functions |
| Risk | Wrong symbolication if the release was built differently; the check against the blame frame catches a chain that ends elsewhere, not one that is wrong inside |
| Cost | A Release build of the crashing commit, minutes for a real app, once per commit |
| Fit with the rules | Full: the crashing commit, built from its own sources; the address comes from the event through the hook |

**Pros:** the expected frame is where the crash is, as on Android. **Cons:** a build the user didn't ask for; it runs the app's Release build phases, which may do anything Release does (a dSYM upload, for one).

### D: The shipped dSYM

Symbolicate with the dSYM Crashlytics has. The Firebase MCP server has no tool to download it, and asking the user for an archive breaks the one-command flow. Rejected for now.

## Trade-off analysis

A is free and right for crashes the optimizer left alone, and wrong, in a way that pushes toward shortcuts, for those it didn't. C costs one Release build per crashing commit and leans on the build being close to the shipped one; the consistency check and the fallback to A bound the damage when it isn't. C keeps the Android rule's meaning: the test fails where the app failed.

For the crashing commit, a custom key with the commit was considered: it needs a change in the app, and custom keys arrive asynchronously, so crashes in the first second (two of three testbed crashes) have none. The tag fallback already exists.

## Consequences

- Easier: one rule on both platforms; the PR body can quote the Swift runtime message.
- Harder: `reproduce` and `verify` need a Release build for iOS; the runner has to know the app's scheme and Release configuration.
- Not covered yet: `NSException` crashes (Objective-C), which may arrive with `exceptions`; crashes in frameworks the app embeds; device (non-simulator) builds for `atos`, which need the device architecture's dSYM.
- Revisit: after the first real iOS app, and when Firebase MCP offers the uploaded dSYM.

## Action items

1. [x] The hook records `blameFrame.address`, the platform and the Mach exception type for iOS events.
2. [x] `reproduce` and `verify`: Release build at the crashing commit, `atos`, the consistency check, the fallback, the match against the failed test's crash log.
3. [x] Unit tests with fixtures from the testbed: an event, an `atos` chain, a test crash log.
4. [ ] Try an `NSException` crash on the testbed.
