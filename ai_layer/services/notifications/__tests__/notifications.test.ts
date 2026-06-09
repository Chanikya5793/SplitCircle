import { describe, it, expect } from 'vitest';
import { findOverdueSettlements, buildActivityDigest, type Settlement } from '../notifications';

const DAY = 86_400_000;
const now = 30 * DAY;

describe('findOverdueSettlements', () => {
  const settlements: Settlement[] = [
    { settlementId: 's1', fromUserId: 'a', toUserId: 'b', amount: 10, status: 'pending', createdAt: now - 10 * DAY },
    { settlementId: 's2', fromUserId: 'a', toUserId: 'c', amount: 20, status: 'pending', createdAt: now - 2 * DAY },
    { settlementId: 's3', fromUserId: 'b', toUserId: 'a', amount: 5, status: 'completed', createdAt: now - 30 * DAY },
    { settlementId: 's4', fromUserId: 'c', toUserId: 'a', amount: 8, status: 'pending', createdAt: now - 20 * DAY },
  ];

  it('returns only pending settlements past the threshold, oldest first', () => {
    const overdue = findOverdueSettlements(settlements, now, 7);
    expect(overdue.map((o) => o.settlementId)).toEqual(['s4', 's1']); // 20d, 10d; s2 too new; s3 completed
    expect(overdue[0].ageDays).toBe(20);
  });

  it('respects a custom threshold and ignores entries without createdAt', () => {
    expect(findOverdueSettlements(settlements, now, 15)).toHaveLength(1);
    expect(findOverdueSettlements([{ settlementId: 'x', fromUserId: 'a', toUserId: 'b', amount: 1, status: 'pending' }], now)).toEqual([]);
  });
});

describe('buildActivityDigest', () => {
  it('summarizes counts + overdue with correct pluralization', () => {
    const msg = buildActivityDigest({ newExpenses: 1, newSettlements: 2, overdue: [{ settlementId: 's', fromUserId: 'a', toUserId: 'b', amount: 5, ageDays: 12 }] });
    expect(msg).toBe('Since you last checked: 1 new expense, 2 settlements, 1 overdue payment (oldest 12d).');
  });

  it('says so when there is nothing new', () => {
    expect(buildActivityDigest({})).toBe('No new activity.');
  });
});
