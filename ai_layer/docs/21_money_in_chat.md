# 21 — Money in Chat: expenses ⇄ group chats integration blueprint

Product + engineering blueprint from the 2026-07-17 brainstorm. Decisions below were
made explicitly by the user; this doc is the contract for implementation.

**Build status (2026-07-17):** Phases 1–3 SHIPPED and sim-verified — `expense` message
type + ExpenseCardBubble + auto-post from addExpense/settleUp; `moneyInChat` admin sheet
(GroupInfoScreen) with autoPost gate; chat-header balance pill. Three infra fixes were
required and are DEPLOYED to Firebase: (1) the chats lookup in
`writeGroupSystemMessage` must query `participantIds array-contains uid` (a groupId-only
query fails rules — "rules are not filters"); (2) RTDB `database.rules.json` type
whitelist now includes `'expense'` + an `expenseRef` validate; (3) `firestore.rules`
group-update whitelist now includes `moneyInChat`. The RTDB wire format
(`messageQueueService`) serializes/parses `expenseRef` explicitly — remember all three
layers (rules, queue serializer, queue parser AND the ChatMessage constructor in
`processMessageSnapshot`) when extending the payload. Degraded expense messages (pointer
lost, e.g. minimal lastMessage copies) render as quiet system chips, never as personal
bubbles. Remaining phases: create-from-chat (B), 1:1 hidden ledger, outward share,
nudge bot (needs a cloud function), extras.

## Decisions (locked)

| Question | Decision |
|---|---|
| Directions | ALL: A expense cards in chat · B create-from-chat · C balance in header · D share outward · E admin controls |
| Auto-post | Rich card per expense/settlement event (muted styling), not compact lines |
| Card interactivity | Tap-through to details + emoji reactions; NO inline actions (details screen stays the one source of truth) |
| 1:1 chats | In scope — request-money cards backed by a **hidden 2-person ledger group** |
| Admin panel | Full per-group "Money in chat" panel, admin-gated, synced on the group doc |
| Nudges | **ManaSplit bot persona** posts stale-debt reminders in chat, tap → settle flow |
| Extras (staged after core) | Money filter chip · pinned live balance bar · monthly digest card |

## What already exists (leverage, verified in code)

- `ChatThread.groupId` links every expense group to its chat; `GroupContext.
  writeGroupSystemMessage` already pushes system messages into the linked thread
  (member changes, renames, currency conversion) via the normal RTDB queue.
- `MessageBubble` already renders rich cards (location map, link preview, file, call
  chip) — precedent for an expense card renderer.
- Reactions, replies, pins, mentions, chat search/filters all exist.
- On-device AI creates complete expenses headlessly (all 11 split modes) — reuse for
  "Split this" from a chat message. Receipt OCR + insights exist for photo → expense.
- `useMoneyDisplay` / display-currency lens / privacy guard are the money render
  funnels — chat cards MUST go through them (see invariants).

## Data model

### New message type: `expense`

Extend `MessageType` union (`src/models/chat.ts`) with `'expense'`. Payload on
`ChatMessage`:

```ts
expenseRef?: {
  kind: 'expense' | 'settlement' | 'request' | 'digest';
  groupId: string;
  expenseId?: string;      // or settlementId / requestId
  // Render snapshot — the card must render offline before Firestore sync,
  // but the POINTER is canonical: tap-through always loads live data, and the
  // card re-renders from live data when available (snapshot is fallback only).
  snapshot: { title: string; amount: number; currency: string; payerName: string;
              payerId: string; participantCount: number; category?: string };
};
```

Local-first rules (Architecture DNA — do not break): the card is a normal chat
message (RTDB transit → local storage). Canonical money data stays in Firestore
expenses. NEVER copy authoritative amounts into chat-only storage — a card whose
expense was deleted renders a tombstone ("expense removed").

### Group doc: `moneyInChat` settings (admin panel, direction E)

```ts
moneyInChat?: {
  autoPost: 'cards' | 'compact' | 'off';   // default 'cards'
  nudges: { enabled: boolean; staleDays: number };  // default on, 7 days
  createFromChat: 'everyone' | 'admins';   // default 'everyone'
  inviteLinks: boolean;                    // default true
  outwardSharing: boolean;                 // default true
};
```

Admin-gated like other group edits (client UX check + Firestore rules enforce).
Settings UI: new "Money in chat" section in GroupInfoScreen.

### Hidden 2-person ledger (1:1 requests)

First money request in a direct chat auto-creates a real expense group with
`hidden: true` flag: excluded from GroupListScreen, but fully alive for expenses/
settlements/balances. `friendBalances` aggregation picks it up with zero changes.
Request card = `expenseRef.kind: 'request'` pointing at an unsettled debt in that
ledger; "paid" = a normal settlement.

## Surfaces

- **A. Cards**: auto-posted by the same code paths that write expenses/settlements
  (GroupContext), respecting `moneyInChat.autoPost`. Muted card chrome (system-adjacent,
  not a member bubble); reactions ride the existing reaction system; reply-to-card works
  like reply-to-message. Tap → ExpenseDetailsScreen (deep-link params already exist).
- **B. Create from chat**: attachment menu gains "Split expense" (opens AddExpense
  scoped to `thread.groupId`); long-press text message → "Split this" (AI parser draft
  with confirm card); receipt photo message → "Split this receipt?" affordance.
  Gated by `moneyInChat.createFromChat`.
- **C. Header balance pill**: in group chat header, "you owe / you're owed" via
  existing balance math + `useMoneyDisplay` (lens + guard apply). Tap → settle flow.
- **D. Share outward**: expense/settlement → rendered receipt image (ViewShot) →
  native share sheet. Group invite link from chat header. Digest card doubles as the
  shareable artifact. Gated by `moneyInChat.outwardSharing`.
- **E. Nudge bot**: "ManaSplit" persona (reserved senderId, own avatar) posts when a
  debt exceeds `staleDays`. Trigger: cloud function cron scanning group balances
  (server-side — clients can't be trusted to be online); posts through the normal
  message queue so delivery/offline semantics hold. Never posts when nudges disabled.

## Staged extras (v1.5)

1. **Money filter chip** in chat search/filter UI → only `type === 'expense'` rows.
2. **Pinned live balance bar** — special pin, renders from live balances (not snapshot).
3. **Monthly digest card** — cloud function cron posts `expenseRef.kind: 'digest'`
   (totals, top category, biggest payer); shareable via D.

## Invariants (non-negotiable)

- **Privacy guard**: card amounts render through the guard (`••••`/decoy) — the chat
  must never leak what the expenses tab hides. Same for header pill and pinned bar.
- **Display-currency lens** applies to all chat money renders (≈ marker).
- **Tier discipline**: RTDB transit only; messages local; expenses Firestore. Cards
  are pointers + render snapshots, never authoritative copies.
- Cards are muted/system-adjacent so the chat stays a conversation, not a feed of
  receipts (explicit user concern behind "rich card per event" + admin off-switch).

## Suggested build order

1. `expense` message type + card renderer + auto-post from GroupContext (A core).
2. Admin panel + gates (E) — ship WITH A so groups can opt down from day one.
3. Header pill (C) — smallest, high visibility.
4. Create-from-chat (B): attachment menu first, then long-press AI draft, then receipt.
5. 1:1 hidden ledger + request cards.
6. Outward share images (D), nudge bot (needs functions deploy), then extras.
