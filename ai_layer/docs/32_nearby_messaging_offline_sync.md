# 32 — Nearby messaging offline sync (mesh delivery on reconnect)

**Status: RESEARCHED 2026-07-30 — root causes confirmed against the actual code
(not inferred from comments alone), fix plan locked.**

**ALL of §5 and §10 are now BUILT** — §5a (DM cloud relay), §5b (per-chat FIFO
+ bounded retry), §5c (decrypt-failure receipt), §5d (audience reconciliation),
§5f (native `emitPeerCount()`), §10.1 (self-sync coverage), §10.2 (3+ device
mesh collapse). §5e was a documentation decision, not code.

§5d's server half, `repairChatAudience`, was **deployed 2026-07-30** and
confirmed live in `firebase functions:list` (33 functions), with its caller
confirmed present in `ChatContext.tsx` — both rungs of CLAUDE.md's
"deployed?" / "does anything CALL it?" ladder checked, not assumed.

**Still NOT verified: anything native** (§5f, §10.2). A native change cannot be
proven by the jsbundle hot-swap, so those two remain unexercised until a real
build runs the three-device repro.

JS work is covered by tests: **235 services + 419 unit pass.**

**§10 is the section to read first if you are here because messaging is
broken.** §1–§9 diagnose the OFFLINE mesh queue; §10 covers two entirely
different bugs that break while fully ONLINE, which is what users actually
reported. Three agents
read the JS layer, the native MultipeerConnectivity layer, and the existing
test suites in parallel; every load-bearing claim below (the DM/cloud-relay
split, the FIFO break-on-error, the native `emitPeerCount()` gap, the
`resolveMeshThreadAudience` null case) was independently re-verified against
the real source in this pass, not taken on the research agents' word alone.

## 0. Goal (as given)

The nearby mesh (`SplitCircleMeshModule.swift` / `meshMessageProtocol.ts`)
delivers messages over MultipeerConnectivity when internet is absent. The
queue (`meshMessageQueue.ts`) is supposed to persist envelopes and
re-broadcast them when peers reconnect. In practice, messages sent while a
recipient is offline are either silently lost or never delivered once both
devices come back online. This doc finds out exactly why, for both DM and
group paths, and locks in a fix.

## 1. Data flow, as actually built

### 1.1 Send (`ChatContext.tsx` `sendMessage`, ~928–1260)

The message is saved locally as `status: 'sending'` first, then `NetInfo.fetch()`
decides the branch:

- **Online** (1184–1213): recipients come straight from
  `latestThread.participants`; each gets `queueMessage(recipientId, message,
  isGroupChat)`, then `queueMessageToOwnDevices(...)` mirrors it to the
  sender's other devices — all into the Firebase RTDB transit tier. **This is
  the exact same function used for both DMs and groups** — `isGroupChat` is
  just a boolean argument, not a different code path. DMs already go through
  Firebase RTDB every time the sender has any connectivity at all; there is no
  "DMs never touch the cloud" invariant anywhere in the online path.
- **Offline** (982–1127): `buildMeshMessageBody` (`meshMessageProtocol.ts:168–299`)
  calls `resolveMeshThreadAudience(thread)` (155–166) — a union of
  `participantIds` and `participants[].userId`, required to resolve to
  *exactly 2* ids for a `'direct'` thread, or returns `null`. For each
  recipient device it tries a cached Signal ratchet session first
  (`encryptMessageForRecipient`, 223–241) and falls back per-device to
  stateless HPKE sealed to that device's cached identity key (246–281) if the
  ratchet session is unusable (e.g. prekeys exhausted while offline). A `null`
  body, a missing local device id, or zero successfully-encrypted-for devices
  makes `buildMeshMessageBody` return `null`.

  Back in `ChatContext` (1067–1083): a `null` body reports a `'blocked'` nearby
  event and throws. **For `direct` chats this throw propagates** to the outer
  catch (1234–1257), setting `message.status = 'failed'` — a real, visible
  failure. **For `group` chats the same throw is swallowed** (1082 has no
  `else`), so the send "succeeds" locally with no `wireEnvelope` at all. Either
  way a `MeshMessageOperation` is built (1085–1103) and persisted via
  `enqueueMeshMessage` into the on-device AsyncStorage queue
  (`meshMessageQueue.ts`). **The single line that forks the two paths for
  everything downstream:**

  ```ts
  cloudRelay: latestThread.type === 'group',   // ChatContext.tsx:1099
  ```

  If a `wireEnvelope` was built, `broadcastQueuedNearbyMessages()` fires
  immediately (1112–1114).

### 1.2 Broadcast (`nearbyMessageService.ts` `broadcastQueuedNearbyMessages`, 118–168)

Reloads the *entire* mesh queue (DM + group, own + relayed) and, for every
operation still carrying a `wireEnvelope`, hands it to native
`broadcastNearbyEnvelope` for whichever of `operation.recipientDeviceIds` are
currently connected. Success stamps `meshBroadcastAt` and — for the sender's
own operation — flips local status to `'sent'`. **This is a transport-layer
ack only** (bytes reached a connected peer's radio); there is no decrypt or
receipt ack from the recipient anywhere in this codebase.

This function has exactly five triggers, confirmed by grep across `src/`:
receiving a new envelope (gossip re-broadcast, `ChatContext.tsx:415`), an
attachment-progress callback (429), the sender's own send (1113), a
nearby-peer-count change `> 0` (`nearbyMessageService.ts:192–197`), and once on
mesh start (219). **It is never triggered by "internet came back."** Per-
operation send failures are caught and silently swallowed (158–162), leaving
the queue untouched for whatever future trigger happens to fire next — which,
for a DM with no other delivery path, may be never.

### 1.3 Cloud relay — group only (`meshCloudRelay.ts`, full file read and verified)

A `NetInfo` listener (`ChatContext.tsx:464–476`) calls
`flushMeshCloudRelay(user.userId)` whenever `isConnected && isInternetReachable
=== true`. It reloads the whole mesh queue and, per operation:

```ts
if (
  !operation.originOwned
  || !operation.cloudRelay
  || operation.chatType !== 'group'
  || operation.originUserId !== currentUserId
) {
  continue;                                    // meshCloudRelay.ts:43-50
}
```

For a matching group op it marks the message `'sent'`, uploads any staged
attachment, fans it out via the **exact same** `queueMessage` /
`queueMessageToOwnDevices` RTDB calls the online send path uses (100–103),
updates the Firestore chat doc, and only then calls `removeMeshMessage` — the
sole place a group mesh-queue entry is ever deleted. Any exception in that
block `break`s the whole `for` loop (120–124):

```ts
} catch {
  // Preserve FIFO-ish behavior and retry later. Continuing after a
  // failure can reorder a conversation on the server.
  break;
}
```

**Important, independently verified finding:** `originOwned` (line 44) is
*already* the guard that prevents a relay device from impersonating the
original sender — it is checked separately from, and in addition to,
`chatType !== 'group'` (line 46). The "a relay cannot safely impersonate the
origin" reasoning that justifies excluding *relayed* copies from cloud relay
(see `ChatContext.tsx:370`, quoted in §3's Scenario D) is fully satisfied by
`originOwned` alone. The `chatType !== 'group'` line is a **separate,
additional** restriction with no independent technical justification anywhere
in the code or comments — see §5a.

### 1.4 Receive (`ChatContext.tsx` `onEnvelope`, 283–460)

Each inbound envelope is shape-parsed, matched to a locally-cached
`ChatThread` by `chatId` (302–312 — a thread not yet synced locally can never
receive mesh traffic for it), DM-only checked that the immediate carrier
device matches the claimed origin device (317–327, since DMs are never
relayed), authorized via `verifyMeshEnvelopeForThread` →
`isMeshBodyAuthorizedForThread` (`meshMessageProtocol.ts:437–472` — recomputes
`resolveMeshThreadAudience` and fails closed on `null`, and fails closed on
the 7-day/60s age window at line 467), dedup-claimed via
`claimMeshMessageProcessing` *before* any stateful Signal decrypt
(`meshMessageQueue.ts:88–99`), decrypted per-device
(`decryptMeshFieldsForDevice` — the HPKE branch returns `null` on any native
failure, `meshMessageProtocol.ts:503–514`), then persisted and saved locally,
after which the receiver re-broadcasts it onward for gossip (415). **Every
failure step calls `reportNearbyMessageEvent({type:'rejected'|'blocked', ...})`
and returns — no exception surfaces, no retry is scheduled, nothing durable
records the attempt.**

### 1.5 Native peer topology (`SplitCircleMeshModule.swift` / `modules/splitcircle-mesh/index.ts`)

`MeshController` exposes `onEnvelope`, `onPeersChanged`, `onStateChanged`,
`onAttachmentEvent` to JS. Two **independent, unsynchronized** emission paths
exist:

- `emitPeerCount()` (982–987) — resolves `session.connectedPeers` filtered to
  `trustedDeviceIds`, dispatches `onPeersChanged`.
- `emitState()` (989–1030) — recomputes a full state payload, dispatches
  `onStateChanged`. Called from nearly every mutating path.

`nearbyMessageService.ts`'s `startNearbyMessaging` (170–229) has exactly one
consumer of `onPeersChanged` in the whole codebase (confirmed by grep):

```ts
const peerSubscription = addNearbyPeersChangedListener((count) => {
  if (count > 0) {
    void announceIncomingNearbyAttachmentProgress();
    void broadcastQueuedNearbyMessages();          // nearbyMessageService.ts:192-197
  }
});
```

This is the **only** code path that triggers a rebroadcast purely because of a
peer-count change. `onStateChanged`'s handler only updates UI state and pairing
phase — it never calls `broadcastQueuedNearbyMessages`, even though its own
`connectedPeerCount` field is independently, correctly recomputed on every
state mutation. This split is the root of §3 Scenario-adjacent finding §5f.

**Native admission gate:** `trustedDeviceIds` is checked in
`browser(_:foundPeer:)`, `advertiser(_:didReceiveInvitationFromPeer:)`, and
`session(_:peer:didChange:)`. A peer failing this check is added to
`ignoredPeerNames` and never reaches `session.connectedPeers` — no `didChange`,
no `emitPeerCount`, no `onPeersChanged`/`onStateChanged` for it, ever, until
`updateTrustedPeers` is later called with its id. `trustedDeviceIds` itself is
only as fresh as the last successful `refreshSignalDeviceDirectory()` call,
which requires internet (`ChatContext.tsx:215–254`, the `seedWhenOnline`
effect) — so a participant's device registered/rotated while *this* phone had
no internet (precisely mesh's reason to exist) can never be trusted until both
sides regain internet, at which point mesh is no longer needed anyway.

## 2. Every point a message can be silently dropped

| # | Location | What happens | DM / Group |
|---|---|---|---|
| 1 | `ChatContext.tsx:1099` | `cloudRelay: type==='group'` — DM ops permanently excluded from the only internet-based delivery path | DM |
| 2 | `meshCloudRelay.ts:43-50` | Flush filter skips every DM op, silently, every single call | DM |
| 3 | `nearbyMessageService.ts` (5 call sites) | `broadcastQueuedNearbyMessages` is never wired to "internet restored" | DM (fatal — its only channel) |
| 4 | `ChatContext.tsx:302-312` | Envelope for a `chatId` not yet in the local thread cache is dropped, no retry once synced | both |
| 5 | `ChatContext.tsx:317-327` | DM anti-relay origin-device check rejects any envelope not from the claimed direct peer | DM |
| 6 | `meshMessageProtocol.ts:462-464` | `resolveMeshThreadAudience` returns `null` → `isMeshBodyAuthorizedForThread` fails closed | both |
| 7 | `meshMessageProtocol.ts:467` | 7-day / 60s age gate rejects an old or clock-skewed envelope | both |
| 8 | `meshMessageProtocol.ts:503-514` | HPKE `openWithIdentity` failure (e.g. empty identity-key cache) swallowed, returns `null` | both |
| 9 | `ChatContext.tsx:341-343` | Dedup no-op (`claimMeshMessageProcessing` returns `false`) — no event at all, not even `'rejected'` | both |
| 10 | `ChatContext.tsx:384` | Second silent dedup point post-decrypt (`enqueueMeshMessage` returns `false`) | both |
| 11 | `ChatContext.tsx:451-453` | `startNearbyMessaging` failure → `console.warn` only, no user-facing signal that mesh is dead | both |
| 12 | `nearbyMessageService.ts:158-162` | Any native send exception swallowed, no event, no scheduled retry | both (worst for DM) |
| 13 | `nearbyMessageService.ts:125` | A group op with no `wireEnvelope` (build failure swallowed at §1.1) is never attempted over nearby at all — depends entirely on cloud relay | group |
| 14 | `meshCloudRelay.ts:120-124` | FIFO `catch { break }` — one stuck operation blocks every later operation, in every group, indefinitely | group |
| 15 | `meshMessageQueue.ts:48-64` | 7-day TTL silently excludes aged operations from every future queue read (not deleted, just invisible) — terminal for a DM | both, terminal for DM |
| 16 | `ChatContext.tsx:1104` | `enqueueMeshMessage`'s return value is discarded; a resend reusing the same id while a stale entry exists silently fails to replace it | both, edge case |
| 17 | `SplitCircleMeshModule.swift:214-254` (`updateTrustedPeers`) | Trust promotion of an already-connected peer calls `emitState()` but never `emitPeerCount()` — the one signal that triggers rebroadcast | both |
| 18 | `SplitCircleMeshModule.swift` gossip forwarding | Re-broadcast reuses the origin's frozen `recipientDeviceIds`; a device not in it at seal time can never receive that envelope via gossip | group |
| 19 | `nearbyTrustService.ts:138-141` | Device-id ownership ambiguity (post sign-out/sign-in) silently excludes a legitimate device from `trustedDeviceIds` | both |
| 20 | `NearbyMessagingSheet.tsx` + `nearbyMessagingState.ts` | Even a reported `'rejected'`/`'blocked'` event lives in a single-slot value, overwritten by the next mesh event, visible only if the user manually opens the sheet | both |

## 3. Scenario reproductions

### Scenario A — DM while physically separated

**Repro:** A sends a DM to B while B is offline and out of MultipeerConnectivity
range. Later, both A and B regain internet but are never again in the same
physical room before A's 7-day TTL expires.

**Expected:** the DM eventually arrives once both are reachable by any means.
**Actual (confirmed):** it never arrives. `cloudRelay: false` is stamped
permanently at send time (`ChatContext.tsx:1099`); `flushMeshCloudRelay`
`continue`s past it on every single invocation forever
(`meshCloudRelay.ts:43-50`); `broadcastQueuedNearbyMessages` is never invoked
by connectivity change, only by mesh-topology events that require physical
proximity B will never provide in this scenario. The operation silently ages
out at the 7-day TTL (`meshMessageQueue.ts:48-64`) with zero notice to A, whose
UI still shows... whatever pre-TTL status it last had (still "sending"/local,
since it never got a transport ack either — this specific case never even
reaches the false-"sent" problem in Scenario C, it just stalls forever, then
vanishes from the queue silently).

**Classification:** mixed. The *mechanism* (no cloud relay for direct chats)
is explicitly and repeatedly commented as intentional (`meshCloudRelay.ts:1-4`,
`ChatContext.tsx:462-463`, `1079-1082`) — see §5a for why that intent doesn't
actually require this outcome. The *outcome* (a message that reads "sent" or
sits silently, then is permanently and unrecoverably lost with zero warning)
is a **silent failure**: no comment anywhere accepts this consequence as
designed.

### Scenario B — group message offline flush ordering

**Repro:** A sends 3 group messages while offline (ops `M1`, `M2`, `M3`,
queued in that order). Internet returns. `M1`'s Firestore write throws a
transient error during flush.

**Expected:** `M1` retries; `M2`/`M3` are unaffected or merely delayed one
flush cycle.
**Actual (confirmed):** `catch { break; }` (`meshCloudRelay.ts:120-124`) exits
the loop unconditionally. Because `loadMeshMessageQueue()` reloads in stable
creation order and nothing marks/reorders/removes `M1`, the **next** flush
call hits `M1` again first — so `M1` genuinely does retry, not skip. But the
loop scope is the **entire mesh queue**, not per-chat: if `M1` keeps failing
(a real, non-transient error, not just a one-off blip), `M2`, `M3`, and every
other group's queued operations are re-blocked on **every** subsequent flush,
indefinitely — until `M1` either succeeds or ages past the 7-day TTL and
silently drops out of `loadMeshMessageQueue()`'s results, at which point the
queue is "unblocked" only by permanently sacrificing `M1`.

**Classification: bug.** The comment states the *intent* is per-conversation
ordering preservation ("reorder a conversation on the server"). The
*implementation* scopes that guarantee globally across every group instead of
per-chat, with no retry cap or backoff — a mismatch between stated intent and
actual behavior.

### Scenario C — Signal session stale + HPKE key missing

**Repro:** A's Signal ratchet session with B is stale (prekeys exhausted while
both were offline); `buildMeshMessageBody` falls back to HPKE, sealing to B's
cached identity key. B's own identity-key cache was never seeded (e.g. B never
completed the online-priming step). B receives the envelope; HPKE
`openWithIdentity` throws.

**Expected:** some visible "delivery failed" or "could not verify" signal to
one or both parties.
**Actual (confirmed):** `decryptMeshFieldsForDevice`'s HPKE branch swallows
the exception and returns `null` (`meshMessageProtocol.ts:503-514`).
`ChatContext.tsx:346-355` reports a `'rejected'` event and returns — the
message is never saved, never enqueued, and the dedup claim is released with
nothing durable left behind. **On B's side:** the `'rejected'` event is
visible only if B happens to manually open the per-chat Nearby Messaging sheet
before it's overwritten by any other mesh event — no toast, no badge, no log.
**On A's (sender's) side: nothing at all.** A's local status already flipped
to `'sent'` the moment the transport reported `sent > 0` recipients
(`nearbyMessageService.ts:131-156`) — a delivery acknowledgment with no
decrypt/receipt confirmation channel back from B anywhere in this codebase. A
sees a successful send for a message that was permanently and silently
dropped.

**Classification: silent failure with a correctness-bug consequence.**
Fail-closed on undecryptable ciphertext is the correct security posture and
presumably intentional. What is not designed or documented anywhere is the
total absence of a decrypt-failure signal flowing back to the sender, combined
with a sender status that already reports success from transport delivery
alone.

### Scenario D — gossip bridging failure

**Repro:** three devices A, B, C. A reaches B; B reaches C; A does not reach C
directly. A sends a group message. B receives and is expected to bridge it to
C via re-broadcast.

**Expected:** C eventually receives the message via B relaying it.
**Actual (confirmed): C does not receive it, and the exclusion is permanent
for that specific envelope.** `buildMeshMessageBody` freezes
`encryptedForDevices` (and therefore `recipientDeviceIds`) at **seal time**,
from A's own local cache of the thread's audience. If C's device wasn't in
A's cache at that instant (new member, rotated device, or simply never seen
online by A), C's id is absent — not from any transport limit, but because A
never had a key to seal a copy for C. B does not rebuild or re-seal anything
when it relays: `enqueueMeshMessage` at `ChatContext.tsx:358-383` re-queues
A's *exact*, unmodified `wireEnvelope` and A's *exact*, unmodified
`recipientDeviceIds` — even though B, having just decrypted its own copy,
does hold the plaintext. Native `send()`
(`SplitCircleMeshModule.swift:347-367`) filters `connectedPeers` by
`recipients.contains($0.displayName)`; C is a connected, trusted peer of B at
the session level but is excluded from `recipients`, so B transmits to zero
peers with respect to C for this envelope.

The only escape hatch is **outside** the mesh subsystem: for a group thread,
A's own origin-owned queue entry has `cloudRelay: true`, so if A itself later
regains internet, `flushMeshCloudRelay` pushes the message through the normal
RTDB path against *current* membership, which does reach C. B's *relayed*
copy is marked `cloudRelay: false` (the "a relay cannot safely impersonate the
origin" comment at `ChatContext.tsx:370`), so B/C's proximity does nothing —
only A regaining connectivity fixes it. For DMs there is no cloud-relay
fallback at all, so the exclusion is absolute.

**Classification: by design / structural**, not a bug — there is no
re-sealing step anywhere in the protocol, and adding one has real security
implications (see §5e). The gap is real but the current mitigation (group
cloud relay from the *origin*) is sound; it's undocumented as an accepted
limitation, which this doc now fixes.

### Scenario E — thread audience mismatch

**Repro:** an older DM thread has `participantIds: ['userA']` and
`participants: [{userId: 'userA'}]` — userB is missing from **both** arrays
(not just one).

**Expected:** the message is rejected or repaired, with some feedback.
**Actual (confirmed):** `resolveMeshThreadAudience` (`meshMessageProtocol.ts:155-166`)
unions both arrays — `normalizedAudience([...participantIds, ...participants.map(userId)])`
— then requires the union to have exactly 2 entries for a `'direct'` thread.
Here the union is `['userA']`, length 1, so it returns `null`. **This cannot be
repaired by the existing union logic**, because the union logic only helps
when one of the two local arrays is complete and the other is stale — here
userB's id is absent from *every* local source. Send-side: `buildMeshMessageBody`
returns `null`, A gets a visible `'failed'` bubble (since `thread.type ===
'direct'` rethrows per §1.1) — real but generically worded, never naming the
actual cause. Receive-side: `isMeshBodyAuthorizedForThread` returns `false`,
`ChatContext.tsx:330-338` reports a `'rejected'` event and returns — silent,
same single-slot/manual-sheet visibility limit as Scenario C.

**Classification: bug.** `resolveMeshThreadAudience`'s own doc-comment
(`meshMessageProtocol.ts:143-153`) exists specifically to work around
`participantIds`/`participants` divergence between old and new clients — the
exact class of shape drift CLAUDE.md already documents repeatedly elsewhere in
this codebase (`isGroupJoinUpdate`/`isGroupDepartureUpdate`, doc 30's
`displayName` rollout). A thread missing a member from *both* arrays is a
symptom of an upstream data-integrity defect the local union can't see past,
not an intended terminal state.

## 4. Test coverage gaps

All five scenarios have **zero genuine reproduction+assertion coverage** today.
Every existing test exercises the underlying unit in a clean/happy-path or
single-failure configuration; none reproduce the specific compound/end-to-end
condition described above, and none assert on the resulting user-visible
outcome.

| Scenario | Covered? | Notes |
|---|---|---|
| A | No | `meshCloudRelay.test.ts`'s direct-chat test hand-constructs `cloudRelay:false` and asserts the relay no-ops — it never tests what (if anything) eventually delivers such a message, or that it silently expires |
| B | No | Only 2 tests exist in `meshCloudRelay.test.ts` (one direct-skip, one successful group flush); neither injects a mid-batch error or calls `flushMeshCloudRelay` twice to observe resume/skip/loss |
| C | No | The only HPKE test in `meshMessageProtocol.test.ts` is a happy-path *recovery* (ratchet fails, HPKE succeeds) — no test covers a missing/empty identity key on either the build or decrypt side |
| D | No | `nearbyMessageService.test.ts`'s gossip test is single-hop only; no 3-device relay scenario exists anywhere, despite `broadcastQueuedNearbyMessages`'s own docstring explicitly claiming "bounded gossip across a partial mesh" |
| E | No | The `resolveMeshThreadAudience() === null` case is tested in isolation only — never threaded through `buildMeshMessageBody` or `isMeshBodyAuthorizedForThread` to confirm the downstream silent-drop |

Also flagged: the 7-day TTL filter in `meshMessageQueue.ts`'s `readUnlocked`
has **zero** test coverage — every fixture across `meshMessageQueue.test.ts`
uses `createdAt: Date.now()`. By contrast, `claimMeshMessageProcessing`'s
dedup/claim semantics **are** well covered (three solid tests) — the gap is
specific to the five scenarios above and TTL, not a general testing gap in
these files.

## 5. Locked fix decisions

### 5a. DM offline gap — **chosen: extend origin-owned cloud relay to direct chats** (a corrected Option 1, not a new feature) — BUILT 2026-07-30

The brief framed this as three options, including "add an RTDB-backed cloud
relay for DMs, gated on a user preference, with a privacy disclosure." That
framing assumes DMs don't already touch the cloud. **They do, unconditionally,
every time the user has internet** (§1.1's online path calls the identical
`queueMessage`/`queueMessageToOwnDevices` for DMs and groups alike). The fix is
not "add a new delivery channel with new privacy implications" — it's "stop
excluding origin-owned DM operations from the fallback path that reaches the
exact same RTDB channel a DM already uses whenever it's sent online."

Concretely:
- Change `cloudRelay: latestThread.type === 'group'` to `cloudRelay: true`
  unconditionally for origin-owned operations (`ChatContext.tsx:1099`).
- Remove the `operation.chatType !== 'group'` clause from
  `meshCloudRelay.ts:43-50`. `originOwned` (already checked, already the
  actual impersonation guard) continues to prevent a device from cloud-relaying
  someone *else's* message — the property the "can't impersonate the origin"
  comment is actually protecting.
- `flushMeshCloudRelay`'s existing per-recipient `queueMessage` loop already
  works unchanged for a direct chat's single recipient (it already computes
  `recipients = operation.participantIds.filter(id => id !== currentUserId)`,
  which is chat-type-agnostic).
- No new user preference or privacy disclosure: this converges two paths
  (online-sent vs. offline-then-reconnected) that a user would reasonably
  expect to behave the same way, without creating any capability that doesn't
  already exist today for the "just don't happen to be offline" case.

**UI treatment while queued and mesh-only:** per Option 3's spirit, the
message's local status during the window before either mesh delivery or cloud
flush succeeds should read as "sending" (not a false "sent" — see 5c), so nothing
new is claimed here beyond what 5c already fixes.

### 5b. Group flush FIFO — **chosen: partition by chat + bounded retry with backoff** — BUILT 2026-07-30

Two independent fixes, both needed:

1. **Scope the break to the failing operation's own chat**, not the entire
   mesh queue. Group `flushMeshCloudRelay`'s operations by `chatId` before
   iterating; a failure in chat X's list `break`s only chat X's remaining
   operations for this flush, and other chats proceed normally. This directly
   fixes the "one bad group blocks every other group" bug while preserving the
   original, correct intent (never reorder messages *within* one conversation).
2. **Bounded retry with backoff per operation**, so a genuinely broken (not
   transient) operation doesn't retry-and-fail on every single reconnect
   forever, silently consuming the 7-day TTL. Track an attempt counter on the
   operation (`meshCloudRelay.ts` already round-trips the operation through
   `updateMeshMessage`, so this is a field addition, not new plumbing);
   skip retrying an operation until its backoff window elapses; after a capped
   number of attempts, surface a real "failed to send" status on that specific
   message (ties into 5c) rather than silently retrying until TTL expiry
   discards it.

### 5a + 5b: what actually landed (2026-07-30)

**5a.** `cloudRelay: latestThread.type === 'group'` → `cloudRelay: true`
([ChatContext.tsx](../../src/context/ChatContext.tsx)), and the
`chatType !== 'group'` clause removed from `flushMeshCloudRelay`'s filter
([meshCloudRelay.ts](../../src/services/meshCloudRelay.ts)) — `originOwned`,
checked separately, remains the guard against relaying someone else's message.
Two things the plan did not anticipate, both found while implementing:

- **`isGroupChat` was hardcoded `true` at both fan-out call sites** inside the
  relay (`queueMessage(recipientId, msg, true)` and
  `queueMessageToOwnDevices(..., true)`). Harmless while the path was
  group-only; with DMs flowing through it that would mislabel every relayed DM
  as a group message, changing delivery-receipt and notification handling on
  the receiving side. Now derived from `operation.chatType`.
- **The `direct` rethrow in the send path had to go.** `ChatContext` rethrew
  when a DM could not build a nearby envelope, on the stated grounds that
  "direct messages are intentionally local-mesh-only, so silently accepting an
  unsigned/unsharable direct message would lie". With 5a that reasoning
  inverts — the message now *does* have a durable path — so continuing to mark
  it `failed` would itself be the lie. It now only throws when
  `resolveMeshThreadAudience` returns null, i.e. the thread's membership cannot
  be resolved at all and there is genuinely nobody to address the message to on
  either path (Scenario E; repair is §5d).

Duplicate delivery was checked rather than assumed: a DM delivered by mesh is
still in the queue when connectivity returns, so it gets cloud-relayed too.
That is the same dual delivery groups have always done, and
`saveMessageLocally` upserts by message id with explicit "cloud convergence
replay" handling — so it converges instead of double-posting.

**5b.** `flushMeshCloudRelay` now buckets operations by `chatId` and drains
each bucket through `drainChatBucket`, which stops at the first failure in
*that* conversation only. Ordering is a per-conversation property; enforcing it
globally is precisely what let one stuck operation starve every other chat.
Failure bookkeeping added to `MeshMessageOperation`: `cloudRelayAttempts` and
`cloudRelayNextAttemptAt`, with escalating backoff (5s → 30s → 2m → 10m → 30m)
and a cap of 6 attempts. On hitting the cap the message is marked `failed`
(visible and resendable) and the operation is retired from the relay path via
`cloudRelay: false` — which deliberately leaves any nearby envelope it carries
still broadcastable, and unblocks the rest of that conversation. Previously a
permanently-undeliverable operation retried on every reconnect until the 7-day
TTL discarded it silently.

Both are covered by the rewritten
[`meshCloudRelay.test.ts`](../../src/services/__tests__/meshCloudRelay.test.ts)
(10 tests). Note the old suite contained a test named *"never uploads or
cloud-fans-out a direct nearby message"* that still passed after the change —
its fixture hardcoded `cloudRelay: false`, so it was asserting the flag, not
the chat type. It has been replaced by a test asserting a direct message IS
relayed and labelled `isGroupChat: false`; a stale test whose name asserts the
opposite of current intent is worse than no test.

### 5c. Signal/HPKE fallback surfacing — **chosen: add a decrypt-failure NACK + inline chat-thread surfacing** — BUILT 2026-07-30

Two changes:

1. **A lightweight NACK envelope.** When `decryptMeshPayloadForDevice` (or its
   Signal-path equivalent) fails for a claimed operation, the receiver sends a
   small signed "could not decrypt message `<id>`" NACK back to the origin —
   over mesh if still in range, otherwise queued for cloud delivery once
   online (reusing the same origin-owned relay path 5a establishes for DMs,
   generalized to carry NACKs as well as messages). The sender's message
   tracking updates that specific message's status to a real "delivery
   failed" state when a matching NACK arrives, instead of leaving the
   transport-only "sent" status unchallenged.
2. **Inline surfacing, not just the manual sheet.** For both `'rejected'` and
   `'blocked'` nearby events tied to the currently-open chat thread, render an
   inline system message in that thread (mirroring how other system messages
   already render) rather than relying solely on `NearbyMessagingSheet`'s
   single-slot `lastMessageEvent`, which is invisible unless the user happens
   to open that specific sheet at the right moment.

### 5c + 5d: what actually landed (2026-07-30)

**5c — delivered as a negative RECEIPT, not a new mesh NACK protocol.** The
plan called for a signed NACK envelope with its own mesh-or-cloud delivery.
Building a second signed wire format for one signal was disproportionate when
`receipts/{chatId}/{messageId}/{recipientId}` already exists, the sender is
already listening on it via `listenForReceipts`, and an RTDB write made while
offline lands as soon as connectivity returns — which covers the offline-mesh
case that motivated the NACK in the first place. Concretely:

- `ReceiptData` gains `undecryptable`/`undecryptableAt`;
  `sendUndecryptableReceipt` writes it.
- `listenForReceipts` reports a new `'undecryptable'` status, ranked **below**
  delivered and read on purpose: if any recipient actually received the
  message, the sender must not be told it failed — otherwise one stale device
  in a group would fail a message everyone else read.
- Both receive paths report it: the online path (which already rendered a
  `⚠️ Couldn't decrypt` placeholder but told the sender nothing) now sends the
  receipt *instead of* a delivery receipt — sending both would hide the very
  thing being reported. The mesh path, which previously discarded the message
  entirely, now also leaves the same visible placeholder bubble the online path
  always has.
- `ChatContext` maps `'undecryptable'` → local status `'failed'`, since
  `MessageStatus` has no such member and a failed bubble is the actionable,
  resendable outcome.

The security line is unchanged and worth restating: this is only ever sent for
an envelope that **already passed** signature and audience verification. An
unverifiable envelope is still dropped in silence — acknowledging it would
confirm receipt to an unverified sender.

**5d — the local union is the fix; the server repair is the follow-up.** Two
halves, because they solve different halves of the problem:

- `reconcileChatAudience` unions `participantIds` with `participants[].userId`
  in `ChatContext`'s snapshot mapper. This was `data.participantIds ?? …`,
  which only handled the array being *entirely absent*; when both existed and
  disagreed the stale one won. Since every device applies the identical union
  to the same document, they all agree **without any write** — this alone fixes
  Scenario E for every device that can see the chat.
- The write-back exists for the one case a union provably cannot reach: a user
  missing from `participantIds` never matches the `array-contains` query that
  loads their chat list, so their device never receives the document it would
  need to repair. Someone else has to fix it for them.

**The write-back had to be a Cloud Function, and this was a rules wall, not a
preference.** `firestore.rules`'s `isChatMutableUpdate()` explicitly asserts
`request.resource.data.participantIds == resource.data.participantIds` (and the
same for `participants`), and `isGroupChatJoinUpdate()` only lets a caller add
*themselves* to a group. A client repair write is denied, permanently — the
same class of wall CLAUDE.md documents for invite-code joins. Loosening the
rule is not available either: rules cannot map `participants[].userId` to
compare it against `participantIds`, so any client-writable form would have to
permit adding arbitrary ids to a chat, which is a read-access escalation (the
chat read rule is membership-based). `functions/src/chatAudienceRepair.ts`
derives the union from the document's own contents inside a transaction, so no
caller can inject a participant, and authorizes against *either* array —
because the caller may legitimately be the person missing from the stale one,
which is exactly the corruption being repaired.

### 5d. Thread audience mismatch — **chosen: server-side repair on the next authoritative sync**

The existing `resolveMeshThreadAudience` union already handles "one array
stale, one complete." Scenario E — both arrays missing the same member — can't
be fixed by reconciling two locally-cached, both-incomplete sources; it needs
the authoritative Firestore doc. Fix: wherever the app's chat-thread listener
normalizes an incoming Firestore snapshot into local `ChatThread` state,
detect any divergence between `participantIds` and `participants[].userId`
(not just the null/exactly-2 case `resolveMeshThreadAudience` checks), and:
- apply the same union locally for immediate correctness (already effectively
  happening for the repairable case), and
- if this device has write access, write the corrected, unioned
  `participantIds`/`participants` back to the Firestore doc, so the fix
  propagates to every other device's next sync instead of each device
  silently re-deriving its own local patch forever.

This runs as a normal part of the existing online chat-sync pipeline, not as a
new reactive check inside the mesh code — mesh should keep failing closed on a
`null` audience; the fix is upstream, at the data source.

### 5e. Gossip bridging correctness — **chosen: document as an accepted limitation, do not build a re-seal path this pass**

Building a re-seal path (B re-encrypting a fresh copy for a device added to
the thread after A sealed the envelope) is technically possible — B does hold
the plaintext after decrypting its own copy — but it changes the security
model: a re-sealed copy attributed to A but actually authored/encrypted by B
needs its own signature/authorization story to avoid B being able to forge
messages "from" A to a new recipient. That's a real cryptographic design
question, not a plumbing fix, and is out of scope for this pass.

**Ruling:** accept the limitation for mesh-only gossip (a message sealed
before a device joins the audience will never reach that device via gossip
relay) and rely on the existing mitigation — group messages already reach a
newly-added device once the *origin* regains internet and `flushMeshCloudRelay`
runs against current membership (and per 5a, this now applies to DMs too, for
whatever it's worth given DMs are never gossip-relayed in the first place —
see §1.4's origin-device check). This doc makes the limitation explicit;
previously it was an accidental consequence of the freeze-at-seal-time
protocol, undocumented as intentional.

### 5f. Native trust-promotion gap — **chosen: add the missing `emitPeerCount()` call** — BUILT 2026-07-30, NOT device-verified

Found during this research pass, not in the original brief, but it's a
concrete, confirmed root cause of "peer is reachable but queued messages
aren't retried," so it belongs in the fix plan: `updateTrustedPeers`
(`SplitCircleMeshModule.swift:214-254`) calls `emitState()` (252) but never
`emitPeerCount()`, so `nearbyMessageService.ts`'s `peerSubscription` — the sole
consumer of `onPeersChanged` and the only thing that calls
`broadcastQueuedNearbyMessages()` off a peer-count change — never fires when a
peer transitions from pairing/untrusted to trusted while already connected
(the `promotedConnectedPair` branch, lines 222-224/245-251). This is exactly
the shape of a freshly-completed pairing ceremony. Fix: call `emitPeerCount()`
alongside `emitState()` at line 252 (and anywhere else trust changes without
going through `session(_:peer:didChange:)`, which already calls both).

**What actually landed (2026-07-30):** `emitPeerCount()` added immediately
before the existing `emitState()` at the end of `updateTrustedPeers`, matching
the `emitPeerCount()` → `emitState()` ordering `session(_:peer:didChange:)`
already uses (lines 1198-1199, 1220-1221), with a comment explaining why this
site needs it. Checked while making the change:

- **The fix reaches the intended consumer.** `nearbyMessageService.ts:192-197`
  calls `broadcastQueuedNearbyMessages()` whenever `count > 0`; a
  promoted-while-connected peer is in both `session.connectedPeers` and (now)
  `trustedDeviceIds`, so `emitPeerCount()`'s recompute resolves to ≥ 1 and the
  broadcast fires. This was verified by reading the consumer, not assumed.
- **The rebuild branch double-emits, harmlessly.** When
  `connectedUntrusted || (addedTrust && !promotedConnectedPair)` is true,
  `rebuildTransportLocked()` → `replaceSessionLocked()` already emits
  `emitPeerCount(0)` (line 299) and installs a fresh `MCSession` with no
  connected peers, so the new unconditional call recomputes to 0 and emits 0 a
  second time. The JS listener guards on `count > 0`, so a duplicate 0 is a
  no-op. Placing the call unconditionally (rather than only inside the `else`
  branch) was chosen deliberately: it matches `didChange`'s unconditional
  pattern and cannot miss a future branch added above it.
- **No `pod install` needed.** This edits an existing file already referenced
  in `Pods.xcodeproj` (4 refs) and covered by the podspec's
  `**/*.{h,m,mm,swift,hpp,cpp}` glob — the CLAUDE.md gotcha about a NEW
  `.swift` file compiling to nothing does not apply here. Confirmed rather
  than assumed.
- **`xcrun swiftc -parse` on the file: exit 0, zero diagnostics.**

**Not verified, and cannot be without a real build:** native changes are
invisible to the jsbundle hot-swap (CLAUDE.md), and local Release sim builds
are banned in this repo, so the runtime behavior — that completing a pairing
ceremony now immediately flushes that peer's queued nearby messages — has NOT
been observed. Verifying it needs `npm run ship:ios` (or a one-off debug
`xcodebuild` + `simctl install`) and then the two-device pairing repro:
queue a nearby message to a peer *before* pairing completes, complete the
pairing ceremony, and confirm the message delivers without any further
topology change (previously it would sit until an unrelated peer event fired).
Do not mark this verified until that has actually been run — per doc 31 §5c,
a green build proves nothing about this.

## 6. What was explicitly ruled out and why

- **A new user preference + privacy disclosure for "send DMs via cloud when
  nearby unavailable"** (the brief's literal Option 1) — ruled out because DMs
  already unconditionally use the cloud (RTDB) whenever the sender has
  internet; adding a preference/disclosure for the reconnect-flush case alone
  would be inconsistent with, and imply a false distinction from, the existing
  always-on online path.
- **"Keep the current design but make the UI explicit" as the DM fix** (the
  brief's Option 3) — ruled out as the *primary* fix once 5a showed the real
  gap is a wiring bug, not a load-bearing design constraint; a "nearby-only,
  must meet in person" status bubble would be honest but would ship a worse
  product than simply delivering the message once possible, when the delivery
  mechanism (RTDB) is sitting right there, already used for DMs today, and
  already safe under the existing `originOwned` guard.
- **A cryptographic re-seal path for gossip bridging** (5e) — ruled out for
  this pass; it's a genuine security-design question (can a relay legitimately
  mint a new sealed copy attributed to the original sender?) that deserves its
  own scoping, not a bolt-on to a reliability fix.
- **Retrying `broadcastQueuedNearbyMessages` on a fixed interval/timer as a
  blanket fix** for the native `emitPeerCount` gap (5f) — ruled out in favor of
  fixing the actual missing call; a polling timer would mask this specific bug
  and any future instance of the same "state changed, matching event not
  fired" mistake, rather than fixing the root cause.

## 7. Sequenced build order

1. **5f (native `emitPeerCount` fix)** — ✅ **code landed 2026-07-30**, pending
   device verification (see §5f). Smallest, most isolated change, unblocks
   real-world "just paired, why isn't my queued message going" cases
   immediately, no dependency on anything else here.
2. **5d (thread audience repair)** — ✅ **built + deployed 2026-07-30**, though
   last rather than second: 5a shipped ahead of it with the mitigation that an
   unresolvable audience still fails the send visibly. The client half (the
   local union) is what actually fixes the symptom; the server half
   (`repairChatAudience`) is live and handles the case the union cannot reach.
3. **5a (DM cloud-relay extension)** — ✅ **built 2026-07-30.** The core
   "message eventually delivered" fix for the reported symptom. Was sequenced
   after 5d so audience resolution would be trustworthy first; shipped ahead of
   it instead, with the mitigation that the send path still fails visibly when
   `resolveMeshThreadAudience` returns null, so an unaddressable message is
   never silently accepted. 5d remains worth doing for the repair itself.
4. **5b (FIFO partition + backoff)** — ✅ **built 2026-07-30**, alongside 5a
   rather than before it. Independent of 5a/5d, but genuinely needed *with* 5a:
   5a increases the volume and variety of operations flowing through
   `flushMeshCloudRelay` (DMs now, not just groups), which widens the blast
   radius of the global head-of-line block it removes.
5. **5c (decrypt-failure NACK + inline surfacing)** — ✅ **built 2026-07-30**,
   as a negative receipt on the existing `receipts/` channel rather than a new
   signed mesh format (see above). Did not end up depending on 5a/5b at all.
6. **5e (document the gossip limitation)** — pure documentation, already done
   in this doc; no code dependency, can happen any time.

## 8. Gotcha for CLAUDE.md

The strongest "will get silently reintroduced" candidate is **5f**, not the
FIFO or DM-relay bugs — those are each a single, already-identified call site
that gets fixed in this same pass. The native trust/state-emission split is
structural: any future native code path that changes peer trust or connection
state without going through `session(_:peer:didChange:)` can reproduce the
identical bug, and nothing (not the compiler, not a lint rule, not a test)
catches a missing `emitPeerCount()` call — it's a silent omission, exactly like
the Firestore-rules "missing branch for a new membership-shape change" class of
bug this codebase has already been burned by more than once. Entry added to
CLAUDE.md's "Gotchas that have burned us" section (see the diff below).

## 9. Out of scope for this pass

- Building 5c's NACK protocol's actual wire format/signing — flagged as a
  needed addition, not designed in cryptographic detail here.
- A general audit of every other native Swift path that mutates
  `trustedDeviceIds`/`connectedPeers`-adjacent state for the same missing-
  emission pattern beyond `updateTrustedPeers` — 5f fixes the one confirmed
  instance; a broader sweep of the whole file for the same class of bug is
  worth doing but wasn't performed here.
- Retroactively repairing thread docs already affected by Scenario E's shape
  drift in production — 5d's fix is forward-looking (repairs on next sync);
  whether a one-time backfill script is warranted depends on how many existing
  threads are actually affected, which wasn't measured in this pass.
- Redesigning the transport-ack-only "sent" status into a full delivery-receipt
  system beyond what 5c's NACK adds for the specific decrypt-failure case.
## 10. Round 2 (2026-07-30) — two DIFFERENT bugs, found from production evidence

Reported after the §5f fix landed: (a) "more than 2 devices couldn't mesh up",
(b) "others' messages are syncing but my own messages are not syncing across my
linked devices". Neither is any of §3's scenarios — §1-§9 are about the OFFLINE
mesh queue, while both of these break while fully ONLINE. Both are now fixed.

### 10.1 Own messages never reached own linked devices — FIXED

**Evidence first, not inference.** `firebase functions:list` confirmed
`fanOutQueuedMessage` IS deployed (ruling out this repo's classic
"written but never pushed" gotcha), and its production logs showed the shape of
the bug directly: across a whole session of real traffic, every fan-out logged
`skippedOrigin: false` — inbound peer messages — with exactly ONE
`skippedOrigin: true` entry. `originDeviceId` is set *only* by
`queueMessageToOwnDevices`, so `skippedOrigin: true` is the signature of a
self-mirror. One in the entire window means the self-mirror was almost never
being **written at all**. The same logs showed peers fanning out to that same
account's `deviceCount: 3` continuously, proving all three devices had healthy
published keys and were reachable — so the failure was specific to *self*-
encryption, not to the devices.

**Root cause.** `queueMessageToOwnDevices`
([messageQueueService.ts](../../src/services/messageQueueService.ts)) called
`encryptMessageForRecipient` with only three arguments, so `coveragePolicy`
defaulted to `'all-devices'`. That policy *throws* `EncryptionRequiredError`
unless every one of the sender's other devices could be encrypted for
([messageEnvelope.ts:121-123](../../src/services/messageEnvelope.ts)) — and
`ensureSessionWithDevice` returns `false` silently on any prekey-claim failure
([signalCryptoService.ts:560-562](../../src/services/signalCryptoService.ts)).
So ONE sibling device with an unestablishable session threw, and
`queueMessageToOwnDevices`'s own catch swallowed the throw into a
`console.warn` — meaning **no** sibling got the message, healthy ones included,
and nothing anywhere said so. With three devices this is strictly more likely
to trip than with two, which is why it correlated with adding a third device.

**Why the strict policy is wrong *here* specifically:** `'all-devices'` exists
to stop a downgrade-to-plaintext attack on a real recipient — someone who can
make one device's keys unavailable must not thereby force the message into the
clear. Self-sync has no plaintext fallback at all (it returns early instead),
so there is no downgrade to defend against, and delivering to the reachable
devices strictly beats delivering to none. Fixed by passing the
already-existing `'available-devices'` policy, and by raising the swallow from
`console.warn` to `console.error` — a Release bundle's `console.warn` never
reaches the device log (CLAUDE.md), which is precisely why a total self-sync
outage stayed invisible. Guarded by a new regression test,
[`selfSyncCoverage.test.ts`](../../src/services/__tests__/selfSyncCoverage.test.ts)
(4 tests), which pins the policy argument at the call site, the partial-coverage
write, the genuine single-device no-op, and the never-fail-the-send contract.

### 10.2 Three or more devices could never form a mesh — FIXED

Not a discovery or capacity limit (MCSession holds 8 peers, and the
lexicographic invite tiebreaker at
[SplitCircleMeshModule.swift:1053](../../modules/splitcircle-mesh/ios/SplitCircleMeshModule.swift)
is present and correct). The bug is that **two different code paths tore down
the entire shared MCSession to deal with a single peer**, disconnecting every
healthy peer as collateral:

1. **Invitation timeout.** `beginInvitation`'s 15s timeout handler called
   `replaceSessionLocked()` unconditionally. Written to clear a genuinely
   wedged session, it also destroyed every established connection. With two
   devices that self-heals invisibly; with three or more, invitation timeouts
   are frequent enough that each one collapsed the whole mesh and it could
   never converge. Now gated on `session.connectedPeers.isEmpty` — a wedged
   session with nothing connected costs nothing to replace, which is the case
   the remedy was actually for.
2. **Trust expansion.** `updateTrustedPeers` called `rebuildTransportLocked()`
   for both trust *revocation* and trust *expansion*. Revocation genuinely
   requires it (MCSession cannot selectively evict a peer). Expansion only
   needs discovery restarted so previously-ignored radios are re-found — and
   this function runs on **every** `threads` change (ChatContext's
   trust-refresh effect), so routine app activity was tearing the mesh down.
   `rebuildTransportLocked` gained a `replacingSession: Bool = true`
   parameter; the expansion branch now passes `false`, keeping the eviction
   semantics for revocation and dropping the collateral damage.

**Status:** both changes parse clean (`xcrun swiftc -parse`, exit 0) and the
full JS suites pass (213 services + 419 unit). The mesh half is native, so —
same caveat as §5f — it cannot be proven by the jsbundle hot-swap and has NOT
been verified on hardware. The three-device repro is the verification: run
three paired devices, confirm all three connect simultaneously and stay
connected across a thread-list change (previously any invitation timeout or
trust refresh dropped everyone).


### 10.3 Own messages sent OFFLINE never reached own devices — FIXED 2026-07-31

§10.1 fixed self-sync for the **online** send path. Hardware testing on
2026-07-31 (iPhone 17 Pro + Pixel 7 on one account, an iPhone Mini on a second)
showed it was still totally broken for the **offline** one, and the two are
easy to confuse because the online case works perfectly:

- All three devices offline. 17 Pro ↔ Mini exchange DMs and group messages
  over the mesh; both receive everything.
- All three come back online. The Mini's messages appear on **both** the 17 Pro
  and the Pixel. The 17 Pro's own messages appear on the Pixel **never** — not
  as a failed bubble, not as a `⚠️ Couldn't decrypt` placeholder. Nothing.

**Root cause.** `queueMessageToOwnDevices` was written for, and only ever
exercised by, the online send path — where `ChatContext` builds the message
field-by-field moments earlier, so an absent optional field is *omitted*.
`flushMeshCloudRelay` (§5a) calls the same function with an
`operation.message` **rebuilt from the on-disk mesh queue**, where an optional
field can round-trip as an explicit `undefined`. RTDB rejects `undefined`
outright, so `set` threw — into the function's own catch, which swallows it by
design so a mirror failure can never fail the real send.

Every observable signal therefore stayed green. The message reached its real
recipients over the mesh, the sender's UI showed `sent`, nothing was written
to RTDB, and because nothing was written there is no `fanOutQueuedMessage` log
entry either — the exact diagnostic §10.1 was found with shows *nothing at
all* for these messages, which reads identically to "no message was sent".

Note the sibling `queueGapFillMessage` immediately below it already carried a
comment stating this precise hazard — *"a gap-fill replay of arbitrary local
history has to sanitize where the normal send path could rely on building its
payload field-by-field"* — and already called `stripUndefinedDeep`. The rule
was written down and simply not applied to the other function that had since
acquired the same class of caller. `queueMessage` survives the identical input
only because it rebuilds every nested object field-by-field with truthiness
guards; `queueMessageToOwnDevices` raw-spreads `mediaMetadata`, `replyTo`,
`forwardedFrom` and `expenseRef` straight from storage.

**Fixed** by sanitizing the payload with the existing `stripUndefinedDeep`, and
by making the two silent exits diagnosable:

- `!encrypted` (nobody to mirror to — a genuinely single-device account) stays
  quiet. Logging it would fire on every message those users send.
- `envelopes === {}` (siblings exist, **not one** could be encrypted for) is now
  a loud `console.error`. `'available-devices'` coverage, correct in itself,
  turns that case into an empty map rather than a throw — indistinguishable
  from success at every layer without this.
- The catch now carries `messageId`/`chatId`/`type`, so "failed to mirror" can
  be matched against the one message a user reports missing on another phone.

**Rule this generalizes to:** any function on the online send path that a
store-and-forward/replay path is later pointed at must sanitize its payload.
The two callers differ in exactly one way that matters, it is invisible to
`tsc` and to every test that feeds it a freshly-built message, and the failure
surfaces only as absence.

**Status:** 275 services + 419 unit tests pass, including two new regression
tests (a mesh-queue-shaped message with `undefined` optionals; the
single-device-vs-all-siblings-unreachable distinction). **NOT yet verified on
hardware** — the repro is the offline exchange above.
