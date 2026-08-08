#!/bin/bash
# Runs automatically at the start of every `eas build --local` via the
# package.json "eas-build-pre-install" hook (no-ops on EAS's remote builders).
#
# Why: each local build copies the project to a fresh temp path, so Xcode
# derives a NEW multi-GB DerivedData folder per run and never cleans up —
# seven builds once accumulated 21GB and archives started dying with
# "No space left on device" mid-compile.

set -u

# Only meaningful on a Mac with a home-dir DerivedData (skip remote builders).
DERIVED="$HOME/Library/Developer/Xcode/DerivedData"
[ -d "$DERIVED" ] || exit 0

# 1. Purge previous per-run SplitCircle DerivedData (safe: fully rebuildable).
rm -rf "$DERIVED"/SplitCircle-* 2>/dev/null || true

# NOTE: do NOT touch eas-build-local-nodejs temp dirs here — this hook runs
# INSIDE the current build's temp workdir; deleting it kills the build.

# 2. Fail fast (with a readable reason) if the disk can't fit the selected
# build.  Android AAB builds do not need the 12GB reserve required by an iOS
# archive, so allow the smaller, still-safe Android reserve.
MIN_FREE_GB=12
if [ "${EAS_BUILD_PLATFORM:-}" = "android" ]; then
  MIN_FREE_GB=6
fi
FREE_GB=$(df -g / | awk 'NR==2 {print $4}')
if [ "${FREE_GB:-0}" -lt "$MIN_FREE_GB" ]; then
  echo "❌ eas-local-preflight: only ${FREE_GB}GB free — this build needs ~${MIN_FREE_GB}GB."
  echo "   Free up space (check ~/Library/Developer/Xcode/DerivedData and old build artifacts) and retry."
  exit 1
fi

echo "✓ eas-local-preflight: DerivedData purged, ${FREE_GB}GB free."
exit 0
