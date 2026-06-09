/**
 * get_settlement_suggestions — minimal set of transactions to settle a group.
 * Read-only. Reuses the greedy debt-minimizer (matches the app's algorithm).
 */

import { z } from 'zod';
import type { Tool } from '../lib/tool.js';
import { calculateBalances, minimizeDebts } from '../lib/balances.js';

const inputSchema = z.object({
  groupId: z.string().describe('Group the user belongs to'),
});

export const getSettlementSuggestions: Tool<typeof inputSchema> = {
  name: 'get_settlement_suggestions',
  title: 'Get Settlement Suggestions',
  description: 'Suggest the minimum number of payments that fully settle a group, with names.',
  inputSchema,
  annotations: { readOnlyHint: true },
  async handler(args, ctx) {
    const group = await ctx.data.getGroup(ctx.uid, args.groupId);
    const balances = calculateBalances(group.expenses, group.settlements);
    const debts = minimizeDebts(balances);
    const nameById = Object.fromEntries(group.members.map((m) => [m.userId, m.displayName]));
    const settlements = debts.map((d) => ({
      from: d.from,
      fromName: nameById[d.from] ?? d.from,
      to: d.to,
      toName: nameById[d.to] ?? d.to,
      amount: d.amount,
      currency: group.currency,
    }));
    return {
      data: { groupId: args.groupId, settlements },
      text: settlements.length === 0
        ? 'This group is already settled up.'
        : `${settlements.length} payment(s) will settle the group.`,
    };
  },
};
