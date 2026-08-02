# 35 — Session code audit: findings and fix plan

**Status: Audit complete 2026-08-01. ALL FINDINGS FIXED 2026-08-01 (commits
65177f6, 30f6c7c, 0822fe8, 37939fc, 57e42e9, 902abb8, 3d4c338) — except the two
items below, and with two findings corrected as wrong. NOTHING IS
HARDWARE-VERIFIED; see "What is still owed" at the end.** Covers the 30-commit,
~7300-line mesh/sync session (doc 33 Phases 0/1/3/4/5/7/8, doc 34 steps 1/2/4,
plus the offline-UI bug-fix batch).

Produced by a 9-dimension adversarial review (BLE native, LAN native, mesh JS
core, router/crypto security, chat send path, RTDB rules & build config, UI
rendering, test-suite fidelity, cross-pattern recurrence search), followed by
independent verification. The three highest-severity findings were personally
re-derived from primary source by reading the exact cited lines myself — not
just accepted from the reviewing pass — and are marked **PERSONALLY VERIFIED**
below. Everything else is reported as found, with exact file/line/evidence so
it can be re-checked in seconds.

---

## Summary

**3 critical, 11 high, 9 medium, 3 low** findings survived review. The single
most important thing to internalize: **BLE and LAN have not merely "never been
tested on hardware" — on Android, the code path that would start them is
unreachable, and even if it were reached, a separate arithmetic bug zeroes
BLE's payload capacity to zero.** Every BLE/LAN fix landed this session
(permission requests, GATT handshakes, framing) is correct in isolation and
still never executes from the app's real entry point on Android. This is not
a hardware-verification gap — it is a code defect, confirmed by reading, not
by inference.

The second theme: **the `undecryptable` MessageStatus value added this session
is invisible in the most common case** — a chat-list re-render fingerprint
folds it into the same bucket as `sending`, so the UI this session built
specifically to surface "arrived but couldn't be opened" never updates for a
single in-flight message. Two other UI surfaces (`AlbumBubble`, action-sheet
preview) never learned about the new status at all.

---

## Critical

### BLE (and LAN) never start on Android — gated on an iOS-only availability check
- **File:** src/services/nearbyMessageService.ts:395-398
- **Dimension:** ble-native — **PERSONALLY VERIFIED** by reading the exact code path
- **Problem:** `startNearbyMessaging()` — the sole caller of `bleTransport.start()`,
  `lanTransport.start()`, and `mpcTransport.start()` — returns immediately if
  `!isNearbyMeshAvailable()`. That function
  (`modules/splitcircle-mesh/index.ts:113-118`) is defined as
  `Platform.OS === 'ios' ? requireOptionalNativeModule('SplitCircleMesh') : null`
  then `nativeModule !== null` — so on **every** Android device it is
  unconditionally `false`, regardless of `EXPO_PUBLIC_ENABLE_BLE_MESH`,
  `EXPO_PUBLIC_ENABLE_LAN_MESH`, or anything the user toggles in Settings.
- **Failure scenario:** On Android, `startNearbyMessaging()` returns at line
  397, before `loadTransportPreferences()`, `getCurrentDeviceId()`, or any
  transport's `.start()` is ever reached. The carefully-built Android runtime
  permission request (`ensureAndroidBlePermissions`), the GATT handshake, the
  NSD/TCP LAN stack — none of it has ever run from the app's actual startup
  path on the one platform BLE/LAN exist for (doc 33 §0: "MultipeerConnectivity
  cannot reach Android at all").
- **Why the diagnostics screen looked fine anyway:** `getMeshDiagnostics()`'s
  `transport.isAvailable()` (nearbyMessageService.ts:297) reports pure hardware
  capability — Bluetooth adapter present and enabled — completely independent
  of whether `.start()` was ever called. I confirmed this directly in
  `SplitCircleBleModule.kt`'s `isAvailable()`: it checks only
  `bluetoothAdapter != null && bluetoothAdapter.isEnabled && ...`. So "Bluetooth:
  available, 0 connected" was truthful about hardware and silent about the
  service never having started scanning or advertising at all. My own earlier
  claim in this session that BLE was "alive on a radio for the first time" was
  wrong — verified now, in writing, so it isn't repeated.
- **Verification:** Read `nearbyMessageService.ts:390-410` and
  `modules/splitcircle-mesh/index.ts:108-119` directly. No ambiguity — this is
  not an inference, it's the literal control flow.

### maxPayloadFor zeroes BLE's payload capacity to 0, independent of the bug above
- **File:** src/services/mesh/transport.ts:101-107
- **Dimension:** mesh-js-core — **PERSONALLY VERIFIED** by arithmetic on the actual constants
- **Problem:** `maxPayloadFor(transport, payloadClass)` computes
  `Math.max(0, transport.mtu - ROUTER_HEADER_BYTES)`. `ROUTER_HEADER_BYTES = 54`
  (transport.ts:93). BLE's advertised `mtu` is
  `DEFAULT_ATT_MTU(23) - ATT_OVERHEAD(3) = 20` (bleTransport.ts:97). So for BLE,
  every call computes `Math.max(0, 20 - 54) = 0`.
- **Failure scenario:** `transportSwitch.ts`'s `capableOf()` (line 87-91)
  requires `size <= cap`; with `cap = 0`, only a literally empty payload
  passes. `routesFor()` (line 63-79) has the same gate. `sendRawToTransports`
  in `nearbyMessageService.ts` — confirmed as the **sole** path that calls
  `transport.send()`, used both directly (line 187, router off) and via the
  router's own `send` callback (line 165, router on) — always goes through
  `transports.capableOf(...)` first. There is no bypass. **Even with the
  critical bug above fixed and BLE genuinely running on real hardware with a
  successfully negotiated large per-peer ATT MTU, this static, pessimistic
  gate excludes it from carrying a single byte.** BLE, "the universal floor"
  and the only transport that reaches Android, is dead code from the switch's
  perspective by construction.
- **Verification:** Read `transport.ts:93-107`, `bleTransport.ts:97`,
  `transportSwitch.ts:63-91`, and `nearbyMessageService.ts:128-139,165,187`
  directly and traced every call site — no bypass exists.

### LAN's Bonjour/NSD service type differs between platforms (trailing dot)
- **File:** modules/splitcircle-lan/ios/SplitCircleLanModule.swift:71 vs.
  modules/splitcircle-lan/android/.../SplitCircleLanModule.kt:41
- **Dimension:** lan-native — high confidence, corroborated by documentation research, **not yet hardware-confirmable** (blocked on the first critical fix above)
- **Problem:** iOS: `private let serviceType = "_manasplit-mesh._tcp"` (no
  trailing dot). Android: `const val SERVICE_TYPE = "_manasplit-mesh._tcp."`
  (**with** a trailing dot).
- **Verification:** I checked this against real documentation rather than
  relying on recollection. Google's own official Android NSD guide and
  training samples consistently use the trailing-dot form (`"_http._tcp."`)
  as canonical. Apple's own Network.framework/Bonjour documentation and forum
  guidance consistently show the no-trailing-dot form (`"_waffle-varnish._tcp"`).
  Both platforms are following their own vendor's documented convention — the
  code is not obviously "wrong" by either platform's own standard, which is
  exactly what makes this dangerous: it looks correct in isolation on each
  platform.
- **Failure scenario:** If Android's NSD stack passes the trailing dot through
  literally into the on-wire mDNS query/advertisement (plausible — AOSP's
  `MdnsServiceTypeClient` splits the raw string on literal `.` characters with
  no dot-stripping normalization observed), the two platforms broadcast/browse
  for different literal service names and **never discover each other**,
  silently — no error, indistinguishable from "no peers nearby yet." This
  cannot be confirmed on real hardware until the first critical bug is fixed,
  since BLE/LAN never start on Android today regardless.
- **Recommended fix, regardless of the above uncertainty:** make the two
  literal strings byte-identical. There is zero cost to doing this and it
  eliminates the variable entirely rather than betting the whole transport on
  a platform-normalization detail neither vendor documents precisely enough to
  be certain about from documentation alone.

---

## High

### Nearby preference toggles (Settings) don't control the running transports
- **File:** src/services/nearbyMessageService.ts:390-511; src/services/mesh/transportPreferences.ts; src/screens/settings/NearbyMeshScreen.tsx:155-209
- **Dimension:** mesh-js-core **and** ui-rendering (found independently by both)
- **Problem:** `isTransportEnabled()`/`nearbyEnabled` from `transportPreferences.ts`
  is consulted in exactly one place — `transportSwitch.ts`'s `available()` —
  which only affects which transport is picked for a **new outbound send** or
  the topology view. `startNearbyMessaging()`'s calls to
  `mpcTransport.start()`/`lanTransport.start()`/`bleTransport.start()`, its
  frame/neighbour-change subscriptions, and its trust updates are all wired
  off `activeTransports` directly and never consult the preference at all.
- **Failure scenario:** A user opens Settings → Nearby mesh, flips the master
  "Nearby messaging" switch OFF — copy states "Master switch for every radio
  below" — or disables Bluetooth specifically. The radio keeps advertising,
  keeps scanning, keeps accepting inbound frames, and (with the router
  enabled) keeps **relaying other users' mesh traffic**, all while every row
  in Settings shows "Off." This directly contradicts both the UI's stated
  behavior and `transportPreferences.ts`'s own documented rationale ("which
  radios may this app use is theirs to answer, not something to infer").
- **Verification:** Confirmed by direct reading — `nearbyMessageService.ts`
  never imports `subscribeToTransportPreferences` or `nearbyEnabled`.

### A per-transport toggle can show "ON" on the same row that says "Unavailable"
- **File:** src/screens/settings/NearbyMeshScreen.tsx:181-209
- **Dimension:** ui-rendering
- **Problem:** The Switch's value is driven only by the stored preference
  (`!prefs.disabledTransports.includes(transport.id)`); the row's subtitle text
  is driven only by `transport.available` (real hardware/permission state).
  They are never reconciled.
- **Failure scenario:** User enables Bluetooth in Settings while the OS
  permission is actually denied (or hardware genuinely can't run it). The
  Switch renders ON while the same row's subtitle reads "Unavailable on this
  device" — two adjacent, contradictory signals on one row.

### BLE: a peer becomes sendable before it can attribute chunks back to us
- **File:** modules/splitcircle-ble/ios/SplitCircleBleModule.swift:442-465 (mirrored in the Kotlin half)
- **Dimension:** ble-native
- **Problem:** On the identity-read completing, `centralLinks[remoteId]` is set
  **immediately** — making the peer visible to `connectedPeers()`/`sendChunk()`
  — before this device has **written its own identity** to that peer.
  `emitPeers()` is correctly deferred until the announce-write succeeds, but
  native `connectedPeers()` doesn't gate on that — it reads the map directly.
- **Failure scenario:** If any **unrelated** `emitPeers()` fires during this
  window (a different peer C connecting/disconnecting — realistic with 2+
  nearby devices), the resulting neighbour-change snapshot already includes
  the half-announced peer B. `nearbyMessageService.ts`'s handler reacts by
  calling `sendChunk(B, ...)`. B's own identity map for our address is still
  empty, so B's write-handler drops the chunk via its "no identity yet"
  guard — while still **ACKing the GATT write with success**. Our
  `pendingWrites` promise resolves `true`, `bleTransport.ts` counts it
  delivered, the router never requeues it. The message is silently and
  permanently lost, reported as sent throughout the stack.

### Android BLE: a shared GATT-server characteristic write races across peers
- **File:** modules/splitcircle-ble/android/.../SplitCircleBleModule.kt:638-682
- **Dimension:** ble-native
- **Problem:** `sendChunk()`'s peripheral-role branch sets the single
  module-level `chunkCharacteristic.value` **inside** `synchronized(lock)`, but
  calls `notifyCharacteristicChanged` (which reads that same shared mutable
  value) **outside** the lock.
- **Failure scenario:** Two concurrent `sendChunk()` calls to two different
  peripheral-linked peers (routine: `broadcastQueuedNearbyMessages()` and
  `router.flush()` both fire un-awaited from the same neighbour-change event)
  can interleave: thread 2 overwrites the shared characteristic value between
  thread 1's set and thread 1's actual notify call. Peer X gets notified with
  peer Y's bytes. Silent cross-peer chunk corruption, reported successful.

### iOS LAN: Local Network permission denial is never detected
- **File:** modules/splitcircle-lan/ios/SplitCircleLanModule.swift:144-160
- **Dimension:** lan-native
- **Problem:** Neither `NWListener` nor `NWBrowser` has a `stateUpdateHandler`
  installed — only `newConnectionHandler`/`browseResultsChangedHandler`. Per
  Apple's documented behavior, a `.waiting`/`PolicyDenied` state is exactly how
  Local Network permission denial surfaces, and it's discarded entirely here.
- **Failure scenario:** User taps "Don't Allow" on the Local Network
  permission prompt. `isAvailable()` (driven by `NWPathMonitor`, interface
  state only) stays `true`. `start()`'s `do/catch` never throws for this
  case. The module reports fully healthy while silently discovering nobody
  and being discovered by nobody — forever, indistinguishable from "no peers
  nearby." The JS bridge's own comment ("iOS local-network permission denial
  arrives here") describes a catch path that can never fire for this
  condition — the same "doc-comment asserts an unwired mechanism" pattern
  CLAUDE.md already records three other times in this codebase.

### Android LAN: `closePeer` can close a brand-new healthy connection instead of the stale one it meant to clean up
- **File:** modules/splitcircle-lan/android/.../SplitCircleLanModule.kt:283-286
- **Dimension:** lan-native
- **Problem:** `closePeer(deviceId)` removes and closes whatever socket is
  **currently** mapped under that id, without checking it's the same socket
  instance the caller meant to clean up. iOS's equivalent `drop()` explicitly
  checks `peers[deviceId] === connection` first.
- **Failure scenario:** Peer X's app is killed without a clean FIN; our
  `handshake()` thread sits blocked in `readInt()` on the dead socket, still
  registered as the live peer. X reconnects with a new socket; the dedup
  logic closes the old one (unblocking the first thread) and writes the new
  socket into `peers`. If the first thread's own cleanup (`finally { closePeer(it) }`)
  runs **after** the second thread's write — an uncontrolled scheduling race —
  it closes the **new, healthy** socket by id, not the stale one. The live
  connection silently disappears until the next reconnect cycle.

### `handleSendLocation` reintroduces the exact double-submit bug already fixed for text/media
- **File:** src/screens/chat/ChatRoomScreen.tsx:1452-1463
- **Dimension:** chat-send-path
- **Problem:** `runSend(..., { key: \`chat-location-${thread.chatId}\` })` —
  constant per chat, not per send. This is the identical shape this session's
  commit already fixed for text and media, in the same file, with a comment
  documenting the fix directly above it.
- **Failure scenario:** `LocationPicker.tsx` fires `onSendLocation()`
  un-awaited and closes immediately. A second location send in the same chat
  while the first is still in flight (slow network) has its task **silently
  discarded** by `usePreventDoubleSubmit` — no bubble, no error, no trace.

### `AttachmentMenu`'s dedup key is global, not per-chat
- **File:** src/components/Chat/AttachmentMenu.tsx:600-628
- **Dimension:** chat-send-path
- **Problem:** `key: 'chat-attachment-selection'` — a literal, unparameterized
  string, shared across every mounted `AttachmentMenu` instance app-wide (the
  dedup map is module-level).
- **Failure scenario:** User picks a slow-materializing attachment (this app's
  own documented slow-iCloud-video path) in Chat A, navigates to Chat B (React
  Navigation keeps Chat A mounted underneath), and taps any attachment option
  there. Chat B's call matches Chat A's still-in-flight key and silently
  returns Chat A's pending promise — Chat B's picker never opens, with no
  spinner shown (state is per-hook-instance) to explain why.

### `progressOutlivesSend` is set from the wrong condition, stranding the send-progress ring
- **File:** src/context/ChatContext.tsx:1245-1353
- **Dimension:** chat-send-path
- **Problem:** `progressOutlivesSend = Boolean(nearbyAttachment)`, but
  `nearbyAttachment` is built unconditionally whenever `mediaUri` is present —
  independent of whether the nearby envelope build actually succeeded. It
  should be `Boolean(wireEnvelope && nearbyAttachment)`.
- **Failure scenario:** Offline media send with no established nearby session
  (the ordinary case with no paired device physically in range): the envelope
  build fails, the error is swallowed, `wireEnvelope` stays undefined, so
  `broadcastQueuedNearbyMessages()` never fires and the native transfer never
  starts. Nothing else ever calls `clearSendProgress` for this message.
  `progressOutlivesSend` is `true` anyway, so the `finally` skips clearing it.
  The send-progress ring shows "Uploading…" **permanently**, even after the
  message is later delivered fine via cloud relay.

### `AlbumBubble` and the action-sheet preview never learned about `undecryptable`
- **File:** src/components/AlbumBubble.tsx:382-397; src/components/Chat/MessageActionSheet.tsx:71-109
- **Dimension:** chat-send-path **and** ui-rendering (found independently by both)
- **Problem:** Both files maintain their own duplicated tick-rendering logic,
  separate from `MessageBubble.tsx`'s canonical `MessageStatusIndicator`.
  Neither has a branch for `'undecryptable'` (the action-sheet preview also
  has none for `'failed'`).
- **Failure scenario:** An album send, or a long-press preview, on a message
  whose status is `'undecryptable'` renders an ordinary checkmark/double-tick
  — visually identical to a normal successful send — hiding exactly the
  signal `MessageBubble.tsx`'s amber icon exists to surface for single
  messages.

### The chat-list re-render fingerprint hides the `undecryptable` transition entirely
- **File:** src/screens/chat/ChatRoomScreen.tsx:652 — **PERSONALLY VERIFIED**
- **Dimension:** cross-pattern-search
- **Problem:** `const statusCode = item.status === 'read' ? 4 : ... === 'failed' ? 5 : 1;`
  — `'undecryptable'` is not enumerated and falls into the same bucket (`1`)
  as `'sending'`.
- **Failure scenario:** The common case: a message is sent (`'sending'`), the
  recipient's device fails to decrypt it and reports back
  (`updateMessageStatus(..., 'undecryptable')`, no delivered/read change).
  Every other folded field in the fingerprint is also unchanged, so
  `statusChanged` is false, `setMessages()` is never called, and the bubble
  keeps showing the `'sending'` spinner indefinitely instead of the amber
  icon — silently defeating the entire "tell the sender" feature this session
  built, for the single-message-in-flight case, which is the most common one.
  Confirms `messageQueueService.ts` already special-cases this exact status in
  its own, separate receipt fingerprint — proving the codebase already knew
  this needed explicit handling and simply missed this second site.

### `preventDoubleSubmitHazard.test.ts` tests half the real hook, and would not catch the original bug's return
- **File:** src/utils/__tests__/preventDoubleSubmitHazard.test.ts:21-30
- **Dimension:** test-suite-audit
- **Problem:** The real `usePreventDoubleSubmit` has **two independent**
  concurrency guards: (1) the key-based `activeRequestPromises` Map, and (2) a
  per-instance `loadingRef`/`currentPromiseRef` check that fires on **every**
  concurrent call to the same hook instance, regardless of key — or even with
  no key at all. The test's `makeGuardedRunner` reimplements **only**
  mechanism (1).
- **Why this matters:** The test's "runs both when the key is unique per send"
  case reads as proof that a unique/no key is a safe fix. It is not — if two
  concurrent calls share the same hook **instance** (the normal case: one
  `usePreventDoubleSubmit()` per component), mechanism (2) alone still
  silently discards the second task, reproducing the exact catastrophic bug
  this suite exists to pin. The actual fix comment in `ChatRoomScreen.tsx`
  explicitly names this second mechanism — the engineers who fixed the real
  bug knew about it; this test doesn't encode that knowledge and would pass
  unchanged if a future "fix" reintroduced the danger via mechanism (2) alone.

### `versionCode` never increments on the actual Android ship path
- **File:** android/app/build.gradle:101; scripts/ship-android.sh:67,70
- **Dimension:** rules-and-config
- **Problem:** `versionCode` is hardcoded to the literal `1`. The sanctioned
  ship path (`npm run ship:android` → `ship-android.sh`) builds via raw
  `./gradlew bundleRelease`/`assembleRelease`, **not** `eas build` — so
  `eas.json`'s `autoIncrement`/`appVersionSource: "remote"` (which would
  normally bump this) never runs for Android at all. (The per-ABI
  `versionCode * 10 + offset` multiplication is confirmed **not** to
  compound this — Android App Bundles ignore the `splits` DSL entirely, Play
  splits by ABI itself, so that logic is moot for the `--submit` path; the
  real defect is the base number never advances from `1`.)
- **Failure scenario:** A second `--submit` to Play at any point after the
  first successful upload is built with the identical `versionCode 1` and
  rejected outright — Play requires strictly increasing versionCode for the
  package's lifetime.

### Six new `console.warn` calls on diagnosis-critical sync/crypto paths
- **Files:** src/services/signalCryptoService.ts:103,110; src/services/messageQueueService.ts:692; src/services/syncGapService.ts:242,259,309-311,458,472
- **Dimension:** cross-pattern-search
- **Problem:** A Release bundle drops `console.warn` entirely (this repo's own
  CLAUDE.md gotcha, already fixed once this session in
  `messageEnvelope.ts`). Six more sites on the exact class of path that
  gotcha was written for were left as `console.warn`:
  - `discardIdentityOrphanedByReinstall`'s trigger and failure logs — the
    function that exists specifically to fix a prior "messages appear blank,
    permanently" bug.
  - An incoming queue message failing `parseQueuePayload` is dropped with no
    other trace — functionally identical to the message vanishing.
  - `syncGapService.ts`'s `requestGapFill`, `claimGapRequest`,
    `releaseGapRequestClaim`, and its `onChildAdded`/`onChildChanged` listener
    cancellation — the file whose entire stated purpose is fixing prior
    silent-failure-of-sync bugs (doc 34 §0.1/§0.2).
  - The gap-request listener's `onError`, unlike the structurally identical
    receipt listener in `ChatContext.tsx`, also has **no retry/re-subscribe
    logic** — if cancelled, this device permanently stops seeing any other
    device's gap-fill requests for the rest of the session.
- **Failure scenario:** Any of these failing in the field reproduces exactly
  the silent, undiagnosable sync failures this session's own doc 34 was
  written to fix — with zero device-log evidence to show it happened.

### `meshRouter.test.ts`'s self-origin test never exercises the self-origin branch
- **File:** src/services/__tests__/meshRouter.test.ts:101-112
- **Dimension:** test-suite-audit
- **Problem:** The test titled "marks its own message seen so an echo cannot
  be re-flooded" constructs its echo frame with `origin: 'B'` (the *sender*
  role in the test), not `origin: 'A'` (the local node under test) — so it
  only exercises the ordinary `duplicate` dedup branch. If the `self-origin`
  check in `router.ts` were deleted entirely, this exact test would still
  pass unchanged.
- **Why it matters beyond redundancy:** `SeenSet` is capacity-bounded (2048,
  LRU-evicted). Once a self-originated message's id ages out under load,
  `self-origin` is the **only** remaining guard against a node re-processing
  its own stale, replayed broadcast. That guard has zero direct test
  coverage.

### `transportPreferences.test.ts` never tests the real fail-open load path
- **File:** src/services/__tests__/transportPreferences.test.ts:9-17,27-33
- **Dimension:** test-suite-audit
- **Problem:** The module's own header states its core guarantee: "FAIL OPEN.
  An unreadable or absent preference means ENABLED." That guarantee lives in
  `loadTransportPreferences`'s try/catch around `AsyncStorage.getItem` +
  `JSON.parse`. The test file never imports or calls
  `loadTransportPreferences` — its "FAILS OPEN" test only feeds pre-parsed JS
  values into the separate, already-safe pure function `parseTransportPreferences`.
- **Failure scenario:** A regression that makes `loadTransportPreferences`
  rethrow instead of catching (e.g. genuinely corrupt stored JSON) would go
  completely undetected, silently reintroducing the exact invisible-failure
  class ("nearby messaging quietly disabled with no signal") the module's own
  docstring says it exists to prevent.

---

## Medium

### `syncBatchService`'s associated-data derivation can mismatch on a chatId containing `__`
- **File:** src/services/syncBatchService.ts:100-104,124,181-183
- **Dimension:** router-crypto-security
- **Problem:** The seal side uses the full `body.chatId`; the open side
  derives chatId via `key.split('__')[0]` — only the substring before the
  **first** `__`. These differ whenever chatId itself contains a literal
  `__` (plausible at a `direct_${a}_${b}` concatenation boundary).
- **Failure scenario:** Fails closed (HPKE auth failure on open), not a
  forgery vector — but the outer catch that handles this never calls
  `consume()`, so the batch is left in RTDB and re-fails on every
  `onChildAdded` replay (app restart, reconnect), **forever**: gap-fill
  between the user's own linked devices for that chat is permanently broken,
  and the node accumulates indefinitely.

### `router.originate()` can report `held: true` for a message its own eviction just discarded
- **File:** src/services/mesh/router.ts:207-231
- **Dimension:** router-crypto-security
- **Problem:** `hold()` pushes a frame then immediately calls `enforceCap()`,
  which can evict that very frame in the same synchronous call.
  `originate()`'s return value doesn't check whether the frame survived.
- **Failure scenario:** Currently silent rather than visibly wrong (no
  current caller inspects `held`), but the router's own public contract is
  dishonest — any future caller or diagnostics surface trusting `held: true`
  to mean "will be delivered once reachable" would be silently wrong.

### `syncGapBatches` has no reaper, and a doc comment falsely claims one exists
- **Files:** functions/src/cleanup.ts (absence); src/services/syncBatchService.ts:204-208
- **Dimension:** rules-and-config
- **Problem:** Every other ephemeral RTDB path this session touches has a
  matching branch in `cleanupOldRtdbData` — `syncGapBatches` does not. The
  catch-block comment in `syncBatchService.ts` explicitly says "the reaper
  bounds how long it can linger" — no such reaper exists anywhere in the
  codebase.
- **Failure scenario:** A responder answers a gap request but the requester
  never comes back online to consume it (revoked device, uninstall — exactly
  the scenario doc 34's zero-history backfill exists to handle). The node
  never expires, contradicting CLAUDE.md's "never let RTDB accumulate" rule.

### `pairingConfirm` RTDB path has no rule branch
- **File:** database.rules.json (absence); functions/src/pairing.ts:33; functions/src/cleanup.ts:148
- **Dimension:** cross-pattern-search
- **Problem:** Currently harmless — only Admin-SDK code touches this path
  today, which bypasses rules entirely.
- **Failure scenario:** If any future feature adds a client-side listener on
  this path (e.g. UI polling for pairing confirmation instead of waiting on
  the callable), it fails with `permission_denied` for every user —
  reproducing the exact `syncGapBatches` incident this session already hit
  once, invisibly, until someone builds that feature.

### `syncBatchFormat`'s `until`/`complete` claims aren't cross-validated against the actual messages
- **File:** src/services/syncBatchFormat.ts:105-157
- **Dimension:** test-suite-audit
- **Problem:** Neither `parseSyncBatchBody` nor `isBatchForRequest` checks
  that `until` (or `complete: true`) is consistent with the max `createdAt`
  actually present in `messages`. A batch claiming "complete up to timestamp
  X" while delivering almost nothing currently passes both.
- **Failure scenario:** Partially mitigated today — `syncGapService.ts`'s
  detection loop re-derives its watermark from real local message stats
  rather than trusting `body.until` — but the format's own stated security
  invariant ("the requester cannot tell 'nothing more' from 'I withheld it'")
  is unenforced and untested; any future code trusting `body.until` at face
  value would be silently exploitable.

### `localNodeId` can be empty when a frame is originated, producing a false "sent" status
- **File:** src/services/nearbyMessageService.ts:158,406
- **Dimension:** mesh-js-core
- **Problem:** `localNodeId` is `''` until `startNearbyMessaging`'s async
  device-id resolution completes. Other entry points that can drive
  `router.originate()` (queued-send broadcasts, attachment-handling
  callbacks) are not gated on that assignment.
- **Failure scenario:** If a send races the assignment, `router.originate()`
  stamps `origin: ''`. Every receiving peer's `decodeRouterFrame` rejects
  this as malformed (requires non-empty origin) and silently drops it — but
  `sendRawToTransports`'s `deliveredCount` only reflects whether raw bytes
  reached a connected peer at the transport layer, not whether the frame
  parses, so the message is still marked `meshBroadcastAt`/`'sent'`: a
  false-positive delivery confirmation for a message no peer can ever accept.

### iOS/Android LAN: unbounded connection/thread accumulation for a peer that never completes the handshake
- **Files:** modules/splitcircle-lan/android/.../SplitCircleLanModule.kt:47,228-281; modules/splitcircle-lan/ios/SplitCircleLanModule.swift:99-105,224-247
- **Dimension:** lan-native
- **Problem:** Neither platform sets a socket/connection timeout. Android's
  version is the more severe of the two: `handshake()` blocks on
  `input.readInt()` with no `Socket.setSoTimeout`, on a thread pulled from an
  **unbounded** `Executors.newCachedThreadPool()`.
- **Failure scenario:** A peer that opens a connection and never completes
  the identity exchange (backgrounded mid-connect, hostile peer, or just an
  ordinary radio drop) permanently pins an Android thread (real stack memory,
  no reclamation) or leaks an iOS dictionary entry with no reaper. Repeated
  over a session, thread count grows without bound on Android.

### BLE (Swift): a stuck `deferredNotifies` promise isn't cleaned up when its peer disconnects
- **File:** modules/splitcircle-ble/ios/SplitCircleBleModule.swift:213
- **Dimension:** ble-native
- **Problem:** When the peripheral-manager's transmit queue is full,
  `sendChunk` defers the promise into `deferredNotifies`, relying on
  `peripheralManagerIsReady` to retry it. Neither `disconnect(deviceId:)` nor
  `didUnsubscribeFrom` scans/clears that peer's entry.
- **Failure scenario:** If that peer then loses trust or disconnects, and no
  other peripheral-role traffic happens afterward (plausible if it was the
  only/last connected peer), the promise never settles — the exact failure
  `stop()`'s own comment calls unacceptable, just not enforced on the
  per-peer eviction paths.

### Group-chat undecryptable receipt can pick the sender's own self-sync device, swallowing a real peer's failure
- **File:** src/services/messageQueueService.ts:1120 combined with src/context/ChatContext.tsx (self-authored check)
- **Dimension:** chat-send-path
- **Problem:** `listenForReceipts` picks a single representative
  `recipientId` (`allUndecryptable[0]`, alphabetically sorted) for a group's
  overall `'undecryptable'` status. If the sender's own account has 2+
  devices and the sender's own userId happens to sort first, `ChatContext`'s
  `if (recipientId === currentUser.userId) return` treats the **whole
  event** as self-authored.
- **Failure scenario:** A real group member's simultaneous, independent
  undecryptable report is silently swallowed alongside the self-sync one —
  the message stays at its prior status, permanently hiding a genuine
  delivery failure to an actual human recipient. (I'd personally weight this
  higher than "medium" given the consequence, but I'm reporting the
  originally-assessed severity rather than silently reclassifying it.)

---

## Low

### `needsContinuation()` is tested but has zero real callers
- **File:** src/services/syncBatchFormat.ts:160-161
- **Dimension:** test-suite-audit
- **Problem:** Exported, correctly unit-tested in isolation — but nothing in
  `ChatContext.tsx`'s `onBatch` callback (the actual consumer of a batch)
  ever calls it. "The requester should immediately ask for the remainder" is
  proven only as a pure function, not wired into the real continuation flow.

### `originReseal.test.ts` has 11 tests, not the "10" claimed in commit messages
- **File:** src/services/__tests__/originReseal.test.ts
- **Dimension:** test-suite-audit
- **Problem:** Trivial correction, not a functional defect. All other
  session-commit test-count claims checked out exactly (lanTransport=13,
  meshRouter=23, transportPreferences=8, syncBatchFormat=18).

### BLE/LAN: narrow, self-correcting memory-visibility races on `trusted`/`localDeviceId`
- **File:** modules/splitcircle-ble/*, modules/splitcircle-lan/android/.../SplitCircleLanModule.kt:49-51
- **Dimension:** ble-native, lan-native
- **Problem:** Trust/id fields are written under a lock but read unguarded
  from other threads in a few places.
- **Failure scenario:** A just-revoked trust entry may not be visible
  immediately to an in-flight handshake started in the same instant. Narrow
  window, self-correcting on the next trust update or connection churn.

---

## What was searched and found clean

- **Native callback argument order** (the class of bug already found once in
  `lanTransport.ts`): checked `mpcTransport.ts` and `bleTransport.ts`'s
  `onFrame` wiring against the native contracts and against
  `MeshTransport.onFrame`'s declared `(data, from)` order. Both correct.
- **`usePreventDoubleSubmit` call sites app-wide**: every site outside chat
  send/location/attachment (payment/expense/settlement/group create-or-join
  buttons in `PrimaryButton.tsx`) uses a key scoped to one entity and one
  logical action — the "second tap is a mistake" case this hook is actually
  for. No further recurrence found.
- **RTDB rule coverage**: every client-reachable path across
  `src/services/*.ts`, `src/context/*.tsx`, `src/services/mesh/*.ts` maps to
  an existing rule branch, except `pairingConfirm` (medium finding above,
  currently harmless).
- **`isAvailable()` conflating hardware with permission** (the class of bug
  found and fixed once in BLE's Kotlin module): checked `splitcircle-crypto`
  and `splitcircle-mesh` (MultipeerConnectivity) on both platforms. Neither
  has an OS-permission dimension to conflate in the first place — crypto
  needs no runtime grant, and MPC's own `isAvailable` is purely "is the
  module linked," with no permission check gating it. No recurrence.
- **`MessageStatus` exhaustiveness elsewhere**: notification badge logic,
  unread-count logic, chat-list preview, search indexing, and AI/insights
  code (`aiTools.ts`, `onDeviceAiContext.ts`, `statsInsights.ts`) do not
  branch on message status at all. Only the `ChatRoomScreen.tsx` fingerprint
  (high finding above), `AlbumBubble.tsx`, and `MessageActionSheet.tsx`
  needed updating.

---

## Fix plan

Ordered by what actually blocks what, not by nominal severity label.

1. **Fix the Android BLE/LAN start gate** (`nearbyMessageService.ts:395`).
   Stop gating `startNearbyMessaging` on `isNearbyMeshAvailable()` (MPC-only).
   Gate MPC's own `.start()` on it, but let BLE/LAN start independently —
   this is the single blocker for every other Android mesh fix this session
   produced.
2. **Fix `maxPayloadFor`'s BLE capacity zeroing** (`transport.ts:101-107`).
   Either give BLE a realistic advertised MTU that accounts for the router
   header, or make the router header size adaptive/optional per transport
   rather than a flat subtraction that exceeds BLE's entire budget.
3. **Unify the LAN service-type string** (`_manasplit-mesh._tcp` on both
   platforms, matching exactly) — costless, and removes the single biggest
   cross-platform-discovery risk before any hardware test is attempted.
4. **Only after 1–3**: re-run the doc 33 §9.6 BLE hardware test and the LAN
   equivalent. Nothing about LAN or BLE's actual radio behavior can be
   trusted from a device test until these three land.
5. **Wire `transportPreferences` into the actual transport lifecycle** —
   either restart `startNearbyMessaging` on a preference change, or add a
   `stop()`/pause path that the preference subscription actually drives.
   This is a real privacy promise the UI currently breaks.
6. **Fix the `ChatRoomScreen.tsx` status fingerprint** to include
   `'undecryptable'` as its own code — one-line fix, restores the entire
   doc 33 §4.3 feature for the common case.
7. **Add `'undecryptable'` (and `'failed'`, for the action sheet) branches to
   `AlbumBubble.tsx` and `MessageActionSheet.tsx`** — match
   `MessageBubble.tsx`'s canonical treatment, or better, extract the ranking
   logic to one shared function all three call.
8. **Fix `handleSendLocation`'s dedup key** to be per-send, not per-chat —
   identical fix to what text/media already got.
9. **Scope `AttachmentMenu`'s dedup key per chat** (include `chatId` in the
   key) rather than a global literal.
10. **Fix `progressOutlivesSend`** to `Boolean(wireEnvelope && nearbyAttachment)`.
11. **Fix the BLE identity-handshake ordering** (both platforms) so a peer is
    only added to `centralLinks`/`peripheralLinks` after this device's own
    identity write is acknowledged, not merely after the read completes —
    or gate `sendChunk`'s target lookup on the same "fully announced" flag
    `emitPeers()` already uses.
12. **Fix the Android GATT-server peripheral write race** — move
    `characteristic.value = bytes` and `notifyCharacteristicChanged` inside
    the same lock, or give each peer its own characteristic-value staging.
13. **Add a socket/connection timeout to LAN's handshake on both platforms**,
    and expire `pending`/`pendingConnections` entries that never complete.
14. **Fix Android LAN's `closePeer`** to take the specific `Socket` instance
    (or a generation counter) rather than closing whatever is currently
    mapped under a device id.
15. **Add an iOS `stateUpdateHandler` to LAN's `NWListener`/`NWBrowser`** so
    Local Network permission denial is detected and surfaced as `start()`
    returning `false`, not silently swallowed.
16. **Route Android's actual ship path through `eas build`**, or otherwise
    give `versionCode` a real increment mechanism, before the next `--submit`.
17. **Add rule branches for `pairingConfirm`** in `database.rules.json` (cheap
    insurance) and **add a `syncGapBatches` reaper** to `cleanup.ts`; correct
    the false "the reaper bounds it" comment in `syncBatchService.ts`.
18. **Switch the six flagged `console.warn` calls to `console.error`**
    (`signalCryptoService.ts`, `messageQueueService.ts`, `syncGapService.ts`)
    and add retry to the gap-request listener's `onError`, matching the
    receipt listener's own pattern.
19. **Fix `syncBatchService`'s associated-data derivation** to use the same
    full `chatId` on both seal and open sides (don't split on `__`), and make
    the outer catch call `consume()` so a persistently-failing batch doesn't
    accumulate forever.
20. **Rewrite `preventDoubleSubmitHazard.test.ts`** to import and exercise the
    real hook (both guard mechanisms), not a partial reimplementation.
21. **Rewrite `transportPreferences.test.ts`'s fail-open test** to actually
    call `loadTransportPreferences()` against a mocked-to-throw `AsyncStorage`.
22. **Fix `meshRouter.test.ts`'s self-origin test** to construct a frame with
    `origin === localNodeId` for a fresh msgId, not an echo from a different
    origin.
23. **Everything else in Medium/Low** — the `held: true` eviction lie, the
    group-chat undecryptable-receipt representative-picking, the
    `until`/`complete` cross-validation gap, the `versionCode`/ABI-splits
    interaction note, the trust-read memory-visibility races, and the
    `needsContinuation` dead-code wiring — is real but lower-urgency; fix
    opportunistically or in a follow-up pass once 1–22 land.

---

## Status after the fix pass (2026-08-01)

Everything in Critical, High, Medium and Low above is fixed, with the exceptions
and corrections noted here. Each fix is described in its commit message rather
than duplicated into this doc; the audit text above is left as WRITTEN AT AUDIT
TIME so the reasoning stays checkable against what was actually found.

### Two findings were WRONG, and are corrected rather than quietly dropped

1. **`meshRouter.test.ts`'s self-origin test** — the audit said it "only
   exercises the ordinary `duplicate` dedup branch" and that deleting the
   `self-origin` check would leave it passing. Half right. The frame's
   `origin: 'B'` models the echo AS REBROADCAST BY A PEER, which is a real and
   distinct property: that `originate()` recorded the id in the seen set. The
   `self-origin` check fires EARLIER, so setting `origin: 'A'` as the audit
   proposed does not fix that test, it replaces one branch's coverage with the
   other's — verified by making the change and watching the assertion flip to
   `reason: 'self-origin'`. Both are now covered by two separate tests, and the
   original is retitled to say which it is.

2. **`AttachmentMenu`'s dedup key** — the fix plan said "scope it per chat
   (include `chatId`)". That is insufficient. The key map entry is released only
   in the task promise's `.finally()`, so a picker that never settles wedges its
   key permanently no matter how narrowly scoped, and expo-image-picker hanging
   on a large iCloud video (CLAUDE.md) is exactly that. The key was removed
   entirely; the hook's per-instance `loadingRef` still stops a double-tap and
   self-heals on remount.

### Three defects found while fixing, not present in the audit

- `startNearbyMessaging`'s "no transport started" branch published a fresh
  snapshot, wiping `trustedPeers` — three lines below the block that
  deliberately preserves it across a start. On a device with every radio off,
  the user's paired peers vanished.
- Wiring `needsContinuation` (Low #1) with a plain `requestGapFill` would have
  been INERT: the local watermark stays at the original timestamp and
  `isBatchForRequest` then rejects the continuation batch on arrival. Needed
  `requestGapContinuation`, which advances the watermark too.
- `versionCode` read via `findProperty` inside `defaultConfig` resolves against
  the DSL object, not the project, and fails evaluation with "Value is null".
  Caught by `--dry-run`; invisible to review.

### What is still owed

- **Hardware verification of everything above.** No BLE radio and no LAN socket
  has carried a byte. The three critical fixes are what make that test possible
  for the first time on Android; they do not substitute for running it. Doc 33
  §9.6 (BLE) and the LAN equivalent are still un-run.
- ~~**The nearby-in-chat UI revamp**~~ — DONE 2026-08-02 (`a27dfb8`, `bab8dcd`).
  It began with a bug, not a restyle: `onNeighbourChange` fired side effects only
  and never published, so the user-visible snapshot was fed exclusively by an
  MPC-only native event. On Android every nearby surface therefore reported zero
  peers and "Looking for known contacts" while BLE or LAN was connected and
  carrying messages — which is what "both the devices are saying the same" meant.
  A 27th finding, missed by all nine audit dimensions, and one no restyle could
  have fixed.
- **`syncBatchFormat`'s `until`/`complete` cross-validation** (Medium) — the
  claims are still not checked against the actual messages. Deliberately left:
  the failure is a responder lying about its own coverage, which the
  continuation fix now bounds, and the check needs a decision about what a
  requester should DO on detecting the lie.
- **Memory-visibility races on `trusted`/`localDeviceId`** (Low) — narrow and
  self-correcting on the next trust update. Left as documented.
- **`originReseal.test.ts` has 11 tests, not 10** — noted; no action.
