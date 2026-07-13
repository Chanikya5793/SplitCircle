# CLAUDE.md — agent entry point

SplitCircle: Splitwise + WhatsApp + FaceTime in one RN app. iOS-first (iOS 26 SDK,
tested on iOS 27). Expo SDK 55, RN 0.83, Hermes, New Architecture, TypeScript strict.
App Store name: **ManaSplit** (bundle `com.splitcircle.app`, ascAppId 6760814898).

Docs: [DESIGN.md](DESIGN.md) (binding UI rules) · [OPS.md](OPS.md) (ship/credentials/calls infra) · [README.md](README.md) (setup).

## Architecture DNA (do not break)

Local-first, WhatsApp-style. Three tiers:

| Tier | Tech | Holds | Lifetime |
|---|---|---|---|
| Transit | Firebase RTDB | message queue, call signaling (`/calls`, `/userActiveCalls`) | deleted after delivery/hangup |
| Local | AsyncStorage + files | messages, call history, media, wallpapers, split history | permanent on device |
| Persistent | Firestore | profiles, groups, chats metadata, expenses | permanent on server |

- Never store messages/calls in Firestore. Never let RTDB accumulate (reapers exist).
- Calls: RTDB signaling + LiveKit media + CallKit/PushKit native UI. CallKit UUIDs are
  deterministic uuidv5 (namespace `6f9b8e2a-1c3d-4b5e-8a7f-0d1e2c3b4a59`) — server and
  client must stay byte-identical.
- Keys/tokens: never in the repo. Client env via `.env` (`EXPO_PUBLIC_*`), server via
  `firebase functions:secrets:set`.

## Commands

```bash
npx tsc --noEmit                 # typecheck (4 pre-existing test-lib errors are known)
npm run ship:ios                 # build local .ipa + deliver to App Store Connect (headless)
npm run ship:ios:full            # + firebase deploy (functions, firestore rules) first
firebase deploy --only functions,firestore:rules
```

**JS-only change → verify on sim without a build** (native deps unchanged only):

```bash
APP=$(xcrun simctl get_app_container <booted-sim-udid> com.splitcircle.app app)
npx expo export:embed --entry-file index.ts --platform ios --dev false \
  --bundle-output "$APP/main.jsbundle" --assets-dest "$APP"
xcrun simctl terminate <udid> com.splitcircle.app && xcrun simctl launch <udid> com.splitcircle.app
```

Do NOT run local sim Release builds (`expo run:ios --configuration Release`) — banned,
they hog the Mac. Native changes → `npm run ship:ios` or eas build.

## Gotchas that have burned us

- **UIScene lifecycle is mandatory** (iOS 27 kills classic lifecycle, TN3187). Cold-start
  user activities arrive in `SceneDelegate` `connectionOptions.userActivities`, not
  `application(_:continue:)`. Keep the scene manifest through Expo upgrades.
- **patch-package**: patches/ must actually be applied — grep node_modules to verify
  after installs. Patches exist for callkeep, livekit-webrtc, bottom-tabs, expo-sqlite, RN.
- **expo-audio**: `pause()` deactivates the shared AVAudioSession unless the player was
  created with `keepAudioSessionActive: true` — this silently kills live call audio.
- **APNs env**: `BadEnvironmentKeyInToken`/`BadDeviceToken` = sandbox/production mismatch;
  voipPush.ts has dual-env fallback. VoIP pushes MUST call `reportNewIncomingCall`
  unconditionally or iOS revokes the privilege.
- **Hermes + optional native modules**: probe `requireOptionalNativeModule()` before
  `require()`ing a package whose native half may be missing — else SIGSEGV, not a catch.
- **iOS 26 native search tab**: `tabBarSystemItem: 'search'` — setting title/tabBarLabel
  on iOS demotes it to a regular tab.
- **Reanimated new-arch**: inserting a sibling ABOVE entering-animated ScrollView content
  doesn't shift that content (overlap) — mount late-loading rows outside the ScrollView.
  `flex: 1` inside height-constrained containers collapses to zero height.
- **react-native-svg** pinned 15.12.1 (chart-kit compat).

## Backlog ideas (user's own notes)

- Chat "stalk mode": pin-guarded incognito view — no read receipts, sending disabled.
