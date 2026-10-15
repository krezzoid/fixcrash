#!/usr/bin/env bash
# Triggers a seeded crash in the installed SwiftUI testbed app on the booted simulator,
# then relaunches the app: Crashlytics sends a crash report on the next launch.
# Usage: ./trigger-crash.sh render|async|action
set -euo pipefail

app=io.github.krezzoid.fixcrash.testbed.swiftui
scenario=${1:?usage: $0 render|async|action}
case $scenario in
  render) screen=tags ;;
  async) screen=inbox ;;
  action) screen=archive ;;
  *) echo "usage: $0 render|async|action" >&2; exit 2 ;;
esac

xcrun simctl list devices booted | grep -q Booted ||
  { echo "no booted simulator: xcrun simctl boot 'iPhone 17'" >&2; exit 1; }

pid=$(xcrun simctl launch --terminate-running-process booted "$app" -screen "$screen" | awk '{print $NF}')
if [[ $scenario == action ]]; then
  # simctl can't tap: the crash is in the Archive button's action.
  echo "Tap Archive in the simulator, with no draft selected." >&2
fi
# The app crashes on its own for render and async, after a tap for action.
for _ in $(seq 1 120); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done
xcrun simctl launch --terminate-running-process booted "$app" >/dev/null
# The relaunched app uploads the report a few seconds after it starts.
sleep 10
