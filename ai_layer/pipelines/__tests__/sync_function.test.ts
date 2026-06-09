/**
 * sync_function.test.ts — Firestore->BigQuery sync core. Pure row mappers +
 * runBqSyncForGroup with a mocked BigQuery client (no live GCP).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertSpy } = vi.hoisted(() => ({
  insertSpy: vi.fn((_rows?: Array<{ insertId: string; json: object }>, _opts?: unknown) => Promise.resolve()),
}));

/** The deterministic insertId of the first row of the Nth insert() call. */
const firstInsertId = (call: number) => insertSpy.mock.calls[call][0]![0].insertId;

vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: class {
    dataset() { return { table: () => ({ insert: insertSpy }) }; }
  },
}));
vi.mock('firebase-functions/logger', () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('firebase-functions/v2/firestore', () => ({ onDocumentWritten: (_p: string, h: unknown) => h }));

import { mapExpenseRow, mapSettlementRow, runBqSyncForGroup } from '../firestore_to_bq/sync_function';

beforeEach(() => insertSpy.mockClear());

describe('mapExpenseRow', () => {
  it('maps fields, tolerates title/description drift, flags notes presence', () => {
    const row = mapExpenseRow('g1', '$', {
      expenseId: 'e1', description: 'Dinner', amount: 40, paidBy: 'u1',
      participants: [{ userId: 'u1' }, { userId: 'u2' }], notes: 'tip', receipt: {},
      createdAt: 111, updatedAt: 222,
    } as any, '2026-01-01T00:00:00.000Z');
    expect(row).toMatchObject({
      expense_id: 'e1', group_id: 'g1', title: 'Dinner', amount: 40, currency: '$',
      paid_by: 'u1', participant_ids: ['u1', 'u2'], participant_count: 2,
      notes_present: true, has_receipt: true,
    });
  });

  it('defaults amount, empty participants, and notes_present=false', () => {
    const row = mapExpenseRow('g1', '$', { expenseId: 'e1', title: 'X', paidBy: 'u1' } as any, '2026-01-01T00:00:00.000Z');
    expect(row.amount).toBe(0);
    expect(row.participant_ids).toEqual([]);
    expect(row.notes_present).toBe(false);
    expect(row.has_receipt).toBe(false);
  });
});

describe('mapSettlementRow', () => {
  it('maps a settlement', () => {
    const row = mapSettlementRow('g1', '$', { settlementId: 's1', fromUserId: 'u1', toUserId: 'u2', amount: 10, status: 'pending', createdAt: 5 } as any, 'ts');
    expect(row).toMatchObject({ settlement_id: 's1', group_id: 'g1', from_user_id: 'u1', to_user_id: 'u2', amount: 10, status: 'pending' });
  });
});

describe('runBqSyncForGroup', () => {
  it('no-ops on delete (after undefined)', async () => {
    expect(await runBqSyncForGroup('g1', undefined)).toEqual({ expenses: 0, settlements: 0 });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('inserts expenses, settlements and the group row with deterministic insertIds', async () => {
    const after = {
      currency: '$', updatedAt: 999, name: 'Trip', memberIds: ['u1', 'u2'], createdBy: 'u1', createdAt: 1,
      expenses: [{ expenseId: 'e1', amount: 40, paidBy: 'u1', updatedAt: 222, participants: [{ userId: 'u1' }] }],
      settlements: [{ settlementId: 's1', fromUserId: 'u1', toUserId: 'u2', amount: 10, createdAt: 5 }],
    };
    const res = await runBqSyncForGroup('g1', after as any);
    expect(res).toEqual({ expenses: 1, settlements: 1 });
    expect(insertSpy).toHaveBeenCalledTimes(3);
    expect(firstInsertId(0)).toBe('e1:222');
    expect(firstInsertId(1)).toBe('s1:5');
    expect(firstInsertId(2)).toBe('g1:999');
  });

  it('skips empty expense/settlement inserts but always writes the group row', async () => {
    const res = await runBqSyncForGroup('g1', { currency: '$', updatedAt: 7, memberIds: [] } as any);
    expect(res).toEqual({ expenses: 0, settlements: 0 });
    expect(insertSpy).toHaveBeenCalledTimes(1); // groups only
    expect(firstInsertId(0)).toBe('g1:7');
  });
});
