# Phase 1 — SplitCircle Codebase Analysis

> Grounded reconnaissance of the SplitCircle repository as it exists today. Every
> entity, function, and observation below was read directly from source, not assumed.
> This document is the factual foundation for every later phase of the AI layer.

---

## 1. Tech Stack Summary

| Layer | Technology | Evidence |
|---|---|---|
| **Project type** | Cross‑platform **mobile app** (iOS-first, Android, RN‑web) | `app.config.ts`, `ios/`, RN deps |
| **Frontend framework** | **React Native 0.83 + Expo SDK 55**, React 19.2 | `package.json` |
| **Language** | **TypeScript 5.9** (strict app + functions) | `tsconfig.json`, `functions/tsconfig.json` |
| **Navigation** | React Navigation v7 (native-stack, bottom-tabs, drawer, top-tabs) | `src/navigation/AppNavigator.tsx` (1348 LOC) |
| **State** | React Context (`Auth`, `Group`, `Chat`, `Call`, `Notification`, `Theme`, `Loading`) | `src/context/` |
| **Backend** | **Firebase Cloud Functions v2** (Node 22, Gen-2) | `functions/src/` |
| **Primary DB** | **Cloud Firestore** | `firestore.rules`, `src/firebase/` |
| **Realtime DB** | **Firebase Realtime Database** (call signaling only) | `database.rules.json`, `onValueCreated` |
| **Auth** | **Firebase Auth** (Google OAuth + email) | `OAUTH_CONFIG.md`, `AuthContext.tsx` |
| **Storage** | Firebase Storage (`storageService.ts`) + on-device SQLite/AsyncStorage cache | `expo-sqlite`, `localMessageStorage.ts` |
| **Realtime calls** | **LiveKit** (WebRTC) + CallKit/VoIP push | `livekit-client`, `functions/src/voipPush.ts` |
| **Push** | Expo Push (data) + APNs VoIP (`@parse/node-apn`) | `functions/src/notifications.ts` |
| **Existing AI/ML** | **Gemini 2.5 Flash** (server receipt parsing); on-device OCR (VisionKit); `@google/genai` client dep; `openai` dep in functions | `functions/src/parseReceiptWithLLM.ts`, `src/services/ocrService.ts` |
| **Charts** | `react-native-chart-kit` (spending visuals already in app) | `package.json` |

**Confidence: High.** Stack is unambiguous from config + dependency files.

---

## 2. Complete Entity Map

SplitCircle has a **document-embedded** data model: the `Group` document is the
aggregate root and embeds `expenses[]` and `settlements[]` as arrays. There are
**also** top-level `/expenses` and `/groups/{id}/expenses` collections defined in
`firestore.rules` (transitional / dual-write surface). **This matters enormously
for the AI layer** — see §5 Gaps.

### Entity: UserProfile  (`src/models/user.ts`, collection `users/{userId}`)
| Field | Type | Notes |
|---|---|---|
| userId | string | = Firebase Auth UID |
| email | string | **PII** |
| displayName | string | **PII** |
| photoURL | string \| null | must be `null` not `undefined` for Firestore |
| phoneNumber? | string | **PII** |
| groups | `LinkedGroup[]` | `{ groupId, name, lastActive }` denormalized list |
| status | `'online'\|'offline'\|'busy'\|'away'` | presence |
| pushToken? | string | legacy; devices now in subcollection |
| preferences | `NotificationPreference` | granular push/email toggles, mute lists |
| createdAt / updatedAt | number | epoch ms |

- **Subcollection** `users/{userId}/notificationDevices/{deviceId}` → `NotificationDeviceRecord` (platform, expoPushToken, permission/registration status, receipt diagnostics). Client read-only; written by Functions.
- **Relationships:** owns many Groups (via membership); denormalized `groups[]` mirror.

### Entity: Group  (`src/models/group.ts`, collection `groups/{groupId}`)
| Field | Type | Notes |
|---|---|---|
| groupId | string | doc id |
| inviteCode | string | join token (immutable per rules) |
| name, description?, currency | string | single currency per group |
| members | `GroupMember[]` | embedded, see below |
| archivedMembers? | `GroupMember[]` | left/removed members kept for name resolution |
| memberIds? | string[] | flat index used by security rules + queries |
| **expenses** | `Expense[]` | **embedded array — the primary expense store** |
| **settlements** | `Settlement[]` | **embedded array** |
| createdBy, createdAt, updatedAt | string/number | |

- **GroupMember:** `{ userId, displayName, photoURL?, role: 'owner'|'admin'|'member', balance: number, archived?, archivedAt?, archivedReason? }` — note the **per-member cached `balance`**.
- **Relationships:** 1 Group → N members, N expenses, N settlements; 1 Group ↔ 1 group `chat`.

### Entity: Expense  (`src/models/expense.ts`)
| Field | Type | Notes |
|---|---|---|
| expenseId, groupId | string | |
| requestId? | string | client idempotency key |
| **title** | string | ⚠️ model uses `title`; Functions read `expense.description` (drift — §5) |
| category | string | **free-form string, no enum** → ML opportunity |
| amount | number | |
| paidBy | string | userId |
| splitType | `'equal'\|'percentage'\|'shares'\|'custom'` | legacy field |
| participants | `ParticipantShare[]` | `{ userId, share }` — final per-user amounts |
| splitMetadata? | `ExpenseSplitMetadata` | **rich v1 split spec, 11 methods** |
| settled | boolean | |
| notes? | string | **PII-bearing free text** |
| receipt? | `ReceiptMetadata` | `{ url?, fileName?, size?, scannedWith }` |
| recurring? | `{ billId, occurrenceAt }` | links to RecurringBill |
| createdAt / updatedAt | number | |

- **ExpenseSplitMethod** (11): `equal, exact, percentage, shares, adjustment, itemized, income, consumption, timeBased, gamified, itemType`. Gamified sub-modes: `roulette, weightedRoulette, scrooge` (karma). This is **far richer than Splitwise** — a genuine differentiator.
- **ExpenseReceiptItem:** `{ id, name, price, quantity?, assignedTo[], splitMode?, splitData? }` — line-item structure already exists.

### Entity: Settlement  (`src/models/group.ts`, embedded in Group)
`{ settlementId, requestId?, fromUserId, toUserId, amount, createdAt, note?, status: 'pending'|'completed' }`

### Entity: RecurringBill  (`src/models/recurringBill.ts`, collection `recurringBills/{billId}`)
`{ billId, groupId, title, amount, category, paidBy, participants[], recurrenceRule, startAt, endAt?, isActive, lastGeneratedAt?, nextDueAt, createdAt, updatedAt }`.
- **RecurrenceRule:** `{ frequency: daily|weekly|monthly|yearly, interval, monthlyPattern?, weekdays?, daysOfMonth?, weeksOfMonth?, monthsOfYear?, timezoneOffsetMinutes? }` + legacy fields. Generates expenses via scheduler.

### Entity: ChatThread / ChatMessage  (`src/models/chat.ts`, `chats/{chatId}` + `messages` subcollection)
- **ChatThread:** `{ chatId, type: 'direct'|'group', participants[], participantIds[], lastMessage?, unreadCount, groupId?, pinnedMessages?, typing? }`.
- **ChatMessage:** `{ messageId, chatId, senderId, type: text|image|video|audio|file|location|system|call, content, mediaUrl?, mediaMetadata?, location?, status, reactions?, starredBy?, mentions?, replyTo?, ... }`. Largely **local-first** (SQLite); cloud sync via `lastMessage`.

### Entity: Call  (`src/models/call.ts`; RTDB `/calls/{callId}` + Firestore `calls/{callId}`)
Signaling record: `{ chatId, status: ringing|connected|..., type: audio|video, initiatorId, groupId?, allowedUserIds, participants }`.

### Derived (not stored) — Balance
There is **no `Balance` entity**. Balances are computed on demand by
`calculateBalancesFromExpenses()` (`src/utils/debtMinimizer.ts`) and cached per
member as `GroupMember.balance`. Pairwise friend balances are approximated by
`computeFriendBalances()` (`src/utils/friendBalances.ts`), multi-currency aware.

**Entity-map confidence: High.**

---

## 3. Business Logic Inventory

| Concern | Location | Behaviour |
|---|---|---|
| **Split computation** | `src/components/BillSplit/splitMath.ts` (641 LOC) + `src/utils/expenseSplit.ts` | Pure functions per method (`computeEqual/Exact/Percentage/Shares/Adjustment/Itemized/Income/Consumption/TimeBased/Karma/ItemType`); `roundCents` for money. `computeSharesFromExpenseSplit()` is the canonical entry. |
| **Balance calc** | `src/utils/debtMinimizer.ts` → `calculateBalancesFromExpenses(expenses, settlements)` | Payer credited (total − own share); participants debited share; settlements applied. Returns `Record<userId, net>`. |
| **Debt simplification** | `src/utils/debtMinimizer.ts` → `minimizeDebts(balances)` | **Greedy** largest-debtor↔largest-creditor matching, ε=0.01. Already minimizes transaction count. |
| **Friend balances** | `src/utils/friendBalances.ts` → `computeFriendBalances(me, groups)` | Per-other-user, per-currency net; proportional slice approximation (exact pairwise deferred to group settle view). |
| **Recurring bills** | `functions/src/recurringBills.ts`, `recurrence.ts`; `src/services/recurringBillService.ts` | Scheduler every 6h materializes due bills → expenses; idempotent via `nextDueAt`/`lastGeneratedAt`. |
| **Receipt scan → split** | `src/services/ocrService.ts`, `visionKitService.ts`, `receiptScanNormalization.ts`, `ReceiptScannerSheet.tsx` | On-device OCR → optional Gemini parse → line items → itemized split. |
| **Receipt learning** | `src/services/receiptLearningService.ts` | **Rule-based, on-device** (AsyncStorage): records user name-corrections & item drops per merchant; ≥2 hits to apply. **No server ML.** |
| **Friend graph** | `functions/src/friends.ts` | `materializeGroupFriendships`, `materializeDebtFriendships`, `touchFriendInteraction` — idempotent edge fan-out on group/expense/settlement events. |
| **Notifications** | `functions/src/notifications.ts` + `onGroupUpdated`/`onChatUpdated` | Diff-based: detects new expenses/settlements/members by array-length + id-set diff; fans out Expo push. |

**Confidence: High** on split/balance/debt; **Medium** on chat/media internals (large, not fully read).

---

## 4. API / Cloud Function Inventory  (`functions/src/index.ts`)

| Function | Trigger | Type | Auth | Purpose |
|---|---|---|---|---|
| `syncNotificationDevice` | callable | onCall | Firebase Auth (uid) | Register/refresh device push record |
| `unregisterNotificationDevice` | callable | onCall | Auth | Remove device |
| `sendTestPushNotification` | callable | onCall | Auth | Diagnostics |
| `onChatUpdated` | `chats/{chatId}` update | Firestore trigger | n/a | New-message push fan-out |
| `onGroupUpdated` | `groups/{groupId}` update | Firestore trigger | n/a | **Expense/settlement/member diff → push + friend fan-out** |
| `onCallCreated` | RTDB `/calls/{callId}` create | RTDB trigger | n/a | Incoming-call push + VoIP |
| `registerVoipPushToken` | callable | onCall | Auth | APNs VoIP token upsert (hex-validated) |
| `runRecurringBillsScheduler` | every 6h | scheduler | n/a | Materialize due recurring bills |
| `processNotificationReceipts` | every 1h | scheduler | n/a | Reconcile Expo push receipts |
| `triggerRecurringBillsForGroup` | callable | onCall | Auth + membership | Manual recurring sync |
| `generateLiveKitToken` | HTTP POST | onRequest | Bearer ID token + chat membership | Issue LiveKit JWT |
| `parseReceiptWithLLM` | HTTP POST | onRequest | Bearer ID token | **Gemini 2.5 Flash** receipt OCR→JSON (secret-managed key) |
| `cleanupOldRtdbData` | (exported) | — | — | RTDB GC |

**Secrets in use:** `LIVEKIT_URL/API_KEY/API_SECRET`, `GEMINI_API_KEY`, VoIP push secrets — all via `defineSecret` (Secret Manager). **No credentials hardcoded** in the functions read.

**Confidence: High** (entry point read in full).

---

## 5. Architecture Diagram

```mermaid
flowchart TB
  subgraph Client["📱 React Native + Expo (TS)"]
    UI[Screens / Navigation]
    CTX[Context: Auth/Group/Chat/Call]
    SVC[Services: ocr, media, receiptLearning, recurringBill]
    LOCAL[(SQLite + AsyncStorage<br/>local-first cache)]
    UI --> CTX --> SVC --> LOCAL
  end

  subgraph Firebase["☁️ Firebase / GCP"]
    AUTH[Firebase Auth]
    FS[(Firestore<br/>users, groups{expenses,settlements},<br/>expenses, recurringBills, chats, calls)]
    RTDB[(Realtime DB<br/>call signaling)]
    STG[(Storage<br/>media + receipts)]
    subgraph FN["Cloud Functions v2"]
      TRIG[onGroupUpdated / onChatUpdated / onCallCreated]
      SCHED[recurringBills / receipts schedulers]
      HTTP[generateLiveKitToken / parseReceiptWithLLM]
    end
  end

  GEM[Gemini 2.5 Flash API]
  LK[LiveKit Cloud]
  EXPO[Expo Push] 
  APNS[APNs VoIP]

  CTX -->|SDK| AUTH
  SVC -->|SDK| FS
  SVC -->|signaling| RTDB
  SVC -->|upload| STG
  FS --> TRIG
  RTDB --> TRIG
  TRIG --> EXPO
  TRIG --> APNS
  HTTP --> GEM
  HTTP --> LK
  SCHED --> FS
```

---

## 6. Gaps & Observations (critical for the AI layer)

1. **Dual expense storage.** Expenses live embedded in `groups.expenses[]` *and* there are
   `/expenses` + `/groups/{id}/expenses` collections in the rules. The **source of truth
   today is the embedded array** (that's what `onGroupUpdated` and balance math read).
   → The Firestore→BQ sync and embedding pipeline must trigger on **`groups/{groupId}`
   updates and unnest the array**, *not* (only) on a flat `/expenses/{id}` trigger as the
   master prompt's template assumes. This is the single most important design correction.
2. **Field drift: `title` vs `description`.** The `Expense` model field is `title`, but
   `functions/index.ts` reads `expense.description`. The AI layer must read `title` and
   tolerate `description` as a fallback.
3. **Categories are free-form strings, no taxonomy.** No enum, no constants file. High-value,
   low-risk target for an **expense category classifier** (MODEL-01).
4. **No timestamp standard for "transaction date".** Only `createdAt`/`updatedAt` (epoch ms);
   no user-set expense date field. Forecasting/seasonality must use `createdAt`.
5. **Balances are recomputed, never persisted** (except the cached `GroupMember.balance`).
   Good for correctness, but means analytics need their own materialization in BigQuery.
6. **Existing AI is narrow + on-device.** Only server AI is `parseReceiptWithLLM` (Gemini).
   Receipt "learning" is rule-based AsyncStorage, per-device, not shared or model-backed.
7. **PII surface for embeddings:** `email`, `displayName`, `phoneNumber`, expense `notes`,
   `title`, receipt item names. Must be handled per the Critical Rules (no logging, per-user
   namespacing, consider redaction before BQ export).
8. **Scaling watch-outs:** the embedded-array model means a hot group document grows
   unbounded; large `groups.expenses[]` arrays will eventually hit the 1 MiB doc limit and
   make `onGroupUpdated` diffs expensive — an independent reason to mirror to BigQuery.
9. **Strong existing primitives to reuse, not rebuild:** `minimizeDebts`, `splitMath.*`,
   `calculateBalancesFromExpenses`, the line-item `ExpenseReceiptItem` structure, and the
   Gemini receipt prompt. The AI layer should call/port these rather than reinvent them.

---

## 7. Module Confidence Levels

| Module | Confidence | Why |
|---|---|---|
| Data models (`src/models/*`) | **High** | Read in full |
| Split & balance logic | **High** | Read in full |
| Cloud Functions / API surface | **High** | `index.ts` read in full |
| Firestore security model | **High** | `firestore.rules` read in full |
| Receipt / OCR pipeline | **Medium-High** | Core read; some UI sheets skimmed |
| Chat / media / calls internals | **Medium** | Very large; models read, deep impl skimmed |
| Realtime DB usage | **Medium** | Inferred from triggers + rules |

> **Gate check (per master prompt):** I have genuine, source-grounded confidence in the
> data model and architecture — in particular the embedded-array storage reality that
> reshapes the pipeline design. Proceeding to Phase 2.
