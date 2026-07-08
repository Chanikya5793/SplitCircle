import { describe, expect, it } from 'vitest';

import { groupByType, looksLikeQuestion, searchIndex, type SearchItem } from '../../services/searchService';

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
});
