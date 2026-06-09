/**
 * predict_service.test.ts — auto-categorize core (MODEL-01). Mocks BigQuery
 * ML.PREDICT + Firestore to verify blank-only categorization, confidence gating,
 * and idempotency (no write-back when nothing changes).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { querySpy, updateSpy } = vi.hoisted(() => ({
  querySpy: vi.fn(async () => [[{ category: 'food', confidence: 0.9 }]]),
  updateSpy: vi.fn((_v?: unknown) => Promise.resolve()),
}));

vi.mock('firebase-functions/logger', () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('firebase-functions/v2/firestore', () => ({ onDocumentWritten: (_p: string, h: unknown) => h }));
vi.mock('firebase-admin/app', () => ({ getApps: () => [], initializeApp: vi.fn() }));
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ collection: () => ({ doc: () => ({ update: updateSpy }) }) }),
}));
vi.mock('@google-cloud/bigquery', () => ({ BigQuery: class { query = querySpy; } }));

import { runAutoCategorizeForGroup } from '../predict_service';

beforeEach(() => {
  querySpy.mockClear();
  updateSpy.mockClear();
  querySpy.mockResolvedValue([[{ category: 'food', confidence: 0.9 }]]);
});

describe('runAutoCategorizeForGroup', () => {
  it('no-ops with no doc / no expenses', async () => {
    expect(await runAutoCategorizeForGroup('g1', undefined)).toEqual({ categorized: 0 });
    expect(await runAutoCategorizeForGroup('g1', {} as any)).toEqual({ categorized: 0 });
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('categorizes a blank expense above threshold and writes back once', async () => {
    const after = { expenses: [{ expenseId: 'e1', category: '', title: 'Dinner', amount: 40, participants: [{ userId: 'u1' }], createdAt: 111 }] };
    const res = await runAutoCategorizeForGroup('g1', after as any);
    expect(res).toEqual({ categorized: 1 });
    expect(updateSpy).toHaveBeenCalledOnce();
    const written = updateSpy.mock.calls[0][0] as any;
    expect(written.expenses[0]).toMatchObject({ category: 'food', categorySource: 'model' });
  });

  it('respects a user-set category (idempotent — no predict, no write)', async () => {
    const after = { expenses: [{ expenseId: 'e1', category: 'travel', title: 'Flight', amount: 200 }] };
    expect(await runAutoCategorizeForGroup('g1', after as any)).toEqual({ categorized: 0 });
    expect(querySpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('does not apply a low-confidence prediction', async () => {
    querySpy.mockResolvedValue([[{ category: 'food', confidence: 0.3 }]]);
    const after = { expenses: [{ expenseId: 'e1', category: 'uncategorized', title: 'Misc', amount: 5 }] };
    expect(await runAutoCategorizeForGroup('g1', after as any)).toEqual({ categorized: 0 });
    expect(querySpy).toHaveBeenCalledOnce();
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
