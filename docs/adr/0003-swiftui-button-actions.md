# ADR-0003: A crash in a SwiftUI button's action

**Status:** Accepted
**Date:** 2026-10-16
**Deciders:** Ilya Seliverstov

## Context

- In SwiftUI, an action's logic often sits in the button's closure, not in a model: `Button("Archive") { archived.append(selected!) }`. The SwiftUI testbed's `action` scenario crashes there, with nothing selected; the blame frame is `closure #1 in closure #2 in ArchiveView.body.getter` (`docs/RESEARCH.md` §7, step 5.7.2).
- A hosted unit test can render the screen as the app does, in a window on the app's scene (step 5.7.3). It can't tap. The toolbar button is a SwiftUI view inside a `UIKitBarItemHost`: no `UIControl`, no `UIBarButtonItem`, and SwiftUI's own gestures handle the touch. UIKit has no public way to send a touch.
- SwiftUI exposes its views as accessibility elements only while accessibility is on, and nothing public turns it on in a test process. libAccessibility's private `_AXSApplicationAccessibilitySetEnabled(1)` and `_AXSSetAutomationEnabled(1)` do. After them, `accessibilityActivate()` on the element labeled "Archive" runs the action: the test's crash log has the blame frame, called from `ButtonAction.callAsFunction()` through `AccessibilityButtonModifier`, and fixcrash's check accepts it.
- That switch is a setting of the simulator, not of the process: it stays on for every later test run until its keys are deleted from `com.apple.Accessibility` and the simulator is rebooted.
- fixcrash's shortcut check refused the spike's test, but only because the test cast the `dlsym` pointer with `unsafeBitCast`. Declared with `@_silgen_name`, the same calls pass.
- The render and async scenarios need no decision: a hosted test that renders the Tags screen, and a test that awaits `InboxModel.load()`, crash at the blame frame, and the check accepts both as it is.
- Constraints: a test that reaches the crash from a state the app is never in proves nothing (rule 1); the test lands in someone else's suite through the PR, so the team has to be able to keep it; ADR-0001: the agent uses only the test libraries the project has.

## Decision

**Option A, with D where the project already has ViewInspector.** A crash in a button's closure ends in a report that names what would reach it: moving the action into a model method a test can call, a UI test, or ViewInspector (its setup as a diff, per ADR-0001). A shortcut rule refuses the private accessibility switches, so the agent can't take B by accident.

Revisit if a real app shows many crashes in action closures, or if Apple ships a public way to activate SwiftUI elements in a unit test.

## Options considered

### A: A report (the plan's expectation)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: guidance in the reproducer and the fix skill, one shortcut rule |
| Crashes it fixes | None in action closures: they end in a report |
| Risk to the user's project | None |
| Fit with the rules | Full |

**Pros:** nothing private, nothing left behind in the simulator. The report's first suggestion, moving the logic into the model, is the fix most reviewers would ask for anyway.
**Cons:** a common SwiftUI crash family gets no PR, even when the cause is plain.

### B: Activate the button through the private accessibility switch

The test renders the screen, turns accessibility on through libAccessibility, finds the button by its label, activates it. fixcrash resets the simulator after the run.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: a reset step in the runner (delete two keys, reboot the simulator), guidance, a rule that allows exactly these calls |
| Crashes it fixes | Crashes in any control VoiceOver can activate |
| Risk to the user's project | A test that calls private Apple functions lands in the team's suite; it can break with any iOS release; while the switch is on, every other test in the suite runs with accessibility on |
| Fit with the rules | The path is the app's own (the rendered screen, its button, its action); the switch is outside the app, but private |

**Pros:** the closest a unit test gets to a tap, in a hosted test the project already has.
**Cons:** private API in a PR; state outside the test that has to be undone; the frames under the action differ from a tap's (`AccessibilityButtonModifier` instead of `_ButtonGesture`). If the switch breaks, the test doesn't crash and fixcrash reports NOT REPRODUCED, so it fails safe.

### C: A UI test

An XCUITest taps the button in the running app.

| Dimension | Assessment |
|-----------|------------|
| Complexity | High: the runner runs only unit tests; the crash is in the app process, not the test's, and how its crash log reaches the result bundle is untested |
| Crashes it fixes | Any reachable by a tap |
| Risk to the user's project | A UI test target, if the project has none, is a build change (ADR-0001 option A puts it in the report) |
| Fit with the rules | Full, where the project has a UI test target |

**Pros:** the real tap.
**Cons:** slow, untested here, and the testbeds have no UI test target. Not now.

### D: ViewInspector, where the project has it

ViewInspector finds the button in the view's value and calls its action.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low in fixcrash: guidance only |
| Crashes it fixes | Action closures, in projects that use ViewInspector |
| Risk to the user's project | None: the library is already theirs |
| Fit with the rules | The closure is the app's own, called from a state the app reaches; ViewInspector reads SwiftUI's internals by reflection inside the library, not the app's private members, and the test's source has no shortcut |

**Pros:** a test the team already writes.
**Cons:** not tried in the spike: the testbed doesn't use ViewInspector, and adding it is a build change.

## Trade-off analysis

B works today, and that is its pull. Against it: private calls in a test the team has to keep, and a simulator setting that changes every other test until it's undone. A and D keep every rule as it is and cost almost nothing. Most crashes in action closures can be moved into a model method a test can call, and that refactor is often the fix reviewers want. So the price of A is a report where B would give a PR. B stays open if real apps show the price is high.

## Consequences

- Easier: no private API in PRs, no simulator state to reset.
- Harder: crashes in action closures, in projects without ViewInspector, end in reports.
- Revisit: with data from a real app, or a public API.

## Action items

1. [ ] The reproducer's and the fix skill's guidance for SwiftUI: rendering a screen in a hosted test; a crash in an action closure is a report naming the model refactor, a UI test or ViewInspector; ViewInspector only if the project has it.
2. [ ] A shortcut rule for private accessibility switches (`_AXS…` symbols, through `dlsym` or `@_silgen_name`), with a test.
3. [ ] D on a testbed copy that has ViewInspector, if a real app asks for it.
