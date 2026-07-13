# OPS.md — shipping, credentials, calling infra

## Ship to App Store Connect (one command)

```bash
npm run ship:ios         # eas build -p ios --local → eas submit (headless Transporter)
npm run ship:ios:full    # + firebase deploy --only functions,firestore:rules first
npm run build:ios:local  # .ipa only, no upload
```

`scripts/ship-ios.sh` archives every `.ipa` in `build-output/` (git-ignored), build
number auto-increments, `scripts/eas-local-preflight.sh` needs ~12GB free disk and
purges stale DerivedData. Builds land in TestFlight after Apple processes.

One-time credentials (already done; redo only if rotated):
- ASC API key stored on EAS: `eas credentials` → iOS → App Store Connect API Key.
- `eas.json` `submit.production.ios.ascAppId: "6760814898"` (required for
  `--non-interactive`).

## Client env (`.env`, loaded by app.config.ts — fails fast if missing)

`EXPO_PUBLIC_FIREBASE_*` (7 values), `EXPO_PUBLIC_GOOGLE_{WEB,ANDROID,IOS}_CLIENT_ID`,
`EXPO_PUBLIC_GOOGLE_MAPS_API_KEY`, `EXPO_PUBLIC_LIVEKIT_TOKEN_ENDPOINT`,
`EXPO_PUBLIC_OCR_PROXY_ENDPOINT`. Never put server secrets here.

## Server secrets (Firebase Functions Secret Manager)

```bash
cd functions
firebase functions:secrets:set LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET
firebase functions:secrets:set APNS_AUTH_KEY      # full .p8 contents
firebase functions:secrets:set APNS_KEY_ID        # 10 chars
firebase functions:secrets:set APNS_TEAM_ID       # YDF2TB9967
firebase functions:secrets:set APNS_BUNDLE_ID     # com.splitcircle.app
firebase functions:secrets:set APNS_USE_SANDBOX   # false for TestFlight/App Store
```

Deploy: `cd functions && npm run build && firebase deploy --only functions`.

## Calling architecture (summary)

- **Incoming (works on killed app):** caller writes `/calls/{callId}` in RTDB →
  `onCallCreated` sends APNs VoIP push (deterministic uuidv5 callUUID in payload) →
  AppDelegate PushKit handler → `RNCallKeep.reportNewIncomingCall` (system UI) →
  JS wakes → CallContext → accept → LiveKit room join.
- **Outgoing:** `useCallManager.startCall` → RTDB session + CallKit "calling…" +
  LiveKit token/join. Ringback via `services/ringback.ts` (`keepAudioSessionActive:
  true` — required, see CLAUDE.md gotchas).
- **Hygiene:** ring timeout 45s client-side, `reapStaleRingingCalls` every 2 min
  (90s stale), signaling deleted on hangup; call history is device-local.
- **Tokens:** VoIP token per device at `users/{uid}/notificationDevices/{deviceId}
  .voipPushToken` via `registerVoipPushToken`; rotation re-uploads automatically.
- Key files: `functions/src/voipPush.ts` (dual-env APNs fallback), `functions/src/
  index.ts` (onCallCreated, reportMissedCall), `functions/src/cleanup.ts` (reaper),
  `src/context/CallContext.tsx`, `src/services/nativeCallService.ts`,
  `ios/SplitCircle/AppDelegate.swift`.

### Debugging incoming-call failures

```bash
firebase functions:log --only onCallCreated   # expect: dispatch complete accepted=1
```
- `accepted=0` → receiver has no `voipPushToken` in Firestore.
- `failed=1` + `BadDeviceToken`/`BadEnvironmentKeyInToken` → flip `APNS_USE_SANDBOX`
  (dual-env fallback usually saves this); `MissingTopic` → bundle-id secret wrong;
  `Forbidden` → key revoked / wrong team. APNs voip topic is `<bundleId>.voip`.
- End-to-end test needs two PHYSICAL devices (sim can't receive VoIP push).

## Google OAuth (rotation / new environment)

Google Cloud project `splitcircle-c9e46` → APIs & Credentials → three client IDs:
Web (Expo redirect `https://auth.expo.io/@<user>/SplitCircle`), iOS + Android (both
`com.splitcircle.app`; Android needs debug-keystore SHA-1). Paste into `.env`, restart
Metro. Firebase Auth must have Google + Email/Password providers enabled. If a secret
ever lands in git history: revoke first, then `git filter-repo` before pushing.
