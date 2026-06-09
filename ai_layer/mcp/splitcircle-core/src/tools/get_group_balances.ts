/**
 * get_group_balances — net balances for every member of a group.
 * Read-only. Uses the ported balance math so figures match the app exactly.
 */

import { z } from 'zod';
import type { Tool } from '../lib/tool.js';
import { calculateBalances, toBalanceView } from '../lib/balances.js';

const inputSchema = z.object({
  groupId: z.string().describe('Group the user belongs to'),
});

export const getGroupBalances: Tool<typeof inputSchema> = {
  name: 'get_group_balances',
  title: 'Get Group Balances',
  description: 'Compute per-member net balances (who owes / is owed) for a group.',
  inputSchema,
  annotations: { readOnlyHint: true },
  async handler(args, ctx) {
    const group = await ctx.data.getGroup(ctx.uid, args.groupId);
    const balances = calculateBalances(group.expenses, group.settlements);
    const view = toBalanceView(balances);
    const nameById = Object.fromEntries(group.members.map((m) => [m.userId, m.displayName]));
    const enriched = view.map((b) => ({ ...b, displayName: nameById[b.userId] ?? b.userId }));
    return {
      data: { groupId: args.groupId, currency: group.currency, balances: enriched },
      text: `Computed balances for ${enriched.length} member(s) in ${group.name}.`,
    };
  },
};
