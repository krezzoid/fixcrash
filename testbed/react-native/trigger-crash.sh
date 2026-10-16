#!/usr/bin/env bash
# Triggers a seeded crash in the installed testbed app, on a running Android emulator
# or on the booted iOS simulator, then relaunches the app: Crashlytics sends the
# report on the next launch.
#
# The app opens the screen it is launched with: a link, testbedrn://<screen>, on
# Android, and a launch argument, -screen <screen>, on iOS (simctl openurl waits for
# a tap on a confirmation).
#
# Usage: ./trigger-crash.sh android|ios parser|render|async|engine
set -euo pipefail

app=io.github.krezzoid.fixcrash.testbed.rn
usage="usage: $0 android|ios parser|render|async|engine"
platform=${1:?$usage}
scenario=${2:?$usage}
case $scenario in
  parser) screen=profile ;;
  render) screen=tags ;;
  async) screen=inbox ;;
  engine) screen=updates ;;
  *) echo "$usage" >&2; exit 2 ;;
esac

case $platform in
  android)
    adb shell am start -S -W -a android.intent.action.VIEW -d "testbedrn://$screen" "$app" >/dev/null
    sleep 3
    adb shell am start -S -W -n "$app/.MainActivity" >/dev/null ;;
  ios)
    xcrun simctl list devices booted | grep -q Booted ||
      { echo "no booted simulator: xcrun simctl boot 'iPhone 17'" >&2; exit 1; }
    xcrun simctl launch --terminate-running-process booted "$app" -screen "$screen" >/dev/null
    sleep 3
    xcrun simctl launch --terminate-running-process booted "$app" >/dev/null ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
# The relaunched app uploads the report a few seconds after it starts. async records
# a non-fatal and doesn't crash: the relaunch ends that run and sends it too.
sleep 10
