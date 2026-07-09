/**
 * expenseAnalyticsIndex.test.ts — the persistent, incremental on-device index
 * logic in `expenseAnalytics`: the single source of truth for staleness
 * (`computeIndexMeta` + `isIndexFresh`), version-mismatch rebuild decisions, the
 * memory→store→recompute resolution chain in `getGroupAnalytics`, and the
 * guarantee that a failing persistence layer (the SQLite store) never crashes
 * the AI path. The SQLite store is injected via `setIndexPersistence`, so these
 * pure tests mock that boundary directly instead of expo-sqlite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Expense } from '../../models/expense';
import {
  clearAnalyticsCache,
  computeIndexMeta,
  getGroupAnalytics,
  INDEX_VERSION,
  isIndexFresh,
  setIndexPersistence,
  type ExpenseAnalytics,
  type IndexPersistence,
  type StoredGroupIndex,
} from '../expenseAnalytics';

const exp = (over: Partial<Expense>): Expense => ({
  expenseId: Math.random().toString(36).slice(2),
  groupId: 'g1',
  title: 'X',
  category: 'General',
  amount: 0,
  paidBy: 'u1',
  splitType: 'equal',
  participants: [],
  settled: false,
  createdAt: Date.UTC(2026, 4, 15),
  updatedAt: Date.UTC(2026, 4, 15),
  ...over,
});

/**
 * A controllable in-memory stand-in for the SQLite-backed index store. `readVal`
 * is what read() returns; setting `throwOn*` makes a method throw so we can
 * exercise the AI path's fallback-on-error guards.
 */
function makeProvider(opts: {
  readVal?: StoredGroupIndex | null;
  throwOnRead?: boolean;
  throwOnWrite?: boolean;
  throwOnClear?: boolean;
} = {}): IndexPersistence & {
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
} {
  return {
    read: vi.fn((): StoredGroupIndex | null => {
      if (opts.throwOnRead) throw new Error('sqlite read boom');
      return opts.readVal ?? null;
    }),
    write: vi.fn((): void => {
      if (opts.throwOnWrite) throw new Error('sqlite write boom');
    }),
    clear: vi.fn((): void => {
      if (opts.throwOnClear) throw new Error('sqlite clear boom');
    }),
  };
}

beforeEach(() => {
  // Isolate each test: drop any injected persistence first so clearing the
  // memory cache can't fan out to a previous test's mock, then start clean.
  setIndexPersistence(null);
  clearAnalyticsCache();
});

afterEach(() => {
  setIndexPersistence(null);
});

describe('computeIndexMeta (staleness fingerprint)', () => {
  it('folds group/expense/settlement timestamps into updatedAt and counts expenses', () => {
    const group = {
      groupId: 'g',
      updatedAt: 100,
      expenses: [exp({ updatedAt: 250 }), exp({ updatedAt: 180 })],
      settlements: [{ settlementId: 's1', fromUserId: 'u2', toUserId: 'u1', amount: 5, createdAt: 400, status: 'completed' as const }],
    };
    const meta = computeIndexMeta(group);
    expect(meta.version).toBe(INDEX_VERSION);
    expect(meta.expenseCount).toBe(2);
    expect(meta.updatedAt).toBe(400); // newest of group/expense/settlement stamps
  });

  it('defaults cleanly when nothing has timestamps', () => {
    const meta = computeIndexMeta({ groupId: 'g' });
    expect(meta).toEqual({ version: INDEX_VERSION, updatedAt: 0, expenseCount: 0 });
  });
});

describe('isIndexFresh (single source of truth for staleness)', () => {
  const current = { version: INDEX_VERSION, updatedAt: 500, expenseCount: 3 };

  it('is fresh only when version, updatedAt, and count all match', () => {
    expect(isIndexFresh({ ...current }, current)).toBe(true);
  });

  it('is stale on version mismatch (drives lazy rebuild after an app upgrade)', () => {
    expect(isIndexFresh({ ...current, version: INDEX_VERSION - 1 }, current)).toBe(false);
  });

  it('is stale when data changed (updatedAt) or an expense was added/removed (count)', () => {
    expect(isIndexFresh({ ...current, updatedAt: 499 }, current)).toBe(false);
    expect(isIndexFresh({ ...current, expenseCount: 2 }, current)).toBe(false);
  });

  it('is stale when there is no stored fingerprint at all', () => {
    expect(isIndexFresh(null, current)).toBe(false);
    expect(isIndexFresh(undefined, current)).toBe(false);
  });
});

describe('getGroupAnalytics resolution chain (memory → store → recompute)', () => {
  it('hydrates from the store on a memory miss without recomputing', () => {
    const group = { groupId: 'gh', updatedAt: 10, expenses: [exp({ updatedAt: 10 })], settlements: [] };
    const meta = computeIndexMeta(group);
    const sentinel = { count: 42 } as unknown as ExpenseAnalytics; // proves it came from the store, not a fresh compute
    const provider = makeProvider({ readVal: { ...meta, analytics: sentinel } });
    setIndexPersistence(provider);

    const a = getGroupAnalytics(group, 'u1');
    expect(a).toBe(sentinel); // returned the stored analytics reference
    expect(provider.read).toHaveBeenCalledTimes(1);
    expect(provider.write).not.toHaveBeenCalled(); // fresh store hit ⇒ no write-back

    // Second ask is served from the hydrated memory cache — store not touched again.
    const b = getGroupAnalytics(group, 'u1');
    expect(b).toBe(sentinel);
    expect(provider.read).toHaveBeenCalledTimes(1);
  });

  it('recomputes and writes back when the stored index version is stale', () => {
    const group = {
      groupId: 'gv',
      updatedAt: 10,
      expenses: [exp({ amount: 100, participants: [{ userId: 'u1', share: 100 }], updatedAt: 10 })],
      settlements: [],
    };
    const meta = computeIndexMeta(group);
    const oldSentinel = { count: -1 } as unknown as ExpenseAnalytics;
    const provider = makeProvider({
      readVal: { ...meta, version: INDEX_VERSION - 1, analytics: oldSentinel },
    });
    setIndexPersistence(provider);

    const a = getGroupAnalytics(group, 'u1');
    expect(a).not.toBe(oldSentinel); // stale version ⇒ ignored, recomputed
    expect(a.totalSpend).toBe(100);
    expect(provider.write).toHaveBeenCalledTimes(1);
    const [, , written] = provider.write.mock.calls[0];
    expect((written as StoredGroupIndex).version).toBe(INDEX_VERSION); // written back at current version
    expect((written as StoredGroupIndex).analytics).toBe(a);
  });

  it('recomputes and writes back when the group data changed (staleness)', () => {
    const group = {
      groupId: 'gs',
      updatedAt: 10,
      expenses: [exp({ amount: 50, participants: [{ userId: 'u1', share: 50 }], updatedAt: 10 })],
      settlements: [],
    };
    const meta = computeIndexMeta(group);
    // Store holds a matching-version index but with an older updatedAt/count.
    const provider = makeProvider({
      readVal: { ...meta, updatedAt: meta.updatedAt - 1, analytics: { count: 0 } as unknown as ExpenseAnalytics },
    });
    setIndexPersistence(provider);

    const a = getGroupAnalytics(group, 'u1');
    expect(a.totalSpend).toBe(50); // recomputed from current data
    expect(provider.write).toHaveBeenCalledTimes(1);
  });
});

describe('fallback-on-error (persistent SQLite store never crashes the AI path)', () => {
  const group = {
    groupId: 'gerr',
    updatedAt: 10,
    expenses: [exp({ amount: 20, participants: [{ userId: 'u1', share: 20 }], updatedAt: 10 })],
    settlements: [],
  };

  it('recomputes in memory when the store read throws', () => {
    setIndexPersistence(makeProvider({ throwOnRead: true }));
    const a = getGroupAnalytics(group, 'u1');
    expect(a.totalSpend).toBe(20);
  });

  it('still returns the computed value when the store write throws', () => {
    const provider = makeProvider({ throwOnWrite: true });
    setIndexPersistence(provider);
    const a = getGroupAnalytics(group, 'u1');
    expect(a.totalSpend).toBe(20);
    expect(provider.write).toHaveBeenCalledTimes(1); // attempted, threw, swallowed
  });

  it('clearAnalyticsCache swallows a throwing store clear', () => {
    setIndexPersistence(makeProvider({ throwOnClear: true }));
    expect(() => clearAnalyticsCache()).not.toThrow();
  });
});
