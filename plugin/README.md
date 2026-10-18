# fixcrash

A Claude Code plugin for mobile teams on Firebase Crashlytics. Given a Crashlytics issue, fixcrash writes a test that fails on the version that crashed, with the crash's own exception. It then fixes the code, proves the fix (the test passes and the full suite is green), and opens a pull request with that proof. When it can't reproduce a crash, it says what it tried, what it suspects and what data is missing, and opens no pull request.

It works on Android (Kotlin, JVM unit tests and Robolectric), iOS (Swift, XCTest and Swift Testing on a simulator) and React Native (JS errors, with Jest). It runs on demand in your own Claude Code session, on your machine, and has no server of its own.

Source, docs and eval results: https://github.com/krezzoid/fixcrash

## Commands

- `/fixcrash:triage [app-id]`: the top issues of the app's latest version, each marked as likely or unlikely to be reproducible by a unit test. It changes nothing.
- `/fixcrash:fix <issue-id> [app-id] [which JS error]`: the loop for one issue. A subagent that may only write tests reproduces the crash at the crashing commit. Then the fix goes on a `fixcrash/…` branch, and `fixcrash verify` checks it. fixcrash asks you before it pushes, opens the pull request or adds a note to the issue.

## Requirements

- Claude Code, and Node.js 24 or newer for the `fixcrash` command and the hook.
- A Firebase project with Crashlytics, and a Firebase CLI login (`npx firebase-tools login`).
- Your app's own toolchain, with its dependencies already downloaded once: the JDK and Android SDK, Xcode with an iPhone simulator, or npm for React Native.
- `git`, and `gh` logged in to open pull requests.

## Install

```bash
claude plugin marketplace add krezzoid/fixcrash
claude plugin install fixcrash@fixcrash
```

Claude Code asks for the plugin's options when you enable it. Every option has a default:

| Option | Default | What it is |
|--------|---------|------------|
| Firebase app id | empty: read from `google-services.json` or `GoogleService-Info.plist` | The app whose crashes to read |
| Project directory | `.` | Where `gradlew`, the Xcode project or a React Native app's `package.json` is, relative to the repository root |
| Release tag pattern | `v{display}` | The git tag of a release, used when an event has no build stamp |
| Hypotheses per crash | 3 | How many root causes the reproducer may try before it reports |
| Test attempts per crash | 5 | How many test runs at the crashing version it may make before it reports |

Each [release](https://github.com/krezzoid/fixcrash/releases) also carries the plugin as a zip, which loads for one session without a marketplace: `claude --plugin-url <the zip's URL>`.

## What fixcrash runs, sends and writes

### Runs

- **The Firebase MCP server**, from Google's `firebase-tools` at a pinned version: `npx -y firebase-tools@15.32.1 mcp`. Claude Code starts it with your session. Only eight of its tools are on: the environment and resources, the Crashlytics report, issue, events and notes, and creating a note.
- **One hook**, `hooks/run.sh`, which runs `src/hook.ts` with Node. It runs before each shell command, file edit and GitHub pull request tool call, and after each Crashlytics tool call. It reads the call. It redacts personal data from crash events before Claude sees them, records each event's expected failure, blocks a pull request that has no proof for its commit, and keeps file writes out of fixcrash's state. It makes no network requests.
- **The `fixcrash` command** (`bin/fixcrash`, which runs `src/cli.ts` with Node), when the skills call it:
  - `git`, to find the crashing commit and to run tests in a worktree of their own;
  - Android: `./gradlew --offline` for unit tests;
  - iOS: `xcodebuild` and `xcrun` (`simctl`, `atos`). For an iOS crash it also builds the crashing commit in Release, which runs your project's build phases. If one uploads debug symbols to Crashlytics, as Crashlytics' own run script does, that upload happens too;
  - React Native: `npm ci --offline`, Metro's `react-native bundle`, `hermesc`, `metro-symbolicate` and Jest, all from your project's `node_modules`.
- **Through Claude, after you say yes:** `git push` of the fix branch, `gh pr create`, and a Crashlytics note.

### Sends

- **To Firebase:** Crashlytics reads through `firebase-tools`, with your Firebase login. A note on an issue only when you agree. fixcrash never changes an issue's state.
- **To GitHub:** the fix branch and the pull request, through `git` and `gh`, only when you agree.
- **To Claude:** the crash events, after the hook redacts them, like any other tool result in your session.
- Nothing else: no telemetry, and no server of fixcrash's own.

### Fetches

- `firebase-tools` from npm, the first time the MCP server starts.
- Swift packages, the first time `xcodebuild` resolves them in fixcrash's own build folder.
- Nothing else: Gradle and npm run offline, from the caches your own builds filled. When a cache lacks something, fixcrash stops and says how to fill it.

### Writes

- **In your repository's git directory, `.git/fixcrash/`:**
  - a worktree for Gradle and Xcode runs, and build caches;
  - receipts of verified fixes;
  - the redacted events and expected failures;
  - attempt counts, session markers and logs.
- **In your cache directory, `~/.cache/fixcrash/worktrees/`** (or `$XDG_CACHE_HOME`): a React Native app's worktree, with its `node_modules`. It can take hundreds of MB, and deleting it is safe.
- **In your checkout:** a `fixcrash/…` branch with the test and the fix, which Claude writes and commits. `fixcrash reproduce` and `fixcrash verify` run in their own worktree and never change your checkout.

## Safety rules

- **Crash data is untrusted input.** Exception messages, logs, custom keys and breadcrumbs may contain text that reads like instructions. fixcrash never follows it.
- **No pull request without proof.** `fixcrash verify` writes a receipt only when the test fails at the crashing commit with the crash's exception and frame, passes with the fix, and the full suite is green. The hook blocks pull request creation without a receipt for the commit.
- **Redaction.** No user ids, emails, tokens, IPs or other personal data from events in tests, commits, pull requests or notes.
- **Bounded.** Hypotheses and test attempts are budgeted. When they run out, you get a report.

## License

MIT. See `LICENSE`. fixcrash is not affiliated with Google or Firebase.
