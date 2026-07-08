/**
 * notificationEntityMatch.test.ts — the pure logic behind withdrawing stale
 * notifications for deleted groups/expenses/settlements: payload matching and
 * snapshot diffing.
 */

import { describe, it, expect } from 'vitest';

import {
  diffRemovedChatIds,
  diffRemovedEntities,
  notificationMatchesEntity,
  type GroupEntityIds,
} from '../notificationEntityMatch';

const ids = (expenseIds: string[] = [], settlementIds: string[] = []): GroupEntityIds => ({
  expenseIds: new Set(expenseIds),
  settlementIds: new Set(settlementIds),
});

describe('notificationMatchesEntity', () => {
  it('rejects null/empty payloads', () => {
    expect(notificationMatchesEntity(null, { groupId: 'g1' })).toBe(false);
    expect(notificationMatchesEntity(undefined, { groupId: 'g1' })).toBe(false);
    expect(notificationMatchesEntity({}, { groupId: 'g1' })).toBe(false);
  });

  it('rejects when the filter is empty', () => {
    expect(notificationMatchesEntity({ groupId: 'g1' }, {})).toBe(false);
  });

  it('matches on groupId — clears every notification referencing the group', () => {
    expect(notificationMatchesEntity({ type: 'expense', groupId: 'g1', expenseId: 'e1' }, { groupId: 'g1' })).toBe(true);
    expect(notificationMatchesEntity({ type: 'group_join', groupId: 'g1' }, { groupId: 'g1' })).toBe(true);
    expect(notificationMatchesEntity({ type: 'expense', groupId: 'g2' }, { groupId: 'g1' })).toBe(false);
  });

  it('matches on expenseId, settlementId, and chatId individually', () => {
    expect(notificationMatchesEntity({ expenseId: 'e1' }, { expenseId: 'e1' })).toBe(true);
    expect(notificationMatchesEntity({ settlementId: 's1' }, { settlementId: 's1' })).toBe(true);
    expect(notificationMatchesEntity({ chatId: 'c1' }, { chatId: 'c1' })).toBe(true);
    expect(notificationMatchesEntity({ expenseId: 'e2' }, { expenseId: 'e1' })).toBe(false);
  });

  it('any single id match is enough', () => {
    expect(
      notificationMatchesEntity(
        { groupId: 'g1', expenseId: 'e1' },
        { groupId: 'gX', expenseId: 'e1' },
      ),
    ).toBe(true);
  });
});

describe('diffRemovedEntities', () => {
  it('returns nothing when snapshots are identical', () => {
    const prev = new Map([['g1', ids(['e1'], ['s1'])]]);
    const curr = new Map([['g1', ids(['e1'], ['s1'])]]);
    expect(diffRemovedEntities(prev, curr)).toEqual([]);
  });

  it('reports a deleted group as a group filter (not per-entity)', () => {
    const prev = new Map([['g1', ids(['e1', 'e2'], ['s1'])]]);
    const curr = new Map<string, GroupEntityIds>();
    expect(diffRemovedEntities(prev, curr)).toEqual([{ groupId: 'g1' }]);
  });

  it('reports removed expenses and settlements in surviving groups', () => {
    const prev = new Map([['g1', ids(['e1', 'e2'], ['s1'])]]);
    const curr = new Map([['g1', ids(['e1'], [])]]);
    expect(diffRemovedEntities(prev, curr)).toEqual([
      { expenseId: 'e2' },
      { settlementId: 's1' },
    ]);
  });

  it('ignores newly added groups and entities', () => {
    const prev = new Map([['g1', ids(['e1'])]]);
    const curr = new Map([
      ['g1', ids(['e1', 'e2'])],
      ['g2', ids(['e9'])],
    ]);
    expect(diffRemovedEntities(prev, curr)).toEqual([]);
  });

  it('handles a mix of deleted group and removed expense elsewhere', () => {
    const prev = new Map([
      ['g1', ids(['e1'])],
      ['g2', ids(['e2', 'e3'])],
    ]);
    const curr = new Map([['g2', ids(['e2'])]]);
    expect(diffRemovedEntities(prev, curr)).toEqual([
      { groupId: 'g1' },
      { expenseId: 'e3' },
    ]);
  });
});

describe('diffRemovedChatIds', () => {
  it('returns nothing when snapshots are identical', () => {
    expect(diffRemovedChatIds(new Set(['c1', 'c2']), new Set(['c1', 'c2']))).toEqual([]);
  });

  it('reports each vanished chat as a chatId filter', () => {
    expect(diffRemovedChatIds(new Set(['c1', 'c2', 'c3']), new Set(['c2']))).toEqual([
      { chatId: 'c1' },
      { chatId: 'c3' },
    ]);
  });

  it('ignores newly added chats', () => {
    expect(diffRemovedChatIds(new Set(['c1']), new Set(['c1', 'c2']))).toEqual([]);
  });

  it('handles an empty previous snapshot', () => {
    expect(diffRemovedChatIds(new Set(), new Set(['c1']))).toEqual([]);
  });

  it('reports everything gone when the current snapshot is empty', () => {
    expect(diffRemovedChatIds(new Set(['c1', 'c2']), new Set())).toEqual([
      { chatId: 'c1' },
      { chatId: 'c2' },
    ]);
  });
});
