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
| iOS (Swift) — second | `swift test` for logic in SPM packages; otherwise `xcodebuild test -scheme <s> -destination 'platform=iOS Simulator,…' -only-testing:<id>` (XCTest or Swift Testing) | minutes | Needs macOS and Xcode. No dSYM upload means no symbolicated stacks. Slow builds make the attempt budget tighter |
| React Native — third | Jest (in the RN template) | seconds | JS errors only. Native crashes in an RN app go down the Android/iOS paths. Symbolication: build the bundle and source map for the crashing commit (`react-native bundle --sourcemap-output`, Hermes source-map composition), then `metro-symbolicate`. Cache in `${CLAUDE_PLUGIN_DATA}` |

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
  - A session can end with `{ type: "continued-in", continuedInSessionId }`. The continuation's file repeats every entry of the first, same uuids, under its own session id, and goes on from there.
  - `cost-state` entries (no uuid) carry the session's running `totalCostUSD`, `totalDuration`, `totalAPIDuration`, `totalToolDuration` and `modelUsage` per model. They count more output tokens than the transcript's assistant messages hold (6245 against 4724 for the paging run): the cost covers calls the transcript doesn't show.
  - `pr-link` entries record a pull request the session opened: `prNumber`, `prUrl`, `prRepository`.
- `eval/metrics.ts` reads all of this.
  - Agent time is the union of the main agent's turns and each subagent's span, so a background subagent counts as work. An `AskUserQuestion` call pauses the turn until its answer: that wait is the user's.
  - The work ends at the last activity, not at a later `/exit`.
  - A continued session is merged into the one it continues, copied entries counted once. Cost is the sum of each session's last `cost-state`.

**2026-10-08: First eval run, parser (step 4)** (Claude Code 2.1.293, plugin loaded with `--plugin-dir`)

- **`${user_config.*}` stays literal.** With `--plugin-dir` and no options set, the skill text kept `${user_config.project_dir}`, `${user_config.release_tag_pattern}`, `${user_config.max_hypotheses}` and the rest as is: the manifest defaults were not applied. `$0` and `${CLAUDE_SESSION_ID}` were substituted. The agent spent four tool calls looking for the config, then guessed `--project-dir .` and dropped the budget and tag-pattern flags, so the CLI's own defaults applied. The docs say `userConfig` is prompted for "when the plugin is enabled", and `default` is the "value used when the user provides nothing": `--plugin-dir` skips that. The skills now give each option's default next to its placeholder.
- **Model switch.** The main agent ran on `claude-opus-5`, then on `claude-sonnet-5` from the turn after the reproducer reported. The user didn't switch it; Claude Code was updating itself at the time (2.1.293 to 2.1.294, whose default model is `claude-opus-5-5`). The reproducer, `model: inherit`, ran on Opus.
- **The reproducer wrote its test with Bash** (a heredoc, then `python3`), not Write or Edit, so the hook's test-only check didn't see it. It touched only the test file (deferred list, step 3).
- Commits get Claude Code's own attribution trailer, from the user's settings: the plugin doesn't add or remove it.

**2026-10-08: Second eval run, paging (step 4)** (Claude Code 2.1.294, `claude-opus-5-5` throughout)

- **The options fix works.** With the defaults written next to each `user_config` placeholder, the agent made no config search: `fixcrash app-id --project-dir .` first, `--tag-pattern 'v{display}'` passed explicitly.
- **Asking before the push**, the agent used the `AskUserQuestion` tool rather than plain text. The reproducer wrote its test with Edit, so the hook's test-only check saw it, and ended with a `SubagentHandback` call.

**2026-10-08: Third eval run, lifecycle (step 4): a false proof** (Claude Code 2.1.294, `claude-opus-5-5`)

- **Expected** an honest report and no PR. **Got** REPRODUCED and VERIFIED on the first attempt, and a pull request.
- **The test** built `DetailsFragment` with `sun.misc.Unsafe.allocateInstance`, so its constructor never ran (no `Handler`, no host), and called the private `onDetailsLoaded` through reflection. `requireContext()` threw `IllegalStateException` at the crash's blame frame, so the "same failure" check passed at the crashing commit and at the fix parent.
- **The reproducer's reason:** the module has no Robolectric, and the fragment's `Handler(Looper.getMainLooper())` field can't be built on the JVM. It took the shortcut without trying anything else.
- **What the proof covered:** the fix had two parts, cancelling the delayed load in `onDestroyView` (the real fix) and returning early when `context` is null (defensive). The test exercised only the early return. The agent said so to the user, but only after opening the PR.
- **Lesson:** exception type plus top app frame is necessary, not sufficient. Reflection and constructor bypass reach any frame from any state.
- **Changes:** `reproduce` and `verify` refuse a test whose new lines build an object without its constructor (`Unsafe`, Objenesis, a serialization constructor) or open a private member (`isAccessible = true`, `setAccessible(true)`, `trySetAccessible`, `privateLookupIn`, Whitebox). The reproducer is told to reach the crash the way the app does, or answer NOT REPRODUCED and name what would (Robolectric). The fix skill reads the test on REPRODUCED, and says what the test covers before asking to push.

**2026-10-15: iOS testbed (step 5.2)** (`testbed/ios`; Xcode 27.0, iOS 27.0 simulator, Swift 6.4, Firebase iOS SDK 13.0.1 through SPM, Apple silicon Mac)

- **Toolchain**
  - Simulator builds need no Apple account and no signing team.
  - Resolving Firebase through SPM fetches 13 packages, about 1.4 GB. `xcodebuild -list` resolves too, into the default DerivedData, not into `-derivedDataPath`.
  - With packages resolved, a clean Debug build plus the three unit tests takes 37 s; a Release build of the app, 14 s.
  - `xcodebuild test` runs test classes in parallel on clones of the destination simulator (`Clone 1 of iPhone 17`). Its log line is `Test case 'FeedPagerTests.testCountsPartialPage()' passed on …`; the result bundle is `<derivedData>/Logs/Test/Test-<scheme>-<date>.xcresult`.
- **Project**
  - With `INFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES` and the app delegate's `configurationForConnecting`, a UIKit app on the UIScene lifecycle needs no `Info.plist` file.
  - A folder-synchronized target (`PBXFileSystemSynchronizedRootGroup`) builds every file in its folder: a new test file needs no `project.pbxproj` entry.
  - A unit test target hosted in the app runs the app's launch code. The testbed skips `FirebaseApp.configure()` when `XCTestConfigurationFilePath` is set; an app that doesn't would send Crashlytics a report for each crashing test.
  - Firebase's `Crashlytics/run` script validates, then starts `upload-symbols --build-phase` in the background with its output discarded. Run from Claude Code's Bash tool, that process died with the command: no upload, nothing in the macOS log, and the console showed "This app has 3 unprocessed crashes. Upload 1 dSYM file to process them." The testbed's build phase calls `upload-symbols --build-phase` in the foreground instead ("Successfully submitted symbols for architecture arm64 with UUID …"). It runs with `ENABLE_USER_SCRIPT_SANDBOXING = NO` on the app target (not tried with the sandbox on), and for Release only, so test builds never reach Firebase.
  - Crashlytics takes crashes without a dSYM, but holds them back: until the dSYM for the binary's UUID arrives, the reports API (`topIssues`) returns nothing for them.
- **Crashes on the simulator** (local crash reports, `~/Library/Logs/DiagnosticReports/Testbed-<date>.ips`; what Crashlytics shows is step 5.3)
  - A force unwrap of `nil` and an array index out of range are both `EXC_BREAKPOINT (SIGTRAP)`. The crashed thread's top frame is a pseudo-frame named after the failure, `Swift runtime failure: Unexpectedly found nil while unwrapping an Optional value` or `… Array index is out of range`, even in an optimized Release build. The app frame below it keeps its own name through inlining: `ProfileParser.parse(_:)`, `FeedPager.page(_:)`.
  - A closure's frame is named `closure #1 in SyncService.start(completion:)`.
  - `simctl launch <device> <bundle id> -scenario <name>` passes the argument to `UserDefaults`. A crash under `simctl launch` is not caught by a debugger.
  - A background task the app never ends expires about 30 s after the app leaves the foreground for another app, and the simulator calls its expiration handler (`-[_UIBackgroundTaskInfo fireExpirationHandler]`).

**2026-10-15: iOS events through Firebase MCP (step 5.3)** (the testbed's Release build on the iOS 27.0 simulator, Crashlytics SDK 13.0.0, firebase-tools 15.32.1). Answers §9 question 1 for iOS and question 5's `GoogleService-Info.plist` part.

- **Timing:** with the dSYM already uploaded, the three crashes were in `topIssues` within 3 minutes (received 1 to 2 minutes after the crash). The first three crashes, held back for a missing dSYM, still weren't there 15 minutes after it was uploaded.
- **Issue:** title `[Testbed] <file> - <symbol>`, e.g. `[Testbed] SyncService.swift - closure #1 in SyncService.start(completion:)`; subtitle `EXC_BREAKPOINT`, the Mach exception type only. The Swift runtime message ("Unexpectedly found nil …") is nowhere in the issue or the event.
- **Event fields**
  - `platform: IOS`. No `exceptions` and no `buildStamp`; the stack is in `threads`, as text: `Thread:  (crashed)`, then `at <symbol> (<file>:<line>)` lines, cut at 20 frames (`... frames omitted ...`); a frame with no symbol prints as a bare `at`.
  - `blameFrame` has `symbol`, `file`, `line`, `library: Testbed`, `owner: DEVELOPER`, and `address`: the crash's offset in the app binary (29516 for the parser crash, the `.ips` report's `imageOffset`).
  - `processState`: `FOREGROUND` for parser and paging, `BACKGROUND` for lifecycle.
  - `user`, `customKeys`, `logs` and `breadcrumbs` (Analytics `screen_view` and the app's events) arrived only for the lifecycle crash, 30 s after the last action. Parser and paging crash a second after launch and have none of them, the user id included: the SDK writes them asynchronously.
- **Inlined frames are lost.** Crashlytics symbolicates without inline frames. In the Release build `ProfileParser.parse(_:)` is inlined into `MainViewController.openProfile()` and `FeedPager.page(_:)` into `MainViewController.loadMore()`, so those are the blame frames, and the issues are named after them. A unit test that calls `ProfileParser.parse` directly (Debug, no inlining) never has `openProfile()` on its stack.
- **The blame frame's file and line can be wrong.** `MainViewController.openProfile() (FakeBackend.swift:6)` for a crash at `ProfileParser.swift:10`; `SyncService.swift:31` for line 28. The symbol is right. (Hypothesis: the line comes from the instruction before the trap, which the compiler places at the end of the function.)
- **The address recovers what is lost.** `atos -arch arm64 -o <dSYM>/Contents/Resources/DWARF/Testbed -l 0x100000000 -i 0x100000000+<address>` against the build's dSYM gives the full inline chain: `Swift runtime failure: Unexpectedly found nil while unwrapping an Optional value`, `ProfileParser.parse(_:) (ProfileParser.swift:10)`, `MainViewController.openProfile() (MainViewController.swift:50)`. Not yet checked: whether a rebuild of the same commit gives a binary with the same UUID, so a developer's own rebuild can stand in for the shipped dSYM.
- **fixcrash today:** `toCrashEvent` reads the version and the blame frame, but with no `exceptions`, `expectationOf` returns nothing: the hook records no expected failure for an iOS event. Redaction drops `user` and `installationUuid` as on Android.
- **Commit (question 1):** no build stamp in iOS events. Without one, the version-to-commit step has the release tag only (`CFBundleShortVersionString`, e.g. `v1.0`).
- **App id (question 5):** `GOOGLE_APP_ID` in `GoogleService-Info.plist`. `fixcrash app-id` reads only `google-services.json` so far.

**2026-10-15: A crashing test on iOS (step 5.4)** (the testbed at `6af448a`, Xcode 27.0, iOS 27.0 simulator; spike tests not committed)

- **The failure**
  - A Swift trap in a test kills the test host. `xcodebuild test` exits 65 and lists the test as failed with no reason in its log.
  - The result bundle's summary (`xcrun xcresulttool get test-results summary`) has `failureText: "Crash: Testbed at +[XCTFailableInvocation invokeErrorConventionInvocation:completion:]"`, an XCTest frame, not the crash's.
  - The crash log is an attachment of the failed test: `xcrun xcresulttool export attachments --path <bundle> --output-path <dir>` writes it as `<id>.ips` with a `manifest.json` that maps `testIdentifier` to the file, with `isAssociatedWithFailure: true`. macOS also writes it to `~/Library/Logs/DiagnosticReports/` and shows its crash dialog.
  - Its crashed thread, Debug build: `_assertionFailure(_:_:file:line:flags:)` frames in `libswiftCore.dylib`, then `ProfileParser.parse(_:) (ProfileParser.swift:10)` in the image `Testbed.debug.dylib` (Debug builds put the app's code there), then `SpikeCrashTests.testParsesProfileWithoutAvatar()` in the image `TestbedTests`. Exception type `EXC_BREAKPOINT`, as in the event. For an array index: `Array._checkIndex(_:)` and `Array.subscript.getter` in `libswiftCore.dylib`, then `FeedPager.page(_:)`.
  - The Swift message (`Testbed/ProfileParser.swift:10: Fatal error: Unexpectedly found nil while unwrapping an Optional value`) is in `xcodebuild`'s output only with `-parallel-testing-enabled NO`; it is in neither the crash log nor the result bundle's logs. After the crash: "Restarting after unexpected exit, crash, or test timeout".
  - Swift Testing: the same, with `Crash: Testbed at specialized static Runner._applyScopingTraits(for:testCase:_:)` and the same crash log attachment.
- **Test ids for `-only-testing`:** XCTest `TestbedTests/SpikeCrashTests/testParsesProfileWithoutAvatar`, Swift Testing `TestbedTests/SpikeSwiftTestingCrash/pageBeyondLastPartialPage()` (with the parentheses). The result bundle names both `<Suite>/<test>()`.
- **A new test file** in the folder-synchronized test target built and ran with no change to `project.pbxproj`.
- **Time and stability**
  - With a warm build: the testbed's suite 20 s; a targeted crashing test 29 to 34 s, most of it starting and restarting the test host.
  - Parallel testing (the scheme default) shuts the booted simulator down and boots a clone (`Clone 1 of iPhone 17`) for every run.
  - Two of five crashing runs hung: one sequential run after the restart, in "Blocking finish to clean up test session" (stopped after 10 min); one parallel run before testing started (stopped by a 150 s guard). The same commands went through on other tries. `run.ts` has one timeout, 30 min, for every command.
- **A rebuild of the crashing commit:** the testbed rebuilt in Release from a copy at another path had other UUIDs (paths end up in the binary), the same `__text` size, and one different instruction in 545,000 lines of disassembly, a string offset. `atos -i` against the copy's dSYM gave the same inline chains for all three crashes' addresses.

**2026-10-15: fixcrash on a copy of the iOS testbed (step 5.5)** (`testbed/copy-ios.sh`, events recorded from the step 5.3 issues as the hook would; Xcode 27.0, iOS 27.0 simulator)

- **The copy** took 31 s, its Release build included: Swift packages came from SPM's cache.
- **parser:** `reproduce` REPRODUCED on its first attempt in 89 s: a Release build of `v1.0` in fixcrash's cache, `atos` at the event's address (`crash site: the crash is in ProfileParser.parse(_:)(ProfileParser.swift:10), inlined into MainViewController.openProfile() (Swift runtime failure: Unexpectedly found nil while unwrapping an Optional value)`), then the Debug build and the test, 60 s. `verify` VERIFIED: base 30 s (the crash site cached), fix parent 334 s (a hang, see below), suite with the fix 21 s. `pr-body` built the description from the receipt.
- **paging:** REPRODUCED at `FeedPager.page(_:)`, inlined into `MainViewController.loadMore()` (`Array index is out of range`), 169 s with a hang.
- **lifecycle:** the crash site is the expiration handler's closure itself. A test that starts a sync and waits for it passes at `v1.0`: NOT REPRODUCED in 36 s. A test that swizzles `beginBackgroundTask(withName:expirationHandler:)` was refused before any build.
- **Hangs:** in two of the four runs where the test crashed, `xcodebuild test-without-building` hung after "Restarting after unexpected exit, crash, or test timeout"; never in a run where it didn't. Each time the timeout (5, then 2 minutes) killed it and the retry went through.
- **The Release build runs the app's build phases.** The testbed's uploaded the worktree build's dSYM to Crashlytics ("Successfully uploaded Crashlytics build event and symbols"), a binary with yet another UUID.

**2026-10-15: The iOS eval (step 5.6)** (Claude Code 2.1.300, `claude-opus-5-5`; results in `docs/EVAL.md`)

- **Why xcodebuild hung after a crashing test.** Eight runs of the same crashing test, alternating `-collect-test-diagnostics on-failure` (the default) and `never`, with a 120 s guard: `on-failure` hung twice in four runs (no result bundle), `never` went through four times out of four in 8 to 22 s, with the crash log attached each time. The hangs are the diagnostics collection after a failure ("verbose diagnostics (like a sysdiagnose)", `xcodebuild -help`).
- **A timed-out retry leaves an unfinished result bundle**: a `tests-retry.xcresult` with no `Info.plist`, which `xcresulttool` refuses.
- **The agent takes xcodebuild's test id form.** In both sessions that verified, the first `fixcrash verify` got `TestbedTests/ProfileParserTests/testParsesProfileWithoutAvatar`, the form of the fix skill's `-only-testing` example.

**2026-10-15: SwiftUI crashes on the simulator (step 5.7.1)** (`testbed/swiftui`, Release build, Xcode 27.0, iOS 27.0 simulator; local crash reports, `~/Library/Logs/DiagnosticReports/TestbedSwiftUI-<date>.ips`; what Crashlytics shows is step 5.7.2)

- All three are `EXC_BREAKPOINT (SIGTRAP)` under a `Swift runtime failure: …` pseudo-frame, as in the UIKit app. SwiftUI's frames are in the images `SwiftUI` and `SwiftUICore`.
- **render** (an index out of range in the `ForEach` content closure): `Swift runtime failure: Index out of range`, then `specialized Array._checkSubscript(_:wasNativeTypeChecked:)` and `specialized Array.subscript.getter`, both in the app's image, not in `libswiftCore.dylib`, then `closure #1 in closure #1 in TagsView.body.getter (TagsView.swift:10)`, then `ForEachState.item(at:offset:)` in `SwiftUICore`. The view's `body` is a property: its closures are named after its getter, and numbered by nesting (the `List`'s content closure, then the `ForEach`'s inside it).
- **async** (a force unwrap after an `await`, in a function `.task` calls): `InboxModel.load() (InboxModel.swift:23)`, then `closure #2 in InboxView.body.getter (InboxView.swift:12)`, the `.task` closure, then a `<deduplicated_symbol>` in the app's image and `completeTaskWithClosure` in `libswift_Concurrency.dylib`. The part of `load()` that runs after the `await` is named `load()`.
- **action** (a force unwrap in a toolbar button's closure): `closure #1 in closure #2 in ArchiveView.body.getter (ArchiveView.swift:26)`, then `MainActor.assumeIsolated` and `ButtonAction.callAsFunction()` in `SwiftUI`.
- `simctl launch <device> <bundle id> -screen <name>` reaches the app's `App` struct through `UserDefaults`, as in the UIKit app; a `NavigationStack(path:)` built from it opens the screen. `simctl` can't tap; Claude Code's iOS Simulator tool tapped the toolbar button at its point coordinates.

**2026-10-15: SwiftUI events through Firebase MCP (step 5.7.2)** (the same build; Crashlytics SDK 13.0.0, firebase-tools 15.32.1)

- **The dSYM again.** The build phase's `upload-symbols --build-phase` printed "Successfully uploaded Crashlytics build event and symbols" a few minutes after the Firebase app was created, before the first crashes. The console still showed "This app has 3 unprocessed crashes. Upload 1 dSYM file". `upload-symbols -gsp <plist> -p ios <dSYM>` by hand submitted the same UUIDs and the message went away. Those three crashes never reached `topIssues` (still one event per issue a day later); the same three triggered again after it were there about 3 minutes after the crash, received together 30 to 60 s after them. Why the first upload didn't count is not known (the app was new; the build phase's output wasn't kept).
- **Issues and blame frames.** One issue per scenario, subtitle `EXC_BREAKPOINT`:
  - render: `[TestbedSwiftUI] TagsView.swift - closure #1 in closure #1 in TagsView.body.getter`. The `specialized Array` frames above it are inlined into the closure (one address in the `.ips` report), so Crashlytics drops them and blames the closure.
  - async: `[TestbedSwiftUI] InboxModel.swift - InboxModel.load()`.
  - action: `[TestbedSwiftUI] ArchiveView.swift - closure #1 in closure #2 in ArchiveView.body.getter`.
  - Each blame frame's `address` is the `.ips` report's `imageOffset`; each `line` is one below the crash's line (11, 24 and 27 for 10, 23 and 26).
- **The async caller is gone.** The event's crashed thread is `InboxModel.load()`, then `swift::runJobInEstablishedExecutorContext`, `swift_job_runImpl` and the main queue: the stack the continuation ran on. The `.task` closure that awaited `load()` is only in the `.ips` report, which adds the async callers.
- **SwiftUI's frames are mangled** in `threads` (`$s7SwiftUI12ForEachStateC4item…`), and some name other functions than the `.ips` report does (`ContextMenuBridge…willPerformPreviewAction…` where it has `<deduplicated_symbol>`).
- **Process state, keys, logs:** render crashed a second after launch, with `UNKNOWN_PROCESS_STATE` and no user, keys or logs. async (after a 200 ms `await`) has the user id, the custom key, the log and the breadcrumb. action has the user id only: the crash comes right after `Telemetry.track`, in the same call.
- **fixcrash today:** `expectationOf` gives `EXC_BREAKPOINT`, the blame frame and its site (image `TestbedSwiftUI`, the address) for all three, as for the UIKit events.
- **ADR-0002:** `atos -i` at each address against the build's dSYM gives the `Swift runtime failure` pseudo-frame, the inlined `specialized Array` frames for render (from `<compiler-generated>`, no file), and ends in the blame frame. `resolveSite`'s rules, run on that output (`parseAtos`, `sameSymbol`, the first frame with a file in the project), keep the blame frame for all three: the release build adds nothing, and costs a build.

**2026-10-16: Failing tests for the SwiftUI scenarios (step 5.7.3)** (`testbed/swiftui` at `6f41c7b`, Xcode 27.1 with the iOS 27.0 simulator; spike tests not committed; fixcrash's `parseCrashLog` and `matchFailure` run on each test's crash log)

- **Rendering a screen in a hosted test:** a `UIWindow` on the app's connected `UIWindowScene`, a `UIHostingController` with the screen in a `NavigationStack`, `makeKeyAndVisible()`, then the run loop for a second. The `List` lays out its rows and SwiftUI runs the `ForEach` content closure.
- **render:** the test crashes at `closure #1 in closure #1 in TagsView.body.getter (TagsView.swift:10)` in `TestbedSwiftUI.debug.dylib`, under `Array._checkSubscript` and `Array.subscript.getter` in `libswiftCore.dylib` (not specialized in a Debug build). The check accepts it.
- **async:** the crash log names the code after the `await` `InboxModel.load()`, as the release build does, so no rule for `async` partial functions is needed. A test that awaits `load()` has the test method under it; a test that renders the Inbox screen has `closure #2 in InboxView.body.getter`, the `.task` closure. The check accepts both.
- **Time:** each crashing test 8 to 11 s with a warm build, with `-collect-test-diagnostics never`; no hang in the four crashing runs.
- **action:** the toolbar button is a SwiftUI view in a `UIKitBarItemHost<BarItemView>`: no `UIControl`, no `UIBarButtonItem`. With accessibility off (it is, in a test process), SwiftUI exposes no accessibility elements at all.
  - libAccessibility's private `_AXSApplicationAccessibilitySetEnabled(1)` and `_AXSSetAutomationEnabled(1)` (through `dlsym`) turn them on: `AccessibilityNode` elements for the rows and the button. `accessibilityActivate()` on "Archive" runs the action: `closure #1 in closure #2 in ArchiveView.body.getter (ArchiveView.swift:26)`, under `ButtonAction.callAsFunction()` and `AccessibilityButtonModifier`, where a tap has `_ButtonGesture`. The check accepts it.
  - The switch is the simulator's: `ApplicationAccessibilityEnabled` and `AutomationEnabled` in its `com.apple.Accessibility` defaults. A later run that doesn't call it still sees the elements. Deleting the two keys took effect only after the simulator rebooted.
  - fixcrash's shortcut check would refuse the spike's test, for its `unsafeBitCast` of the `dlsym` pointer; a `@_silgen_name` declaration would pass. The decision on this path is ADR-0003.
- **Xcode updated itself** to 27.1 overnight. Until its components were installed (an admin password), the system's CoreSimulator (1171.7) was older than the new Xcode's (1174.9.2): `xcodebuild` reported "Unable to find a device matching the provided destination specifier", with "CoreSimulator is out of date" a few lines above it, and `simctl` hung.

**2026-10-16: fixcrash on a copy of the SwiftUI testbed (step 5.7.4)** (`testbed/copy-ios.sh swiftui`, events recorded from the step 5.7.2 issues as the hook would; Xcode 27.1, iOS 27.0 simulator; tests written as the reproducer's SwiftUI guidance says)

- **The copy** took 32 s, its Release build included.
- **render:** a test that renders `TagsView` in a `NavigationStack`, in a window on the app's scene. `reproduce` REPRODUCED on the first attempt in 53 s: a Release build of `v1.0` in fixcrash's cache, `atos` at the event's address (`crash site: the crash is in closure #1 in closure #1 in TagsView.body.getter(TagsView.swift:10) itself (Swift runtime failure: Index out of range)`), then the test, 22 s. With the rows built from the tags themselves, `verify` VERIFIED in 35 s: base and fix parent fail as the crash did, the fix passes, the suite is green.
- **async:** a test that awaits `InboxModel().load()`. REPRODUCED in 24 s (the release build cached), VERIFIED in 36 s with a headline for an empty inbox.
- **action:** a test that turns accessibility on through `@_silgen_name("_AXSApplicationAccessibilitySetEnabled")` was refused in 0.15 s, before any build: "turns accessibility on through private libAccessibility functions, line 5".
- No hang in any run.

**2026-10-07: React Native Firebase.** JS errors go through `recordError` (also the global handler). The JS stack is converted to a mock native exception. Line numbers are relative to the bundle after transpilation and minification, so source maps have to be kept and applied by the developer.

**2026-10-16: React Native, before step 6** (React Native Firebase 26.4.0, source of `packages/crashlytics` on `main`; `@react-native-community/template` 0.88.0; reactnative.dev/docs/symbolication)

- **A JS crash, as React Native Firebase reports it**
  - The global handler (`ErrorUtils.setGlobalHandler`) converts the error's stack with `stacktrace-js` (`StackTrace.fromError(error, { offline: true })`) when `isErrorGenerationOnJSCrashEnabled` is on. It sets the custom key `com.firebase.crashlytics.reactnative.fatal` to a timestamp, logs the Analytics event `app_exception` with `fatal: 1` when Analytics is there, then calls `crashWithStackPromise`. With handler chaining on, it calls `recordErrorPromise` instead, then the original handler.
  - Natively, both calls record an exception, and `crashWithStackPromise` then exits the app (`System.exit(0)`, `exit(0)`). No native crash happens. According to the source, the custom key is what makes the backend treat the event as fatal.
  - Android: `recordException` of an `io.invertase.firebase.crashlytics.JavaScriptError` (`UnhandledPromiseRejection` for a rejection), with `StackTraceElement("", fn, file, -1)` frames. iOS: `recordExceptionModel` of a `FIRExceptionModel` named `JavaScriptError` (or `UnhandledPromiseRejection`), with `FIRStackFrame` frames (`fn`, `file`, `line`).
  - The payload's message is `error.message`, without the error's name: a `TypeError` arrives as `JavaScriptError` with its message. A frame's `file` is the file name without its query, plus `:<line>:<column>`, and `fn` is the function name or `<unknown>`. `recordError(error, jsErrorName)` adds a first frame that carries the name in `file`.
  - Unhandled rejections are tracked with the `promise` library's `rejection-tracking` module, for all rejections, and ignored when `__DEV__` is set.
- **The RN template (0.88.0, published 2026-10-16)**
  - React 19.3.0, Jest 29 with `@react-native/jest-preset`, react-test-renderer 19.3.0, and a test that renders `App`.
  - Hermes on (`hermesEnabled=true`); the Hermes compiler's flags default to `-O -output-source-map`. Node 22.11 or later.
  - A Gemfile for CocoaPods (Ruby 2.6.10 or later).
- **Symbolication** (the RN docs)
  - `metro-symbolicate <map> < <stack trace>`. The map must come from the crashing build's commit.
  - Android release builds write the composed map to `android/app/build/generated/sourcemaps/react/release/index.android.bundle.map`.
  - iOS builds make no map unless `SOURCEMAP_FILE` is exported in the "Bundle React Native code and images" build phase.
- **This machine:** no CocoaPods and no Watchman. Ruby is the system's 2.6.10. Android Studio's JDK is 25.

**2026-10-16: React Native testbed (step 6.2)** (`testbed/react-native`; RN 0.88.0 from `@react-native-community/cli` 20.2.0, React Native Firebase 26.4.0, Crashlytics Android SDK 20.1.0; Release builds on the API 37 emulator and the iOS 27.0 simulator; logcat and the simulator's unified log)

- **Builds**
  - The template's Gradle 9.4.1 runs on Android Studio's JDK 25. The first `assembleRelease` downloaded NDK 27.1 by itself (its license was already accepted) and took 3 minutes.
  - `pod install` took 52 s and says that calling it directly is deprecated in React Native. React Native Firebase brings the Firebase iOS SDK in through Swift Package Manager inside the Pods project, with `use_frameworks! :linkage => :dynamic`.
  - `pod install` adds React Native Firebase's "[RNFB] Crashlytics Configuration" build phase to the app target. With the SDK from SPM, the phase runs `upload-symbols` in the foreground with `-gsp ${PROJECT_DIR}/GoogleService-Info.plist`, the directory of the Xcode project, not the app's folder. With the config there, the Release build printed "Successfully uploaded Crashlytics symbols".
  - With Hermes on, release bundles skip Metro's minifier. The Gradle plugin sets `minifyEnabled` to `!hermesEnabled`, and `react-native-xcode.sh` passes `--minify false`. The Hermes compiler comes from the npm package `hermes-compiler`.
  - Android keeps the composed source map in `android/app/build/generated/sourcemaps/react/release/index.android.bundle.map`. An iOS build writes one when `SOURCEMAP_FILE` is passed to `xcodebuild` as a build setting.
- **Three paths a JS error takes in the app**, all three seen on both platforms, with handler chaining off (what reaches Crashlytics is step 6.3)
  - **An error in a timer callback** (and, by React Native's design, in a button's handler) goes to `ErrorUtils`' global handler, which React Native Firebase replaced.
    - Android: logcat shows `io.invertase.firebase.crashlytics.JavaScriptError: Cannot read property 'url' of undefined`, then frames such as `at .parseProfile(address at index.android.bundle:1:485277)`, then the VM exits with code 0. iOS logs "Crashlytics - Crash logged. Terminating app."
    - `stacktrace-js` reads Hermes's `address at` prefix as part of the file name.
    - Function names survive. Built-ins show as `(native):0:0` frames, for example `.toISOString((native):0:0)` above `dayKey`.
    - `prepare`, the function between the timer's closure and `parseProfile`, is missing from the stack. Hypothesis: the Hermes compiler inlined it (`-O`).
  - **An error while React renders** goes to React's `onUncaughtError`, which calls `ExceptionsManager.handleException(error, true)` directly, not through `ErrorUtils`, so React Native Firebase never sees it. The app crashes natively.
    - Android: `FATAL EXCEPTION: mqt_v_native`, `com.facebook.react.common.JavascriptException: TypeError: Cannot read property 'label' of undefined`. The message holds the component stack ("This error is located at: at TagList (address at index.android.bundle:1:487060) …"), then `, stack:` and the JS stack.
    - iOS: an uncaught `RCTFatalException: Unhandled JS Exception: TypeError: …`, with a crash report in `~/Library/Logs/DiagnosticReports/`.
  - **An error inside a promise** is a rejection, not a crash. The testbed's screen catches it and calls `recordError`, and Crashlytics' debug log on Android shows "disk worker: log non-fatal event to persistence".
  - Hermes's messages: "Cannot read property 'url' of undefined" (V8: "Cannot read properties of undefined (reading 'url')"), and "Date value out of bounds" for `toISOString()` of an invalid date.
- **Dates:** Hermes's `Date` parser (`lib/VM/JSLib/DateUtil.cpp`) takes ISO dates, with a `T` or a space between date and time, and forms that start with a weekday. `2026-10-16 10:00` parses; `2026/10/16 10:00` doesn't, and `toISOString()` throws. Node 24 parses every `YYYY/MM/DD HH:mm` with each field in range: 8,035,200 strings over 15 years, in three time zones (Europe/Paris, UTC, America/Los_Angeles).
- **Opening a screen from the command line**
  - `xcrun simctl openurl` with a custom scheme asks "Open in "TestbedRN"?" every time, and `simctl` can't confirm it.
  - React Native's iOS `Settings` reads a launch argument (`simctl launch … -screen inbox`) from `NSUserDefaults`.
  - On Android, `am start -a android.intent.action.VIEW -d testbedrn://…` hands the link to `Linking.getInitialURL()`.
  - An app that handles its launch screen inside that promise turns a crash into a rejection. The testbed opens the screen from a timer instead.
- **Jest:** React Native Firebase's modules and React Native's `Settings` (TurboModule `SettingsManager`) don't exist under Jest, and need `jest.mock` stubs in the setup file.

**2026-10-16: React Native events through Firebase MCP (step 6.3)** (the step 6.2 testbed, its Release builds on the API 37 emulator and the iOS 27.0 simulator; React Native Firebase 26.4.0, Crashlytics SDK 20.1.0 on Android and 12.19.2 on iOS, firebase-tools 15.32.1). Answers §9 question 1 for RN.

- **React Native Firebase's report of a fatal JS error is lost**
  - With handler chaining off, as the testbed had it in 6.2 and as React Native Firebase's docs advise once an app is integrated: no parser or engine crash reached Crashlytics on either platform, 40 minutes after the crashes.
    - On Android, with Crashlytics' debug log on, the `JavaScriptError` line is followed straight by "VM exiting with result code 0". "disk worker: log non-fatal event to persistence" never shows: the SDK writes a recorded exception on a background worker, and `crashWithStackPromise` exits before it does.
    - On iOS, the report folder (`Library/Caches/com.crashlytics.data/<bundle id>/v5/reports/active/<id>/`) held no exception record after the crash.
  - With chaining on, React Native Firebase's default, React Native's own handler crashes the app natively after React Native Firebase records the error.
    - Android: only the native crash arrives. React Native Firebase's `JavaScriptError` is lost here too.
    - iOS: both arrive, from the same report: the native crash as a FATAL event, and React Native Firebase's `JavaScriptError` as a NON_FATAL one. The custom key that marks it fatal didn't make it FATAL.
  - The testbed now runs React Native Firebase's default (no `firebase.json`).
- **The native crash is what carries a fatal JS error**, render errors included
  - **Android:** `exceptions` is `com.facebook.react.common.JavascriptException: <JS error type>: <Hermes message>, stack:`, then the JS stack as `<function>@1:<column>` lines (`parseProfile@1:485277`, `anonymous@1:708373`), then the Java frames. A render error adds React's component stack (`at TagList (address at index.android.bundle:1:487060)` …) before `, stack:`, and its JS stack runs `anonymous@1:664863`, `TagList@1:487205`, `renderWithHooks@1:267316`, ….
  - **Every fatal JS error on Android is in one issue**, under one variant. The issue is titled `com.facebook.react.modules.core.ExceptionsManagerModule.reportException`. Its blame frame is `ExceptionsManagerModule.reportException (ExceptionsManagerModule.kt:52)`, `owner: THIRD_PARTY`. Parser, engine and render events all landed in issue `77ff1260…`. The issue's subtitle shows one event's message, and the other events can only be found by reading the events themselves.
  - **iOS:** an `RCTFatalException` NSException. The issue is titled `[CoreFoundation]`, and its subtitle reads `RCTFatalException: Unhandled JS Exception: <type>: <message> - ExceptionsManager.reportException raised an exception: Unhandled JS Exception: <type>: <message>, stack:` followed by the JS stack (`parseProfile@1:484854`, `anonymous@1:706303`).
    - The event's `exceptions` holds the same text, then 12 bare `at` lines. The blame frame has only `library: CoreFoundation` and an `address` (the `__exceptionPreprocess` offset), `owner: DEVELOPER`. The crashed thread is Crashlytics' own handler and React Native's TurboModule queue.
    - Unlike Android, each error is an issue of its own: parser and engine are two issues.
  - The JS error's type (`TypeError`, `RangeError`) is in the native crash's message, but not in React Native Firebase's events.
  - iOS render crashes didn't reach Crashlytics: the one at 20:27 with chaining off, and the one at 21:07 with chaining on. Both left an `.ips` report on the Mac. Cause unknown.
- **React Native Firebase's non-fatal events** (`recordError`, and on iOS the chained copy of a fatal one)
  - **Android:** `exceptions` is `io.invertase.firebase.crashlytics.JavaScriptError: <message>`, then frames such as `at .?anon_0_ (address at index.android.bundle:1:698961)`, `at .next ((native):0:0)`, `at .asyncGeneratorStep (address at index.android.bundle:1:432790)`, `at .tryCallOne (address at InternalBytecode.js:1:27784)`.
    - The blame frame is the top frame, with `file: address at index.android.bundle:1:698961`, `symbol: .?anon_0_`, `owner: THIRD_PARTY`. The issue is titled `<file> - <symbol>`.
  - **iOS:** `JavaScriptError: <message>`, then frames such as `at parseProfile (address at <app container>/TestbedRN.app/main.jsbundle:1:484854:1)`. The file is the bundle's absolute path in the app's container (on the simulator, under the user's home directory), and `:1` (the frame's line) is appended to it.
    - The blame frame has `symbol: parseProfile`, `line: '1'`, `owner: DEVELOPER`, and the path as `file`. For the engine crash the blame frame is the built-in, so the issue is titled `(native):0:0 - toISOString`.
    - A new install has a new container path. Its events still joined the same issue: async from two installs is one issue.
  - **After `await`, the function's name is gone:** `loadHeadline`'s code after the `await` runs as `?anon_0_`, the generator that Babel's async-to-generator transform makes of it, under `asyncGeneratorStep` and Hermes's promise internals (`InternalBytecode.js`).
- **A rejection nobody catches** reaches nothing: a temporary build without the inbox's `catch` showed "Loading…" forever. Android's log had no non-fatal and no rejection line, and Crashlytics had no event.
- **Both platforms:** each platform has its own bundle and offsets: `parseProfile` is at 485277 on Android and 484854 on iOS. Every frame is on line 1, and the column is a Hermes bytecode offset. Hermes's messages are what the events show.
- **Version and commit:** version `1.0 (1)` on both platforms. Android's `buildStamp` is `generate_error_reason: NO_SUPPORTED_VCS_FOUND` (the Gradle root is `android/`, not the git root), iOS has none. Only a release tag finds the commit.
- **Other fields:** `user.id`, `customKeys` (`screen`), `logs` and `installationUuid` arrive as with native crashes. Redaction applies as before. The simulator's bundle path also carries the user's home directory, which no redaction rule removes; a device's path (`/private/var/containers/Bundle/Application/<uuid>/`) doesn't.
- **App ids:** `apps:sdkconfig ANDROID` writes a `google-services.json` that lists every Android app in the project. `fixcrash app-id --project-dir testbed/react-native` prints three ids: both Android apps from that one file, and the iOS app. Only the package name tells which Android app is this one.
- **fixcrash today** (`toCrashEvent` and `expectationOf` run on copies of the events)
  - Android native crash: the expectation is `com.facebook.react.common.JavascriptException` at `ExceptionsManagerModule.reportException`, a frame no Jest test has. The JS stack sits unparsed in the message.
  - Android non-fatal: `io.invertase.firebase.crashlytics.JavaScriptError` at `.?anon_0_`. No frame parses: the `address at …:1:<column>` location doesn't match the frame pattern.
  - iOS, both kinds: no expectation. `RCTFatalException` and `JavaScriptError` have no dot, so the exception header doesn't parse. The subtitle starts with no Mach exception, and the non-fatal's blame `file` is a folded YAML scalar that `parseFlatMap` reads as `>-`.

**2026-10-16: Symbolication and the failing Jest test (step 6.4)** (the testbed at `8ee5a3b`, exported with `git archive` to another path; npm 11, Node 24.21, metro-symbolicate 0.87, the RN 0.88 template's Jest 29; spike tests in the copy, not committed)

- **`node_modules` at another path:** `npm ci --offline` took 3 s and wrote 481 MB, all from npm's cache. npm 11 skipped the packages' install scripts (it asks for approval), and neither the tests nor the bundle needed them.
- **Rebuilding the shipped bundle**, with the commands the release builds run
  - Android: `node node_modules/react-native/cli.js bundle --platform android --dev false --reset-cache --entry-file index.js --bundle-output <out>/index.android.bundle --assets-dest <dir> --sourcemap-output <out>.packager.map --minify false` took 1.9 s. Then `node_modules/hermes-compiler/hermesc/osx-bin/hermesc -w -emit-binary -max-diagnostic-width=80 -out <out>.hbc <out> -O -output-source-map` took 1.0 s. Then `node node_modules/react-native/scripts/compose-source-maps.js <packager map> <hbc map> -o <map>` took 0.3 s.
  - iOS: the same with `--platform ios`, and `hermesc -emit-binary -max-diagnostic-width=80 -O -output-source-map`. The iOS build ran that `hermesc` too, from `node_modules`, not from the Pods.
  - **The bytecode matches.** Android's was byte-identical to the APK's `assets/index.android.bundle`. iOS's differed in 40 of 1,108,924 bytes from the app's `main.jsbundle`, probably the source file's path, which differed.
  - The composed maps matched the release builds' maps in `mappings`, `names`, `x_facebook_sources` and `x_hermes_function_offsets`. Only `sources` differed, in the absolute paths.
- **`metro-symbolicate <map>`** (from the app's `node_modules`), on the 6.3 events' frames, through the rebuilt maps:
  - `parseProfile@1:485277` → `src/profile.ts:15:parseProfile`.
  - `anonymous@1:708373` → `App.tsx:55:prepare`: the frame Hermes names `anonymous` is `prepare`, which the Hermes compiler inlined into the timer's closure.
  - `dayKey@1:485517` → `src/updates.ts:13:dayKey`, then `groupByDay` and `prepare`.
  - render: `anonymous@1:665004` → `src/TagList.tsx:19:Array.from$argument_1`, then `TagList@1:487346` → `src/TagList.tsx:17:TagList`, then React's `ReactFabric-prod.js`.
  - React Native Firebase's frames, `at .?anon_0_ (address at index.android.bundle:1:698961)` → `at .?anon_0_ (address at src/inbox.ts:14:loadHeadline)`. The async function's name comes back from Metro's function map.
  - The output has a line and the enclosing function's name, no column.
  - It fails on `(native):0:0` ("Line must be greater than or equal to 1, got 0"), and gives `null:null:null` for iOS's `main.jsbundle:1:484854:1`. Without the trailing `:1` it reads it.
  - iOS's offsets differ from Android's, and map to the same lines.
- **The failing tests** (`jest <path> --json --outputFile=<file>`)
  - Each failure is a string in `assertionResults[].failureMessages`: the error's `name: message`, then V8's stack, mapped through Babel's source maps. `failureDetails` is empty for a thrown error.
  - parser: `TypeError: Cannot read properties of undefined (reading 'url')`, `at url (<root>/src/profile.ts:15:62)`, then the test file.
  - async: `TypeError: … (reading 'title')`, `at title (<root>/src/inbox.ts:14:28)`, `at Generator.next (<anonymous>)`, `at asyncGeneratorStep (<root>/node_modules/@babel/runtime/helpers/asyncToGenerator.js:3:17)`. No test-file frame: the test awaited the rejection.
  - render (react-test-renderer in `act`): `TypeError: … (reading 'label')`, `at label (<root>/src/TagList.tsx:19:25)`, `at Array.from (<anonymous>)`, `at from (<root>/src/TagList.tsx:17:14)`, then react-test-renderer's development build.
  - The files and lines are the symbolicated event's. The names are not: Jest names a frame after the identifier at the mapped position (`url`, `title`, `label`, `from`), not its function.
  - engine: `dayKey('2026/10/16 10:00')` doesn't throw under Node. A test that swaps `Date` (`jest.spyOn(global, 'Date').mockImplementation(…)`) fails with `RangeError: Invalid time value` at `src/updates.ts:13:30`, Hermes's crash line.
  - Test names: `fullName` is the `describe` titles and the test's title joined with spaces (`TagList renders a page whose total counts tags it lacks`). The file is the result's `name`, an absolute path. A targeted run is `jest <file> -t '<anchored, escaped fullName>'`.
  - Time: four failing tests 1.8 s, the testbed's suite of 12 tests 1.9 s.

## 8. Risks

- **Testability of real apps.** Logic living in Activities, Fragments or ViewControllers can't be unit-tested without refactoring. Mitigation: an honest "can't reproduce" path, and measuring the reproducible share early.
- **Crashlytics MCP is Experimental.** Tools or fields may change. Mitigation: pin firebase-tools, and isolate MCP-shape assumptions in one place.
- **Version → commit** works only with a build stamp or tagged releases. AGP writes the commit only when the Gradle root is the git root (§7), which rules out most React Native apps and monorepos.
- **Build-tool friction.** Gradle and npm want the network, Xcode is slow, and machines differ (JDK, Android SDK, Xcode versions). Mitigation: let the user override the test command; use `--offline` after the cache is warm.
- **Overlap.** Google may extend its guide from a plan to a run. Acceptable: this is open source, not a business.

## 9. Open questions (answer in the spike)

1. ~~Does `buildStamp` carry the git commit on Android, from AGP VCS info in release builds?~~ Answered in §7 (spike). ~~Is there anything comparable on iOS?~~ No: iOS events have no build stamp (§7, step 5.3). ~~React Native?~~ No: the Android project isn't the git root, and iOS has none (§7, step 6.3).
2. Are 20 frames enough to reach app code in typical Kotlin stacks (coroutines, RxJava, Compose)? Do we need the full event? Partly answered in §7: `blameFrame` survives truncation; real-app stacks still unchecked.
3. What share of a real app's top crashes can a unit test reproduce? This is the number that decides whether the plugin is useful.
4. ~~How do Debug builds and emulators report to Crashlytics, and how fast? Do events need a release build with an uploaded mapping?~~ Answered in §7 (spike).
5. ~~Can `firebase-tools mcp` start with only Crashlytics tools? What does the plugin need for auth and app-id discovery?~~ Answered in §7 (spike) for Android; for iOS, `GOOGLE_APP_ID` in `GoogleService-Info.plist` (§7, step 5.3).
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
