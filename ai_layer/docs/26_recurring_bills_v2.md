# 26 — Recurring Bills v2: chat-native bills, detection, rotation

Product + engineering blueprint from the 2026-07-19 brainstorm. Decisions below were
made explicitly by the user; this doc is the contract for implementation.

**Build status (2026-07-20):** CORE SHIPPED in code (user overrode the
after-doc-25 sequencing) — typechecks clean, 369 unit + 133 services + 28
functions tests green. Landed: model v2 fields (`amountMode`, `rotation`,
`skippedOccurrences`, `pendingOccurrences`, `reminderSentFor`); suffix/auto-note
removed from BOTH generation paths (which also fixed a pre-existing dedupe bug:
the server expense object lacked `splitMetadata`, so client/server arrayUnion
objects differed — now byte-identical); `recurringBill` ExpenseRef kind +
stateful card in ExpenseCardBubble (state derived live from the deterministic
expense id — pointer-canonical, message never edited); variable confirm on-card
(Alert.prompt, payer/admin gated) via `confirmVariableOccurrence`; card posting
via the DIGEST pattern (client-triggered idempotent `fixedMessageId:
recbill-<billId>-<occurrenceAt>` from ChatRoomScreen → `postRecurringBillCards`
in GroupContext), NOT a server bot cron — deliberate deviation, matches doc 22
precedent and needs no new RTDB write path; T-3 payer push rides the EXISTING
`runRecurringBillsScheduler` (rotation-aware, `reminderSentFor` idempotent,
variable-due push included); rotation editor + fixed/variable picker +
skip-next in RecurringBillsScreen; detection (`src/utils/recurringDetection.ts`)
on all three surfaces + `upsertFactByPrefix` commitments fact into the memory
ledger (written from GroupStatsScreen).

**Round 2 (2026-07-20, user override — "build them"):** the two deferred items
are BUILT and functions are DEPLOYED (`runRecurringBillsScheduler` +
`triggerRecurringBillsForGroup` updated on us-central1; full `--only functions`
aborts on a stale remote `parseReceiptWithLLM` — delete it manually someday).
- **Hidden 1:1 ledger** (`src/services/hiddenLedgerService.ts`): deterministic
  group id `ledger_<sortedUidA>__<sortedUidB>` (concurrent ensures converge —
  same idempotency trick as expense ids); `hidden: true` group with both
  members at create (group create rules have no field whitelist — verified, no
  rules change); GroupListScreen now filters `hidden` (search/stats already
  did). Entry: direct-chat header menu → "Recurring requests" → ensures ledger
  → RecurringBillsScreen.
- **`requiresAccept`** on the bill model: hidden-ledger bills are ALWAYS
  accept-gated (set automatically by RecurringBillsScreen); both generation
  paths park accept-gated occurrences in `pendingOccurrences` exactly like
  variable ones — accept = `confirmVariableOccurrence(bill, occ, bill.amount)`,
  so the whole pending machinery is reused. `recurringRequest` ExpenseRef kind;
  card shows "Awaiting accept · requested by X" with an Accept & add button
  gated to the counterparty (non-payer member). Posting: `postRecurringRequest
  Cards` via `writeDirectCardMessage` (direct-chat variant of
  writeGroupSystemMessage — no group→chat lookup), digest-pattern idempotent
  `recreq-<billId>-<occurrenceAt>`, triggered from ChatRoomScreen direct
  threads. Scheduler pushes the COUNTERPARTY ("accept it in the chat") for
  newly-parked request occurrences, payer for variable ones.
- **Per-participant settle state**: `Expense.settledParticipantIds` — payer
  implicitly settled; ExpenseDetails "Split with" rows get tick toggles
  (payer/admin can tick anyone, members tick themselves; all non-payer ticked
  → `settled` flips true). The recurring card renders the avatar tick row from
  live expense data.
Staged extras (Siri index, price-creep, amortization, calendar) remain future.

**What already exists (verified in code, keep it):** the full recurrence mechanism —
Firestore `recurringBills` collection, the `RecurrenceRule` engine
(`src/utils/recurrence.ts`: daily/weekly/monthly/yearly, intervals, weekday-of-month
patterns, timezones), dual-path generation (cloud fn `triggerRecurringBillsForGroup`
+ client fallback in `src/services/recurringBillService.ts`) with **deterministic
idempotent expense IDs `rec_<billId>_<occurrenceAt>`** and a catch-up cap of 48.
The AI already exposes a read-only `recurring()` tool (`src/utils/aiTools.ts`) and
stats insights count recurring commitment. Management UI: `RecurringBillsScreen`.
None of this is rewritten — v2 wraps it.

## Decisions (locked)

| Question | Decision |
|---|---|
| Chat presence | **Stateful bill card** in the group chat — one card per occurrence, renders live state: upcoming → due → generated → settlement progress with member avatars |
| Generation | **Per-bill fixed vs variable.** Fixed auto-generates silently (today's path). Variable posts a confirm-and-enter-amount card; expense generates only on confirm |
| Confirm permissions | Variable-card actionable by the **payer OR any group admin** (matches doc 21 admin model) |
| Reminders | **T-3 days** chat card + push to payer, for monthly-and-slower bills only; daily/weekly get due-day only |
| Rotation | **Ships this round** — rotation order on the bill model; card announces whose turn |
| Detection | **All three surfaces**: AddExpense inline chip, stats insight card, bot chat suggestion. Deterministic clustering, no FM call. Writes a commitments fact to the AI memory ledger (doc 25) |
| 1:1 | **Yes**, on the doc 21 hidden 2-person ledger — bot card in the 1:1 chat, **one-tap accept per occurrence** books the entry. No silent accrual |
| Sequencing | After doc 25 Q1→Q3 |

## Data model

### `RecurringBill` extensions (`src/models/recurringBill.ts`)

```ts
amountMode?: 'fixed' | 'variable';        // default 'fixed' (back-compat)
rotation?: {
  order: string[];                        // userIds, takes precedence over paidBy
  index: number;                          // next payer = order[index % order.length]
};
skippedOccurrences?: number[];            // occurrenceAt timestamps explicitly skipped
// reminder lead is DERIVED, not stored: monthly/yearly → 3 days, daily/weekly → 0
```

- Rotation: `paidBy` for an occurrence = `rotation.order[index]`; the index advances
  when an occurrence **generates** (skipped occurrences do NOT advance the turn).
  Rotation composes with variable — whoever's turn it is gets the confirm card/push.
- Variable bills: `processDueBills` must NOT auto-generate them. A due variable
  occurrence is represented only by the chat card + a `pendingOccurrences: number[]`
  style marker on the bill; confirm writes the expense at the stored `occurrenceAt`
  with the entered amount — the deterministic ID scheme is untouched (only the
  amount arrives late).
- Amount-change-going-forward: edit `amount` on the bill only — generated history
  never mutates. Skip-this-occurrence: append to `skippedOccurrences`, advance
  `nextDueAt`, rotation index frozen.

### Chat card: extend `expenseRef` (doc 21 payload)

New kinds on the existing `expenseRef` union: `'recurringBill'` (group card) and
`'recurringRequest'` (1:1 accept card).

```ts
expenseRef?: {
  kind: 'recurringBill' | 'recurringRequest' | ...existing;
  groupId: string;                        // hidden ledger group for 1:1
  billId: string;
  occurrenceAt: number;                   // → expenseId is derivable: rec_<billId>_<occurrenceAt>
  snapshot: { title: string; amount: number | null;  // null = variable, not yet entered
              currency: string; payerName: string; payerId: string;
              recurrenceSummary: string };
};
```

**The card is stateful WITHOUT message edits.** Messages are immutable through the
RTDB→local pipeline; the pointer is canonical (doc 21 rule). The renderer derives
state live: bill exists + `occurrenceAt > now` → *upcoming*; due, no expense doc →
*due* (variable: show confirm affordance); expense doc exists → *generated*, and
settlement progress (avatars ticking) comes from live expense/settlement data.
Snapshot is offline fallback only; deleted bill → tombstone. One card per
occurrence — posted at T-3 for monthly+ (it renders as "upcoming" until due day),
posted on due day for daily/weekly. Remember the three RTDB layers when extending
the payload: `database.rules.json` whitelist, `messageQueueService` serializer AND
parser, plus the ChatMessage constructor in `processMessageSnapshot` (doc 21 burn).

## Surfaces

- **Bill card (group chat)**: posted by the **ManaSplit bot persona** (doc 21 E —
  reserved senderId) through the normal message queue. Cron cloud function scans
  `recurringBills` for T-3/due transitions (server-side; clients can't be trusted
  to be online). Push to the occurrence's payer (rotation-aware) at T-3 for
  monthly+. Tap → ExpenseDetails (generated) or RecurringBills screen (not yet).
  Card overflow: skip this occurrence · edit amount going forward · pause bill —
  admin/payer gated.
- **Variable confirm flow**: card shows "enter amount" for payer + group admins
  (client UX check + Firestore rules enforce). Confirm → expense written by the
  existing generation path with the entered amount → card re-renders as generated.
- **Rotation display**: card headline names the turn ("Priya's turn this month");
  RecurringBillsScreen gains a rotation editor (ordered member list).
- **Detection** (`src/utils/recurringDetection.ts`, pure + unit-tested):
  deterministic clustering over group expense history — normalized title match,
  amount within tolerance (tight for fixed-looking, loose for variable-looking),
  inter-occurrence gap matching a weekly/monthly cadence, ≥3 occurrences. No FM
  call. Surfaced on: (a) AddExpense inline chip ("Repeats monthly?") when the
  in-progress expense matches a cluster → prefilled bill form; (b) deterministic
  stats insight card (doc 22 engine); (c) ManaSplit bot suggestion in chat —
  rate-limited to once per cluster ever (store suggested cluster keys on the
  group's `moneyInChat` or a sibling field). Each detected/created bill also
  writes "monthly commitments ≈ X" into the AI memory ledger (doc 25) so the
  assistant reasons with it.
- **1:1 recurring** (`recurringRequest`): bill lives on the hidden 2-person ledger
  group (doc 21). Every occurrence posts an accept card in the direct chat; the
  counterparty's one-tap accept books the ledger expense (deterministic ID as
  usual). No accept → nothing accrues; the card nudges once, then waits. Either
  side can pause the bill from the card overflow.

## Invariants (non-negotiable)

- **Privacy guard + display-currency lens** on every money render in cards, pushes
  excluded (pushes show title only, never amounts).
- **Tier discipline**: cards are pointers + snapshots via RTDB transit → local;
  bills and expenses stay Firestore. Never copy authoritative amounts into
  chat-only storage.
- **Deterministic ID scheme is sacred**: `rec_<billId>_<occurrenceAt>` on every
  path (auto, variable-confirm, 1:1 accept) — it is the dedupe key across cloud
  fn, client fallback, and card tap-through.
- **No FM calls anywhere in this feature** — detection is deterministic; nothing
  routes through `serializeFm`.
- Kill the hardcoded `" (Recurring)"` title suffix + English-only auto-note in
  `generateExpenseFromBill` BEFORE titles reach cards — recurrence is metadata
  (`expense.recurring`), the card renders its own badge.
- Bot posts respect `moneyInChat.autoPost === 'off'` and nudge settings — a group
  that opted out of money chatter gets silent generation only.

## Staged extras (not this round)

1. Bills into the Siri SQLite index (`SplitCircleIndexReader`) — "when's rent due?"
2. Price-creep stats card ("Netflix ₹499 → ₹649 over 12 months").
3. Annual-bill amortization in stats ("insurance is really ₹1,200/mo").
4. Calendar export / due-date widget line.

## Suggested build order (after doc 25 Q1→Q3)

1. Model extensions + `" (Recurring)"` cleanup + `expenseRef` kinds + card renderer
   (renders live state; no bot yet — verify via manually posted cards).
2. Cron cloud function: T-3/due card posting + rotation-aware push (bot infra from
   doc 21 E — build order intentionally adjacent so the bot persona ships once).
3. Variable confirm flow + rules enforcement (payer/admin).
4. Rotation model + card headline + RecurringBillsScreen editor.
5. Detection util + AddExpense chip + stats insight; bot suggestion + memory-ledger
   write last (depends on doc 25 memory shipping).
6. 1:1 `recurringRequest` on the hidden ledger (depends on doc 21 phase "1:1
   hidden ledger" being built).
7. Card overflow actions (skip / edit-forward / pause) + polish.
