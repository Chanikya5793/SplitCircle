/**
 * expenseQuery.ts — deterministic natural-language answerer for the Ask AI
 * assistant. Classifies the common questions (spend by category, balances,
 * settle-up, biggest, totals, count, summary) and answers them with EXACT
 * numbers computed from the on-device data — no LLM, so no arithmetic mistakes,
 * works on every device, instant and offline.
 *
 * Open-ended questions return `handled: false` so the caller can fall back to
 * the grounded on-device LLM. Pure module — no RN/native imports (unit-tested).
 */

import type { Expense } from '@/models/expense';
import type { Settlement } from '@/models/group';
import {
  buildExpenseAnalytics,
  inTimeframe,
  parseTimeframe,
  sumTotal,
  sumUserShare,
  userShareOf,
  type Timeframe,
} from './expenseAnalytics';

export interface QueryMember {
  userId: string;
  displayName: string;
}

export interface QueryContext {
  expenses: readonly Expense[];
  settlements: readonly Settlement[];
  members: readonly QueryMember[];
  currentUserId: string;
  currency: string;
  /** Injectable for deterministic timeframe tests. */
  now?: number;
}

export interface QuerySource {
  expenseId: string;
  groupId: string;
  title?: string;
  category?: string;
  amount: number;
  currency?: string;
  paidByName?: string;
  createdAt?: number;
}

export interface QueryResult {
  handled: boolean;
  answer: string;
  sources: QuerySource[];
  confidence: number;
}

const NOT_HANDLED: QueryResult = { handled: false, answer: '', sources: [], confidence: 0 };

const MAX_SOURCES = 8;

// Canonical category → words that imply it (improves recall for "food", "gas"…).
const CATEGORY_SYNONYMS: Record<string, string[]> = {
  Food: ['food', 'dinner', 'lunch', 'breakfast', 'restaurant', 'restaurants', 'eat', 'eating', 'groceries', 'grocery', 'meal', 'meals', 'snack', 'snacks', 'dining', 'coffee'],
  Transport: ['transport', 'transportation', 'gas', 'fuel', 'uber', 'lyft', 'taxi', 'cab', 'commute', 'train', 'bus', 'parking'],
  Utilities: ['utilities', 'utility', 'electric', 'electricity', 'water', 'internet', 'wifi'],
  Entertainment: ['entertainment', 'movie', 'movies', 'cinema', 'concert', 'netflix', 'spotify', 'game', 'games'],
  Shopping: ['shopping', 'shop', 'clothes', 'clothing', 'amazon'],
  Travel: ['travel', 'trip', 'flight', 'flights', 'hotel', 'hotels', 'airbnb', 'vacation'],
  Health: ['health', 'medical', 'doctor', 'pharmacy', 'medicine', 'gym', 'fitness'],
};

const money = (n: number, currency: string): string => `${n.toFixed(2)} ${currency}`;

const lc = (s: string): string => (s ?? '').toLowerCase();

const wordIn = (haystack: string, word: string): boolean =>
  new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(haystack);

/** Resolve a member's display name (first name kept) or a friendly fallback. */
const nameOf = (members: readonly QueryMember[], userId: string, selfId: string): string => {
  if (userId === selfId) return 'You';
  return members.find((m) => m.userId === userId)?.displayName ?? 'Someone';
};

/** True when the question is scoped to the current user ("I", "my", "me"). */
const isUserScoped = (q: string): boolean => /\b(i|me|my|mine)\b/i.test(q);

/** Detect a category mentioned in the question, preferring categories present in data. */
function detectCategory(q: string, expenses: readonly Expense[]): string | null {
  const present = new Map<string, string>(); // lc → original casing
  for (const e of expenses) {
    const c = (e.category ?? '').trim();
    if (c) present.set(lc(c), c);
  }
  // 1) Direct mention of a present category name.
  for (const [low, orig] of present) {
    if (low && wordIn(q, low)) return orig;
  }
  // 2) Synonym → canonical category (return present casing if we have it).
  for (const [canonical, syns] of Object.entries(CATEGORY_SYNONYMS)) {
    if (wordIn(q, canonical) || syns.some((s) => wordIn(q, s))) {
      return present.get(lc(canonical)) ?? canonical;
    }
  }
  return null;
}

const toSource = (e: Expense, ctx: QueryContext): QuerySource => ({
  expenseId: e.expenseId,
  groupId: e.groupId,
  title: e.title,
  category: e.category,
  amount: e.amount,
  currency: ctx.currency,
  paidByName: ctx.members.find((m) => m.userId === e.paidBy)?.displayName,
  createdAt: e.createdAt,
});

const topSources = (expenses: readonly Expense[], ctx: QueryContext): QuerySource[] =>
  [...expenses].sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, MAX_SOURCES).map((e) => toSource(e, ctx));

const tfSuffix = (tf: Timeframe | null): string => (tf ? ` ${tf.label}` : '');

/**
 * Try to answer `question` deterministically. Returns `handled: false` for
 * open-ended questions the caller should route to the LLM.
 */
export function answerExpenseQuery(question: string, ctx: QueryContext): QueryResult {
  const q = (question ?? '').trim();
  if (!q) return NOT_HANDLED;
  const tf = parseTimeframe(q, ctx.now);
  const scoped = inTimeframe; // alias
  const inTf = (e: Expense) => scoped(e, tf);
  const currency = ctx.currency || 'USD';

  // ── Settle-up plan ("settlements", "who owes whom", "settle up") ──
  if (/\bsettle( ?up)?\b|\bsettlements?\b|who owes who/i.test(q)) {
    const analytics = buildExpenseAnalytics(ctx.expenses, ctx.settlements, ctx.currentUserId);
    if (analytics.debts.length === 0) {
      return { handled: true, answer: "Everyone's settled up — no payments needed. 🎉", sources: [], confidence: 1 };
    }
    const lines = analytics.debts.map(
      (d) => `• ${nameOf(ctx.members, d.from, ctx.currentUserId)} → ${nameOf(ctx.members, d.to, ctx.currentUserId)}: ${money(d.amount, currency)}`,
    );
    return {
      handled: true,
      answer: `Suggested settle-up (${analytics.debts.length} payment${analytics.debts.length > 1 ? 's' : ''}):\n${lines.join('\n')}`,
      sources: [],
      confidence: 1,
    };
  }

  // ── Balance / owe ("how much do I owe", "what's my balance", "am I even") ──
  if (/\bowe[ds]?\b|\bbalance\b|settled up\?|\beven\b/i.test(q)) {
    const analytics = buildExpenseAnalytics(ctx.expenses, ctx.settlements, ctx.currentUserId);
    const bal = analytics.userBalance;
    if (Math.abs(bal) < 0.01) {
      return { handled: true, answer: "You're all settled up — you don't owe anything and nothing's owed to you.", sources: [], confidence: 1 };
    }
    if (bal < 0) {
      const yourDebts = analytics.debts.filter((d) => d.from === ctx.currentUserId);
      const breakdown = yourDebts.map((d) => `• You owe ${nameOf(ctx.members, d.to, ctx.currentUserId)} ${money(d.amount, currency)}`);
      return {
        handled: true,
        answer: `You owe ${money(Math.abs(bal), currency)} overall.${breakdown.length ? `\n${breakdown.join('\n')}` : ''}`,
        sources: [],
        confidence: 1,
      };
    }
    const owedToYou = analytics.debts.filter((d) => d.to === ctx.currentUserId);
    const breakdown = owedToYou.map((d) => `• ${nameOf(ctx.members, d.from, ctx.currentUserId)} owes you ${money(d.amount, currency)}`);
    return {
      handled: true,
      answer: `You're owed ${money(bal, currency)} overall.${breakdown.length ? `\n${breakdown.join('\n')}` : ''}`,
      sources: [],
      confidence: 1,
    };
  }

  // ── Biggest / top expenses ──
  if (/\b(biggest|largest|top|most expensive|priciest|highest)\b/i.test(q)) {
    const pool = ctx.expenses.filter((e) => inTf(e));
    const top = [...pool].sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, 5);
    if (top.length === 0) {
      return { handled: true, answer: `No expenses found${tfSuffix(tf)}.`, sources: [], confidence: 1 };
    }
    const lines = top.map((e, i) => `${i + 1}. ${e.title || 'Untitled'} — ${money(e.amount, currency)}${e.category ? ` (${e.category})` : ''}`);
    return {
      handled: true,
      answer: `Biggest expenses${tfSuffix(tf)}:\n${lines.join('\n')}`,
      sources: top.map((e) => toSource(e, ctx)),
      confidence: 1,
    };
  }

  // ── Count ("how many expenses") ──
  if (/how many\b.*\bexpenses?\b|\bnumber of expenses\b/i.test(q)) {
    const pool = ctx.expenses.filter((e) => inTf(e));
    return {
      handled: true,
      answer: `There ${pool.length === 1 ? 'is' : 'are'} ${pool.length} expense${pool.length === 1 ? '' : 's'}${tfSuffix(tf)}.`,
      sources: [],
      confidence: 1,
    };
  }

  // ── Summary / month-in-review (checked before spend/total so "summarize
  // spending" isn't captured by the total intent) ──
  if (/\b(summar(y|ize|ise)|overview|recap|review|breakdown)\b/i.test(q)) {
    const pool = ctx.expenses.filter((e) => inTf(e) && lc(e.category ?? '') !== 'settlement');
    if (pool.length === 0) {
      return { handled: true, answer: `No expenses to summarize${tfSuffix(tf)}.`, sources: [], confidence: 1 };
    }
    const total = sumTotal(pool);
    const userShare = sumUserShare(pool, ctx.currentUserId);
    const catTotals = new Map<string, number>();
    for (const e of pool) {
      const c = (e.category ?? 'General').trim() || 'General';
      catTotals.set(c, (catTotals.get(c) ?? 0) + (e.amount || 0));
    }
    const topCats = [...catTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([c, t]) => `${c} ${money(Math.round(t * 100) / 100, currency)}`);
    const period = tf ? tf.label.replace(/^the /, '') : 'all time';
    return {
      handled: true,
      answer:
        `Summary for ${period}: ${pool.length} expense${pool.length === 1 ? '' : 's'} totaling ${money(total, currency)}` +
        ` (your share ${money(userShare, currency)}).` +
        `\nTop categories: ${topCats.join(', ')}.`,
      sources: topSources(pool, ctx),
      confidence: 1,
    };
  }

  // ── Category spend ("how much did I spend on food", "food spending") ──
  const category = detectCategory(q, ctx.expenses);
  if (category && /\b(spen[dt]|spending|cost|paid|much)\b/i.test(q)) {
    const matching = ctx.expenses.filter((e) => inTf(e) && lc(e.category ?? '') === lc(category));
    const userScoped = isUserScoped(q);
    if (matching.length === 0) {
      return {
        handled: true,
        answer: `No ${category} expenses found${tfSuffix(tf)}.`,
        sources: [],
        confidence: 1,
      };
    }
    const amount = userScoped ? sumUserShare(matching, ctx.currentUserId) : sumTotal(matching);
    const who = userScoped ? 'You spent' : 'The group spent';
    return {
      handled: true,
      answer: `${who} ${money(amount, currency)} on ${category}${tfSuffix(tf)} across ${matching.length} expense${matching.length === 1 ? '' : 's'}.`,
      sources: topSources(matching, ctx),
      confidence: 1,
    };
  }

  // ── Total spend ("how much did we/I spend", "total spending") ──
  if (/\b(spen[dt]|spending|total)\b/i.test(q)) {
    const pool = ctx.expenses.filter((e) => inTf(e));
    if (pool.length === 0) {
      return { handled: true, answer: `No expenses found${tfSuffix(tf)}.`, sources: [], confidence: 1 };
    }
    const userScoped = isUserScoped(q);
    const amount = userScoped ? sumUserShare(pool, ctx.currentUserId) : sumTotal(pool);
    const who = userScoped ? 'Your share of spending' : 'Total spending';
    return {
      handled: true,
      answer: `${who}${tfSuffix(tf)} is ${money(amount, currency)} across ${pool.length} expense${pool.length === 1 ? '' : 's'}.`,
      sources: topSources(pool, ctx),
      confidence: 1,
    };
  }

  return NOT_HANDLED;
}
