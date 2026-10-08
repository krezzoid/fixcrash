# Android testbed

A small Kotlin app with three seeded crashes. fixcrash is developed and evaluated against it.

| Scenario | In the app | Crash | Top app frame | Unit-reproducible |
|----------|------------|-------|---------------|-------------------|
| `parser` | Open profile | `NullPointerException`: the profile JSON has no `avatar`, Gson leaves the non-null Kotlin field `null` | `ProfileParser.parse` | yes, JVM test |
| `paging` | Load more, three times | `IndexOutOfBoundsException: toIndex = 30` on the last, partial page | `FeedPager.page` | yes, JVM test |
| `lifecycle` | Open details, then back within 1.5 s | `IllegalStateException: Fragment … not attached to a context` | `DetailsFragment.onDetailsLoaded` | no: expected outcome is a report, no PR |

The unit tests in `app/src/test` pass and miss all three bugs.

## Setup

1. A Firebase project with an Android app registered as `io.github.krezzoid.fixcrash.testbed`, and a Firebase CLI login.
2. Write the app config (git ignores it):

   ```bash
   npx -y firebase-tools@15.32.1 apps:sdkconfig ANDROID <firebase-app-id> -o app/google-services.json
   ```

3. Start an emulator, then build and install:

   ```bash
   ./gradlew :app:installDebug
   ```

## Trigger a crash

```bash
./trigger-crash.sh parser     # or paging, lifecycle
```

The script starts the scenario through adb, then relaunches the app and waits while Crashlytics sends the report. The issue shows up in Crashlytics 2 to 5 minutes later.

## Notes

- Release builds from this directory carry no git commit: AGP looks for `.git` in the Gradle root only (`docs/RESEARCH.md` §7).
- `../copy-android.sh <dest>` copies the app into a git repository of its own, for the eval: without this README and the trigger script, with a release APK that carries the commit tagged `v1.0`, and a later commit on `main`. Install that APK, then trigger the crashes from here.
- All values in the app are synthetic, including the Crashlytics user id `test-user-0001`.
