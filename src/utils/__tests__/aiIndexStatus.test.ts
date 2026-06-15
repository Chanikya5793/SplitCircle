/**
 * aiIndexStatus.test.ts — on-device index status summary (pure).
 */

import { describe, expect, it } from 'vitest';
import { buildIndexStatus } from '../aiIndexStatus';

const groups = [
  { groupId: 'g1', name: 'Trip', expenses: [{}, {}, {}], settlements: [{}] },
  { groupId: 'g2', name: 'Flat', expenses: [{}], settlements: [] },
];

describe('buildIndexStatus', () => {
  it('summarizes per-group counts + totals and cached flags', () => {
    const status = buildIndexStatus(groups, 'u1', new Set(['g1:u1']));
    expect(status.totalGroups).toBe(2);
    expect(status.totalExpenses).toBe(4);
    expect(status.totalSettlements).toBe(1);
    expect(status.groups[0]).toMatchObject({ groupId: 'g1', expenseCount: 3, settlementCount: 1, cached: true });
    expect(status.groups[1].cached).toBe(false); // g2:u1 not in cache set
  });

  it('handles empty input', () => {
    const status = buildIndexStatus([], 'u1', new Set());
    expect(status).toEqual({ groups: [], totalGroups: 0, totalExpenses: 0, totalSettlements: 0 });
  });
});
