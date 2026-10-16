# React Native testbed

A small React Native app with four seeded JS crashes, built from the Community CLI template (React Native 0.88, Hermes, the New Architecture) with React Native Firebase. fixcrash is developed and evaluated against it (`docs/PLAN.md`, step 6).

| Scenario | Screen | Crash | Function | Reported as | Jest-reproducible |
|----------|--------|-------|----------|-------------|-------------------|
| `parser` | profile | `TypeError`: the profile JSON has no `avatar` | `parseProfile` | a fatal JS error, through React Native Firebase's handler | yes |
| `render` | tags | `TypeError` while React renders the list: the backend's `total` counts tags it doesn't send | the row closure in `TagList` | a native crash: React Native's own handler takes uncaught React errors, React Native Firebase's never sees them | yes, by rendering `TagList` |
| `async` | inbox | `TypeError` after an `await`: the inbox came back empty | `loadHeadline` | a non-fatal: the screen catches it and calls `recordError` | yes, with an `async` test |
| `engine` | updates | `RangeError` from `toISOString()`: Hermes can't parse `2026/10/16 10:00` | `dayKey` | a fatal JS error, through React Native Firebase's handler | no: expected outcome is a report, no PR |

Why `engine` is out of Jest's reach: Jest runs on Node, whose `Date` parses every time that passes `dayKey`'s format check (checked for every month, day, hour and minute of 15 years). Hermes parses ISO dates (a `T` or a space between date and time) and the forms that start with a weekday, `Fri Oct 16 2026 10:00:00` or `Fri, 16 Oct 2026 10:00:00`, and nothing else (`lib/VM/JSLib/DateUtil.cpp`). The only way to make `dayKey` throw under Node is to replace `Date` in the test, which proves nothing about the app.

The Jest tests in `__tests__` pass and miss all four bugs. React Native Firebase is stubbed in `jest.setup.js`: tests report nothing.

## Setup

1. Node 22.11 or later; for Android, the Android SDK and an emulator; for iOS, Xcode with a simulator and CocoaPods.
2. A Firebase project with an Android app `io.github.krezzoid.fixcrash.testbed.rn` and an iOS app with the same bundle id, and a Firebase CLI login.
3. Install the packages and write both app configs (git ignores them):

   ```bash
   npm ci
   npx -y firebase-tools@15.32.1 apps:sdkconfig ANDROID <android-app-id> -o android/app/google-services.json
   npx -y firebase-tools@15.32.1 apps:sdkconfig IOS <ios-app-id> -o ios/GoogleService-Info.plist
   ```

   The iOS config sits next to the Xcode project, not in `ios/TestbedRN/`: the Crashlytics build phase that React Native Firebase adds uploads the dSYM with the config it finds there.

4. Android: build a Release APK and install it on a running emulator. Release builds carry the JS bundle compiled to Hermes bytecode, and Android's keeps the bundle's source map in `android/app/build/generated/sourcemaps/react/release/`; Debug builds load the bundle from Metro. The first build downloads the NDK.

   ```bash
   (cd android && ./gradlew assembleRelease)
   adb install -r android/app/build/outputs/apk/release/app-release.apk
   ```

5. iOS: install the pods, then build a Release app for the booted simulator and install it. `SOURCEMAP_FILE` keeps the bundle's source map, which iOS builds don't by default; the build uploads the dSYM to Crashlytics.

   ```bash
   (cd ios && LANG=en_US.UTF-8 pod install)
   xcrun simctl boot 'iPhone 17'
   xcodebuild -workspace ios/TestbedRN.xcworkspace -scheme TestbedRN -configuration Release -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath ios/build SOURCEMAP_FILE="$PWD/ios/build/main.jsbundle.map" build
   xcrun simctl install booted ios/build/Build/Products/Release-iphonesimulator/TestbedRN.app
   ```

## Run the tests

```bash
npm test
```

## Trigger a crash

```bash
./trigger-crash.sh android parser    # or render, async, engine; ios instead of android
```

The script launches the app with the scenario's screen (`profile`, `tags`, `inbox` or `updates`): as a link, `testbedrn://<screen>`, on Android, and as a launch argument, `-screen <screen>`, on iOS, where `simctl openurl` waits for a tap on a confirmation. The app opens that screen from a timer once it has rendered, as a button's handler would: an error there reaches the global handler. Then the script relaunches the app and waits while Crashlytics sends the report. The issue shows up in Crashlytics a few minutes later.

## Notes

- The home screen has a button for each screen, for trying them by hand.
- `firebase.json` turns off React Native Firebase's handler chaining, as its docs advise. With chaining on (the default), React Native Firebase records a fatal JS error, then passes it to React Native's own handler, which crashes the app natively: the same error can be reported twice.
- Release builds are signed with `android/app/debug.keystore`, the template's public debug key, as the template does.
- All values in the app are synthetic, including the Crashlytics user id `test-user-0001`.
