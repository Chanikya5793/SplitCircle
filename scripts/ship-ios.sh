#!/usr/bin/env bash
#
# ship-ios.sh — one command to build AND deliver SplitCircle to App Store Connect,
# replacing the manual "eas build … then drag the .ipa into Transporter" dance.
#
#   bash scripts/ship-ios.sh            # build (local) + submit to App Store Connect
#   bash scripts/ship-ios.sh --full     # ALSO deploy Firebase functions + Firestore rules first
#   bash scripts/ship-ios.sh --profile preview   # use a different eas.json build/submit profile
#   bash scripts/ship-ios.sh --build-only        # build the .ipa but don't submit
#
# One-time setup (see OPS.md): store an App Store Connect API key on EAS with
#   `eas credentials` → iOS → App Store Connect API Key, or run `eas submit -p ios`
# once interactively. After that this script is fully non-interactive.

set -euo pipefail

PROFILE="production"
DEPLOY_BACKEND=false
SUBMIT=true
FIREBASE_PROJECT="splitcircle-c9e46"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --full)       DEPLOY_BACKEND=true; shift ;;
    --build-only) SUBMIT=false; shift ;;
    --profile)    PROFILE="$2"; shift 2 ;;
    -h|--help)    grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$ROOT/build-output"
IPA="$OUT_DIR/SplitCircle-$PROFILE-$STAMP.ipa"
mkdir -p "$OUT_DIR"

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }

# 0. Optional backend deploy — functions + Firestore rules.
if [[ "$DEPLOY_BACKEND" == true ]]; then
  step "Deploying Firebase functions + Firestore rules ($FIREBASE_PROJECT)…"
  ( cd "$ROOT/functions" && npm run build )
  firebase deploy --only functions,firestore:rules --project "$FIREBASE_PROJECT" --non-interactive --force
fi

# 0b. Preflight (doc 25 Q1): the vitest suites are a HARD gate — a red suite
#     never ships. On-device AI evals live on the phone (Settings → On-Device
#     AI → AI evals), unreadable from here: prompt when interactive, warn when
#     headless. SKIP_AI_EVAL_CHECK=1 skips the prompt only, never the tests.
step "Preflight: unit + services test suites…"
npm run test:unit
npm run test:services
if [[ "${SKIP_AI_EVAL_CHECK:-}" != "1" ]]; then
  if [[ -t 0 ]]; then
    printf '\033[1;33m▶ On-device AI evals passed on the iPhone? (Settings → On-Device AI → AI evals) [y/N] \033[0m'
    read -r EVAL_OK
    if [[ "$EVAL_OK" != "y" && "$EVAL_OK" != "Y" ]]; then
      echo "Aborting — run the on-device evals first (or SKIP_AI_EVAL_CHECK=1)." >&2
      exit 1
    fi
  else
    printf '\033[1;33m▶ Reminder: run the on-device AI evals (Settings → On-Device AI → AI evals) before releasing this build.\033[0m\n'
  fi
fi

# 1. Local iOS build → a saved, timestamped .ipa artifact.
step "Building iOS locally (profile: $PROFILE)…"
eas build --platform ios --local --profile "$PROFILE" --non-interactive --output "$IPA"
echo "   built: $IPA"

# 2. Deliver to App Store Connect (the Transporter step, headless).
if [[ "$SUBMIT" == true ]]; then
  step "Submitting to App Store Connect…"
  eas submit --platform ios --path "$IPA" --profile "$PROFILE" --non-interactive
  printf '\n\033[1;32m✅ Shipped — %s delivered to App Store Connect. It will appear in TestFlight after Apple finishes processing.\033[0m\n' "$(basename "$IPA")"
else
  printf '\n\033[1;32m✅ Built (no submit): %s\033[0m\n' "$IPA"
fi
