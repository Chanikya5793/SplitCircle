# Nearby group recovery, private names, and encryption model

Date: 2026-07-29  
Status: implementation complete; automated and native/build validation are
recorded below as they finish. Two-phone Airplane Mode message exchange remains
the final human acceptance gate.

Read this after
`2026-07-29_NEARBY_TRUST_DM_AND_THUMBNAIL_REPAIR.md`. This note records the
next physical-test regression, the device evidence that isolated it, the
recipient-encryption repair, and the privacy model for human-readable nearby
names.

## Reported behavior

The latest physical test reversed the earlier symptom:

- direct messages were working;
- group messages no longer appeared on the other nearby phone;
- nearby discovery still showed an opaque/iPhone-like installation label;
- the user requested real app profile names, but only for people who already
  know one another rather than for every person scanning nearby.

## Device evidence and exact group root cause

The iPhone 17 Pro application container was copied read-only with
`xcrun devicectl`. Its local message store, nearby queue, cached Signal device
directory, and non-secret session status were inspected. No private key bytes
were printed or modified.

The failing group operations were not UI-only sends:

- they had signed nearby wire envelopes;
- they named the correct group chat, group id, sender, and three-member
  audience;
- they remained in the durable nearby queue;
- their `meshBroadcastAt` stayed empty because no connected native recipient
  matched the signed per-device recipient map.

The recipient map contained only the third, absent group member's installation.
It did not contain the connected iPhone 13 mini installation. The Pro's durable
device directory did contain that mini installation, its Signal device number,
and its public identity key. A native Signal session file also existed, but the
same device had a durable `needsRebuild` marker.

That marker is intentionally authoritative for normal Signal encryption:
`ensureSessionWithDevice(..., "cache-only")` refuses to use the suspect ratchet,
and it cannot claim a fresh server prekey without Internet. The nearby body
builder caught the failure and continued with other group members. This
fail-closed behavior protected confidentiality, but silently removed the
present phone from `encryptedForDevices`. Native targeted routing then did the
correct thing with an incomplete recipient map: it sent to nobody nearby.

This explains why connection/link tests could be green while group messages
failed. The radio path was healthy; the application never produced ciphertext
for the connected installation.

## Implemented encrypted recovery

Signal Double Ratchet remains the primary envelope for every recipient device.
If—and only if—that path cannot produce a device copy offline, the builder now
uses libsignal's RFC 9180 HPKE implementation to seal the same message fields
directly to the cached, previously published Signal identity public key for
that exact installation.

The recovery envelope is:

```ts
{
  m: "identity-hpke",
  b: "<libsignal HPKE ciphertext>"
}
```

The recipient's existing private identity key opens it. HPKE associated data
binds the ciphertext to:

- protocol version;
- chat id and message id;
- origin account and installation;
- recipient installation;
- creation timestamp.

Moving a sealed copy to another chat, message, sender, recipient installation,
or timestamp therefore makes decryption fail. The entire body is still covered
by the sender's existing Signal identity signature. Receipt still requires the
cached sender identity, exact thread membership/audience authorization,
operation deduplication, and the per-device recipient entry.

There is no plaintext fallback, shared group password, opportunistic stranger
key, carrier-name trust, or reduction in native admission checks.

### Security critique

The two modes have different compromise properties:

| Property | Signal Double Ratchet | Identity HPKE recovery |
| --- | --- | --- |
| Recipient-only confidentiality | yes | yes |
| Sender authenticity | Signal envelope plus signed body | signed body |
| Metadata/context binding | signed body | signed body plus HPKE associated data |
| Per-message ratchet forward secrecy | yes | no |
| Works with a ratchet marked for online rebuild | no | yes |

The HPKE fallback deliberately trades ratchet forward secrecy for offline
availability. If a recipient's long-term identity private key is compromised
later, previously captured HPKE recovery copies for that key may be exposed.
Normal Signal copies retain their Double Ratchet properties. The fallback is
limited to cached identity-backed devices for which Signal produced no
ciphertext, and normal online session preparation remains the preferred
recovery.

RFC 9180 defines HPKE as a hybrid public-key encryption construction and
requires applications to supply their authentication/context policy. In
ManaSplit, recipient confidentiality comes from HPKE; sender authentication
comes from the signed outer body and the cached identity directory.

Reference: <https://www.rfc-editor.org/rfc/rfc9180.html>

## Private human-readable names

The app must not advertise a real name in Bonjour, `MCPeerID.displayName`, or
other public discovery metadata. Doing that would let any nearby scanner learn
who is present before authorization.

The implemented display flow is instead:

1. Native discovery exposes only the existing opaque installation id.
2. JavaScript builds a local allowlist from members of cached direct chats and
   cached shared groups.
3. Each allowed installation must have a cached Signal identity public key.
4. The opaque discovered id must exactly match one of those cached
   installations before native code invites or accepts it.
5. Only after that match does the UI resolve the locally cached ManaSplit
   participant `displayName`.
6. Unknown installations are ignored and receive neither a connection nor a
   name.

The visible label is not an authorization credential. The cached device
identity, signed envelope, exact conversation membership, and per-device
ciphertext remain the security checks.

### What “known contact” means today

It means a person who is already present in a locally cached ManaSplit direct
conversation or shared group and whose identity-backed device directory was
observed while online. It does **not** currently mean an iOS Contacts
address-book intersection. Implementing actual mutual phone-contact discovery
would require explicit Contacts permission, normalized/private identifier
matching, a mutuality service or private-set-intersection design, revocation,
and careful metadata analysis. Claiming that property without that protocol
would be misleading.

The current approach is more private than broadcasting a phone/profile name
and works offline from the app's existing relationship cache. A future product
policy can narrow automatic group-derived trust to direct contacts only, or
require an explicit first-time system pairing through DeviceDiscoveryUI and
Wi-Fi Aware.

## Residual metadata and platform direction

Multipeer still exposes a stable pseudonymous installation id as the native
peer display name. The new allowlist prevents unknown installations from
joining or receiving application envelopes, but it cannot make that radio
identifier rotate without a compatibility and identity-handshake redesign.

The flagship direction remains Apple Wi-Fi Aware plus DeviceDiscoveryUI on
supported hardware: explicit system pairing and authenticated direct
discovery, with the same ManaSplit signatures, membership checks, Signal/HPKE
application encryption, dedupe, queueing, and media protocol above it.

- Wi-Fi Aware: <https://developer.apple.com/documentation/WiFiAware>
- DeviceDiscoveryUI: <https://developer.apple.com/documentation/devicediscoveryui>
- Multipeer session security:
  <https://developer.apple.com/documentation/multipeerconnectivity/mcsession/init%28peer%3Asecurityidentity%3Aencryptionpreference%3A%29>

## Implementation map

| Concern | Primary path |
| --- | --- |
| HPKE native bridge | `modules/splitcircle-crypto/` |
| Signal-primary/HPKE-recovery recipient construction | `src/services/meshMessageProtocol.ts` |
| Cached relationship and identity-backed allowlist | `src/services/nearbyTrustService.ts` |
| Private names and no UUID-tail fallback | `src/services/nearbyMessagingState.ts` |
| Discovery security explanation | `src/components/Chat/NearbyDiscoveryArena.tsx`, `src/components/Chat/NearbyMessagingSheet.tsx` |
| Targeted carrier routing | `src/services/nearbyMessageService.ts`, `modules/splitcircle-mesh/ios/SplitCircleMeshModule.swift` |

## Regression coverage

- A group recipient with a cached identity remains in the device map when
  Signal returns no offline ciphertext.
- The recovery ciphertext is opened with exactly the same associated data.
- Existing Signal envelopes remain the primary mode.
- Malformed device envelopes are rejected before signature/decryption work.
- Direct/group authorization and exact audience checks remain strict.
- An opaque installation UUID/tail never becomes a visible peer label.
- Unknown installations never enter the native trusted-peer allowlist.

## Validation

- `npm run test:unit`: 36 files / 419 tests passed.
- `npm run test:services`: 23 files / 188 tests passed.
- `npm run test:dom`: 5 files / 15 tests passed.
- `npx tsc --noEmit`: passed.
- `git diff --check`: passed.
- Native libsignal HPKE bridge: compiled successfully for arm64 in the signed
  Release build.
- Signed standalone Release app: passed deep/strict code-sign verification,
  has bundle identifier `com.splitcircle.app`, and contains its embedded Hermes
  `main.jsbundle` (SHA-256
  `c217de30390dbe54a1e7a93d22e4fef258957ed8d1dddb7ea53287869c24e961`).
- Real devices: that exact 119 MB app was installed and launched successfully
  on the iPhone 17 Pro and iPhone mini; both app processes remained alive after
  launch.

## Required two-phone acceptance

With Airplane Mode enabled and Wi-Fi and Bluetooth manually re-enabled:

1. Cold-start both standalone apps.
2. Open the same cached group on both phones.
3. Confirm each phone shows the other member's cached ManaSplit name, not an
   iPhone label or UUID tail.
4. Send three uniquely named text messages rapidly in each direction.
5. Confirm all six arrive without restoring Internet.
6. Repeat in a direct chat.
7. Send a photo in the group and confirm its thumbnail, full-screen bytes, and
   progress state on the receiving phone.
8. Restore Internet and confirm group text/media converge to absent members
   without duplicates.

Do not call the feature release-ready until this physical radio matrix passes.
