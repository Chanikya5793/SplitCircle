# Nearby asymmetric trust incident and AirDrop-style pairing

Date: 2026-07-29  
Status: implemented; physical two-phone validation pending the next installed build

## Incident

Two offline iPhones produced opposite discovery results at the same time:

- Phone A showed **Known phone found**, resolved the cached ManaSplit profile
  name, and waited for a private link.
- Phone B showed **Looking for known contacts**, reported one unknown phone,
  and rejected it.

This was not a Wi-Fi/Bluetooth discovery failure. Both phones saw the radio.
It was an asymmetric authorization decision.

### Root cause

`nearbyTrustService.ts` previously admitted only installation UUIDs found in
the local phone's cached Signal device directories for participants in cached
direct/group threads. The native Multipeer layer enforced that allowlist in
both `foundPeer` and `didReceiveInvitation`.

The app's friendship model is separate:

- A friend record is not a cryptographic device identity.
- Friendship can be one-sided.
- A friend can have a missing, stale, or account-switched Signal device
  directory on one phone.
- Therefore “A trusts B” did not imply “B trusts A,” even when both users
  considered each other friends.

Weakening the native allowlist to accept every discovered ManaSplit install
would fix connectivity by removing the privacy boundary. That is not an
acceptable fix.

## Platform research

### AirDrop's current non-contact model

Apple's current AirDrop guidance uses an explicit temporary ceremony for
non-contacts: the receiver opens access, displays an AirDrop code, the sender
enters it, and the resulting temporary contact lasts 30 days. “Everyone”
automatically closes after ten minutes.

Source: [Apple Support — How to use AirDrop on iPhone and iPad](https://support.apple.com/en-au/119857)

The relevant pattern is not “discover everyone forever.” It is:

1. Known identities get the fast path.
2. Unknown identities stay private by default.
3. A deliberate, short-lived user action opens pairing.
4. A human-verifiable code upgrades one exact device identity.
5. The upgrade expires and can be forgotten.

Apple documents this for iOS 26.2 and later. It should not be described as an
iOS 27-exclusive feature.

### Wi-Fi Aware and DeviceDiscoveryUI

Apple now offers system-level peer pairing and encrypted peer-to-peer Wi-Fi
through Wi-Fi Aware and DeviceDiscoveryUI:

- [Connecting devices for peer-to-peer Wi-Fi](https://developer.apple.com/documentation/wifiaware/connecting-paired-devices)
- [DeviceDiscoveryUI](https://developer.apple.com/documentation/devicediscoveryui)
- [Building peer-to-peer apps](https://developer.apple.com/documentation/wifiaware/building-peer-to-peer-apps)

This is the preferred long-term transport. It supports system-mediated pairing
and does not require an access point or internet. It is not an immediate
drop-in for this build:

- ManaSplit currently uses MultipeerConnectivity.
- The app does not currently have the `com.apple.developer.wifi-aware`
  entitlement.
- Changing transport requires entitlement approval, provisioning changes,
  device/OS capability handling, and a migration path for existing installs.

The new app-level ceremony therefore ships on the current encrypted
Multipeer carrier while keeping Wi-Fi Aware as the planned transport
migration.

### Multipeer security boundary

`MCSession` is configured with `.required` encryption, but ManaSplit does not
provide a PKI-backed `securityIdentity`. Transport encryption is not the
application identity proof. Apple exposes certificate validation separately,
and current Apple documentation directs new work toward Network framework
APIs.

Sources:

- [MCSession encrypted initializer](https://developer.apple.com/documentation/multipeerconnectivity/mcsession/init%28peer%3Asecurityidentity%3Aencryptionpreference%3A%29)
- [MCSession certificate delegate](https://developer.apple.com/documentation/multipeerconnectivity/mcsessiondelegate/session%28_%3Adidreceivecertificate%3Afrompeer%3Acertificatehandler%3A%29)

ManaSplit therefore continues to treat the carrier as untrusted for chat
identity. Every chat envelope is independently Signal-identity-signed and
recipient-encrypted.

## Implemented pairing protocol

### Default lane

- Advertising says `access=known-devices`.
- Cached conversation devices and unexpired explicitly paired devices enter
  the normal allowlist.
- Unknown installations are counted but not invited.
- No profile name is broadcast.

### User-opened pairing lane

- The user taps **Pair a nearby phone**.
- One phone chooses **Show a code**; the other chooses **Enter their code**.
- Both phones advertise `access=pairing` for at most five minutes.
- An unknown peer can enter only a quarantined native session.
- The quarantine accepts frames beginning with `manasplit-pair-v1|`.
- Chat envelopes, link probes, attachment control frames, streams, and media
  resources remain blocked.

### Code and identity ceremony

- Code: eight characters from a 32-character alphabet with ambiguous
  characters removed (40 bits).
- Host generates a 128-bit pairing id and 192-bit fresh challenge.
- Host offer includes its public Signal identity and is signed by the
  corresponding private identity.
- Joiner proof binds:
  - the code;
  - pairing id and challenge;
  - both physical installation UUIDs;
  - both public Signal identity keys.
- Joiner response includes its account/profile identity and is signed.
- Host accepts only when the actual Multipeer peer UUID, signed response,
  target UUID, distinct account, code proof, and unexpired session all agree.
- Host acceptance is itself signed and targets the joiner's exact UUID.
- Names are revealed only inside the user-opened encrypted pairing session;
  the host name is not sent until the joiner's code proof succeeds.
- Incorrect proofs are globally bounded to five attempts per pairing window.

### Durable trust

On both phones, a successful ceremony:

1. Stores the peer's public Signal device identity in the durable offline
   directory.
2. Removes the same installation UUID from stale cached account owners.
3. Stores an explicit paired trust record for 30 days.
4. Promotes that UUID into the native known-device allowlist.
5. Reconnects in the normal lane after pairing closes.

Private keys never enter AsyncStorage. The stored material is the peer's public
identity, account binding, local label, timestamps, and installation UUID.

## Privacy and security critique

### Improvements delivered

- One stale cache can no longer deadlock both users.
- Pairing requires explicit action on both phones.
- Unknown peers cannot send chat/media while pairing.
- The code is bound to the physical transport peers and Signal identities.
- A malicious peer cannot substitute a profile or identity without changing
  the proof.
- The normal discovery path remains private and known-only.
- Pairing trust expires instead of silently becoming permanent.
- The exact peer can be removed from local paired trust.

### Residual risks

1. **Stable discovery pseudonym.** The current `MCPeerID.displayName` is the
   installation UUID. It does not expose a profile name, but a nearby observer
   can correlate the same installation across scans. Protocol v3 should use a
   rotating discovery pseudonym and map it to a verified installation only
   after pairing/known-identity authentication.
2. **Code proof is not a formal PAKE.** Forty bits plus an encrypted local
   carrier and bounded active attempts is materially stronger than a six-digit
   app code, but it is not SPAKE2+/OPAQUE. The Wi-Fi Aware system pairing
   migration should replace this app-layer construction.
3. **Self-issued offline identity binding.** During a first offline pairing,
   the human code authenticates the presented Signal identity. When internet
   returns, the app should compare that identity with the server-published
   directory and visibly revoke/quarantine a mismatch.
4. **Multipeer lifecycle.** iOS may still stall invitations. The transport has
   bounded retries and session replacement, but Wi-Fi Aware/Network framework
   is the strategic replacement.
5. **Trust management UI.** Pairing expiry and storage support forgetting.
   A dedicated Settings list with last-seen date and **Forget** should be
   included before broad release.

## Files

- `modules/splitcircle-mesh/ios/SplitCircleMeshModule.swift`
  - pairing discovery metadata, quarantine admission, pairing-only frame lane
- `modules/splitcircle-mesh/index.ts`
  - pairing native bridge
- `src/services/nearbyPairingService.ts`
  - ceremony, signatures, proof, expiry, attempt limits, promotion
- `src/services/nearbyPairingTrustService.ts`
  - 30-day durable trust and forgetting
- `src/services/nearbyTrustService.ts`
  - merge cached conversation and explicitly paired devices
- `src/services/signalCryptoService.ts`
  - persist the paired public device identity and remove stale-owner collisions
- `src/components/Chat/NearbyMessagingSheet.tsx`
  - show-code/enter-code/status UX

## Validation gates

- **Passed:** TypeScript strict compile.
- **Passed:** pairing proof mutation tests for code, challenge, device UUIDs,
  and both identity keys.
- **Passed:** durable trust tests for offline reload, expiry, and forget.
- **Passed:** trust-directory test proving explicit pairing works without a
  conversation cache.
- **Passed:** all 25 service suites and 194 tests, including existing nearby
  state/message/media coverage.
- **Passed:** all 36 unit suites and 419 tests, plus all 5 DOM suites and 15
  tests.
- **Passed:** clean and final-source incremental native `Release-iphoneos`
  developer builds against the iOS 27 SDK.
- **Passed:** strict code-signature verification for `com.splitcircle.app`,
  with an embedded 13 MB `main.jsbundle` and no Metro dependency.
- **Pending physical devices:** installation and the two-phone acceptance
  matrix below. At validation time neither known phone was available through
  CoreDevice, so this is not claimed as passed.
- Two-phone physical test:
  1. airplane mode; Wi-Fi and Bluetooth manually on;
  2. confirm unknown remains blocked before pairing;
  3. open pairing on both phones;
  4. show/enter code;
  5. confirm both resolve the other profile only after success;
  6. send at least ten alternating DM messages;
  7. send group text, photo, video, and document;
  8. force-quit both apps, stay offline, relaunch, confirm trusted reconnect;
  9. use a wrong code and confirm no trust record is created;
  10. return online and verify group cloud sync remains idempotent.
