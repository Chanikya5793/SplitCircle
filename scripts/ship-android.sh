#!/usr/bin/env bash
#
# ship-android.sh — build the Android app locally, and only submit when told to.
#
#   bash scripts/ship-android.sh                 # build a release APK (default)
#   bash scripts/ship-android.sh --aab           # build an app bundle (Play format)
#   bash scripts/ship-android.sh --install       # build APK + install to the connected device
#   bash scripts/ship-android.sh --submit        # build AAB + submit to Play (internal track)
#   bash scripts/ship-android.sh --abi x86_64    # pick which per-ABI APK to report/install
#
# APKs are split per ABI (android/app/build.gradle), because libsignal's native
# library is ~8MB per architecture and a universal APK wastes ~24MB on every
# install. All four are built; --abi selects which one is reported and
# installed, defaulting to arm64-v8a — every modern phone, the Pixel included.
#
# WHY SUBMIT IS OPT-IN. Android is NOT feature-complete (ai_layer/docs/33):
# nearby mesh is iOS-only, and cross-platform interop is unproven. Shipping it
# to real users is a product decision, so the default here builds and stops.
# eas.json's Play track is `internal`, not `production`, for the same reason —
# a submit that reached everyone by default is a foot-gun, not a convenience.
set -euo pipefail

FORMAT="apk"
DO_INSTALL=false
DO_SUBMIT=false
ABI="arm64-v8a"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --aab)     FORMAT="aab"; shift ;;
    --install) DO_INSTALL=true; shift ;;
    --submit)  FORMAT="aab"; DO_SUBMIT=true; shift ;;
    --abi)     ABI="${2:?--abi needs a value, e.g. arm64-v8a}"; shift 2 ;;
    -h|--help) grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

step "Checking prerequisites"
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}}"
[[ -d "$ANDROID_HOME" ]] || fail "Android SDK not found. Set ANDROID_HOME."
export ANDROID_SDK_ROOT="$ANDROID_HOME"

# Gradle needs an SDK path and android/local.properties is gitignored, so a
# fresh clone has none. Write it rather than failing with Gradle's opaque
# "SDK location not found".
if [[ ! -f android/local.properties ]]; then
  echo "sdk.dir=$ANDROID_HOME" > android/local.properties
  echo "  wrote android/local.properties"
fi

# The crypto module needs libsignal 0.99.1 in ~/.m2 (doc 33 §3.1). Check it
# here so the failure names the remedy instead of surfacing 500 lines deep.
bash scripts/build-libsignal-android.sh --check >/dev/null 2>&1 \
  || fail "libsignal 0.99.1 missing. Run: bash scripts/build-libsignal-android.sh"
echo "  libsignal 0.99.1 present"

step "Building ${FORMAT}"
cd android
if [[ "$FORMAT" == "aab" ]]; then
  ./gradlew bundleRelease
  ARTIFACT="$ROOT/android/app/build/outputs/bundle/release/app-release.aab"
else
  ./gradlew assembleRelease
  # Per-ABI APKs (android/app/build.gradle `splits.abi`), so there is no single
  # app-release.apk any more. Default to the ABI every modern phone runs —
  # including the Pixel this is usually installed on — and let --abi override.
  ARTIFACT="$ROOT/android/app/build/outputs/apk/release/app-${ABI}-release.apk"
fi
cd "$ROOT"
if [[ ! -f "$ARTIFACT" ]]; then
  echo "  built APKs:"
  ls -1 "$ROOT/android/app/build/outputs/apk/release/"*.apk 2>/dev/null | sed 's/^/    /'
  fail "Build reported success but $ARTIFACT is missing"
fi
echo "  $ARTIFACT ($(du -h "$ARTIFACT" | awk '{print $1}'))"
if [[ "$FORMAT" == "apk" ]]; then
  echo "  other ABIs built alongside it:"
  ls -1 "$ROOT/android/app/build/outputs/apk/release/"*.apk \
    | grep -v "app-${ABI}-release.apk" | sed 's/^/    /' || true
fi

if [[ "$DO_INSTALL" == true ]]; then
  step "Installing to the connected device"
  ADB="$ANDROID_HOME/platform-tools/adb"
  "$ADB" install -r "$ARTIFACT"
fi

if [[ "$DO_SUBMIT" == true ]]; then
  step "Submitting to Play (internal track)"
  # NOTE: the release build is signed with the DEBUG keystore (Expo's local
  # default, see android/app/build.gradle). Play requires a real upload key,
  # so a submit needs signing credentials configured first — EAS-managed or a
  # keystore of your own. This will fail loudly rather than upload something
  # unsigned-for-Play.
  npx eas submit -p android --profile production --path "$ARTIFACT"
fi

printf '\n\033[1;32m✓ Done — %s\033[0m\n' "$ARTIFACT"
[[ "$DO_SUBMIT" == false ]] && echo "  (not submitted; pass --submit to upload to the internal track)"
