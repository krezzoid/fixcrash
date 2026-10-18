#!/usr/bin/env bash
# Copies testbed/react-native into a git repository of its own, for the eval (docs/EVAL.md):
# the agent works there and can't read the scenario descriptions: README.md and
# trigger-crash.sh stay behind, and the copy gets a plain README.
#
# The copy gets two commits on main:
#   1. "Initial version", tagged v<versionName>. JS events carry no commit, so the tag
#      is how fixcrash finds this one. The JS bundle built from it has the same
#      Hermes bytecode as the testbed's own release builds;
#   2. the next version's number, so the crashing commit is not the head of main.
# It installs node_modules with npm ci, from npm's cache when it can.
#
# Usage: testbed/copy-rn.sh <dest>   (a new directory outside this repository)
set -euo pipefail

dest=${1:?usage: $0 <dest>}
src=$(cd "$(dirname "$0")/react-native" && pwd -P)
repo=$(git -C "$src" rev-parse --show-toplevel)

[[ -e $dest ]] && { echo "$dest exists: pick a new directory" >&2; exit 1; }
parent=$(cd "$(dirname "$dest")" && pwd -P)
dest=$parent/$(basename "$dest")
[[ $dest/ == "$repo"/* ]] && { echo "$dest is inside $repo: the agent could read the scenarios" >&2; exit 1; }

mkdir "$dest"
git -C "$src" ls-files -z -- . ':!README.md' ':!trigger-crash.sh' |
  (cd "$src" && tar -c --null -T - -f -) | (cd "$dest" && tar -x -f -)
# Untracked config a native build needs, when the testbed has it; the copy's .gitignore covers it.
for f in android/app/google-services.json ios/GoogleService-Info.plist; do
  [[ -f $src/$f ]] && cp "$src/$f" "$dest/$f"
done

cat > "$dest/README.md" <<'EOF'
# fixcrash-testbed (React Native)

A small React Native app: a profile, tags, an inbox and updates. Data comes from canned responses in `src/backend.ts`.

## Test

```bash
npm ci
npm test
```

## Build

Android: put the app's Firebase config at `android/app/google-services.json`, then `(cd android && ./gradlew assembleRelease)`.
iOS: put it at `ios/GoogleService-Info.plist`, then `(cd ios && pod install)` and build `ios/TestbedRN.xcworkspace`.

The app runs on an emulator or a simulator only: it is never published.
EOF

cd "$dest"
git init -q -b main
git config user.name "$(git -C "$repo" config user.name)"
git config user.email "$(git -C "$repo" config user.email)"
git add -A
[[ -z $(git ls-files android/app/google-services.json ios/GoogleService-Info.plist) ]] || { echo "untracked config got staged" >&2; exit 1; }
git commit -q -m "Initial version"

gradle=android/app/build.gradle
pbxproj=ios/TestbedRN.xcodeproj/project.pbxproj
version=$(sed -n 's/^[[:space:]]*versionName "\(.*\)"$/\1/p' "$gradle")
code=$(sed -n 's/^[[:space:]]*versionCode \([0-9]*\)$/\1/p' "$gradle")
[[ -n $version && -n $code ]] || { echo "no versionName and versionCode in $gradle" >&2; exit 1; }
git tag -a "v$version" -m "Release $version"
release=$(git rev-parse HEAD)

npm ci --offline --no-audit --no-fund >/dev/null 2>&1 || npm ci --no-audit --no-fund >/dev/null

next_version=${version%.*}.$((${version##*.} + 1))
sed -i.bak -e "s/^\([[:space:]]*versionName \)\"$version\"$/\1\"$next_version\"/" \
  -e "s/^\([[:space:]]*versionCode \)$code$/\1$((code + 1))/" "$gradle"
sed -i.bak -e "s/^\([[:space:]]*MARKETING_VERSION = \)$version;$/\1$next_version;/" "$pbxproj"
rm "$gradle.bak" "$pbxproj.bak"
git commit -q -am "Start version $next_version"

cat <<EOF
$dest
  v$version  $release
  main  $(git rev-parse HEAD)  version $next_version
Crashes reported from the testbed's own release builds are this version's: same JS, same bundle.
EOF
