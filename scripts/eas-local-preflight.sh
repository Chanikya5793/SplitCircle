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

# 2. Purge stale eas-local temp workdirs from earlier runs.
find "${TMPDIR:-/tmp}/../" -maxdepth 2 -name "eas-build-local-nodejs" -exec rm -rf {} + 2>/dev/null || true

# 3. Fail fast (with a readable reason) if the disk can't fit an archive.
FREE_GB=$(df -g / | awk 'NR==2 {print $4}')
if [ "${FREE_GB:-0}" -lt 12 ]; then
  echo "❌ eas-local-preflight: only ${FREE_GB}GB free — an iOS archive needs ~12GB."
  echo "   Free up space (check ~/Library/Developer/Xcode/DerivedData and old .ipa files) and retry."
  exit 1
fi

echo "✓ eas-local-preflight: DerivedData purged, ${FREE_GB}GB free."
exit 0
