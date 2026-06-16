import { describe, expect, it } from 'vitest';
import type { Expense } from '../../models/expense';
import type { Group, Settlement } from '../../models/group';
import { mergeOutboxIntoGroups, type OutboxOp } from '../outboxApply';

const exp = (over: Partial<Expense>): Expense => ({
  expenseId: 'e1', groupId: 'g1', title: 'X', category: 'Food', amount: 10, paidBy: 'u1',
  splitType: 'equal', participants: [{ userId: 'u1', share: 10 }], settled: false,
  createdAt: 1, updatedAt: 1, ...over,
});

const settle = (over: Partial<Settlement>): Settlement => ({
  settlementId: 's1', fromUserId: 'u1', toUserId: 'u2', amount: 5, createdAt: 1, status: 'pending', ...over,
});

const group = (over: Partial<Group>): Group => ({
  groupId: 'g1', inviteCode: 'ABC', name: 'G', currency: 'USD', members: [], expenses: [], settlements: [],
  createdBy: 'u1', createdAt: 1, updatedAt: 1, ...over,
});

describe('mergeOutboxIntoGroups', () => {
  it('returns the same array when there are no ops', () => {
    const groups = [group({})];
    expect(mergeOutboxIntoGroups(groups, [])).toBe(groups);
  });

  it('appends a pending expense to the matching group', () => {
    const groups = [group({ expenses: [exp({ expenseId: 'a' })] })];
    const op: OutboxOp = { id: 'b', kind: 'addExpense', groupId: 'g1', expense: exp({ expenseId: 'b' }), createdAt: 2 };
    const out = mergeOutboxIntoGroups(groups, [op]);
    expect(out[0].expenses.map((e) => e.expenseId)).toEqual(['a', 'b']);
  });

  it('dedups by expenseId (already synced)', () => {
    const groups = [group({ expenses: [exp({ expenseId: 'b' })] })];
    const op: OutboxOp = { id: 'b', kind: 'addExpense', groupId: 'g1', expense: exp({ expenseId: 'b' }), createdAt: 2 };
    const out = mergeOutboxIntoGroups(groups, [op]);
    expect(out[0].expenses).toHaveLength(1);
  });

  it('dedups by requestId even if expenseId differs', () => {
    const groups = [group({ expenses: [exp({ expenseId: 'server', requestId: 'r1' })] })];
    const op: OutboxOp = { id: 'r1', kind: 'addExpense', groupId: 'g1', expense: exp({ expenseId: 'local', requestId: 'r1' }), createdAt: 2 };
    const out = mergeOutboxIntoGroups(groups, [op]);
    expect(out[0].expenses).toHaveLength(1);
  });

  it('appends a pending settlement', () => {
    const groups = [group({})];
    const op: OutboxOp = { id: 's2', kind: 'settleUp', groupId: 'g1', settlement: settle({ settlementId: 's2' }), createdAt: 2 };
    const out = mergeOutboxIntoGroups(groups, [op]);
    expect(out[0].settlements.map((s) => s.settlementId)).toEqual(['s2']);
  });

  it('only touches the op\'s own group', () => {
    const groups = [group({ groupId: 'g1' }), group({ groupId: 'g2' })];
    const op: OutboxOp = { id: 'b', kind: 'addExpense', groupId: 'g2', expense: exp({ expenseId: 'b', groupId: 'g2' }), createdAt: 2 };
    const out = mergeOutboxIntoGroups(groups, [op]);
    expect(out[0].expenses).toHaveLength(0);
    expect(out[1].expenses).toHaveLength(1);
    expect(out[0]).toBe(groups[0]); // untouched group keeps its reference
  });

  it('drops ops for groups that are not loaded', () => {
    const groups = [group({ groupId: 'g1' })];
    const op: OutboxOp = { id: 'b', kind: 'addExpense', groupId: 'gX', expense: exp({ expenseId: 'b', groupId: 'gX' }), createdAt: 2 };
    const out = mergeOutboxIntoGroups(groups, [op]);
    expect(out[0].expenses).toHaveLength(0);
  });
});
