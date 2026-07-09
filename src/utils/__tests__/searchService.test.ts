import { describe, expect, it } from 'vitest';

import {
  groupByType,
  highlightSegments,
  looksLikeQuestion,
  searchIndex,
  type SearchItem,
} from '../../services/searchService';

const index: SearchItem[] = [
  {
    id: 'group-trip',
    type: 'group',
    title: 'Barcelona Trip',
    subtitle: '4 members',
    icon: 'account-group-outline',
    keywords: 'Maya Theo',
    route: 'GroupsTab',
    recency: Date.now(),
  },
  {
    id: 'expense-paella',
    type: 'expense',
    title: 'Paella night',
    subtitle: '$84.00 - Food - Barcelona Trip',
    icon: 'receipt-text-outline',
    keywords: 'restaurant Maya Barcelona Trip',
    route: 'ExpenseDetails',
  },
  {
    id: 'friend-maya',
    type: 'friend',
    title: 'Maya Patel',
    subtitle: 'Friend',
    icon: 'account-circle-outline',
    route: 'FriendInfo',
  },
  {
    id: 'settlement-theo',
    type: 'settlement',
    title: 'Theo paid Maya',
    subtitle: '$20.00 - Barcelona Trip',
    icon: 'cash-check',
    keywords: 'settle payment',
    route: 'Settlements',
  },
];

describe('searchService', () => {
  it('ranks exact and prefix title matches above keyword-only matches', () => {
    const results = searchIndex('maya', index);

    expect(results.map((r) => r.id).slice(0, 2)).toEqual(['friend-maya', 'settlement-theo']);
    expect(results.some((r) => r.id === 'group-trip')).toBe(true);
  });

  it('requires every query token to match somewhere on the item', () => {
    const results = searchIndex('maya restaurant', index);

    expect(results.map((r) => r.id)).toEqual(['expense-paella']);
  });

  it('groups ranked results into user-facing sections', () => {
    const sections = groupByType(searchIndex('barcelona', index));

    expect(sections.map((s) => s.type)).toEqual(['group', 'expense', 'settlement']);
  });

  it('detects natural-language questions for the AI handoff', () => {
    expect(looksLikeQuestion('how much did we spend on food')).toBe(true);
    expect(looksLikeQuestion('paella')).toBe(false);
  });

  it('falls back to OR semantics only when strict AND yields nothing, at compressed scores', () => {
    // 'paella' matches the expense; 'zzz' matches nothing → strict AND tier empties.
    const results = searchIndex('paella zzz', index);
    expect(results.some((r) => r.id === 'expense-paella')).toBe(true);

    // The same term as a clean AND hit must always outscore the OR-fallback hit.
    const andHit = searchIndex('paella', index).find((r) => r.id === 'expense-paella')!;
    const orHit = results.find((r) => r.id === 'expense-paella')!;
    expect(orHit.score).toBeLessThan(andHit.score);
  });

  it('applies light typo tolerance only in the fallback tier', () => {
    const strict = searchIndex('barcelona', index);
    expect(strict.length).toBeGreaterThan(0);

    // 'barcelora' is a single substitution from 'barcelona' — no strict hit exists,
    // so only the fuzzy fallback can surface it.
    const typo = searchIndex('barcelora', index);
    expect(typo.some((r) => r.id === 'group-trip')).toBe(true);

    const strictTop = strict.find((r) => r.id === 'group-trip')!;
    const typoTop = typo.find((r) => r.id === 'group-trip')!;
    expect(typoTop.score).toBeLessThan(strictTop.score);

    // A three-letter garbage token gets no typo grace and finds nothing.
    expect(searchIndex('zzz', index)).toEqual([]);
  });

  it('indexes message hits into their own section below stronger entity matches', () => {
    const withMessage: SearchItem[] = [
      ...index,
      {
        id: 'message-1',
        type: 'message',
        title: 'lets grab paella tonight',
        subtitle: 'Barcelona Trip',
        icon: 'message-text-outline',
        route: 'GroupChat',
        params: { chatId: 'c1', messageId: 'm1' },
        recency: Date.now(),
      },
    ];

    const results = searchIndex('paella', withMessage);
    expect(results.some((r) => r.id === 'message-1')).toBe(true);

    const sections = groupByType(results);
    expect(sections.some((s) => s.type === 'message')).toBe(true);

    // A prefix title match on the expense outranks a mid-content message hit.
    const expenseRank = results.findIndex((r) => r.id === 'expense-paella');
    const messageRank = results.findIndex((r) => r.id === 'message-1');
    expect(expenseRank).toBeGreaterThanOrEqual(0);
    expect(expenseRank).toBeLessThan(messageRank);
  });

  it('matches case- and diacritic-insensitively', () => {
    const accented: SearchItem[] = [
      { id: 'group-cafe', type: 'group', title: 'Café Olé', icon: 'account-group-outline', route: 'GroupsTab' },
    ];

    expect(searchIndex('cafe', accented).some((r) => r.id === 'group-cafe')).toBe(true);
    expect(searchIndex('OLE', accented).some((r) => r.id === 'group-cafe')).toBe(true);
  });

  it('nudges more recent items above otherwise-tied matches', () => {
    const now = Date.now();
    const tied: SearchItem[] = [
      {
        id: 'friend-old',
        type: 'friend',
        title: 'Jordan Lee',
        icon: 'account-circle-outline',
        route: 'FriendInfo',
        recency: now - 30 * 86_400_000,
      },
      {
        id: 'friend-new',
        type: 'friend',
        title: 'Jordan Lee',
        icon: 'account-circle-outline',
        route: 'FriendInfo',
        recency: now,
      },
    ];

    const results = searchIndex('jordan', tied);
    expect(results[0].id).toBe('friend-new');
  });
});

describe('highlightSegments', () => {
  it('splits text into matched/unmatched runs, diacritic-insensitive, preserving originals', () => {
    const segs = highlightSegments('Café Olé', 'cafe');

    // Original characters (with accents) are preserved end-to-end.
    expect(segs.map((s) => s.text).join('')).toBe('Café Olé');
    const matched = segs.filter((s) => s.match).map((s) => s.text).join('');
    expect(matched).toBe('Café');
  });

  it('highlights every occurrence of each query token', () => {
    const segs = highlightSegments('Maya paid Maya', 'maya');
    const matched = segs.filter((s) => s.match).map((s) => s.text);
    expect(matched).toEqual(['Maya', 'Maya']);
  });

  it('returns a single unmatched run when the query is empty', () => {
    expect(highlightSegments('hello', '')).toEqual([{ text: 'hello', match: false }]);
  });
});
