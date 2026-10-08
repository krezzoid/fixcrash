# fixcrash — research

Status: 2026-10-07, before any code. Facts checked on that date are in §7; everything else is analysis or a hypothesis and says so.

## 1. Goal

An open-source Claude Code plugin that turns a Firebase Crashlytics issue into a **proven** fix:

1. a test that fails on the version that crashed;
2. the fix;
3. the test passes and the full suite is green;
4. a PR with that evidence and a note on the issue.

When the crash can't be reproduced, the plugin reports why and opens no PR.

Not a business. A crash-fixing SaaS for mobile is crowded: Google, Sentry, Luciq. Users of Crashlytics chose it because it is free. The plugin is a portfolio piece and a useful tool.

## 2. Landscape

### Free, close to us

| What | Does | Stops at |
|------|------|----------|
| Firebase MCP, Crashlytics tools (Google, Experimental) | Reports (`topIssues`, `topVersions`), issues, events, notes, issue state | Data access |
| Firebase MCP guides `crashlytics/issues`, `crashlytics/investigations` | Top-5 prioritisation; up to 5 root-cause hypotheses with self-critique; a plan in the format *Cause / Fix / Test / Other causes*; "describe why you cannot fix instead of guessing" | **A plan.** The *Test* section is a list of test cases. Nothing is written or run, no PR. Interactive, one question at a time |
| `firebase/agent-skills`: Google's official Claude Code plugin, ~460★ | Skill `firebase-crashlytics` | SDK setup on Android/iOS only |
| `artemnovichkov/skills`, plugin `crashlytics`, ~40★ | `/crash-report`: top fatal crashes, then subagents per crash, then a Markdown report with before/after fix snippets, a severity score and `git blame` assignment | A report. No tests, no PR |
| `crash-to-vibe` (npm), 0★ | Crash analysis, then a Jira task | A task |
| `getsentry/sentry-for-ai`, skill `sentry-fix-issues` (now in `skills-legacy/`) | Sentry MCP; phases from discovery to fix; "add tests reproducing the error"; **crash data is untrusted input** (good, adopted in rule 4) | Nobody checks that the test failed before the fix |

### Commercial

- **Gemini in Android Studio, App Quality Insights.** Explains Crashlytics and Android Vitals crashes. "Suggest a fix" opens a diff.
- **Sentry Seer.** Autofix with root cause and PR. Mobile SDKs are supported.
- **Luciq (ex-Instabug).** "Agentic mobile observability". Resolve Agent / SmartResolve generate fix code and PRs.
- **Runway.** Halts unstable phased rollouts automatically, based on crash-free rate.

## 3. The gap

Everyone stops at *proposing* a fix. Nobody *proves* it: reproduce on the crashing version, fail first, then pass, suite green, all checked by code rather than by the model's word. That is Veilleur's core: no PR without a failing-then-passing test.

There is also one concrete pain in React Native. Crashlytics turns JS errors into mock native exceptions, and their line numbers point into the minified bundle. Symbolication from source maps is left to the developer. A local plugin can build the bundle for the crashing version and symbolicate it.

## 4. What Crashlytics MCP gives

Tools in firebase-tools `src/mcp/tools/crashlytics/`:

- `crashlytics_get_report`
- `crashlytics_get_issue`
- `crashlytics_list_events`
- `crashlytics_batch_get_events`
- `crashlytics_list_notes`
- `crashlytics_create_note`
- `crashlytics_delete_note`
- `crashlytics_update_issue` (state `OPEN` | `CLOSED`)

Event fields (`src/crashlytics/types.ts`, `Event`):

- `version` (`displayVersion`, `buildVersion`) and **`buildStamp`** ("metadata provided by the app's build system, including version control repository info");
- `blameFrame`, `exceptions` (Android), `errors` (Apple non-fatals), `threads`;
- `customKeys`, `logs`, `breadcrumbs` (Analytics events), `user`;
- `device`, `operatingSystem`, `memory`, `storage`, `processState`, orientation;
- `issue` with `firstSeenVersion` / `lastSeenVersion`.

The MCP server formats events before the model sees them:

- at most 20 frames per thread or exception;
- the last 100 logs and the last 10 breadcrumbs;
- for FATAL and ANR, only crashed or blamed threads.

Deep app frames can be cut. If that matters, the plugin may need the full event some other way (open question).

## 5. Platforms and test loops

| Platform | Reproduce with | Loop | Notes |
|----------|----------------|------|-------|
| Android (Kotlin) — **first** | JVM unit test: `./gradlew :<module>:testDebugUnitTest --tests <Class>`; Robolectric when Android framework classes are involved | seconds to a minute, no emulator | Crashlytics is the default crash tool on Android. Stacks are deobfuscated when the R8 mapping is uploaded. `buildStamp` may carry the git commit (hypothesis, §9) |
| React Native — second | Jest (in the RN template) | seconds | JS errors only. Native crashes in an RN app go down the Android/iOS paths. Symbolication: build the bundle and source map for the crashing commit (`react-native bundle --sourcemap-output`, Hermes source-map composition), then `metro-symbolicate`. Cache in `${CLAUDE_PLUGIN_DATA}` |
| iOS (Swift) — third | `swift test` for logic in SPM packages; otherwise `xcodebuild test -scheme <s> -destination 'platform=iOS Simulator,…' -only-testing:<id>` (XCTest or Swift Testing) | minutes | Needs macOS and Xcode. No dSYM upload means no symbolicated stacks. Slow builds make the attempt budget tighter |

**Reproducible by a unit test, usually:**

- parsing and mapping (missing field, wrong type);
- nil or `!!` on data;
- index and range errors;
- state-machine logic;
- date, locale and number formatting.

**Usually not:**

- lifecycle (Fragment not attached, view after `onDestroy`);
- main-thread races;
- OOM, ANR, watchdog kills;
- OEM-specific crashes;
- native (NDK, C++) crashes;
- crashes inside third-party SDKs.

These end in an honest report. The plugin's value depends on the share of the first group in real apps (§9).

## 6. Design, carried over from Veilleur

- **Rules in code.**
  - `bin/fixcrash verify` decides whether a fix is proven and writes a receipt bound to the commit.
  - A `PreToolUse` hook refuses PR creation without a receipt for the commit the PR proposes.
  - Prompts describe the loop; code enforces the rule.
  - As implemented (step 3), one hook process (`hooks/run.sh` → `src/hook.ts`) holds these rules:
    - PostToolUse on Crashlytics tools: redact personal data before the model sees the result; record each event's expected failure (exception type and blame frame) in `.git/fixcrash/events/`; mark the session.
    - PreToolUse: the PR guard, for sessions that read crash events and for `fixcrash/` branches. The receipt must exist for the PR's commit, and its expected failure must come from a recorded event, not from `verify`'s arguments.
    - PreToolUse: no tool writes `.git/fixcrash` but the CLI; the reproducer subagent writes test files only.
    - It fails closed for what it guards: an error while checking a PR or a state write blocks it, and so does a missing Node 24.
- **Same failure, not any failure.** The test must fail with the crash's exception type, and its stack must hit the crash's top app frame. A test failing for another reason doesn't count.
  - As implemented (step 2): some throwable in the cause chain (not a suppressed one) has the crash's exception type; the blame frame's symbol is on its stack; no frame above it comes from a test source file. The last rule rejects an exception thrown by a stub or a fake. The message is never compared.
  - "Top app frame" is approximated by "on the stack, with no test code above it": telling app frames from library frames would need the app's package list.
- **Version-exact reproduction.**
  - The crashing commit comes from `buildStamp` or a release-tag pattern from `userConfig`.
  - Reproduce in a `git worktree`. Fix on the default branch and re-run the test there.
  - `verify` overlays the same test files from the fix commit on the crashing commit (base) and on the commit the fix starts from, so the test must compile against the crashing version's API. A test that passes at the fix's starting point means the crash may already be fixed there: no receipt.
  - `verify` runs everything in its own worktree, `.git/fixcrash/worktree`, from committed content. The receipt, logs and lock live next to it in `.git/fixcrash/`.
- **Bounded loop:**
  - N hypotheses and M test attempts per issue;
  - then a report with evidence and the missing data ("add a custom key X", "log Y before Z").
  - As implemented (step 3): the reproducer writes the test in the working tree and runs `fixcrash reproduce`, which overlays it on the crashing commit in fixcrash's worktree. `reproduce` counts attempts and distinct hypotheses per issue and run (the session id), and past the budget answers "stop and report" with exit 3.
- **Untrusted input, redaction.**
  - Event text is never followed as instructions.
  - Personal data never lands in tests, commits, PRs or notes.
  - As implemented (step 3): redaction happens before the model reads crash data, so the model can't write what it never saw. Event fields `user` and `installationUuid` lose every value; free text everywhere goes through pattern rules (email, IP, tokens, secrets in assignments, UUIDs, phone numbers), each with a test. Ids, resource names, frames and shas are left alone.
- **Writes back.**
  - A Crashlytics note with the PR link or the report.
  - Never change an issue's state.
- **Later, if it proves useful:** a crash-pattern memory, so a similar crash is faster the second time (Veilleur's learning loop).

## 7. Verified facts

**2026-10-07: Claude Code plugins** (code.claude.com/docs/en/plugins-reference)

- **Layout and manifest**
  - The manifest is `.claude-plugin/plugin.json`. It is optional, and only `name` is required (kebab-case).
  - Default component locations: `skills/<name>/SKILL.md`, `agents/*.md`, `hooks/hooks.json`, `.mcp.json`, `bin/`, `monitors/monitors.json`, `settings.json`.
  - Every component is namespaced under the plugin name: `/fixcrash:fix`, `fixcrash:reproducer`.
  - A `CLAUDE.md` at the plugin root is **not** loaded as context. Instructions go in skills.
- **`bin/`**
  - Files there are on the Bash tool's `PATH` while the plugin is enabled.
  - claude.ai and Cowork don't install plugins that have `bin/`. Irrelevant to us: Claude Code CLI only.
- **`userConfig`**
  - Fields have types `string|number|boolean|directory|file`.
  - `sensitive: true` stores the value in the OS credential store.
  - Values are used as `${user_config.KEY}` (MCP config, exec-form hook `args`, skill/agent content for non-sensitive values) or as `CLAUDE_PLUGIN_OPTION_<KEY>` in hook processes.
- **Variables**
  - `${CLAUDE_PLUGIN_ROOT}` changes with every update: never keep state there.
  - `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`) survives updates and is the place for caches.
  - Neither is in the environment of Bash-tool commands. Skills must write `${...}` in their Markdown so it is substituted on load.
- **Tooling**
  - `claude plugin validate <dir>` (`--strict` for CI) checks the manifest, paths and MCP entries.
  - `claude --plugin-dir <dir>` loads a plugin from a checkout.
  - `experimental.evals` with `claude plugin eval`: to look at for our eval.
- **Distribution:** a marketplace is a catalog (`.claude-plugin/marketplace.json`); an entry may point at the marketplace root, so one repository can be both.
- **Install** (code.claude.com/docs/en/discover-plugins)
  - `/plugin marketplace add krezzoid/fixcrash` (`#<tag>` pins a ref), then `/plugin install fixcrash@<marketplace name>`. The shell has the same as `claude plugin marketplace add` and `claude plugin install`.
  - Third-party marketplaces don't auto-update by default.

**2026-10-07: Firebase MCP / Crashlytics** (firebase-tools `main`, package version 15.32.1)

- **Status:** the Crashlytics MCP tools are Experimental (no SLA, no deprecation policy). Unity is not supported.
- **Auth:** the Firebase CLI login or Application Default Credentials.
- **Launch:** the README shows `claude mcp add firebase npx -- -y firebase-tools@latest mcp`. We pin a version instead of `@latest`. Flags: see the spike below.
- **Prompt:** `crashlytics:connect` is the entry point; it checks the connection with the `topVersions` report.
- **Guides:** `firebase://guides/crashlytics/{connect,issues,investigations,reports}`, plus `firebase://guides/app_id`.

**2026-10-07: Crashlytics Android SDK** (firebase.google.com/docs/crashlytics/android/get-started)

- Minimums: Gradle 8.0, AGP 8.1.0, Google services Gradle plugin 4.4.1.
- Google Analytics is recommended: breadcrumbs come from Analytics events.
- A crash is sent on the next app launch. If it isn't in the console after five minutes, enable debug logging.

**2026-10-07: Spike, Android testbed** (`testbed/android`; AGP 9.4.1, Gradle 9.6, Crashlytics SDK 20.1.1, crashlytics-gradle 3.0.8, google-services 4.5.0, BoM 34.19.0, firebase-tools 15.32.1, emulator API 37). Answers open questions 1, 2 (partly), 4 and 5.

- **Commit in events (Q1)**
  - The Crashlytics Gradle plugin copies AGP's VCS info into the string resource `com.google.firebase.crashlytics.version_control_info`; the SDK reads it at startup.
  - AGP fills it in release builds only. Debug builds get an empty string.
  - AGP looks for `.git` in the Gradle root directory only. With the Android project in a subdirectory (this repository, most React Native apps, monorepos) the value is `generate_error_reason: NO_SUPPORTED_VCS_FOUND`.
  - With the Gradle root as the git root, the resource and `META-INF/version-control-info.textproto` carry `revision: "<full sha>"`.
  - In events: such a release build's event has `buildStamp` with `revision: "<full sha>"` of the commit it was built from. Debug events have no `buildStamp`.
  - Fallback for everything else: the release-tag pattern from `userConfig`.
- **Frames (Q2, partly)**
  - `blameFrame` comes computed: `symbol`, `file`, `line`, `owner: DEVELOPER`. Truncation to 20 frames (`... frames omitted ...`) doesn't hide it.
  - Chained exceptions come with `Caused by:`. A crash in `onCreate` is `RuntimeException: Unable to start activity` caused by the real exception; Crashlytics groups the issue by the cause.
  - The NPE message differs between ART and the JVM. The "same failure" check compares the exception type in the cause chain and `blameFrame`, never the message.
  - Coroutine, RxJava and Compose stacks were not tested: still open, needs a real app.
- **Debug builds and emulators (Q4)**
  - Debug builds report from an emulator with no extra setup.
  - SDK 20.1.1 enqueues a fatal report to DataTransport at crash time when the process lives long enough, otherwise on the next launch.
  - Issues show up in the reports API 2 to 5 minutes after the crash.
  - A new AGP 9 project limits R8 to `androidx.**`, `kotlin.**` and `kotlinx.**` (`optimization.packageScope`): app frames stay readable in release. The mapping is uploaded at `assembleRelease` anyway.
- **MCP launch and data (Q5)**
  - `firebase-tools mcp --tools a,b,c` exposes exactly the listed tools. The plugin leaves out `crashlytics_update_issue` and `crashlytics_delete_note`, so rule 7 holds in the server config, not only in a prompt. `--only crashlytics` is accepted too.
  - `crashlytics_get_report` tells the agent to read `firebase://guides/crashlytics/reports` through `firebase_read_resources`: keep that tool in the list.
  - Auth: the Firebase CLI login is enough. Every tool call needs `appId`: from `google-services.json` (`client_info.mobilesdk_app_id`) or `firebase apps:list ANDROID`.
  - Events show the model `user.id`, `installationUuid`, `customKeys`, `logs` and Analytics `breadcrumbs` as is. Redaction (rule 5) applies to everything the agent writes.
  - Logs and breadcrumbs are written asynchronously: the last ones before a crash can be missing.

**2026-10-07: `fixcrash verify` on the testbed (step 2)** (Gradle 9.6, Node 24.21)

- **Gradle test reports**
  - JUnit XML in `<module>/build/test-results/testDebugUnitTest/TEST-<class>.xml`.
  - A failure is `<failure type="<exception class>">` with the full stack trace as its body, JUnit and Gradle worker frames included.
  - JDK frames carry module prefixes (`java.base/`, `jdk.proxy1/`).
  - The `hostname` attribute holds the machine name: scrubbed in committed fixtures.
- **Building in a worktree**
  - Gradle builds and runs tests in a linked worktree under `.git/`.
  - With a warm daemon, a targeted test in that worktree takes 1 to 2 s, and a whole `verify` on the testbed about 3 s.
  - With the google-services plugin, unit tests need `google-services.json`: `processDebugGoogleServices` runs first and looks in `app/src/debug/`, `app/src/` and `app/`. Git ignores it, so `verify` copies it and `local.properties` from the checkout.
  - The Gradle wrapper needs a JDK. On a Mac with only Android Studio, Claude Code's shell has no `java` and no `JAVA_HOME`; `verify` then uses Android Studio's bundled JDK.
- **Writing the reproducing test**
  - A test written against the fixed API doesn't compile at the crashing commit (`Null cannot be a value of a non-null type`). It has to use the crashing version's API.
- **Node**
  - Node 24.21 runs the `.ts` sources with no flag and no warning. `import.meta.main` is available.
  - `node --test` takes a glob (`'test/**/*.test.ts'`), not a directory.

**2026-10-08: Hooks and the Firebase MCP output (step 3)** (Claude Code 2.1.260, firebase-tools 15.32.1; code.claude.com/docs/en/hooks, firebase-tools `lib/mcp/tools/crashlytics/events.js`)

- **Hook mechanics**
  - Tools of a plugin's MCP server are named `mcp__plugin_<plugin>_<server>__<tool>`, e.g. `mcp__plugin_fixcrash_firebase__crashlytics_batch_get_events`. A matcher written against the bare server key never fires for them.
  - A hook blocks a tool call only with exit code 2 or a JSON `permissionDecision: "deny"`. A hook that can't start or exits 1 lets the call through, so a guard has to fail closed on purpose.
  - The input carries `cwd` (the session's directory, not where a command `cd`s to), `session_id`, and `agent_type` inside a subagent (`fixcrash:reproducer` for a plugin subagent).
  - Plugin subagents ignore `hooks`, `mcpServers` and `permissionMode` in their frontmatter: per-agent rules go in the plugin's hooks, keyed on `agent_type`.
  - Exec-form hooks (`command` + `args`) take `${CLAUDE_PLUGIN_ROOT}` as one argument with no quoting.
- **MCP results in PostToolUse** (checked live, in a session)
  - For an MCP tool, `tool_response` is the content array, `[{ "type": "text", "text": "…" }]`, and the input carries `mcp_server: { name, source }`.
  - `hookSpecificOutput.updatedToolOutput` with an array of the same shape replaces what the model sees. This is how fixcrash redacts crash data before the model reads it.
  - Hooks added to `.claude/settings.local.json` take effect in the running session; removed ones keep running until the session restarts.
- **Event format**
  - `batch_get_events` and `list_events` print `js-yaml.dump(events)` with `lineWidth: 200`. Each event is a map from field name to a string: nested objects (`issue`, `version`, `blameFrame`, `user`, `customKeys`) are YAML-dumped first, and `exceptions` and `threads` are text.
  - `exceptions` lines are `Type: message`, `at symbol (File.kt:12)` (a space before the parenthesis, unlike the JVM's), `Caused by: …`, and `... frames omitted ...` past 20 frames. Exceptions are separated by a blank line.
  - `get_issue` prints JSON; the issue `title` is the blame frame's symbol, the `subtitle` is `<exception type> - <message>`.
  - A release build's `buildStamp` holds the `repositories { … revision: "<sha>" }` text.
- **Auto mode** refuses to copy a captured event into a committed fixture, scrubbed or not. The test fixtures are written by hand, with synthetic values.
- **Headless runs** (`claude -p`) from the agent's sandbox can't authenticate (`OAuth session expired`), so the plugin as a whole is tried in the user's own session (step 4).

**2026-10-08: Events from the eval copy (step 4)** (the copy from `testbed/copy-android.sh`, its `v1.0` release APK, Crashlytics SDK 20.1.1, firebase-tools 15.32.1, emulator API 37)

- **Build stamp end to end:** all three scenarios arrived with `buildStamp` `revision` set to the `v1.0` commit, and `fixcrash commit-for-version` resolved it in the copy.
- **Same issue across builds:** the copy's release events landed in the issues the step 1 debug events made, under the same version `1.0 (1)`. The issue follows the stack, not the build type.
- **`sampleEvent` is the newest event:** once a release event arrived, `get_issue`, its variant and `topIssues` all pointed `sampleEvent` at it. Before that it was the old debug event, which has no build stamp and leaves only the tag fallback.
- **`crashlytics_list_events`** needs `filter.issueId` or `filter.issueVariantId`. Recent events across issues come from `topIssues` with a time interval.
- **A report can get lost**
  - The report is enqueued to DataTransport at crash time or on the next launch. The upload (`TRuntime.CctTransportBackend: Status Code: 200`) comes a few seconds later, mostly from the relaunched app, and can carry several reports at once.
  - When the next scenario's `am start -S` stopped the relaunched app at once, its report never arrived (not there 10 minutes later). Triggered alone, it arrived.
  - `trigger-crash.sh` now waits 10 s after the relaunch. With that, three scenarios back to back all arrived.

**2026-10-08: Claude Code session transcripts, for the eval metrics** (Claude Code 2.1.293; read from transcripts on this machine, the format is undocumented)

- **Where**
  - A session is `~/.claude/projects/<project path, non-alphanumerics as dashes>/<session id>.jsonl` (`CLAUDE_CONFIG_DIR` moves `~/.claude`).
  - Subagents are in `<session id>/subagents/agent-<id>.jsonl`, each with an `agent-<id>.meta.json` holding `agentType` and the parent's `toolUseId`.
- **Entries:** one JSON object per line, each with `type` (`user`, `assistant`, `system`, `attachment`, …) and most with a `timestamp`.
  - A message the user typed is a `user` entry with `origin.kind: "human"`. Background task reports have `origin.kind: "task-notification"`; compaction summaries have no `origin`; skill text loaded for a command is `isMeta`.
  - Tool results are `user` entries with `tool_result` blocks, matched to `tool_use` blocks by id.
  - An assistant message is written as one line per content block, all with the same `message.id` and `usage`: tokens are counted once per id.
  - A tool call a hook refused carries `permissionDecision: { decision: "reject", source: "hook" }`. Auto-mode approvals have `source: "config"`.
  - A resumed session's file is not in time order, and can hold gaps of days inside one turn.
  - A typed `/fixcrash:fix <issue>` is a human entry, `<command-message>fixcrash:fix</command-message>` `<command-name>/fixcrash:fix</command-name>` `<command-args><issue></command-args>`, followed by the skill text as an `isMeta` entry.
  - A local command such as `/login` is a `system` entry with `subtype: "local_command"`. `subtype: "turn_duration"` entries carry `durationMs`, but with a background subagent their span is unclear, so the metrics don't use them.
  - The `Agent` tool runs a subagent in the background by default: the main agent ends its turn, and the subagent's report arrives as a task notification.
- `eval/metrics.ts` reads all of this. Agent time is the union of the main agent's turns and each subagent's span, so a background subagent counts as work.

**2026-10-08: First eval run, parser (step 4)** (Claude Code 2.1.293, plugin loaded with `--plugin-dir`)

- **`${user_config.*}` stays literal.** With `--plugin-dir` and no options set, the skill text kept `${user_config.project_dir}`, `${user_config.release_tag_pattern}`, `${user_config.max_hypotheses}` and the rest as is: the manifest defaults were not applied. `$0` and `${CLAUDE_SESSION_ID}` were substituted. The agent spent four tool calls looking for the config, then guessed `--project-dir .` and dropped the budget and tag-pattern flags, so the CLI's own defaults applied.
- **Model switch.** The main agent ran on `claude-opus-5`, then on `claude-sonnet-5` from the turn after the reproducer reported, with no user action in the transcript. The reproducer, `model: inherit`, ran on Opus.
- **The reproducer wrote its test with Bash** (a heredoc, then `python3`), not Write or Edit, so the hook's test-only check didn't see it. It touched only the test file (deferred list, step 3).
- Commits get Claude Code's own attribution trailer, from the user's settings: the plugin doesn't add or remove it.

**2026-10-07: React Native Firebase.** JS errors go through `recordError` (also the global handler). The JS stack is converted to a mock native exception. Line numbers are relative to the bundle after transpilation and minification, so source maps have to be kept and applied by the developer.

## 8. Risks

- **Testability of real apps.** Logic living in Activities, Fragments or ViewControllers can't be unit-tested without refactoring. Mitigation: an honest "can't reproduce" path, and measuring the reproducible share early.
- **Crashlytics MCP is Experimental.** Tools or fields may change. Mitigation: pin firebase-tools, and isolate MCP-shape assumptions in one place.
- **Version → commit** works only with a build stamp or tagged releases. AGP writes the commit only when the Gradle root is the git root (§7), which rules out most React Native apps and monorepos.
- **Build-tool friction.** Gradle and npm want the network, Xcode is slow, and machines differ (JDK, Android SDK, Xcode versions). Mitigation: let the user override the test command; use `--offline` after the cache is warm.
- **Overlap.** Google may extend its guide from a plan to a run. Acceptable: this is open source, not a business.

## 9. Open questions (answer in the spike)

1. ~~Does `buildStamp` carry the git commit on Android, from AGP VCS info in release builds?~~ Answered in §7 (spike). Is there anything comparable on iOS?
2. Are 20 frames enough to reach app code in typical Kotlin stacks (coroutines, RxJava, Compose)? Do we need the full event? Partly answered in §7: `blameFrame` survives truncation; real-app stacks still unchecked.
3. What share of a real app's top crashes can a unit test reproduce? This is the number that decides whether the plugin is useful.
4. ~~How do Debug builds and emulators report to Crashlytics, and how fast? Do events need a release build with an uploaded mapping?~~ Answered in §7 (spike).
5. ~~Can `firebase-tools mcp` start with only Crashlytics tools? What does the plugin need for auth and app-id discovery?~~ Answered in §7 (spike) for Android; `GoogleService-Info.plist` waits for iOS.
6. ~~How does the hook reliably recognise PR creation: `gh pr create` in Bash, GitHub MCP tools, `git push` plus a web PR?~~ Answered in step 3, as far as a hook can: `gh pr create`, `hub pull-request`, `gh api …/pulls` with a body, and any MCP tool named `create_pull_request` (or `pull_request_create`, `createPullRequest`). A PR opened on the web after `git push` happens outside Claude Code and can't be blocked; the PR body built from the receipt is what a reviewer checks.
7. Can `claude plugin eval` drive our eval (seeded crash → expected outcome), or do we need our own runner as in Veilleur?

## 10. Sources

- Crashlytics MCP: https://firebase.google.com/docs/crashlytics/ai-assistance-mcp
- firebase-tools source:
  - https://github.com/firebase/firebase-tools/tree/main/src/mcp/tools/crashlytics
  - https://github.com/firebase/firebase-tools/tree/main/src/mcp/resources/guides
  - https://github.com/firebase/firebase-tools/blob/main/src/crashlytics/types.ts
- Firebase agent skills: https://github.com/firebase/agent-skills
- artemnovichkov plugins: https://github.com/artemnovichkov/skills
- crash-to-vibe: https://github.com/naufaldiath/crash-to-vibe
- Sentry for AI: https://github.com/getsentry/sentry-for-ai
- Gemini in Android Studio, App Quality Insights: https://developer.android.com/studio/preview/gemini/deploy
- Sentry Seer: https://sentry.io/seer/
- Luciq Resolve Agent: https://docs.luciq.ai/docs/product-guides-smart-resolve
- Runway rollout automation: https://www.runway.team/automations/halt-unstable-phased-rollouts
- React Native Firebase Crashlytics: https://rnfirebase.io/crashlytics/usage
- React Native symbolication: https://reactnative.dev/docs/symbolication
- Claude Code plugin reference: https://code.claude.com/docs/en/plugins-reference
