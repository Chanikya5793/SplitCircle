# 29 — Group departure balance integrity

Research + implementation plan for two related problems in how the app handles a
member leaving/being removed from a group: (1) no requirement to settle up first,
and (2) a confirmed, reproducible bug where editing an expense after someone has
left silently corrupts the split. Raised as a follow-up to
[doc 28](28_account_deletion.md), since account deletion's group-cleanup cascade
was explicitly modeled on `leaveGroup`'s current behavior — this doc changes that
model, so doc 28 is updated to match (see the end of this doc). Not yet built.

## Finding #1: leaving/removal doesn't require settling up (design gap, not corruption)

[`leaveGroup`](../../src/context/GroupContext.tsx:1621) blocks only if the caller
is the group `owner`. It does not check the caller's balance — the archived
member entry it writes has `balance: 0`
([`GroupContext.tsx:1652`](../../src/context/GroupContext.tsx)), regardless of
what they actually owed or were owed. Same shape in
[`removeMember`](../../src/context/GroupContext.tsx:1525) (admin-initiated).

**This does not actually erase the debt** — worth stating precisely, because it's
easy to over-read this as full ledger corruption. `adaptGroup`
([`GroupContext.tsx:127`](../../src/context/GroupContext.tsx)) recomputes every
member's `balance` on every read by replaying the full `expenses` +
`settlements` arrays from scratch, seeding the balance map with **both**
`members` and `archivedMembers` — so the stored `balance: 0` gets immediately
overwritten with the real computed number the moment the group doc is read.
[`BalanceSummary.tsx`](../../src/components/BalanceSummary.tsx:87) explicitly
renders nonzero archived-member balances tagged "former member," and
[`DebtsList.tsx`](../../src/components/DebtsList.tsx:151) includes archived
members in the debt-minimization graph, with a working "Settle" action that
routes to the settlement screen with the departed member's `userId`
([`DebtsList.tsx:276`](../../src/components/DebtsList.tsx)) — `settleUp`
([`GroupContext.tsx:713`](../../src/context/GroupContext.tsx)) has no membership
check at all, so recording a settlement against someone who's left works fine.

So today: a departed member's real balance stays visible and settleable
indefinitely. The gap is purely that **nothing requires it to be resolved before
they leave** — which is exactly what was asked for, and a reasonable ask on its
own terms (matches Splitwise-family product conventions, and removes the
"former member" balance row lingering forever as the normal case instead of the
exception).

## Finding #2: editing an expense after someone left silently drops their share (confirmed bug)

This is the real correctness bug, independent of Finding #1 — it exists today
regardless of whether departure ever gets a balance check, and fixing Finding #1
does not fix it (a member could still have a $0 *net* balance at the moment they
leave while individual historical expenses still list them with a nonzero share
— net-zero doesn't mean each line item is zero).

**Reproduction, traced through the code:**
1. A member leaves or is removed from a group. They're dropped from
   `group.members`, added to `group.archivedMembers`. Every `Expense.participants`
   entry that references them is untouched — expenses are never rewritten by
   `leaveGroup`/`removeMember`.
2. Someone opens [`AddExpenseScreen`](../../src/screens/expenses/AddExpenseScreen.tsx)
   to edit **any** expense that departed member was part of (even just to fix a
   typo in the title). The edit-load effect
   ([`AddExpenseScreen.tsx:135-175`](../../src/screens/expenses/AddExpenseScreen.tsx))
   correctly seeds `selectedMembers` from `expense.participants` (so the departed
   member's id IS present) and always calls
   `setSplitMetadata(inferExpenseSplitMetadata(expense))` —
   [`inferExpenseSplitMetadata`](../../src/utils/expenseSplit.ts:168) **never
   returns `undefined`**, it synthesizes a metadata object with the departed
   member's real historical share even for legacy expenses with no stored
   metadata. So `splitMetadata` is always truthy on an edit.
3. `participantShares` — the value actually saved —
   ([`AddExpenseScreen.tsx:257-279`](../../src/screens/expenses/AddExpenseScreen.tsx))
   therefore always takes the `splitMetadata` branch:
   `computeSharesFromExpenseSplit(numericAmount, billSplitParticipants, splitMetadata)`.
4. `billSplitParticipants`
   ([`AddExpenseScreen.tsx:228-255`](../../src/screens/expenses/AddExpenseScreen.tsx))
   is built as `group.members.map(...)` — **only currently-active members**. The
   departed member's `participantConfig` entry from step 2 is looked up via
   `configMap.get(m.userId)` *for each active member*; nothing ever iterates the
   reverse direction to pull in a `configMap` entry whose `userId` isn't in
   `group.members`. Their entry is silently discarded.
5. `computeParticipantsFromSplitMetadata`
   ([`expenseSplit.ts:214`](../../src/utils/expenseSplit.ts)) only ever operates
   on the `participants` array it's handed — there's no merge-back step anywhere
   downstream that could recover the dropped entry.
6. Save → `updateExpense` writes an expense whose `participants` no longer
   includes the departed member at all. Their previously-real, correctly-computed
   balance contribution from that expense vanishes the next time `adaptGroup`
   recomputes — and depending on the split method, the amount either silently
   redistributes across the remaining active participants (equal/percentage/
   shares splits renormalize over whoever's in `billSplitParticipants`) or the
   expense total simply stops summing to `amount` (exact/itemized splits, since
   nothing tops the missing share back up). Either way the group's ledger is now
   wrong, and nobody was warned.

This also means the existing confirm-removal copy in
[`GroupInfoScreen.tsx:261`](../../src/screens/groups/GroupInfoScreen.tsx) —
*"Remove {name} from the group? Their balance history stays in the group
ledger."* — is a promise the code doesn't actually keep once anyone touches one
of that member's expenses afterward.

**Why this needs fixing regardless of Finding #1's fix:** even with a
settle-before-leave gate, a member can legitimately leave at net-zero while
still appearing as a participant on individual historical expenses (their debits
and credits across different expenses net to zero, not each line being zero).
Editing any one of those expenses later would still hit this bug. Finding #2 is
the actual data-integrity fix; Finding #1 is a UX policy layered on top.

## Design decisions (proposed defaults)

- **Fix #2 ships regardless of #1** — it's the correctness guarantee, and it also
  protects every group that already has departed members with untouched
  historical expenses today (Finding #1's fix is not retroactive).
- **Self-leave hard-blocks on nonzero balance** (`leaveGroup`), matching the
  request directly: the leaving person is the one who can act, so require it.
  Uses the same `0.005` epsilon already used for "settled" everywhere else
  (`BalanceSummary.tsx`, `DebtsList`'s implicit zero-filtering).
- **Admin-removal warns but doesn't hard-block** (`removeMember`): an admin can't
  force an uncooperative or unreachable member to settle, and making removal
  impossible in that case would trap a problem member in the group. The existing
  confirm dialog gets the real balance in its copy instead of the generic message,
  so the admin makes an informed choice — Fix #2 is what makes "their balance
  history stays in the group ledger" actually true afterward.

## Implementation plan

### Fix #2 — expense split must never drop a participant (do this first)

In [`AddExpenseScreen.tsx`](../../src/screens/expenses/AddExpenseScreen.tsx):

```ts
// Union of active + archived members, but only pull in an archived member if
// they're actually part of THIS expense (via selectedMembers) — don't resurrect
// every former member into the picker for expenses they were never on.
const departedParticipants = useMemo(
  () => (group.archivedMembers ?? []).filter((m) => selectedMembers.includes(m.userId)),
  [group.archivedMembers, selectedMembers],
);

const splitBaseMembers = useMemo(
  () => [...group.members, ...departedParticipants],
  [group.members, departedParticipants],
);
```
Then swap every `group.members.map(...)` that feeds the split computation to
`splitBaseMembers.map(...)`:
- `billSplitParticipants` (line 230) — the critical one; this alone fixes the
  silent-drop bug.
- `memberDisplayNames` (line 212) — otherwise a departed participant's name
  renders blank in the edit form.
- `historicalPaidMap` (line 219) — cosmetic (departed members' `paidBy` history
  is small), but consistent.

**UI treatment for the departed participant's row:** they should render in the
participant list (so their share and name are visible, matching the "their
balance history stays in the ledger" promise) but not be re-toggleable — mirror
`BalanceSummary.tsx`'s "former member" label/`italic` treatment. `toggleMember`
(line 294) should reject toggling a departed participant's id (removing them
from an expense is a real edit someone might legitimately want to make, but it
should be an explicit, visible action, not an automatic side effect of e.g.
changing the amount — for a first pass, simplest and safest is: departed
participants are locked into the expense as-is; if someone truly needs to
re-split the expense excluding them, that's a deliberate "remove from this
expense" action on their row, not implicit).

`ExpenseDetailsScreen.tsx` (view-only) should already be safe — worth a quick
check during implementation that it also resolves departed names via a
`[...members, ...archivedMembers]` map (the same pattern
`GroupDetailsScreen.tsx:203` already uses), not `group.members` alone.

### Fix #1 — settle-before-leave

In [`GroupContext.tsx`](../../src/context/GroupContext.tsx), `leaveGroup`
(around line 1626, right after the `me` lookup and owner check):

```ts
if (Math.abs(me.balance) >= 0.005) {
  throw new Error(
    me.balance > 0
      ? `You're owed ${formatCurrency(me.balance, group.currency)} — settle up before leaving.`
      : `You owe ${formatCurrency(Math.abs(me.balance), group.currency)} — settle up before leaving.`,
  );
}
```
(`formatCurrency` already imported elsewhere in this codebase via
`@/utils/currency`; add the import if `GroupContext.tsx` doesn't have it.) The
existing catch block in
[`GroupInfoScreen.tsx:333-336`](../../src/screens/groups/GroupInfoScreen.tsx)
already surfaces thrown errors via `appAlert('Could not leave group',
errorMessage(error, ...))`, so this needs no new UI plumbing — just a clearer
message than the generic fallback.

In [`GroupInfoScreen.tsx`](../../src/screens/groups/GroupInfoScreen.tsx),
`confirmRemoveMember` (line 258): look up the target's live balance (already on
`member.balance` thanks to `adaptGroup`) and branch the copy:
```ts
const confirmRemoveMember = (member: GroupMember) => {
  const settled = Math.abs(member.balance) < 0.005;
  appAlert(
    'Remove member',
    settled
      ? `Remove ${member.displayName} from "${group.name}"? Their balance history stays in the group ledger.`
      : `${member.displayName} still has an unsettled balance of ${fmtMoney(Math.abs(member.balance), group.currency)}. Removing them keeps this visible under Former members, but they won't be able to settle it themselves anymore. Remove anyway?`,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void performMemberAction(member, 'remove') },
    ],
  );
};
```

### Update to doc 28 (account deletion) — required consistency fix

Doc 28's `deleteAccountCascade` currently mirrors `leaveGroup`/`removeMember`'s
**pre-fix** behavior (archive-remove regardless of balance). Once Fix #1 lands,
account deletion must follow the same self-leave rule — otherwise deleting your
account becomes a backdoor around the very check just added to `leaveGroup`.
Concretely, `findDeletionBlockers`
(doc 28's Cloud Function sketch) needs a second blocker type alongside the
existing owner-with-members one:
```ts
// In the same loop as the ownership check:
if (Math.abs(computeMemberBalance(data, uid)) >= 0.005) {
  blockers.push({ groupId: doc.id, groupName: data.name ?? "Untitled group", reason: "unsettled_balance" });
}
```
(`computeMemberBalance` — a small admin-side port of `adaptGroup`'s balance-replay
logic over that one group's `expenses`/`settlements`, scoped to `uid`; doesn't
exist yet, needs writing alongside the rest of doc 28's Cloud Function.) The
client-side pre-check and blocker-list UI in doc 28 step 5 already has a place
for this — extend the modal copy to distinguish "transfer ownership" blockers
from "settle up" blockers.

## Verify

- Create a throwaway group, three members, one expense split three ways. Have
  member C leave while owing money — confirm `leaveGroup` now blocks with the
  right amount in the message. Settle up, leave again — confirm it succeeds.
- With a *pre-existing* departed member (seed data or a test account from before
  this fix), edit one of their expenses — confirm their share is now preserved
  and the expense total still matches `amount` after saving (this is the
  regression test for Finding #2; it must pass even without ever exercising
  Fix #1, since Fix #2 is the one guarding pre-existing data).
- Admin-remove a member with a nonzero balance — confirm the warning copy shows
  the right amount and direction, and that removal still succeeds.

## Out of scope for this pass

- Retroactively repairing expenses that have *already* been corrupted by this bug
  in production (their participant shares already lost). That's a data-cleanup
  script decision, not a code-fix decision — flagging for awareness, not planning
  here without knowing how much existing data is actually affected.
- Extending the same "departed but still on this expense" treatment to
  itemized/receipt-scan flows beyond what Fix #2 already covers structurally
  (the fix is at the participant-list level, so it should apply uniformly, but
  itemized assignment UI specifically wasn't traced line-by-line here).
