# SwiftUI testbed

A small SwiftUI app with three seeded crashes, where SwiftUI calls the app's code: while it renders a view, in a `.task`, in a button's action. fixcrash is developed and evaluated against it, next to the UIKit testbed in `../ios`.

| Scenario | In the app | Crash | Where | Unit-reproducible |
|----------|------------|-------|-------|-------------------|
| `render` | Tags | Index out of range: the list builds `total` rows from `tags`, and the backend's total counts two tags it no longer sends | the `ForEach` content closure in `TagsView.body` | yes, by rendering the view in a hosted test |
| `async` | Inbox | Force unwrap of `nil` after an `await`: the headline takes the first message of an empty inbox | `InboxModel.load()` | yes, by an `async` test |
| `action` | Archive, then tap Archive with no draft selected | Force unwrap of `nil` in the button's action | the Archive button's closure in `ArchiveView.body` | expected not: a unit test can't tap a SwiftUI button |

The unit tests in `TestbedSwiftUITests` pass and miss all three bugs. The app uses the SwiftUI `App` lifecycle and sets Firebase up in an `@UIApplicationDelegateAdaptor`; under XCTest it skips `FirebaseApp.configure()`, so tests report nothing to Firebase. As in Xcode's SwiftUI app template, the app target isolates to the main actor by default.

## Setup

As for `../ios`, with this app's own Firebase app, bundle id `io.github.krezzoid.fixcrash.testbed.swiftui`:

```bash
npx -y firebase-tools@15.32.1 apps:sdkconfig IOS <firebase-app-id> -o TestbedSwiftUI/GoogleService-Info.plist
xcrun simctl boot 'iPhone 17'
xcodebuild -project TestbedSwiftUI.xcodeproj -scheme TestbedSwiftUI -configuration Release -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath build build
xcrun simctl install booted build/Build/Products/Release-iphonesimulator/TestbedSwiftUI.app
```

## Run the tests

```bash
xcodebuild -project TestbedSwiftUI.xcodeproj -scheme TestbedSwiftUI -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath build test
```

## Trigger a crash

```bash
./trigger-crash.sh render     # or async, action
```

The script opens the scenario's screen through `simctl` (`-screen tags|inbox|archive`), waits for the crash, then relaunches the app and waits while Crashlytics sends the report. `simctl` can't tap: for `action`, tap Archive in the simulator when the script asks.
