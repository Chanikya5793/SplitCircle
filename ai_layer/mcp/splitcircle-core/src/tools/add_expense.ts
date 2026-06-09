/**
 * add_expense — create an expense in a group (the only WRITE tool here).
 *
 * Per MCP spec + Critical Rules, this is flagged non-readonly/non-destructive and
 * idempotent (via `requestId`); clients SHOULD require human confirmation before
 * invoking. Validates that `paidBy` and all participants are members of the group,
 * and that participant shares sum to the amount (within a cent).
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Tool } from '../lib/tool.js';
import type { Expense } from '../lib/types.js';

const inputSchema = z.object({
  groupId: z.string(),
  title: z.string().min(1),
  amount: z.number().positive(),
  paidBy: z.string().describe('Member userId who paid'),
  participants: z.array(z.object({ userId: z.string(), share: z.number().nonnegative() })).min(1),
  splitType: z.enum(['equal', 'percentage', 'shares', 'custom']).default('equal'),
  category: z.string().default('uncategorized'),
  date: z.string().optional().describe('ISO date; defaults to now'),
  notes: z.string().optional(),
  requestId: z.string().optional().describe('Idempotency key; pass to avoid duplicates on retry'),
});

export const addExpense: Tool<typeof inputSchema> = {
  name: 'add_expense',
  title: 'Add Expense',
  description: 'Create a new expense in a group. Requires human confirmation (write action).',
  inputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async handler(args, ctx) {
    const group = await ctx.data.getGroup(ctx.uid, args.groupId); // also enforces membership

    const memberIds = new Set(group.memberIds ?? group.members.map((m) => m.userId));
    if (!memberIds.has(args.paidBy)) {
      throw new Error(`paidBy ${args.paidBy} is not a member of this group`);
    }
    for (const p of args.participants) {
      if (!memberIds.has(p.userId)) throw new Error(`participant ${p.userId} is not a member of this group`);
    }
    const shareSum = args.participants.reduce((s, p) => s + p.share, 0);
    if (Math.abs(shareSum - args.amount) > 0.01) {
      throw new Error(`participant shares (${shareSum.toFixed(2)}) must sum to amount (${args.amount.toFixed(2)})`);
    }

    const createdAt = args.date ? Date.parse(args.date) : Date.now();
    const expense: Expense = {
      expenseId: randomUUID(),
      requestId: args.requestId,
      groupId: args.groupId,
      title: args.title,
      category: args.category,
      amount: args.amount,
      paidBy: args.paidBy,
      splitType: args.splitType,
      participants: args.participants,
      settled: false,
      notes: args.notes,
      createdAt,
      updatedAt: createdAt,
    };

    const saved = await ctx.data.addExpense(ctx.uid, args.groupId, expense);
    return { data: { expenseId: saved.expenseId, expense: saved }, text: `Added "${saved.title}" (${group.currency}${saved.amount.toFixed(2)}).` };
  },
};
