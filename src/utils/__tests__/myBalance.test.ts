import { describe, expect, it } from 'vitest';
import {
  computeMyGroupBalance,
  computeOverallBalance,
  splitOwedAndOwing,
} from '@/utils/myBalance';

const ME = 'me';
const A = 'alice';
const B = 'bob';

/** I paid 90, split three ways → the other two owe me 30 each. */
const paidByMe = {
  currency: 'USD',
  expenses: [
    {
      paidBy: ME,
      participants: [
        { userId: ME, share: 30 },
        { userId: A, share: 30 },
        { userId: B, share: 30 },
      ],
    },
  ],
  settlements: [],
};

/** Alice paid 90, split three ways → I owe 30. */
const paidByAlice = {
  currency: 'USD',
  expenses: [
    {
      paidBy: A,
      participants: [
        { userId: ME, share: 30 },
        { userId: A, share: 30 },
        { userId: B, share: 30 },
      ],
    },
  ],
  settlements: [],
};

describe('computeMyGroupBalance', () => {
  it('is positive when others owe me', () => {
    expect(computeMyGroupBalance(ME, paidByMe)).toBe(60);
  });

  it('is negative when I owe', () => {
    expect(computeMyGroupBalance(ME, paidByAlice)).toBe(-30);
  });

  it('settling cancels the debt out', () => {
    const settled = {
      ...paidByAlice,
      settlements: [{ fromUserId: ME, toUserId: A, amount: 30 }],
    };
    expect(computeMyGroupBalance(ME, settled)).toBe(0);
  });

  it('treats sub-cent dust as settled, not as a balance', () => {
    // Three-way split of 10 leaves rounding residue; a UI that renders
    // "you owe $0.00" instead of "settled up" is the bug this guards.
    const dust = {
      currency: 'USD',
      expenses: [
        {
          paidBy: A,
          participants: [
            { userId: ME, share: 3.333 },
            { userId: A, share: 3.333 },
            { userId: B, share: 3.334 },
          ],
        },
      ],
      settlements: [{ fromUserId: ME, toUserId: A, amount: 3.3329 }],
    };
    expect(computeMyGroupBalance(ME, dust)).toBe(0);
  });

  it('returns 0 with no user (signed out / not yet hydrated)', () => {
    expect(computeMyGroupBalance(undefined, paidByMe)).toBe(0);
  });

  it('ignores groups I am not part of', () => {
    const theirs = {
      currency: 'USD',
      expenses: [
        { paidBy: A, participants: [{ userId: A, share: 10 }, { userId: B, share: 10 }] },
      ],
      settlements: [],
    };
    expect(computeMyGroupBalance(ME, theirs)).toBe(0);
  });
});

describe('computeOverallBalance', () => {
  it('keeps currencies separate instead of summing them', () => {
    const inr = { ...paidByMe, currency: 'INR' };
    const totals = computeOverallBalance(ME, [paidByMe, inr]);
    expect(totals).toHaveLength(2);
    expect(totals.map((t) => t.currency).sort()).toEqual(['INR', 'USD']);
  });

  it('nets multiple groups in the SAME currency', () => {
    // +60 owed, -30 owing, same currency → +30 net.
    const totals = computeOverallBalance(ME, [paidByMe, paidByAlice]);
    expect(totals).toEqual([{ currency: 'USD', amount: 30 }]);
  });

  it('drops a currency that nets to zero rather than showing 0', () => {
    const owedBack = {
      currency: 'USD',
      expenses: [
        {
          paidBy: A,
          participants: [
            { userId: ME, share: 60 },
            { userId: A, share: 60 },
          ],
        },
      ],
      settlements: [],
    };
    // +60 from paidByMe, -60 here → nothing to show.
    expect(computeOverallBalance(ME, [paidByMe, owedBack])).toEqual([]);
  });

  it('sorts by largest exposure first', () => {
    const big = { ...paidByMe, currency: 'EUR' };
    const small = {
      currency: 'GBP',
      expenses: [
        { paidBy: ME, participants: [{ userId: ME, share: 1 }, { userId: A, share: 1 }] },
      ],
      settlements: [],
    };
    const totals = computeOverallBalance(ME, [small, big]);
    expect(totals[0].currency).toBe('EUR');
  });

  it('is empty when settled everywhere', () => {
    expect(computeOverallBalance(ME, [])).toEqual([]);
  });
});

describe('splitOwedAndOwing', () => {
  it('separates directions and makes owing positive for display', () => {
    const { owed, owing } = splitOwedAndOwing([
      { currency: 'USD', amount: 40 },
      { currency: 'INR', amount: -250 },
    ]);
    expect(owed).toEqual([{ currency: 'USD', amount: 40 }]);
    expect(owing).toEqual([{ currency: 'INR', amount: 250 }]);
  });

  it('keeps both sides rather than netting across currencies', () => {
    // Owed $500 and owing ₹500 is NOT "settled" — both must survive.
    const { owed, owing } = splitOwedAndOwing([
      { currency: 'USD', amount: 500 },
      { currency: 'INR', amount: -500 },
    ]);
    expect(owed).toHaveLength(1);
    expect(owing).toHaveLength(1);
  });
});
