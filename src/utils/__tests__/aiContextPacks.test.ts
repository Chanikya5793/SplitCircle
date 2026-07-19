/**
 * aiContextPacks.test.ts — the data side of the pipeline: per-kind formatting,
 * cross-group aggregation, the personal spending profile, and priority-ordered
 * budget packing that must never overflow the model's context window.
 */

import { describe, expect, it } from 'vitest';
import type { Expense } from '../../models/expense';
import type { Group, Settlement } from '../../models/group';
import {
  approxTokens,
  buildSpendingProfileLines,
  formatCrossGroupLines,
  formatSettlementLines,
  packSections,
  type ContextSection,
} from '../aiContextPacks';

const members = [
  { userId: 'u1', displayName: 'You' },
  { userId: 'u2', displayName: 'Sam' },
];

const expense = (over: Partial<Expense>, i: number): Expense => ({
  expenseId: `e${i}`,
  groupId: 'g1',
  title: `Item ${i}`,
  category: 'Food',
  amount: 30,
  paidBy: 'u1',
  splitType: 'equal',
  participants: [
    { userId: 'u1', share: 15 },
    { userId: 'u2', share: 15 },
  ],
  settled: false,
  createdAt: new Date('2026-04-10').getTime() + i * 86400000,
  updatedAt: 0,
  ...over,
});

const group = (over: Partial<Group>): Group => ({
  groupId: 'g1',
  inviteCode: 'X',
  name: 'Trip',
  currency: 'USD',
  members: members.map((m) => ({ ...m, role: 'member', balance: 0 } as Group['members'][number])),
  expenses: [expense({}, 0), expense({ category: 'Transport', amount: 40 }, 1)],
  settlements: [],
  createdBy: 'u1',
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('formatSettlementLines', () => {
  it('renders newest-first with names and amounts', () => {
    const settlements: Settlement[] = [
      { settlementId: 's1', fromUserId: 'u1', toUserId: 'u2', amount: 12.5, createdAt: 100, status: 'completed' },
      { settlementId: 's2', fromUserId: 'u2', toUserId: 'u1', amount: 8, createdAt: 200, status: 'pending' },
    ];
    const lines = formatSettlementLines(settlements, members, 'USD');
    expect(lines[0]).toContain('Sam paid You 8.00 USD');
    expect(lines[0]).toContain('(pending)');
    expect(lines[1]).toContain('You paid Sam 12.50 USD');
  });
});

describe('formatCrossGroupLines', () => {
  it('aggregates a grand total across groups', () => {
    const groups = [group({ groupId: 'g1', name: 'Trip' }), group({ groupId: 'g2', name: 'Flat' })];
    const lines = formatCrossGroupLines(groups, 'u1');
    const summary = lines[lines.length - 1];
    expect(summary).toContain('ALL GROUPS');
    // Two groups × (30 + 40) = 140 total spend.
    expect(summary).toContain('140.00');
  });
});

describe('buildSpendingProfileLines', () => {
  it('summarizes categories and split partners from the user’s share', () => {
    const lines = buildSpendingProfileLines([group({})], 'u1');
    expect(lines.join('\n')).toMatch(/Top categories/);
    expect(lines.join('\n')).toContain('Sam');
  });

  it('returns nothing when the user has no expenses', () => {
    expect(buildSpendingProfileLines([group({ expenses: [] })], 'nobody')).toEqual([]);
  });
});

describe('packSections — budget enforcement', () => {
  const bigSection = (kind: ContextSection['kind'], priority: number, n: number): ContextSection => ({
    kind,
    title: `${kind} title`,
    lines: Array.from({ length: n }, (_, i) => `${kind} line ${i} with some padding text to cost tokens`),
    priority,
  });

  it('keeps high-priority sections and drops low-priority ones under a tight budget', () => {
    const sections = [
      bigSection('balances', 1, 4),
      bigSection('spending_profile', 4, 40),
    ];
    const { included, context } = packSections(sections, 120);
    expect(included).toContain('balances');
    expect(included).not.toContain('spending_profile');
    expect(approxTokens(context)).toBeLessThanOrEqual(120);
  });

  it('never exceeds the budget even with many sections', () => {
    const sections = [
      bigSection('balances', 1, 10),
      bigSection('settlements', 2, 30),
      bigSection('chat_messages', 2, 30),
      bigSection('receipt_items', 3, 30),
    ];
    const budget = 300;
    const { context } = packSections(sections, budget);
    expect(approxTokens(context)).toBeLessThanOrEqual(budget);
  });

  it('skips empty sections entirely', () => {
    const { included } = packSections([{ kind: 'settlements', title: 'x', lines: [], priority: 1 }], 1000);
    expect(included).toEqual([]);
  });
});
