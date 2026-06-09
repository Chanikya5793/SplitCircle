/**
 * analytics.ts — DI boundary for splitcircle-insights.
 *
 * In production these are backed by BigQuery (`splitcircle_ml`), the RAG service,
 * and Gemini. Tools depend on this interface so they are unit-testable with fakes
 * (Critical Rule #7). All queries are scoped by the authenticated uid.
 */

import type { ExpenseRow, GroupExpense } from './aggregate.js';

export interface RagAnswer { answer: string; sources: ExpenseRow[] }

export interface Analytics {
  /** Rows attributed to the user (userShare) in a time window. */
  getUserRows(uid: string, start: number, end: number, groupId?: string): Promise<ExpenseRow[]>;
  /** Full group expenses (for contribution analysis); enforces membership. */
  getGroupExpenses(uid: string, groupId: string): Promise<{ memberIds: string[]; expenses: GroupExpense[]; currency: string }>;
  /** RAG-backed NL question over the user's expenses. */
  ask(uid: string, question: string, groupId?: string): Promise<RagAnswer>;
  /** Gemini one-liner insight from a compact stats payload (NL polish). */
  generateInsight(prompt: string): Promise<string>;
}

export interface InsightsToolContext {
  uid: string;
  analytics: Analytics;
}
