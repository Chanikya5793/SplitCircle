import { describe, expect, it } from 'vitest';

import {
  addToChatMap,
  isInChatMap,
  partitionChats,
  removeFromChatMap,
  sortByChatMapTimeDesc,
} from '../chatOrganization';

interface Item {
  id: string;
}
const items = (...ids: string[]): Item[] => ids.map((id) => ({ id }));
const ids = (list: Item[]): string[] => list.map((i) => i.id);

describe('isInChatMap', () => {
  it('is true only for ids present in the map', () => {
    const map = { a: 100, b: 0 };
    expect(isInChatMap(map, 'a')).toBe(true);
    // A 0 (falsy) timestamp still counts as a membership marker.
    expect(isInChatMap(map, 'b')).toBe(true);
    expect(isInChatMap(map, 'c')).toBe(false);
  });

  it('is false for an undefined map', () => {
    expect(isInChatMap(undefined, 'a')).toBe(false);
  });
});

describe('addToChatMap / removeFromChatMap', () => {
  it('adds an id immutably with the given timestamp', () => {
    const before = { a: 1 };
    const after = addToChatMap(before, 'b', 42);
    expect(after).toEqual({ a: 1, b: 42 });
    expect(before).toEqual({ a: 1 }); // input untouched
  });

  it('defaults to a "now" timestamp when none is given', () => {
    const t0 = Date.now();
    const after = addToChatMap(undefined, 'a');
    expect(after.a).toBeGreaterThanOrEqual(t0);
  });

  it('removes an id immutably', () => {
    const before = { a: 1, b: 2 };
    const after = removeFromChatMap(before, 'a');
    expect(after).toEqual({ b: 2 });
    expect(before).toEqual({ a: 1, b: 2 });
  });

  it('returns an empty map when removing from undefined', () => {
    expect(removeFromChatMap(undefined, 'a')).toEqual({});
  });
});

describe('sortByChatMapTimeDesc', () => {
  it('orders most-recent first', () => {
    const list = items('a', 'b', 'c');
    const map = { a: 10, b: 30, c: 20 };
    expect(ids(sortByChatMapTimeDesc(list, map, (i) => i.id))).toEqual(['b', 'c', 'a']);
  });

  it('sinks items missing from the map to the bottom, stable on ties', () => {
    const list = items('a', 'b', 'c', 'd');
    const map = { b: 5 };
    // b (5) first; a/c/d all 0 → keep incoming order.
    expect(ids(sortByChatMapTimeDesc(list, map, (i) => i.id))).toEqual(['b', 'a', 'c', 'd']);
  });
});

describe('partitionChats', () => {
  const getId = (i: Item) => i.id;

  it('splits into pinned / active / archived / locked with precedence', () => {
    const list = items('active1', 'pinned1', 'archived1', 'locked1', 'active2');
    const buckets = partitionChats(list, {
      getId,
      isArchived: (i) => i.id === 'archived1',
      pinnedChats: { pinned1: 100 },
      lockedChats: { locked1: 200 },
    });
    expect(ids(buckets.active)).toEqual(['active1', 'active2']);
    expect(ids(buckets.pinned)).toEqual(['pinned1']);
    expect(ids(buckets.archived)).toEqual(['archived1']);
    expect(ids(buckets.locked)).toEqual(['locked1']);
  });

  it('locked wins over archived — a locked+archived chat is only in locked', () => {
    const list = items('x');
    const buckets = partitionChats(list, {
      getId,
      isArchived: () => true, // also archived
      lockedChats: { x: 1 },
    });
    expect(ids(buckets.locked)).toEqual(['x']);
    expect(buckets.archived).toEqual([]);
    expect(buckets.active).toEqual([]);
    expect(buckets.pinned).toEqual([]);
  });

  it('locked wins over pinned — a locked+pinned chat is only in locked', () => {
    const list = items('x');
    const buckets = partitionChats(list, {
      getId,
      isArchived: () => false,
      pinnedChats: { x: 1 },
      lockedChats: { x: 2 },
    });
    expect(ids(buckets.locked)).toEqual(['x']);
    expect(buckets.pinned).toEqual([]);
    expect(buckets.active).toEqual([]);
  });

  it('archived wins over pinned — an archived+pinned chat is only in archived', () => {
    const list = items('x');
    const buckets = partitionChats(list, {
      getId,
      isArchived: () => true,
      pinnedChats: { x: 1 },
    });
    expect(ids(buckets.archived)).toEqual(['x']);
    expect(buckets.pinned).toEqual([]);
    expect(buckets.active).toEqual([]);
  });

  it('orders the pinned cluster most-recently-pinned first', () => {
    const list = items('p1', 'p2', 'p3');
    const buckets = partitionChats(list, {
      getId,
      isArchived: () => false,
      pinnedChats: { p1: 10, p2: 30, p3: 20 },
    });
    expect(ids(buckets.pinned)).toEqual(['p2', 'p3', 'p1']);
  });

  it('preserves the incoming order within the active bucket', () => {
    const list = items('c', 'a', 'b');
    const buckets = partitionChats(list, { getId, isArchived: () => false });
    expect(ids(buckets.active)).toEqual(['c', 'a', 'b']);
  });
});
