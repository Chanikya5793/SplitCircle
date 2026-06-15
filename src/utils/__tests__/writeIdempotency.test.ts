/**
 * writeIdempotency.test.ts — the dedup checks that keep offline money writes
 * (arrayUnion-based addExpense/settleUp) idempotent without a server read.
 */

import { describe, expect, it } from 'vitest';
import { findDuplicateExpense, findDuplicateSettlement } from '../writeIdempotency';

describe('findDuplicateExpense', () => {
  const expenses = [
    { expenseId: 'e1', requestId: 'r1' },
    { expenseId: 'e2', requestId: 'r2' },
  ];

  it('matches by expenseId', () => {
    expect(findDuplicateExpense(expenses, 'e2', undefined)?.expenseId).toBe('e2');
  });

  it('matches by requestId when id differs', () => {
    expect(findDuplicateExpense(expenses, 'new-id', 'r1')?.expenseId).toBe('e1');
  });

  it('returns undefined when neither matches', () => {
    expect(findDuplicateExpense(expenses, 'nope', 'also-nope')).toBeUndefined();
  });

  it('ignores a falsy requestId (no accidental match on undefined requestIds)', () => {
    const items = [{ expenseId: 'e1' }];
    expect(findDuplicateExpense(items, 'other', undefined)).toBeUndefined();
  });

  it('handles undefined/empty arrays', () => {
    expect(findDuplicateExpense(undefined, 'e1', 'r1')).toBeUndefined();
    expect(findDuplicateExpense([], 'e1', 'r1')).toBeUndefined();
  });
});

describe('findDuplicateSettlement', () => {
  const settlements = [
    { settlementId: 's1', requestId: 'r1' },
    { settlementId: 's2' },
  ];

  it('matches by settlementId', () => {
    expect(findDuplicateSettlement(settlements, 's1', undefined)?.settlementId).toBe('s1');
  });

  it('matches by requestId when id differs', () => {
    expect(findDuplicateSettlement(settlements, 'new', 'r1')?.settlementId).toBe('s1');
  });

  it('returns undefined when neither matches', () => {
    expect(findDuplicateSettlement(settlements, 'nope', 'nope')).toBeUndefined();
  });

  it('handles undefined arrays', () => {
    expect(findDuplicateSettlement(undefined, 's1', 'r1')).toBeUndefined();
  });
});
