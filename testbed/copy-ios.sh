#!/usr/bin/env bash
# Copies testbed/ios or testbed/swiftui into a git repository of its own, for the eval (docs/EVAL.md):
# the agent works there and can't read the scenario descriptions: README.md and
# trigger-crash.sh stay behind, and the copy gets a plain README.
#
# The copy gets two commits on main:
#   1. "Initial version", tagged v<MARKETING_VERSION>, with a Release build made from it
#      (its dSYM goes to Crashlytics): install it on a simulator and trigger the crashes.
#      iOS events carry no commit, so the tag is how fixcrash finds this one;
#   2. the next version's number, so the crashing commit is not the head of main.
#
# Usage: testbed/copy-ios.sh [ios|swiftui] <dest>   (a new directory outside this repository; ios by default)
set -euo pipefail

usage="usage: $0 [ios|swiftui] <dest>"
testbed=ios
[[ $# -eq 2 ]] && { testbed=$1; shift; }
dest=${1:?$usage}
case $testbed in
  ios)
    app=Testbed
    about='A small Swift (UIKit) app: a profile, a paged feed and a drafts sync.'
    triggers='parser    # then paging, lifecycle' ;;
  swiftui)
    app=TestbedSwiftUI
    about='A small SwiftUI app: tags, an inbox and drafts to archive.'
    triggers='render    # then async, action' ;;
  *) echo "$usage" >&2; exit 2 ;;
esac

src=$(cd "$(dirname "$0")/$testbed" && pwd -P)
repo=$(git -C "$src" rev-parse --show-toplevel)

[[ -e $dest ]] && { echo "$dest exists: pick a new directory" >&2; exit 1; }
parent=$(cd "$(dirname "$dest")" && pwd -P)
dest=$parent/$(basename "$dest")
[[ $dest/ == "$repo"/* ]] && { echo "$dest is inside $repo: the agent could read the scenarios" >&2; exit 1; }
[[ -f $src/$app/GoogleService-Info.plist ]] || { echo "no $src/$app/GoogleService-Info.plist: see testbed/$testbed/README.md, Setup" >&2; exit 1; }

mkdir "$dest"
git -C "$src" ls-files -z -- . ':!README.md' ':!trigger-crash.sh' |
  (cd "$src" && tar -c --null -T - -f -) | (cd "$dest" && tar -x -f -)
# Untracked config the build needs; the copy's .gitignore covers it.
cp "$src/$app/GoogleService-Info.plist" "$dest/$app/"

cat > "$dest/README.md" <<EOF
# fixcrash-testbed

$about Data comes from canned responses in \`FakeBackend\`.

## Build

Put the app's Firebase config at \`$app/GoogleService-Info.plist\` (git ignores it), then:

\`\`\`bash
xcodebuild -project $app.xcodeproj -scheme $app -destination 'platform=iOS Simulator,name=iPhone 17' build
xcodebuild -project $app.xcodeproj -scheme $app -destination 'platform=iOS Simulator,name=iPhone 17' test
\`\`\`

The app runs on the simulator only: it is never published.
EOF

cd "$dest"
git init -q -b main
git config user.name "$(git -C "$repo" config user.name)"
git config user.email "$(git -C "$repo" config user.email)"
git add -A
[[ -z $(git ls-files "$app/GoogleService-Info.plist") ]] || { echo "untracked config got staged" >&2; exit 1; }
git commit -q -m "Initial version"

pbxproj=$app.xcodeproj/project.pbxproj
version=$(sed -n 's/^[[:space:]]*MARKETING_VERSION = \(.*\);$/\1/p' "$pbxproj" | sort -u)
build=$(sed -n 's/^[[:space:]]*CURRENT_PROJECT_VERSION = \(.*\);$/\1/p' "$pbxproj" | sort -u)
[[ -n $version && -n $build && $version != *$'\n'* && $build != *$'\n'* ]] ||
  { echo "no single MARKETING_VERSION and CURRENT_PROJECT_VERSION in $pbxproj" >&2; exit 1; }
git tag -a "v$version" -m "Release $version"
release=$(git rev-parse HEAD)

xcodebuild -quiet -project "$app.xcodeproj" -scheme "$app" -configuration Release \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build build
bundle=$dest/build/Build/Products/Release-iphonesimulator/$app.app

next_version=${version%.*}.$((${version##*.} + 1))
sed -i.bak -e "s/^\([[:space:]]*CURRENT_PROJECT_VERSION = \)$build;$/\1$((build + 1));/" \
  -e "s/^\([[:space:]]*MARKETING_VERSION = \)$version;$/\1$next_version;/" "$pbxproj"
rm "$pbxproj.bak"
git commit -q -am "Start version $next_version"

cat <<EOF
$dest
  v$version  $release  Release build: ${bundle#"$dest"/}
  main  $(git rev-parse HEAD)  version $next_version
Next, with a simulator booted:
  xcrun simctl install booted "$bundle"
  $src/trigger-crash.sh $triggers
EOF
