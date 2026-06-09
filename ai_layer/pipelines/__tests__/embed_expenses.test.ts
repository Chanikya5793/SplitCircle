/**
 * embed_expenses.test.ts — embedding core. Mocks Firestore + embedding_client to
 * verify composite datapoint ids, user/group restricts, and contentHash idempotency.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const { store, embedTextSpy, upsertSpy } = vi.hoisted(() => ({
  store: new Map<string, any>(),
  embedTextSpy: vi.fn(async () => new Array(8).fill(0.1)),
  upsertSpy: vi.fn((_dp?: unknown) => Promise.resolve()),
}));

vi.mock('firebase-functions/logger', () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('firebase-functions/v2/firestore', () => ({ onDocumentWritten: (_p: string, h: unknown) => h }));
vi.mock('firebase-admin/app', () => ({ getApps: () => [], initializeApp: vi.fn() }));
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    doc: (path: string) => ({
      get: async () => ({ exists: store.has(path), data: () => store.get(path) }),
      set: async (v: any) => { store.set(path, v); },
    }),
  }),
}));
vi.mock('../embedding/embedding_client', () => ({
  buildEmbeddingText: (e: any) => `${e.title}|${e.category}|${e.amount}`,
  embedText: embedTextSpy,
  upsertDatapoint: upsertSpy,
}));

import { runEmbedForGroup } from '../embedding/embed_expenses';

beforeEach(() => { store.clear(); embedTextSpy.mockClear(); upsertSpy.mockClear(); });

describe('runEmbedForGroup', () => {
  it('no-ops on delete / empty expenses', async () => {
    expect(await runEmbedForGroup('g1', undefined)).toEqual({ embedded: 0, skipped: 0 });
    expect(await runEmbedForGroup('g1', { expenses: [] } as any)).toEqual({ embedded: 0, skipped: 0 });
    expect(embedTextSpy).not.toHaveBeenCalled();
  });

  it('embeds a new expense with composite id + user/group restricts', async () => {
    const after = {
      currency: '$', members: [{ userId: 'u1', displayName: 'Alex' }, { userId: 'u2', displayName: 'Sam' }],
      expenses: [{ expenseId: 'e1', title: 'Dinner', category: 'food', amount: 40, paidBy: 'u1', participants: [{ userId: 'u1' }, { userId: 'u2' }], createdAt: 111 }],
    };
    const res = await runEmbedForGroup('g1', after as any);
    expect(res).toEqual({ embedded: 1, skipped: 0 });
    expect(embedTextSpy).toHaveBeenCalledOnce();

    const dp = upsertSpy.mock.calls[0][0] as any;
    expect(dp.datapointId).toBe('g1:e1');
    const userR = dp.restricts.find((r: any) => r.namespace === 'user');
    expect(userR.allowList).toEqual(expect.arrayContaining(['u1', 'u2']));
    expect(dp.restricts.find((r: any) => r.namespace === 'group').allowList).toEqual(['g1']);
    // reverse-lookup record persisted with composite embeddingId
    expect(store.get('groups/g1/_embedHashes/e1')).toMatchObject({ embeddingId: 'g1:e1' });
  });

  it('skips when contentHash is unchanged (idempotent re-fire)', async () => {
    const e = { expenseId: 'e1', title: 'Dinner', category: 'food', amount: 40, paidBy: 'u1', participants: [{ userId: 'u1' }], createdAt: 111 };
    const hash = createHash('sha256').update('Dinner|food|40').digest('hex').slice(0, 16);
    store.set('groups/g1/_embedHashes/e1', { hash });

    const res = await runEmbedForGroup('g1', { currency: '$', members: [], expenses: [e] } as any);
    expect(res).toEqual({ embedded: 0, skipped: 1 });
    expect(embedTextSpy).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});
