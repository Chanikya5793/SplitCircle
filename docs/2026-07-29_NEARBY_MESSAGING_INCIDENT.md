# 2026-07-29 nearby messaging physical-test incident

Update: a second physical test found that only the first message in each
direction survived before Signal readiness failed. The root cause was
gossip replay entering the Double Ratchet before operation dedupe, compounded
by a stale cross-account installation record. Read
`2026-07-29_NEARBY_PROTOCOL_V2_RESEARCH_AND_PLAN.md` for the device evidence,
implemented correction, media-capable protocol, transport research, and phased
validation plan.

Status: root causes identified, corrections implemented, automated/native
validation passed, and the corrected standalone developer build installed on
the iPhone 17 Pro and iPhone 13 mini. A final human two-phone offline send is
still required because the Mac cannot type into and observe both physical
phones simultaneously.

Read this after
`2026-07-28_OFFLINE_AND_NEARBY_MESSAGING_HANDOFF.md`. This incident supersedes
the earlier assumption that merging Firestore's offline device-directory
snapshot was sufficient.

## Reported behavior

The physical test had two distinct failures:

1. Discovery found the other phone immediately, but one phone stayed at
   `Securing…` while the other stayed at `Found`. It could take five minutes
   before both showed connected.
2. Once both phones showed connected and native link tests succeeded, newly
   sent chat bubbles remained at a clock or single-check state. They did not
   appear on the other phone until Internet connectivity returned.

The link test was not a false positive. It is a native Multipeer
ping/pong frame and proved that the established radio session could move bytes.
It did not exercise JavaScript, cached Signal state, chat authorization,
decryption, local persistence, or cloud fallback.

## Evidence captured from both phones

The app data containers were copied read-only from both physical devices and
the AsyncStorage manifests/message files were compared.

- The tested group chat was present on both devices.
- The messages created around 05:14–05:15 UTC had identical message ids on
  both phones after connectivity recovery and were marked delivered/read.
- Those messages were shown as unresolved local sends in the screenshots taken
  while offline.
- `nearby_message_queue_v1` was absent by the later capture, consistent with
  the origin's group cloud-relay queue being removed after a successful online
  flush.
- Both devices had durable public Signal device directories.
- Both devices had native Signal sessions for the other test account. This
  ruled out missing historical key material as the primary two-phone failure.

The evidence fits one sequence: the send began in the offline branch, blocked
before it could create/enqueue/broadcast the nearby wire envelope, then resumed
when Firestore became reachable and completed through the group cloud path.

## Root cause 1: the "offline" envelope builder awaited Firebase

The call path was:

```text
ChatContext.sendMessage (Internet unavailable)
  -> buildMeshMessageBody
  -> encryptMessageForRecipient
  -> listSignalDevices
  -> Firestore getDocs
  -> encryptForAllDevices
  -> listSignalDevices again
  -> ensureSessionWithDevice
  -> claimSignalPreKey Cloud Function if a session is absent/broken
```

The durable device directory was loaded before `getDocs`, but it was only used
after the Firestore request resolved or threw. In the React Native Firebase JS
configuration, an offline `getDocs` can remain pending until the network
returns instead of immediately rejecting. Therefore the fallback existed in
source but was unreachable while the promise was pending.

This explains all observed message behavior:

- the optimistic local bubble appeared immediately;
- its send promise stayed unresolved, so the bubble showed a clock/check rather
  than a nearby receipt;
- no wire envelope reached the connected native session;
- when Internet returned, the blocked query/function could finish and the
  normal group cloud relay delivered the same message ids.

### Correction

Nearby encryption now uses an explicit `cache-only` policy through every layer:

- `listSignalDevices(userId, 'cache-only')` merges memory and durable device
  metadata and never starts a Firestore request;
- `encryptMessageForRecipient(..., 'cache-only')` preserves that policy;
- `encryptForAllDevices(..., 'cache-only')` does not re-enter the online lookup;
- `ensureSessionWithDevice(..., 'cache-only')` may reuse a native session but
  never calls the prekey Cloud Function;
- `buildMeshMessageBody` always selects this cache-only path.

If cached metadata or an established session is genuinely missing, nearby
encryption now fails promptly and the existing diagnostic UI says secure
nearby delivery is not ready. It never waits silently for Internet.

While Internet is available, `ChatContext` now refreshes participant device
directories and proactively establishes/repairs their Signal sessions. This is
important for group chats: every member who was prepared online can receive
later offline, rather than only members with a session created incidentally by
an earlier message.

Security was not weakened. There is no plaintext nearby fallback, no trust in a
Bonjour display name, and no offline attempt to reuse/claim a server-held
one-time prekey.

## Root cause 2: a stalled MCSession was reused

The two discovery screenshots showed asymmetric framework state:

- inviter: peer discovered and `Securing…`;
- receiver: peer `Found`, waiting for the direct link.

The prior timeout called `cancelConnectPeer` and restarted Bonjour browsing, but
kept the same `MCSession`. A session internally stuck at `.connecting` could
therefore poison every subsequent retry. Exponential backoff then made a
framework stall look like a five-minute application loop.

This closely matches a reported iOS 26 issue where discovery succeeds but
`MCSession` remains indefinitely in `.connecting`. Apple DTS says this is not
expected, that Multipeer does not expose enough state for a reliable internal
recovery, and recommends migrating to Network framework:

- <https://developer.apple.com/forums/thread/811978>
- <https://developer.apple.com/documentation/multipeerconnectivity/mcsessionstate>
- <https://developer.apple.com/documentation/technotes/tn3151-choosing-the-right-networking-api>

### Correction

The native module now:

- creates a fresh encrypted `MCSession` after an invitation watchdog expires;
- performs a full session/advertiser/browser rebuild for `Scan again`;
- accepts a first/retried incoming invitation on a clean receiver session when
  no peer is already connected;
- immediately marks the receiver as connecting, eliminating the misleading
  `Found`-only state;
- ignores delegate callbacks and data from superseded sessions; and
- retains bounded exponential retry rather than spinning the radios.

This is a mitigation around a deprecated framework, not proof that Multipeer
itself is fixed.

## Research critique and transport direction

Multipeer remains useful for the current deployment target because it gives
ManaSplit mandatory session encryption and peer-to-peer Wi-Fi with a compact
API. It is also deprecated and has reproducible recent-iOS stalls. Repeatedly
adding retries is not a sound permanent strategy.

Apple's supported direction is:

1. Network framework with `NWParameters.includePeerToPeer` for the broad
   fallback transport; and
2. Wi-Fi Aware on supported iOS 26+ hardware for explicit secure discovery,
   pairing, and direct communication without an access point.

References:

- <https://developer.apple.com/documentation/network/nwparameters/includepeertopeer>
- <https://developer.apple.com/documentation/wifiaware/adopting-wi-fi-aware>
- <https://developer.apple.com/documentation/wifiaware/connecting-paired-devices>

A Network framework rewrite must not simply replace encrypted `MCSession` with
plaintext TCP. It needs authenticated transport encryption or a redesigned
application envelope that encrypts metadata as well as content. It must also
retain the current signed membership authorization, per-device encryption,
dedupe/gossip, bounded retry, and generic unverified-peer UI. That security
work is why this incident applies a contained MCSession reset instead of
rushing an unauthenticated TCP migration.

## Tests and validation

Implemented regression coverage:

- the nearby protocol test asserts every recipient encryption call uses
  `cache-only`;
- durable/cache merge tests cover empty and partial Firestore cache snapshots;
- the Hermes test still runs envelope parsing without `TextEncoder`;
- the full TypeScript compile covers the policy propagation across service
  boundaries.

Results on 2026-07-29:

- `npx tsc --noEmit`: passed.
- `npm run test:unit`: 36 files, 419 tests passed.
- `npm run test:services`: 18 files, 164 tests passed.
- `npm run test:dom`: 5 files, 15 tests passed.
- generic physical-device Release build with iOS 27 SDK: passed.
- Apple Development signing and app validation: passed.
- corrected Release app installed successfully on both test phones.
- after launching the corrected build on both phones, the native session
  reached connected and returned a 9 ms link test within the first 8-second
  observation window. Both phones were online/on Wi-Fi for this smoke test, so
  it validates fast session establishment but does not replace the Airplane
  Mode peer-to-peer check below.

Installed artifact:

`/tmp/manasplit-device-derived/Build/Products/Release-iphoneos/SplitCircle.app`

Install results (ephemeral container ids):

- iPhone 17 Pro: `6B7FCCF6-1283-4606-BD5D-D01F35E11D3A`
- iPhone 13 mini: `F096E59E-2E1A-41F0-9AC7-9AFDA9B4BE6D`

The artifact is a standalone Release app with an embedded Hermes bundle. It
does not use Metro.

## Required final physical check

Both phones were online once after installing so their current participant
directories/sessions could prewarm. Now:

1. Force-quit ManaSplit on both phones.
2. Enable Airplane Mode, then manually turn Wi-Fi and Bluetooth back on.
3. Launch ManaSplit on both and open the same cached group chat.
4. The phones should move from Found/Securing to connected within one bounded
   attempt. If the first framework attempt stalls, the clean-session retry
   should recover rather than carrying stale state for minutes.
5. Send a uniquely named message from each phone.
6. Verify each message appears on the other phone before restoring Internet.
7. Open Nearby Messaging and confirm the latest diagnostic says the message
   was handed to a phone on the sender and verified/decrypted/saved on the
   receiver.
8. Restore Internet and verify the same message ids do not duplicate while the
   originated group copies synchronize to absent members/cloud.

If this check fails, capture the Nearby Messaging diagnostic from both phones
before reconnecting. The next discriminator is then explicit:

- `blocked`: cached key/session preparation is incomplete;
- `handed to phone` only: receiver verification/decryption rejected it;
- `verified, decrypted, and saved`: transport and crypto succeeded; investigate
  chat subscription/rendering;
- no event: the send did not enter the offline branch, so central connectivity
  classification is the next target.
