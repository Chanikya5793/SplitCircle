# 31 — Multi-Device Support + iCloud Backup/Sync

Status: **ARCHITECTURE LOCKED, PHASES 0-2 BUILT, PHASE 3 GATES 1+2 PASSED
(libsignal links, app launches, and a real libsignal call verified executing on
a physical iPhone) — Phase 3's crypto logic itself NOT yet built**
(2026-07-25, branch `ui-revamp`).
§1's 23 decisions and §3's full architecture are locked from two rounds of
research→verify→synthesize→adversarially-critique (all sonnet, sequential, per the
user's explicit process instruction). The final adversarial critique
(`wf_fd4b3134-d5d`) found real gaps in the first "final" draft — all resolved
inline in §3, including the one genuine product/security tradeoff (§3.12,
"lost every device" recovery model), confirmed by the product owner the same day.
Phases 0, 1, and 2 (§5) are built — see each entry for exactly what landed and
what's still unverified (no real native/simulator build has exercised any
phase end-to-end yet). Phase 3's own explicit pre-implementation spike is
in progress: the module scaffold and libsignal dependency are written, but
`pod install` under the dynamic-framework linkage libsignal requires is
currently failing for real, confirmed reasons (a CocoaPods validation error,
root-caused against CocoaPods' own source — see Phase 3's entry) — this
directly caught and corrected an earlier false "Gate 1 passed" claim in this
same doc, worth reading in full before trusting any future linkage-related
claim in this section without the same level of direct verification. Phases
3-8 remain not built.

## 0. Goal (as stated by the user, 2026-07-24)

WhatsApp-style multi-device:

- Chats sync in real time across every device a user is logged into.
- Any logged-in device can receive and send messages.
- One "main" device is the source of truth; chats are backed up to iCloud **from
  the main device only**.
- A **new** main device can restore its full chat history directly from iCloud
  (device-swap flow).
- Companion devices can take calls and receive notifications, not just messages.
- A companion device should *feel* like the main device (same chats, same groups,
  same history) while still allowing its own local customization (theme, wallpaper,
  notification prefs — the things already device-local today, see
  [CLAUDE.md](../../CLAUDE.md) `NotificationPreference`/wallpaper notes).
- Secure pairing/login flow for linking a companion device to a main device.
- Longer-term (explicitly deprioritized until the above ships): move expenses off
  Firestore too, to cut Firebase cost. Out of scope for this doc's first pass.

iCloud entitlement is already added to the App ID in the Apple Developer console
(user confirmed 2026-07-24) — capability exists, nothing wired up in the app yet.

## 1. Locked decisions (asked + answered 2026-07-24)

All 23 scoping questions asked in chat were answered as MCQs. These are now locked
product decisions, not open questions:

1. **Platform**: iOS-only for this feature (iOS app already shipped to the App
   Store). Android is a real future target using **Google Drive** as its backup
   analog — the sync layer must sit behind a provider-agnostic interface, not
   CloudKit-specific code sprinkled everywhere.
2. **Companion device types**: any Apple device, no hardcoded allowlist.
3. **Web companion**: explicitly planned for later — keep the pairing/sync
   protocol conceptually provider-agnostic from day one even though the first
   client is iOS-native.
4. **Main-device dependency**: companions must work **fully independently** of the
   main device once paired (modern WhatsApp/Signal model, not old WhatsApp Web).
   This locks in server/client-side per-device fan-out at send time, not
   phone-relay — consistent with how calls/notifications already work today (see
   §2.2).
5. **Main↔companion promotion**: wanted, but explicitly gated on a **verified
   complete backup/transfer** first — the user flagged, unprompted, that
   companion devices only hold a bounded window of data (#9), so promoting a
   companion or retiring an old main device without a verified-complete transfer
   risks **permanent, unrecoverable data loss** if the old main device is given
   away first. This is now a hard product requirement, not a nice-to-have — see
   §3/§5 for the concrete safety-gate design.
6. **Encryption bar**: **true end-to-end encryption** for message content —
   live messages too, not just backup. Not even the SplitCircle backend/Firebase
   should be able to read message content.
7. **Backup encryption**: iCloud backups must be encrypted with a
   **user-chosen passphrase** (WhatsApp-style), not just rely on default
   iCloud/CloudKit account security.
8. **Pairing security**: QR code scan **plus** a secondary out-of-band
   confirmation on both devices (Signal safety-number-style), **and** a separate
   manual (non-QR) pairing method must also exist as a fallback.
9. **First-pairing history depth**: a bounded window (e.g. last 90 days), older
   history fetched lazily on demand.
10. **Media sync**: full media sync to companions (not on-demand-only).
11. **Per-device settings**: let the user explicitly choose, **per setting**,
    whether it syncs across devices or stays local to that device.
12. **Privacy Guard / duress mode** (shake-to-hide, decoy world, `isVanished`):
    per-device by default, user-overridable, app must be transparent about the
    consequences/limitations of changing it.
13. **Call ringing**: user-configurable per device whether it rings for incoming
    calls.
14. **Call auto-silence**: answering on a companion auto-silences other devices
    ("answered elsewhere").
15. **Read state**: read/delivered receipts dedupe live across all of a user's
    devices.
16. **Backup cadence**: a combination — user-configurable frequency, automatic
    scheduling that respects real iOS background-execution constraints, an
    immediate manual "back up now" trigger, and an explicit user choice about
    whether backups may use cellular data. User explicitly asked this be
    "researched properly, documented transparently, including real platform
    limitations, so other agents can pick it up" — see §2.7.
17. **Backup scope**: includes call history, not just chat messages/media.
18. **iCloud unavailable**: degrade gracefully — live multi-device sync keeps
    working; only backup/restore is affected; user is clearly informed their
    backup is at risk.
19. **Expenses/groups/balances**: explicitly out of scope — already fully
    Firestore-synced, no device concept, no changes needed here.
20. **AI assistant threads**: stay per-device, do not sync.
21. **Companion device cap**: 4 per user for v1 (matches WhatsApp); more devices
    possibly behind a future paywall/subscription if stability allows.
22. **Rollout**: ship to all users once built — no feature flag / opt-in beta
    gating.
23. **Future expenses migration**: design the sync layer generically enough to
    plausibly extend to expenses later, without building that now or letting it
    complicate this build.

## 2. Research findings

Two background research workflows were run (sequential sonnet agents,
research→verify→repeat, per the user's explicit instruction). Run 1
(`wf_46761174-a22`) covered the codebase deep-dive + WhatsApp/Signal/CloudKit
prior art. Its first attempt at the external prior-art step stalled mid-stream
and returned nothing (see §4 — logged as a process gotcha, not a product one);
retried successfully on resume. Run 2 (`wf_fd4b3134-d5d`) covered E2E
multi-device crypto protocol choice and iOS background backup scheduling,
triggered by the user's answers requiring true E2E encryption and detailed
backup-scheduling behavior that run 1 had explicitly scoped out.

### 2.1 Current codebase — chat/message pipeline (verified)

- Messages live **only** in per-device AsyncStorage
  ([localMessageStorage.ts](../../src/services/localMessageStorage.ts), 789
  lines) after transiting RTDB. All mutations route through a per-chat
  serialized write chain (`chatWriteChains`/`withSerializedChatWrite`).
- Send flow: `ChatContext.sendMessage` (519-641) saves locally first, uploads
  any media, then `queueMessage` writes to RTDB per recipient via
  `set()` ([messageQueueService.ts:258](../../src/services/messageQueueService.ts)).
  Receive flow: `listenForMessages` parses the queue payload, downloads media,
  saves locally, sends a delivery receipt, and removes the queue entry.
- Reactions/read-receipts publish to Firestore via
  `messageStateService.ts` using `mergeFields` (not `merge: true`) —
  already following the CLAUDE.md gotcha correctly.
- RTDB is reaped by two separate scheduled functions in
  `functions/src/cleanup.ts`: a daily sweep (`cleanupOldRtdbData`, >1hr old
  regardless of status) and a 2-minute sweep for stuck `ringing` calls
  (`reapStaleRingingCalls`, >90s). Both were tuned for small, ephemeral,
  per-recipient entries — **not** the bulk-backfill or multi-device fan-out
  volume this feature will introduce (flagged as a real risk in §4).
- **No multi-device/session concept exists anywhere in this pipeline today.**
  Confirmed by an independent repo-wide grep for single-device-enforcement
  patterns (zero matches) — `AuthContext.tsx` already lets the same Firebase/GCIP
  account sign in concurrently on multiple devices with no special handling;
  "device" is currently only a push-registration concept
  (`NotificationDeviceRecord` in [user.ts](../../src/models/user.ts)), not an
  identity/session concept.

### 2.2 Current codebase — calls + notifications (verified) — key finding

**Calls and notifications already fan out to every one of a user's registered
devices today.** `collectVoipDevices`
([functions/src/voipPush.ts:86-115](../../functions/src/voipPush.ts)) queries
all of `users/{userId}/notificationDevices` with no limit/recency filter, and
`sendCallVoipPush` (128-242) `Promise.all`s a VoIP push to every device
returned. `resolveNotificationTargets`/`sendPushToUsers` in
`functions/src/notifications.ts` does the equivalent for regular pushes with
existing dedup/recency logic. **This means zero new server-side fan-out code is
needed for calls/notifications to reach companion devices** — companions just
need a `notificationDevices` doc with a `role` field and they're automatically
included.

What's genuinely missing, confirmed by direct code inspection (no guard exists
anywhere):
- No "answered elsewhere" cross-device signal — needs an `answeredByDeviceId`
  field on the `calls/{callId}` RTDB node plus every other device's CallKit
  listener calling `CXProvider.reportCall(..., reason: .answeredElsewhere)`.
- LiveKit room identity collision — `generateLiveKitToken`
  ([functions/src/index.ts:1320-1323](../../functions/src/index.ts)) mints
  `AccessToken({identity: uid, ...})`; two devices for the same user colliding
  on the same room identity today has no guard. Needs
  `identity: \`${uid}:${deviceId}\``.
- The CallKit UUID's deterministic uuidv5 derivation must be verified as keyed
  **only** on `callId`, never `deviceId` — the whole "answered elsewhere"
  mechanism depends on every device deriving the identical UUID, and this
  hasn't been explicitly confirmed (this exact class of client/server UUID
  mismatch has already burned this team once, per CLAUDE.md).
- APNs sandbox/prod token mismatch, today an obvious total failure (nothing
  rings), becomes a **silent partial failure** under fan-out — one companion
  with a bad token just never rings and nobody notices until someone asks why.

### 2.3 External prior art — WhatsApp/Signal multi-device + companion pairing

- WhatsApp's post-2021 multi-device redesign: each companion gets its own
  independent E2E identity/session; the server fans messages out per-device.
  **Important nuance the "fully independent" framing misses**: the primary
  phone must still "check in" periodically (commonly reported ~14 days across
  multiple secondary sources, not pinned to a single primary Meta document) or
  **all** companion devices get force-logged-out. So even WhatsApp's model isn't
  *infinitely* main-device-independent — it defers the dependency from
  per-message to roughly bi-weekly. Worth deciding deliberately whether
  SplitCircle wants an analogous (even if more lenient) liveness check, rather
  than silently having zero anchor at all.
- Cap of 4 linked devices, QR pairing, Signal's Sesame device-list algorithm —
  all confirmed standard/stable prior art.
- WhatsApp's E2E backup: password or 64-digit key → an HSM-based "Backup Key
  Vault" that rate-limits password-guessing attempts and renders the key
  permanently inaccessible after too many failed attempts. A formal
  cryptographic analysis of this protocol (CRYPTO 2023, IBM Research, built on
  OPAQUE password-authenticated key exchange) proved it secure under
  universal composability, **with one real caveat**: a corrupted server can
  under certain conditions make more password-guessing attempts than prior
  analysis assumed. SplitCircle does not have Meta's HSM infrastructure — a
  client-side-only KDF (Argon2id or high-iteration PBKDF2) is the practical
  substitute, with the same honest tradeoff WhatsApp makes explicit: **losing
  the passphrase means the backup is unrecoverable, by design.**

### 2.4 Apple platform capabilities — CloudKit / iCloud

- **Encryption has three real tiers, not two** (this materially changes what's
  achievable "for free"):
  1. Default `CKRecord` fields — Apple-readable at rest.
  2. Fields wrapped via CloudKit's **`encryptedValues` API** — genuinely
     end-to-end encrypted, keyed off the user's iCloud Keychain,
     **unconditionally available since iOS 15, independent of whether the user
     has Advanced Data Protection on.** Cannot be indexed server-side (real
     consequence: any future cross-device search over the CloudKit copy — see
     doc 25 — would need to rebuild an index locally from decrypted plaintext,
     never query CloudKit content directly).
  3. `CKAsset` binary attachments (media) — Apple-readable **unless** the
     specific user has personally enabled Advanced Data Protection; cannot be
     individually marked `encryptedValues`.
- **CKSyncEngine has real, independently-confirmed maturity risk as of
  mid-2026**: no public updates since its single WWDC23 session, and an Apple
  DTS engineer has explicitly confirmed on the public developer forums that
  `handleEvent` batch-acknowledgement ordering is "not formally documented, and
  may be subject to change" — apps should not rely on it, which conflicts with
  how an efficient field-level sync would naturally want to work. Treat as
  functional but budget for undocumented-behavior workarounds. Zero Simulator
  push support (device/Mac required for any real testing, consistent with this
  repo's existing PCC/widgets/App-Intents simulator-verification gaps).
- Standard, stable, long-documented quotas: 1MB per record, 50MB per asset,
  200 ops per response batch; private-database usage counts against the
  **user's own personal iCloud quota** (shared with Photos, device backups,
  everything else) — a heavy user's chat history + media backup could push a
  free-tier (5GB) account over quota with no warning built in by default.

### 2.5 E2E multi-device crypto protocol (run 2, verified)

- **Signal's Sesame algorithm**: one ciphertext per **device** session, not per
  user — "for each non-stale DeviceRecord in the UserRecord that contains an
  active session, the sending device encrypts the plaintext using that active
  session" (confirmed directly against Signal's own spec). A newly linked
  device gets an **empty** DeviceRecord — no historical session, therefore
  **zero cryptographic path to old ciphertext**. This is the actual crux of
  decision #9 (bounded history window): it isn't solvable by protocol choice,
  Signal and MLS share the identical limitation. Signal's own answer, shipped
  Jan 2025 ("Synchronized Start for Linked Devices"): the primary device
  bundles already-decrypted plaintext, re-encrypts it under a fresh one-time
  key, and ships it through Signal's own servers as an opaque blob (45-day
  media cap) — this is the pattern SplitCircle's history handoff is modeled on
  (§3.3).
- **MLS (RFC 9420)/TreeKEM** was seriously evaluated as an alternative — it's a
  ratified IETF standard, OpenMLS specifically passed an independent SRLabs
  security audit (published May 2026, 7 of 8 findings fixed, one Low-severity
  open), and it powers real production messengers (Wire; GSMA's E2E-RCS
  rollout across iPhone↔Android began May 2026). But it shares Sesame's exact
  same "no retroactive history for new members" limitation, its multi-device
  rekeying efficiency advantage doesn't pay for itself at SplitCircle's
  expense-splitting group sizes, and — decisively — **no official MLS Rust
  binding targets React Native**, so adopting it would mean building the same
  category of Rust-FFI bridge risk libsignal's official Swift bindings let
  SplitCircle skip entirely (see below). WhatsApp itself uses Signal Protocol +
  Sender Keys, not MLS — a common but confirmed-incorrect assumption to watch
  for in any future reference material.
- **Library decision: libsignal via its official first-party Swift bindings**,
  wrapped as a new native module — **not** MLS/OpenMLS, **not** a hand-rolled
  ratchet, **not** the unofficial community React Native libsignal wrapper
  packages. libsignal's only official bindings are Java, Swift, and
  TypeScript(Node.js) — no React Native binding exists from Signal itself.
  Because SplitCircle is iOS-only for v1 (decision #1), official Swift bindings
  let it skip the Rust-FFI/UniFFI bridge risk entirely (real but young
  precedent exists for that path — `uniffi-bindgen-react-native` +
  `react-native-matrix-sdk` bridging `matrix-rust-sdk`, Mozilla-tooled,
  2024-era, not proven at production scale) by building the crypto core as a
  plain native Swift module in the same house pattern already used for
  `modules/splitcircle-ai`. **Do not hand-roll a Double Ratchet implementation**
  — both libsignal and OpenMLS represent a decade-plus (libsignal) or recently
  independently-audited (OpenMLS) level of adversarial scrutiny a one-shot
  in-house build cannot replicate.
- **Groups** use Signal Sender Keys (one sender-key per user per group,
  distributed pairwise once per member device via Double Ratchet) — matches
  WhatsApp's actual group crypto and scales fine at SplitCircle's group sizes.
  Rekey-on-membership-change (a member leaves) is standard Signal behavior but
  has **no implementation-level protocol detail specced yet** — carried forward
  as an open risk into Phase 3 (§3.10).
- **WhatsApp's backup key hierarchy is architecturally separate from its
  live-messaging Signal Protocol identity keys** — confirmed, including a May
  2026 Meta follow-up adding cryptographic transparency (HSM fleet keys now
  delivered in a signed, independently-verifiable validation bundle) that
  reinforces rather than changes this separation. SplitCircle's design mirrors
  this: the passphrase-derived backup key (§3.4) is independent of the
  per-device Signal identity keys (§3.3).

### 2.6 iOS background backup scheduling (run 2, verified)

- **`BGProcessingTaskRequest`** (minutes-scale, deferrable maintenance work) is
  the correct fit for scheduled backup — confirmed against Apple's own
  framework docs. `BGAppRefreshTaskRequest` (~30s budget) is not suitable.
- **No timing guarantee exists, confirmed verbatim from Apple's own DTS
  engineer** on the public developer forums: "Processing tasks are typically
  run overnight when the device is on mains power," targeting the "middle" of
  a low-usage window, opportunistic and system-dependent — never promise a
  specific backup time to the user.
- **No wifi-only or power-required flag exists on `BGProcessingTaskRequest`**
  as of iOS 26/27 — confirmed by direct search, not just inherited assumption.
  `requiresNetworkConnectivity` is a plain online/offline gate (cellular or
  wifi, no distinction). A cellular-data preference (#16) must be **self-enforced
  inside the task handler** via `NWPathMonitor`, rescheduling rather than
  uploading if the connection is cellular and the user opted out.
- **Expo's `expo-background-task` is confirmed insufficient** — directly
  fetched Expo's own docs: the only configurable option is `minimumInterval`;
  network/power gating are hardcoded platform defaults, not exposed knobs. A
  native Swift module is required for the scheduled path (consistent with this
  app already shipping several native modules for App Intents/widgets/CallKit).
- **Real finding that changes the manual-backup design**: iOS 26 shipped
  **`BGContinuedProcessingTask`** (WWDC25 Session 227) — purpose-built for a
  user-initiated foreground action (tap "Back Up Now") that should keep running
  if the app is backgrounded mid-upload, with a **system-rendered Live Activity
  progress UI and cancel control for free**. Apple's own example use case is
  literally an export/upload flow. This is a better fit than a bare
  foreground `URLSession` call for the manual backup path (§3.5) — the app
  builds no custom progress chrome at all.
- Standard, stable UX pattern to follow: show only "Last successful backup:
  [relative time]," never a predicted next-run time.

## 3. Final architecture (locked)

Two independent engines, never conflated, sitting behind a provider-agnostic
boundary so Android/Google-Drive and a future web client (#1, #3) can plug in
later without touching call sites.

### 3.1 Live sync engine — RTDB per-device fan-out

Extends existing DNA, doesn't replace it. Today `messageQueueService.ts`'s
`queueMessage(recipientId, message)` writes one copy to
`messageQueue/{recipientId}/{message.id}`. Change the path shape to
`messageQueue/{recipientId}/{deviceId}/{message.id}` and change `queueMessage`
to `queueMessageToAllDevices`, looping `set()` over every `deviceId` in the
recipient's device registry (max 4, decision #21 — the same no-limit-query
shape `collectVoipDevices`/`sendPushToUsers` already use for push, now also
applied to the message queue). Each device's `listenForMessages` watches only
its **own** `deviceId` subtree. This is the single biggest mental-model shift
in this whole feature: **`localMessageStorage.ts` (AsyncStorage+files) becomes
per-device, not per-user** — a user with 3 paired devices has 3 independent
local stores, kept eventually consistent via this live fan-out for new
activity plus CloudKit-backed history handoff (§3.3) for cold-start backfill
on a newly paired device.

Read/delivered dedupe across devices (#15) rides the same relay: a lightweight
receipt-sync event fanned device-to-device drives the **already-existing**
`markMessagesRead`/`applyRemoteMessageState` in `localMessageStorage.ts` — no
new tier invented, no new merge-semantics risk (already `mergeFields`-correct
per the CLAUDE.md reactions lesson).

### 3.2 Backup/restore engine — CloudKit, deliberately NOT CKSyncEngine

Explicit deviation from a naive "just use CKSyncEngine" default: SplitCircle's
backup/restore is **one-shot bulk export** (main device → CloudKit, scheduled
or manual) and **one-shot bulk import** (new/promoted main device only ←
CloudKit, once) — not continuous bidirectional sync. That means CKSyncEngine's
confirmed-unstable batch-acknowledgement-ordering risk (§2.4) doesn't need to
be accepted at all. Use raw `CKModifyRecordsOperation`/
`CKFetchRecordZoneChangesOperation` in ~200-record chunks (with backoff on
`.zoneBusy`/`.serverResponseLost`/`.limitExceeded`) inside a new native Swift
module (`ios/SplitCircleBackup/`), private database default zone (no
multi-writer conflict resolution needed — only the main device ever writes).

Provider-agnostic interface: a `BackupProvider` Swift protocol
(`backupChunk()`, `restoreChunk()`, `verifyIntegrity()`, `estimateSize()`,
`isHealthy()`) with `CloudKitBackupProvider.swift` as the only v1
implementation. A future `GoogleDriveBackupProvider` (Android, #1) or a
web-client provider (#3) plugs in without touching `backupService.ts` call
sites — this is the concrete mechanism honoring decision #23 ("generic enough
to extend later") without building anything extra now.

Record types: chunked message-batch records (day- or 500-message-bounded,
under the 1MB non-asset ceiling), `CKAsset` for full media (#10), a separate
call-history record type (#17), and an incrementally-maintained
`BackupManifest` record (per-chat `{count, latestTimestamp,
latestMessageChecksum}`) computed **synchronously at backup-write time** — the
device-retirement gate (§3.6) reads this manifest, it never re-derives it by
walking raw records later (E2E encryption makes after-the-fact plaintext
diffing mechanically impossible by design — the device only has plaintext
transiently, right before it's encrypted for transit or backup).

### 3.3 End-to-end encryption

libsignal via official Swift bindings, native module `modules/splitcircle-crypto/ios/`
(§2.5). Per-device Signal sessions (Sesame-style): every paired device is its
own independent identity (own identity keypair, own prekey bundle published to
a new `users/{uid}/signalPrekeys/{deviceId}` Firestore collection — public
material only, safe under existing rules patterns, mirrors how
`notificationDevices` already shapes per-device rows). The §3.1 per-device
fan-out means each recipient device — and each of the *sender's own* other
devices — gets its own ciphertext under its own session.

Encrypted: message `content`, media payload (encrypted client-side before
upload, key delivered in the Signal envelope), `replyTo.content` snippet,
`location`. Left plaintext (explicit, bounded scope): `chatId`, `senderId`,
`timestamp`, `type`, delivery/receipt bookkeeping, and `expenseRef` pointers —
the linked Firestore expense/group doc stays exactly as today (#19); only the
chat bubble referencing it is E2E'd.

**History handoff for newly paired devices** (resolves the bounded-history
requirement, #9): modeled directly on Signal's own 2025 "Synchronized Start."
At pairing completion, the main device bundles the last 90 days of
already-decrypted plaintext, re-encrypts it under a fresh one-time key
exchanged through the pairing channel's own ephemeral key agreement (§3.4),
and transports it as an opaque `HistoryHandoff` CKRecord — CloudKit plays the
"opaque relay that never reads it" role Signal's own servers play in their
design. **This is genuinely new protocol work, its own roadmap phase (§3.10
Phase 6), not a footnote** — both Signal and MLS share the same
no-retroactive-history limitation, so this is unavoidable regardless of
protocol choice.

### 3.4 Pairing security

Cloud-Function-mediated, admin SDK — matches the existing
`joinGroupByInviteCode`/`deleteAccount` pattern, avoiding the Firestore
query-provability trap already documented in CLAUDE.md.

1. **Main device**: "Link a device" requires a `LocalAuthentication` biometric
   re-auth gate **before the pairing screen is even reachable** (closes a real
   gap the first draft had — gating only on "foregrounded/unlocked" would let
   ~2 minutes of unattended physical access silently pair a malicious
   companion). Then `createPairingCode` (new `functions/src/pairing.ts`,
   `onCall`) writes a 5-minute-TTL `pairingCodes/{code}` doc
   `{uid, expiresAt, consumedBy: null}` and returns a QR payload
   `{code, uid, ephemeralPublicKey}` — the ephemeral key transports *only* the
   history-handoff key material (§3.3), kept separate from the long-term
   Signal identity key.
2. **New device** scans the QR, **or** manually types the same 8-character code
   (the required non-QR fallback, #8) → `redeemPairingCode` (`onCall`) does, in
   one transaction: (a) idempotent redemption — `consumedBy` must be null and
   is set atomically in the same write, closing the retry-double-redemption gap
   the first synthesis left open; (b) mints a Firebase custom auth token,
   carrying a `deviceId` claim (needed for revocation, below); (c) writes
   `notificationDevices/{deviceId}` (reused) + `pairedDevices/{deviceId}`
   (new — platform, name, pairedAt, lastSeenAt, isMainDevice:false, backs the
   revoke UI); (d) writes the new device's Signal prekey bundle; (e) writes an
   RTDB `pairingConfirm/{uid}/{code}` event the main device is already
   subscribed to.
3. **Secondary out-of-band confirmation** (#8, Signal-safety-number-style —
   this is the actual MITM check): the server derives a short numeric code from
   a hash of both devices' Signal identity public keys. The new device shows
   it; the main device gets a **mandatory push** (reuses `sendPushToUsers`,
   zero new fan-out infra needed) plus an in-app sheet with the same code and
   the new device's name/platform, requiring an explicit "Confirm — this is my
   device" tap. **The new device's prekey bundle is not trusted for Sender Key
   distribution or history handoff until this confirmation lands** — a
   photographed/intercepted QR completes server-side redemption, but the main
   device's owner sees an unexpected device and can deny instead of confirm.
4. **Linked-devices Settings screen**: lists `pairedDevices`, each with
   "Remove this device."
5. **Revocation is a hard revoke, not a soft one**: `firestore.rules` and RTDB
   rules both gain a check that `request.auth.token.deviceId` must exist in
   the user's live `pairedDevices` list. `revokeDevice` deletes the
   `pairedDevices`/`notificationDevices`/`signalPrekeys` docs for that device
   **atomically** (verify this is a literal multi-doc transaction at
   implementation time, not sequential awaits that only look atomic — a
   partial failure here reproduces the exact `archivedMembers`/
   `isGroupJoinUpdate` class of bug already documented in CLAUDE.md) — the next
   read/write from the cached client then fails immediately under the new
   rule, rather than surviving until natural token TTL expiry. The revoked
   device also gets a silent push to wipe local Signal session state.
6. **"Paired but not yet trusted" UX (closes a real gap the adversarial
   critique found)**: redemption (step 2) necessarily happens *before*
   confirmation (step 3) gates cryptographic trust, and push/message fan-out
   already iterates every `notificationDevices` row unconditionally — so a
   newly redeemed device can receive a "new message" push and open a chat with
   **nothing decryptable** while it waits for the main device owner to notice
   and tap Confirm, which can realistically take hours. The device state
   machine must have an explicit `pending_confirmation` status, surfaced as a
   clear "Waiting for [main device] to confirm this device" screen instead of
   a blank or decrypt-error chat, and message fan-out to a device should be
   gated on **trusted session existing**, not merely device-registry
   membership. A `pairingCodes` doc has a 5-minute TTL bounding *redemption*,
   but nothing bounded *confirmation* in the first draft — add an analogous
   TTL (e.g. 24h) after which an unconfirmed pairing auto-expires and frees the
   device slot, rather than sitting as a live, unconfirmed, standing entry
   indefinitely.

### 3.5 Backup encryption

Two independent layers, explicitly **not** redundant defense-in-depth (see
§3.9 for why this distinction matters): CloudKit's native `encryptedValues`
API wraps the backup record's content field (true E2E, iCloud-Keychain-keyed,
unconditional since iOS 15), **and**, underneath that, the whole backup
payload is encrypted client-side under a **user-chosen passphrase** via a
memory-hard KDF (Argon2id preferred; CryptoKit ships no Argon2, so budget real
native-Swift integration effort — PBKDF2 via `HKDF` with a high iteration
count is the explicit fallback if Argon2id proves too costly for a one-shot
build; decide the fallback threshold early, not mid-implementation).

**Passphrase UX (a real gap the first draft left entirely unspecified,
resolved here)**: enrollment must include a strength check, a "confirm you've
written this down" step (WhatsApp's own model, which this design explicitly
follows, requires exactly this), and the literal sentence **"If you forget
this passphrase, this backup cannot be recovered by anyone, including us"** —
shown at passphrase-*creation* time, not just implied later in a retirement
banner. Restore must use an AEAD cipher mode so a wrong passphrase fails
**cleanly** (auth-tag mismatch → clear error) rather than silently decrypting
to garbage that then gets imported as corrupted chat history. Since decryption
happens fully offline against already-downloaded CKRecords, there is no
server-side rate limit on guessing — passphrase entropy is the only thing
between a stolen encrypted blob and offline brute force; enforce a real
minimum strength at enrollment, don't just suggest one.

### 3.6 Backup scheduling & UX

Automatic: native Swift `BGProcessingTaskRequest`
(`com.splitcircle.app.backup.scheduled`). `earliestBeginDate` derives from a
user-chosen frequency (Daily / Every 3 days / Weekly / Off) stored **synced**
in Firestore `users/{uid}/backupSettings` (only the main device ever acts on
it, so one value suffices — not a per-device local setting).
`requiresNetworkConnectivity = true` always; cellular allow/deny (#16) is
self-enforced inside the task handler via `NWPathMonitor` — if cellular-only
and the user hasn't opted in, reschedule (+2h) and exit without uploading.

Manual "Back Up Now": iOS 26's `BGContinuedProcessingTask` (§2.6), not a bare
foreground `URLSession` — real determinate progress via `Progress`/
`ProgressReporting`, system-rendered Live Activity + cancel, survives the app
being backgrounded mid-upload, and the app builds no custom progress chrome.

Honest-uncertainty copy in a new `BackupSettingsScreen`: shows only "Last
successful backup: [relative time]," never a predicted next-run time, with
static explanatory copy ("Automatic backups are on — usually happen overnight
while charging and connected to Wi-Fi, but iOS decides exactly when").
Frequency picker: "This sets how often we ask iOS to consider backing up — iOS
decides the exact timing." Cellular toggle defaults **off**. A persistent risk
banner appears once the last backup is older than 2x the chosen frequency,
linking straight to "Back Up Now." A distinct iCloud-unavailable banner (#18):
"iCloud isn't available right now, so your chats aren't being backed up — your
messages are still syncing live across your devices, just not backed up to
iCloud until this is resolved."

### 3.7 Device retirement / promotion safety gate

The single most product-critical piece of new UX in this build — the user
raised this risk unprompted (#5), and the adversarial critique found the first
draft's verification was ambiguous in exactly the way that makes it gameable.

"Verified complete" is now defined mechanically, resolved to close that gap:

1. **Record-count + timestamp reconciliation** against the `BackupManifest`
   (§3.2) — extend `localMessageStorage.ts` with `getLocalMessageStats(chatId?)`.
2. **The manifest checksum is trusted, not re-derived** — computed
   synchronously at backup-write time (§3.2), because E2E encryption makes
   after-the-fact plaintext diffing on the CloudKit side mechanically
   impossible by design.
3. **A real second-device handshake is the actual trust anchor — and it MUST
   perform real decryption, not just compare metadata** (this explicit
   requirement closes the critique's gameability finding: if the "independent"
   restore-side check only re-derives count/timestamp from CloudKit metadata,
   a structurally-intact-but-corrupted backup passes cleanly without the
   ciphertext ever round-tripping through Signal/passphrase decryption — that
   must not be possible). `initiateRetirement()` forces an immediate
   `BGContinuedProcessingTask`-driven backup if the last completed backup is
   stale or the count check shows any gap; on success it writes a
   `RetirementAttestation` record (manifest snapshot + Signal-identity-key-signed
   attestation). The promoted/new device independently restores from that
   **same** manifest into a scratch verification buffer, **actually decrypts
   every chunk (or a well-justified statistical sample — not metadata alone)**,
   and writes back a `RestoreVerified` ack. Only when both records exist does
   retirement/promotion unlock.
4. **Single-device migration is the most common real case and was the
   weakest path in the first draft** — a user with exactly one device moving to
   a new phone has no second device to perform step 3's real trust anchor. The
   UI must **force** pair-new-device-first-then-retire-old (safe, reuses
   existing infra) rather than offering an "informational self-check" as an
   apparently-equal alternative — the first draft left this ambiguous, which is
   the dangerous reading.
5. **UI**: new `DeviceRetirementScreen`, default state "Not yet safe to
   retire" with plain-language reasons ("3 chats haven't finished backing up" /
   "Waiting for [device] to confirm it received your backup"), live progress
   during the forced backup, retire/promote action **disabled** (not
   warn-and-allow) until the handshake completes. Removing the current main
   device while no other device holds a verified attestation is blocked by a
   modal requiring either a completed verified backup or a deliberately
   effortful typed-confirmation phrase acknowledging permanent data loss (an
   escape hatch is preserved — never make leaving literally impossible; the
   app cannot stop an OS-level factory reset regardless, so this modal is the
   only real intervention point).
6. **What this gate cannot control**: a factory reset happens at the OS level
   with zero app hooks. If the old device is later stolen rather than
   deliberately wiped, its Firebase custom-token `deviceId` claim stays valid
   against the `pairedDevices` allowlist indefinitely unless another device
   calls `revokeDevice`. There is currently no "report this device lost/stolen"
   flow that doesn't require having another trusted device handy — flagged as
   an explicit open risk (§3.10), not solved by this gate alone.

### 3.8 Settings sync model

New `PerDeviceSetting<T>` registry (`src/config/settingsRegistry.ts`) tags
every setting `scope: 'synced'` (Firestore `users/{uid}/settings/{key}`,
snapshot-listened on every device) or `scope: 'local'` (AsyncStorage-only,
matching the precedent decision #20 already set for AI threads). Per-device
ring toggle (#13) is `local` by definition. Privacy Guard/duress mode (#12)
defaults `local`, `userOverridable: true`, gated by an explicit in-app
explainer before flipping to synced ("If you sync this, every linked device
shares the same duress passphrase and decoy state — understand the tradeoff
before turning this on") — satisfies the transparency requirement via
disclosure, not by hiding the control. Backup frequency/cellular-allow (#16)
are `synced`. Cosmetic settings default `local` unless product decides
otherwise — a one-line registry change, not an architecture change, which is
how #23's "generic enough to extend later" is honored without building
anything extra now.

### 3.9 Calls and notifications

Push/VoIP fan-out to every registered device **already works** — zero server
changes needed (§2.2). Three scoped changes:

1. **LiveKit per-device identity fix**: `identity: uid` → `` identity: `${uid}:${deviceId}` `` client-side, audit every server-side `AccessToken`-minting
   Cloud Function to match.
2. **"Answered elsewhere" (#14)**: extend the existing `/calls`/
   `userActiveCalls` RTDB signaling with an `answeredBy: deviceId` field
   written via `transaction()` (not plain `set()`, so exactly one device
   wins the race). Every other device already listening reacts by calling
   CallKit's real `reportCall(..., reason: .answeredElsewhere)` — no new
   server fan-out, rides the existing signaling path. The LiveKit identity
   change is scoped to room-participant identity only, **not** the
   CallKit/RTDB `callId`-keyed signaling path that must stay byte-identical
   client/server (CLAUDE.md) — re-verify this boundary explicitly at
   implementation time given this exact invariant has broken before.
3. **Per-device ringing toggle (#13) is a genuine open risk, not a solved
   detail**: CLAUDE.md already documents that `reportNewIncomingCall` **must**
   be called unconditionally on every VoIP push or iOS revokes the privilege —
   in real tension with a device simply not ringing. The compliant approach
   still calls `reportNewIncomingCall` (preserving the privilege) and
   immediately follows with a suppression/muted presentation — this needs real
   physical-device verification before shipping, not just code review.

### 3.10 CLAUDE.md Architecture DNA amendment (to land with the code, not after)

Add to the Architecture DNA table's Local tier row: *"Local tier is now
PER-DEVICE, not per-user — a user with N paired devices (max 4) has N
independent AsyncStorage/file stores, kept eventually consistent via live
per-device RTDB fan-out for new activity and CloudKit backup/restore for
cold-start backfill on newly paired/promoted devices only."*

New gotcha entries to append once built:
1. Never route message content through CloudKit's CKSyncEngine — deliberately
   not used; its batch-acknowledgement ordering is undocumented/unstable per
   Apple DTS, and this app's backup/restore is one-directional bulk
   export/import, so raw `CKModifyRecordsOperation`/
   `CKFetchRecordZoneChangesOperation` batches are used instead. Don't
   "upgrade" to CKSyncEngine later without re-deriving why it was avoided.
2. A device-retirement checksum must be computed at backup-**write** time,
   never reconstructed later — E2E encryption makes after-the-fact plaintext
   diffing mechanically impossible by design.
3. `BGProcessingTaskRequest` has no wifi-only or power-required flag —
   confirmed absent as of iOS 26/27, not a gap to re-check later. Self-enforce
   cellular choice via `NWPathMonitor` inside the task handler. Never surface a
   predicted next-backup time to the user.
4. Per-device Firebase Auth session enforcement needs a `deviceId` custom-token
   claim checked against a live `pairedDevices` allowlist in **both**
   `firestore.rules` and RTDB rules, or "remove this device" does nothing
   until natural token TTL expiry — mirrors the existing lesson that every
   `groups/{groupId}` membership-shape change needs a matching rule branch or
   the write silently fails for everyone.
5. Crypto (`modules/splitcircle-crypto`) sits on the hot path of **every**
   message send/receive, not an occasional AI query — an unguarded
   `require()` of a not-yet-linked native module (stale sim build, dev build
   where the pod wasn't reinstalled) crashes the whole chat surface, not one
   feature. Probe with `requireOptionalNativeModule()` here even more strictly
   than elsewhere.
6. No hot-swap iteration on `splitcircle-crypto` or `SplitCircleBackup` during
   active development — both are brand-new, actively-changing native Swift
   modules; the documented JS-bundle-hot-swap sim workflow will silently test
   against stale native code. Full rebuild only for these two modules.
7. Bulk operations racing Foundation Models calls is a **symmetric** risk, not
   just a restore-time one: the first-ever bulk backup **export** (Phase 4)
   reads potentially years of message history off `localMessageStorage.ts`
   while ambient FM activity (Spotlight indexing, stats narration) may be
   running concurrently — the same SIGSEGV class already hit on a physical
   device. Route through the existing `serializeFm` queue on both the export
   and the history-handoff/restore import paths, not just one.
8. Group Sender Key rekeying on membership change fans out pairwise to every
   remaining member's every device through the RTDB tier — for
   expense-splitting groups with routine membership churn (roommates, trip
   groups), this is exactly the bulk-fan-out volume pattern the existing
   reaper (tuned for small ephemeral entries) wasn't built for. Re-validate
   reaper batch sizing against this before shipping group chat E2E.
9. A mixed dev/prod device pair (e.g. a TestFlight companion paired to a prod
   main device) silently drops a push to one device per the existing
   sandbox/prod APNs gotcha — under E2E this can also delay Double Ratchet
   processing on that device, interacting with skipped-message-key growth
   limits in a way that can produce a **second, compounding** silent failure
   (decryption failure on very-late delivery). Watch for this combination
   specifically when debugging "message never arrived on my iPad" reports.

### 3.11 Two overlapping device registries — verify, don't assume

`notificationDevices` (reused, already in production) and `pairedDevices`
(new) both track "devices for a user" with overlapping purpose.
`revokeDevice`'s claim to delete rows from both "in one transaction" must be
verified as a literal atomic multi-doc transaction at implementation time, not
sequential awaits that only look atomic — a partial failure here reproduces
the exact `archivedMembers`/`isGroupJoinUpdate` class of bug already
documented in CLAUDE.md. Also: `notificationDevices` is already a live,
in-production collection (push/VoIP token registration runs on every device
today) — adding a `role`/pairing-related field to it means auditing the
**existing** `firestore.rules` update branch's `affectedKeys().hasOnly([...])`
list, not writing a clean new branch from scratch. A gap here is more
dangerous than a gap on a brand-new collection, because it can silently break
routine push-token refresh for every existing user, not just new
companion-pairing users. **This audit is scoped as Phase 0, first task — see
§3.12.**

### 3.12 One flagged tradeoff that needs explicit sign-off: recovering from "lost every device"

The adversarial critique found a real, unresolved gap in the first "final"
draft: stacking CloudKit's `encryptedValues` (iCloud-Keychain-keyed) under the
passphrase layer was described as "defense in depth," but for the
**all-devices-lost** case these are not redundant — they're an **AND-gate of
two independent failure modes**. `encryptedValues`'s own decryption key lives
in iCloud Keychain escrow, which itself depends on the user having configured
iCloud recovery in advance (a recovery contact, or a separate Apple recovery
key) — not something Apple guarantees "just works" from an Apple ID and
nothing else. If a user never set that up (the common case) and loses every
device, the CloudKit-layer key can be gone even if the user remembers the
passphrase perfectly.

The first draft also had **no bootstrap flow at all** for this scenario —
every recovery path ran through §3.4's pairing design, which requires an
**existing trusted device** to confirm. If every device is lost, nothing can
confirm anything.

**The resolution this doc recommends, matching WhatsApp's own actual model**:
new-main-device restore should be its own flow, independent of §3.4's
companion-pairing flow entirely — a brand-new device authenticates via the
existing Firebase Auth (email/Google/Apple, no other device needed) to prove
account ownership, then enters the backup passphrase to prove backup
ownership, and that combination alone is sufficient to restore as the new main
device. No existing device's cooperation, confirmation, or even continued
existence is required. This is deliberately the **same security tradeoff
WhatsApp itself makes** (phone number + backup password = full restore) —
weaker than requiring physical possession of an existing paired device, but
it's the only way "lost every device, still have the passphrase" is
recoverable at all, and the passphrase-loss-is-permanent framing (§3.5) is the
explicit, communicated cost of that choice.

**CONFIRMED by the product owner (2026-07-24): yes, match WhatsApp's model.**
Their reasoning sharpens the security framing beyond what this doc originally
gave credit for: an attacker needs not just SplitCircle account credentials,
but **actual access to the user's iCloud account** (CloudKit's private
database is only reachable while signed into that specific iCloud account on
the device) **plus** the backup passphrase — three independent factors in
practice (SplitCircle auth, iCloud account access, passphrase), not the two
this doc's original framing implied. Locked: new-main-device restore is its
own flow, independent of §3.4's companion-pairing flow, gated only on
(Firebase Auth + iCloud account access + backup passphrase) — no existing
device's cooperation required. Build this in Phase 8 as specified.

## 4. Bugs / gotchas discovered along the way

- **Process gotcha, not a product one**: the first research workflow's
  external-prior-art step (a single agent covering WhatsApp + Signal + CloudKit
  in one pass) stalled mid-stream and returned nothing; the verification step
  correctly caught the empty input rather than fabricating a report. Fixed by
  splitting it into two smaller, independently-scoped research calls
  (messaging prior art; CloudKit prior art) before retrying — worth remembering
  as a pattern if a future research pass on this doc stalls again: split
  broad/multi-topic research agents rather than just retrying the same
  oversized prompt.
- **`notificationDevices` already exists in production** (push/VoIP token
  registration runs on every device today) — adding a `role: 'main'|'companion'`
  field to it means auditing the **existing** `firestore.rules` update branch's
  `affectedKeys().hasOnly([...])` list, not writing a clean new branch from
  scratch. A gap here is more dangerous than a gap on a brand-new collection,
  because it can silently break routine push-token refresh for every existing
  user, not just new companion-pairing users — exactly the `isGroupJoinUpdate`
  class of bug (see CLAUDE.md), on a bigger blast radius.
- **Bulk restore is a plausible Foundation-Models SIGSEGV trigger.** Restore
  lands potentially thousands of messages in AsyncStorage at once, unlike
  normal one-at-a-time arrival. Any downstream consumer that reacts to newly
  stored messages by triggering on-device FM calls per-chat/per-message without
  routing through the existing `serializeFm` queue is a plausible repeat of the
  concurrent-FM-construction SIGSEGV already hit on a physical device (see
  CLAUDE.md). Restore must either suppress FM-triggering side effects during
  bulk import or explicitly throttle them through the serialize queue.
- **Pairing-code redemption needs explicit idempotency.** A dropped
  `redeemPairingCode` call under bad network followed by a client retry risks
  "code already consumed" on the retry even though the first call actually
  succeeded server-side — the code-consumption write must be atomic with full
  pairing success, not a naive two-step "mark consumed, then mint token."
  Mirrors the same class of lesson as the `joinGroupByInviteCode` fix, but
  needs its own explicit handling since the failure mode is different
  (false-negative rather than a hard permission-denied).
- **The obvious pairing design is meaningfully weaker than the WhatsApp
  comparison it would invoke, if not deliberately hardened.** A first-draft
  pairing flow gated only on "main device is foregrounded/unlocked" (no fresh
  biometric re-prompt, no mandatory notification to the main device, no
  always-visible linked-devices/revoke UI) would let someone with ~2 minutes of
  physical access to an unattended unlocked phone pair a malicious companion
  device silently and permanently. Locked decision #8 (QR + secondary
  confirmation + manual fallback) partially addresses this, but the full
  mitigation set (biometric gate before the pairing screen is even reachable,
  mandatory push notification to main on any new pairing, always-visible
  revoke UI, and a **hard** revoke that also calls `revokeRefreshTokens` on the
  companion's Firebase Auth session — not just deleting its device doc, which
  would leave an already-cached client session valid until natural token
  expiry) must all be built in, not treated as follow-up hardening.
- **iCloud quota exhaustion has no default UX.** CloudKit surfaces this as
  `CKError.quotaExceeded`, easy to swallow silently if not explicitly handled;
  a heavy user's first-ever (one-time, potentially years of history) backup
  burst is exactly the scenario most likely to hit it.
- **Companion backfill needs resumable checkpointing.** A companion's initial
  history sync dropping mid-stream (subway, elevator) with no per-chat cursor
  means either a silently incomplete history or a naive full-restart retry
  that reopens the "let RTDB accumulate" gotcha this feature otherwise
  correctly needs to avoid.

## 5. Roadmap

Nine phases, sequenced by dependency. Each phase's `risk_callouts` are open
items to close *within* that phase, not deferred — several were the specific
findings of the adversarial critique pass (`wf_fd4b3134-d5d`) and are
load-bearing, not decorative.

### Phase 0 — Foundations & registries — BUILT 2026-07-24 (branch `ui-revamp`)
**Goal**: shared scaffolding every later phase depends on, so nothing gets
built twice.
- ✅ Firestore-rules audit on the already-in-production `notificationDevices`
  collection, done first per §3.11. **Finding: no gap existed.** The
  collection already has `allow create, update, delete: if false` — every
  write already routes through Cloud Functions (Admin SDK, bypasses rules
  entirely; confirmed directly in `syncNotificationDeviceRecord`'s plain
  `docRef.set(payload, {merge:true})`). Adding a `role` field later needs
  zero rules changes, and since that write's payload never includes `role`,
  `merge:true` leaves an existing value untouched automatically — no code
  change needed there until Phase 1 actually sets the field.
- ✅ `users/{uid}/pairedDevices/{deviceId}` and `users/{uid}/signalPrekeys/{deviceId}`
  added to `firestore.rules` — both Cloud-Function-only
  (`create/update/delete: if false`), matching the `notificationDevices`
  pattern. `signalPrekeys` reads are `isSignedIn()` (any authenticated user,
  not just the owner) since another participant's device needs to fetch a
  prekey bundle to start a session — public key material only, by design.
- ✅ `users/{uid}/settings/{key}` also added (needed by the registry below,
  not explicitly named in the original phase list but required by it) — one
  flat doc per key, client-writable directly (`isSelf`), no Cloud Function
  needed since this is plain per-user preference data with no
  security-sensitive validation, same trust model as the `users/{userId}`
  doc itself.
- ✅ [`src/config/settingsSyncRegistry.ts`](../../src/config/settingsSyncRegistry.ts)
  (synced vs local, deliberately named to avoid colliding with the
  *pre-existing, unrelated* `src/constants/settingsRegistry.ts`, which is
  UI-search/deep-link metadata) + [`src/services/settingsSyncService.ts`](../../src/services/settingsSyncService.ts).
  Seeded with a representative slice (ring-per-device #13, Privacy Guard sync
  opt-in #12, backup frequency/cellular #16) — populating every existing
  per-user setting is still Phase 8's job.
- ✅ `BackupProvider` Swift protocol
  ([`modules/splitcircle-backup/ios/BackupProvider.swift`](../../modules/splitcircle-backup/ios/BackupProvider.swift))
  + TS-facing Expo module shell (`SplitCircleBackupModule.swift`, `src/`,
  `index.ts`) — built as a proper Expo module under `modules/splitcircle-backup/`
  (autolinked via this repo's `nativeModulesDir: "modules"` config), not a
  bare `ios/SplitCircleBackup/` folder, to reuse the same JS-callable-native-module
  wiring `modules/splitcircle-ai` already has working (podspec,
  `expo-module.config.json`, `requireOptionalNativeModule`) rather than the
  unrelated Widget-Extension-target pattern doc 19 uses. No CloudKit calls
  yet, as specified — every mutating function throws a clear
  "not implemented" exception (Phase 4's job) rather than faking success;
  `isHealthy()` is the one real exception, a cheap
  `FileManager.ubiquityIdentityToken` check (not a CloudKit API call) so the
  iCloud-unavailable banner (§3.6) has something real to read even before
  Phase 4 lands.
- ✅ [`localMessageStorage.ts`](../../src/services/localMessageStorage.ts) extended
  with `getLocalMessageStats(chatId?)` — per-chat count + latest `createdAt`,
  the local side of the `BackupManifest` reconciliation (§3.2/§3.7); the
  manifest itself is computed at backup-write time in Phase 4, never
  re-derived from this function later.
- **Verification done**: `npx tsc --noEmit` clean (exit 0). `firebase deploy
  --only firestore:rules --dry-run` confirms the rules file compiles
  successfully against the real project. **Verification NOT done**: no real
  Xcode/native build has run against the new Swift files yet (per CLAUDE.md's
  own "native changes are invisible to jsbundle hot-swap" gotcha, this can
  only be confirmed by an actual build, e.g. `npm run ship:ios` or a targeted
  `xcodebuild`/`pod install` pass) — do this before Phase 1 native work
  builds on top of it, don't assume a clean typecheck proves the Swift
  compiles.
- **Dependencies**: none — done first.
- **Risk carried into Phase 1**: `signalPrekeys`' Cloud-Function-only write
  restriction may need loosening for a device's own prekey rotation once the
  `deviceId` custom-auth-token claim exists (§3.4 point 5) — flagged in the
  rules file comment, not yet resolved.

### Phase 1 — Pairing infrastructure — BUILT 2026-07-24 (branch `ui-revamp`)
**Goal**: ship §3.4 in full — QR + manual fallback + secondary confirmation +
revoke UI + the "paired but not yet trusted" state machine.

**What shipped:**
- [`functions/src/pairing.ts`](../../functions/src/pairing.ts):
  `createPairingCode`, `redeemPairingCode`, `confirmPairing`, `revokeDevice`,
  wired as thin `onCall` wrappers in `functions/src/index.ts`, mirroring
  `groupJoin.ts`'s impl-file/thin-wrapper split. Unlike `groupJoin.ts`'s
  single-`.update()` precedent, `redeemPairingCode` uses a real
  `db.runTransaction()` (idempotent code-consumption check-and-set + the new
  device's `pairedDevices`/`notificationDevices` writes, all atomic) and
  `revokeDevice` uses a `db.batch()` for the atomic 3-doc delete — both
  genuinely new patterns for this codebase, not adaptations of existing code.
- `syncNotificationDeviceRecord` (`functions/src/notifications.ts`) now
  writes `role: 'main'` and a matching `pairedDevices` doc
  (`isMainDevice: true, pairingStatus: 'confirmed'`) the first time a device
  ever registers — this is how "before any pairing happens, there's just one
  device, and it's main" actually gets encoded; no separate onboarding step
  needed.
- Biometric re-auth (`src/services/biometrics.ts`, the exact
  `SettlementsScreen.tsx` pattern) gates `requestPairingCode` client-side
  before a pairing code is ever requested.
- Main device: [`LinkDeviceScreen.tsx`](../../src/screens/settings/LinkDeviceScreen.tsx)
  — QR (`react-native-qrcode-svg`, **new dependency**, peer-compatible with
  the installed `react-native-svg@15.15.3`) + 8-char manual code, live
  confirmation UI for any pending companion with its own comparison code.
- New device: [`ScanPairingCodeScreen.tsx`](../../src/screens/auth/ScanPairingCodeScreen.tsx)
  in the **Auth** stack (reachable from `SignInScreen` before the device is
  signed in at all — redeeming a code IS how it signs in, via the custom
  token `pairing.ts` mints). First live `expo-camera` `CameraView`/barcode-
  scanning usage anywhere in this codebase — no in-repo precedent existed to
  copy (confirmed by discovery: `expo-camera` was previously only used for
  permission checks).
- [`PendingPairingGate.tsx`](../../src/components/ui/PendingPairingGate.tsx),
  mounted at the `App.tsx` root next to `AppLockGate` — blocks the app behind
  a "waiting for confirmation" panel (showing the comparison code) whenever
  this device's own `pairedDevices` record is `pending_confirmation`. This
  exists because of a real navigation-structure constraint: the moment
  `signInWithCustomToken` succeeds, `user` goes truthy and `AppNavigator`
  unmounts the Auth stack (including `ScanPairingCodeScreen`) in favor of the
  App stack — the waiting UI can't live in the screen that redeemed the code,
  it has to live somewhere that survives the stack swap.
- [`LinkedDevicesScreen.tsx`](../../src/screens/settings/LinkedDevicesScreen.tsx)
  — lists `pairedDevices`, self-revoke always available, revoking a
  *different* device only offered when this device `isMainDevice`. Wired
  into `SettingsScreen.tsx`'s Security section + both settings registries
  (the UI-search one and the new sync-scope one — these are unrelated files
  that happen to share a naming pattern, see Phase 0's note).
- [`src/services/pairingService.ts`](../../src/services/pairingService.ts) —
  thin `httpsCallable` wrappers (mirrors `groupJoinService.ts`) + Firestore
  subscriptions for the two screens/gate above.

**Deliberate Phase 1 scope simplification (documented, not silently
shipped):** the "secondary out-of-band confirmation" code is a
server-generated random 6-digit number tied to the specific pairing
transaction, **not yet** a hash of both devices' Signal identity public keys
as §3.4 point 3 ultimately specifies — Signal identity keys don't exist until
Phase 3 publishes them to `signalPrekeys`. It still catches "wrong pairing
session" confusion (a photographed/intercepted QR redeemed in a different
session shows a different code) but doesn't yet cryptographically bind to a
persistent device identity. Phase 3 must upgrade the derivation without
changing the pairing flow's API shape (see `pairing.ts`'s header comment).

**`deviceId` custom-claim rules enforcement — built narrower than §3.4 point
5 originally specified, for a concrete, documented reason:** the claim itself
is minted correctly (`getAuth().createCustomToken(uid, {deviceId})`), and a
new `hasLiveDeviceSession()` Firestore rules function checks it — but it is
**deliberately NOT folded into `isSignedIn()`/`isSelf()`**, and therefore
does **NOT** yet gate `chats`, `messages`, `groups`, `expenses`, or
`recurringBills`. Reason: this file's own existing comment on
`groups/{groupId}`'s read rule documents that Firestore denies **list**
queries outright the moment *any* `get()`/`exists()` appears in an
applicable rule, regardless of what it's checking — and this repo has no
Firestore-emulator rules test harness to safely verify a change of that
scope. `hasLiveDeviceSession()` is applied only to three collections
confirmed (by grepping the client) to be single-document access only:
`users/{userId}`, `notificationDevices` (read), `settings`. **This means a
revoked companion device's cached session can still read/write chats,
messages, groups, and expenses until its Firebase ID token naturally
expires/refreshes (~hourly)** — `revokeDevice` immediately removes the
device from the paired-devices list, stops it receiving future pushes, and
prevents it from redeeming a new pairing code, but is not yet a full
instant kill switch for in-flight sessions on the sensitive collections.
Extending `hasLiveDeviceSession()` to those needs its own Firebase-emulator-
verified pass — **carried forward as an explicit open risk, not resolved
here.**
- RTDB `deviceId`-claim rules (the other half of §3.4 point 5) are **not
  built yet** — deferred to Phase 2, where the `messageQueue` path shape
  actually changes to include `deviceId`; there's no per-device RTDB path to
  gate until then.

**4-device-cap UX for a rejected 5th pairing attempt**: resolved as a hard
block (`redeemPairingCode` throws `resource-exhausted`) for Phase 1, per
decision #21's stated base cap — the paywall/subscription idea for more
devices is explicitly a later monetization feature, not required to close
this phase.

**Verification done**: `npx tsc --noEmit` clean for both the app and
`functions/` (exit 0 each); `firebase deploy --only firestore:rules
--dry-run` compiles successfully against the real project.
**Verification NOT done**: no simulator or device build has exercised this
flow end-to-end (QR scan → redeem → confirm → linked-devices list → revoke)
— per this repo's own native-change/hot-swap gotcha and the general lesson
that a clean typecheck proves nothing about runtime correctness, treat the
whole pairing flow as unverified-by-a-real-run until it is. In particular:
`CameraView`'s `barcodeScannerSettings`/`onBarcodeScanned` prop shape was
written from general `expo-camera` API knowledge, not confirmed against this
specific installed SDK version (`~55.0.9`) by a real build.

- **Dependencies**: Phase 0.
- **Risks carried forward into later phases**: full `chats`/`messages`/
  `groups` hard-revocation enforcement (needs an emulator-verified pass);
  RTDB `deviceId` rules (Phase 2); confirmation-code cryptographic upgrade
  (Phase 3); a "report this device lost/stolen without needing another
  trusted device" flow (still only cooperative Settings-page revoke exists).

### Phase 2 — Per-device live sync (RTDB fan-out) — BUILT 2026-07-24 (branch `ui-revamp`)
**Goal**: messages and call "answered elsewhere" reach every paired device
independently, phone-relay-free.

**A real design change from what this section originally said, made before
writing any code** (verified via a dedicated research/verify workflow):
`messageQueue` → `queueMessageToAllDevices` looping client-side over a
recipient's device list, as originally written here, is **not possible** —
`firestore.rules` only grants `isSelf(userId)` read access to `pairedDevices`,
so a sender's client can never enumerate a *different* user's devices to fan
a message out to them. This is the exact same Firestore query-provability
wall CLAUDE.md already documents from the invite-code-join bug. The actual
design built:

- ✅ [`functions/src/messageFanout.ts`](../../functions/src/messageFanout.ts)
  — a new `fanOutQueuedMessage` RTDB trigger (`onValueCreated` on
  `/messageQueue/{recipientId}/{messageId}` — the first RTDB-to-RTDB trigger
  in this codebase; the only prior `onValueCreated` precedent,`onCallCreated`,
  only ever fans out to push, never writes back into RTDB). The **client's
  `queueMessage` in `messageQueueService.ts` is completely unchanged** —
  still one write per recipient, exactly as before. The trigger reads the
  recipient's *confirmed* `pairedDevices` via the Admin SDK (bypasses rules
  entirely, same pattern `collectVoipDevices`/`sendPushToUsers` already use
  for push fan-out), fans the payload out to
  `messageQueueDevices/{recipientId}/{deviceId}/{messageId}` for each one,
  and deletes the original relay node. If a recipient has zero confirmed
  devices, the legacy node is left untouched rather than dropping the
  message.
- ✅ `messageQueueService.ts` gained `listenForMessagesOnDevice(userId,
  deviceId, ...)`, sharing its body with the legacy `listenForMessages` via a
  new internal `attachQueueListener` helper. `ChatContext.tsx`'s singleton
  queue-listener effect now **dual-listens** on both the legacy per-user path
  and this device's fanned-out path simultaneously — a deliberate migration
  safety net (see the backfill fix below for why), not a permanent design;
  `saveMessageLocally` dedupes by message id, so a message the rare
  transition-window race delivers via both paths is a harmless re-save, not a
  duplicate.
- ✅ **Fixed a real backward-compatibility gap found while planning this
  phase**: Phase 1's "a device's first-ever registration becomes main"
  logic in `syncNotificationDeviceRecord` was gated on the
  `notificationDevices` doc being new — which is **never true** for any
  device that registered before Phase 0/1 shipped (their `notificationDevices`
  doc already existed). Every such existing, real device would have gotten
  zero `pairedDevices` row, meaning `fanOutQueuedMessage` would find no
  confirmed devices for them and (without the dual-listen fallback above)
  messages would have silently stopped delivering. Fixed by checking
  `pairedDevices` existence independently of `notificationDevices` — now ANY
  device without one gets backfilled as main on its next routine sync, not
  just a truly-first-ever device.
- ✅ **LiveKit per-device identity** (`identity: uid` → `` identity:
  `${uid}:${deviceId}` ``): `functions/src/index.ts`'s `generateLiveKitToken`,
  `LiveKitService.ts`'s `getToken`, and **both** of `useCallManager.ts`'s call
  sites (outgoing path *and* answering path — confirmed via the research pass
  to be two distinct call sites, not one; an earlier draft of this section
  would have fixed only one).
- ✅ **"Answered elsewhere"**: `session.answeredBy: deviceId` is now written
  inside the *existing* `joinCall` RTDB transaction (`callService.ts`, no
  separate write) on the branch that actually adds the participant, never on
  a no-op branch. A new `AnsweredElsewhereError` is thrown when this device's
  `joinCall` call finds a *different* device of the same account already won
  — closing a real gap the naive design would have shipped with: before this,
  that race silently no-op'd and the losing device would go on to request a
  LiveKit token and connect anyway, which the identity fix above would have
  turned into two live room participants for one callee instead of the
  pre-existing (accidentally safe) colliding-identity behavior. Only one
  `joinCall` call site exists in the whole codebase (confirmed by grep), so
  no other caller needed auditing. `nativeCallService.ts` gained
  `reportAnsweredElsewhere()`, using react-native-callkeep's
  `reportEndCallWithUUID(uuid, CONSTANTS.END_CALL_REASONS.ANSWERED_ELSEWHERE)`
  — verified directly against Apple's own `CXCallEndedReason` documentation
  and the callkeep package's actual source (not just its README) that
  `.answeredElsewhere` is correct for a still-ringing, never-locally-answered
  call, not only for ending an already-connected one. `CallContext.tsx`'s
  connected-status listener now checks `session.answeredBy` against this
  device's own id to choose between `reportAnsweredElsewhere` and the
  pre-existing plain `endCall`.
- ✅ `database.rules.json` gained a `messageQueueDevices` block (mirroring
  `messageQueue`'s field validators, client access delete-only — creation is
  Admin-SDK-only) with a `deviceId`-claim read check (`auth.token.deviceId ==
  null || auth.token.deviceId == $deviceId`, RTDB rules' own syntax — **not**
  Firestore rules' `'deviceId' in auth.token`, a real syntax difference
  between the two rules languages caught before it could fail silently), and
  an optional `answeredBy` string field on `calls/{callId}`.

**Verification done**: `npx tsc --noEmit` clean (app + functions);
`firebase deploy --only firestore:rules,database --dry-run` confirms both
rules files compile against the real project. **Verification NOT done**: no
simulator/device build has exercised message delivery or a real multi-device
call race — the CallKit `.answeredElsewhere` API was verified against Apple's
documentation and the callkeep source, not by actually triggering it on a
device.

- **Dependencies**: Phase 0 (device registry).
- **Risks carried forward, not resolved by this phase**:
  - Receipt-sync fan-out (cross-device read/delivered dedupe, #15) is
    explicitly out of scope here — still needs its own design pass.
  - The per-device ringing toggle (#13) is untouched — every paired device
    still receives `reportNewIncomingCall` unconditionally (required to keep
    the VoIP push privilege) and all devices ring simultaneously until the
    `answeredBy` transaction race resolves; needs real physical-device
    verification before it's addressed.
  - `messageQueueDevices`' `$deviceId` read-rule asymmetry (main device
    unrestricted across its own device subtrees, companion restricted to its
    own claim) is inert today only because the client always calls
    `listenForMessagesOnDevice` with its own resolved `deviceId` — verify no
    future code path ever passes an arbitrary `deviceId` before relying on
    this as a security boundary.
  - `fanOutQueuedMessage` adds one extra RTDB round-trip (client write →
    trigger fires → multi-path update) to message delivery latency versus
    the old direct single write — not measured against real-world targets.
  - Phase 3's E2E encryption will need to layer cleanly on top of this
    fan-out shape (plaintext payloads currently move through
    `messageQueueDevices`, same as `messageQueue` always has) — re-verify
    this design still fits once Phase 3's per-device Signal sessions land,
    rather than assuming it does.

### Phase 3 — E2E encryption core — GATES 1+2 PASSED 2026-07-25 (verified on device), CRYPTO LOGIC NOT YET BUILT
**Goal**: libsignal-backed per-device Signal sessions protecting message
content end-to-end, integrated into the Phase 2 send/receive path.

**Pre-implementation spike (research/verify workflow, per this phase's own
risk callout) completed 2026-07-25 — findings below change the plan
materially. Do not start writing crypto code from the bullet list that used
to be here without reading this first.**

**Good news, resolves the roadmap's original stated risk**: libsignal ships
an official CocoaPods podspec (`LibSignalClient.podspec` at the repo root of
`signalapp/libsignal`) — Signal's own README states the CocoaPods build is
"canonical," SPM is explicitly "not supported" for external consumption. This
repo's established `modules/<name>/ios/<Name>.podspec` +
`expo-module.config.json` + Swift `Module` class pattern (already proven
twice: `splitcircle-ai`, `splitcircle-backup`) can declare `s.dependency
'LibSignalClient', '0.99.1'` (pin exact — the podspec's `script_phases` fetch
a matching prebuilt archive from `build-artifacts.signal.org` by exact
version+checksum) directly, no SPM bridge or XCFramework vendoring needed. A
real precedent exists: the npm package `react-native-libsignal-client`'s
actual shipped podspec does exactly this (`s.dependency 'ExpoModulesCore'` +
`s.dependency 'LibSignalClient'` side by side), independently confirmed by
downloading and inspecting the real tarball, not just reading its docs.

**A real, previously-unflagged risk found instead** — *superseded: see the
Gates 1 & 2 entry below, which resolves this. libsignal's pod does NOT in fact
require dynamic linkage; it can be linked statically by putting
`libsignal_ffi.a` on the app target's link line. The original concern, and why
it looked mandatory, is preserved here for context.* libsignal's pod appears to
require `use_frameworks! :linkage => :dynamic` at the Podfile level. This repo
currently builds with **plain static linking** for every pod
(`ios.useFrameworks` is unset in `Podfile.properties.json`), New Architecture
on, React Native built from source
(`ios.buildReactNativeFromSource: true`), and **five hand-maintained native
patches** (`react-native+0.83.2.patch`, `react-native-callkeep+4.3.16.patch`,
`livekit+react-native-webrtc+137.0.2.patch`,
`react-navigation+bottom-tabs+7.10.1.patch`, `expo-sqlite+55.0.10.patch`) —
none of which have ever been built or tested under dynamic-framework
linkage. Flipping this is a **project-wide** switch, not scoped to the new
crypto module — it changes how RN core, every third-party pod, and both
existing `splitcircle-*` modules link. This is genuinely higher-risk than
libsignal's own API surface (which is fully verified against real source,
zero invented names) and was not evaluated by the original roadmap text.

**Verified real Swift API surface** (fetched and cross-checked directly
against `signalapp/libsignal`'s actual source, not summaries — safe to build
against): `IdentityKeyPair.generate()` for per-device identity;
**no registration-ID generator exists in the Swift bindings** (Java-only) —
must roll our own matching libsignal's own test-store pattern
(`UInt32.random(in: 0...0x3FFF)`); `PrivateKey.generate()` +
`KEMKeyPair.generate()` for prekeys (`PreKeyBundle`'s constructors always
require Kyber/post-quantum fields — there is no classic-X3DH-only path in
this version); **no `SessionBuilder` or `SessionCipher` classes exist** —
session establishment and encrypt/decrypt are free functions:
`processPreKeyBundle(...)` establishes a session, `signalEncrypt` sends,
receive-side dispatches on `CiphertextMessage.MessageType`
(`.whisper`→`signalDecrypt`, `.preKey`→`signalDecryptPreKey`,
`.senderKey`→`groupDecrypt`); groups use `processSenderKeyDistributionMessage`
+ `groupEncrypt`/`groupDecrypt`. Five store protocols to implement for real
(libsignal's own in-memory reference store is confirmed test-only):
`IdentityKeyStore`, `PreKeyStore`, `SignedPreKeyStore`, `KyberPreKeyStore`,
`SessionStore`, `SenderKeyStore`.

**A real protocol-design gap found, not previously specced**: libsignal's
`DeviceId` type is `Int8`-backed (effectively 1–127) and is what
`ProtocolAddress` uses to key sessions — this is **not** the same identifier
as this repo's existing UUID-string `deviceId`
(`getOrCreateInstallationId()`, used everywhere in `notificationDevices`/
`pairedDevices`/RTDB paths since Phase 0). Phase 3 needs a small-integer
device-id allocation scheme (e.g. a per-user monotonic counter minted at
pairing time) purely for libsignal's `ProtocolAddress`, stored alongside —
never replacing — the existing string `deviceId`. §3.4's pairing flow
(Phase 1) does not currently account for this and will need a small addition
when Phase 3 actually implements it.

- **Dependencies**: Phase 1 (device identities to build sessions against),
  Phase 2 (fan-out path to carry per-device ciphertext).
- **Gates 1 & 2 — RESOLVED 2026-07-25, but only after shipping one genuinely
  broken build to TestFlight. The whole arc is recorded here because every
  wrong turn was a *plausible* fix that produced a green build, and the only
  thing that ever caught them was inspecting the actual artifact.**

  **Wrong turn #1 — a false "Gate 1 PASSED".** Flipped `ios.useFrameworks` to
  `"dynamic"`, ran `pod install`, read CocoaPods' complaint about
  `Pods-SplitCircle` having statically-linked transitive dependencies
  (`ExpoModulesCore`, `ExpoModulesJSI`) as an informational warning, then ran
  a full Xcode build that succeeded (~1068s, zero errors) and logged the gate
  as passed. **That build success didn't mean what it looked like it meant.**
  A direct check of `ios/Pods/Pods.xcodeproj/project.pbxproj` later showed
  every pod still built as `com.apple.product-type.library.static`, with an
  mtime three days older than the session: `pod install` had been **exiting 1**
  all along via `TargetValidator#verify_no_static_framework_transitive_dependencies`
  (real source: `cocoapods-1.16.2/lib/cocoapods/installer/xcode/target_validator.rb:72-95`)
  — a hard failure that aborts *before* regenerating `Pods.xcodeproj` or
  `Podfile.lock`, so Xcode had silently rebuilt the stale, still-static
  project. Expo's documented escape hatch (`ios.forceStaticLinking`) did not
  fix it either. **Lesson, now a standing rule for this repo: never trust
  `pod install`'s exit code or a downstream build's success — grep the
  generated xcconfig/pbxproj for the setting you think you changed.**

  **Resolution of the linkage question: don't go dynamic at all.** The
  validator conflict is unavoidable here (Expo's modules set
  `static_framework = true` on themselves), so the project stays on
  `use_frameworks! :linkage => :static`. Two more discoveries followed from
  libsignal's own podspec (read directly, not assumed): it links its fetched
  Rust FFI archive via `pod_target_xcconfig => { OTHER_LDFLAGS =>
  $(LIBSIGNAL_FFI_LIB_TO_LINK) }` and ships an **empty**
  `user_target_xcconfig`. `OTHER_LDFLAGS` is a *linker* flag, and a static
  framework target is assembled by `libtool`/`ar` — which never invokes `ld`
  — so that flag was silently discarded and `libsignal_ffi.a` was linked by
  nothing. Hence hundreds of undefined `_signal_*` symbols at the app link.

  **Wrong turn #2 — the one that shipped broken (build 0.0.156).** Forced the
  `LibSignalClient` pod target's `MACH_O_TYPE` to `mh_dylib` in `post_install`
  so its own `OTHER_LDFLAGS` trick would run. This **linked, built, archived,
  and uploaded cleanly** — and crashed every launch. CocoaPods computes the
  app's `[CP] Embed Pods Frameworks` list at **install** time from each pod's
  *declared* build type (static), so a `post_install` `MACH_O_TYPE` flip
  yields a real dylib that is **never copied into `SplitCircle.app/Frameworks/`**.
  The app therefore linked against `@rpath/LibSignalClient.framework/
  LibSignalClient` that wasn't in the bundle → dyld failure at process start,
  before any JS ran. App Store Connect independently flagged the same defect
  as **ITMS-90863** ("links with libraries that aren't present in macOS").
  The evidence was already on disk and went unread: a bundle inspection during
  that session listed 10 embedded frameworks with LibSignalClient absent.
  **Lesson: for any pod switched to dynamic, verifying the link step is not
  enough — verify the framework is actually inside `.app/Frameworks/`.**

  **The actual fix (verified).** Keep every pod static and link
  `libsignal_ffi.a` from the **app target** — the only build step in the
  workspace that really runs `ld`:
  - `modules/splitcircle-crypto/ios/SplitCircleCrypto.podspec` gained a
    `user_target_xcconfig` (merged into the aggregate `Pods-SplitCircle.*
    .xcconfig`, i.e. it reaches the app target) **defining** the archive's
    location. `PROJECT_TEMP_DIR` is per-project, so the path is reconstructed
    as `$(PROJECT_TEMP_ROOT)/Pods.build/libsignal_ffi/target/
    $(CARGO_BUILD_TARGET)/release/libsignal_ffi.a`; the `CARGO_BUILD_TARGET`
    triples must be duplicated there too (they live in LibSignalClient's
    `pod_target_xcconfig` and aren't visible to the app target), and were
    checked against the real archive's contents
    (`{aarch64-apple-ios-sim,aarch64-apple-ios,x86_64-apple-ios}`).
  - **The link flag itself is deliberately NOT in that podspec.** Static
    archive linking is order-dependent (`ld` pulls only members resolving an
    already-undefined symbol, and does not re-scan), so the archive must come
    *after* `-framework "LibSignalClient"`. CocoaPods **sorts** the
    OTHER_LDFLAGS tokens it merges, and an `OTHER_LDFLAGS` set in the podspec
    landed *before* that `-framework` (confirmed in the generated
    `Pods-SplitCircle.release.xcconfig`) — which would have linked nothing and
    failed identically. The flag is applied in `ios/Podfile`'s `post_install`
    directly on the app target instead, where `$(inherited)` expands to the
    xcconfig's flags first and pins the archive last (Xcodeproj serializes it
    as an ordered array — verified in `SplitCircle.xcodeproj/project.pbxproj`).

  **What is actually verified** (simulator, single-arch, `DEBUG_INFORMATION_FORMAT=dwarf`
  — dSYM generation is what exhausted the Mac's disk twice, see below):
  `BUILD SUCCEEDED`; **826 `_signal_*` symbols defined (`T`) in the app binary
  and 0 undefined**; no `LibSignalClient.framework` in `.app/Frameworks/`
  (correct now — nothing for dyld to miss, nothing for ITMS-90863 to flag);
  app **installs and launches without crashing** (PID alive, `launchctl`
  status 0, no crash report, dev-launcher UI rendered). Only 826 of the
  archive's 10,826 available symbols were pulled, which is why plain-path
  linking was kept instead of `-force_load` (no whole-archive bloat).

- **Gate 2 — FULLY PASSED 2026-07-25 on a physical iPhone 17 Pro.** Beyond the
  linkage/launch evidence above, `IdentityKeyPair.generate()` was actually
  **executed on device arm64** (Release config, signed with Apple Development
  via `-allowProvisioningUpdates`, installed with `devicectl`). It returned a
  real 69-byte serialized keypair; the base64 head decodes to `0x0A 0x21 0x05…`
  — protobuf field 1 carrying a 33-byte key with libsignal's `0x05` Curve25519
  type prefix, i.e. genuine output, not a stub. Entry and completion were logged
  separately so a hang inside the Rust FFI would have been distinguishable from
  never being called; both fired in the same millisecond. The temporary probes
  (an `index.ts` startup call + `NSLog`s in the Swift module) were reverted
  immediately after — `spikeGenerateIdentityKeyPair` is back to being uncalled
  dead code, kept only as the executable proof.
- **Two device-verification gotchas worth reusing** (both cost a build cycle
  here): (1) a Release build's JS **`console.error` does NOT reach the device
  log** — the JS probe produced nothing while native `NSLog` from the same code
  path appeared immediately, so instrument Release-on-device from native, not
  JS; (2) `xcrun devicectl` has **no `console` subcommand** and `log stream` has
  no `--device-name` on this toolchain — the working capture is
  `devicectl device process launch --console`, which streams stdout/stderr only.
  A local device build also needs `-allowProvisioningUpdates`: the automatic
  profile initially lacked this device, Sign In with Apple, and the PCC
  entitlement, and failed signing outright without it.
- **Environment hazard hit repeatedly, worth knowing before any future iOS
  build here**: this Mac ran to **0 bytes free twice**, hard enough that even
  `df`/`rm`/`true` failed with `ENOSPC` (the tool harness can't write its own
  output file). Both times the proximate cause was `GenerateDSYMFile`
  (`dsymutil` → `LLVM ERROR: IO failure on output stream`). Cleaning ~14GB of
  accumulated `DerivedData` recovered it once, but a single full clean build
  re-consumed it, so the headroom problem is real and not just leftover
  artifacts. For verification builds prefer
  `-derivedDataPath` in a scratch dir + `DEBUG_INFORMATION_FORMAT=dwarf` +
  `ONLY_ACTIVE_ARCH=YES`.
- **What remains genuinely unverified without a physical-device build**:
  whether libsignal's Rust-FFI core is safe to call concurrently from this RN
  bridge or needs the same `serializeFm`-style single-flight discipline
  Foundation Models already required (§3.10 gotcha #5 extends here); whether
  the device (`aarch64-apple-ios`) slice links as cleanly as the simulator one
  did — the ship build exercises this, but a device *run* has not; whether the
  CDN fetch of the 153MB prebuilt archive is reliable in a headless CI build;
  release-build binary size impact once the archive is linked into a stripped
  Release slice.
- **Crypto core BUILT 2026-07-25 (commit `68b05af`), round-trip verified.**
  `modules/splitcircle-crypto/ios/` now holds the real engine: `SignalStorage`
  (Keychain for the device secret + a file-per-record blob store, since a Signal
  session is rewritten on every message; not SQLite, per CLAUDE.md's
  libsqlite3/expo-sqlite linker caution), `SignalProtocolStores` (all six
  libsignal protocols, signatures read from the vendored source rather than
  guessed), `SignalSessionEngine` (identity bootstrap, prekey bundle export,
  session establishment, encrypt/decrypt), and a JS bridge that serializes every
  call on one queue — concurrent ops on one session corrupt the ratchet, the
  same failure class as CLAUDE.md's `serializeFm` gotcha. Private keys never
  cross the bridge.
  **Verified** (simulator, Release) by a two-party round trip against
  libsignal's own `InMemorySignalProtocolStore` as a synthetic peer:
  `outboundOK=true` (type 3 PreKey handshake decrypted by the peer),
  `inboundOK=true` (type 2 Whisper reply decrypted by our persistent store),
  `sessionPersisted=true`. The inbound leg is the one that matters — it only
  decrypts if our store really persisted the session the handshake produced.
- **Key-distribution wiring BUILT + deployed 2026-07-25 (commit `7224079`).**
  `functions/src/signalKeys.ts` adds two deployed callables, and
  `src/services/signalCryptoService.ts` orchestrates them from the client
  (invoked from `NotificationContext` immediately after device registration,
  because publishing requires the confirmed `pairedDevices` row that
  registration creates).
  - `publishSignalPrekeys` — must be server-side: `signalPrekeys` is
    client-READ (peers need public bundles) but write-denied, since a direct
    client write would let an attacker publish their own identity key under
    someone else's device and become that device's endpoint. Rejects
    non-`confirmed` devices, so a device awaiting approval cannot become
    addressable and quietly sidestep `PendingPairingGate`.
  - **Small-integer libsignal device id is allocated here**, transactionally,
    on first publish — resolving the protocol-design gap flagged above. One
    place mints it, so both pairing paths converge without either knowing about
    libsignal; the transaction prevents two devices receiving the same id,
    which would make them share a `ProtocolAddress` and cross-decrypt.
  - `claimSignalPreKey` — atomic pop of one one-time prekey. Concurrent senders
    must not receive the same key (reuse destroys the forward secrecy that key
    exists for). Uses a whole-array replace, NOT a merge: CLAUDE.md's
    reaction-removal gotcha means a merged write cannot shrink the array and
    would hand the same key out twice. Exhaustion is not an error —
    `PreKeyBundle` has a signed-prekey-only form, and failing would make a
    popular device undeliverable.
  - `listSignalDevices` reads `signalPrekeys`, not `pairedDevices`: it is the
    only cross-user-readable collection, and its rule doesn't depend on
    document contents, so a LIST query is provable and dodges the Firestore
    query-provability wall that forced group joining server-side.

  **Verified on a physical iPhone 17 Pro** (Cloud Function log, real
  authenticated call): `publishSignalPrekeys: published, oneTimeCount: 100,
  signalDeviceId: 1` — the full chain (native identity bootstrap → prekey
  generation → server allocation → Firestore write) works on device.
  **NOT verified: allocation of a SECOND device id.** The 13 mini was running
  but never published in the observation window — most likely not signed in on
  that handset. So the transactional no-collision path (device 2 getting id 2)
  is still untested against real concurrency; test it before trusting the
  allocator.

- **Message path WIRED 2026-07-25 (commit `e15a7d1`, fan-out redeployed).**
  `src/services/messageEnvelope.ts` bundles the fields §3.3 scopes as private
  (content, the `replyTo` snippet quoting it, `location`) into one JSON payload
  and encrypts it once per recipient device; `queueMessage` attaches the
  resulting `{ deviceId -> envelope }` map plus the sender's libsignal device
  id (which the receiver needs to name the session it decrypts against).
  `fanOutQueuedMessage` hands each device ONLY its own envelope and strips the
  map — forwarding it whole would give every device every other device's
  ciphertext. `attachQueueListener` decrypts before processing, so everything
  downstream is untouched.
  - **ALL-OR-NOTHING per message**: if any one recipient device can't be
    encrypted for, the whole message goes plaintext. Partial coverage would
    silently lose the message on the uncovered device. This is explicitly a
    ROLLOUT measure — an attacker able to suppress key publication can force
    plaintext — and MUST be removed once every client publishes keys.
  - A failed decrypt falls back to whatever plaintext the payload carried
    rather than dropping the message: a peer that reinstalled has a new
    identity, so dead sessions are normal and must not look like message loss.
  - No RTDB rules change was needed: `messageQueue` has no `$other` deny so the
    new fields validate, and blanking `content` to `''` still satisfies the
    existing `hasChildren(['content', …])` check.

  **NOT verified at runtime**: an encrypted message actually round-tripping
  between two devices. That needs both handsets signed in and publishing keys,
  which has not happened yet (only the 17 Pro has published). Until that test
  runs, treat the message path as built-but-unproven — the crypto engine itself
  is round-trip verified, but the transport wiring around it is not.

- **Sender's own-device fan-out WIRED 2026-07-25 (commit `bf3e6d1`).**
  `queueMessageToOwnDevices` mirrors a sent message to the user's other
  devices, carrying `originDeviceId`; `fanOutQueuedMessage` skips that device
  (it already has the message, and could not decrypt a ciphertext addressed to
  a session it doesn't hold). Called once per message in `ChatContext`,
  deliberately OUTSIDE the per-recipient loop — inside it, a group chat would
  mirror the same message to our own devices once per participant. Encryption
  excludes the origin device because a device cannot hold a Signal session with
  its own identity. When no other device of ours has keys, the mirror is
  skipped entirely rather than sent plaintext: putting our own content in
  transit buys nothing when no device is waiting to read it.
- **Race fixed that also affected ORDINARY recipient delivery**, found while
  building the above: the legacy dual-listen subscription (§5 Phase 2) watches
  the same shared relay node `fanOutQueuedMessage` consumes, so it could pick
  up an encrypted message BEFORE fan-out split it per-device — `content`
  blanked, per-device `envelope` not yet present — and save it with EMPTY
  content, blanking a message that was about to arrive correctly. The listener
  now skips any payload still carrying an `envelopes` MAP, which is exactly the
  un-fanned-out relay node (a delivered payload has a singular `envelope` and
  no map). Plaintext messages are unaffected, so the legacy fallback for
  recipients with no confirmed devices still works.

  **Still to wire before Phase 3 closes**: prekey replenishment triggering, and
  §3.4's pairing flow recording the libsignal device id. Group (sender-key)
  messaging deliberately throws rather than being half-built. Message STATUS
  for a self-synced message is also unresolved — a mirrored message arrives on
  the other device with no delivery/read state attached.
- Other risks carried from the original plan, still unresolved: no hot-swap
  iteration during this phase (§3.10 gotcha #6); Sender Key rekey volume
  against the RTDB reaper (§3.10 gotcha #8) — re-validate reaper batch sizing
  before shipping group E2E.

### Phase 4 — CloudKit backup engine — ENGINE BUILT + ROUND-TRIP VERIFIED 2026-07-25

**Status**: the storage engine, passphrase layer and export/import orchestration
are built and verified end-to-end against real iCloud on a physical iPhone 17
Pro. What remains is the USER-FACING half: passphrase enrollment UX (§3.5),
scheduling (§3.6, Phase 5), media/`CKAsset` and call-history record types, and
the retirement gate that consumes the manifest (§3.7, Phase 7).

**Provisioning gate, resolved 2026-07-25.** The App ID had iCloud ticked but
ZERO containers, so the provisioning profile carried
`icloud-container-identifiers` as an EMPTY array and every CloudKit call would
have failed at runtime. Registered `iCloud.com.splitcircle.app` ("SplitCircle
Backup"), assigned it to the App ID, THEN added the entitlement — that order
matters, per the rule the App Group note in `SplitCircle.entitlements` already
states. Verified by `codesign -d --entitlements` on the built app, not just by
the file. Enabling the capability invalidated existing provisioning profiles;
EAS regenerates on the next `ship:ios`.

**Verified on device** (temporary probe, since reverted):
```
HEALTH    available=true
EXPORT    ok  chats=10 msgs=153 ms=7293
IMPORT    ok  restored=153 missing=0
WRONGPASS ok: rejected as expected
```
153 messages out, 153 back, zero missing, and a wrong passphrase fails cleanly.

**The bug the round trip caught — the reason it was worth running.** Export
worked on the first try; import failed instantly with "the passphrase is wrong
or the data is corrupt" against a backup written seconds earlier under the same
passphrase. `importBackup` opened a session with the passphrase but no salt,
minting a FRESH random salt and a key that decrypted nothing. The salt lives
inside the backup, so a restore cannot know it up front — and reading the backup
needs the key, which needs the salt. `backupService`'s own comment asserted the
native layer extracted the salt from the envelope; `extractSalt` existed but was
never called, so the mechanism the comment described simply did not exist.
`unwrap` now re-derives from the envelope's salt/iterations, which is what makes
the format genuinely self-describing. **A doc comment describing a mechanism is
not evidence the mechanism is wired — this one read as correct for two
commits.**

**KDF caveat, unresolved by design.** §3.5 specifies "Argon2id, PBKDF2
fallback"; what shipped is the PBKDF2 fallback (600k iterations, OWASP's floor),
because Argon2id is absent from CryptoKit and libsignal's Swift bindings expose
only HKDF, so adopting it means a new native dependency. Argon2id is memory-hard
and materially better against offline GPU cracking of a backup passphrase —
exactly this threat model. The envelope reserves `kdf = 2` so it can be adopted
without stranding existing backups. **Decide this before backups ship to
users.**

**Left in the test account's iCloud**: the probe wrote a real backup under a
throwaway passphrase. Record ids are stable (`manifest-current`,
`msg-<chatId>-<n>`), so the first genuine backup overwrites it.

#### Original plan (still accurate for the remaining work)
**Goal**: main-device-only bulk export to CloudKit, provider-agnostic,
passphrase + `encryptedValues` protected.
- `CloudKitBackupProvider.swift` via raw `CKModifyRecordsOperation`/
  `CKFetchRecordZoneChangesOperation`.
- Chunked message/media/call-history `CKRecord` schema + incrementally
  maintained `BackupManifest`.
- Passphrase-derived (Argon2id, PBKDF2 fallback) client-side encryption layer
  wrapping `encryptedValues`, with full enrollment UX (§3.5): strength check,
  "confirm you've written this down," the explicit forgot-passphrase-means-
  permanent-loss sentence at creation time, AEAD clean-failure on wrong
  passphrase.
- `serializeFm`-gated bulk export (§3.10 gotcha #7 — symmetric with Phase 6's
  restore-side guard, not a restore-only concern).
- iCloud health check (`isHealthy()`) + graceful-degradation signaling to the
  UI layer.
- **Dependencies**: Phase 0 (`BackupProvider` shell), Phase 3 (backup records
  store already-Signal-decrypted-then-re-encrypted content, so the crypto core
  must exist first).
- **Risks**: Argon2id native integration cost is unknown for a one-shot
  build — decide the PBKDF2 fallback threshold early. CloudKit
  quota-exceeded UX needs its own small design task inside this phase, not an
  afterthought.

### Phase 5 — Backup scheduling & UX
**Goal**: automatic + manual backup triggers respecting real BGTaskScheduler
constraints, with fully honest uncertainty messaging.
- `BGProcessingTaskRequest` scheduled task + `NWPathMonitor` cellular
  self-enforcement.
- `BGContinuedProcessingTask` manual "Back Up Now" path with Live Activity
  progress.
- New `BackupSettingsScreen`: frequency picker, cellular toggle, last-backup
  display, risk banner, iCloud-unavailable banner.
- `users/{uid}/backupSettings` synced Firestore doc.
- **Dependencies**: Phase 4 (an actual backup engine to schedule/trigger).
- **Risk**: none beyond what's already specified in §3.6 — mostly integration,
  not new invention.

### Phase 6 — History handoff for new devices
**Goal**: a freshly paired device gets the bounded 90-day window instead of
zero history.
- Ephemeral-key-based `HistoryHandoff` CKRecord protocol (Signal Synchronized
  Start-style).
- Main-device bundling/re-encryption of last-90-days plaintext at pairing
  completion.
- New-device consumption + decrypt-and-import into its own local store, with
  **resumable checkpointing** — a chunked handoff interrupted mid-transfer
  (subway, elevator) must not silently produce an incomplete window or force a
  full-restart retry that reopens the RTDB-accumulation gotcha.
- `serializeFm`-gated bulk import (§3.10 gotcha #7).
- **Dependencies**: Phase 1 (pairing channel/ephemeral key), Phase 3 (Signal
  sessions to build the fresh one-time key against), Phase 4 (CloudKit as
  transport).
- **Risk**: the bulk-import Foundation-Models SIGSEGV risk is real and
  specific to this phase — must be explicitly gated, not assumed safe by
  inheritance from Phase 4's general import path.

### Phase 7 — Device retirement/promotion safety gate
**Goal**: ship §3.7 in full — the single most product-critical new UI/UX in
this build.
- `BackupManifest`-based count+timestamp reconciliation.
- `RetirementAttestation`/`RestoreVerified` two-device handshake records, with
  the restore side performing **real decryption verification**, not
  metadata-only comparison (closes the gameability gap — §3.7 point 3).
- `DeviceRetirementScreen` with disabled-by-default retire/promote action,
  forced pair-new-device-first flow for single-device migration (§3.7 point
  4), not an equal-looking self-check alternative.
- "Remove this device" guard modal with the effortful confirmation-phrase
  escape hatch.
- iCloud-unavailable honest failure state on this screen specifically.
- **Dependencies**: Phase 4 (`BackupManifest` exists), Phase 6 (restore path
  exists to verify against).
- **Risk**: this is the phase where a subtle bug directly causes irreversible
  user data loss — budget for a dedicated adversarial review pass before ship,
  mirroring the six-bugs-found pattern from doc 28's account-deletion review.

### Phase 8 — Settings sync, Privacy Guard override UX, recovery bootstrap, and ship
**Goal**: close out §3.8, wire Privacy Guard's per-device-default-with-override,
ship the §3.12 "lost every device" recovery flow, and ship to all users per
decision #22 (no feature flag).
- Populate `settingsRegistry.ts` for every existing per-user setting,
  defaulting conservatively (local unless there's a clear reason to sync).
- Privacy Guard sync-override explainer sheet + synced-state plumbing.
- **New-main-device recovery flow independent of any existing device** (§3.12)
  — Firebase Auth + backup passphrase alone restores as a new main device.
  Confirm this design with the product owner before building (§3.12) —
  treat as blocked, not just risky, until confirmed.
- Full adversarial review pass across pairing, revocation, retirement gate,
  and the Phase 0 `notificationDevices` rules audit.
- CLAUDE.md Architecture DNA amendment (§3.10) + new gotchas committed
  alongside the code, not after.
- **Dependencies**: all prior phases functionally complete.
- **Risk**: shipping to all users with no flag (#22) means Phase 7's gate bugs
  are immediately user-facing at full scale — do not compress the adversarial
  review to hit a ship date.

## 5b. Bugs found by the first real two-device test (2026-07-25)

Two physical iPhones signed into one account exposed a cluster of defects that
every prior check had missed. Recorded because the pattern matters more than
the individual fixes: **`tsc` clean + tests green + "Phase N built" said nothing
about whether any of it was reachable, or even present, in production.**

1. **The entire pairing backend was never deployed.** `createPairingCode`,
   `redeemPairingCode`, `revokeDevice` (Phase 1) and `fanOutQueuedMessage`
   (Phase 2) existed in `functions/src/`, passed typecheck, were committed and
   documented as "BUILT" — and had **never been pushed to Firebase**.
   `firebase functions:list` showed 22 deployed functions, none of them these.
   So the QR flow could not have worked for anyone: the client called a
   callable that did not exist. Phase 2's per-device message fan-out was
   likewise inert. **"Built" in this doc has meant "code exists and
   typechecks"; it has NOT meant deployed. Check `functions:list` against
   `functions/src/index.ts`'s exports before believing any server-side phase is
   live.**

2. **Every new device auto-promoted itself to confirmed main.**
   `syncNotificationDeviceRecord` wrote `isMainDevice: true, pairingStatus:
   "confirmed"` for any device without a `pairedDevices` row. That was Phase
   2's backward-compat backfill for pre-Phase-0/1 devices, but it applied to
   brand-new devices too — so a second phone signing in with plain
   email+password became a confirmed main device. Pairing was bypassed,
   `PendingPairingGate` never fired (nothing was ever `pending_confirmation`,
   which is why no QR/confirmation UI ever appeared), and the 4-device cap —
   enforced only inside `redeemPairingCode` — never applied. Fixed by gating
   the backfill on "does this user have ZERO devices", which preserves the
   migration path exactly (those users have no rows) while closing the bypass.
   Additional devices are now written `pending_confirmation` + `selfRegistered`.

3. **`PendingPairingGate` signed brand-new devices straight back out.** It read
   `ownRecord === null` as denied/revoked, but on a fresh sign-in the row does
   not exist yet — it is created asynchronously — so the subscription's first
   emission is legitimately null. Latent before; fix #2 would have made it fire
   on every new device. Now only a null that FOLLOWS a seen record counts.

4. **No way to approve a self-registered device.** `confirmPairing` was
   reachable only from the QR flow, so a device that signed in directly would
   have sat blocked behind the gate forever. Linked devices now offers
   Approve/Deny on pending devices — never for your own device, since
   self-approval defeats the gate.

5. **`confirmPairing` did not enforce the 4-device cap.** `redeemPairingCode`
   did, but a self-registered device never goes through redemption, so approval
   was a second path past the cap. Now enforced server-side.

Not retroactive: devices that already hold a main/confirmed row keep it. Two
devices that both became "main" under bug #2 stay that way until one is removed
and re-added.

## 6. Open risks carried forward (not yet fully closed by the design above)

- CallKit's mandatory-`reportNewIncomingCall` requirement vs. the per-device
  ringing toggle needs physical-device verification, not just code review.
- Per-device Firebase Auth session enforcement via custom claims is
  unprototyped — needs its own spike.
- Official libsignal Swift bindings are unverified specifically inside an
  RN-embedded native-module context in this codebase — spike before Phase 3.
- Argon2id native integration cost/PBKDF2 fallback threshold is undecided.
- CloudKit quota-exceeded UX is only partially addressed via the general
  iCloud-unavailable banner.
- Sender Key rekeying on group membership change has no implementation-level
  protocol detail yet.
- A stolen (not deliberately wiped) old main device has no "report lost/stolen,
  force-revoke without needing another trusted device" flow — only cooperative
  Settings-page revocation exists today (§3.7 point 6).
- 4-device-cap UX for a rejected 5th pairing attempt (hard block vs. paywall
  upsell) is undecided.
- **§3.12's recovery-bootstrap tradeoff needs explicit product-owner
  confirmation before Phase 8 builds it.**
