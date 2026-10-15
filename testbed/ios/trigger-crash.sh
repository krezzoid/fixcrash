#!/usr/bin/env bash
# Triggers a seeded crash in the installed testbed app on the booted simulator, then
# relaunches the app: Crashlytics sends a crash report on the next launch.
# Usage: ./trigger-crash.sh parser|paging|lifecycle
set -euo pipefail

app=io.github.krezzoid.fixcrash.testbed
scenario=${1:?usage: $0 parser|paging|lifecycle}

xcrun simctl list devices booted | grep -q Booted ||
  { echo "no booted simulator: xcrun simctl boot 'iPhone 17'" >&2; exit 1; }

xcrun simctl launch --terminate-running-process booted "$app" -scenario "$scenario" >/dev/null
sleep 3
if [[ $scenario == lifecycle ]]; then
  # Leave the app for another one. The sync's background task runs out of time,
  # about 30 s later, and its expiration handler crashes.
  xcrun simctl launch booted com.apple.Preferences >/dev/null
  sleep 45
fi
xcrun simctl launch --terminate-running-process booted "$app" >/dev/null
# The relaunched app uploads the report a few seconds after it starts.
sleep 10
