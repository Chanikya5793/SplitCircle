# Nearby trust, direct-message, and media-thumbnail repair

Date: 2026-07-29  
Follow-up: the next physical group test uncovered an offline Signal-repair
recipient omission. Continue with
`2026-07-29_NEARBY_GROUP_RECOVERY_AND_PRIVATE_NAMES.md`.

Status: implementation and automated/native validation passed. A fresh signed
standalone Apple Development build was installed, launched, and confirmed
running on the iPhone 17 Pro and iPhone 13 mini. The manual two-phone radio/UI
acceptance matrix remains the final release gate.

Read this after:

1. `2026-07-29_OFFLINE_MEDIA_SHARING_RESEARCH_AND_PLAN.md`
2. `2026-07-29_NEARBY_PROTOCOL_V2_RESEARCH_AND_PLAN.md`
3. `2026-07-29_NEARBY_MESSAGING_INCIDENT.md`

This note records the post-media physical-test evidence, exact direct-message
failure, album-thumbnail failure, trust redesign, security critique, and
acceptance gates. It supersedes the earlier assumption that a connected
Multipeer radio session should admit every nearby ManaSplit installation.

## Physical-test report

The latest two-phone test established three facts:

- offline group text and media transfer worked;
- the same group media later uploaded and converged to absent group members;
- direct messages created local bubbles but never appeared on the other phone;
- album media opened full-screen from a valid local file, while every grid
  thumbnail displayed an error icon.

The source screenshot is:

`/Users/chanakya/Downloads/Screenshot 2026-07-29 at 1.11.55 PM.heic`

The two physical application containers were copied read-only with
`xcrun devicectl`. Both chat stores, nearby queues, device directories, and
media directories were inspected. Private key material was not printed or
modified.

## Exact direct-message root cause

Both phones had the same direct thread and the correct two participants. Both
created signed nearby operations encrypted for the other phone's exact current
installation id. The operations remained in the sender's durable nearby queue
and were repeatedly offered, proving that UI send, local persistence, Signal
encryption, recipient selection, and carrier broadcast all ran.

The receiver rejected every DM in `isMeshBodyAuthorizedForThread` before
decryption:

```ts
if (body.groupId !== thread.groupId) return false;
```

A direct signed JSON body omits `groupId`, so it parses as `undefined`.
Firestore-derived direct-thread caches materialize the absent value as `null`.
`undefined !== null`, even though both correctly mean “not a group.” Group
messages worked because both values were the same non-empty group id.

### Correction and invariant

- Group authorization requires a non-empty signed `groupId` equal to the
  cached thread's exact group id.
- Direct authorization requires both sides to have no non-null group id.
- Regression tests cover `undefined` body versus `null` thread, and reject a
  direct body or thread that claims a group.
- Direct messages are also bound to the actual native carrier peer:
  `originDeviceId` must equal `peerDeviceId`. Direct messages are never
  relayed; group messages retain bounded signed gossip.

## Exact thumbnail finding

Every tested attachment existed on both phones under permanent `chat_media`
storage. Sample files had plausible sizes and decoded successfully with macOS
image tooling. The full-screen viewer working from the same message confirmed
that the encrypted transfer, hash/AEAD verification, atomic publication, and
image bytes were sound.

The fault was local source convergence:

- a cloud or gossip replay could merge a message object that omitted
  `localMediaPath`, `mediaDownloaded`, `mediaUrl`, or `thumbnailUrl`;
- a mounted album cell could briefly see that incomplete object even though
  the nearby finalizer had already published the deterministic local file;
- the album error latch remained set after a later successful image load.

### Correction and invariant

- Local message convergence never erases an existing working local media path
  or URL merely because an incoming optional field is absent.
- Media rendering verifies both the stored local path and the deterministic
  path derived from `(chatId, messageId, fileName)`.
- A failed image source is cleared before showing the error state, and a later
  successful load clears the transient error latch.
- The shared resolver behavior is used by album cells, so this repair does not
  create a second media pipeline.

## Threat model and trust decision

### Previous behavior

The Multipeer carrier advertised a stable installation UUID as its
`MCPeerID.displayName`, invited every ManaSplit peer it discovered, and accepted
every incoming invitation. `MCSession` used required encryption, and every
application message was separately signed, membership-authorized, and
Signal-encrypted. This protected message content, but it still:

- connected strangers automatically;
- exposed stable pseudonymous installation ids to every nearby app instance;
- broadcast signed envelope metadata/ciphertext to unrelated connected peers;
- let the UI claim a secure nearby relationship before application identity
  authorization.

Apple's strongest documented Multipeer configuration combines a security
identity with encryption. Required encryption without a security identity
encrypts the carrier but does not authenticate a ManaSplit account. Invitation
context and discovery metadata are untrusted input. Therefore radio discovery
or an encrypted `MCSession` is never account authorization.

### Implemented admission authority

The durable offline Signal device directory is now the admission source:

1. Start with users already present in locally cached direct or group
   conversations.
2. Load their device directories with the explicit `cache-only` policy.
3. Require a cached Signal identity key for each installation.
4. Exclude the current installation.
5. If the same installation id is claimed by two different other accounts,
   reject it as ambiguous rather than guessing.
6. Pass the bounded result to native code before discovery starts.
7. Invite and accept only those installation ids; ignore all unknown
   ManaSplit installations.
8. Route message envelopes and attachment resources only to recipient device
   ids present in the signed per-device encryption map.
9. Immediately replace the native session when trust is revoked. Restart
   discovery when trust expands so a previously ignored radio can be found
   again.

The discovery UI now uses locally known contact labels and states whether the
relationship is direct or through shared groups. It explicitly says unknown
nearby installations are ignored. The label is informative only; signatures,
cached identity keys, thread membership, and per-device ciphertext remain the
authorization checks.

### Security properties after the repair

- A random nearby ManaSplit installation is never invited into the session.
- An unsolicited invitation from an unknown installation id is rejected.
- An authorized carrier receives only envelopes/resources targeting that
  installation, rather than every connected contact's metadata.
- A direct envelope must come from its signed origin installation.
- Message bodies and attachment secrets remain Signal-encrypted per device.
- Signed membership authorization and pre-decrypt operation dedupe remain
  mandatory.
- Account-switch collisions fail closed.

### Honest residual limitations

This is a substantial privacy improvement, not system-owned contact
authentication:

- `MCPeerID.displayName` remains a stable pseudonymous UUID visible during
  Multipeer discovery.
- A malicious custom client that knows a trusted installation UUID may spoof
  that carrier name. It can receive targeted ciphertext/limited metadata but
  cannot decrypt a Signal body or forge a valid origin signature. Direct
  carrier binding prevents it from injecting as another real origin unless it
  also compromises that identity.
- Trust is based on the last offline durable directory. A newly added device
  must be observed online once before it can be trusted offline; revoked
  devices remain trusted until an authoritative refresh reaches the phone.
- Multipeer is deprecated, foreground-oriented, and has reproduced connection
  stalls. The fresh-session watchdog is mitigation rather than a platform
  guarantee.

The flagship endpoint is Wi-Fi Aware plus DeviceDiscoveryUI on supported
iOS 26+ devices: explicit system pairing, authenticated/encrypted direct radio,
then the same ManaSplit application signature, membership, Signal encryption,
dedupe, and media protocol. Network framework peer-to-peer remains the broad
fallback migration. Transport encryption never replaces application identity.

Primary Apple references:

- Multipeer discovery and advertiser:
  <https://developer.apple.com/documentation/multipeerconnectivity/mcnearbyserviceadvertiser>
- `MCSession` security identity and encryption:
  <https://developer.apple.com/documentation/multipeerconnectivity/mcsession/init%28peer%3Asecurityidentity%3Aencryptionpreference%3A%29>
- Untrusted invitation handling:
  <https://developer.apple.com/documentation/MultipeerConnectivity/MCNearbyServiceAdvertiserDelegate/advertiser%28_%3AdidReceiveInvitationFromPeer%3AwithContext%3AinvitationHandler%3A%29>
- Wi-Fi Aware:
  <https://developer.apple.com/documentation/WiFiAware>
- DeviceDiscoveryUI:
  <https://developer.apple.com/documentation/devicediscoveryui>
- Paired Wi-Fi Aware devices:
  <https://developer.apple.com/documentation/wifiaware/connecting-paired-devices>
- Apple Wi-Fi Aware sample:
  <https://developer.apple.com/documentation/wifiaware/building-peer-to-peer-apps>
- WWDC25 “Meet Wi-Fi Aware”:
  <https://developer.apple.com/videos/play/wwdc2025/228/>

## Implementation map

| Concern | Primary path |
| --- | --- |
| Nullish direct/group authorization | `src/services/meshMessageProtocol.ts` |
| Cached-conversation trust reduction | `src/services/nearbyTrustService.ts` |
| Native allowlist, targeted sends, peer attribution | `modules/splitcircle-mesh/ios/SplitCircleMeshModule.swift` |
| TypeScript native bridge | `modules/splitcircle-mesh/index.ts` |
| Trust startup, source binding, recipient routing | `src/context/ChatContext.tsx` |
| Queue replay and native targeted sends | `src/services/nearbyMessageService.ts`, `src/services/meshMessageQueue.ts` |
| Local media convergence preservation | `src/services/localMessageStorage.ts` |
| Canonical media source recovery | `src/utils/useResolvedMediaUri.ts` |
| Album success/error integration | `src/components/AlbumBubble.tsx` |
| Trust-aware UI | `src/components/Chat/NearbyDiscoveryArena.tsx`, `src/components/Chat/NearbyMessagingSheet.tsx`, `src/components/OfflineBanner.tsx` |

## Validation completed

- `npx tsc --noEmit`: passed.
- `npm run test:unit`: 36 files / 419 tests passed.
- `npm run test:services`: 23 files / 186 tests passed.
- `npm run test:dom`: 5 files / 15 tests passed.
- `git diff --check`: passed.
- `SplitCircleMesh` CocoaPods target compiled against the iOS 27 simulator SDK.
- A clean Release device build compiled and signed against the iOS 27 device
  SDK.
- The standalone app contains an optimized embedded Hermes bundle (3,120
  modules); it does not require a Metro server.
- `codesign --verify --deep --strict` passed for bundle
  `com.splitcircle.app`, signed by team `YDF2TB9967`.
- The exact same 118 MB app artifact was installed and launched successfully
  on both physical phones. Running processes were confirmed with `devicectl`.

Build artifact used for this test:

`/tmp/manasplit-private-nearby-20260729-derived/Build/Products/Release-iphoneos/SplitCircle.app`

Embedded bundle SHA-256:

`db1ce75f94722b62a31ecb3db6bbcf146ed67b38da6870a47cdf390093a95ef7`

New regression coverage includes:

- direct `undefined` versus cached `null` authorization;
- strict group identity;
- identity-backed cached-contact admission;
- ambiguous cross-account installation rejection;
- current-installation exclusion;
- native-start allowlist preservation and recipient-targeted envelope routing;
- local media fields surviving a convergence replay;
- privacy-safe known-contact discovery copy.

## Two-phone acceptance matrix

Run this on the installed standalone build with Airplane Mode enabled and Wi-Fi
and Bluetooth manually re-enabled:

1. Cold-start both apps and open the same cached direct chat.
2. Confirm each phone names only the recognized contact and reports it connected.
3. Send three uniquely named DMs rapidly in each direction. All six must appear
   before Internet is restored.
4. Force one discovery rescan and repeat one DM each way.
5. Open the tested group album. Every thumbnail must render without an error;
   tap each item and confirm full-screen parity.
6. Capture a new photo offline, send it to the group, and confirm placeholder,
   progress, thumbnail, full-screen image, and local restart survival.
7. Restore Internet. Confirm the group attachment converges once to absent
   members and the cloud replay does not erase the nearby local path.
8. Confirm direct nearby messages remain local-only by the explicit product
   rule.
9. Put a third ManaSplit phone/account nearby that shares no cached
   conversation. It must remain ignored and receive no session, envelope, or
   attachment.
10. Revoke/remove a known device online, refresh, then repeat offline. Native
    state must disconnect and stop admitting it.

The Mac can build, install, launch, inspect containers, and compile every
layer. It cannot complete the radio/UI acceptance matrix without a person
operating both physical phones, so this matrix remains the final release gate.
