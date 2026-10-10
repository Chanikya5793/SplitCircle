// Duress decoy dataset (Privacy Guard).
//
// In the duress decoy world the app must look unlocked while showing nothing
// real. Masking each field at render time does not hold up: every screen that
// forgets one call — and new screens always do — prints the real group name,
// member list or invite code under a "fake" unlock. So the decoy is applied to
// the DATA instead: `useGroups()` hands every screen a disguised copy of each
// shielded group, and whatever a screen renders, derives or passes along is
// already fake and self-consistent.
//
// Rules the copy keeps so it survives scrutiny:
//  - Same ids, members, counts, categories and ordering — the structure is
//    real, only the identifying content is replaced.
//  - Text comes from the curated dictionaries (`disguiseText`), deterministic
//    per real value, so a person has the same fake name in every group and on
//    every screen (and matches `maskPersonName` on Friends / Calls).
//  - Money is scaled by the group's ONE stable factor (`decoyScaleFor`), so
//    shares, totals, balances and settlements still reconcile.
//  - Dates move back by a stable per-group offset (`decoyTimestamp`).
//  - Photos, receipts and itemized split details are dropped outright.

import type { Expense, Group, GroupMember, Settlement } from '@/models';
import type { RecurringBill } from '@/models/recurringBill';
import { decoyScaleFor, decoyTimestamp, disguiseText, garbleText } from '@/services/privacyGuardService';

const round2 = (value: number) => Math.round(value * 100) / 100;

const fakeText = (value: string | undefined, kind: Parameters<typeof disguiseText>[1]) =>
  value && value.trim() ? disguiseText(value, kind) : value;

const decoyMember = (member: GroupMember, scale: number): GroupMember => ({
  ...member,
  displayName: fakeText(member.displayName, 'person') ?? member.displayName,
  photoURL: undefined,
  balance: round2(member.balance * scale),
});

const decoyExpense = (expense: Expense, scale: number, groupId: string): Expense => {
  const { splitMetadata: _split, receipt: _receipt, ...rest } = expense;
  return {
    ...rest,
    title: fakeText(expense.title, 'title') ?? expense.title,
    notes: fakeText(expense.notes, 'note'),
    amount: round2(expense.amount * scale),
    participants: expense.participants.map((p) => ({ ...p, share: round2(p.share * scale) })),
    createdAt: decoyTimestamp(expense.createdAt, groupId),
    updatedAt: decoyTimestamp(expense.updatedAt, groupId),
  };
};

const decoySettlement = (settlement: Settlement, scale: number, groupId: string): Settlement => ({
  ...settlement,
  amount: round2(settlement.amount * scale),
  note: fakeText(settlement.note, 'note'),
  createdAt: decoyTimestamp(settlement.createdAt, groupId),
  updatedAt: settlement.updatedAt === undefined ? undefined : decoyTimestamp(settlement.updatedAt, groupId),
});

/** The disguised copy of one group. Pure and deterministic for a given salt. */
export const decoyGroup = (group: Group): Group => {
  const scale = decoyScaleFor(group.groupId);
  const id = group.groupId;
  return {
    ...group,
    name: fakeText(group.name, 'group') ?? group.name,
    description: fakeText(group.description, 'note'),
    inviteCode: group.inviteCode ? garbleText(group.inviteCode) : group.inviteCode,
    photoURL: undefined,
    members: group.members.map((m) => decoyMember(m, scale)),
    archivedMembers: group.archivedMembers?.map((m) => decoyMember(m, scale)),
    expenses: group.expenses.map((e) => decoyExpense(e, scale, id)),
    settlements: group.settlements.map((s) => decoySettlement(s, scale, id)),
    budgets: group.budgets
      ? Object.fromEntries(Object.entries(group.budgets).map(([k, v]) => [k, round2(v * scale)]))
      : group.budgets,
    createdAt: decoyTimestamp(group.createdAt, id),
    updatedAt: decoyTimestamp(group.updatedAt, id),
  };
};

/** A recurring bill as the decoy world shows it (loaded outside useGroups). */
export const decoyRecurringBill = (bill: RecurringBill): RecurringBill => {
  const scale = decoyScaleFor(bill.groupId);
  return {
    ...bill,
    title: fakeText(bill.title, 'title') ?? bill.title,
    amount: round2(bill.amount * scale),
    participants: bill.participants.map((p) => ({ ...p, share: round2(p.share * scale) })),
  };
};

/** Thrown by every write the decoy world blocks. Reads like an ordinary failure. */
export class DecoyWriteBlockedError extends Error {
  constructor() {
    super('Something went wrong. Please try again.');
    this.name = 'DecoyWriteBlockedError';
  }
}
