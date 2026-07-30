# 2026-07-29 nearby protocol v2: second incident, research, and build plan

Status: the repeated-message failure is reproduced from the two physical-phone
stores and corrected in code. Text protocol v1 remains a bridge while the
Network framework/Wi-Fi Aware v2 transport is built. Media transfer is designed
below but is not yet implemented. The focused, implementation-ready media plan
is now in `2026-07-29_OFFLINE_MEDIA_SHARING_RESEARCH_AND_PLAN.md`.

Future agents should read this file first, followed by:

1. `2026-07-29_NEARBY_MESSAGING_INCIDENT.md`
2. `2026-07-28_OFFLINE_AND_NEARBY_MESSAGING_HANDOFF.md`
3. `OFFLINE_FIRST_RESEARCH.md`
4. `NEARBY_MESSAGING_UX.md`

## What the second physical test proved

Test environment:

- iPhone 17 Pro and iPhone 13 mini;
- Airplane Mode enabled;
- Wi-Fi and Bluetooth manually re-enabled;
- both apps in the foreground;
- both UIs reported `Offline · Nearby connected to 1 phone`;
- one message in each direction arrived quickly;
- later messages stayed local and a direct-message attempt reported
  `No nearby participant has an established secure session`.

The screens rule out discovery, radio negotiation, and React rendering as the
initial failure. The native session was connected and the first encrypted
application payload crossed in both directions.

We copied and inspected the app containers before changing code. No private key
material or plaintext outside the already-visible test messages was exported.

Sanitized evidence:

| Phone | Signed-in user | Installation | Signal id | Nearby queue |
| --- | --- | --- | --- | --- |
| iPhone 17 Pro | `hVk…` | `76d9…` | 2 | only the first message received from `t9d…` |
| iPhone 13 mini | `t9d…` | `dc0f…` | 1 | only the first message from each phone |

The later chat bubbles existed in local chat storage but did not exist as
sendable nearby operations. They later appeared on both stores through the
normal group cloud path, matching the earlier observation that reconnecting to
the Internet made messages appear. This proves that the failure occurred while
constructing a secure nearby envelope, before native transport send.

The Pro also contained a `needsRebuild` Signal repair flag. The Mini snapshot no
longer did after reconnecting, which is consistent with online session
preparation repairing and clearing it.

## Root cause: replay entered the Double Ratchet before dedupe

The v1 gossip code intentionally retransmitted every live signed envelope:

```text
send a new message
  -> read the whole seven-day nearby queue
  -> send old envelope 1 again
  -> send new envelope 2
```

The receiver performed these steps in the unsafe order:

```text
parse -> verify -> Signal decrypt -> enqueue/dedupe
```

A signed operation id is idempotent; a Signal ciphertext is not. The Double
Ratchet uses a unique message key for each ciphertext and deletes or advances
past it after successful decryption. Replaying the already-consumed ciphertext
raises libsignal's typed `SignalError.duplicatedMessage`.

`decryptMessageEnvelope` classified every decrypt error as session corruption
and wrote a `needsRebuild` flag. The next offline send used `cache-only`
encryption, correctly refused to claim a cloud prekey to rebuild the flagged
session, and produced no nearby body. That created the exact sequence seen on
both phones:

```text
first message works
  -> gossip repeats first ciphertext
  -> duplicate decrypt marks session broken
  -> all later offline envelope creation fails
  -> direct chat exposes the secure-session error
  -> group chat retains a cloud-sync-only local operation
```

### Correction implemented

1. `meshMessageQueue` now atomically claims `(originUserId, messageId)` before
   any stateful decrypt.
2. A persisted or concurrently processing operation is discarded before
   touching libsignal.
3. The native crypto bridge maps `SignalError.duplicatedMessage` to the stable
   `DuplicateSignalMessage` exception code.
4. The JS repair policy never marks a session for rebuild for that typed replay
   condition. Other decrypt failures still request repair.
5. Tests cover persisted replay, concurrent replay, committed dedupe, typed
   duplicate handling, and real-failure repair.

Pre-decrypt idempotency is a protocol invariant from this point forward. No
transport replacement or media implementation may bypass it.

## Second defect: stale cross-account installation records

The Mini's installation id, `dc0f…`, was cached as a Signal device for both its
current `t9d…` account and the Pro's `hVk…` account. This can happen because an
iOS installation id survives in SecureStore while sign-out marks only the
notification record as signed out; it does not remove the former account's
`signalPrekeys` document.

That stale record made the Mini encrypt a message to itself while treating
itself as a remote device on a different account. Strict all-device encryption
then had an unnecessary failure dependency on the stale session.

### Immediate correction implemented

`buildMeshMessageBody` now excludes the originating installation id from every
recipient directory, not only the sender's own account. Installation ids are
intended to be globally unique, so a current phone appearing under a different
recipient is necessarily stale and must never be targeted.

Nearby encryption now also retains every healthy per-device ciphertext instead
of discarding an entire recipient when one stale sibling device is unavailable.
This is not a plaintext downgrade: every included copy is still Signal
encrypted. The normal cloud path remains strict all-device coverage. This
separation is necessary for the product promise that a present group member or
direct-chat peer is not blocked by an absent, retired phone.

### Required account-lifecycle correction

The immediate filter prevents nearby failure but does not clean server state.
Before v2 exits beta:

1. add a server-side sign-out/reassignment operation that atomically retires
   the installation's notification, paired-device, and Signal-prekey records
   from its former account;
2. bind every native Signal identity to the active user id and wipe/rebootstrap
   when that binding changes;
3. remove durable peer-directory entries only from a server-authoritative
   refresh, never an offline/Firestore-memory-cache result;
4. add a migration/reaper for installation ids published under multiple users;
5. test account A -> sign out -> account B -> offline nearby -> account A
   recovery on one physical phone.

Do not delete current main-device records ad hoc. The server operation must
respect main-device retirement and backup ownership rules.

## Critique of protocol v1

What is good and should survive:

- headless offline cold boot does not wait for Firebase;
- mandatory encrypted native links;
- Signal identity signatures and cached chat-membership authorization;
- private message fields are per-device encrypted;
- origin/message ids are stable across nearby and cloud delivery;
- originated group messages sync to the normal cloud path;
- direct nearby messages remain local-only by product decision;
- generic discovery UI does not expose contact identity before verification.

What is not flagship-grade yet:

- Multipeer Connectivity is deprecated and has reproduced multi-minute
  `.connecting` stalls with too little diagnostic visibility;
- replay-everything gossip has no per-peer ACK, flow control, or retry ledger;
- `MCSession.send(.reliable)` means handed to the framework, not verified,
  decrypted, durably stored, or viewed;
- a connected radio peer is not yet bound to a signed application identity by
  an explicit hello;
- the entire signed envelope is JSON/base64 and capped at 256 KiB;
- there is no attachment transfer, resume, hash verification, quota, or
  temporary-file lifecycle;
- there is no durable inbox state between `decrypt` and local chat commit;
- group relays have no hop limit or receiver-specific receipt tracking;
- session readiness depends on online prewarming and has no local first-contact
  bootstrap;
- stale multi-account device ownership is not repaired server-side;
- background availability is opportunistic and must not be marketed as a
  guaranteed nearby inbox.

## Apple transport decision

Apple DTS explicitly recommends moving stalled Multipeer apps to Network
framework. Apple's Network sample uses Bonjour plus TLS for nearby iOS
connections. `NWParameters.includePeerToPeer = true` opts browsers, listeners,
and connections into Apple peer-to-peer Wi-Fi.

For iOS 26 and later, Wi-Fi Aware is the preferred primary path:

- no router, hotspot, cellular connection, or Internet is required;
- links are authenticated and encrypted at the Wi-Fi layer;
- it is designed for low-latency, high-throughput transfer and multiple peers;
- DeviceDiscoveryUI provides system-owned app-to-app pairing;
- Network framework provides browser, listener, connection, TLS, path metrics,
  and custom protocol framing;
- the app must use `WACapabilities.supportedFeatures` as the authoritative
  runtime capability gate rather than assuming support from a model name.

Wi-Fi Aware requires the `com.apple.developer.wifi-aware` entitlement and
declared `WiFiAwareServices`. It also introduces an intentional system pairing
step. It is not a drop-in automatic scan replacement.

Transport order for v2:

1. Wi-Fi Aware + DeviceDiscoveryUI + Network framework on supported paired
   iOS 26+ devices.
2. Bonjour + Network framework TLS with `includePeerToPeer` for unpaired
   Apple-device discovery/fallback.
3. Existing Multipeer implementation behind a measured legacy fallback flag
   until the first two paths pass the physical matrix.

The application protocol must be transport-independent. Never weaken
application authentication because Wi-Fi Aware or TLS encrypts the radio link.

## Nearby protocol v2

### Layering

```text
Discovery/pairing
  DeviceDiscoveryUI + Wi-Fi Aware, or Bonjour

Secure transport
  NetworkConnection / NWConnection with TLS

Application session
  version negotiation + signed identity hello + capability exchange

Reliable operation channel
  framed control/message operations + durable ACK/receipt ledger

Bulk channel
  encrypted, content-addressed, resumable media chunks

Convergence
  stable operation/blob ids -> local store -> group cloud relay
```

### Framing

Use a Network framework framer rather than delimiter-scanning JSON. Every frame
has a bounded fixed header and a canonical CBOR or protobuf payload:

```text
magic | protocolVersion | frameType | flags | streamId
sequence | payloadLength | payloadDigest | payload
```

Frame types:

- `HELLO`, `HELLO_ACK`, `CAPABILITIES`
- `HAVE`, `OFFER`, `REQUEST`
- `MESSAGE`
- `BLOB_MANIFEST`, `BLOB_CHUNK`
- `ACK`, `NACK`, `RECEIPT`
- `CANCEL`, `PING`, `PONG`, `GOODBYE`

Reject unsupported versions, unknown critical flags, oversized lengths, invalid
canonical encodings, and digest mismatches before allocating large buffers.

### Application identity handshake

After the encrypted transport is ready:

1. exchange random nonces, protocol versions, capabilities, installation id,
   Signal device id, and an ephemeral Curve25519 public key;
2. sign the canonical transcript with the existing Signal identity;
3. verify the signature against the durable online-seeded device directory;
4. bind the session to `(userId, installationId, signalDeviceId, identityKey)`;
5. derive application traffic keys from the ephemeral shared secret and
   transcript hash;
6. expose a contact/group identity in UI only after verification and local
   membership authorization.

Transport TLS protects the link. The signed transcript prevents an app that can
advertise the same service from impersonating a cached ManaSplit member and
binds the radio peer to the message identity.

### Idempotency, ACKs, and retry

Maintain a durable operation ledger:

```text
operationId
originUserId
originDeviceId
chatId hash
envelope hash
firstSeenAt / expiresAt
state: offered | received | verified | committed | relayed
perPeer: offeredAt | ackedAt | receiptAt | retryCount
```

Rules:

- check the replay ledger before signature verification, ratchet decrypt, file
  allocation, or chat-store mutation;
- bind the operation id to the signed envelope hash; reject same-id/different-
  body equivocation;
- distinguish transport ACK (`frame bytes accepted`) from application receipt
  (`verified and durably committed`);
- retry only unacknowledged work with capped exponential backoff and jitter;
- exchange compact `HAVE` sets/ranges on reconnect rather than replaying the
  full queue;
- preserve a bounded replay tombstone after message/cloud compaction;
- limit hop count and relay TTL;
- use per-peer send windows and backpressure;
- compact only when cloud relay policy and required peer receipts are satisfied.

The UI may show:

- clock: local only / waiting for secure route;
- one check: accepted by nearby transport;
- two checks: verified and committed by at least one intended phone;
- cloud badge: group copy converged to cloud.

These meanings must be explicit; `MCSession.send` alone cannot produce two
checks.

### Group and direct behavior

Group:

- every connected, authorized member receives the operation;
- a connected member may relay the exact signed operation to another present
  member;
- all recipient devices named in the encrypted manifest can decrypt;
- only the origin uploads the canonical group operation and attachment to the
  cloud when Internet returns;
- stable message and blob ids make nearby/cloud convergence idempotent.

Direct:

- remains local-only;
- both devices must have an established/prewarmed Signal session;
- v2 may add an explicit QR/system-pairing first-contact bootstrap, but it must
  be a separate reviewed design and cannot silently trust proximity.

### Media transfer

Do not put media bytes in the Signal JSON message envelope. Send an encrypted
manifest in the message operation:

```text
blobId = SHA-256(ciphertext or canonical plaintext identity)
mediaKey = 256 random bits
mime, logical size, encrypted size
chunk size, chunk count
whole-file digest
per-chunk digest or Merkle root
thumbnail blob id
caption and media key wrapped per recipient device
```

Transfer policy:

- default 128 KiB chunks, tunable from 64–256 KiB;
- encrypt each chunk with an AEAD such as ChaChaPoly using a unique derived
  nonce and authenticated `(blobId, chunkIndex, totalChunks, manifestHash)`;
- request only missing chunks using a durable bitmap;
- cap in-flight bytes and use receiver-advertised credit;
- write to an app-owned temporary file, verify every chunk and final digest,
  then atomically rename into permanent local media storage;
- delete abandoned partials by TTL and quota;
- validate declared size before allocation, sniff actual content type, decode
  images with pixel/dimension limits, and never auto-open executable/unsafe
  documents;
- send preview/thumbnail as an independent small blob;
- allow pause, cancel, resume, and per-peer progress;
- on Internet return, the origin uploads the same encrypted/canonical blob once
  and publishes the stable blob id in the group cloud operation.

The existing empty Multipeer resource delegate methods could support a short
prototype, and `sendResource` exposes progress plus a temporary receive URL.
They should not become the long-term API because the transport itself is being
replaced and `sendResource` still lacks our application ACK/resume semantics.

### Resource and abuse limits

Initial conservative defaults:

- control/message frame: 256 KiB maximum;
- decoded canonical control payload: 128 KiB maximum;
- attachment: 100 MiB per item for beta, product-configurable later;
- 4 concurrent blob streams globally, 2 per peer;
- 8 MiB receiver window per peer;
- 1 GiB nearby partial-file quota;
- 7-day operation TTL and 24-hour abandoned-partial TTL;
- bounded `HAVE` response and replay tombstone count;
- reject clock skew beyond the existing signed-envelope policy;
- rate-limit discovery restart, pairing prompts, invalid signatures, and NACKs.

These are starting points, not security constants. Measure memory, energy,
throughput, and real user media sizes before raising them.

## Implementation plan and gates

### Phase 0 — stabilize text v1 (implemented in this incident)

- pre-decrypt durable/concurrent dedupe;
- typed libsignal duplicate handling;
- exclude self installation from cross-account recipient directories;
- regression tests;
- two-phone standalone developer Release retest with 20 alternating messages.

Exit: 20/20 each direction offline, no session-repair flags caused by replay,
no duplicates after reconnect, and direct messages remain off cloud.

### Phase 1 — observable delivery semantics

- add signed application receipts;
- persist per-peer attempt/ACK/receipt state;
- stop replaying every queued envelope on every send;
- expose exact route and receipt state in the nearby sheet;
- add an exportable redacted diagnostic bundle.

Exit: packet loss/reconnect tests converge without duplicate decrypts and UI
never claims durable receipt from transport handoff alone.

### Phase 2 — Network framework transport

- define a TypeScript transport interface used by nearby services;
- implement native Bonjour browser/listener/connection with TLS,
  `includePeerToPeer`, and a Network framer;
- implement deterministic duplicate-connection arbitration;
- retain Multipeer as a feature-flagged fallback;
- compare connection latency/success/energy on the physical matrix.

Exit: at least 95% first-attempt connection success in the test matrix, bounded
recovery, and no unexpected disconnect during a 30-minute soak.

### Phase 3 — Wi-Fi Aware pairing

- request/configure entitlement and `WiFiAwareServices`;
- add DeviceDiscoveryUI pairing from the nearby sheet;
- persist paired endpoints without exposing raw hardware identifiers;
- use Wi-Fi Aware `NetworkBrowser`, `NetworkListener`, and
  `NetworkConnection`;
- retain clear fallback copy for unsupported/unpaired devices.

Exit: both test phones pair, cold-launch offline, reconnect, and exchange 100
messages with no router/hotspot/Internet.

### Phase 4 — media

- implement encrypted manifests and file/chunk stores;
- resume bitmap, credit-based flow control, progress, pause/cancel;
- image/video/document validation and quota management;
- stable blob convergence to cloud for groups;
- thumbnails and polished transfer UI.

Exit: 1 KiB, 1 MiB, 25 MiB, and 100 MiB fixtures transfer, interrupt/resume,
verify byte-for-byte, reject tampering, and do not duplicate on cloud sync.

### Phase 5 — hardening and release

- three-phone partial-topology gossip;
- account-switch/revocation migration;
- fuzz framing/parser and malformed manifests;
- replay/equivocation/identity-change tests;
- network conditioning, low disk, memory pressure, foreground/background,
  Wi-Fi toggles, Bluetooth toggles, and airplane-mode matrix;
- privacy review, accessibility, localization, battery/thermal soak;
- staged feature flag, metrics without message/contact content, rollback path.

## Validation matrix

Automated:

- queue claim races and replay tombstones;
- duplicate versus corrupt-session classification;
- signature, audience, age, version, size, and same-id/different-hash rejection;
- ACK loss, reconnect, out-of-order frames, resume bitmaps, quota, cancellation;
- media digest/AEAD failure and atomic-file cleanup;
- account switch and stale directory filtering;
- group cloud convergence and direct no-cloud invariant.

Physical:

1. 20 alternating text messages in Airplane Mode.
2. Burst 100 messages from each phone without waiting.
3. Disconnect/reconnect after every 10th message.
4. Kill/relaunch sender, receiver, then both.
5. Deny/re-enable Local Network permission.
6. Wi-Fi on/unjoined, shared infrastructure Wi-Fi, and Airplane Mode with
   Wi-Fi/Bluetooth manually restored.
7. Three present members with A-B-C partial reachability.
8. Restore Internet and verify one canonical group copy and zero direct copies.
9. Account A/B switch on one installation.
10. Media size/resume/tamper/low-disk matrix.

Record p50/p95 discovery time, secure-session time, first-byte time, throughput,
receipt latency, reconnect count, failure code, energy, memory, and thermal
state. Never record chat ids, contact ids, plaintext, ciphertext, or identity
keys in analytics.

## Primary resources

Apple:

- Network framework custom peer-to-peer sample:
  <https://developer.apple.com/documentation/network/building-a-custom-peer-to-peer-protocol>
- `NWParameters.includePeerToPeer`:
  <https://developer.apple.com/documentation/network/nwparameters/includepeertopeer>
- Network framework framer protocol:
  <https://developer.apple.com/documentation/network/nwprotocolframerimplementation>
- TN3151, choosing the right networking API:
  <https://developer.apple.com/documentation/technotes/tn3151-choosing-the-right-networking-api>
- Apple DTS recommendation to move from Multipeer:
  <https://developer.apple.com/forums/thread/811978>
- Wi-Fi Aware overview and supported hardware:
  <https://developer.apple.com/documentation/wifiaware>
- Wi-Fi Aware pairing/connection:
  <https://developer.apple.com/documentation/wifiaware/connecting-paired-devices>
- Wi-Fi Aware sample:
  <https://developer.apple.com/documentation/wifiaware/building-peer-to-peer-apps>
- DeviceDiscoveryUI:
  <https://developer.apple.com/documentation/devicediscoveryui>
- WWDC25 Wi-Fi Aware session:
  <https://developer.apple.com/videos/play/wwdc2025/228/>
- Multipeer `sendResource` behavior:
  <https://developer.apple.com/documentation/multipeerconnectivity/mcsession/sendresource(at:withname:topeer:withcompletionhandler:)>
- CryptoKit authenticated encryption:
  <https://developer.apple.com/documentation/cryptokit/chachapoly/sealedbox>
- Background Tasks:
  <https://developer.apple.com/documentation/backgroundtasks>

Signal:

- Double Ratchet specification:
  <https://signal.org/docs/specifications/doubleratchet/>
- Sesame multi-device session management:
  <https://signal.org/docs/specifications/sesame/>
- libsignal source:
  <https://github.com/signalapp/libsignal>

## Non-negotiable invariants

1. Offline boot and nearby startup never begin a Firebase request that can gate
   the UI or send path.
2. Replay detection happens before any stateful decrypt.
3. Proximity, Bonjour names, and transport connection state are not identity.
4. No plaintext downgrade when a known encrypted recipient cannot be covered.
5. Direct nearby messages never enter cloud relay.
6. Originated group messages converge to the existing cloud path exactly once.
7. Media is encrypted, bounded, hashed, resumable, and committed atomically.
8. UI distinguishes connected, handed off, durably received, and cloud-synced.
9. Background delivery is described as opportunistic, never guaranteed.
10. No implementation ships as flagship without the two- and three-phone
    fault-injection matrix.

## Validation and installed build

Results for the second-incident correction:

- `npx tsc --noEmit`: passed.
- `npm run test:unit`: 36 files, 419 tests passed.
- `npm run test:services`: 19 files, 171 tests passed.
- `npm run test:dom`: 5 files, 15 tests passed.
- `plutil -lint ios/SplitCircle/Info.plist`: passed.
- `git diff --check`: passed.
- iOS 27 SDK physical-device Release compile: passed.
- the packaged app's strict/deep code-signature check: passed.
- embedded `main.jsbundle`: Hermes bytecode version 96.
- no process was listening on Metro port 8081.

Artifact:

`/tmp/manasplit-device-derived/Build/Products/Release-iphoneos/SplitCircle.app`

The final standalone Apple Development-signed Release was installed and
launched on:

- iPhone 17 Pro, install container
  `14C6E757-2B07-4CF6-B75E-B3A137B3F9EB`;
- iPhone 13 mini, install container
  `6E7EE3A5-CA78-4267-AA57-5F2460987E9A`.

Compilation and installation validate the code path but cannot simulate two
people composing messages. The required acceptance check is Phase 0's 20
alternating messages per direction while both phones remain offline, followed
by an Internet reconnect and duplicate/cloud-policy check.
