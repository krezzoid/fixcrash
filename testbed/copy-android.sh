#!/usr/bin/env bash
# Copies testbed/android into a git repository of its own, for the eval (docs/EVAL.md):
# - the agent works there and can't read the scenario descriptions: README.md and
#   trigger-crash.sh stay behind, and the copy gets a plain README;
# - the Gradle root is the git root, so AGP writes the commit into release builds.
#
# The copy gets two commits on main:
#   1. "Initial version", tagged v<versionName>, with a release APK built from it: install
#      it on an emulator and trigger the crashes, and their events carry this commit;
#   2. the next version's number, so the crashing commit is not the head of main.
#
# Usage: testbed/copy-android.sh <dest>   (a new directory outside this repository)
set -euo pipefail

src=$(cd "$(dirname "$0")/android" && pwd -P)
repo=$(git -C "$src" rev-parse --show-toplevel)
dest=${1:?usage: $0 <dest>}

[[ -e $dest ]] && { echo "$dest exists: pick a new directory" >&2; exit 1; }
parent=$(cd "$(dirname "$dest")" && pwd -P)
dest=$parent/$(basename "$dest")
[[ $dest/ == "$repo"/* ]] && { echo "$dest is inside $repo: the agent could read the scenarios" >&2; exit 1; }
[[ -f $src/app/google-services.json ]] || { echo "no $src/app/google-services.json: see testbed/android/README.md, Setup" >&2; exit 1; }

mkdir "$dest"
git -C "$src" ls-files -z -- . ':!README.md' ':!trigger-crash.sh' |
  (cd "$src" && tar -c --null -T - -f -) | (cd "$dest" && tar -x -f -)
# Untracked config the build needs; the copy's .gitignore covers both.
cp "$src/app/google-services.json" "$dest/app/"
[[ -f $src/local.properties ]] && cp "$src/local.properties" "$dest/"

cat > "$dest/README.md" <<'EOF'
# fixcrash-testbed

A small Kotlin Android app: a profile, a paged feed and a details screen. Data comes from canned responses in `FakeBackend`.

## Build

Put the app's Firebase config at `app/google-services.json` (git ignores it), then:

```bash
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest
```

Release builds are signed with the debug key: the app is never published.
EOF

cd "$dest"
git init -q -b main
git config user.name "$(git -C "$repo" config user.name)"
git config user.email "$(git -C "$repo" config user.email)"
git add -A
[[ -z $(git ls-files app/google-services.json local.properties) ]] || { echo "untracked config got staged" >&2; exit 1; }
git commit -q -m "Initial version"

gradle_file=app/build.gradle.kts
version=$(sed -n 's/^ *versionName = "\(.*\)"$/\1/p' "$gradle_file")
code=$(sed -n 's/^ *versionCode = \([0-9]*\)$/\1/p' "$gradle_file")
[[ -n $version && -n $code ]] || { echo "no versionName or versionCode in $gradle_file" >&2; exit 1; }
git tag -a "v$version" -m "Release $version"
release=$(git rev-parse HEAD)

# Gradle needs a JDK: on a Mac with only Android Studio, use its bundled one.
studio_jdk="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
if [[ -z ${JAVA_HOME:-} ]] && ! command -v java >/dev/null && [[ -d $studio_jdk ]]; then
  export JAVA_HOME=$studio_jdk
fi
./gradlew -q :app:assembleRelease
apk=$dest/app/build/outputs/apk/release/app-release.apk
unzip -p "$apk" META-INF/version-control-info.textproto | grep -q "revision: \"$release\"" ||
  { echo "the release APK doesn't carry commit $release" >&2; exit 1; }

next_version=${version%.*}.$((${version##*.} + 1))
sed -i.bak -e "s/^\( *versionCode = \)$code$/\1$((code + 1))/" \
  -e "s/^\( *versionName = \)\"$version\"$/\1\"$next_version\"/" "$gradle_file"
rm "$gradle_file.bak"
git commit -q -am "Start version $next_version"

cat <<EOF
$dest
  v$version  $release  release APK: ${apk#"$dest"/}
  main  $(git rev-parse HEAD)  version $next_version
Next, with an emulator running:
  adb install -r "$apk"
  $src/trigger-crash.sh parser    # then paging, lifecycle
EOF
