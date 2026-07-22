/**
 * aiTools.test.ts — the agentic tool registry (doc 24 §4) against a fixture
 * group with hand-computable numbers. Every assertion is exact: the registry
 * is the numbers source for the model, so a wrong tool result IS a wrong
 * answer. Includes the doc-17 screenshot-#3 regression ("Aprils total?" —
 * explicit month names must resolve).
 */
import { describe, expect, it } from 'vitest';

import type { Expense } from '@/models/expense';
import type { Settlement } from '@/models/group';
import {
  MAX_REQUESTS_PER_HOP,
  availableTools,
  executeToolRequests,
  requestKey,
  resolveMember,
  resolvePeriod,
  statusLineFor,
  toolCatalog,
  toolResultsBlock,
  toolTier,
  type ToolCtx,
  type ToolResult,
} from '../aiTools';

// Fixed clock: Sat Jul 19 2026, noon local.
const NOW = new Date(2026, 6, 19, 12).getTime();

const at = (y: number, m: number, d: number): number => new Date(y, m, d, 10).getTime();

let seq = 0;
const makeExpense = (over: Partial<Expense> & Pick<Expense, 'title' | 'amount' | 'category' | 'paidBy' | 'createdAt'>): Expense => ({
  expenseId: `e${++seq}`,
  groupId: 'g1',
  splitType: 'equal',
  participants: [],
  settled: false,
  updatedAt: over.createdAt,
  ...over,
});

const share = (userId: string, amount: number) => ({ userId, share: amount });

// Members: Chan (current user), Sam Lee + Samir (ambiguous "Sam"), Maya.
const members = [
  { userId: 'u1', displayName: 'Chan' },
  { userId: 'u2', displayName: 'Sam Lee' },
  { userId: 'u3', displayName: 'Samir' },
  { userId: 'u4', displayName: 'Maya' },
];

const expenses: Expense[] = [
  makeExpense({
    title: 'Walmart groceries', amount: 120, category: 'Food', paidBy: 'u1',
    createdAt: at(2026, 6, 5),
    participants: [share('u1', 30), share('u2', 30), share('u3', 30), share('u4', 30)],
    receipt: { insights: { savings: 7 } } as Expense['receipt'],
  }),
  makeExpense({
    title: 'Uber airport', amount: 40, category: 'Transport', paidBy: 'u2',
    createdAt: at(2026, 6, 10),
    participants: [share('u1', 20), share('u2', 20)],
  }),
  makeExpense({
    title: 'Costco run', amount: 200, category: 'Food', paidBy: 'u4',
    createdAt: at(2026, 5, 15),
    participants: [share('u1', 50), share('u2', 50), share('u3', 50), share('u4', 50)],
  }),
  makeExpense({
    title: 'April dinner', amount: 80, category: 'Food', paidBy: 'u1',
    createdAt: at(2026, 3, 12),
    participants: [share('u1', 20), share('u2', 20), share('u3', 20), share('u4', 20)],
  }),
  makeExpense({
    title: 'Gas', amount: 45, category: 'Transport', paidBy: 'u3',
    createdAt: at(2026, 3, 20),
    participants: [share('u1', 22.5), share('u3', 22.5)],
  }),
  // Settlement-category rows are non-spend and must stay out of aggregates.
  makeExpense({
    title: 'Recorded payment', amount: 10, category: 'settlement', paidBy: 'u2',
    createdAt: at(2026, 6, 11),
    participants: [share('u1', 10)],
  }),
];

const settlements: Settlement[] = [
  { settlementId: 's1', fromUserId: 'u2', toUserId: 'u1', amount: 15, createdAt: at(2026, 5, 20), status: 'completed' },
];

const groupCtx = (): ToolCtx => ({
  now: NOW,
  currentUserId: 'u1',
  group: {
    groupId: 'g1',
    name: 'Flat 42',
    currency: 'USD',
    members,
    expenses,
    settlements,
    budgets: { Food: 300 },
    updatedAt: NOW,
  },
});

const run = async (
  req: Parameters<typeof executeToolRequests>[0][number],
  ctx = groupCtx(),
): Promise<ToolResult> => {
  const [result] = await executeToolRequests([req], ctx, new Set());
  return result;
};

const json = (r: ToolResult): Record<string, unknown> => JSON.parse(r.json);

describe('resolvePeriod', () => {
  it('resolves bare month names to the most recent occurrence (doc-17 #3)', async () => {
    const p = resolvePeriod('april', NOW);
    expect(p?.label).toBe('April 2026');
    expect(new Date(p!.tf.startMs).getMonth()).toBe(3);
  });

  it('handles possessive/trailing forms and short names', async () => {
    expect(resolvePeriod("april's", NOW)?.label).toBe('April 2026');
    expect(resolvePeriod('apr', NOW)?.label).toBe('April 2026');
  });

  it('future months without a year roll back a year', async () => {
    expect(resolvePeriod('december', NOW)?.label).toBe('December 2025');
  });

  it('parses explicit years, iso months, and relative phrases', async () => {
    expect(resolvePeriod('april 2025', NOW)?.label).toBe('April 2025');
    expect(resolvePeriod('2026-04', NOW)?.label).toBe('April 2026');
    expect(resolvePeriod('last month', NOW)?.label).toBe('June 2026');
    expect(resolvePeriod('2025', NOW)?.label).toBe('2025');
    expect(resolvePeriod('2 months ago', NOW)?.label).toBe('May 2026');
    expect(resolvePeriod('this year', NOW)?.label).toBe('2026');
  });

  it('returns null for empty/garbage', async () => {
    expect(resolvePeriod('', NOW)).toBeNull();
    expect(resolvePeriod('banana', NOW)).toBeNull();
  });
});

describe('resolveMember', () => {
  it('returns both Sams as candidates for "sam" (clarify fuel)', async () => {
    const m = resolveMember('sam', members);
    expect(m.matched).toBeNull();
    expect(m.candidates.sort()).toEqual(['Sam Lee', 'Samir']);
  });

  it('resolves unique prefixes and exact names', async () => {
    expect(resolveMember('maya', members).matched?.userId).toBe('u4');
    expect(resolveMember('Sam Lee', members).matched?.userId).toBe('u2');
    expect(resolveMember('samir', members).matched?.userId).toBe('u3');
  });
});

describe('graph tools — exact numbers', () => {
  it('month_summary("april") — the doc-17 screenshot case', async () => {
    const r = await run({ tool: 'month_summary', month: 'april' });
    const p = json(r);
    expect(p.month).toBe('April 2026');
    expect(p.total).toBe(125); // 80 dinner + 45 gas
    expect(p.count).toBe(2);
    expect(p.yourShare).toBe(42.5); // 20 + 22.5
    expect((p.topCategories as { c: string; t: number }[])[0]).toEqual({ c: 'Food', t: 80 });
    expect((p.prevMonth as { total: number }).total).toBe(0); // March empty
  });

  it('range_totals for June credits Maya as payer', async () => {
    const p = json(await run({ tool: 'range_totals', month: 'june 2026' }));
    expect(p.total).toBe(200);
    const maya = (p.perMember as { name: string; paid: number }[]).find((m) => m.name === 'Maya');
    expect(maya?.paid).toBe(200);
  });

  it('range_totals all-time excludes the settlement-category row', async () => {
    const p = json(await run({ tool: 'range_totals' }));
    expect(p.total).toBe(485); // 120+40+200+80+45
    expect(p.count).toBe(5);
  });

  it('compare_ranges july vs june', async () => {
    const p = json(await run({ tool: 'compare_ranges', month: 'july', monthB: 'june' }));
    expect(p.deltaTotal).toBe(-40); // 160 vs 200
    expect((p['July 2026'] as { total: number }).total).toBe(160);
    expect((p['June 2026'] as { total: number }).total).toBe(200);
  });

  it('member_stats("sam") surfaces ambiguity as data', async () => {
    const p = json(await run({ tool: 'member_stats', member: 'sam' }));
    expect((p.ambiguous as string[]).sort()).toEqual(['Sam Lee', 'Samir']);
  });

  it('member_stats("maya") — paid, share, pairwise vs you', async () => {
    const p = json(await run({ tool: 'member_stats', member: 'maya' }));
    expect(p.paid).toBe(200);
    expect(p.share).toBe(100); // 30 + 50 + 20
    // You owe her your Costco share (50); she owes your Walmart+dinner shares (50).
    expect(p.youOweThem).toBe(0);
    expect(p.theyOweYou).toBe(0);
  });

  it('merchant_stats fuzzy-matches Walmart with savings', async () => {
    const p = json(await run({ tool: 'merchant_stats', merchant: 'walmart' }));
    expect(p.merchant).toBe('Walmart groceries');
    expect(p.total).toBe(120);
    expect(p.visits).toBe(1);
    expect(p.savings).toBe(7);
  });

  // Regression test for a confirmed bug (ui-revamp branch review):
  // merchantAggregate groups strictly by exact lowercased title, so
  // "Walmart" and "Walmart groceries" are separate rows with independent
  // totals — but merchant_stats' "recent" list re-filters with a
  // bidirectional substring match against the matched title, which pulls
  // rows from the OTHER exact-title group back in. total/visits stay
  // correct for the matched group; "recent" silently disagrees with them.
  // Expected to FAIL until the "recent" filter matches on the same
  // exact-title key merchantAggregate used, not a substring.
  it('BUG: merchant_stats "recent" can include expenses from a different exact-title group', async () => {
    const collision = makeExpense({
      title: 'Walmart', amount: 10, category: 'Food', paidBy: 'u1',
      createdAt: at(2026, 6, 15),
      participants: [share('u1', 10)],
    });
    const ctx: ToolCtx = { ...groupCtx(), group: { ...groupCtx().group!, expenses: [...expenses, collision] } };
    const p = json(await run({ tool: 'merchant_stats', merchant: 'walmart' }, ctx));

    expect(p.merchant).toBe('Walmart groceries');
    expect(p.total).toBe(120);
    expect(p.visits).toBe(1);

    const recent = p.recent as { title: string }[];
    expect(recent.map((r) => r.title)).toEqual(['Walmart groceries']);
  });

  it('top_expenses ranks by amount', async () => {
    const p = json(await run({ tool: 'top_expenses', n: 2 }));
    const rows = p.rows as { title: string; amount: number }[];
    expect(rows.map((r) => r.title)).toEqual(['Costco run', 'Walmart groceries']);
  });

  it('search_expenses sums matches', async () => {
    const p = json(await run({ tool: 'search_expenses', query: 'walmart' }));
    expect(p.matches).toBe(1);
    expect(p.sum).toBe(120);
  });

  it('category_trail covers every month in the span, including zeros', async () => {
    const p = json(await run({ tool: 'category_trail', category: 'food', months: 4 }));
    const byMonth = p.byMonth as { month: string; total: number }[];
    expect(byMonth.map((m) => m.total)).toEqual([80, 0, 200, 120]); // Apr..Jul
    expect(p.category).toBe('Food');
  });

  it('budgets: July Food spend vs the 300 budget', async () => {
    const p = json(await run({ tool: 'budgets' }));
    const rows = p.rows as { category: string; budget: number; spent: number; pct: number }[];
    expect(rows[0]).toMatchObject({ category: 'Food', budget: 300, spent: 120, pct: 40 });
  });

  it('balances: nets sum to ~0 and yours matches your row', async () => {
    const p = json(await run({ tool: 'balances' }));
    const rows = p.perMember as { name: string; net: number }[];
    const sum = rows.reduce((s, r) => s + r.net, 0);
    expect(Math.abs(sum)).toBeLessThan(0.02);
    expect(p.yourBalance).toBe(rows.find((r) => r.name === 'Chan')?.net);
  });

  it('settle_plan transfers use display names', async () => {
    const p = json(await run({ tool: 'settle_plan' }));
    const transfers = p.transfers as { from: string; to: string; amount: number }[];
    expect(transfers.length).toBeGreaterThan(0);
    for (const t of transfers) {
      expect(members.map((m) => m.displayName)).toContain(t.from);
      expect(members.map((m) => m.displayName)).toContain(t.to);
    }
  });

  it('forecast projects from month-to-date', async () => {
    const p = json(await run({ tool: 'forecast' }));
    expect(p.monthToDate).toBe(160);
    expect(p.previousMonthTotal).toBe(200);
    expect(p.projectedTotal).toBeGreaterThan(160);
  });
});

describe('personal tools', () => {
  const personalCtx: ToolCtx = {
    now: NOW,
    currentUserId: 'u1',
    personalGroups: [
      { groupId: 'g1', name: 'Flat 42', currency: 'USD', expenses },
      {
        groupId: 'g2', name: 'Goa Trip', currency: 'INR',
        expenses: [
          makeExpense({
            title: 'Beach shack', amount: 3000, category: 'Food', paidBy: 'u9',
            createdAt: at(2026, 6, 2), groupId: 'g2',
            participants: [share('u1', 1500), share('u9', 1500)],
          }),
        ],
      },
    ],
  };

  it('group_compare keeps currencies separate', async () => {
    const [r] = await executeToolRequests([{ tool: 'group_compare', month: 'july' }], personalCtx, new Set());
    const p = JSON.parse(r.json) as { groups: { name: string; yourShare: number; currency: string }[] };
    expect(p.groups.find((g) => g.name === 'Goa Trip')).toMatchObject({ yourShare: 1500, currency: 'INR' });
    expect(p.groups.find((g) => g.name === 'Flat 42')).toMatchObject({ yourShare: 50, currency: 'USD' });
  });

  it('scope gating: group tools absent for personal ctx and vice versa', async () => {
    expect(availableTools(personalCtx).sort()).toEqual(['entity_lookup', 'group_compare', 'personal_overview']);
    expect(availableTools(groupCtx())).not.toContain('personal_overview');
    expect(toolCatalog(personalCtx)).toContain('personal_overview');
    expect(toolCatalog(personalCtx)).not.toContain('month_summary');
  });
});

describe('local-tier tools (doc 24 P5)', () => {
  const localCtx = (): ToolCtx => ({
    ...groupCtx(),
    chatSearch: async (query) => ({
      matches: 2,
      rows: [
        { text: `we said the ${query} was 120`, from: 'Maya', date: 'Jul 5' },
        { text: `ok booking the ${query}`, from: 'Chan', date: 'Jul 6' },
      ],
    }),
    callStats: async () => ({ calls: 3, totalMinutes: 42, missed: 1, lastCall: 'Jul 18' }),
  });

  it('chat_search returns capped snippets from the provider', async () => {
    const p = json(await run({ tool: 'chat_search', query: 'hotel' }, localCtx()));
    expect(p.matches).toBe(2);
    expect((p.rows as { from: string }[])[0].from).toBe('Maya');
  });

  it('call_stats returns the provider aggregate', async () => {
    const p = json(await run({ tool: 'call_stats' }, localCtx()));
    expect(p).toMatchObject({ calls: 3, totalMinutes: 42, missed: 1, lastCall: 'Jul 18' });
  });

  it('entity_lookup fuzzy-resolves members and merchants (graph tier)', async () => {
    const p = json(await run({ tool: 'entity_lookup', query: 'sam' }));
    const rows = p.rows as { type: string; name: string }[];
    expect(rows.filter((r) => r.type === 'member').map((r) => r.name).sort()).toEqual(['Sam Lee', 'Samir']);
  });

  it('local tools vanish without providers and under the PCC filter', async () => {
    expect(availableTools(groupCtx())).not.toContain('chat_search'); // no provider
    expect(availableTools(localCtx())).toContain('chat_search');
    expect(availableTools(localCtx(), { includeLocal: false })).not.toContain('chat_search');
    expect(availableTools(localCtx(), { includeLocal: false })).not.toContain('call_stats');
    expect(availableTools(localCtx(), { includeLocal: false })).toContain('entity_lookup');
    expect(toolCatalog(localCtx(), { includeLocal: false })).not.toContain('chat_search');
  });

  it('entity fixes rewrite member args before resolution (doc 25 Q2)', async () => {
    const ctx: ToolCtx = { ...groupCtx(), entityFixes: { sam: 'Sam Lee' } };
    const p = json(await run({ tool: 'member_stats', member: 'Sam' }, ctx));
    expect(p.ambiguous).toBeUndefined(); // no clarify — the fix resolved it
    expect(p.name).toBe('Sam Lee');
  });

  it('toolTier reports tiers', async () => {
    expect(toolTier('chat_search')).toBe('local');
    expect(toolTier('call_stats')).toBe('local');
    expect(toolTier('balances')).toBe('graph');
    expect(toolTier('nope')).toBeNull();
  });
});

describe('executeToolRequests guards', () => {
  it('dedupes identical requests across hops via seenKeys', async () => {
    const seen = new Set<string>();
    const first = await executeToolRequests([{ tool: 'balances' }], groupCtx(), seen);
    const second = await executeToolRequests([{ tool: 'balances' }], groupCtx(), seen);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('caps a hop at MAX_REQUESTS_PER_HOP', async () => {
    const reqs = ['balances', 'forecast', 'anomalies', 'budgets', 'settle_plan'].map((tool) => ({ tool }));
    const out = await executeToolRequests(reqs, groupCtx(), new Set());
    expect(out).toHaveLength(MAX_REQUESTS_PER_HOP);
  });

  it('unknown tools become error results, not throws', async () => {
    const r = await run({ tool: 'hack_the_planet' });
    expect(r.error).toContain('no tool named');
  });

  it('unresolvable args become error results the model can react to', async () => {
    expect((await run({ tool: 'month_summary', month: 'banana' })).error).toContain('could not resolve month');
    expect((await run({ tool: 'member_stats', member: 'zorp' })).error).toContain('no member matching');
  });

  it('requestKey treats normalized args as identical', async () => {
    expect(requestKey({ tool: 'month_summary', month: 'April' })).toBe(
      requestKey({ tool: 'month_summary', month: 'april' }),
    );
  });
});

describe('presentation helpers', () => {
  it('statusLineFor is concrete', async () => {
    expect(statusLineFor({ tool: 'compare_ranges', month: 'july', monthB: 'june' }, groupCtx())).toBe(
      'Comparing July 2026 vs June 2026…',
    );
    expect(statusLineFor({ tool: 'month_summary', month: 'april' }, groupCtx())).toBe('Pulling April 2026…');
  });

  it('toolResultsBlock numbers results', async () => {
    const block = toolResultsBlock([await run({ tool: 'balances' }), await run({ tool: 'forecast' })]);
    expect(block).toMatch(/^T1 balances:/);
    expect(block).toContain('T2 forecast:');
  });
});
