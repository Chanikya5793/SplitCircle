# On-device RAG pipeline + offline — roadmap

> Goal: make the assistant genuinely smart (understands any phrasing, answers
> with EXACT cited results) and make the app usable offline. All on-device.

## Why
The deterministic engine is exact but was rigid pattern-matching; off-pattern
questions fell to the LLM over raw lines (the "dumb" path). And the app has **no
real offline persistence** — it uses the Firebase JS SDK, which on React Native
is memory-cache only (`persistentLocalCache` needs IndexedDB; unavailable in RN —
firebase-js-sdk#7947, expo#13670), and `addExpense`/`settleUp` use
`runTransaction`, which fails entirely offline.

## Architecture — "plan → retrieve → compose"
The robust RAG pattern for structured data (and a better fit than Swift
tool-calling, since our data/index live in JS):
1. **Understand (FM):** `planExpenseQuery` (`@Generable OnDeviceQueryPlan`) turns
   free-form text into `{ intent, scope, category, member, metric, timeframe }`.
2. **Retrieve (deterministic, exact):** `planToQuestion(plan)` → canonical
   question → `answerExpenseQuery` over the cached index → exact numbers + the
   specific expenses (citations). The model never does arithmetic.
3. **Compose (optional, FM):** natural phrasing over the exact facts — deferred;
   the deterministic answer is already a clean, cited sentence. (Compose needs
   device verification for number fidelity.)
4. **Cite:** sources come from the deterministic retrieval → tappable cards.

## Track 1 — Smarter RAG chatbot
- **P1.1 ✅** native `planExpenseQuery` + `@Generable OnDeviceQueryPlan` (understand).
- **P1.2 ✅** pure `utils/expensePlan.planToQuestion` (plan → canonical question),
  unit-tested incl. end-to-end "every plan is handled by the engine".
- **P1.3 ✅** `onDeviceAiService.answerExpenseSmart` (understand → retrieve →
  exact cited answer); wired in `assistantService` between the deterministic
  fast path and the grounded LLM fallback.
- **P1.4 (in progress):** tappable citation cards — each `[n]` source row opens
  that expense's Details screen (the "cite" step made actionable). Still to do:
  optional FM compose for conversational phrasing (verify number fidelity on device).

## Track 2 — Offline-first
- **P2.0 ✅ (critical — the "doesn't work offline at all" fix):** `AuthContext`
  only set the signed-in user from the `users/{uid}` Firestore snapshot, which
  never fires offline (memory-only cache on RN) — so on a cold offline launch the
  user stayed `null` and `loading` stayed `true` forever, hanging the splash. Now
  we build the profile from the persisted auth session immediately (clearing
  `loading`) and only ENRICH it via snapshot when online; `services/profileCache`
  (AsyncStorage) preserves the profile across cold offline starts. Cleared on sign-out.
- **P2.1 ✅ (shipped, code):** persistent group cache (`services/groupCache.ts`,
  AsyncStorage). `GroupContext` hydrates from it on launch (instant + offline)
  and refreshes it on every snapshot; live Firestore data wins when online. The
  on-device AI now has data to work on offline.
- **P2.2 ✅ (durable outbox — verify on device):** offline writes are now durable.
  `addExpense`/`settleUp` moved off `runTransaction` (server read → fails offline)
  AND off `await`-ing the Firestore write (its promise only resolves on server ack,
  so offline it hung the UI). Each create is mirrored to a persistent **outbox**
  (`services/outbox`, AsyncStorage) BEFORE the network write, shown optimistically
  (`utils/outboxApply.mergeOutboxIntoGroups` + balance recompute via `adaptGroup`),
  and replayed on launch / reconnect by a single-writer, NetInfo-gated
  `flushOutbox`. Replays are idempotent (`arrayUnion` + stable `requestId` +
  `utils/writeIdempotency` dedup), so they survive an app-kill while offline and
  sync once exactly on reconnect. Pure merge logic is unit-tested. The snapshot
  listener merges still-pending ops so optimistic writes don't flicker out. Admin
  ops (`removeMember`/`leaveGroup`/role changes) keep `runTransaction` —
  online-only by nature. ⚠️ Money path: confirm the once-exactly sync on device.
- **P2.3 (partial):** connectivity banner — slim, safe-area-aware `OfflineBanner`
  mounted at the app shell (`App.tsx`), shown on every screen when the device is
  offline ("showing saved data; edits will sync"). Styled translucent to respect
  the liquid-glass DNA. Still to do: "queued" badges on individual pending writes
  (depends on P2.2's write queue).
- **P2.4** Persist the analytics index to disk so RAG retrieval is instant + offline.

## Notes / risks
- FM passes (understand, future compose) need a device build to verify; the pure
  retriever + plan mapping are unit-tested in-sandbox.
- P2.2 touches the money-write path — idempotent + well-tested.
- The on-device AI already runs offline; Track 2 mainly makes the *data* available
  offline so the AI has something to work on.
