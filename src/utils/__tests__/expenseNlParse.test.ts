/**
 * expenseNlParse.test.ts — name resolution + NL draft mapping (pure).
 */

import { describe, expect, it } from 'vitest';
import { mapNlExpense, resolveMemberId, type NlMember } from '../expenseNlParse';

const members: NlMember[] = [
  { userId: 'u1', displayName: 'Alice Smith' },
  { userId: 'u2', displayName: 'Bob' },
  { userId: 'u3', displayName: 'Charlie Brown' },
];

describe('resolveMemberId', () => {
  it('matches exact and first-name/partial', () => {
    expect(resolveMemberId('Bob', members)).toBe('u2');
    expect(resolveMemberId('alice', members)).toBe('u1'); // first-name prefix
    expect(resolveMemberId('Charlie', members)).toBe('u3');
  });

  it('returns null for unknown names', () => {
    expect(resolveMemberId('Zelda', members)).toBeNull();
    expect(resolveMemberId('', members)).toBeNull();
  });
});

describe('mapNlExpense', () => {
  it('resolves payer + participants, coerces category, rounds amount', () => {
    const out = mapNlExpense(
      {
        title: 'Dinner',
        amount: 42.555,
        category: 'food',
        paidByName: 'Bob',
        participantNames: ['Alice', 'Bob'],
        splitEqually: true,
        date: '2026-06-13',
      },
      members,
      'u1',
    );
    expect(out).toMatchObject({
      title: 'Dinner',
      amount: 42.56,
      category: 'Food',
      paidByUserId: 'u2',
      participantUserIds: ['u1', 'u2'],
      splitEqually: true,
    });
    expect(out.createdAt).not.toBeNull();
  });

  it('defaults payer to current user and participants to everyone', () => {
    const out = mapNlExpense({ title: 'Snacks', amount: 9 }, members, 'u3');
    expect(out.paidByUserId).toBe('u3');
    expect(out.participantUserIds).toEqual(['u1', 'u2', 'u3']);
    expect(out.splitEqually).toBe(true); // default
    expect(out.createdAt).toBeNull(); // no/!valid date
  });

  it('clamps a bad amount to 0 and dedupes participants', () => {
    const out = mapNlExpense(
      { amount: -5, participantNames: ['Bob', 'bob', 'Alice Smith'] },
      members,
      'u1',
    );
    expect(out.amount).toBe(0);
    expect(out.participantUserIds).toEqual(['u2', 'u1']);
    expect(out.title).toBe('');
    expect(out.category).toBe('General');
  });

  it('honors splitEqually=false', () => {
    expect(mapNlExpense({ splitEqually: false }, members, 'u1').splitEqually).toBe(false);
  });
});
