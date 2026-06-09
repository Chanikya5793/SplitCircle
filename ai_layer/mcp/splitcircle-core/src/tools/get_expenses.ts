/**
 * get_expenses — list a user's expenses, optionally filtered by group/category/date.
 * Read-only. Scoped to the authenticated uid; only returns expenses from groups
 * the caller belongs to.
 */

import { z } from 'zod';
import type { Tool } from '../lib/tool.js';
import type { Expense } from '../lib/types.js';

const inputSchema = z.object({
  groupId: z.string().optional().describe('Restrict to a single group the user belongs to'),
  limit: z.number().int().positive().max(200).default(50),
  category: z.string().optional(),
  dateRange: z.object({
    start: z.string().describe('ISO date'),
    end: z.string().describe('ISO date'),
  }).optional(),
});

export const getExpenses: Tool<typeof inputSchema> = {
  name: 'get_expenses',
  title: 'Get Expenses',
  description: "List the authenticated user's expenses with optional group, category, and date filters.",
  inputSchema,
  annotations: { readOnlyHint: true },
  async handler(args, ctx) {
    const groups = args.groupId
      ? [await ctx.data.getGroup(ctx.uid, args.groupId)]
      : await ctx.data.getUserGroups(ctx.uid);

    const start = args.dateRange ? Date.parse(args.dateRange.start) : undefined;
    const end = args.dateRange ? Date.parse(args.dateRange.end) : undefined;

    let expenses: Expense[] = groups.flatMap((g) => g.expenses);
    // Only expenses involving the user (payer or participant).
    expenses = expenses.filter((e) => e.paidBy === ctx.uid || e.participants.some((p) => p.userId === ctx.uid));
    if (args.category) expenses = expenses.filter((e) => e.category === args.category);
    if (start !== undefined && end !== undefined) {
      expenses = expenses.filter((e) => e.createdAt >= start && e.createdAt <= end);
    }
    expenses.sort((a, b) => b.createdAt - a.createdAt);
    expenses = expenses.slice(0, args.limit);

    return {
      data: { expenses, count: expenses.length },
      text: `Found ${expenses.length} expense(s).`,
    };
  },
};
