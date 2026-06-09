/**
 * get_recent_activity — a merged, time-sorted feed of recent expenses + settlements.
 * Read-only. Reconstructs an activity feed from the embedded arrays (Phase 1 notes
 * there is no stored activity feed today).
 */

import { z } from 'zod';
import type { Tool } from '../lib/tool.js';

const inputSchema = z.object({
  groupId: z.string().optional(),
  limit: z.number().int().positive().max(100).default(20),
});

interface ActivityItem {
  type: 'expense' | 'settlement';
  id: string;
  groupId: string;
  summary: string;
  amount: number;
  currency: string;
  at: number;
}

export const getRecentActivity: Tool<typeof inputSchema> = {
  name: 'get_recent_activity',
  title: 'Get Recent Activity',
  description: 'Recent expenses and settlements across the user\'s groups, newest first.',
  inputSchema,
  annotations: { readOnlyHint: true },
  async handler(args, ctx) {
    const groups = args.groupId
      ? [await ctx.data.getGroup(ctx.uid, args.groupId)]
      : await ctx.data.getUserGroups(ctx.uid);

    const items: ActivityItem[] = [];
    for (const g of groups) {
      const nameById = Object.fromEntries(g.members.map((m) => [m.userId, m.displayName]));
      for (const e of g.expenses) {
        items.push({
          type: 'expense', id: e.expenseId, groupId: g.groupId,
          summary: `${nameById[e.paidBy] ?? 'Someone'} added "${e.title}"`,
          amount: e.amount, currency: g.currency, at: e.createdAt,
        });
      }
      for (const s of g.settlements) {
        items.push({
          type: 'settlement', id: s.settlementId, groupId: g.groupId,
          summary: `${nameById[s.fromUserId] ?? 'Someone'} paid ${nameById[s.toUserId] ?? 'someone'}`,
          amount: s.amount, currency: g.currency, at: s.createdAt,
        });
      }
    }
    items.sort((a, b) => b.at - a.at);
    const sliced = items.slice(0, args.limit);
    return { data: { activity: sliced }, text: `${sliced.length} recent activity item(s).` };
  },
};
