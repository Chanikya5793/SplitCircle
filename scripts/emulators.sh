#!/usr/bin/env bash
# Runs the whole backend locally for on-device/simulator testing.
#
# Pairs with EXPO_PUBLIC_FIREBASE_EMULATOR_HOST (see src/firebase/firebaseConfig.ts):
#   npm run emulators                     # this terminal: backend
#   EXPO_PUBLIC_FIREBASE_EMULATOR_HOST=127.0.0.1 npx expo export:embed ...   # app
#
# Uses the `demo-manasplit` project id, which the emulators guarantee never
# reaches a real Google service. Data persists in .emulator-data/ between runs.
set -euo pipefail
cd "$(dirname "$0")/.."

for java_home in \
  /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
  /usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home; do
  if [[ -x "$java_home/bin/java" ]]; then
    export JAVA_HOME="$java_home"
    export PATH="$JAVA_HOME/bin:$PATH"
    break
  fi
done

# Callable functions read their secrets at invocation time. Placeholders keep
# the emulator from reaching for Secret Manager; features that genuinely need a
# provider (LiveKit calls, APNs, breach monitoring) fail closed locally.
if [[ ! -f functions/.secret.local ]]; then
  for name in APNS_AUTH_KEY APNS_BUNDLE_ID APNS_KEY_ID APNS_TEAM_ID APNS_USE_SANDBOX \
    FLARE_API_KEY GOOGLE_WEB_RISK_API_KEY HIBP_API_KEY LIVEKIT_API_KEY \
    LIVEKIT_API_SECRET LIVEKIT_URL SECURITY_BLIND_INDEX_KEY SECURITY_MONITORING_KMS_KEY; do
    echo "$name=emulator-placeholder"
  done > functions/.secret.local
fi

npm --prefix functions run build
import_args=()
[[ -f .emulator-data/firebase-export-metadata.json ]] && import_args=(--import .emulator-data)
exec npx firebase emulators:start \
  --only auth,firestore,database,functions,storage \
  --project demo-manasplit \
  ${import_args[@]+"${import_args[@]}"} --export-on-exit .emulator-data
