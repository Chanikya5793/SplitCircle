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

### iOS notification icon cache diagnosis

iOS notification banners use the app's compiled primary icon. The
`expo-notifications` `icon` setting and `assets/notification-icon.png` are Android
status-bar resources; changing them cannot fix an iOS banner icon. This app has no
notification content extension and its push payloads do not supply alternate
artwork.

When one phone appears to show an old icon:

1. Send a fresh notification. Existing rows in Notification Center can retain the
   artwork captured when they arrived.
2. Compare the installed build on every reachable phone:

   ```bash
   xcrun devicectl device info apps \
     --device <device-id> --bundle-id com.splitcircle.app --columns '*'
   ```

3. Inspect the exact shipped IPA rather than trusting source assets:

   ```bash
   tmp_dir=$(mktemp -d)
   unzip -q build-output/<build>.ipa -d "$tmp_dir"
   app_dir=$(find "$tmp_dir/Payload" -maxdepth 1 -name '*.app' -type d | head -1)
   plutil -p "$app_dir/Info.plist"
   ```

   Confirm `CFBundleDisplayName`, `CFBundleVersion`,
   `CFBundleIcons.CFBundlePrimaryIcon.CFBundleIconName`, and the compiled
   `*AppIcon60x60@2x.png`. Compiled iOS PNGs may use Apple's CgBI encoding; convert
   a copy with `sips -s format png` before visually inspecting it.
4. If the same build and fresh push render correctly on other phones, treat the
   outlier as an IconServices/device cache. Clear historical notifications and
   restart the phone before considering reinstall/offload. Do not change APNs,
   notification payloads, Expo tokens, or the bundle identifier for a one-device
   cache.
5. For an intentional icon migration, use a new primary asset-catalog identity
   (currently `ManaSplitAppIcon`, not the legacy `AppIcon`) and update
   `ASSETCATALOG_COMPILER_APPICON_NAME`, the generator, and validator together.
   Verify the identity before shipping:

   ```bash
   out=$(mktemp -d)
   xcrun actool ios/SplitCircle/Images.xcassets \
     --compile "$out" --platform iphoneos --minimum-deployment-target 17.0 \
     --target-device iphone --target-device ipad \
     --app-icon ManaSplitAppIcon \
     --output-partial-info-plist "$out/asset-info.plist"
   plutil -p "$out/asset-info.plist"
   ```

2026-07-30 finding: build `0.0.186` contained the correct Muggu icon and multiple
phones displayed it correctly; one phone alone retained the old notification icon.
That is device cache evidence, not a second notification asset path.

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
