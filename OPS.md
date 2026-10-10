# OPS.md — shipping, credentials, calling infra

## Ship to App Store Connect (one command)

```bash
npm run ship:ios         # eas build -p ios --local → eas submit (headless Transporter)
npm run ship:ios:full    # + Firebase Auth, functions, Firestore rules/indexes,
                         #   RTDB and Storage rules after the IPA builds
npm run build:ios:local  # .ipa only, no upload
```

`scripts/ship-ios.sh` archives every `.ipa` in `build-output/` (git-ignored), build
number auto-increments, `scripts/eas-local-preflight.sh` needs ~12GB free disk and
purges stale DerivedData. Builds land in TestFlight after Apple processes.

### 2026-10-10 TestFlight build: 1.0.3 (0.0.256)

On October 10, iOS `1.0.3 (0.0.256)` was built locally with `npm run ship:ios`
from `ui-revamp` (`380de13`) and accepted by App Store Connect through EAS
Submit (submission `ccd3bcb0-3865-4528-b6a4-4fd47fc182db`). Apple processing
and its appearance in the **Team (Expo)** TestFlight group were not yet
confirmed when this was written. It is TestFlight-only; `1.0.2 (0.0.253)`
remains the version in App Review and was not changed.

- Build numbers `0.0.254` and `0.0.255` are burned. The first run stopped at
  the disk preflight (7GB free), and the second archived as `1.0.2 (0.0.255)`
  but App Store Connect refused it with "You've already submitted this
  version", because a version in review accepts no further builds. The
  marketing version was bumped to `1.0.3` in `app.config.ts` and all four
  `MARKETING_VERSION` entries in the Xcode project.
- Contents: feature-limit enforcement for AI assistant messages, AI insight
  reports, link checks and manual scans; the Usage & Limits screen; the
  repair of the 2026-10-03 UI restyle; and the Privacy Guard duress rework
  (decoy data applied at the `useGroups()` source, writes blocked). See
  commit `4aae57c`.
- Functions: before this build, 57 Functions were deployed to
  `splitcircle-c9e46`. That was every previously live function, updated,
  plus the new `getMonetizationUsage`. The CLI checks the secrets of EVERY
  function in the codebase even under `--only`, so the Security Center
  exports (`securityMonitoring`, `securityUrlAnalysis`) were commented out of
  `functions/src/index.ts` for that deploy only and restored right after.
  The Security Center gate below still applies: its 13 Functions are not
  deployed.
- The disk preflight needs 12GB. To get there, the npm, CocoaPods, Homebrew
  and pip caches, Xcode DerivedData and iOS DeviceSupport were cleared. Old
  Xcode Archives (about 4.7GB) were kept, and they are the next thing to
  prune.

### 2026-10-03 release status: Security Center provider gate

On October 3 at 8:31 PM CDT (October 4 at 01:31 UTC), App Store Connect
accepted the public update submission for iOS `1.0.2 (0.0.253)`.
Submission `c4ad006c-4759-4b13-b863-31fd382d5583` and the version both
showed `WAITING_FOR_REVIEW` on a fresh API read. Release type is
`AFTER_APPROVAL`, so Apple should publish automatically if it approves the
version. The public US storefront still showed `1.0.1` at submission time.
The update uses the processed TestFlight build; no new binary was uploaded
for this submission. Google sign-in and new-account email remain unverified
on a physical device, and live Security Center monitoring remains gated as
described below.

The iOS `1.0.1 (0.0.252)` archive built, but App Store Connect rejected its
submission because version `1.0.1` was already submitted. The replacement
archive uses marketing version `1.0.2`. Build `0.0.253` was uploaded and
accepted by App Store Connect through EAS Submit. On 2026-10-03, the signed-in
App Store Connect TestFlight page showed `1.0.2 (0.0.253)` in **Testing** for the
internal **Team (Expo)** group, and the group showed an installation of that
build by the owner iCloud tester account. Physical-device Google sign-in and
the new-account notification email remain unverified. The 56 existing core
Functions deployed.
The Security Center monitoring Functions were excluded from that
Functions deploy: Cloud KMS is not enabled, and the project has no values for
`SECURITY_MONITORING_KMS_KEY`, `SECURITY_BLIND_INDEX_KEY`, `HIBP_API_KEY`,
`FLARE_API_KEY`, or `GOOGLE_WEB_RISK_API_KEY`. Do not set dummy credentials or
describe monitoring as live. Finish provider onboarding, create the KMS key and
blind-index secret, bind the real provider keys, then run the full Functions
deploy and exercise enrollment, scanning, URL analysis, and deletion on a
physical device. Firebase Auth, Firestore rules/indexes, RTDB rules, and Storage
rules were deployed separately after the full Functions deploy stopped at the
missing-secret gate.

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

Google Cloud project `splitcircle-c9e46` → Google Auth Platform → Clients has Web,
iOS and Android client IDs. Put the public IDs in `.env` and restart Metro. The
iOS client must use bundle ID `com.splitcircle.app`. Its reversed client ID must
be registered as a URL scheme in the shipped `Info.plist`; the app uses
`<reversed-client-id>:/oauthredirect` and exchanges the authorization code with
PKCE before handing the credential to Firebase. Android needs the SHA-1 of each
signing key used to distribute the app. Firebase Auth must have Google and
Email/Password enabled.

Google Auth Platform → Branding controls the name shown in Google's account
authorization and related Google notices. Keep its app name **ManaSplit** and
check whether a changed public brand needs Google's verification. The
`firebase.json` auth section keeps the OAuth display name and the existing
public support address under source control; deploy it with
`firebase deploy --only auth --project splitcircle-c9e46`. A successful CLI
deploy is not proof that Google has published a changed public brand. The Firebase
project and Web app display names are also **ManaSplit**; their immutable IDs
remain `splitcircle-c9e46` and the existing app ID. After changing branding,
verify the consent screen and a new-account Google notice with a real account.
On 2026-10-03, the owner Chrome profile `chanikya.chowdary1@gmail.com` showed
the ManaSplit project Branding page with app name **ManaSplit** and the
`manasplit.pages.dev` public links. The canonical `assets/icon.png` was selected
in Google's logo picker and saved; the console confirmed "Branding changes
saved!" and again showed a Current App logo. A live Google sign-in preview for
the shipped iOS OAuth client showed "continue to ManaSplit" and "You're signing
back in to ManaSplit" with the expected privacy and terms links. A fresh
new-account notification email and a physical-device sign-in still need checking.
As checked on 2026-10-03, Audience is External and Testing with no listed test
users. Google's basic `openid`/`email`/`profile` sign-in exception permits
non-test accounts in that state, so Testing alone does not explain a login
bounce. Publishing changes the audience to production and can require brand
verification; assess that separately from sign-in debugging.
If a secret ever lands in git history: revoke first, then `git filter-repo`
before pushing.

### TODO: move public app links to manasplit.com

The Google OAuth Branding page currently uses `https://manasplit.pages.dev/`
for the homepage, privacy policy, and terms, with `manasplit.pages.dev` as an
authorized domain. Keep those working links until the custom website is live.

- [ ] After `https://manasplit.com/`, `/privacy/`, and `/terms/` are live, verify
  each page over HTTPS and set up the intended redirect from the Pages address.
- [ ] In Google Auth Platform → Branding, add and verify `manasplit.com`, then
  change the homepage, privacy policy, and terms URLs to the custom domain.
  Complete any Google brand verification prompted by that change; confirm the
  public consent screen still shows ManaSplit and its logo.
- [ ] Check Firebase Authentication authorized domains and the Web OAuth client
  origins/redirect URIs; add the custom domain only where a website sign-in flow
  actually uses it. Keep the iOS client bundle ID and callback scheme intact.
- [ ] Update public website references, including `website/sitemap.xml` and
  `website/robots.txt`, plus any App Store Connect website, support, or privacy
  links that still point to the Pages address.
- [ ] Recheck sign-in and a new-account Google notice after the cutover. Keep
  existing DNS mail records working during any DNS change.
