/**
 * search_expenses — natural-language semantic search over the user's expenses.
 * Read-only. Delegates to the RAG service (falls back to substring scan if RAG is
 * not configured). Returns both the matching expenses and a grounded answer.
 */

import { z } from 'zod';
import type { Tool } from '../lib/tool.js';

const inputSchema = z.object({
  query: z.string().min(1).describe('Natural-language question, e.g. "dinner with Sam in May"'),
  groupId: z.string().optional(),
  limit: z.number().int().positive().max(50).default(10),
});

export const searchExpenses: Tool<typeof inputSchema> = {
  name: 'search_expenses',
  title: 'Search Expenses',
  description: 'Semantic search over the user\'s expenses; returns matches and a grounded, cited answer.',
  inputSchema,
  annotations: { readOnlyHint: true },
  async handler(args, ctx) {
    const hit = await ctx.data.searchExpenses(ctx.uid, args.query, args.groupId, args.limit);
    return {
      data: { results: hit.results, answer: hit.answer },
      text: hit.answer,
    };
  },
};
