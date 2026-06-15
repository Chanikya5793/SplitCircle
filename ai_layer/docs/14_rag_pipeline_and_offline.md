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
- **P1.4 (next):** richer citations UI (inline `[n]` markers → Expense Details);
  optional FM compose for conversational phrasing (verify number fidelity on device).

## Track 2 — Offline-first (planned)
- **P2.1** Persistent group cache (`expo-sqlite`, already a dep): hydrate
  `GroupContext` on launch, update on each snapshot → app shows data offline.
- **P2.2** Offline write queue: refactor `addExpense`/`settleUp` off
  `runTransaction` to idempotent `updateDoc` (+ replay queue). The other mutators
  already queue offline.
- **P2.3** Offline UX: connectivity banner, "queued" badges on pending writes.
- **P2.4** Persist the analytics index to disk so RAG retrieval is instant + offline.

## Notes / risks
- FM passes (understand, future compose) need a device build to verify; the pure
  retriever + plan mapping are unit-tested in-sandbox.
- P2.2 touches the money-write path — idempotent + well-tested.
- The on-device AI already runs offline; Track 2 mainly makes the *data* available
  offline so the AI has something to work on.
