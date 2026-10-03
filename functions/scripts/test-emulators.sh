#!/usr/bin/env bash

set -euo pipefail

# Firestore Emulator requires Java 21. Prefer the stable Homebrew installation
# used by release machines while still respecting a valid explicit toolchain.
if [[ "$(uname -s)" == "Darwin" ]]; then
  for java_home in \
    /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
    /usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home; do
    if [[ -x "$java_home/bin/java" ]]; then
      export JAVA_HOME="$java_home"
      export PATH="$JAVA_HOME/bin:$PATH"
      break
    fi
  done
fi

if ! command -v java >/dev/null 2>&1; then
  echo "Java 21 is required for Firebase emulator tests." >&2
  exit 1
fi

java -version
npx firebase emulators:exec \
  --only firestore,database \
  --project manasplit-local-audit \
  "npx vitest run --maxWorkers=1"
