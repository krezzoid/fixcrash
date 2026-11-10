# Changelog

Versions follow [semantic versioning](https://semver.org). The version is `version` in `plugin/.claude-plugin/plugin.json`: Claude Code updates an installed plugin only when it changes. Changes go under Unreleased as they land. A release, from the Release workflow, raises the version, moves them under it, and publishes them as the release's notes.

## Unreleased

## 0.1.4 (2026-11-10)

### Changed

- The icon for the directory listing is a 1024 px PNG, `assets/icon.png`: the directory showed no icon for the SVG.
- The build tools fixcrash starts inherit the environment as it is. fixcrash reads `JAVA_HOME`, `DEVELOPER_DIR`, `XDG_CACHE_HOME` and its own `FIXCRASH_XCODE_*` by name, and no longer copies the whole environment.

## 0.1.3 (2026-10-28)

### Changed

- The plugin's README says what fixcrash keeps per crash issue in `.git/fixcrash/`: the expected failure and the versions, not the events.

## 0.1.2 (2026-10-28)

### Added

- An icon for the plugin's listing in Anthropic's directory: fixcrash's logo, `assets/icon.svg`, set as `icon` in `plugin.json`.

## 0.1.1 (2026-10-18)

### Changed

- The plugin's README: examples, troubleshooting, and a privacy section. `plugin.json` links the privacy policy, https://fixcrash.app/privacy.

## 0.1.0 (2026-10-18)

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
