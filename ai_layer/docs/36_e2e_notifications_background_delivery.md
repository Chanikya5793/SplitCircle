# 36 — E2E notifications, background delivery, and dropping the Expo push relay

**Status: RESEARCH ONLY, 2026-08-02. Nothing built.** Written after a user
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
