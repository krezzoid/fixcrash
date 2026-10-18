# fixcrash — known limits

Where fixcrash's checks stop, what it hasn't been tried on, and what it doesn't do yet. A new way past one of the guard's limits below is still worth a report: see [SECURITY.md](../SECURITY.md).

## The proof and the guard

- **The crashing commit is the agent's word.** `verify` takes `--base` from the agent. It could check it against the build stamp the hook recorded from the event, when there is one; it doesn't yet.
- **The hook reads commands as text.** It spots writes to fixcrash's state and pull request commands by their text. A command that builds the path or the command in a variable gets past it, and so does a pull request opened on the web after `git push`. It guards against a careless agent, not a hostile one.
- **The guard turns on per repository**, for sessions that read crash events and for `fixcrash/` branches. A pull request from another branch in a later session isn't checked.
- **The reproducer's shell can still edit app code** (`sed -i`). Only its Write and Edit tools are held to test files.
- **The shortcut check reads the new lines of the changed test files.** A mock of the class under test (Mockito and MockK build it without its constructor) is caught by the reproducer's rules only, not in code. A shortcut in a helper outside the changed test files, or written another way, gets past it.
- **The same exception at the same frame is necessary, not sufficient.** It can come from an input the app never gets. Only the reproducer's judgment rules that out ([eval](EVAL.md#react-native), React Native, finding 3).
- **A NOT REPRODUCED answer can come without a single `fixcrash reproduce` run.** That is fine with a concrete reason, but a lazy answer looks the same.
- **Test runs aren't isolated from the network.** Gradle runs `--offline` and npm installs from its cache, but the tests are the app's own code and can reach whatever it reaches.

## Android

- The unit test task is `testDebugUnitTest`. Apps with flavors need `test<Flavor>DebugUnitTest`, and plain JVM modules (task `test`) are left out of the suite.
- A Robolectric test counts as a JVM test, but adding Robolectric to a module that lacks it is a build change, and `reproduce` and `verify` don't apply build changes at the crashing commit. The report carries the setup as a build-file diff instead ([ADR-0001](adr/0001-test-libraries-the-module-lacks.md)).

## iOS

- The Release build of the crashing commit runs the app's Release build phases. If one uploads debug symbols to Crashlytics, that upload happens too.
- Swift packages are resolved into fixcrash's own build folder, so the first run needs the network.
- A test target that isn't folder-synchronized lists its files in `project.pbxproj`, so a new test file isn't built at the crashing commit. The reproducer can add its test to an existing test file instead.
- `xcodebuild test-without-building` can hang after a crashing test. fixcrash turns off diagnostics collection, which caused it, and keeps a 2-minute timeout and one retry.
- After Xcode updates itself, the system's simulator components can be older than it needs until they are installed. `xcodebuild` then says only "Unable to find a device matching the provided destination specifier".
- Untried: a crash in a framework the app embeds, an `NSException`, and crash sites from device builds ([ADR-0002](adr/0002-same-failure-on-ios.md)).

## React Native

- JS errors only. A native crash in a React Native app goes down the Android or iOS path, with `--project-dir android` or `ios`. That is untried for an app's own native module. On Android such an event has no build stamp, because the Gradle root isn't the git root, so only release tags find the commit.
- npm only. Yarn and pnpm apps stop with a message ([ADR-0005](adr/0005-node-modules-in-the-worktree.md)).
- Untried: Expo apps (the `jest-expo` preset, the bundle from `expo export:embed`, native folders made by prebuild), and apps with Hermes off.
- An event from an earlier build with the same version number has other bundle offsets, and the tagged commit's source map places it wrong. Nothing flags it.
- One JS bug on both platforms is two Crashlytics issues and, fixed in two sessions, two pull requests.
- A JS project's worktree, with its `node_modules` (hundreds of MB), stays in `~/.cache/fixcrash/worktrees/`. No command removes it yet; deleting it is safe.

## Not yet

- A production app. fixcrash is evaluated on testbeds ([eval](EVAL.md)). The share of a real app's top crashes that a unit test can reproduce is unmeasured.
- Crash sources other than Crashlytics, such as Sentry.
- Headless runs (`claude -p`) in CI on new top issues.
- Memory of crash patterns across runs.
- `claude plugin eval`: the eval ran by hand, measured with `eval/metrics.ts`.
