# ManaSplit offline-first research and implementation plan

Status: researched and validated against this checkout on 2026-07-28. This is
a living plan. The first cold-boot and nearby-message slice began on
2026-07-28. The two-phone 2026-07-29 incident and correction are documented in
`2026-07-29_NEARBY_MESSAGING_INCIDENT.md`; that document is authoritative for
the cache-only Signal path and stalled-session recovery.

## Implementation progress

Implemented in the first slice:

- Cached auth now releases the navigator immediately during a killed-app,
  network-free launch. Empty cached group/chat states also release their
  loading gates.
- Chat-thread metadata is durably mirrored per account, so locally stored
  message bodies remain navigable after a cold offline boot.
- Empty `fromCache` Firestore snapshots can no longer erase the application
  caches while offline.
- The public Signal device directory and local Signal device id are persisted
  so identity signatures and established sessions remain usable after a cold
  process start.
- `splitcircle-mesh` provides an iOS MultipeerConnectivity transport with
  mandatory MCSession encryption, reliable delivery and deterministic
  discovery/invitation behavior.
- Nearby message bodies are signed by the origin's Signal identity and their
  private fields are encrypted separately for eligible recipient devices.
  Nearby non-members see ciphertext, not chat plaintext.
- Every group member is in the signed audience. A broadcast reaches all
  currently connected members; newly seen envelopes are re-broadcast once to
  bridge a partial A-to-B-to-C topology.
- Originated group messages are durably queued and use the normal
  RTDB/Signal/Firebase chat path when Internet returns. Direct nearby messages
  deliberately have no cloud-relay flag.

Current slice limitations:

- A signed-in account must have completed at least one online run of this
  version to populate the new thread cache. Data that an older build never
  stored locally cannot be reconstructed without a server.
- Nearby delivery currently supports JSON-sized messages whose usable content
  is already local (text/location/cards). Attachment byte transfer, progress,
  resumable chunks and hashes are not implemented yet.
- A recipient needs a previously established Signal session and cached public
  device identity. The app refuses unsigned or undecryptable nearby data.
- Only the originating device uploads its group message to Firebase. Relaying
  a signed origin message through another member's cloud connection requires a
  new server endpoint that can validate origin attestations without
  impersonating the sender; that remains a later hardening task.
- The new native module requires a native iOS build and two-device physical
  validation. It is optional at runtime: builds without the module safely
  retain the durable cloud queue.

## Decision

ManaSplit can be made **fully useful with no Internet after an initial local
profile exists**, but it cannot deliver messages, synchronize with another
device, receive a push, join a LiveKit call, resolve a map/place, upload media,
or use cloud AI without a transport. No client-side cache can change that.

The product requirement therefore needs three explicit radio states:

| Mode | Meaning | Feasible result |
| --- | --- | --- |
| All radios off | No Internet and no local radio transport. | One device can read/edit cached data and durably queue remote effects. |
| Airplane Mode with Wi-Fi and Bluetooth re-enabled | No Internet, but Apple peer-to-peer Wi-Fi is available. | Nearby members exchange signed/encrypted messages directly with no hotspot or router. |
| Internet available | Cloud transport is reachable. | Pending originated group messages relay through the normal cloud path. |

Personal Hotspot is not a required mode. It shares cellular Internet and can be
unavailable when cellular service/data is absent. The native Multipeer
Connectivity transport automatically enables Apple peer-to-peer Wi-Fi, which
Apple documents as independent of cellular.

Do not describe either as "messages work offline" unless the UI says whether a
message is **saved locally**, **sent nearby**, or **server-delivered**.

## What exists today

The app is already partially local-first:

- `localMessageStorage.ts` stores per-chat messages in AsyncStorage; media is
  held in the app file system.
- `GroupContext.tsx` hydrates cached groups and keeps an AsyncStorage outbox for
  *new expenses* and *settlements*. It replays only when NetInfo says Internet
  is reachable.
- Firebase Auth is deliberately persisted in AsyncStorage.
- Search, drafts, themes, call history, selected AI state, and backup staging
  also have on-device stores.

The audit also found hard online dependencies:

| Capability | Current dependency | Offline gap |
| --- | --- | --- |
| Login, registration, reset, account deletion | Firebase Auth / Functions | A new identity cannot be created or verified offline. A retained session can open, but token refresh/expired credentials cannot. |
| Groups, chat list, profile, settings, expense edits/deletes, friends, recurring bills | Firestore listeners and writes | Native Firestore JS initialization is memory cache only. Cached groups are application-managed, but chats and most metadata are not durably mirrored. |
| Sending/receiving messages, receipts | RTDB queue | A sender can display local optimism, but no other device can receive it offline. Queue writes do not survive a network-less delivery path. |
| Attachments, avatars, receipts | Firebase Storage | Files can be retained locally but cannot be shared until uploaded; downloaded remote media must have a local cache. |
| Calls and incoming call UI | RTDB signaling, Functions token, LiveKit, PushKit/APNs | A LiveKit room requires signaling plus a reachable SFU. Push cannot arrive without a network. |
| Remote AI, OCR, link previews, places/maps, backup and device pairing/history handoff | Google/Functions/HTTP/Firebase | Must be explicitly unavailable/deferred or replaced by a packaged on-device model/data set. |

## Research and validation

### Firestore is not the missing persistence layer

Firebase documents offline persistence for its Apple/Android native SDKs and
the web SDK, including locally queued writes. The installed app uses the
Firebase **JavaScript** SDK (`firebase@11.10.0`) in React Native, not the
native Firestore SDK. In this checkout, `src/firebase/firebaseConfig.ts`
configures `persistentLocalCache()` only for `Platform.OS === 'web'`; native
initializes Firestore with long polling only. The existing outbox comment and
implementation correctly recognize native writes as non-durable across a kill.

This rules out the tempting "turn on Firestore persistence" solution. Moving
to React Native Firebase/native Firestore is possible, but would be a native
dependency migration, still would not make RTDB, Storage, LiveKit, APNs, or
cloud functions work without a network, and must be evaluated separately.

Firebase's offline documentation also says cached reads can be incomplete and
that multi-write conflicts are last-write-wins. It is a cache, not a
conflict-free source of truth. The operation log below is needed even if a
native Firestore migration is later chosen.

### SQLite is the right local source of truth

The installed Expo SDK 55 already includes `expo-sqlite@55.0.10`. Expo documents
that its SQLite database persists across app restarts and supports migrations,
prepared statements, and change listeners. It is a better fit than a growing
set of AsyncStorage JSON blobs: transactions, indexes, atomic outbox writes,
pagination, and recoverable schema upgrades are all required for a chat/ledger.

Keep files outside SQLite; store only a local file id, checksum, MIME type and
transfer state. Encrypt database/file contents with a per-account key in
Keychain/SecureStore (or use an evaluated encrypted-SQLite solution). Do not
put the primary database encryption key in AsyncStorage.

### Calls and cross-device delivery have a physical constraint

LiveKit's client protocol joins rooms through a WebSocket and WebRTC peer
connections to an SFU. In the current product, a Function mints tokens and
RTDB plus APNs/PushKit supplies signaling. With no reachable network, there is
no server, token refresh, push delivery, rendezvous, or relay. A local cache
cannot create a call between separate devices.

If nearby offline calling/messaging is a product requirement, evaluate an iOS
native `MultipeerConnectivity` bridge (Bluetooth/Wi-Fi) with explicit nearby
permission, QR/contact pairing, encrypted operation exchange, duplicate
suppression, and foreground-only expectations. It is a new product surface,
not a fallback toggle for LiveKit. It must never claim delivery once a peer
leaves radio range.

## Target architecture

Make SQLite the sole source for all UI reads and all mutations. Cloud services
become synchronization transports.

```text
UI action
  -> SQLite transaction: entity projection + immutable operation + file record
  -> UI observes SQLite immediately (works with radio disabled)
  -> Sync coordinator, only when a transport is available
       -> Firebase/RTDB/Storage OR the implemented nearby mesh
       -> server acknowledgement / remote operation
  -> SQLite transaction: mark operation acked + apply deduplicated remote op
```

### Minimum schema

- `entities`: normalized profiles, groups, members, chats, messages, expenses,
  settlements, settings and tombstones; every row has `updatedAt`, `deletedAt`,
  `revision`, and local/server ids as appropriate.
- `operations`: immutable `opId`, device id, entity id/type, mutation payload,
  causal parent/revision, creation time, state (`pending`, `in_flight`,
  `acked`, `rejected`, `conflicted`), retry schedule, and error.
- `attachments`: local path, SHA-256, encryption metadata, upload state and
  remote URL; never delete an unsynced local file.
- `sync_cursors` and `remote_dedupe`: per transport/account cursor and received
  op ids. All writes must be idempotent.
- `migration_state` and `integrity`: resumable migration checkpoint, database
  version, and checkpoint/checksum records.

Use operation semantics rather than full-document replacement. Examples:
`expense.create`, `expense.edit-field`, `expense.delete`, `settlement.create`,
`message.send`, `message.edit`, `message.delete`, `chat.mark-read`. Preserve
server security rules as authorization; a rejected operation remains visible as
actionable local state, not silently discarded.

### Conflict policy must be product-defined

- Additive objects use immutable ids and de-duplication.
- Reads/reactions are grow-only per-user sets; removals need a versioned/remove
  operation, not an array overwrite.
- Independent scalar fields use a per-field logical clock plus deterministic
  device-id tie break. Same-field edit conflicts must show a review UI for
  money amounts, participants, settlements, membership, and deletion.
- Never use last-write-wins for monetary split calculation or membership
  changes without showing the user what was superseded.

## Critique of the proposed direction

1. **"Firebase offline support" alone is insufficient.** It does not cover
   the transport-dependent features and, in this React Native JS setup, is not
   a native persistent Firestore cache. It would also leave multiple competing
   local stores with no atomic transaction spanning entity, outbox and file.
2. **AsyncStorage is no longer suitable as the primary ledger.** It is useful
   for small settings and the present emergency queue, but serialized whole
   chat/group blobs do not provide efficient queries, migrations, quotas,
   foreign-key-like integrity, or crash-atomic mutation and enqueue.
3. **A cache is not an offline product.** Cached server snapshots can be stale
   or incomplete. The UI must show data freshness and each operation's sync
   state; it must never call a local draft "delivered".
4. **Full offline from first launch is intentionally out of scope.** A user
   needs a locally generated identity/imported encrypted backup before the app
   can have data. Existing Firebase account creation and recovery necessarily
   need Internet. Decide whether a true local-only profile is a supported,
   non-cloud account type; do not accidentally create one.
5. **Offline mesh is expensive and limited.** The implemented first slice adds
   native discovery, signed/encrypted envelopes, dedupe/gossip, durable group
   cloud relay, and visible connection state. It still needs two-phone radio
   validation, foreground expectations, attachment transfer, and eventual
   migration from deprecated Multipeer Connectivity.

## Implementation plan

### Phase 0 — contract and measurement (1 sprint)

1. Approve the two-mode wording and capability matrix above. Define retention,
   per-account storage quota, local-profile policy, and conflict UX.
2. Add a central `ConnectivityService` with `offline`, `internet`, and (later)
   `nearby` transport states. Replace ad-hoc NetInfo checks.
3. Instrument only local diagnostic counters: pending age/count, conflict and
   rejection count, database size, sync duration. Do not send analytics while
   offline; upload only with consent on reconnect.

Exit: all online-only actions render a truthful disabled/deferred state and no
offline action waits indefinitely on a network promise.

### Phase 1 — local data foundation and migration (2–3 sprints)

1. Add `LocalRepository` backed by Expo SQLite, migrations, transactions,
   repository interfaces and a test database factory.
2. Import existing AsyncStorage groups, local messages, drafts, media indexes,
   local call history, and current outbox in resumable batches. Keep legacy
   reads only as a rollback fallback until a verified migration marker exists.
3. Move all list/detail screens to repository subscriptions. Add indexed
   message pagination and local search.
4. Atomically project a mutation and append an operation in the same SQLite
   transaction. Move the current expense/settlement outbox into `operations`.

Exit: turning on Airplane Mode before launch still opens a complete last-known
local home/groups/chats/ledger; force-killing after every mutation loses none.

### Phase 2 — sync engine and conflict UX (2–3 sprints)

1. Implement a single-flight, resumable per-account sync worker with backoff,
   idempotency keys, attachment transfer and remote-cursor pull.
2. Adapt Firestore/RTDB/Storage through an adapter; it translates operations
   to the present server schema initially. Do not issue cloud writes from UI
   contexts.
3. Add outbox details, retry/cancel, rejection and conflict screens. Surface
   state in messages and monetary records.
4. Migrate all remaining Firestore-mutating features (profile/settings,
   membership, recurring bills, message state) to operation writes.

Exit: network flapping, duplicate delivery, server rejection and conflict are
recoverable and explainable, with no duplicate money movement or message.

### Phase 3 — feature completion and hardening (1–2 sprints)

1. Cache downloaded media with quota/LRU protection; retain unsynced originals.
2. Add offline-safe fallbacks for search/statistics/recurring detection and
   explicitly defer OCR, link previews, maps, cloud AI, backup and pairing.
3. Add encrypted backup/export/import and recovery documentation; exercise
   database corruption and low-storage paths.
4. Update `OfflineSyncScreen` to report operation categories, stale-data time,
   attachment state and actionable failures rather than only two op types.

Exit: the app has a documented, supportable offline guarantee for every visible
feature.

### Phase 4 — nearby mesh hardening and transport migration

The first iOS Multipeer slice is implemented. Validate direct peer-to-peer Wi-Fi
with two physical iPhones that have cellular disabled and no joined Wi-Fi
network. Measure success at distance, background behavior, battery, reconnection,
and three-member gossip. Prototype Wi-Fi Aware on iOS 26+ with its entitlement
and system pairing UI, or Network framework with `includePeerToPeer`, before
retiring Multipeer. Calls remain a separate proof of concept.

## Tests and validation gates

### Automated tests to add with implementation

| Layer | Cases | Gate |
| --- | --- | --- |
| SQLite repository | migrations are idempotent/resumable; indexes; transaction rollback; legacy import does not duplicate | every PR |
| Operation log | mutation + op are atomic; force-kill/restart recovers pending op; dedupe and ordering; retry/backoff; cancel | every PR |
| Conflict reducer | concurrent field edits, delete-vs-edit, double settlement, reaction removal, clock tie break | every PR |
| Sync adapter | no requests in airplane mode; exactly-once visible effect under retries; rejection stays actionable; attachment hash/retry | emulator + CI |
| UI | cached-first boot, offline labels, deferred feature affordances, accessibility, conflict/retry flows | component/E2E |
| Security/recovery | account logout key wipe, encrypted export/import, wrong key, corrupt DB, quota/low disk | release candidate |

### Written now

`src/services/__tests__/outbox.persistence.test.ts` exercises the current
durable queue's insertion order, same-id replacement, update and explicit
clear behavior. It uses the project AsyncStorage mock, so it is a regression
test for the pre-migration safety net rather than evidence that the wider app
is offline-first.

### Device validation matrix (required before launch)

For each test, run on a physical iPhone with cellular and Wi-Fi disabled; then
force quit/relaunch at the marked points. Simulator network controls alone do
not validate background/push/file behavior.

1. Seed a signed-in account while online; disable all radios; relaunch. Verify
   last-known groups, chat list, messages, ledger, search and media are usable
   and marked as cached/stale where needed.
2. Create/edit/delete an expense, settlement, draft and message; kill after
   each database commit. Relaunch offline and verify exactly one local result
   plus a pending operation.
3. Re-enable network repeatedly during a 100-operation run. Verify eventual
   server convergence, no duplicate docs/messages, correct balances, and no
   lost attachment.
4. Make incompatible changes on a second device; reconnect both. Verify the
   documented conflict UI and preserve audit history.
5. Test expired auth, sign out, deleted remote group, failed Storage upload,
   full disk, corrupt database, app upgrade and rollback. All must preserve
   recoverability and clear user messaging.
6. Verify calls, pushes, places, previews and cloud AI say unavailable/deferred
   offline rather than spinning or reporting success.

## Sources

- [Firebase: Access data offline](https://firebase.google.com/docs/firestore/manage-data/enable-offline)
  — cache behavior, queued writes, cached-result limitations, conflict and
  network control semantics; accessed 2026-07-28.
- [Firebase JS environments](https://firebase.google.com/docs/web/environments-js-sdk)
  — supported Firebase JavaScript SDK environments; accessed 2026-07-28.
- [Firebase Auth React Native persistence](https://firebase.google.com/docs/reference/js/auth.md#getreactnativepersistence)
  — `getReactNativePersistence` wraps AsyncStorage; accessed 2026-07-28.
- [Expo SQLite SDK 55](https://docs.expo.dev/versions/v55.0.0/sdk/sqlite/)
  — persisted database, migrations/integration primitives and prepared-statement
  guidance; accessed 2026-07-28.
- [LiveKit client protocol](https://docs.livekit.io/reference/internals/client-protocol/)
  — room joining WebSocket and SFU WebRTC connections; accessed 2026-07-28.
