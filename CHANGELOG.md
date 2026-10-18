# Changelog

Versions follow [semantic versioning](https://semver.org). The version is `version` in `plugin/.claude-plugin/plugin.json`: Claude Code updates an installed plugin only when it changes. Changes go under Unreleased as they land. A release, from the Release workflow, raises the version, moves them under it, and publishes them as the release's notes.

## Unreleased

The first release.

### Added

- `/fixcrash:triage`: the top Crashlytics issues of an app's latest version, each marked as likely or unlikely to be reproducible by a unit test.
- `/fixcrash:fix`: reproduce one crash with a test at the crashing commit, fix it, prove the fix, and open a pull request with the proof. When the crash isn't reproduced, a report and no pull request.
- The `reproducer` subagent, which may only write tests.
- The `fixcrash` command:
  - `reproduce`, `verify`, `receipt` and `pr-body`;
  - `symbolicate`, for React Native JS errors;
  - `commit-for-version`, `event` and `app-id`.
- The hook:
  - redaction of crash events;
  - the expected failure recorded from each event;
  - no pull request without a receipt;
  - no writes to fixcrash's state, and the reproducer held to test files.
- Platforms:
  - Android: Gradle, JVM unit tests and Robolectric;
  - iOS: `xcodebuild`, XCTest and Swift Testing, with inlined frames recovered from a Release build;
  - React Native JS errors: Jest, placed in the sources with the crashing commit's bundle and source map.
- Each release carries the plugin as a zip, which `claude --plugin-dir` and `--plugin-url` load.
