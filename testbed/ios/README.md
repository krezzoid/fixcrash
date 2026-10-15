# iOS testbed

A small Swift (UIKit) app with three seeded crashes. fixcrash is developed and evaluated against it.

| Scenario | In the app | Crash | Top app frame | Unit-reproducible |
|----------|------------|-------|---------------|-------------------|
| `parser` | Open profile | Force unwrap of `nil`: the profile JSON has no `avatar` | `ProfileParser.parse(_:)` | yes, XCTest |
| `paging` | Load more, three times | Array slice past the end of the last, partial page | `FeedPager.page(_:)` | yes, XCTest |
| `lifecycle` | Sync drafts, then leave the app for 30 s | Force unwrap of `nil` in the background task's expiration handler: the upload finished, but the task was never ended | the handler closure in `SyncService.start(completion:)` | no: expected outcome is a report, no PR |

In a Release build `ProfileParser.parse(_:)` and `FeedPager.page(_:)` are inlined into their callers, and Crashlytics drops inlined frames: its issues blame `MainViewController.openProfile()` and `MainViewController.loadMore()` (`docs/RESEARCH.md` §7).

The unit tests in `TestbedTests` pass and miss all three bugs. They run inside the app (a hosted test target), which skips `FirebaseApp.configure()` under XCTest: tests report nothing to Firebase.

Why `lifecycle` is out of a unit test's reach: a hosted test can build and release a view controller, so the Android scenario's equivalent (a callback into a screen that is gone) reproduces on iOS. The expiration handler runs only when the system ends the app's background time, and the app under test stays in the foreground.

## Setup

1. Xcode, with an iOS simulator runtime (`xcodebuild -downloadPlatform iOS`). No Apple developer account: simulator builds aren't signed with one.
2. A Firebase project with an iOS app registered as `io.github.krezzoid.fixcrash.testbed`, and a Firebase CLI login.
3. Write the app config (git ignores it):

   ```bash
   npx -y firebase-tools@15.32.1 apps:sdkconfig IOS <firebase-app-id> -o Testbed/GoogleService-Info.plist
   ```

4. Boot a simulator, then build a Release app and install it. Release builds upload their dSYM to Crashlytics; Debug builds have none. Crashlytics holds back crashes until the dSYM for their binary arrives: if the console says a dSYM is missing, run `build/SourcePackages/checkouts/firebase-ios-sdk/Crashlytics/upload-symbols -gsp Testbed/GoogleService-Info.plist -p ios build/Build/Products/Release-iphonesimulator/Testbed.app.dSYM`.

   ```bash
   xcrun simctl boot 'iPhone 17'
   xcodebuild -project Testbed.xcodeproj -scheme Testbed -configuration Release -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath build build
   xcrun simctl install booted build/Build/Products/Release-iphonesimulator/Testbed.app
   ```

## Run the tests

```bash
xcodebuild -project Testbed.xcodeproj -scheme Testbed -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath build test
```

## Trigger a crash

```bash
./trigger-crash.sh parser     # or paging, lifecycle
```

The script starts the scenario through `simctl`, then relaunches the app and waits while Crashlytics sends the report. `lifecycle` takes a minute: it leaves the app for the Settings app and waits for the background time to run out. The issue shows up in Crashlytics a few minutes later.

## Notes

- The project uses folder-synchronized groups: a Swift file put in `Testbed/` or `TestbedTests/` is in the target, with no entry in `project.pbxproj`.
- All values in the app are synthetic, including the Crashlytics user id `test-user-0001`.
