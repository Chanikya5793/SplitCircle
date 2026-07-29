# Offline nearby media sharing: research and implementation plan

Status: researched and validated against the ManaSplit checkout on 2026-07-29.
Implementation has not started. This document refines the media section in
`2026-07-29_NEARBY_PROTOCOL_V2_RESEARCH_AND_PLAN.md` into a buildable near-term
plan.

## Decision

ManaSplit can exchange these attachment types with no router, hotspot,
cellular connection, or Internet:

- photos and photo albums;
- videos;
- audio files and voice notes;
- supported documents, including PDF, Office documents, text and archives.

The existing iPhone-to-iPhone transport is already capable of moving file
resources. The missing work is the application protocol around the bytes:
authorization, end-to-end encryption, manifests, storage, progress, pause,
resume, receipts, group relay and later cloud convergence.

Location is not a media-transfer blocker. An iPhone can determine coordinates
from Core Location without Internet when satellite/radio positioning is
available, and the existing nearby text envelope can already carry a location
payload. Address lookup, map tiles and reliable positioning indoors may require
network data. Location remains outside this media slice because its product and
privacy behavior needs a separate review.

## Checkout findings

### Reusable pieces already exist

- `modules/splitcircle-mesh/ios/SplitCircleMeshModule.swift` has a working
  encrypted `MCSession`, reliable control-message send, peer discovery and
  connection recovery.
- The same native module already implements the required
  `MCSessionDelegate` resource callback signatures, but both resource callbacks
  are empty.
- `useMediaSendPipeline.ts` already creates an optimistic bubble, materializes
  iCloud assets, compresses images/video, reports progress, supports
  cancellation and produces a stable `requestId`.
- `mediaService.ts` already copies sender media into permanent app storage,
  sanitizes names and paths, validates a MIME allowlist, enforces the current
  100 MiB item cap, uploads to Firebase Storage and downloads remote media.
- Received messages already understand `localMediaPath`, `mediaDownloaded`,
  `mediaMetadata`, `mediaUrl` and stable message ids.
- The nearby application envelope already signs the origin and chat audience,
  encrypts private fields for eligible recipient devices, rejects non-members,
  deduplicates before Signal decrypt and gossips exact signed operations.

### Exact gaps

1. `ChatContext.sendMessage` only enters the offline nearby branch when
   `!mediaUri`. Any offline attachment therefore attempts a Firebase Storage
   upload and fails.
2. `buildMeshMessageBody` deliberately removes `localMediaPath`, correctly
   preventing one sandbox's path from being treated as another phone's file,
   but there is no replacement attachment manifest.
3. Native mesh has no file-send bridge, progress events, receive staging,
   cancellation or resource completion handling.
4. The nearby queue stores JSON operations in AsyncStorage. It has no durable
   per-blob/per-chunk state and is unsuitable for large or resumable transfers.
5. `flushMeshCloudRelay` currently fans out the group message before ensuring
   an offline attachment has been uploaded and assigned a `mediaUrl`.
6. Cloud-replayed messages need to merge the remote URL/status while retaining
   a valid nearby `localMediaPath`; otherwise a recipient may unnecessarily
   download a file it already has.
7. Photos or documents that exist only in iCloud/a remote File Provider cannot
   be sent while offline. No transport can send bytes that are absent from the
   phone. This must produce an immediate “not downloaded on this iPhone”
   error, not a spinner.

## Apple platform findings

### What can ship against the current working transport

`MCSession.sendResource(at:withName:toPeer:...)` sends a file URL
asynchronously to one connected peer, returns `Progress` for observation or
cancellation, and gives the receiver a temporary file URL. Apple requires the
receiver to move the temporary file before the completion delegate returns.
This maps cleanly to the existing native module and avoids copying attachment
bytes through the React Native bridge.

However:

- Multipeer Connectivity, `sendResource`, its resource delegate callbacks and
  its stream API are deprecated in the current SDK in favor of Network
  framework.
- Apple documents a maximum of eight peers in one `MCSession`, including the
  local phone.
- Multipeer sessions disconnect when an app moves to the background. Transfers
  must visibly pause and resume after both apps return; they are not background
  downloads.
- `sendResource` provides transfer progress and success/failure, but no
  application-level resume ledger, durable receipt, authorization or
  end-to-end attachment encryption.

Therefore `sendResource` is acceptable only as the first native **carrier** for
an application-owned chunk protocol. It must sit behind a transport interface
and must not define the media protocol.

### Long-term transport

Apple DTS recommends Network framework for Multipeer migrations, specifically
because Multipeer has poor throughput, no flow control and longstanding bugs.
Network framework can opt into peer-to-peer link technologies with
`NWParameters.includePeerToPeer = true`. Apple recommends disk-backed chunking,
waiting for send completion to provide backpressure, and chunks of at least
64 KiB; 1 MiB is reasonable on fast devices/networks.

On iOS 26+, Wi-Fi Aware provides authenticated, encrypted, high-throughput
peer-to-peer connections without an access point. It uses DeviceDiscoveryUI
for system pairing and Network framework for the data connection. It requires
the `com.apple.developer.wifi-aware` entitlement and declared
`WiFiAwareServices`.

Do not hard-code a phone-model list for Wi-Fi Aware. The official API exposes
`WACapabilities.supportedFeatures`, which is the authoritative runtime gate.
ManaSplit still targets iOS 15.1, so Network/Bonjour peer-to-peer and the
measured Multipeer fallback remain necessary.

## Product semantics

### Group chats

1. The origin saves the processed attachment and message locally.
2. Every connected, authorized group member may request and receive the
   encrypted blob.
3. A present member may relay the unchanged ciphertext chunks to another
   authorized present member. Relays never obtain a new sender identity and
   cannot change the signed manifest.
4. The origin retains a durable cloud-upload job.
5. When Internet returns, the origin uploads the canonical local attachment,
   adds the `mediaUrl` to the same stable message id, and fans it out through
   the existing RTDB/Signal path.
6. Members who already received the bytes nearby merge the cloud URL and
   delivery state while keeping their local file. Absent members receive the
   normal cloud message and download from Storage.

Only the origin uploads in v1. A relay cannot impersonate the sender in the
current cloud protocol. If the origin is lost before reconnecting, other
members keep their nearby copies but the attachment will not reach absent
members through the cloud. A future server endpoint could accept an
origin-signed relay without sender impersonation; that is not required for the
first release.

### Direct chats

- Direct attachments remain local-only, matching the accepted direct-message
  policy.
- They transfer only while an authorized peer is nearby.
- They never enter Firebase Storage or the group cloud relay.
- An interrupted transfer remains “Waiting for nearby phone” and resumes when
  the same devices meet again. The user may cancel or manually retry.

### Honest status vocabulary

- **Preparing**: materializing/compressing and copying to permanent local
  storage.
- **Waiting nearby**: secure manifest exists, but no intended peer is ready.
- **Sending nearby — N%**: encrypted chunks are moving.
- **Received nearby**: the receiver verified, decrypted and atomically
  committed the file.
- **Queued for cloud**: group origin still owes the normal cloud upload.
- **Cloud synced**: the group message and URL converged through the server.
- **Paused — open ManaSplit on both phones**: iOS disconnected the foreground
  peer session.

Transport handoff is not a delivery receipt. A two-check state requires a
signed application receipt after durable file commit.

## Protocol v1

### Control plane and data plane

Keep small signed JSON/Signal envelopes on the existing reliable control
channel. Never base64 a photo or video into that envelope; it is capped at
256 KiB and would multiply memory and payload size.

Use the native resource/stream carrier only for encrypted chunk files:

```text
signed MESSAGE + encrypted attachment key/manifest reference
  -> BLOB_OFFER(manifest)
  <- BLOB_WANT(missing chunk ranges, receive credit)
  -> encrypted chunk resources
  <- CHUNK_ACK / BLOB_COMMITTED
```

The same frame semantics later map to `NWConnection` without changing chat,
storage or receipt logic.

### Manifest

Use a random attachment id rather than a plaintext content hash as the public
blob id. A plaintext content-address leaks that two messages contain the same
file.

```text
protocolVersion
attachmentId: random 128 bits
messageId / chatId hash / origin ids
kind: image | video | audio | file
safe filename, MIME, logical size
width, height, duration and album metadata where applicable
chunkSize / chunkCount
perChunkCiphertextSHA256[]
wholeCiphertextSHA256
thumbnail attachment id, if any
createdAt / expiry
```

The signed public portion is bounded and contains no local path. The 256-bit
attachment key, nonce seed and any sensitive caption/metadata are included in
the existing per-device Signal-encrypted fields.

### Encryption and integrity

- Generate a new random 256-bit key per attachment.
- Process the file natively in bounded chunks; never load a whole video into
  JS or one `Data` value.
- Seal each chunk with AES-256-GCM or ChaCha20-Poly1305.
- Derive a unique nonce from a random per-attachment nonce seed plus the
  32-bit chunk index. Reject a manifest whose chunk count could overflow the
  nonce space.
- Authenticate protocol version, attachment id, message id, chunk index,
  chunk count and immutable manifest metadata as AEAD associated data.
- Include per-chunk ciphertext SHA-256 for cheap pre-decrypt corruption checks
  and exact resume identity. Verify the final digest before commit.
- Keep staging chunks encrypted. Decrypt into a new app-owned file only after
  authorization and validation, then atomically rename it into
  `MEDIA_DIRECTORY`.
- Apply iOS Data Protection to permanent and staging files.

The radio link's encryption is useful but insufficient. Application-layer AEAD
keeps relayed chunks opaque to unauthorized nearby apps and binds every chunk
to the signed message.

### Chunking, scheduling and resume

Initial defaults:

- 1 MiB plaintext chunks (64 KiB minimum if measurement requires smaller
  chunks);
- one chunk in flight per peer on the Multipeer carrier;
- two active peer transfers globally on the first release;
- 100 MiB per item, matching the existing media/upload limit;
- sender checks receiver-advertised free space and credit before sending;
- compact missing ranges/bitmaps persisted after every verified chunk;
- thumbnails/previews have priority over full blobs;
- retries use capped exponential backoff with jitter;
- duplicate chunks are acknowledged and discarded without a second write;
- incomplete direct transfers retain resumable state until cancellation or
  explicit expiry; unsynced group-origin files are never automatically purged.

For the Multipeer compatibility carrier, each encrypted chunk is a resource
file. The receiver moves the temporary resource into the encrypted staging
directory inside the delegate callback, verifies it, updates the durable
bitmap and then sends an ACK. A reconnect requests only missing chunks.

For Network framework, stream the same chunk records from disk and wait for
each send completion before reading the next chunk. Receive directly to disk
to avoid unbounded memory and iOS jetsam termination.

### Durable store

Add a small SQLite-backed `nearby_transfer` store rather than extending the
AsyncStorage JSON queue:

```text
attachments(
  attachmentId, messageId, chatId, originUserId, localPath,
  manifestHash, size, chunkSize, chunkCount, direction,
  state, cloudState, createdAt, updatedAt, lastError
)

attachment_chunks(
  attachmentId, chunkIndex, ciphertextHash, state, peerId, updatedAt
)

attachment_peers(
  attachmentId, peerId, offeredAt, requestedAt, committedAt,
  acknowledgedRanges, retryCount
)
```

State changes and message projection must be crash-safe. Store only paths and
metadata in SQLite; bytes remain in files.

## UI behavior

- The existing media preview and compression UI stays unchanged.
- The message bubble appears immediately from the sender's local file.
- A route label distinguishes Nearby from Cloud and a progress ring displays
  byte progress.
- The recipient sees the verified message/thumbnail before the full video or
  document completes.
- Automatically accept a tiny verified thumbnail when quota permits.
- Full files auto-receive when the conversation is open and storage permits;
  otherwise show “Download nearby · 42 MB”. This prevents a present group
  member from forcing large writes to every phone.
- Pause and Cancel are real native operations. Cancel removes staging chunks
  but never removes a completed chat file without a separate delete action.
- Low-disk, missing-local-source, unsupported-type, peer-left and integrity
  errors receive distinct actionable copy.

## Implementation plan

### Phase 0 — contracts and store

1. Add versioned attachment manifest/control types with strict size/count/MIME
   validation.
2. Extend the per-device Signal-encrypted fields with attachment key material.
3. Add the SQLite transfer repository, migrations and crash-safe state
   transitions.
4. Export one shared attachment size/MIME policy from `mediaService`; the
   picker, nearby receiver and cloud uploader must agree.
5. Add feature flags and redacted diagnostics.

Exit: manifests and transfer state survive a process kill; malformed input
cannot allocate files or enter Signal decrypt.

### Phase 1 — native encrypted blob engine

1. Add native incremental SHA-256 and chunk AEAD using CryptoKit.
2. Add staging directory creation, free-space checks, file protection, atomic
   commit and cleanup.
3. Bridge `prepareAttachment`, `receiveChunk`, `decryptAndCommit`, `pause`,
   `cancel` and progress events without moving bytes through JS.
4. Add known-answer, tamper, wrong-key, nonce-uniqueness and large-file memory
   tests.

Exit: a 100 MiB local fixture encrypts/decrypts byte-for-byte with bounded
memory and survives interruption.

### Phase 2 — Multipeer compatibility carrier

1. Implement chunk `sendResource` and both currently empty resource delegate
   callbacks.
2. Move temporary received files before the delegate returns.
3. Persist progress from native events; implement missing-range request,
   per-peer ACK, reconnect resume and cancellation.
4. Keep all new code behind a `NearbyBulkTransport` interface.

Exit: both current physical phones transfer 1 KiB, 1 MiB, 25 MiB and 100 MiB
fixtures in both directions; a mid-transfer disconnect resumes without
restarting completed chunks.

### Phase 3 — chat/media integration

1. Refactor `ChatContext.sendMessage` so offline media stages locally and
   creates a nearby operation instead of calling Firebase.
2. Reuse the existing optimistic bubble, album ordering and media metadata.
3. Add receiver placeholder/thumbnail/progress and atomic local-message commit.
4. Add pause/resume/cancel/retry and explicit nearby delivery receipts.
5. Handle iCloud-only Photos/File Provider items before transfer setup.

Exit: photos, albums, videos, audio and supported documents render/play/open
from the receiver's local path with truthful status.

### Phase 4 — group cloud convergence

1. Change the group relay into `upload attachment -> persist mediaUrl in the
   same operation -> message fan-out -> chat metadata update`.
2. Retry each stage idempotently with the stable message/storage path.
3. Merge cloud echoes without overwriting a valid nearby local file.
4. Prove direct attachments never enter Storage/RTDB.

Exit: an offline group attachment reaches present peers immediately, then
appears once to absent members after reconnect; direct attachments remain
absent from cloud storage and queues.

### Phase 5 — Network framework carrier and hardening

1. Implement Network/Bonjour TLS with `includePeerToPeer`, disk-backed flow
   control and deterministic duplicate-connection arbitration.
2. Add Wi-Fi Aware + DeviceDiscoveryUI when runtime capability and entitlement
   permit.
3. Keep Multipeer as a measured fallback until the physical matrix proves the
   replacement.
4. Fuzz manifests/control frames and complete privacy, accessibility, thermal,
   battery and quota review.

Exit: the media protocol passes unchanged over either carrier and the app can
retire deprecated Multipeer without changing chat data.

## Validation plan

### Automated

- strict manifest version, size, MIME, chunk-count and path validation;
- random attachment id and nonce uniqueness;
- AEAD round-trip and rejection of altered ciphertext, tag, AAD or key;
- incremental SHA-256 and final byte equality;
- out-of-order, duplicate and missing chunks;
- crash after temp move, hash verify, bitmap commit and final rename;
- resume-range encoding and ACK loss;
- peer leaves during offer, chunk and commit receipt;
- cancellation and staging cleanup;
- low disk/quota and declared-size mismatch;
- same attachment offered by multiple relay peers;
- group upload/fan-out idempotency;
- cloud echo preserves `localMediaPath`;
- direct-media no-cloud invariant;
- replay rejection before Signal decrypt or file allocation.

### Physical iPhone matrix

Use the iPhone 17 Pro and iPhone 13 mini, then add a third member:

1. Send photo, 10-item album, video, audio, PDF and document in both
   directions with Airplane Mode on and Wi-Fi/Bluetooth restored.
2. Test 1 KiB, 1 MiB, 25 MiB and 100 MiB fixtures.
3. Move out of range and return at 10%, 50% and 95%.
4. Toggle Wi-Fi; force-kill sender, receiver and both; relaunch offline.
5. Lock/background each phone. Verify the UI pauses rather than claiming
   background delivery, then resumes in foreground.
6. Cancel and retry; exhaust disk quota; corrupt one ciphertext chunk.
7. Relay through A-B-C where A and C cannot directly connect.
8. Restore Internet. Verify one cloud copy for a group and zero cloud copies
   for a direct chat.
9. Verify absent group members receive the cloud attachment; present members
   keep the nearby file and do not redownload.
10. Compare source/receiver SHA-256, open every document through Quick Look and
    play media to completion.

Record connection time, manifest-to-first-byte latency, throughput, resume
latency, peak memory, energy/thermal state and stable error codes. Never log
filenames, chat/user ids, plaintext, ciphertext or keys in analytics.

## Critique and risks

1. **Whole-file `sendResource` would be quick but not flagship quality.** It
   has progress/cancel but no durable partial resume. Chunk resources are more
   work but preserve completed data after disconnects.
2. **Building directly on deprecated Multipeer creates migration debt.** The
   compatibility carrier is justified because it already works on the two test
   phones, but protocol, crypto, storage and UI must not import Multipeer
   concepts.
3. **Wi-Fi Aware is not a transparent replacement.** It needs entitlement,
   runtime capability and a system pairing experience. It is a preferred
   carrier, not a reason to block media on the existing devices.
4. **Transport encryption alone is not end-to-end security.** Every chunk
   needs application AEAD and keys must travel only in existing Signal
   envelopes.
5. **Cloud sync ordering is a data-loss edge.** Publishing a message before its
   blob is uploaded can strand absent group members. The relay must persist
   each stage and never drop an unsynced origin file.
6. **Automatic group download is an abuse/storage risk.** Verify membership
   before file allocation, enforce quotas and require a tap for large or
   off-screen transfers.
7. **Current cloud media is not application-E2E encrypted.** The first media
   release should preserve the existing Firebase Storage format for
   compatibility while using E2E encryption over nearby. Uploading the same
   encrypted blob to cloud is a valuable separate migration because every
   cloud download/render path would need decryption and key handling.
8. **Foreground is a product constraint, not an implementation bug.** iOS
   disconnects Multipeer sessions in the background. The UI must say both apps
   need to stay open and resume cleanly.

## Primary sources

- Apple, `MCSession.sendResource`:
  <https://developer.apple.com/documentation/multipeerconnectivity/mcsession/sendresource(at:withname:topeer:withcompletionhandler:)>
- Apple, `MCSession`:
  <https://developer.apple.com/documentation/multipeerconnectivity/mcsession>
- Apple, Multipeer background behavior:
  <https://developer.apple.com/documentation/multipeerconnectivity>
- Apple DTS, moving from Multipeer Connectivity to Network framework:
  <https://developer.apple.com/forums/thread/776069>
- Apple, `NWParameters.includePeerToPeer`:
  <https://developer.apple.com/documentation/network/nwparameters/includepeertopeer>
- Apple, Wi-Fi Aware paired connections:
  <https://developer.apple.com/documentation/wifiaware/connecting-paired-devices>
- Apple, `WACapabilities`:
  <https://developer.apple.com/documentation/wifiaware/wacapabilities>
- Apple, Wi-Fi Aware entitlement:
  <https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.wifi-aware>
- Apple, DeviceDiscoveryUI:
  <https://developer.apple.com/documentation/devicediscoveryui>
- Apple, WWDC25 Wi-Fi Aware:
  <https://developer.apple.com/videos/play/wwdc2025/228/>
- Apple, CryptoKit:
  <https://developer.apple.com/documentation/cryptokit/>
- Apple, iterative SHA-256:
  <https://developer.apple.com/documentation/cryptokit/sha256>
- Apple, AES-GCM:
  <https://developer.apple.com/documentation/cryptokit/aes/gcm>

## Non-negotiable invariants

1. No attachment bytes cross the React Native bridge.
2. No Firebase request gates offline preparation, send, receive or resume.
3. Authorization and replay rejection happen before file allocation or Signal
   decrypt.
4. Every chunk is bounded, application-encrypted and authenticated.
5. A completed file is visible only after final verification and atomic commit.
6. Group-origin media eventually uploads exactly once; direct media never
   uploads.
7. A nearby/cloud duplicate never discards a valid local file.
8. Unsynced group-origin media is never removed by automatic cache cleanup.
9. Background/interruption states pause truthfully and resume from durable
   state.
10. Multipeer is a replaceable carrier, not the protocol architecture.
