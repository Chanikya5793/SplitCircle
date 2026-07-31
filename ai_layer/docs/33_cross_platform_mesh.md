# 33 — Cross-platform mesh: transport, routing, crypto parity, and the nearby UI

Status: **DESIGN — decisions LOCKED 2026-07-31, nothing built.** Supersedes the
transport assumptions in [doc 32](32_nearby_messaging_offline_sync.md), whose
fixes remain correct but apply only to the iOS-only stack described there.

This is a rebuild of the offline layer, not an integration pass. The reason is
one hard constraint, established before anything else was decided.

## 0. The constraint that forces a rebuild

`modules/splitcircle-mesh/ios/SplitCircleMeshModule.swift` imports exactly one
framework: **MultipeerConnectivity**. MPC runs over Apple Wireless Direct Link,
a proprietary protocol with no Android client, no published wire format, and no
bridge. An Android device cannot join an MPC session under any circumstance.

So "make nearby work across Android and iOS" cannot be done by extending the
current module. It requires a **new common transport beneath a transport
abstraction**, with MPC demoted from *the* implementation to *one* fast path.

Three further facts, all verified in code rather than assumed:

1. **There is no routing layer.** No hop count, no TTL, no forwarding table, no
   neighbour state. `broadcastQueuedNearbyMessages` re-sends an envelope whose
   `recipientDeviceIds` were frozen at seal time (doc 32 §5e), which is why a
   device added to a thread afterwards can never receive that message. The
   "switches and routers" this doc is asked for genuinely do not exist yet.
2. **`splitcircle-crypto` is iOS-only.** `isCryptoAvailable()` returns false on
   Android, `encryptMessageForRecipient` returns null, and `queueMessage` then
   sends **plaintext** (doc 32 §10, CLAUDE.md). Android has no Signal sessions
   at all. This is a hard prerequisite for every other Android feature here.
3. **Nearby UI is per-chat only.** `NearbyMessagingSheet` (1062 lines) and
   `NearbyDiscoveryArena` (566) live inside a chat; there is no global surface,
   no topology view, and mesh state is a single-slot `lastMessageEvent` that the
   next event overwrites.

## 1. Locked decisions (2026-07-31)

Answered as MCQs in chat, same convention as doc 31 §1. These are settled.

1. **Transport: BLE + local-network hybrid, MPC retained as an iOS↔iOS fast
   path.** BLE GATT is the universal floor (iOS CoreBluetooth ↔ Android
   BluetoothLE, no infrastructure); mDNS+TCP carries bulk when a shared LAN or
   hotspot exists. This is the AirDrop/Briar two-tier shape: cheap ubiquitous
   discovery plus an opportunistic fast pipe.
2. **Android reaches full parity** — `splitcircle-crypto` on libsignal's
   JVM/Android bindings first, then mesh, then history sync.
3. **Payloads: text + small media over any transport; full-size media only over
   a fast path** (LAN or MPC), queued otherwise with explicit UI state.
4. **Routing: flood with dedup + TTL + store-and-forward.** No routing tables.
   Robust to churn, nothing to go stale, and the failure mode is redundant
   traffic rather than silent black-holing.

### 1a. What decision #4 costs, stated plainly

Flooding was chosen over link-state despite this doc also being asked for a
"full mesh topology built into the app". Those pull in opposite directions and
the tension is resolved as: **route by flooding, VISUALISE by observation.**
The topology view renders neighbours actually seen and hops actually taken,
derived from received traffic — it does not drive routing. A displayed graph
that also had to be correct enough to route on is exactly the stale-table
failure mode decision #4 exists to avoid.

## 2. Architecture

### 2.1 Layering

```
  ChatContext / meshMessageQueue / meshCloudRelay      (unchanged contracts)
        │
        ▼
  ROUTER      flood + dedup + TTL, store-and-forward, per-peer ack
        │
        ▼
  SWITCH      transport selection, per-payload-class policy, failover
        │
   ┌────┴────────────┬──────────────────┐
   ▼                 ▼                  ▼
  BLE            LAN (mDNS+TCP)      MPC (iOS↔iOS)
 universal        fast, needs LAN     fastest, Apple-only
```

Naming follows the user's own framing: **transporters** are the three link
implementations, the **switch** picks among them per payload, the **router**
decides where a message goes next and when to give up.

### 2.2 Transporter contract

One interface, three implementations, shared by both platforms:

```ts
interface MeshTransport {
  readonly id: 'ble' | 'lan' | 'mpc';
  readonly mtu: number;              // bytes per frame after headers
  readonly throughputClass: 'slow' | 'fast';
  start(identity: LocalNode, trusted: TrustedSet): Promise<void>;
  stop(): void;
  neighbours(): NeighbourState[];    // drives BOTH the switch and the UI
  send(frame: Frame, to: NodeId): Promise<SendOutcome>;
  onFrame(cb: (frame: Frame, from: NodeId) => void): Unsubscribe;
  onNeighbourChange(cb: (n: NeighbourState[]) => void): Unsubscribe;
}
```

`onNeighbourChange` is mandatory for every transport and must fire on **every**
state transition. Doc 32 §5f is the precedent: `updateTrustedPeers` mutated
trust and emitted only `onStateChanged`, so the one listener that triggers
rebroadcast never fired and queued messages sat unsent. A transport that
changes reachability without announcing it is broken by definition.

### 2.3 Frame format

Transport-agnostic, sized for the BLE floor:

| Field | Bytes | Notes |
|---|---|---|
| `ver` | 1 | wire version |
| `msgId` | 16 | UUID; the dedup key, stable across hops |
| `ttl` | 1 | decremented per hop, dropped at 0 |
| `origin` | 16 | origin node id |
| `dest` | 16 | destination node, or broadcast sentinel for group |
| `fragIdx`/`fragCnt` | 2+2 | fragmentation, required under BLE MTU |
| `payload` | ≤ MTU−54 | opaque ciphertext — routers never see plaintext |

**Routers operate only on the header.** The payload stays sealed end-to-end, so
a relay learns `(origin, dest, size, time)` and nothing else. That metadata
exposure is inherent to any relay mesh and must be stated in the UI copy.

### 2.4 Router

- **Dedup:** LRU seen-set keyed on `msgId`, persisted so a restart does not
  re-flood. Reuses `claimMeshMessageProcessing`'s semantics, which doc 32 §4
  confirms are already well tested.
- **TTL:** default 4 hops. Enough for a room; bounded against flood storms.
- **Store-and-forward:** unreachable destination → hold and retry on every
  neighbour change, capped by the existing 7-day TTL.
- **Backpressure:** BLE saturates fast; queue is per-neighbour with a byte cap
  and drops lowest-priority payload class first (bulk media before text).
- **Acks:** per-hop delivery ack, plus the end-to-end `undecryptable` receipt
  doc 32 §5c already added. Per-hop ack is a routing signal, never a UI claim —
  conflating transport ack with delivery is precisely the bug doc 32 §10.1 hit.

### 2.5 Re-sealing, and the one thing that must not regress

Doc 32 §5e documented that a device added to a thread after an envelope was
sealed can never receive it, because relays forward frozen ciphertext. A real
router makes this worse (more hops, more chances to be the excluded node), so
this doc adopts the re-seal path §5e deferred:

**Only the ORIGIN re-seals.** On learning of a new recipient device, the origin
produces a new envelope for that device and injects it as a new message. A
relay must never mint ciphertext attributed to another sender — that is
forgery, and `originOwned` (doc 32 §5a) remains the guard. The cost is that
re-sealing requires the origin to be reachable; store-and-forward covers the
gap.

## 3. Crypto parity — the gating prerequisite

Android must implement the exact surface `modules/splitcircle-crypto/index.ts`
exports, all 13 functions, with byte-identical wire behaviour: `bootstrapSignalIdentity`,
`hasSignalIdentity`, `generatePublishableBundle`, `establishSession`,
`hasSession`, `encryptForDevice`, `decryptFromDevice`, `signWithIdentity`,
`verifyWithIdentity`, `sealToIdentity`, `openWithIdentity`, `wipeSignalState`,
`isCryptoAvailable`.

Signal publishes Android bindings for the same libsignal used on iOS, so the
protocol is shared rather than reimplemented. **This needs a linkage spike
before anything is scheduled around it** — doc 31 Phase 3 burned real time on
exactly this for iOS, and CLAUDE.md's LibSignalClient gotcha (a pod whose
`OTHER_LDFLAGS` were silently discarded, shipping a build that crashed before
JS) is the standing warning that "it compiles" proves nothing about linkage.

Gate 1 for Android is the same shape: generate a bundle, establish a session,
round-trip a ciphertext **iOS↔Android on real hardware**, before any mesh work
depends on it.

## 4. UI revamp

### 4.1 Universal nearby settings

New top-level Settings surface, replacing per-chat-only controls:

- Master switch, plus per-transport toggles (Bluetooth / Wi-Fi / iOS direct).
- Paired-device list with trust management and revocation.
- Discoverability mode and a plain-language explanation of what relaying
  exposes (§2.3's metadata note).
- Diagnostics: transports up, neighbour count, queue depth, last error —
  replacing today's single-slot `lastMessageEvent`, which is overwritten by the
  next event and visible only if the user happens to have the sheet open.

### 4.2 Topology view

Live graph of this node, its neighbours, and hops observed from received
traffic — per §1a, observed and not authoritative. Per-link transport badge and
signal quality; tap a node for trust state and last-seen. This is the honest
version of "full mesh topology in the app": it shows what the mesh is doing
without pretending the picture is a routing table.

### 4.3 Per-message truth

Delivery states become explicit and distinguishable: queued → in flight →
relayed (n hops) → delivered → **undelivered/failed**. Doc 32 §10.1's lesson is
that a confident tick on an undelivered message is worse than a visible
failure.

## 5. Sequenced build order

Each phase is independently shippable and ends in a verification gate. **No
phase may be marked built without the device check named in it** — doc 31 §5c
and doc 32's native fixes are both cautionary here.

| # | Phase | Gate |
|---|---|---|
| 0 | Transport abstraction; port MPC behind it. No behaviour change. | iOS↔iOS parity with today, on hardware |
| 1 | Android `splitcircle-crypto` (libsignal AAR) + linkage spike | iOS↔Android ciphertext round-trip on real devices |
| 2 | Android history sync (internet only — no mesh) | A Pixel and an iPhone on one account converge |
| 3 | BLE transporter, both platforms | iOS↔Android text with Wi-Fi and cellular off |
| 4 | Router: flood + dedup + TTL + store-and-forward | 3-device relay where A and C cannot see each other |
| 5 | LAN transporter + switch policy + fragmentation | Photo over LAN; graceful degradation to BLE |
| 6 | Cross-platform pairing (transport-independent proof) | Pair a Pixel and an iPhone, verify safety numbers |
| 7 | UI: universal settings, topology, delivery states | Usable on both platforms |
| 8 | Origin re-seal path (§2.5) | Device added mid-thread receives backfill |

**Phase 2 is the early win.** History sync is already internet-based, so once
Phase 1 lands it mostly works on Android without any mesh — matching the user's
own read that "history sync can be done with internet".

## 6. Ruled out, and why

- **Wi-Fi Aware / Wi-Fi Direct / Nearby Connections** — each exists on only one
  platform (iOS exposes no Wi-Fi Aware API to apps; the other two are Android
  only). Any of them can be added later as another fast path, but none can be
  the common floor.
- **BLE-only** — media becomes minutes-per-photo and iOS background BLE limits
  make delivery unreliable when the app is not foreground.
- **LAN-only** — needs a shared network, so it fails in the no-infrastructure
  case nearby exists to serve.
- **Link-state routing** — see §1a; stale tables black-hole silently, which is
  the worst failure mode for a messaging app.
- **Relay re-sealing** — forgery risk; only the origin re-seals (§2.5).

## 7. Risks

1. **libsignal Android linkage** — highest-variance item; Phase 1's spike
   exists to fail fast (see CLAUDE.md's LibSignalClient history).
2. **iOS background BLE** — CoreBluetooth background is restricted; state
   restoration and a foreground-only fallback need explicit design.
3. **Android permissions** — `BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT` (API 31+) and
   location for scanning are a real onboarding cost; the universal settings
   screen is where that is explained.
4. **Battery** — continuous BLE advertising is expensive; needs duty-cycling and
   a user-visible control.
5. **Android is not shippable today regardless** — `android/` is gitignored,
   never committed, has no `ship:android` path, and the Play submit profile
   points at production. Phase 0 should include making Android a tracked,
   reviewable target.

## 8. Gotcha for CLAUDE.md (add when Phase 0 lands)

**MultipeerConnectivity cannot talk to Android, and no amount of work on
`SplitCircleMeshModule.swift` will change that.** Any cross-platform nearby
feature needs a transport that exists on both platforms (BLE, or mDNS+TCP over
a shared LAN). Before designing anything that says "nearby" and "Android" in the
same sentence, check which framework the code actually imports — the entire
nearby stack rests on one Apple-proprietary import, and this is not visible from
the JS layer, which looks platform-neutral.
