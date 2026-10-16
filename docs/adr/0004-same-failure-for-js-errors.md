# ADR-0004: The same failure for a React Native JS error

**Status:** Accepted
**Date:** 2026-10-16
**Deciders:** Ilya Seliverstov

## Context

- A test reproduces a native crash when it fails with the crash's exception type, at the crash's top app frame, with no test frame above it (`docs/RESEARCH.md` §6, ADR-0002). The hook records both from the event, so the agent can't choose them.
- A JS error in a React Native app reaches Crashlytics in two shapes (`RESEARCH.md` §7, step 6.3):
  - **A fatal one is a native crash.** Android: `com.facebook.react.common.JavascriptException`. iOS: `RCTFatalException`. Its message holds the JS error's type, Hermes's message and the JS stack as `<function>@1:<column>` lines: `TypeError: Cannot read property 'url' of undefined, stack:` `parseProfile@1:485277` `anonymous@1:708373`.
    - On Android every fatal JS error lands in one issue, blamed on `ExceptionsManagerModule.reportException`. The blame frame says nothing about the crash. Neither does the issue: parser, engine and render are three events of one issue.
  - **A non-fatal one** (`recordError`, and on iOS the chained copy of a fatal one) is React Native Firebase's `JavaScriptError`. It has the message and frames, `.?anon_0_ (address at index.android.bundle:1:698961)` on Android and `parseProfile (address at <container>/main.jsbundle:1:484854:1)` on iOS. It does not have the JS error's type.
- A position is a Hermes bytecode offset, on line 1. Only the crashing commit's composed source map (Metro's map composed with the Hermes compiler's) gives a file and line. The names in the event aren't the source's:
  - the Hermes compiler inlines (`anonymous@1:708373` is `prepare`, which it inlined into a timer's closure);
  - async functions run as anonymous generators after their first `await` (`?anon_0_` is `loadHeadline`).
- What a rebuild gives (step 6.4):
  - The testbed's bundle, Hermes bytecode and composed map rebuilt from the committed sources at another path took 3.5 s with `node_modules` in place. The Android bytecode was byte-identical to the APK's. The iOS bytecode differed in 40 of 1,108,924 bytes. Both maps matched the shipped ones in everything but the absolute paths in `sources`.
  - `metro-symbolicate` turns `parseProfile@1:485277` into `src/profile.ts:15:parseProfile`, `?anon_0_` into `src/inbox.ts:14:loadHeadline`, and the render crash's top frame into `src/TagList.tsx:19:Array.from$argument_1`. A frame's name is its enclosing function in the source, from Metro's function map. It gives no column for these lines. It stops at a `(native):0:0` frame, and can't read iOS's trailing `:1`.
- What a failing Jest test gives: a thrown error with its `name` (`TypeError`), V8's message, and a stack that Jest maps through Babel's source maps. Files and lines are right. A frame's name is the identifier at the mapped position, not its function: `at url (src/profile.ts:15:62)`, `at title (src/inbox.ts:14:28)`, `at label (src/TagList.tsx:19:25)`.
- Messages differ by engine ("Cannot read property 'url' of undefined" against "Cannot read properties of undefined (reading 'url')"). The rule never compares them.
- A test that swaps `Date` for its own (`jest.spyOn(global, 'Date')`) throws the engine scenario's `RangeError` at `src/updates.ts:13`, the line Hermes crashes on. Node never does, from any input that passes the app's check.
- Constraints: proof is enforced in code (rule 1); the crashing version is the one tested (rule 3); crash data is untrusted (rule 4).

## Decision

**Option B: the JS error type when the event has one, and the top app frame's file and line after symbolication.**

1. The hook records, per event, the JS stack's positions and, from a native crash's message, the JS error type. For a native crash, the positions are the `<function>@1:<column>` lines; for a non-fatal, the `address at <bundle>:1:<column>` frames, with iOS's trailing `:1` dropped. `(native)` frames and Hermes's `InternalBytecode.js` frames are skipped. The platform says which bundle the positions are in.
2. `reproduce` and `verify` build the crashing commit's bundle, Hermes bytecode and composed map for that platform, once per commit and platform, cached next to the worktree. They symbolicate the recorded positions. The expected frame is the first one in the app's own sources: under the project, not under `node_modules`, not a test file. It is kept as a path and a line.
3. A test reproduces the crash when one of its failures:
   - is an error of the event's JS type, when the event has one;
   - has a frame at the expected path and line;
   - has no frame from a test file above it.
4. When the event has no type (a non-fatal), the type isn't compared, and the report and the PR body say so.

Each JS event is its own expected failure: a run names the event it reproduces, since an issue may hold several crashes. On iOS the native crash and its non-fatal copy name the same frame.

**Crashing commit:** the release tag. JS events carry no build stamp (`RESEARCH.md` §7, step 6.3).

## Options considered

### A: Function names, as on Android and iOS

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low |
| Crashes it proves | Few: Hermes's names are inlined or anonymous, and Jest's are identifiers |
| Fit with the rules | Full, but it fails correct tests |

**Cons:** the parser test fails with `at url (src/profile.ts:15:62)`, the event says `parseProfile`. Rejected.

### B: The JS error type when known, and the file and line after symbolication (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: a bundle, a Hermes compile and a map composition per crashing commit, then `metro-symbolicate` |
| Crashes it proves | All three Jest-reproducible testbed scenarios, the async one included |
| Risk | Two different errors on one line with one type look the same. A non-fatal has no type to compare |
| Cost | Seconds per commit with `node_modules` in place (ADR-0005) |
| Fit with the rules | Full: the crashing commit, built from its own sources; the positions come from the event through the hook |

**Pros:** the test fails where the app failed, whatever each engine calls the function. **Cons:** line granularity. A non-fatal's check is weaker than a fatal's.

### C: Compare messages across engines

Map Hermes's messages to V8's ("Cannot read property 'x' of undefined" ↔ "Cannot read properties of undefined (reading 'x')").

| Dimension | Assessment |
|-----------|------------|
| Complexity | High: a table per error kind and engine version |
| Risk | Message text is untrusted input (rule 4) and changes between engine versions |

**Cons:** the rule has never compared messages, for good reasons. Rejected.

### D: The source map the release build made

The Android build leaves one in its build directory; an iOS build makes one only if told to. Few teams keep them per release, and the Firebase MCP server has none. A rebuild gives the same mappings (step 6.4). Kept as a later option: a `--sourcemap` flag for teams that archive them.

## Trade-off analysis

A is the existing rule and fails every correct JS test. C trades a structural check for text matching on untrusted input. B keeps the rule's meaning (the crash's type, where the app crashed, with no test code above it) and changes how "where" is read: by source position after symbolication, since neither engine's names can be trusted. Its cost is a rebuild of the crashing commit's bundle, the same price ADR-0002 pays for iOS, and here it costs seconds rather than minutes.

## Consequences

- Easier: one check for both event shapes and both platforms. The symbolicated stack makes a readable report and PR body.
- Harder: runs start from an event, not an issue. Triage of an Android app has to read the events of `ExceptionsManagerModule.reportException` to tell its crashes apart, and that needs each version's map. The bundle build needs the app's `node_modules` at the crashing commit (ADR-0005).
- New shortcut rule: a test that swaps a built-in (`Date`, `Intl`, `Math`, …) for its own, through `jest.spyOn(global, …)` or assignment, reaches crashes the app's engine has and Node doesn't. It proves nothing about the app.
- Not covered yet: Expo apps (another bundle command), apps that turn Hermes off, an app's own native module crashing.
- Revisit: after the first real React Native app, and if Crashlytics or React Native Firebase start symbolicating JS stacks.

## Action items

1. [ ] The hook records JS positions, the type when present, and the platform, per event; `fixcrash event` shows them.
2. [ ] `fixcrash symbolicate`: build the crashing commit's bundle and map per platform, cache them, run `metro-symbolicate` from the app's `node_modules`.
3. [ ] The Jest runner: failures from `--json`, V8 stack frames, the match by type, path and line, the test-file rule.
4. [ ] The built-in swap shortcut rule.
5. [ ] Unit tests with fixtures written from the testbed's events, maps and Jest output, with synthetic values.
