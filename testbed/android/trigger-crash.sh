#!/usr/bin/env bash
# Triggers a seeded crash in the installed testbed app on a running emulator, then
# relaunches the app: Crashlytics sends a crash report on the next launch.
# Usage: ./trigger-crash.sh parser|paging|lifecycle
set -euo pipefail

app=io.github.krezzoid.fixcrash.testbed
scenario=${1:?usage: $0 parser|paging|lifecycle}

adb shell am start -S -W -n "$app/.MainActivity" --es scenario "$scenario" >/dev/null
sleep 3
adb shell am start -S -W -n "$app/.MainActivity" >/dev/null
# The relaunched app uploads the report a few seconds after it starts. Stopping it
# sooner, as the next run's am start -S does, can lose the report.
sleep 10
