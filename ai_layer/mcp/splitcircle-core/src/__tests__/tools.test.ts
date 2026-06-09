/**
 * tools.test.ts — Unit tests for every splitcircle-core tool + balance math + rate limiter.
 * Uses an in-memory DataAccess fake; no Firestore/SDK required (Critical Rule #7).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { type DataAccess, PermissionError } from '../lib/dataAccess.js';
import type { Expense, Group } from '../lib/types.js';
import type { ToolContext } from '../lib/tool.js';
import { getExpenses } from '../tools/get_expenses.js';
import { getGroupBalances } from '../tools/get_group_balances.js';
import { getSettlementSuggestions } from '../tools/get_settlement_suggestions.js';
import { getUserGroups } from '../tools/get_user_groups.js';
import { getRecentActivity } from '../tools/get_recent_activity.js';
import { searchExpenses } from '../tools/search_expenses.js';
import { addExpense } from '../tools/add_expense.js';
import { calculateBalances, minimizeDebts } from '../lib/balances.js';
import { enforceRateLimit, RateLimitError, __resetRateLimiter } from '../auth/middleware.js';

const ALEX = 'u_alex';
const SAM = 'u_sam';
const KAY = 'u_kay';

function makeGroup(): Group {
  return {
    groupId: 'g1', name: 'Trip', currency: '$',
    members: [
      { userId: ALEX, displayName: 'Alex', role: 'owner' },
      { userId: SAM, displayName: 'Sam', role: 'member' },
      { userId: KAY, displayName: 'Kay', role: 'member' },
    ],
    memberIds: [ALEX, SAM, KAY],
    expenses: [
      { expenseId: 'e1', groupId: 'g1', title: 'Dinner', category: 'food', amount: 30, paidBy: ALEX,
        splitType: 'equal', participants: [{ userId: ALEX, share: 10 }, { userId: SAM, share: 10 }, { userId: KAY, share: 10 }],
        createdAt: 1000, updatedAt: 1000 },
      { expenseId: 'e2', groupId: 'g1', title: 'Taxi', category: 'transport', amount: 20, paidBy: SAM,
        splitType: 'equal', participants: [{ userId: ALEX, share: 10 }, { userId: SAM, share: 10 }],
        createdAt: 2000, updatedAt: 2000 },
    ],
    settlements: [],
    createdBy: ALEX, createdAt: 0, updatedAt: 2000,
  };
}

class FakeData implements DataAccess {
  groups: Record<string, Group> = { g1: makeGroup() };
  async getUserGroups(uid: string): Promise<Group[]> {
    return Object.values(this.groups).filter((g) => (g.memberIds ?? []).includes(uid));
  }
  async getGroup(uid: string, groupId: string): Promise<Group> {
    const g = this.groups[groupId];
    if (!g) throw new Error('not found');
    if (!(g.memberIds ?? []).includes(uid)) throw new PermissionError();
    return g;
  }
  async addExpense(_uid: string, groupId: string, expense: Expense): Promise<Expense> {
    this.groups[groupId].expenses.push(expense);
    return expense;
  }
  async searchExpenses(uid: string, query: string, groupId: string | undefined, limit: number) {
    const groups = groupId ? [await this.getGroup(uid, groupId)] : await this.getUserGroups(uid);
    const results = groups.flatMap((g) => g.expenses).filter((e) => e.title.toLowerCase().includes(query.toLowerCase())).slice(0, limit);
    return { results, answer: `Found ${results.length}` };
  }
}

function ctx(uid: string, data: DataAccess): ToolContext { return { uid, data }; }

describe('balance math', () => {
  it('computes net balances from expenses', () => {
    const b = calculateBalances(makeGroup().expenses);
    // Alex paid 30 (own share 10) => +20; minus taxi share 10 => +10
    expect(b[ALEX]).toBeCloseTo(10);
    // Sam paid 20 (own 10) => +10; minus dinner share 10 => 0
    expect(b[SAM]).toBeCloseTo(0);
    // Kay owes dinner share 10 => -10
    expect(b[KAY]).toBeCloseTo(-10);
  });
  it('minimizes to the fewest transactions', () => {
    const debts = minimizeDebts(calculateBalances(makeGroup().expenses));
    expect(debts).toHaveLength(1);
    expect(debts[0]).toMatchObject({ from: KAY, to: ALEX, amount: 10 });
  });
});

describe('read tools', () => {
  let data: FakeData;
  beforeEach(() => { data = new FakeData(); __resetRateLimiter(); });

  it('get_expenses returns the user\'s expenses, newest first', async () => {
    const r = await getExpenses.handler({ limit: 50 } as any, ctx(ALEX, data));
    const ids = (r.data as any).expenses.map((e: Expense) => e.expenseId);
    expect(ids).toEqual(['e2', 'e1']);
  });

  it('get_expenses filters by category', async () => {
    const r = await getExpenses.handler({ limit: 50, category: 'food' } as any, ctx(ALEX, data));
    expect((r.data as any).expenses).toHaveLength(1);
  });

  it('get_group_balances enriches with names', async () => {
    const r = await getGroupBalances.handler({ groupId: 'g1' } as any, ctx(ALEX, data));
    const kay = (r.data as any).balances.find((b: any) => b.userId === KAY);
    expect(kay.displayName).toBe('Kay');
    expect(kay.owes).toBeCloseTo(10);
  });

  it('get_settlement_suggestions returns named transfers', async () => {
    const r = await getSettlementSuggestions.handler({ groupId: 'g1' } as any, ctx(ALEX, data));
    expect((r.data as any).settlements[0]).toMatchObject({ fromName: 'Kay', toName: 'Alex', amount: 10 });
  });

  it('get_user_groups summarizes my net balance', async () => {
    const r = await getUserGroups.handler({} as any, ctx(KAY, data));
    expect((r.data as any).groups[0]).toMatchObject({ status: 'owes', myNetBalance: -10 });
  });

  it('get_recent_activity merges + sorts', async () => {
    const r = await getRecentActivity.handler({ limit: 10 } as any, ctx(ALEX, data));
    expect((r.data as any).activity[0].id).toBe('e2');
  });

  it('search_expenses delegates to data layer', async () => {
    const r = await searchExpenses.handler({ query: 'taxi', limit: 10 } as any, ctx(ALEX, data));
    expect((r.data as any).results[0].expenseId).toBe('e2');
  });

  it('enforces membership: non-member cannot read a group', async () => {
    await expect(getGroupBalances.handler({ groupId: 'g1' } as any, ctx('stranger', data)))
      .rejects.toBeInstanceOf(PermissionError);
  });
});

describe('add_expense (write tool)', () => {
  let data: FakeData;
  beforeEach(() => { data = new FakeData(); });

  it('adds a valid expense', async () => {
    const r = await addExpense.handler({
      groupId: 'g1', title: 'Snacks', amount: 9, paidBy: ALEX, splitType: 'equal', category: 'food',
      participants: [{ userId: ALEX, share: 3 }, { userId: SAM, share: 3 }, { userId: KAY, share: 3 }],
    } as any, ctx(ALEX, data));
    expect((r.data as any).expense.title).toBe('Snacks');
    expect(data.groups.g1.expenses).toHaveLength(3);
  });

  it('rejects when shares do not sum to amount', async () => {
    await expect(addExpense.handler({
      groupId: 'g1', title: 'Bad', amount: 10, paidBy: ALEX, splitType: 'equal', category: 'food',
      participants: [{ userId: ALEX, share: 3 }, { userId: SAM, share: 3 }],
    } as any, ctx(ALEX, data))).rejects.toThrow(/sum to amount/);
  });

  it('rejects a non-member payer', async () => {
    await expect(addExpense.handler({
      groupId: 'g1', title: 'X', amount: 5, paidBy: 'ghost', splitType: 'equal', category: 'food',
      participants: [{ userId: ALEX, share: 5 }],
    } as any, ctx(ALEX, data))).rejects.toThrow(/not a member/);
  });

  it('is flagged idempotent + non-destructive', () => {
    expect(addExpense.annotations).toMatchObject({ idempotentHint: true, destructiveHint: false });
  });
});

describe('rate limiter', () => {
  beforeEach(() => __resetRateLimiter());
  it('throws after the burst capacity is exhausted', () => {
    const t = 1_000_000;
    expect(() => { for (let i = 0; i < 30; i++) enforceRateLimit('u', t); }).not.toThrow();
    expect(() => enforceRateLimit('u', t)).toThrow(RateLimitError);
  });
  it('refills over time', () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 30; i++) enforceRateLimit('u2', t0);
    expect(() => enforceRateLimit('u2', t0 + 2000)).not.toThrow(); // ~2 tokens refilled
  });
});
