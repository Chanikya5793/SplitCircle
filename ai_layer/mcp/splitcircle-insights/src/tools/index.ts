/**
 * tools/index.ts — splitcircle-insights tool registry.
 * All read-only spending-intelligence tools.
 */

import { z } from 'zod';
import type { Tool } from '../lib/tool.js';
import {
  summarize, comparePeriods, findAnomalies, contributionAnalysis, periodWindow,
  forecastHeadline, type Period,
} from '../lib/aggregate.js';

const periodEnum = z.enum(['week', 'month', 'quarter', 'year']);

export const getSpendingSummary: Tool = {
  name: 'get_spending_summary',
  title: 'Get Spending Summary',
  description: "Summarize the user's spending for a period: total, by-category, top expenses, trend.",
  inputSchema: z.object({ period: periodEnum.default('month'), groupId: z.string().optional() }),
  annotations: { readOnlyHint: true },
  async handler(args, ctx) {
    const { start, end } = periodWindow(args.period as Period);
    const rows = await ctx.analytics.getUserRows(ctx.uid, start, end, args.groupId);
    // Trend: compare to the immediately preceding window.
    const prev = await ctx.analytics.getUserRows(ctx.uid, start - (end - start), start, args.groupId);
    const cmp = comparePeriods(prev, rows);
    const summary = summarize(rows);
    return {
      data: { period: args.period, ...summary, trend: cmp.trend },
      text: `You spent ${summary.total} across ${summary.count} expense(s) this ${args.period} (trend: ${cmp.trend}).`,
    };
  },
};

export const compareSpendingPeriods: Tool = {
  name: 'compare_spending_periods',
  title: 'Compare Spending Periods',
  description: 'Compare two consecutive periods and explain the change in plain language.',
  inputSchema: z.object({ period: periodEnum.default('month'), groupId: z.string().optional() }),
  annotations: { readOnlyHint: true },
  async handler(args, ctx) {
    const { start, end } = periodWindow(args.period as Period);
    const current = await ctx.analytics.getUserRows(ctx.uid, start, end, args.groupId);
    const previous = await ctx.analytics.getUserRows(ctx.uid, start - (end - start), start, args.groupId);
    const cmp = comparePeriods(previous, current);
    const insight = await ctx.analytics.generateInsight(
      `User spending went from ${cmp.total1} to ${cmp.total2} (${cmp.deltaPercent}% ${cmp.trend}). ` +
      `Category deltas: ${JSON.stringify(cmp.categoryBreakdown)}. Write one concise, friendly sentence.`,
    );
    return { data: { ...cmp, insight }, text: insight };
  },
};

export const findUnusualExpenses: Tool = {
  name: 'find_unusual_expenses',
  title: 'Find Unusual Expenses',
  description: 'Flag expenses that are statistical outliers vs. the user\'s own category baseline.',
  inputSchema: z.object({ lookbackDays: z.number().int().positive().max(365).default(30), groupId: z.string().optional() }),
  annotations: { readOnlyHint: true },
  async handler(args, ctx) {
    const end = Date.now();
    const start = end - args.lookbackDays * 86_400_000;
    const rows = await ctx.analytics.getUserRows(ctx.uid, start, end, args.groupId);
    const anomalies = findAnomalies(rows);
    return {
      data: { anomalies },
      text: anomalies.length === 0 ? 'Nothing unusual in that window.' : `Found ${anomalies.length} unusual expense(s).`,
    };
  },
};

export const askAboutSpending: Tool = {
  name: 'ask_about_spending',
  title: 'Ask About Spending',
  description: 'Answer a natural-language question about the user\'s spending, grounded in their expenses.',
  inputSchema: z.object({ question: z.string().min(1), groupId: z.string().optional() }),
  annotations: { readOnlyHint: true },
  async handler(args, ctx) {
    const res = await ctx.analytics.ask(ctx.uid, args.question, args.groupId);
    return { data: { answer: res.answer, sources: res.sources }, text: res.answer };
  },
};

export const getGroupContributionAnalysis: Tool = {
  name: 'get_group_contribution_analysis',
  title: 'Get Group Contribution Analysis',
  description: 'Per-member paid vs. owed vs. fair share for a group.',
  inputSchema: z.object({ groupId: z.string() }),
  annotations: { readOnlyHint: true },
  async handler(args, ctx) {
    const { memberIds, expenses } = await ctx.analytics.getGroupExpenses(ctx.uid, args.groupId);
    const members = contributionAnalysis(expenses, memberIds);
    return { data: { groupId: args.groupId, members }, text: `Contribution analysis for ${members.length} member(s).` };
  },
};

export const getSpendingForecast: Tool = {
  name: 'get_spending_forecast',
  title: 'Get Spending Forecast',
  description: "Forecast the user's monthly spending for the next few months (MODEL-02, ARIMA_PLUS).",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true },
  async handler(_args, ctx) {
    const points = await ctx.analytics.forecastSpending(ctx.uid);
    return { data: { forecast: points }, text: forecastHeadline(points) };
  },
};

export const tools: Tool<any>[] = [
  getSpendingSummary,
  compareSpendingPeriods,
  findUnusualExpenses,
  askAboutSpending,
  getGroupContributionAnalysis,
  getSpendingForecast,
];
