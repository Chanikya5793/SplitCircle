# 33 — Cross-platform mesh: transport, routing, crypto parity, and the nearby UI

Status: **DESIGN — decisions LOCKED 2026-07-31. Phase 0 BUILT (transport
abstraction + switch, unit-tested). Phase 1's linkage spike PASSED on a Pixel 7
at libsignal 0.99.1 built from source, closing the version question (§3.1).**
Cross-platform interop remains unproven — see §3.2. Read §3.1 before planning
around Phase 1: the from-source build has a measured seven-prerequisite cost
that recurs on every libsignal bump. Supersedes the
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
protocol is shared rather than reimplemented.

### 3.1 Linkage spike — RUN 2026-07-31, PASSED on a Pixel 7

Run before scheduling anything around it, per CLAUDE.md's LibSignalClient
gotcha (a pod whose `OTHER_LDFLAGS` were silently discarded, shipping a build
that crashed at dyld before any JS). The spike therefore performs a **full
PQXDH handshake plus a Double Ratchet round-trip**, not a version print — "it
compiles" proves nothing.

Result, from `logcat` on a physical Pixel 7 (`panther`), release build:

```json
{"ok":true,"recovered":"manasplit-android-linkage-spike","ciphertextType":3,
 "libsignalVersion":"0.86.5",
 "stagesCompleted":["loadNativeLibrary","generateBobIdentity","generateBobPreKeys",
  "generateKyberPreKey","buildStores","assemblePreKeyBundle","bobPersistsPreKeys",
  "pqxdhHandshake","encrypt","decrypt","verify"]}
```

All 11 stages passed: the native `.so` loads, PQXDH completes, and ciphertext
round-trips. `ciphertextType: 3` is `PREKEY_TYPE`, i.e. a real
`PreKeySignalMessage`. **libsignal on Android is viable.** Code:
`modules/splitcircle-crypto/android/` (`SplitCircleCryptoSpike.kt`, delete when
the real module lands).

Three findings that change the plan:

1. **VERSION GAP — RESOLVED 2026-07-31 by building from source.** iOS pins
   **LibSignalClient 0.99.1**, built from `signalapp/libsignal` at tag
   `v0.99.1`, so it is not bound by Maven. The Android artifact
   `org.signal:libsignal-android` publishes only to **0.86.5** (last updated
   2025-11-17; 0.99.1 is a hard 404, and no AAR ships in the GitHub release).
   The two platforms cannot be pinned to the same version off the shelf.

   **Chosen: build the Android AAR from source at v0.99.1** — the only option
   that neither touches a shipped iOS crypto stack (downgrading risks failing
   to deserialize live users' existing sessions) nor rests on unproven
   cross-version compatibility. **Verified end-to-end: 0.99.1 built from
   source passes the full spike on a Pixel 7** (same 11 stages).

   Mixed versions (0.86.5 ↔ 0.99.1) were NOT pursued, and the spike produced
   evidence against them: the API changed materially in between —
   `SessionBuilder` and `SessionCipher` each gained an address parameter, and
   `Curve` was removed in favour of `ECKeyPair`. A library that reshapes how
   sessions are addressed across that range is not a safe bet for wire
   compatibility.

   **Cost, measured rather than estimated.** Reproducing the AAR needs SEVEN
   prerequisites: Rust **nightly-2026-07-15** (repo-pinned — stable fails),
   the four Android Rust targets, NDK **28.0.13004108** exactly, cmake from
   the SDK on PATH, a `CXX_*` for the target (`build_jni.sh` exports only
   `CC_*`), `protoc`, and **JDK 21**. Plus ~15GB disk and ~10 min compute.
   Every libsignal bump repeats all of it, on every machine and any CI.

   **Two packaging traps.** (a) The AAR's own `classes.jar` is a 14KB Android
   shim — the Java API lives in the separate `libsignal-client` jar, so BOTH
   artifacts are required; wiring only the AAR compiles and then fails at
   runtime on missing classes. (b) AGP **rejects a direct local `.aar`
   dependency inside a library module**, which every Expo module is, because
   the produced AAR would silently omit those classes. Both artifacts are
   therefore installed to `~/.m2` and consumed as normal coordinates, not via
   `files('libs/*.aar')`.

   **Distribution — solved by reproduction, not by shipping binaries.**
   `scripts/build-libsignal-android.sh` rebuilds both artifacts from the pinned
   upstream tag and installs them to `~/.m2`. It checks all seven prerequisites
   up front with the actual remedy for each (every one was a separate
   10-minute build failure the first time), records SHA-256s of the known-good
   build, and has a `--check` mode. `modules/splitcircle-crypto/android/build.gradle`
   fails at configuration with a message naming the script rather than a bare
   "Could not find org.signal:…". Publishing prebuilt binaries to GitHub
   Releases or LFS was NOT done: libsignal is AGPL-3.0 and redistributing built
   binaries from a public repo is a licensing decision for the project owner,
   not a build convenience.

   **Still open:** only `arm64-v8a` is built (a release needs all four,
   ~4× the time), and the `mavenLocal()` line plus the core-library-desugaring
   flag live in generated `android/`, so both need a config plugin to survive
   `expo prebuild`.

2. **PQXDH is mandatory.** `PreKeyBundle`'s only public constructor takes a
   Kyber key plus signature; the pre-quantum 8-arg form is gone. This matches
   the app's existing `PublishableBundle`, which already carries
   `kyberPreKeyId`/`kyberPreKeyPublic`/`kyberPreKeySignature` — so no schema
   change is needed, but Android must generate Kyber keys from day one.
3. **Core library desugaring is required.** `libsignal-android` declares it, and
   without it the build fails at `:app:checkReleaseAarMetadata`. The app module
   needs `coreLibraryDesugaringEnabled true` plus a `desugar_jdk_libs`
   dependency. Since `android/` is generated, **this must be applied by a config
   plugin** for the real implementation, or it vanishes on the next prebuild.

Also confirmed: the AAR ships native libs for all four ABIs
(`arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`), so emulators and devices are
both covered.

API notes for whoever writes the real module (verified against v0.99.1):
`Curve` no longer exists — key generation is `ECKeyPair.generate()` /
`IdentityKeyPair.generate()`, and signing is the instance method
`ECPrivateKey.calculateSignature(bytes)`.

**And the trap that will bite:** `SessionBuilder` and `SessionCipher` take
their two addresses in OPPOSITE orders —
`SessionBuilder(store, REMOTE, LOCAL)` but `SessionCipher(store, LOCAL, REMOTE)`.
The parameter types are identical, so swapping them **compiles cleanly and
fails at runtime**. Read the v0.99.1 sources, do not infer it.

### 3.1b The spike is NOT the module — Phase 2 is gated on this

Easy to lose, so stated plainly: the JS layer resolves
`requireOptionalNativeModule('SplitCircleCrypto')`, while Android currently
registers `SplitCircleCryptoSpike`. So `isCryptoAvailable()` is still **false**
on Android, `encryptMessageForRecipient` still returns null, and messages would
still go out in plaintext.

**Phase 2 (Android history sync) therefore cannot start yet**, even though it
is "already internet-based": with no Signal sessions there is nothing to
decrypt. What remains in Phase 1 is the real module — all 13 exported
functions under the name `SplitCircleCrypto`, with PERSISTENT identity,
session, prekey, signed-prekey and kyber-prekey stores (libsignal's `InMemory*`
stores are spike-only; a device that forgets its sessions on restart is worse
than one with none). Its serialization must match what iOS publishes, since
the two ends share `signalPrekeys` documents.

### 3.2 Gate 1 (partially closed)

The version question is resolved (§3.1) and Android-side execution is proven
at the matching version. **Cross-platform interop is still unproven**: nothing
has yet round-tripped a ciphertext iOS↔Android. That remains Gate 1's
remaining half and needs both sides wired.

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
| 1 | Android `splitcircle-crypto` (libsignal AAR). **Linkage spike DONE (§3.1)**; resolve the version gap first | iOS↔Android ciphertext round-trip on real devices |
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

## 9. Phase 3 (BLE) — build log

**Status 2026-07-31: both native halves written, neither device-verified. BLE
is deliberately NOT registered with the transport switch — nothing routes over
it yet.** Registering it before hardware proof would put an unproven transport
into the live send path, on top of a mesh that already carries several
unverified changes.

| Piece | State |
|---|---|
| `bleFraming.ts` — fragment/reassemble | BUILT, 17 unit tests |
| `bleTransport.ts` — adapter onto `MeshTransport` | BUILT, 8 unit tests |
| `modules/splitcircle-ble/index.ts` — JS bridge | BUILT, typechecks |
| Android `SplitCircleBleModule.kt` | BUILT, compiles clean |
| iOS `SplitCircleBleModule.swift` | BUILT, `swiftc -parse` clean |
| Android permissions (manifest) | BUILT |
| iOS `NSBluetoothAlwaysUsageDescription` | BUILT |
| Registration with `transportSwitch` | **deliberately not done** |

### 9.1 Why fragmentation lives in TypeScript

The alternative is implementing it twice, in Swift and Kotlin, where the copies
can disagree about header layout or chunk boundaries. That failure appears only
between an iPhone and a Pixel, on real radios, and presents as corruption
rather than a protocol mismatch. One tested implementation, unit-testable
without a device, and native halves that only move opaque strings.

### 9.2 Both GATT roles at once, and the bug that fell out of it

A mesh has no clients or servers, so every device advertises AND scans. GATT is
asymmetric — only a central can initiate — so a peripheral has no way to ask
"who are you?".

The first version had the central read the peripheral's identity and stopped
there. Nothing told the **peripheral** who had connected, so its
`identityByAddress` stayed empty, and the lookup in its write handler dropped
every inbound chunk. The link would have looked established from both ends
while carrying traffic in one direction only — and on BLE that reads as flaky
radio, not as a protocol bug.

Fixed with a writable identity characteristic and a chained handshake:

```
central: connect → MTU → discover → read identity → (trust check)
       → enable notifications → write own identity → link live
```

Chained because **each platform runs exactly one outstanding GATT operation per
connection**; issuing the CCCD write and the identity write together drops one
silently. A peer is reported to JS as reachable only when that last write
lands, so the router never advertises a route the peer cannot yet honour.

Trust is enforced on BOTH roles — the central checks the peripheral by reading
its identity, the peripheral checks the central by validating the announcement.
BLE itself authenticates nothing, so a one-sided check means any device that
can see the advertisement can write into the other's GATT server.

### 9.3 Advertisement asymmetry — the cross-platform trap

`CBPeripheralManager` **cannot advertise service data**; it supports only a
local name and service UUIDs. The Android half naturally uses service data.
Left alone, each platform would discover only its own kind — the precise
failure this whole transport exists to prevent, and one that looks like "BLE is
unreliable" rather than a format mismatch.

Both halves therefore **write their own format and read both**. The prefix is a
discovery hint and connect-direction tiebreak ONLY, never an identity claim: an
advertisement has ~31 bytes and cannot carry a 36-char UUID.

### 9.4 One link per pair, without negotiation

Both devices seeing each other would open two redundant links, where chunks can
arrive twice and the two directions negotiate different MTUs. The rule is that
the **lower device id dials**; both sides compute it from data they already
have, so no handshake is needed to agree.

On an exact prefix tie both dial, and the duplicate is dropped after the
identity read using the full ids. That asymmetry is deliberate: a redundant
link is recoverable, whereas both sides declining to dial is a permanent
failure to ever meet.

### 9.5 Known limitations, not bugs

- **iOS backgrounding.** Once backgrounded, iOS moves the advertised service
  UUID into the "overflow" area, discoverable only by another iOS device
  explicitly scanning for that UUID. An Android scanner cannot see it. There is
  no API to opt out, so cross-platform discovery needs the iOS side
  foregrounded.
- **No BLE background modes declared.** `bluetooth-central`/`bluetooth-peripheral`
  are deliberately absent from `UIBackgroundModes`: given the overflow
  behaviour above they buy little for cross-platform work, and they invite App
  Review scrutiny that should be spent when the feature is proven. Adding them
  later is a one-line change.
- **Notifications are unacknowledged.** The peripheral→central direction uses
  notifications, which have no delivery callback, so `sendChunk` resolves on
  local enqueue. The reassembler's TTL is what actually covers a lost chunk.

### 9.6 What device verification must show

1. An iPhone and a Pixel discover each other with Wi-Fi and cellular OFF.
2. The identity handshake completes in both directions — each side reports the
   other as a peer, which only happens after the final identity write lands.
3. A message longer than one MTU round-trips intact (exercises fragmentation,
   ordering, and reassembly across two independent implementations).
4. An untrusted device is refused by BOTH roles.
5. Revoking trust on a live peer drops that link and leaves other links up.

### 9.7 Device verification runbook (written 2026-08-02, NOT YET RUN)

§9.6 says what must be shown. This says how, because the first three attempts at
this test were wasted on the app not having started the transports at all — see
doc 35's criticals, all three of which had to be fixed before this test could
produce a meaningful result on Android.

**Read this first: what a green result looks like, and what it does NOT.**
`transport.isAvailable()` reports HARDWARE capability — adapter present and
enabled — and is true whether or not `start()` was ever called. "Bluetooth:
available, 0 connected" in Settings therefore proves nothing about the service
running. The signal that a route is genuinely alive is a PEER COUNT, which is
why the nearby sheet now lists one row per route with a live count.

**Build.** Flags are already on in `.env` and in `eas.json`'s production
profile, so no code change is needed:

    bash scripts/ship-android.sh --install    # Pixel, over adb
    npm run ship:ios                          # iPhone, via TestFlight

Confirm the flags actually reached the bundle before testing anything — a flag
that silently failed to inline looks exactly like a broken radio. Open the chat
menu → Nearby messaging: a route absent from the build reads "Not included in
this build". If Bluetooth or Wi-Fi says that, stop; the build is wrong.

**Permissions — what each platform asks, and when (fixed 2026-08-02).**

Both prompts appear when the NATIVE MANAGER IS CONSTRUCTED, which happens
inside each transport's `start()`. That is why a JS `isAvailable()` pre-gate on
`start()` was fatal: it skipped the construction, so the prompt could never
appear and the transport could never run. iOS was affected permanently
(`isAvailable()` needs managers only `start()` creates) and LAN by a launch race
(`hasPath` is false until NWPathMonitor's first callback). Both gates removed;
a 15s retry now re-attempts anything enabled but not running, so granting a
permission or switching a radio on mid-session takes effect without a restart.

- **Android / Bluetooth:** runtime grant for BLUETOOTH_SCAN, _CONNECT and
  _ADVERTISE, requested from JS when nearby starts. All three or nothing —
  scanning without connecting finds peers it can never reach.
- **Android / Wi-Fi (NSD):** no runtime prompt.
- **iOS / Bluetooth:** system prompt on first `CBCentralManager`. Consent is
  readable WITHOUT prompting via `CBManager.authorization`, which is what the
  route rows use to say "Needs permission" rather than "turn the radio on".
- **iOS / Local Network:** system prompt on first `NWListener`/`NWBrowser`.
  There is no API to query this one — Apple provides none — so a denial is
  inferred from the listener reporting `.waiting(.dns(PolicyDenied))`.

**KNOWN LIMITATION — BLE stops in the background on iOS.** `UIBackgroundModes`
deliberately does NOT include `bluetooth-central`/`bluetooth-peripheral`. Adding
them is an App Review justification and a battery trade-off, not a bug fix, so it
has not been done. Consequence for this test: keep BOTH apps in the foreground.
A disconnect on switching apps is expected behaviour, not a failure to chase.

**Test 1 — discovery with no infrastructure (§9.6.1).**
Both phones: Wi-Fi OFF, cellular OFF, Bluetooth ON. Same conversation open on
both. Expect within ~30s: the in-chat pill appears reading "Nearby · 1 phone
connected", and the sheet's Bluetooth row reads "1 phone connected". Both phones
must show it — one-sided is a handshake failure, not a discovery failure, and
means the identity write is not landing (doc 35's BLE staged-link fix is exactly
about this direction).

**Test 2 — the handshake is bidirectional (§9.6.2).**
Already covered by "both phones show it" above, and worth being pedantic about:
before doc 35, a peer entered the sendable map at identity-READ time, so one
phone could show a peer that could not attribute anything it sent back. If only
one side shows a peer, capture logs before changing anything.

**Test 3 — a message longer than one MTU (§9.6.3).**
Send ~2000 characters of continuous text. This is the fragmentation, ordering
and reassembly path across two independent implementations, and BLE's ATT MTU is
~20 bytes by default, so this is ~100 fragments. It must arrive intact and in
order. A truncated or scrambled arrival is a framing mismatch, not a radio
problem.

**Test 4 — Wi-Fi route (Phase 5).**
Both phones on the SAME Wi-Fi network, Bluetooth OFF. The sheet's Wi-Fi row
should reach "1 phone connected". iOS will prompt for Local Network access on
first scan; denying it is now DETECTED and makes the route report unavailable
rather than silently doing nothing forever — worth testing the denial path
deliberately once, then granting it.

**Test 5 — untrusted refusal (§9.6.4) and revocation (§9.6.5).**
A third device signed into a different account must not appear as a peer on
either. Then revoke trust on a live peer and confirm that link drops while any
other stays up — MultipeerConnectivity cannot evict one peer from a session, so
this is the case where tearing down the shared session is legitimate; every
other case must not (CLAUDE.md).

**Capturing evidence.** Release JS `console.*` does NOT reach the device log
(CLAUDE.md), so JS silence proves nothing:

    # Android
    adb logcat -s SplitCircleBle:V SplitCircleLan:V ReactNativeJS:V
    # iOS, physical device
    xcrun devicectl device process launch --device <udid> --console com.splitcircle.app

**If nothing connects**, the order to check is: route rows say "On" on BOTH
phones (not "Off", not "Not included"); then Android's runtime Bluetooth
permissions in system Settings; then that both apps are FOREGROUND; then logs.
Do not conclude "the radios do not work" from an unchanging UI — that was the
symptom of every software bug found so far, not of a hardware limit.

## 10. Phase 4 (Router) — build log

**Status 2026-07-31: BUILT, unit-tested (23 tests), and WIRED behind
`EXPO_PUBLIC_ENABLE_MESH_ROUTER` (default off).** The migration in §10.3 is
implemented: receiving both formats is always on, origination is flag-gated.

`src/services/mesh/routerFrame.ts` (header codec) and `router.ts` (flood, dedup,
TTL, store-and-forward, backpressure). Flood rather than a routing table
because a phone mesh's topology changes faster than any table converges —
people walk out of range mid-message. Flooding is stateless per hop and
self-healing, and its cost, duplicate frames, is precisely what dedup absorbs.

The phase gate — *"3-device relay where A and C cannot see each other"* — is
simulated end to end in `meshRouter.test.ts` with three independent router
instances wired into a line topology, for both unicast and broadcast.

### 10.1 Corrections to §2.3's frame table

Three, all found by building against what Phase 3 actually produced:

1. **ASCII, not packed binary.** Every transport here carries strings —
   `bleFraming` fragments strings, MPC envelopes are strings. Packing to binary
   would force a base64 round trip costing ~33% MORE than a compact ASCII
   header. §2.3's table is honoured as a field list, not a memory layout.

2. **No `fragIdx`/`fragCnt`.** Fragmentation is a TRANSPORT concern and lives in
   `bleFraming`, because MTU varies per transport AND per peer. A router-level
   fragment count would have to assume one MTU for the whole path, which is
   wrong the moment a frame crosses BLE to MPC — the exact situation this mesh
   exists to create. Each hop refragments for its own link.

3. **`payloadClass` ADDED to the header.** §2.4 requires backpressure to drop
   the lowest class first, but a RELAY has no other way to know what it is
   holding. Without it every relayed frame is treated identically and a
   backed-up photo can evict the text message a user is waiting on — the exact
   thing that rule exists to prevent. One character on the wire.

### 10.2 Decisions worth keeping

- **Split horizon.** Never forward back to the sender, or to the origin. Both
  demonstrably have it. Dedup would catch the loop anyway, but only after
  paying for it on the link where bandwidth is scarcest.
- **Own id marked seen at origination.** Otherwise the first echo of our own
  broadcast passes dedup and gets re-flooded: the mesh amplifies its own traffic.
- **Broadcast is delivered AND relayed; unicast-to-self is terminal.** That dual
  role is what makes group messaging work across a partial mesh.
- **`relay` carries no payload.** A relay never hands ciphertext it cannot read
  to the local delivery path, and the return type makes that unrepresentable.
- **Re-holding preserves the original `queuedAt`.** Refreshing it on every flush
  would make a frame immortal and quietly defeat the 7-day cap.
- **A broadcast with no neighbours is NOT held** — there is nobody to relay to,
  and the origin's own queue is what replays a group message.
- **TTL above the maximum is rejected, not clamped.** A frame claiming
  `ttl=9999` is a bug or an attempt to circulate forever; clamping hides both.
- **Per-hop ack is the transport's `SendOutcome.deliveredCount`**, not a new
  mechanism. It is deliberately never surfaced as a UI delivery claim —
  conflating transport ack with delivery is doc 32 §10.1's bug.

### 10.3 The migration (implemented)

Every frame gains a routing header, so **a device running the router cannot be
understood by one that is not**. Unlike BLE — additive, flag-gated, and
invisible to peers — this changes bytes on the wire between devices that
already talk to each other today.

Turning it on therefore needs a migration story, not a flag:

- accept BOTH bare envelopes and router frames during a transition window
  (`decodeRouterFrame` already returns null for a bare envelope, so the
  fallback is a clean `?? treatAsBare`), and
- only originate router frames once the receiving side is known to handle them.

Both halves are now in `nearbyMessageService.ts`:

- **Receiving is always on and unconditional.** `decodeRouterFrame` returns null
  for a bare envelope, so it takes the pre-existing path unchanged. This is
  safe regardless of the flag, which is what makes the rollout survivable.
- **Origination is flag-gated.** With the flag off the wire is byte-identical to
  today, which is why the pre-existing suites pass untouched.

The separation rests on bare envelopes being unmistakable, and that is now
pinned by a test against the REAL wire shape rather than assumed:
`buildSignedMeshEnvelope` emits `JSON.stringify({v, bodyBase64,
signatureBase64})`, and neither base64's alphabet nor JSON's structural
characters include `|` — so the first separator scan fails immediately. A
router frame always starts `r1|`. If either format ever gains a `|`, that test
fails and this assumption must be revisited.

Rollout order: ship to every device in the test set with the flag OFF, confirm
nothing regressed, then enable origination.

### 10.4 Not yet built

- **Seen-set persistence.** `SeenSet` exposes `snapshot()`/`restore()` and the
  router stays synchronous and pure, but nothing calls them on boot yet. The
  consequence is bounded: a device re-floods frames it already relayed after a
  restart, wasteful rather than harmful, and TTL still terminates it.

## 11. Phase 7 (UI) — build log

**Status: diagnostics + topology + per-transport toggles BUILT
(`NearbyMeshScreen`, Settings → Nearby mesh). Per-message delivery states
(§4.3) NOT built.**

Built first, and deliberately, because it is the piece that makes the hardware
session diagnosable. Every hard mesh bug in this project — doc 32 §5f's queue
that never flushed, §10.1's dead self-sync, §10.2's collapsing session — was
invisible from inside the app while it was happening and reconstructed
afterwards from Cloud Function logs. The only in-app signal was a single
`lastMessageEvent` slot that the next event overwrote, visible only to someone
already staring at the sheet. Testing three phones in a room without this is
guesswork.

### 11.1 What it shows

- **Transports** — each one's availability and connected count, plus an
  explicit note when the BLE flag is off, since that is the only transport that
  can reach Android.
- **Nearby devices** — ONE row per node, not per link. A phone reachable over
  both MPC and BLE is one neighbour with two transport badges; rendering it
  twice would make a two-device test look like a three-device mesh.
- **Untrusted-but-reachable peers are shown, not hidden.** "The other phone is
  right there and nothing happens" and "the other phone was never discovered"
  are completely different problems, and filtering would make them identical.
- **Queue depth** — envelopes waiting, and separately what the router is holding
  for an unreachable destination.
- **Recent activity** — a bounded newest-first log, replacing the single slot.
- **What relaying exposes** — §2.3's metadata note in plain language.

### 11.2 Honest by construction

The header states outright that this is what the phone can see *now*, not a map
of the mesh, and that a message can still reach a device not listed (doc 33
§1a). Presenting flood routing behind a topology picture would be a confident
lie of exactly the kind doc 32 §10.1 warns about.

Every number is read live from `getMeshDiagnostics()` — the transports, the
on-disk mesh queue, the router's own pending count. No placeholder stats.

### 11.3 Not built

- **Discoverability mode** (§4.1). The toggles landed 2026-08-01 (§11.4);
  discoverability is a separate decision about how visible this device is to
  strangers, and belongs with Phase 6's pairing work.
- **Per-message delivery states** (§4.3). Attempted 2026-08-01 and REVERTED,
  because the premise was wrong and the finding is worth keeping:

  §4.3 assumed `undecryptable` rendered as a confident tick. It does not.
  `MessageStatus` has no such value — `undecryptable` is a RECEIPT status, and
  `ChatContext`'s receipt listener already maps it to `'failed'` (doc 32 §5c),
  precisely so an unreadable message shows a real failure. The confident-tick
  bug §4.3 was written to prevent had already been fixed.

  What genuinely remains is milder: `'failed'` conflates "never sent" with
  "arrived but could not be opened". Distinguishing them means ADDING
  `'undecryptable'` to `MessageStatus`, which ripples through every consumer of
  that union — a deliberate typed change, not a rendering tweak. Worth doing;
  not worth half-doing.

  Lesson for whoever picks this up: read what actually REACHES the renderer, not
  just the renderer. The status branch looked wrong in isolation and was correct
  in context.

## 12. Phase 8 (Origin re-seal) — build log

**Status 2026-07-31: BUILT and WIRED. 11 tests.**

Doc 32 §5e documented that a device added to a thread AFTER an envelope was
sealed can never receive that message — relays forward frozen ciphertext and no
copy is addressed to it. A router makes it worse (more hops, more chances to be
the excluded node), so §2.5 adopted the re-seal path §5e had deferred.

Split in two on purpose:

- `mesh/originReseal.ts` — the DECISION. Pure, no crypto, no I/O, so the rule
  can be tested exhaustively without a device.
- `originResealService.ts` — the REBUILD. Owns keys and threads.

### 12.1 The rule that cannot bend

**Only the ORIGIN re-seals.** `evaluateReseal` checks `originOwned` FIRST and
unconditionally, before every other condition, and there is a test asserting
that a relayed operation which is *also* expired, *also* envelope-less and
*also* missing devices still fails on ownership. That ordering is the forgery
guard, not a style choice: a relay minting ciphertext attributed to another
sender is forgery, and `originOwned` (doc 32 §5a) is what stops it.

### 12.2 Decisions worth keeping

- **Bounded by the same 7-day queue window.** Without it, one device joining a
  group re-seals every message ever queued — a flood, and an unwelcome surprise
  for someone who joined expecting to start from now.
- **An absent `recipientDeviceIds` means "covers nobody", not "covers
  everyone".** The opposite reading would silently skip re-seal for every
  operation predating that field.
- **`meshBroadcastAt` is cleared on re-seal.** Otherwise the fresh envelope sits
  in the queue behind a flag saying it was already sent, and the new device
  never sees it — which would have made this whole path a no-op.
- **Departed devices are reported but never acted on.** Removing a device from
  an existing envelope rewrites history, and its ciphertext may already have
  been delivered. Departure belongs to the thread audience, not to rewriting
  messages.
- **Triggered by the `threads` effect**, which is exactly when a new device can
  become known, rather than on a timer — so it costs nothing while the audience
  is stable. Cheap guards run before the per-thread device lookup.

### 12.3 A constant that had to move

`originReseal.ts` needs the queue's max-age. Importing it from
`meshMessageProtocol` dragged native crypto into a module whose entire value is
being testable without a device, and the suite failed at collection with
"Cannot read properties of undefined (reading 'EventEmitter')" — the hazard
CLAUDE.md documents. Duplicating the value would drift silently.

Fixed properly by extracting `mesh/constants.ts`, a native-free leaf both
import. Note `meshMessageProtocol` must `import` AND re-export it: a bare
`export ... from` creates no local binding, and that module uses the value
itself.

### 11.4 Per-transport toggles (2026-08-01)

Master switch plus one toggle per transport, in `mesh/transportPreferences.ts`.

- **Synchronous reads.** The switch consults this on every send and every
  reachability check, so an async read would either block the hot path or arrive
  after the decision. Loaded once at startup into an in-memory snapshot; writes
  are async.
- **Fails OPEN.** An unreadable or absent preference means ENABLED. Silently
  disabling someone's nearby messaging because a read failed is
  indistinguishable from the radio being broken — the invisible-failure class
  that has cost this project days repeatedly. Only an explicit `false` disables.
- **Enforced in `transportSwitch.available()`**, not per call site. Every other
  capability there — `neighbours`, `routesFor`, `capableOf` — derives from it,
  so one check covers sends, reachability and the topology view. A per-call-site
  check would eventually miss one and leave a disabled radio still transmitting.
- **Unknown transport ids in stored data are discarded**, not trusted.
- **"Off" and "unavailable" read differently in the UI.** Collapsing them would
  make a toggled-off radio look broken, which is the confusion this screen
  exists to remove.

Note this made `transportSwitch.ts` no longer free of native imports, and its
header comment was corrected rather than left asserting the old guarantee — a
false doc claim is a hazard this repo has already been bitten by three times.
