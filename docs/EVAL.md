# fixcrash — eval

`/fixcrash:fix` on the seeded crashes of each testbed, run as each platform was built: Android, then iOS, then a SwiftUI app, then React Native. What the findings left open is in [LIMITS.md](LIMITS.md).

# Android

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

Tracked in [LIMITS.md](LIMITS.md):

- Robolectric in a module without it: for now the report carries the setup as a build-file diff (`docs/adr/0001-test-libraries-the-module-lacks.md`).
- A NOT REPRODUCED answer with no `fixcrash reproduce` run. Fine with a concrete reason, as here; a lazy answer looks the same.
- `claude plugin eval`: this eval ran by hand, with `eval/metrics.ts`.
- The share of a real app's top crashes a unit test can reproduce.

# iOS

## Setup

As for Android, with these differences:

- **The app.** `testbed/copy-ios.sh <dest>` copies `testbed/ios` (Swift, UIKit, Crashlytics through SPM); tag `v1.0` is the crashing release, `main` starts 1.1.
- **The crashes.** The testbed's Release build crashed once per scenario on the iOS 27.0 simulator, through `testbed/ios/trigger-crash.sh`. iOS events carry no commit: tag `v1.0` links version `1.0 (1)` to it. In all three, the blame frame is what Crashlytics shows of a release build: for parser and paging, the caller the crashing function was inlined into.
- **Runs** go back to `main` between scenarios; when one didn't, the agent asked first.

## Results, 2026-10-15

Claude Code 2.1.300, `claude-opus-5-5`, firebase-tools 15.32.1, Xcode 27.0, Firebase iOS SDK 13.0.1.

| Scenario | Crash (blame frame) | Expected | Outcome | `reproduce` runs | `verify` runs | PR | Agent time | Tool calls | Cost |
|----------|---------------------|----------|---------|------------------|---------------|----|------------|------------|------|
| parser | `EXC_BREAKPOINT` at `MainViewController.openProfile()`, crash in `ProfileParser.parse(_:)` | PR | ✅ PR | 1 | 2: wrong test id, verified | yes | 7m 16s | 20 (4 in the reproducer) | $0.80 |
| paging | `EXC_BREAKPOINT` at `MainViewController.loadMore()`, crash in `FeedPager.page(_:)` | PR | ✅ PR | 1 | 3: wrong test id, unreadable result, verified | yes | 9m 58s | 30 (4 in the reproducer) | $0.91 |
| lifecycle | `EXC_BREAKPOINT` at `closure #1 in SyncService.start(completion:)` | report, no PR | ✅ report, no PR | 1 | - | no | 2m 16s | 15 (4 in the reproducer) | $0.66 |

## Findings

1. **Crash sites from the crashing commit's own build work (ADR-0002).** For parser and paging, `reproduce` built `v1.0` in Release, read the frames at the event's address, and expected `ProfileParser.parse(_:)` and `FeedPager.page(_:)` instead of their callers. Each reproducer wrote a direct test of that function and reproduced the crash on its first attempt. The pull requests quote the crash site (`the crash is in FeedPager.page(_:)(FeedPager.swift:16), inlined into MainViewController.loadMore() (Swift runtime failure: Array index is out of range)`).
2. **The honest path holds on iOS.** The lifecycle reproducer reached the exact state (upload done, task still open) in one attempt, saw that only the system calls an expiration handler, and stopped: more attempts couldn't get past it. The report named the cause, the missing seam (an injected wrapper around the background task), a UI test that might reach it, and a defensive change, not committed.
3. **An iOS fix took four to seven times as long as an Android one.** A run builds the app, a crashing test takes 20 to 30 s, and `verify` makes three runs. Worse, `xcodebuild` hung after a crashing test in about half the runs, and each hang cost the 2-minute timeout (the parser's fix-parent run took 154 s). The hangs came from the diagnostics `xcodebuild` collects after a failure: with `-collect-test-diagnostics never`, which fixcrash now passes, four crashing runs out of four went through, against two of four before, and the crash log is still attached. The parser's `verify` then took 37 s instead of 6.5 minutes.
4. **Three bugs, now fixed.**
   - The hangs above.
   - Both main sessions first passed `verify` the test id in xcodebuild's form, `TestbedTests/ProfileParserTests/testParsesProfileWithoutAvatar`, as in the fix skill's `-only-testing` example. `reproduce` and `verify` now take that form too.
   - A test step whose retry hung as well left a result bundle without its `Info.plist`; reading it made `verify` exit 2 (paging's second `verify`). Unfinished bundles are now skipped, and such a run says it didn't run.
5. **The PR body was edited after the guard let the PR through.** The paging session appended Claude Code's attribution line with `gh pr edit`, from the user's settings. The guard checks creating a PR, not editing one; the receipt's proof was untouched.

# SwiftUI

## Setup

As for iOS, with these differences:

- **The app.** `testbed/copy-ios.sh swiftui <dest>` copies `testbed/swiftui` (the SwiftUI `App` lifecycle, Crashlytics through SPM).
- **The crashes.** The testbed's Release build crashed once per scenario on the iOS 27.0 simulator, through `testbed/swiftui/trigger-crash.sh`; for action, Claude tapped Archive through Claude Code's iOS Simulator tool. In all three, the blame frame is the app frame that crashed: nothing was inlined into it.
- One false start isn't counted: a session given another app's issue id, which stopped at "Login expired". The render session also began with a login, so its wall time includes it.

## Results, 2026-10-16

Claude Code 2.1.301, `claude-opus-5-5`, firebase-tools 15.32.1, Xcode 27.1 with the iOS 27.0 simulator, Firebase iOS SDK 13.0.1.

| Scenario | Crash (blame frame) | Expected | Outcome | `reproduce` runs | `verify` runs | PR | Agent time | Tool calls | Cost |
|----------|---------------------|----------|---------|------------------|---------------|----|------------|------------|------|
| render | `EXC_BREAKPOINT` at `closure #1 in closure #1 in TagsView.body.getter`, a `ForEach` row | PR | ✅ PR | 1 | 1 | yes | 3m 52s | 18 (4 in the reproducer) | $0.81 |
| async | `EXC_BREAKPOINT` at `InboxModel.load()`, after an `await` | PR | ✅ PR | 1 | 1 | yes | 3m 10s | 20 (4 in the reproducer) | $0.73 |
| action | `EXC_BREAKPOINT` at `closure #1 in closure #2 in ArchiveView.body.getter`, a toolbar button's action | report, no PR | ✅ report, no PR | 0 | - | no | 1m 18s | 14 (3 in the reproducer) | $0.64 |

## Findings

1. **The SwiftUI guidance was enough.** The render reproducer opened the screen through the app's own entry, `ContentView(screen: .tags)`, in a window on the app's scene, and let the run loop lay out the list; the async one added a test to the existing `InboxModelTests` that injects an empty `fetch` and awaits `load()`. Both reproduced on their first attempt, and the main session accepted each test as reaching the crash the way the app does.
2. **The fastest iOS runs so far.** Three to four minutes of agent time for a PR, against seven to ten on the UIKit testbed. Each `verify` made its three runs in 8 to 14 s each, with no hang and no retry, and each session got the test id right the first time.
3. **The action report came without a single run.** The reproducer saw that the crash is in a button's action on `private @State`, ruled out private accessibility calls, reflection and swizzling on its own (the shortcut rule never fired), and answered NOT REPRODUCED with its budget untouched. The report gave the cause and three ways to reach it: the logic moved into an `ArchiveModel` (recommended, as the testbed's other screens do), a UI test, or ViewInspector as a project diff, described and not applied; then a breadcrumb that would tell "never selected" from "tapped twice", and a defensive change, not committed.
4. **Nothing to fix in fixcrash.** No hook denials, no PR edited after the guard; both PR bodies carry the crash site line from the release build.
5. **For review, not for fixcrash.** The render test asserts nothing: it passes as long as the screen renders. As a crash regression test that's enough, but a reviewer may want the rows checked. The async fix gives an empty inbox an empty headline, a product choice the PR leaves to its reviewer.

# React Native

## Setup

As for Android and iOS, with these differences:

- **The app.** `testbed/copy-rn.sh <dest>` copies `testbed/react-native` (React Native 0.88 with Hermes, React Native Firebase 26.4) and installs its `node_modules` from npm's cache. Tag `v1.0` is the crashing release; `main` starts 1.1.
- **The crashes.** They were reported on 2026-10-16, from the testbed's release builds on an Android emulator and the iOS 27.0 simulator. JS events carry no commit, so tag `v1.0` links version `1.0 (1)` to it.
  - On Android, parser, render and engine are events of one issue, `JavascriptException` blamed on `ExceptionsManagerModule.reportException`. Async is a non-fatal `JavaScriptError` issue of its own.
  - One more run fixed the iOS parser issue, to cover the iOS bundle.
- **Runs.** `/fixcrash:triage <Android app id>` came first. Then each scenario ran `/fixcrash:fix <issue> <app id> <the error as triage named it>`, as a user would pick from the triage table: for example, `Cannot read property 'url' of undefined at src/profile.ts:15`.
- Before the runs, the skills' examples that named testbed scenarios (`TagList`, `parsesProfileWithoutAvatar`) were replaced with neutral ones (`f10dbd4`). The Android and iOS evals ran with them.

## Results, 2026-10-17

Claude Code 2.1.302, `claude-opus-5-5`, firebase-tools 15.32.1, React Native 0.88.0, Node 24.21, npm 11.

| Scenario | Crash (where `symbolicate` placed it) | Expected | Outcome | `reproduce` runs | `verify` runs | PR | Agent time | Tool calls | Cost |
|----------|---------------------------------------|----------|---------|------------------|---------------|----|------------|------------|------|
| triage | 4 JS errors in 2 issues | a table | ✅ parser, render, async likely; engine unlikely | - | - | - | 59s | 10 | $0.64 |
| render | `TypeError` at `src/TagList.tsx:19`, Android, fatal | PR | ✅ PR | 1 | 1 | yes | 1m 45s | 20 (3 in the reproducer) | $1.04 |
| parser | `TypeError` at `src/profile.ts:15`, Android, fatal | PR | ✅ PR | 1 | 1 | yes | 1m 58s | 20 (4 in the reproducer) | $1.01 |
| engine | `RangeError` at `src/updates.ts:13`, Android, fatal | report, no PR | ✅ report, no PR | 1 | - | no | 2m 06s | 16 (5 in the reproducer) | $0.86 |
| async | `JavaScriptError`, no type, at `src/inbox.ts:14`, Android, non-fatal | PR | ✅ PR | 1 | 1 | yes | 1m 57s | 18 (4 in the reproducer) | $0.71 |
| parser, iOS | `TypeError` at `src/profile.ts:15`, iOS, fatal | PR | ✅ PR | 1 | 1 | yes | 2m 35s | 20 (6 in the reproducer) | $0.73 |

## Findings

1. **Symbolication made the JS errors readable, and the check exact.**
   - Every session placed its error with `fixcrash symbolicate` before any test: `?anon_0_@1:698961` became `loadHeadline` at `src/inbox.ts:14`, and `anonymous@1:665004` became `src/TagList.tsx:19`.
   - Each reproducer reproduced on its first attempt, matched by type, file and line.
   - Each `verify` passed on its first run, 0.6 to 1.7 s per commit. A PR took under two minutes of agent time, as on Android.
2. **Triage split the shared Android issue.** It read the issue's six events and gave each JS error its own row, placed in the sources. It called the engine error unlikely for the right reason: Hermes rejects the date format, and Node doesn't.
   - It also spotted an event from an earlier build with the same version, `1.0 (1)`. That event's offsets are about 141 columns off, so symbolicated at `v1.0` it lands in `react-native-safe-area-context`. Triage and the render session both told it apart by its message and component stack.
   - A version number doesn't pin a bundle, and the tagged commit's map doesn't fit such events.
3. **The engine scenario has a path on Node, and only the reproducer's judgment kept it out.**
   - The app's format check accepts years 0013 to 0031, which V8 rejects too: `new Date('0013/01/01 10:00').toISOString()` throws the crash's `RangeError` at `src/updates.ts:13`. fixcrash would have accepted such a test, since the type and the line match, though the backend never sends such a date.
   - The reproducer found it, called it the right line for the wrong reason, and didn't submit it. Its report named the cause (Hermes's date parser), the two ways to reach it (a test on Hermes, or app code that doesn't depend on the engine), and a defensive change, not committed.
   - As with native frames (Android, finding 1), the same type at the same line is necessary, not sufficient. The testbed's claim that Node parses every string the check accepts was wrong.
4. **One bug, two platforms, two issues, two pull requests.** The parser crash is one event in Android's shared issue and an iOS issue of its own, and its two sessions opened PR #2 and PR #4 with the same fix. Triage works per app, so it can't see this. Matching JS errors across apps by their symbolicated file and line would.
5. **The React Native guidance in the skills held.**
   - Each JS error got its own branch (`fixcrash/77ff1260-taglist-19`, `fixcrash/77ff1260-profile-15`), named from the arguments.
   - The async test awaited `loadHeadline` itself.
   - The tests mocked nothing beyond the app's Jest setup. The render test renders `TagList` with the app's own backend data, as the app does.
   - There were no hook denials, and no PR was edited after the guard.
6. **For review, not for fixcrash.**
   - The Android parser test asserts only that parsing doesn't throw, as on Android.
   - The render fix shows "5 tags" above 3 rows, and the async fix gives an empty inbox a placeholder headline. Each is a product choice the PR names.
   - The render session added an assertion after the reproducer's run, and `verify` proved the edited test.
