# Calling — Production Setup & Walkthrough

Layers 1–4 are landed. Build, deploy, test.

## What you have to do, in order

Each step has its own short section below.

1. **ROTATE THE LEAKED .p8 KEY** (you pasted it in chat)
2. Install JS deps in app and functions
3. Get Apple Team ID and (rotated) APNs key id from developer.apple.com
4. Set Firebase Functions secrets (your terminal does this — no UI)
5. Deploy Firebase Functions
6. Local EAS iOS build prereqs check
7. Run a local EAS build OR `npm run ios`
8. End-to-end test with two devices

---

## 1. Rotate the leaked APNs key

You pasted `AuthKey_8W5W5HXH7D.p8` contents in chat. Treat it as compromised.

1. <https://developer.apple.com/account/resources/authkeys/list>
2. Find key `8W5W5HXH7D` → click → **Revoke**.
3. Click `+` → name `ManaSplit APNs Key` → check **Apple Push Notifications service (APNs)** → Continue → Register.
4. Download the new `.p8` (you only get one shot at this).
5. Note the new **Key ID** (10 chars, e.g. `ABCD1234EF`).
6. Note your **Team ID** — top-right corner of developer.apple.com (10 chars).

The new .p8 file lives only on your disk — don't paste it anywhere; we'll feed it to Firebase via `firebase functions:secrets:set` from the terminal so it never enters the repo.

## 2. Install deps

```bash
# in repo root
npm install
cd ios && pod install && cd ..

# in functions/
cd functions
npm install
cd ..
```

## 3. Set Firebase Functions secrets

This is what makes the `voip` push code actually able to send pushes. Each command prompts you and reads from stdin — values never hit your shell history.

```bash
cd functions

# Paste the FULL .p8 contents (including the BEGIN/END lines) when prompted:
firebase functions:secrets:set APNS_AUTH_KEY

# Key ID from the .p8 you just generated (10 chars, no spaces):
firebase functions:secrets:set APNS_KEY_ID

# Apple Team ID from developer.apple.com:
firebase functions:secrets:set APNS_TEAM_ID

# Bundle ID — just paste: com.splitcircle.app
firebase functions:secrets:set APNS_BUNDLE_ID

# Sandbox flag — type "false" for production builds (TestFlight + App Store).
# Type "true" when running a Debug/dev build straight from Xcode.
# You can flip this anytime with the same command.
firebase functions:secrets:set APNS_USE_SANDBOX
```

To verify they're set:

```bash
firebase functions:secrets:access APNS_KEY_ID
```

## 4. Deploy Functions

```bash
cd functions
npm run build      # tsc — fails fast if your changes break the build
firebase deploy --only functions
```

You should see `registerVoipPushToken` and `onCallCreated` in the deploy summary. The first deploy after adding a new function is slow (~5 min); subsequent deploys are fast.

## 5. Local EAS iOS build prereqs

You said you want to build locally instead of using EAS cloud builders. Requirements:

- macOS with Xcode 15+ installed and `xcode-select --install`
- A bundle ID matching your provisioning profile (`com.splitcircle.app` is what's in `app.config.ts`)
- A logged-in EAS account: `npx eas-cli login`
- Provisioning profile that includes the new background modes (`voip`)

The `voip` background mode I added today changes the entitlements bundle that the provisioning profile needs to permit. EAS will regenerate the profile on the first build that needs it, IF you let it manage credentials. To check / regenerate:

```bash
npx eas-cli credentials
# select iOS → production → push notifications: Yes
# select iOS → production → provisioning profile → regenerate
```

## 6. Build & install

```bash
# Local production build (signs with EAS-managed credentials, builds in your Xcode):
npx eas-cli build --platform ios --profile production --local

# OR quicker dev iteration straight to a connected device:
npm run ios
```

`npm run ios` is faster while iterating; `eas build --local` produces a signed `.ipa` you can install on TestFlight.

## 7. End-to-end test

You need **two iOS devices** signed into two different accounts in your app. (Simulator can't receive VoIP push.)

**Pre-test sanity:**

1. On both devices, open the app, sign in. Background it.
2. From either device, in Xcode console (or `npx react-native log-ios`), confirm you see a log line like:
   ```
   [voipPushService] (no exact match — but you should NOT see "react-native-voip-push-notification not installed yet")
   ```
3. In Firestore (Firebase Console → Firestore → `users/<uid>/notificationDevices/<deviceId>`), each device's doc should now have a `voipPushToken` field.

**The actual test:**

1. From device A, place a call to device B (audio call first, video next).
2. On device B — even if the screen is locked or the app is killed — the **system CallKit ringing UI** should appear within ~2 seconds. Caller name and call type should be correct.
3. Tap **Accept** on the lock screen. The app launches, joins the LiveKit room, audio routes through the earpiece (or Bluetooth if connected).
4. Hang up from either side. Both devices return to idle, call appears in call history.
5. Repeat with **video call**. Both video tracks should appear within 2 seconds of connecting (the new `LocalTrackPublisher` enforces this).

**If the ringing UI does NOT appear:**

- Check the Functions log: `firebase functions:log --only onCallCreated`. You should see `voipPush: dispatch complete accepted=1 failed=0`.
  - `accepted=0`: token isn't reaching Firestore. Check `notificationDevices/<deviceId>.voipPushToken` exists for the receiver.
  - `failed=1`: APNs rejected. The log includes the reason — common ones: `BadDeviceToken` (sandbox vs prod mismatch — flip `APNS_USE_SANDBOX`), `MissingTopic` (bundle ID secret wrong), `Forbidden` (key revoked or wrong Team ID).
- Check the device console (Settings → Privacy & Security → Analytics → Analytics Data). Look for `pushd` errors.

**If video doesn't show:**

- Confirm camera + mic permissions are granted in iOS Settings → ManaSplit.
- Check the JS console for `LocalTrackPublisher: setCameraEnabled failed` — that's the smoking gun.

---

## What's wired (architecture summary)

**Receiver path (incoming call, even on killed app):**

```
Initiator's call → /calls/{callId} write → onCallCreated trigger
                                            ↓
                                  sendCallVoipPush (APNs)
                                            ↓
            Receiver iOS → AppDelegate.pushRegistry:didReceiveIncomingPush
                                            ↓
                  RNCallKeep.reportNewIncomingCall (system ringing UI)
                                            ↓
              JS bundle wakes → voipPushService bridges payload to JS
                                            ↓
            CallContext sets `incomingCall` from payload (callId, chatId, ...)
                                            ↓
                  User taps Accept → CallKit answerCall event
                                            ↓
            CallContext.acceptIncomingCall → useCallManager.joinExistingCall
                                            ↓
                              LiveKit room joins, video/audio publishes
```

**Initiator path:**

```
useCallManager.startCall → createCallSession (writes /calls/{callId})
                          → nativeCallService.startOutgoingCall (CallKit "calling…")
                          → LiveKitService.getToken → LiveKit room joins
```

**VoIP token registration (per device, on every sign-in):**

```
voipPushService receives PKPushRegistry token from native
       ↓
voipPushRegistration calls registerVoipPushToken(deviceId, token, bundleId)
       ↓
Cloud function writes users/{uid}/notificationDevices/{deviceId}.voipPushToken
```

## Files you might touch later

- `src/services/voipPushService.ts` — JS-side native bridge (token + push events)
- `src/services/voipPushRegistration.ts` — backend registration on sign-in
- `src/context/CallContext.tsx` — owns ringing state, both RTDB and VoIP paths
- `functions/src/voipPush.ts` — APNs sender + token upsert
- `ios/SplitCircle/AppDelegate.swift` — PushKit ↔ CallKit bridge

## Operational notes

- VoIP pushes that don't promptly call `reportNewIncomingCall` cause iOS to revoke VoIP push privilege for the app. The `AppDelegate` handler reports unconditionally, so as long as you don't add code that bypasses it, you're safe.
- APNs `voip` topic is `<bundleId>.voip` — don't change that.
- The Expo push that already fires on `onCallCreated` is preserved as a fallback for Android and for iOS devices that haven't registered a VoIP token yet.
- Token rotation: iOS may issue a new VoIP token at any time. `voipPushService.onToken` re-fires; the registration helper re-uploads.
