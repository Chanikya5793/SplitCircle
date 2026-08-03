# 36 — E2E notifications, background delivery, and dropping the Expo push relay

**Status: STEPS 1, 3, 5a AND 6 BUILT AND DEPLOYED 2026-08-03. Step 2 (App Group)
DONE on the portal. Step 4 (iOS NSE) is the remaining piece; step 5b (dropping
Expo) is gated on native-token coverage. NOTHING IS DEVICE-VERIFIED — no real
push has yet carried a sealed preview. See §8.** Written after a user
noticed that a message which showed as *undecryptable in the app* arrived
*perfectly readable in the notification* — which is not a quirk, it is the
symptom of three separate plaintext exposures.

Answers two questions asked alongside it: does this help our bad background
processing (**yes, substantially**), and does it get rid of the third-party push
service and server usage (**partly — they are separable changes, see §6**).

---

## 1. What actually happens today

A text message currently travels **two** paths, and only one of them is
encrypted.

| Path | Carries | Encrypted? | Who can read it |
|---|---|---|---|
| Message body | RTDB queue → Signal | **Yes** | Only the recipient device |
| Notification | Firestore → Cloud Function → Expo → APNs/FCM | **No** | Us, Expo, Apple/Google |

The unencrypted path, precisely:

1. **`ChatContext.tsx:1493`** writes `chats/{chatId}.lastMessage.content` to
   Firestore. For `type === 'text'` that is **the message plaintext**.
2. **`functions/src/index.ts:440`** (`onDocumentUpdated` on `chats/{chatId}`)
   reads `afterMsg.content` and builds the notification body from it.
3. **`functions/src/notifications.ts:140`** POSTs that to
   `https://exp.host/--/api/v2/push/send` — **Expo's relay**, with title and
   body in the clear.
4. Expo forwards to APNs/FCM.

So the plaintext of the most recent message in every chat is at rest in
Firestore, and in transit through a third party we do not control.

**This contradicts the project's own first architectural rule**, CLAUDE.md:
> Never store messages/calls in Firestore.

Scope, stated fairly: `firestore.rules` restricts `chats/{chatId}` reads to
participants, so this is **not** exposed to other users. The exposure is to the
server operator, the Cloud Function, Expo, and Apple/Google. That is still a
broken end-to-end claim — "the server cannot read your messages" is the entire
proposition — but it is not a data breach.

### 1.1 What it costs per message

The notification function performs, per message:

- 1 Firestore read — sender profile (`users/{senderId}`)
- 1 Firestore read — group doc, for group chats
- **N Firestore reads** — one per recipient, for the `lockedChats` check
  (`index.ts:493`)
- device-document reads inside `sendPushToUsers`
- 1 outbound HTTPS call to Expo, plus a later receipt poll

A 4-person group chat therefore costs ~6+ Firestore reads and 2 Expo round trips
**per message**. This is the "server usage" worth attacking, and §6 shows most
of it is removable independently of the crypto work.

---

## 2. Why background delivery is bad today

Separate problem, same fix window.

`ChatContext` subscribes to the RTDB message queue via
`listenForMessagesOnDevice` inside a React effect. There is **no `AppState`
handling anywhere in that file** — the subscription's lifetime is the mounted
component's. When iOS suspends the app the socket dies, and when the app is
killed nothing is listening at all.

Consequence: **messages are only ingested while the app is running.** Everything
queued while you were away lands in a burst on next launch. The existing
background task (`src/utils/backgroundNotificationTask.ts`) does *not* help —
it only dismisses stale tray notifications for `revoke` pushes; it never drains
the message queue.

That is the whole of "our app sucks at background processing": there is no
background ingestion path, only a background *dismissal* path.

---

## 3. The design

### 3.1 Do NOT run the Double Ratchet in the extension

The obvious design — give the iOS Notification Service Extension the Signal
session store and let it decrypt the real message — is a trap, and it is worth
being explicit about why:

- An NSE is a **separate process**. Signal sessions are stateful: decrypting
  advances the ratchet. Two processes advancing the same ratchet, with no shared
  lock, corrupts it. The failure mode is the one we have been chasing all
  session — messages that arrive but cannot be opened.
- The session store lives behind the **JS** libsignal binding
  (AsyncStorage/SQLite via the RN runtime). **An NSE cannot run JS.** There is no
  React Native runtime in that process, so the store would have to be reachable
  and writable from Swift.

### 3.2 Seal a separate preview with HPKE instead

Send a small **preview blob sealed to the recipient device's identity key**,
alongside the existing encrypted message. The NSE opens only that blob.

This is stateless: HPKE (RFC 9180) needs no ratchet, advances nothing, and
cannot desynchronise anything. Two processes opening the same blob is harmless.

**We already do exactly this.** `sealToIdentity` / `openWithIdentity` in
`modules/splitcircle-crypto` back doc 34's sync batches
(`syncBatchService.ts`), including the associated-data binding. The NSE needs
the device identity **private** key from the Keychain, shared via a Keychain
access group — not the session store.

Payload shape (APNs limit is 4096 bytes, so this must stay small):

```
{ "aps": { "mutable-content": 1, "alert": { "loc-key": "NEW_MESSAGE" } },
  "p": "<HPKE blob: senderName + preview text, ≤200 chars>",
  "chatId": "...", "type": "message" }
```

The visible fallback body — shown if the NSE times out or fails — must be
generic ("New message"). iOS displays that fallback verbatim on failure, so it
must never contain plaintext, or the whole exercise is undone by a timeout.

### 3.3 Android is easier and asymmetric

Android **can** run JS in a headless task, and `backgroundNotificationTask.ts`
already proves the wiring. A data-only FCM message triggers
`onMessageReceived` / the expo-notifications background task even when
backgrounded, so Android can reuse the existing JS crypto directly.

Worth planning for the asymmetry rather than forcing symmetry: iOS decrypts the
HPKE preview in Swift, Android can open the same blob in JS. One payload format,
two openers.

Android caveats: a **force-stopped** app receives nothing until relaunched, and
Doze delays normal-priority messages. Message pushes need
`priority: "high"`.

### 3.4 Does this fix background *delivery*, or only the notification text?

Both, partially — and the distinction matters.

- **Notification text**: fully fixed. The preview is decrypted on-device.
- **Message ingestion**: improved but not solved by the NSE alone. The
  extension can write the preview into App Group storage so the chat list is
  current on open. Carrying the *whole* message would mean putting the full
  ciphertext in a ≤4KB payload — viable for text, impossible for media.

The honest framing: this gets **text messages** delivered and readable while
backgrounded, and leaves media to the existing RTDB drain on next launch.
That is the same trade-off Signal makes.

---

## 4. Prerequisites this repo does not yet have

1. **App Group `group.com.splitcircle.app` is NOT provisioned.** CLAUDE.md is
   explicit: do not add `application-groups` to `SplitCircle.entitlements`
   before the capability exists on the portal, or `ship:ios` signing breaks.
   The widget runbook (doc 19 §4) has the same unmet prerequisite — one portal
   change unblocks both.
2. **No NSE target exists.** `ios/` has no notification extension. Adding a
   target is a manual Xcode step in this project — config plugins **do not run**
   here (committed `ios/`, non-CNG), so this cannot be done by installing a
   package.
3. **Keychain access group** for the identity private key, so the NSE can read
   it. `SignalKeychain` (`modules/splitcircle-crypto/ios/SignalStorage.swift:38`)
   sets `kSecAttrService` but **no `kSecAttrAccessGroup`** (verified: zero
   occurrences), so today the key is readable only by the app process. Adding
   one needs a Keychain Sharing entitlement on both targets, and every existing
   install's key must be migrated into the group or re-derived — an item's
   access group cannot be changed by reading it from a process that can no
   longer see it, so the migration has to run from the APP, before the NSE ever
   needs it.

   **Good news, verified:** the accessibility class is already
   `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, and that file's own
   comment says `AfterFirstUnlock` was chosen *"required for background
   decryption while locked"*. Someone already anticipated this. Had it been
   `WhenUnlocked`, the NSE could not decrypt while the phone was locked — which
   is precisely when a notification matters — and changing it later would have
   been a security decision, not a config tweak. That risk is already retired.
4. **Any App-ID capability change invalidates provisioning profiles.** Expected,
   not a failure — EAS regenerates on next `ship:ios`.

---

## 5. What it does NOT fix

- **Media notifications.** A photo's preview stays "sent a photo" — correct
  anyway, and no plaintext involved.
- **Metadata.** APNs/FCM still learn that *a* message went to *a* device at *a*
  time. Unavoidable with push at all; Signal has the same property.
- **The locked-chat path** already genericises copy (`index.ts:486`) and stays
  as-is; it is orthogonal and already correct.

---

## 6. Dropping the Expo relay — separable, and worth doing on its own

This is a **different change** from the crypto work and does not depend on it.

Today every device stores only an **Expo push token**
(`notificationService.ts:390`, `getExpoPushTokenAsync`). No native APNs/FCM
tokens are stored anywhere. Moving off Expo therefore means:

- registering `getDevicePushTokenAsync()` alongside, and storing both during a
  migration window (existing installs have no native token until they next run);
- sending via `firebase-admin`'s `getMessaging().sendEachForMulticast()` for
  Android, and either FCM-for-iOS or direct APNs for iOS. **We already have
  working token-based APNs code and secrets** — `functions/src/voipPush.ts`
  does exactly this for CallKit pushes, so the hard part (the `.p8` auth, the
  dual sandbox/production environment handling) is already solved and proven.

Removing Expo buys: one fewer party seeing notification content (moot once §3
lands, but true today), one fewer dependency in the delivery path, no Expo rate
limits, and the loss of the receipt-polling round trip.

**Independent server-cost win, cheaper than any of the above:** the per-recipient
`lockedChats` Firestore read (§1.1) can be eliminated by denormalising a
`lockedChatIds` array onto the device document already being fetched, or by
caching. On a 4-person group that removes ~4 reads per message on its own.

---

## 7. Suggested order

Each step is independently shippable and independently useful.

1. **Cheap server-cost win** — kill the per-recipient `lockedChats` read. Days,
   no new capability, no migration.
2. **Provision the App Group on the portal.** Unblocks both this and doc 19's
   widgets. One-time, and nothing can proceed on iOS without it.
3. **Android first** — data-only high-priority push + HPKE preview opened in the
   existing JS background task. Proves the payload format end to end without
   needing an Xcode target, an App Group, or a Keychain group.
4. **iOS NSE** — new target, Swift HPKE open, generic fallback body.
5. **Drop Expo** — dual-token migration, then switch senders to
   `firebase-admin` + the existing APNs provider.
6. **Stop writing plaintext to Firestore.** LAST, deliberately: only once
   notifications no longer depend on it. `ChatThreadRow` already builds its
   preview from local storage and uses `thread.lastMessage` merely as a
   pre-sync fallback, so the chat-list cost is a brief generic label on a fresh
   install — not a regression worth blocking on.

Step 6 is the one that actually closes the hole. Steps 1–5 are what make it
possible to do without degrading the product.

---

## 8. What actually shipped (2026-08-03)

Deployed and live. The plaintext hole this doc was written to close is CLOSED:
`onChatUpdated` is deleted from production (verified against
`firebase functions:list`, not the deploy log), and no message plaintext is
written to Firestore or read by any server.

| Step | State |
|---|---|
| 1 — kill the per-recipient `lockedChats` read | DONE (`2d7df3e`) |
| 2 — provision the App Group | DONE on the portal; `group.com.splitcircle.app` enabled on the App ID |
| 3 — sealed previews, sender + server + Android | DONE (`d8e021d`, `766e9cb`, `d91d304`) |
| 4 — iOS NSE | NOT STARTED — now unblocked by step 2 |
| 5a — collect native tokens | DONE (`e9c9ea8`) |
| 5b — drop the Expo relay | BLOCKED on measuring native-token coverage |
| 6 — stop writing plaintext to Firestore | DONE (`d91d304`) |

### 8.1 Deviations from the plan above

- **Previews ride the RTDB queue, not Firestore.** §3.2 did not say where they
  live; the plan implied the Firestore chat doc, since the notification trigger
  was there. That was wrong on both cost and security. `ChatContext` holds a
  live `onSnapshot` per chat, so a preview map on the chat doc ships EVERY
  device's blob to EVERY participant on every message; and `lastMessage`
  persists indefinitely, leaving encrypted previews at rest forever with
  per-participant device counts exposed. The RTDB queue is already per-device
  and is deleted after delivery. It also made step 6 fall out for free rather
  than becoming a later migration.
- **The push rides `fanOutQueuedMessage`**, not a new trigger on the same ref.
  Two triggers on one path would double invocations for no gain, and that
  function has already resolved exactly the devices needing a push.
- **Android replaces the notification rather than receiving a data-only push.**
  A data-only push means a failed handler shows NOTHING. Shipping generic
  visible copy plus a blob means the worst case is a less informative
  notification, never a missing one.

### 8.2 Two bugs worth remembering

- **The no-paired-devices branch would have gone silent.**
  `fanOutQueuedMessage` returns early when a recipient has no confirmed
  `pairedDevices` row, and the push was initially placed after that return.
  With `onChatUpdated` deleted, those recipients would have received nothing at
  all — and doc 34 §1's own measurement puts that branch at 77 of 198 real
  fan-outs (39%). Caught while preparing to deploy, not by a test. Same shape
  as the bug that opened this whole line of work: a mechanism removed and its
  replacement not covering every path the old one did.
- **`database.rules.json` was undeployable for hours** because of a `"//"`
  comment key added earlier in the session. RTDB treats every key as a path
  segment, so that is a syntax error; the file was valid JSON and invalid
  rules, and only a `firebase deploy` that was really about functions surfaced
  it. Now in CLAUDE.md, with the `--dry-run` check that catches it.

### 8.3 Device verification still owed

Nothing here has been exercised on a real push. In order:

1. iPhone → Pixel: Android should show the REAL message text.
2. Pixel → iPhone: iOS should show "New message" — correct until step 4, not a
   bug.
3. An account with NO confirmed paired devices must still be notified — the
   branch §8.2 nearly broke.

If Android shows generic copy, `sendMessagePushes` logs `withPreview`, which
distinguishes "sender never sealed" from "device could not open".

---

## 9. iOS NSE — everything except the Xcode target (2026-08-03)

All source, entitlements and the app-side plumbing are written and the crypto
module compiles. **The extension does not build or run yet**, because creating
an Xcode TARGET is not something that can be done safely by hand: it means new
`PBXNativeTarget`, build phases, configurations, an `Embed App Extensions`
phase on the app target and scheme edits, all inside the `pbxproj` that ships
the app. A malformed edit there breaks `ship:ios` for everything. This project
already treats target creation as a manual step (doc 19 §4 says the same for
widgets).

### 9.1 What is already done

- `ios/SplitCircleNotificationService/` — `NotificationService.swift`,
  `PreviewOpener.swift`, `SharedDeviceIdentity.swift`, `Info.plist`,
  `SplitCircleNotificationService.entitlements`.
- `SignalKeychain` writes the identity key to the **app group as a keychain
  access group**, reads both groups, and migrates existing installs
  (copy → verify → delete, never delete-first).
- `publishInstallationId` puts the installation id in App Group `UserDefaults`,
  republished on every read.

### 9.2 The one-time Xcode step

1. Xcode → **File ▸ New ▸ Target ▸ Notification Service Extension**.
   Product name **SplitCircleNotificationService**, language Swift, embed in
   **SplitCircle**. Let Xcode create it, then **delete the files it generates**
   and add the four in `ios/SplitCircleNotificationService/` instead.
2. Bundle identifier **`com.splitcircle.app.NotificationService`**.
3. Signing & Capabilities on the NEW target: add **App Groups**, tick
   `group.com.splitcircle.app`. Set `CODE_SIGN_ENTITLEMENTS` to the
   entitlements file above.
4. Same capability on the **app** target — it is provisioned on the App ID
   already (2026-08-03) but is not yet in `SplitCircle.entitlements`.
5. Add **LibSignalClient** to the extension's *Link Binary With Libraries*.
   `PreviewOpener` needs `IdentityKeyPair` and `PrivateKey.open`.
6. Set the extension's deployment target to match the app.
7. `cd ios && pod install` — CLAUDE.md: a new `.swift` absent from
   `Pods.xcodeproj` compiles to nothing and the build stays green.

### 9.3 Verifying it, given nothing here is proven

The failure mode is silence — every notification stays generic and no log says
why. So check in this order:

1. **Did the extension run at all?** `NSLog` from `didReceive` via
   `xcrun devicectl device process launch --console`. No line means the target
   is not embedded, or `mutable-content` is missing from the payload.
2. **Is the key visible?** `loadIdentityKeyPair` returning nil means the app has
   not run `migrateToSharedAccessGroup` since installing, or the entitlement is
   missing on one of the two targets.
3. **Is the device id there?** `SharedDeviceIdentity.installationId()` nil means
   the app has not called `publishInstallationId` — it does so on every
   `getOrCreateInstallationId`.
4. **Does the blob open?** If 1-3 pass and it still fails, the associated data
   disagrees. It is `base64(JSON({chatId, deviceId}))` with **sorted keys** on
   both sides; the TS half builds it in `previewAssociatedData`.

### 9.4 Known risk, stated plainly

`PreviewOpener.swift` has never been compiled — there is no target to compile it
in. The HPKE call mirrors `SignalSessionEngine.openWithIdentity` line for line
(`identity.privateKey.open(ciphertext, info:associatedData:)`), and the keychain
query mirrors `SignalKeychain`, but *mirrors* is not *verified*. Expect to fix
compile errors on first build; treat §9.3 as the real acceptance test, not the
absence of errors.
