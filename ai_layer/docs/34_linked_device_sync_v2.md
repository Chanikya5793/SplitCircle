# 34 — Linked-device sync v2: encrypted JSON batches

**Status: Two live failures diagnosed from production data 2026-07-31.
Decisions LOCKED. Steps 1 and 2 BUILT the same day (§7) — NOT device-verified.
Steps 3-6 (measurement, batching, transport) not started.**

Supersedes nothing. Doc 31 §8.1 (`syncGapService`) and doc 31 Phase 6
(`historyHandoffService`) stay as-is until this replaces their payload path.

---

## 0. The two failures, diagnosed from live data

Read directly from RTDB on 2026-07-31, account `hVkFg6…`:

```
/syncGapRequests/hVkFg6…/
  1d094cff…__76d9aebe…  { sinceTimestamp: ~2026-07-20, createdAt: ~2026-07-30 }
  c1f613d8…__76d9aebe…  { sinceTimestamp: ~2026-07-20, createdAt: ~2026-07-30 }
```

Both requests come from `76d9aebe…` — the **iPhone**. Neither comes from the
Pixel (`52ec8716…`). Both have sat unanswered for about a day, asking for ten
days of history.

### 0.1 Why the Pixel never asks

[`syncGapService.ts:323`](../../src/services/syncGapService.ts:323):

```ts
const localCount = stats?.count ?? 0;
if (localCount === 0) continue;   // SCOPE GUARD
```

A chat with **zero** local messages is skipped. The Pixel was reinstalled, so it
has zero messages in every chat, so every chat is skipped, so it can never raise
a gap request for anything.

The guard's own reasoning is sound and should be preserved:

> *"a freshly paired companion would request full history for every chat it has
> never opened at once, which is precisely the bulk volume this path must not
> carry."*

It defers that case to the history handoff. But the handoff is **one-shot per
device lifetime**, gated on `HANDOFF_RECEIVED_KEY`
([`deviceSyncCoordinator.ts:154`](../../src/services/deviceSyncCoordinator.ts:154)),
and exists to bootstrap a brand-new pairing.

**So the two mechanisms' scopes do not overlap — they leave a hole between them:**

| Device state | Covered by |
|---|---|
| Brand-new pairing, once | history handoff |
| Has some history, fell behind | gap fill |
| **Should have history, has none** | **nothing** |

The third row is a reinstall, an iCloud restore, a handoff that failed or was
interrupted, or simply a chat that never synced. That is exactly the Pixel's
state, and it is unreachable by either mechanism — permanently, with no retry
and nothing shown to the user.

### 0.2 Why the requests are never answered

[`answerGapRequest`](../../src/services/syncGapService.ts:257) replays from the
responder's **own local store**. The iPhone's requests can only be served by:

- the **Pixel** — zero local messages, so `missing.length === 0`, it releases
  the claim and replays nothing; or
- the **iPad** — `lastSeenAt` 2026-07-27, not running.

Nobody holds the data, so nothing is replayed. That part is arguably correct
behaviour. The defect is what happens next: the request sits until
`cleanupOldRtdbData` reaps it at seven days, and **nothing anywhere tells the
user their history is stuck**. It looks identical to being fully synced.

That is the same failure shape as doc 32 §10.1 and §10.3 — a silent path whose
failure is indistinguishable from success. This project has now hit it four
times, which is the strongest argument in this document for §3.5.

### 0.3 What this means

The user's report — *"the Android device goes offline, comes back online, the
messages aren't syncing"* — is **not** a transport bug and not a Firebase
capacity problem. It is a coverage hole. No transport change fixes it, which is
why §5 sequences the hole first.

---

## 1. The cost problem, stated honestly

The user's instinct is right about the payload, and it is worth being precise
about why.

`answerGapRequest` replays **message by message** through
`queueGapFillMessage` → `fanOutQueuedMessage` → per-device RTDB writes. For a
gap of *M* messages across *D* linked devices that is:

- *M* × *D* separate Signal encryptions,
- *M* × *D* RTDB writes, plus the same again in deletes,
- *M* function invocations of `fanOutQueuedMessage`,
- capped at `MAX_REPLAY_PER_REQUEST = 200` per pass, so a large gap needs many
  passes.

Ten days of an active chat across three devices is thousands of writes to move
history the devices could have handed each other once.

**Not yet measured.** Before building, read the Firebase console's usage
breakdown (RTDB bandwidth vs Firestore reads vs function invocations) and record
it here. Two things distort any reading taken before 2026-07-31: the origin-reseal
regression fixed in `42b90d2` was doing a Firestore device read per participant
**per message**, and `listSignalDevices` defaults to `network-preferred`. Design
decisions should not be anchored to a number that a since-fixed bug produced.

---

## 2. Evaluating the proposal

The proposal: on reconnect, ask the online linked devices for everything since
timestamp *T*; they reply with the chats as a JSON payload.

### 2.1 Already true

The coordination half is built and is already the right shape. From
`syncGapService`'s own header:

> *"NO MESSAGE CONTENT is written to the coordination path. It carries a chatId,
> a number, and device ids."*

A request is `{chatId, sinceTimestamp, requesterDeviceId, createdAt}` — a few
hundred bytes. That is not what costs money and does not need replacing.

### 2.2 Where it breaks

1. **It assumes a peer is online.** If every other device is asleep, nobody
   answers. That is not hypothetical — it is §0.2, happening in production right
   now. Peer sync is a complement to durable storage, never a replacement.
2. **Two phones cannot simply connect.** Both behind carrier NAT means no direct
   socket without a rendezvous (STUN/TURN) or a relay. The coordination server
   cannot be removed, only made to carry less.
3. **Plain JSON is a security downgrade.** Every message today is sealed end to
   end and identity-signed. A peer that hands over "all chats since 8am" as
   plain JSON becomes a device that can silently **omit** or **inject** history —
   the same forgery boundary doc 33 §2.5 was careful about, and harder to detect
   because absence looks like "there was nothing to send".

### 2.3 Verdict

Adopt the batching idea; reject "instead of Firebase" as unreachable; keep the
payload sealed. The win is real but it comes from **moving bulk off the
per-message fan-out**, not from removing the coordinator.

---

## 3. Locked decisions

### 3.1 One encrypted JSON batch, not N envelopes

A gap response becomes a **single** payload: `{chatId, since, until, messages[]}`,
JSON, compressed, then sealed **once** to the requesting device's Signal
identity.

Replaces *M*×*D* encryptions and writes with one per (chat, requester). This is
the user's idea and it is the core of this document.

### 3.2 Sealed to the requester, signed by the responder

Sealed with the existing `sealToIdentity`/`openWithIdentity` HPKE path — already
implemented on both platforms (doc 33 §3) — and signed with the responder's
identity key.

Signing is what makes §2.2's omission attack detectable: the batch states the
range it claims to cover, so a responder cannot quietly return a subset while
appearing complete. **A batch that fails signature verification is discarded
whole**; a partially-trusted batch is not a thing.

### 3.3 Coordination stays where it is

Requests keep using the existing RTDB path. It is small, it is already reaped,
and it works — §0 proves detection fires correctly when it is allowed to run.
Do not rebuild what is not broken.

### 3.4 Transport is decided by a spike, not by this document

The batch needs a channel. Candidates, in order of preference:

1. **WebRTC data channel.** The app already ships WebRTC (LiveKit, for calls),
   so the dependency exists and NAT traversal is solved. **Unverified**: whether
   a data channel can be opened between two devices of the same account without
   a full LiveKit room, and what that costs. This is a spike, not a decision.
2. **Firebase Storage object.** Responder uploads the sealed blob, requester
   downloads and deletes. One write and one read instead of thousands. Boring,
   certain to work, and still a large improvement.
3. **Existing RTDB path, batched.** Same transport as today but one blob rather
   than per-message envelopes. The floor — worth taking even if 1 and 2 fail.

Option 3 captures most of the cost win on its own, which means **this plan does
not depend on the spike succeeding**. Do not build 1 before measuring §1.

### 3.5 Sync state becomes visible

Every silent-failure bug in this project has cost days. A device that knows it
is behind and cannot get the data **must say so** — surfaced in the Nearby-mesh
diagnostics screen (doc 33 §11) alongside a "last successfully synced" per chat.

An unanswerable request must not simply expire into silence at seven days.

### 3.6 Close the coverage hole

A device with **zero** local messages for a chat must be able to request a
**bounded** backfill — most recent *N* messages or *T* days, not all history.

This preserves the SCOPE GUARD's real intent (never request unbounded history
for every chat at once) while removing the consequence (a restored device is
permanently stuck). The bound is what makes it safe; the guard was right that
the unbounded version is not.

---

## 4. Ruled out

- **Storing message history in Firestore.** Breaks the local-first rule in
  CLAUDE.md's Architecture DNA. Not up for discussion.
- **Plain-JSON peer handoff.** §2.2.3.
- **Removing the coordination server.** §2.2.2. NAT is not negotiable.
- **A new pairing/trust mechanism.** Trust already comes from the Signal device
  directory and is platform-independent (verified 2026-07-31). Reuse it.

---

## 5. Sequenced build order

Ordered so each step is independently verifiable, and so the thing the user
actually reported is fixed first.

| # | Step | Verified by |
|---|---|---|
| 1 | Close the coverage hole (§3.6): bounded backfill request when local count is 0 | **BUILT 2026-07-31.** Device-verify: the Pixel raises a request after a reinstall |
| 2 | Surface sync state (§3.5) | **BUILT 2026-07-31.** Device-verify: a stuck sync is visible instead of silent |
| 3 | Measure Firebase usage (§1), record it here | A real number, post-`42b90d2` |
| 4 | Batch the response (§3.1, §3.2) over the existing RTDB path | One write replaces M×D; gap closes end to end |
| 5 | Spike the WebRTC data channel (§3.4.1) | Two devices move a blob with no Firebase payload |
| 6 | Switch transport if the spike passes; keep 4 as fallback | Cost drop measured against step 3 |

Steps 1 and 2 fix the reported bug and need no new transport. Steps 4 onward are
the cost work. **They are independent** — do not let the transport spike block
the fix.

---

## 6. Risks

- **A batch is a bigger blast radius.** One corrupt payload loses a whole range
  rather than one message. Mitigated by §3.2's discard-whole rule plus the
  requester re-asking, which converges because the watermark has not moved.
- **`MAX_REPLAY_PER_REQUEST = 200` needs rethinking for batches.** The bound
  should become bytes, not message count: 200 text messages and 200 messages
  with media metadata are different by orders of magnitude.
- **Multiple responders may answer the same request.** Already true today, and
  already handled by claim/release. Batching makes duplicated effort more
  expensive, so measure before adding coordination.
- **Any peer transport still needs the durable fallback.** §2.2.1. A design that
  quietly assumes a peer is online reintroduces §0.2 in a new place.

---

## 7. Steps 1 and 2 — build log (2026-07-31)

**BUILT. Not device-verified.**

### 7.1 Coverage hole closed

`checkForGapsAndRequestFill` no longer skips a chat with zero local messages. It
requests a **bounded** backfill instead, bounded in two directions because the
original guard was right about the danger:

- `ZERO_HISTORY_BACKFILL_MS` — 30 days back, not all history.
- `MAX_ZERO_HISTORY_REQUESTS_PER_PASS` — 3 chats per pass, newest first, so a
  device restored with fifty conversations does not ask for all fifty at once.
- A chat whose newest message predates the window is still ignored.

**A bug caught while writing it:** the window is derived from `Date.now()`, so a
raw `Date.now() - WINDOW` differs on every call, would never match its own
previous watermark, and would rewrite the request on *every* detection pass —
precisely the RTDB write storm the guard exists to prevent. The window is
therefore quantized to the hour (`BACKFILL_BUCKET_MS`), which also gives a
natural hourly retry for a request nobody has answered.

**A test that silently changed meaning:** the existing "does NOT request history
for a chat this device has never loaded" case used `createdAt: 5_000_000` — an
epoch of Jan 1970 — so after this change it passed for the wrong reason: the
thread was outside the backfill window rather than being skipped by the guard.
It has been split into two honest cases plus four new ones (bounded window, the
per-pass cap, newest-first ordering, and no re-raise on the next pass).

### 7.2 Sync state surfaced

`getOutstandingSyncGaps()` exposes this device's outstanding requests
synchronously, and a **History sync** card in the Nearby-mesh screen renders
them. A request outstanding more than ten minutes is flagged, with plain-language
copy explaining that another device has to be online and hold the messages.

Deliberately reports what the device asked for and when, not a guess at
progress — this exists so a stuck sync stops being indistinguishable from a
healthy one, and inventing a percentage would recreate exactly that problem.

**324 service + 419 unit tests pass.**
