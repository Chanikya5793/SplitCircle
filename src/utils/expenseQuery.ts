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
  comparisonWindows,
  inTimeframe,
  pairwiseNet,
  parseTimeframe,
  sumTotal,
  sumUserShare,
  userShareOf,
  type PeriodUnit,
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

/** What the deterministic assistant can answer — shown for help/unknown questions. */
export const ASSISTANT_CAPABILITIES = [
  "I'm your expense assistant. I can:",
  '',
  '📊 Answer questions (exact, with sources)',
  '• "How much did I spend on food?"',
  '• "How much do I owe Bob?"',
  '• "Show our settle-up"',
  '• "What were our biggest expenses?"',
  '• "Who paid the most last month?"',
  '',
  '✏️ Do things for you (you confirm first)',
  '• "Add $40 for dinner, split with everyone"',
  '• "Settle up with Alex"',
  '• "Delete the gas expense"',
  '• "Open stats"',
  '',
  'If I\'m missing something, I\'ll ask — just tap an option or type your answer.',
].join('\n');

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

interface Target {
  userId: string;
  /** Sentence subject, e.g. "You" or "Bob". */
  subject: string;
}

/** Find a member named in the question (full name or first name), if any. */
function detectMember(q: string, members: readonly QueryMember[]): QueryMember | null {
  for (const m of members) {
    const full = (m.displayName ?? '').trim();
    if (!full) continue;
    const first = full.split(/\s+/)[0];
    if (wordIn(q, full) || (first.length >= 2 && wordIn(q, first))) return m;
  }
  return null;
}

/**
 * Who the question is about: the current user ("I/my"), a named member, or the
 * whole group (null). "I" wins over a name so "how much do I owe Bob" is self.
 */
function resolveTarget(q: string, ctx: QueryContext): Target | null {
  if (isUserScoped(q)) return { userId: ctx.currentUserId, subject: 'You' };
  const m = detectMember(q, ctx.members);
  if (m) return { userId: m.userId, subject: m.displayName };
  return null;
}

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
  // ── Help / capabilities ──
  if (/\b(help|what (all )?can (you|u|i) (do|ask|help)|what (do|are) you (do|capable|able)|what can you answer|how (do|does) (this|you|it) work|commands?|capabilities|who are you|what are you)\b/i.test(q)) {
    return { handled: true, answer: ASSISTANT_CAPABILITIES, sources: [], confidence: 1 };
  }

  const tf = parseTimeframe(q, ctx.now);
  const scoped = inTimeframe; // alias
  const inTf = (e: Expense) => scoped(e, tf);
  const currency = ctx.currency || 'USD';
  const now = ctx.now ?? Date.now();

  // ── Period comparison ("this month vs last month", "spending more than last week") ──
  const wantsCompare =
    /\b(compare|compared to|versus|vs\.?)\b/i.test(q) ||
    /\bthan last (week|month|year)\b/i.test(q) ||
    /\b(more|less|higher|lower)\b[^.?!]*\blast (week|month|year)\b/i.test(q);
  if (wantsCompare) {
    const unit: PeriodUnit = /\bweek\b/i.test(q) ? 'week' : /\byear\b/i.test(q) ? 'year' : 'month';
    const { current, previous } = comparisonWindows(now, unit);
    const target = resolveTarget(q, ctx);
    const category = detectCategory(q, ctx.expenses);
    const matches = (e: Expense, w: Timeframe) =>
      inTimeframe(e, w) && lc(e.category ?? '') !== 'settlement' && (!category || lc(e.category ?? '') === lc(category));
    const valueIn = (w: Timeframe) => {
      const pool = ctx.expenses.filter((e) => matches(e, w));
      return target ? sumUserShare(pool, target.userId) : sumTotal(pool);
    };
    const cur = valueIn(current);
    const prev = valueIn(previous);
    const delta = Math.round((cur - prev) * 100) / 100;
    const subject = target ? (target.subject === 'You' ? 'You' : target.subject) : 'The group';
    const scopeLabel = category ? ` on ${category}` : '';
    let trend: string;
    if (Math.abs(delta) < 0.01) {
      trend = 'about the same';
    } else {
      const pct = prev > 0 ? ` (${Math.abs(Math.round((delta / prev) * 100))}%)` : '';
      trend = `${delta > 0 ? 'up' : 'down'} ${money(Math.abs(delta), currency)}${pct}`;
    }
    return {
      handled: true,
      answer: `${subject} spent ${money(cur, currency)}${scopeLabel} ${current.label} vs ${money(prev, currency)} ${previous.label} — ${trend}.`,
      sources: [],
      confidence: 1,
    };
  }

  // ── Trend / spending over time (last few months) ──
  if (/\b(trend|over time|by month|each month|month by month|spending history)\b/i.test(q)) {
    const a = buildExpenseAnalytics(ctx.expenses, ctx.settlements, ctx.currentUserId);
    const months = Object.keys(a.byMonth).sort().slice(-6);
    if (months.length === 0) {
      return { handled: true, answer: 'No expenses yet.', sources: [], confidence: 1 };
    }
    const lines = months.map((mk) => `• ${mk}: ${money(a.byMonth[mk].total, currency)}`);
    return {
      handled: true,
      answer: `Spending by month:\n${lines.join('\n')}`,
      sources: [],
      confidence: 1,
    };
  }

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
  if (/\bowe[ds]?\b|\bbalances?\b|settled up\?|\beven\b/i.test(q)) {
    const analytics = buildExpenseAnalytics(ctx.expenses, ctx.settlements, ctx.currentUserId);

    // Overview: "everyone's balances", "all balances", "group balances".
    if (/\b(everyone|every one|all balances|group balance|each (person|member|one))\b/i.test(q)) {
      const rows = ctx.members
        .map((m) => ({ m, bal: analytics.balances[m.userId] ?? 0 }))
        .filter((r) => Math.abs(r.bal) >= 0.01)
        .sort((a, b) => b.bal - a.bal);
      if (rows.length === 0) {
        return { handled: true, answer: "Everyone's settled up.", sources: [], confidence: 1 };
      }
      const lines = rows.map((r) => {
        const name = nameOf(ctx.members, r.m.userId, ctx.currentUserId);
        const isYou = name === 'You';
        return r.bal > 0
          ? `• ${name} ${isYou ? 'are' : 'is'} owed ${money(r.bal, currency)}`
          : `• ${name} owe${isYou ? '' : 's'} ${money(Math.abs(r.bal), currency)}`;
      });
      return { handled: true, answer: `Balances:\n${lines.join('\n')}`, sources: [], confidence: 1 };
    }

    // Pairwise: "how much do I owe Bob" / "does Bob owe me" → exact bilateral net.
    const other = detectMember(q, ctx.members.filter((m) => m.userId !== ctx.currentUserId));
    if (other) {
      const net = pairwiseNet(ctx.expenses, ctx.settlements, ctx.currentUserId, other.userId);
      if (Math.abs(net) < 0.01) {
        return { handled: true, answer: `You and ${other.displayName} are settled up.`, sources: [], confidence: 1 };
      }
      return {
        handled: true,
        answer:
          net > 0
            ? `You owe ${other.displayName} ${money(net, currency)}.`
            : `${other.displayName} owes you ${money(Math.abs(net), currency)}.`,
        sources: [],
        confidence: 1,
      };
    }
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

  // ── What did I pay for (list a user's paid expenses) ──
  if (/\b(paid for|pay for|did i pay|i paid|i bought|did i buy|what.* i pay)\b/i.test(q)) {
    const target = resolveTarget(q, ctx) ?? { userId: ctx.currentUserId, subject: 'You' };
    const paid = ctx.expenses
      .filter((e) => inTf(e) && e.paidBy === target.userId && lc(e.category ?? '') !== 'settlement')
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (paid.length === 0) {
      return { handled: true, answer: `${target.subject === 'You' ? "You haven't" : `${target.subject} hasn't`} paid for anything${tfSuffix(tf)}.`, sources: [], confidence: 1 };
    }
    const total = sumTotal(paid);
    const lines = paid.slice(0, MAX_SOURCES).map((e) => `• ${e.title || 'Untitled'} — ${money(e.amount, currency)}`);
    const subj = target.subject === 'You' ? 'You paid for' : `${target.subject} paid for`;
    return {
      handled: true,
      answer: `${subj} ${paid.length} expense${paid.length === 1 ? '' : 's'}${tfSuffix(tf)} (${money(total, currency)} total):\n${lines.join('\n')}`,
      sources: paid.slice(0, MAX_SOURCES).map((e) => toSource(e, ctx)),
      confidence: 1,
    };
  }

  // ── Recent / latest expenses ──
  if (/\b(recent|latest|most recent|last few)\b.*\bexpenses?\b|\brecent (activity|expenses?)\b|\bwhat'?s new\b/i.test(q)) {
    const recent = [...ctx.expenses]
      .filter((e) => lc(e.category ?? '') !== 'settlement')
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 5);
    if (recent.length === 0) {
      return { handled: true, answer: 'No expenses yet.', sources: [], confidence: 1 };
    }
    const lines = recent.map((e) => `• ${e.title || 'Untitled'} — ${money(e.amount, currency)}${e.category ? ` (${e.category})` : ''}`);
    return {
      handled: true,
      answer: `Most recent expenses:\n${lines.join('\n')}`,
      sources: recent.map((e) => toSource(e, ctx)),
      confidence: 1,
    };
  }

  // ── Per-member spending leaderboard ("how much has each person spent") ──
  if (/\b(each (person|member|one)|everyone'?s? (spending|share|spend)|per person|how much has each|breakdown by (person|member))\b/i.test(q)) {
    const pool = ctx.expenses.filter((e) => inTf(e) && lc(e.category ?? '') !== 'settlement');
    const byPaid = lc(q).includes('paid');
    const totals = new Map<string, number>();
    for (const e of pool) {
      if (byPaid) totals.set(e.paidBy, (totals.get(e.paidBy) ?? 0) + (e.amount || 0));
      else for (const p of e.participants ?? []) totals.set(p.userId, (totals.get(p.userId) ?? 0) + (Number(p.share) || 0));
    }
    const rows = ctx.members
      .map((m) => ({ m, amt: Math.round((totals.get(m.userId) ?? 0) * 100) / 100 }))
      .filter((r) => r.amt > 0)
      .sort((a, b) => b.amt - a.amt);
    if (rows.length === 0) {
      return { handled: true, answer: `No expenses found${tfSuffix(tf)}.`, sources: [], confidence: 1 };
    }
    const verb = byPaid ? 'paid' : 'spent';
    const lines = rows.map((r) => `• ${nameOf(ctx.members, r.m.userId, ctx.currentUserId)}: ${money(r.amt, currency)}`);
    return {
      handled: true,
      answer: `How much each person ${verb}${tfSuffix(tf)}:\n${lines.join('\n')}`,
      sources: [],
      confidence: 1,
    };
  }

  // ── Spending by category breakdown ("where did the money go", "by category") ──
  if (/\b(by category|per category|category breakdown|breakdown by category)\b/i.test(q) || /\bwhere did (the |our |my )?money go\b/i.test(q)) {
    const pool = ctx.expenses.filter((e) => inTf(e) && lc(e.category ?? '') !== 'settlement');
    if (pool.length === 0) {
      return { handled: true, answer: `No expenses found${tfSuffix(tf)}.`, sources: [], confidence: 1 };
    }
    const target = resolveTarget(q, ctx);
    const totals = new Map<string, number>();
    for (const e of pool) {
      const c = (e.category ?? 'General').trim() || 'General';
      const v = target ? userShareOf(e, target.userId) : (e.amount || 0);
      if (v > 0) totals.set(c, (totals.get(c) ?? 0) + v);
    }
    const rows = [...totals.entries()].map(([c, t]) => [c, Math.round(t * 100) / 100] as const).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const subj = target ? `${target.subject === 'You' ? 'Your' : `${target.subject}'s`} spending` : 'Spending';
    const lines = rows.map(([c, t]) => `• ${c}: ${money(t, currency)}`);
    return {
      handled: true,
      answer: `${subj} by category${tfSuffix(tf)}:\n${lines.join('\n')}`,
      sources: [],
      confidence: 1,
    };
  }

  // ── Who paid / spent the most ──
  if (/\bwho\b.*\b(paid|spent|spend|owes? the most|biggest spender)\b|biggest spender/i.test(q)) {
    const pool = ctx.expenses.filter((e) => inTf(e) && lc(e.category ?? '') !== 'settlement');
    if (pool.length === 0) {
      return { handled: true, answer: `No expenses found${tfSuffix(tf)}.`, sources: [], confidence: 1 };
    }
    const byPaid = lc(q).includes('paid');
    const totals = new Map<string, number>();
    for (const e of pool) {
      if (byPaid) {
        totals.set(e.paidBy, (totals.get(e.paidBy) ?? 0) + (e.amount || 0));
      } else {
        for (const p of e.participants ?? []) totals.set(p.userId, (totals.get(p.userId) ?? 0) + (Number(p.share) || 0));
      }
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length === 0) {
      return { handled: true, answer: `No expenses found${tfSuffix(tf)}.`, sources: [], confidence: 1 };
    }
    const [topId, topAmt] = ranked[0];
    const verb = byPaid ? 'paid' : 'spent';
    return {
      handled: true,
      answer: `${nameOf(ctx.members, topId, ctx.currentUserId)} ${verb} the most${tfSuffix(tf)}: ${money(Math.round(topAmt * 100) / 100, currency)}.`,
      sources: [],
      confidence: 1,
    };
  }

  // ── Average expense ──
  if (/\baverage\b|\bavg\b|\bon average\b|\btypical (expense|amount)\b/i.test(q)) {
    const pool = ctx.expenses.filter((e) => inTf(e) && lc(e.category ?? '') !== 'settlement');
    if (pool.length === 0) {
      return { handled: true, answer: `No expenses found${tfSuffix(tf)}.`, sources: [], confidence: 1 };
    }
    const avg = sumTotal(pool) / pool.length;
    return {
      handled: true,
      answer: `The average expense${tfSuffix(tf)} is ${money(Math.round(avg * 100) / 100, currency)} (across ${pool.length}).`,
      sources: [],
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
    const target = resolveTarget(q, ctx);
    if (matching.length === 0) {
      return {
        handled: true,
        answer: `No ${category} expenses found${tfSuffix(tf)}.`,
        sources: [],
        confidence: 1,
      };
    }
    const amount = target ? sumUserShare(matching, target.userId) : sumTotal(matching);
    const who = target ? `${target.subject} spent` : 'The group spent';
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
    const target = resolveTarget(q, ctx);
    const amount = target ? sumUserShare(pool, target.userId) : sumTotal(pool);
    const who = target
      ? `${target.subject === 'You' ? 'Your' : `${target.subject}'s`} share of spending`
      : 'Total spending';
    return {
      handled: true,
      answer: `${who}${tfSuffix(tf)} is ${money(amount, currency)} across ${pool.length} expense${pool.length === 1 ? '' : 's'}.`,
      sources: topSources(pool, ctx),
      confidence: 1,
    };
  }

  return NOT_HANDLED;
}
