# iOS Native Customizations — prebuild / EAS migration map

> **This is a BARE workflow.** `ios/` is committed and hand-edited. **Do not run
> `expo prebuild`** — it regenerates `ios/` from `app.config.ts` and would silently
> destroy the native code listed below. Day-to-day integration of local Expo
> modules is **`npx pod-install ios` only** (autolinking handles the rest).
>
> This file is the inventory + plan for IF the project ever moves to a
> prebuild/EAS-managed flow. Each item below must be expressed as a config plugin
> (and verified on a real prebuild) *before* the first prebuild — otherwise it is
> lost. Nothing here changes the current build; it is documentation.

## Already prebuild-safe (no work needed)

| Item | Why it survives |
|---|---|
| `modules/splitcircle-ai` (AI helpers) | Local **Expo module** — autolinked from its `expo-module.config.json`. |
| `modules/my-module` (QuickLookPreview) | Same — autolinked. |
| Info.plist keys (`NSUserActivityTypes`, `UIBackgroundModes`, display name, …) | Declared in `app.config.ts` → `ios.infoPlist`; regenerated on prebuild. |
| `aps-environment` entitlement | Declared in `app.config.ts` → `ios.entitlements`. |
| LiveKit, location, audio/video, splash, etc. | Standard config plugins already in `app.config.ts` `plugins`. |

## ⚠️ NOT yet expressed as plugins — would be LOST by a prebuild

### 1. VisionKit receipt scanner (classic RN bridge module)
Files: `ios/SplitCircle/VisionKitReceiptScanner.swift` (~61 KB),
`VisionKitReceiptScannerBridge.m`, and entries in `SplitCircle-Bridging-Header.h`.
Consumed from JS via `NativeModules.VisionKitReceiptScanner`
(`src/services/visionKitService.ts`).

**Plan:** a `withDangerousMod` + `withXcodeProject` plugin that copies the three
files into the generated target and adds the `.swift`/`.m` to the build sources,
or (cleaner long-term) **port it to a local Expo module** like `splitcircle-ai`
so it autolinks. Sketch:

```js
// plugins/withVisionKitReceiptScanner.js  (UNVERIFIED — test on first prebuild)
const { withDangerousMod, withXcodeProject } = require('@expo/config-plugins');
const fs = require('fs'); const path = require('path');
// 1) withDangerousMod('ios'): copy VisionKitReceiptScanner.{swift,m} +
//    merge the bridging-header imports into the generated -Bridging-Header.h
// 2) withXcodeProject: addSourceFile(...) for the .swift and .m to the app target
```

### 2. AppDelegate native logic (CRITICAL — VoIP / CallKit / linking)
`ios/SplitCircle/AppDelegate.swift` (174 lines) adds, on top of the Expo
template: PushKit registration, `didReceiveIncomingPushWith` → CallKit
`reportNewIncomingCall` (synchronous, required for VoIP pushes),
`RNVoipPushNotificationManager`, `RNCallKeep`, and `RCTLinkingManager`
`open url` + `continue userActivity` (deep links + the donated Ask-AI activity).

**Plan:** an Expo **AppDelegate subscriber** (preferred — `ExpoModulesCore`
`ExpoAppDelegateSubscriber`, lives in a local module so it survives prebuild) or a
`withAppDelegate` mod that re-injects these blocks. This is the highest-risk item:
getting VoIP/CallKit wrong breaks incoming calls. **Must be verified on a device
with a real VoIP push before trusting a prebuild.** The bridging-header imports
(`RNCallKeep`, `RNVoipPushNotificationManager`) move with it.

### 3. Bridging header
`ios/SplitCircle/SplitCircle-Bridging-Header.h` (RCTBridgeModule/RCTEventEmitter +
the CallKit/VoIP imports) — regenerated empty by prebuild; its imports must be
re-added by the plugins in (1) and (2).

## Observations (not changed here)
- The local Android plugins `plugins/withAdiRegistration.js`, `withSplitApk.js`,
  `withStripForegroundService.js` are **not registered** in `app.config.ts`
  `plugins`. In a bare flow that's consistent (the committed `android/` already
  has the result), but they would need registering before an Android prebuild.

## Migration checklist (when/if moving to prebuild)
1. Write + register plugins for §1–§3; keep this list as the acceptance set.
2. `npx expo prebuild --clean` on a throwaway branch.
3. `git diff` the generated `ios/` against committed — confirm VisionKit files,
   AppDelegate VoIP/CallKit/linking, and bridging-header imports are all present.
4. Build + device-test: incoming VoIP call → CallKit UI; receipt scan; deep link
   + Ask-AI Siri activity.
5. Only then delete the committed native `ios/` and switch to generated.
