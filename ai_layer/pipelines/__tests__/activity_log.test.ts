/**
 * activity_log.test.ts — derived group activity feed (Open Question #3 / RAG-06).
 */

import { describe, it, expect } from 'vitest';
import { buildActivityEvents } from '../activity/activity_log';

describe('buildActivityEvents', () => {
  it('returns nothing on delete (no after)', () => {
    expect(buildActivityEvents({}, undefined, 'g1')).toEqual([]);
  });

  it('emits expense_added for new expenses with deterministic ids', () => {
    const before = { expenses: [{ expenseId: 'e1' }] };
    const after = { expenses: [{ expenseId: 'e1' }, { expenseId: 'e2', title: 'Taxi', amount: 18, paidBy: 'u1', createdAt: 5 }] };
    const ev = buildActivityEvents(before, after, 'g1');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ eventId: 'expense_added:e2', type: 'expense_added', actorId: 'u1', at: 5 });
  });

  it('emits expense_settled only on the unsettled→settled transition', () => {
    const before = { expenses: [{ expenseId: 'e1', settled: false }] };
    const after = { expenses: [{ expenseId: 'e1', settled: true, title: 'Dinner', paidBy: 'u1', updatedAt: 9 }] };
    const ev = buildActivityEvents(before, after, 'g1');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'expense_settled', eventId: 'expense_settled:e1' });
  });

  it('emits settlement_added and member join/leave', () => {
    const before = { members: [{ userId: 'u1', displayName: 'Alex' }, { userId: 'u3', displayName: 'Robin' }], settlements: [] };
    const after = {
      members: [{ userId: 'u1', displayName: 'Alex' }, { userId: 'u2', displayName: 'Sam' }],
      settlements: [{ settlementId: 's1', fromUserId: 'u2', toUserId: 'u1', amount: 10, createdAt: 3 }],
    };
    const ev = buildActivityEvents(before, after, 'g1');
    const types = ev.map((e) => e.type).sort();
    expect(types).toEqual(['member_joined', 'member_left', 'settlement_added']);
    expect(ev.find((e) => e.type === 'settlement_added')!.summary).toContain('u2 paid u1 10');
  });

  it('does not emit for unchanged data (idempotent re-fire)', () => {
    const snap = { expenses: [{ expenseId: 'e1', settled: true }], settlements: [{ settlementId: 's1' }], members: [{ userId: 'u1' }] };
    expect(buildActivityEvents(snap, snap, 'g1')).toEqual([]);
  });
});
