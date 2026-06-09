/**
 * get_user_groups — all groups the user belongs to, with a balance summary each.
 * Read-only.
 */

import { z } from 'zod';
import type { Tool } from '../lib/tool.js';
import { calculateBalances } from '../lib/balances.js';

const inputSchema = z.object({}).describe('No parameters — scoped to the authenticated user.');

export const getUserGroups: Tool<typeof inputSchema> = {
  name: 'get_user_groups',
  title: 'Get User Groups',
  description: "List the authenticated user's groups with their net balance in each.",
  inputSchema,
  annotations: { readOnlyHint: true },
  async handler(_args, ctx) {
    const groups = await ctx.data.getUserGroups(ctx.uid);
    const summary = groups.map((g) => {
      const balances = calculateBalances(g.expenses, g.settlements);
      const myNet = Number((balances[ctx.uid] ?? 0).toFixed(2));
      return {
        groupId: g.groupId,
        name: g.name,
        currency: g.currency,
        memberCount: g.members.length,
        expenseCount: g.expenses.length,
        myNetBalance: myNet,
        status: myNet > 0.01 ? 'owed' : myNet < -0.01 ? 'owes' : 'settled',
      };
    });
    return { data: { groups: summary }, text: `You belong to ${summary.length} group(s).` };
  },
};
