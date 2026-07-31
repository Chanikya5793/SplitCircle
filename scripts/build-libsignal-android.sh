#!/usr/bin/env bash
#
# build-libsignal-android.sh — reproduce the Android libsignal artifacts and
# install them to the local Maven repo (ai_layer/docs/33 §3.1).
#
#   bash scripts/build-libsignal-android.sh            # build arm64 only (fast, dev)
#   bash scripts/build-libsignal-android.sh --all-abis # all four ABIs (release)
#   bash scripts/build-libsignal-android.sh --check     # verify install, build nothing
#
# WHY THIS EXISTS. iOS pins LibSignalClient 0.99.1 (built from signalapp's repo
# at tag v0.99.1). Maven Central's org.signal:libsignal-android stops at 0.86.5
# and no AAR ships in the GitHub release, so there is no way to get a matching
# Android build off the shelf. Running mixed versions was rejected on evidence:
# the API changed materially in between (SessionBuilder/SessionCipher each
# gained an address parameter, Curve was replaced by ECKeyPair), which is a
# poor bet for wire compatibility between two ends of a conversation.
#
# The artifacts are ~63MB and deliberately NOT committed. This script is the
# distribution mechanism: any machine with the prerequisites can reproduce them
# byte-for-byte from a pinned upstream tag.
set -euo pipefail

LIBSIGNAL_TAG="v0.99.1"
LIBSIGNAL_VERSION="0.99.1"
REQUIRED_NDK="28.0.13004108"
# Recorded from the 2026-07-31 --all-abis build. ADVISORY, not an integrity
# check — the real anchor is the pinned upstream tag above.
#
# Two reasons a mismatch is expected rather than alarming, learned by hitting
# both: an arm64-only build (no --all-abis) legitimately produces a different
# AAR, since the ABI set IS the content; and libsignal's build is not
# bit-reproducible, so even the pure-Java jar changed between two builds of the
# same tag. Treat a mismatch as "confirm you know why", never as "compromised".
EXPECTED_AAR_SHA="3f57f9430c982921988c7cb64ca98c3a0572b52b39a01100a522c0ccfa3f03e8"
EXPECTED_JAR_SHA="969e918d53a360f85432f53ba1da4adef21b45b6d5e40cc5022c858bb9ca5af2"

ARCHS="arm64"
CHECK_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --all-abis) ARCHS="arm64,arm,x86_64,x86" ;;
    --check)    CHECK_ONLY=true ;;
    -h|--help)  grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

M2="$HOME/.m2/repository/org/signal"
AAR_DEST="$M2/libsignal-android/$LIBSIGNAL_VERSION/libsignal-android-$LIBSIGNAL_VERSION.aar"
JAR_DEST="$M2/libsignal-client/$LIBSIGNAL_VERSION/libsignal-client-$LIBSIGNAL_VERSION.jar"

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

verify_install() {
  [[ -f "$AAR_DEST" && -f "$JAR_DEST" ]] || return 1
  local aar_sha jar_sha
  aar_sha=$(shasum -a 256 "$AAR_DEST" | awk '{print $1}')
  jar_sha=$(shasum -a 256 "$JAR_DEST" | awk '{print $1}')
  echo "  aar $aar_sha"
  echo "  jar $jar_sha"
  if [[ "$aar_sha" != "$EXPECTED_AAR_SHA" || "$jar_sha" != "$EXPECTED_JAR_SHA" ]]; then
    echo "  ⚠ differs from the recorded --all-abis build."
    echo "    Expected if you built without --all-abis (the ABI set is the content),"
    echo "    or simply because libsignal does not build bit-reproducibly."
  fi
  return 0
}

if [[ "$CHECK_ONLY" == true ]]; then
  step "Checking local Maven install"
  verify_install && { echo "  ✓ libsignal $LIBSIGNAL_VERSION present"; exit 0; }
  fail "libsignal $LIBSIGNAL_VERSION is NOT installed. Run: bash scripts/build-libsignal-android.sh"
fi

# ── Prerequisites ────────────────────────────────────────────────────────────
# Every one of these was a separate build failure the first time through, so
# they are checked up front with the actual remedy rather than discovered one
# 10-minute compile at a time.
step "Checking prerequisites"

command -v cargo >/dev/null 2>&1 || [[ -x "$HOME/.cargo/bin/cargo" ]] \
  || fail "Rust not found. Install: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"
export PATH="$HOME/.cargo/bin:$PATH"

ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}}"
[[ -d "$ANDROID_HOME" ]] || fail "Android SDK not found. Set ANDROID_HOME."
export ANDROID_HOME ANDROID_SDK_ROOT="$ANDROID_HOME"

NDK_DIR="$ANDROID_HOME/ndk/$REQUIRED_NDK"
[[ -d "$NDK_DIR" ]] \
  || fail "NDK $REQUIRED_NDK required (libsignal pins it; another version fails at configuration).
  Install: \$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager 'ndk;$REQUIRED_NDK'"
export ANDROID_NDK_HOME="$NDK_DIR"
NDKBIN="$NDK_DIR/toolchains/llvm/prebuilt/darwin-x86_64/bin"
[[ -d "$NDKBIN" ]] || NDKBIN=$(echo "$NDK_DIR"/toolchains/llvm/prebuilt/*/bin)

CMAKE_BIN=$(ls -d "$ANDROID_HOME"/cmake/*/bin 2>/dev/null | head -1)
[[ -n "$CMAKE_BIN" ]] \
  || fail "cmake not found in the SDK (BoringSSL needs it).
  Install: \$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager 'cmake;3.22.1'"

command -v protoc >/dev/null 2>&1 || [[ -x /opt/homebrew/bin/protoc ]] \
  || fail "protoc not found (Signal's post-quantum ratchet needs it). Install: brew install protobuf"
export PROTOC="${PROTOC:-$(command -v protoc || echo /opt/homebrew/bin/protoc)}"

# libsignal's Java half targets release 21; JDK 17 fails with
# "invalid source release: 21".
JDK21="${JAVA_HOME_21:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
[[ -d "$JDK21" ]] || JDK21=$(/usr/libexec/java_home -v 21 2>/dev/null || true)
[[ -n "$JDK21" && -d "$JDK21" ]] \
  || fail "JDK 21 required (libsignal's Java targets release 21). Install: brew install openjdk@21"
export JAVA_HOME="$JDK21"

export PATH="$JAVA_HOME/bin:$CMAKE_BIN:$NDKBIN:/opt/homebrew/bin:$PATH"

AVAIL_KB=$(df -k "$HOME" | awk 'NR==2 {print $4}')
(( AVAIL_KB > 15000000 )) || echo "  ⚠ under ~15GB free; this build has run the disk to 100% before"

echo "  rust    $(rustc --version 2>/dev/null || echo '?')"
echo "  ndk     $REQUIRED_NDK"
echo "  jdk     $($JAVA_HOME/bin/java -version 2>&1 | head -1)"
echo "  protoc  $($PROTOC --version 2>/dev/null || echo '?')"
echo "  archs   $ARCHS"

# ── Source ───────────────────────────────────────────────────────────────────
WORK="${LIBSIGNAL_WORKDIR:-${TMPDIR:-/tmp}/libsignal-build}"
step "Fetching libsignal $LIBSIGNAL_TAG"
if [[ -d "$WORK/.git" ]] && git -C "$WORK" describe --tags 2>/dev/null | grep -q "^$LIBSIGNAL_TAG$"; then
  echo "  reusing $WORK"
else
  rm -rf "$WORK"
  git clone --depth 1 --branch "$LIBSIGNAL_TAG" https://github.com/signalapp/libsignal.git "$WORK"
fi

# The repo pins a nightly in rust-toolchain; stable does NOT work.
TOOLCHAIN=$(tr -d '[:space:]' < "$WORK/rust-toolchain" 2>/dev/null || echo "")
if [[ -n "$TOOLCHAIN" ]]; then
  step "Ensuring pinned toolchain $TOOLCHAIN + Android targets"
  rustup toolchain install "$TOOLCHAIN" --profile minimal >/dev/null 2>&1 || true
  rustup target add --toolchain "$TOOLCHAIN" \
    aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android >/dev/null 2>&1 || true
fi

# ── Build ────────────────────────────────────────────────────────────────────
# NOTE the arch naming: build_jni.sh wants its own names (arm64), and gradle
# prefixes them with 'android-'. Passing the Android ABI name (arm64-v8a)
# yields 'android-arm64-v8a', which the script rejects.
step "Building (Rust cross-compile; ~10 min for one ABI)"
cd "$WORK/java"
# build_jni.sh exports CC_* and linkers but NOT a C++ compiler, which boring-sys
# needs. The cc crate prefers the dashed target-triple form.
env "CXX_aarch64-linux-android=$NDKBIN/aarch64-linux-android23-clang++" \
    "CC_aarch64-linux-android=$NDKBIN/aarch64-linux-android23-clang" \
    ./gradlew :android:assembleRelease -PandroidArchs="$ARCHS" --no-daemon

AAR_SRC="$WORK/java/android/build/outputs/aar/libsignal-android-release.aar"
JAR_SRC=$(ls "$WORK/java/client/build/libs/libsignal-client-$LIBSIGNAL_VERSION.jar" 2>/dev/null | head -1)
[[ -f "$AAR_SRC" ]] || fail "AAR not produced at $AAR_SRC"
[[ -n "$JAR_SRC" && -f "$JAR_SRC" ]] || fail "libsignal-client jar not produced — the Java API lives there, the AAR alone is not enough"

# ── Install to ~/.m2 ─────────────────────────────────────────────────────────
# NOT files('libs/*.aar'): AGP rejects a direct local .aar dependency inside a
# library module (every Expo module is one) because the produced AAR would
# silently omit those classes.
step "Installing to local Maven repo"
mkdir -p "$(dirname "$AAR_DEST")" "$(dirname "$JAR_DEST")"
cp "$AAR_SRC" "$AAR_DEST"
cp "$JAR_SRC" "$JAR_DEST"

cat > "${JAR_DEST%.jar}.pom" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.signal</groupId>
  <artifactId>libsignal-client</artifactId>
  <version>$LIBSIGNAL_VERSION</version>
  <packaging>jar</packaging>
</project>
EOF

cat > "${AAR_DEST%.aar}.pom" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.signal</groupId>
  <artifactId>libsignal-android</artifactId>
  <version>$LIBSIGNAL_VERSION</version>
  <packaging>aar</packaging>
  <dependencies>
    <dependency>
      <groupId>org.signal</groupId>
      <artifactId>libsignal-client</artifactId>
      <version>$LIBSIGNAL_VERSION</version>
      <scope>compile</scope>
    </dependency>
  </dependencies>
</project>
EOF

step "Verifying"
verify_install
printf '\n\033[1;32m✓ libsignal %s installed. Android builds can now resolve org.signal:libsignal-android:%s\033[0m\n' \
  "$LIBSIGNAL_VERSION" "$LIBSIGNAL_VERSION"
echo "  Free the ~6GB build cache when done:  rm -rf $WORK/target"
