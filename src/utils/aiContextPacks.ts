/**
 * aiContextPacks.ts — the data side of the on-device AI pipeline.
 *
 * The model can be grounded in much more than the current group's expense
 * titles: settlements, recurring bills, itemized receipt lines, cross-group
 * aggregates, chat snippets, and a personal spending profile. Each "pack" is a
 * compact, citable text section; `packSections` fits the requested packs into
 * the device's real token budget in priority order so the prompt never
 * overflows the context window.
 *
 * Pure module — no RN/native imports (unit-tested). IO (loading chat messages,
 * bills) happens in `services/aiDataAccess.ts`; this file only formats + packs.
 */

import type { ChatMessage } from '@/models/chat';
import type { Expense } from '@/models/expense';
import type { Group, Settlement } from '@/models/group';
import type { RecurringBill } from '@/models/recurringBill';
import { getGroupAnalytics } from './expenseAnalytics';

/** Data kinds the model may request while answering (agentic read path). */
export const AI_DATA_KINDS = [
  'expenses',
  'balances',
  'settlements',
  'recurring_bills',
  'receipt_items',
  'cross_group',
  'chat_messages',
  'spending_profile',
] as const;

export type AiDataKind = (typeof AI_DATA_KINDS)[number];

/** One-line description per kind — given to the model so it knows what to ask for. */
export const AI_DATA_KIND_DESCRIPTIONS: Record<AiDataKind, string> = {
  expenses: "this group's expense lines (date, title, category, amount, payer)",
  balances: 'verified totals and who-owes-whom balances for this group',
  settlements: 'settlement/payment history for this group',
  recurring_bills: 'recurring bills set up in this group',
  receipt_items: 'itemized receipt line-items attached to expenses',
  cross_group: "the user's totals and balances across ALL their groups",
  chat_messages: "recent snippets from this group's chat conversation",
  spending_profile: "the user's personal spending habits profile",
};

export interface ContextSection {
  kind: AiDataKind;
  title: string;
  lines: string[];
  /** 1 = must keep; higher numbers are dropped first when the budget is tight. */
  priority: number;
}

/** ~4 chars/token is a safe on-device estimate for expense-style text. */
export const approxTokens = (text: string): number => Math.ceil(text.length / 4);

const isoDate = (ms: number): string => {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : 'unknown-date';
};

const money = (n: number, currency: string): string => `${(Number(n) || 0).toFixed(2)} ${currency}`;

interface NamedMember {
  userId: string;
  displayName: string;
}

const nameMap = (members: readonly NamedMember[]): Map<string, string> =>
  new Map(members.map((m) => [m.userId, m.displayName]));

// ── Per-kind formatters ──────────────────────────────────────────────────────

export function formatSettlementLines(
  settlements: readonly Settlement[],
  members: readonly NamedMember[],
  currency: string,
  max = 20,
): string[] {
  const names = nameMap(members);
  return [...settlements]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, max)
    .map(
      (s) =>
        `${isoDate(s.createdAt)} | ${names.get(s.fromUserId) ?? 'someone'} paid ${names.get(s.toUserId) ?? 'someone'} ${money(s.amount, currency)}${s.status === 'pending' ? ' (pending)' : ''}`,
    );
}

export function formatRecurringBillLines(
  bills: readonly RecurringBill[],
  members: readonly NamedMember[],
  currency: string,
  max = 10,
): string[] {
  const names = nameMap(members);
  return bills
    .filter((b) => b.isActive)
    .slice(0, max)
    .map(
      (b) =>
        `${b.title} | ${b.category} | ${money(b.amount, currency)} | paid by ${names.get(b.paidBy) ?? 'someone'} | next due ${isoDate(b.nextDueAt)}`,
    );
}

export function formatReceiptItemLines(
  expenses: readonly Expense[],
  currency: string,
  max = 15,
): string[] {
  const lines: string[] = [];
  const itemsOf = (e: Expense) => e.splitMetadata?.receiptItems ?? [];
  const withItems = [...expenses]
    .filter((e) => itemsOf(e).length > 0)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  for (const e of withItems) {
    if (lines.length >= max) break;
    const items = itemsOf(e)
      .slice(0, 8)
      .map((i) => `${i.quantity && i.quantity > 1 ? `${i.quantity}× ` : ''}${i.name} ${money(i.price, currency)}`)
      .join('; ');
    lines.push(`${e.title} (${isoDate(e.createdAt)}): ${items}`);
  }
  return lines;
}

/** Per-group totals + balances for "across all my groups" questions. */
export function formatCrossGroupLines(groups: readonly Group[], currentUserId: string): string[] {
  const lines: string[] = [];
  let grandTotal = 0;
  let grandShare = 0;
  const byCategory = new Map<string, number>();
  for (const g of groups) {
    const a = getGroupAnalytics(g, currentUserId);
    grandTotal += a.totalSpend;
    grandShare += a.userShareTotal;
    for (const c of a.byCategory) byCategory.set(c.category, (byCategory.get(c.category) ?? 0) + c.total);
    const bal =
      Math.abs(a.userBalance) < 0.01
        ? 'settled'
        : a.userBalance < 0
          ? `owes ${money(Math.abs(a.userBalance), g.currency)}`
          : `owed ${money(a.userBalance, g.currency)}`;
    lines.push(
      `${g.name}: total ${money(a.totalSpend, g.currency)} across ${a.count} expenses | your share ${money(a.userShareTotal, g.currency)} | you're ${bal}`,
    );
  }
  const topCats = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([c, t]) => `${c} ${t.toFixed(2)}`)
    .join(', ');
  lines.push(`ALL GROUPS: total ${grandTotal.toFixed(2)}, your share ${grandShare.toFixed(2)}${topCats ? ` | top categories: ${topCats}` : ''}`);
  return lines;
}

/**
 * Personal spending profile: habits computed locally from every group the user
 * belongs to. Used to personalize phrasing and pre-fill drafts — never leaves
 * the on-device/PCC boundary.
 */
export function buildSpendingProfileLines(groups: readonly Group[], currentUserId: string): string[] {
  const catTotals = new Map<string, number>();
  const partnerCounts = new Map<string, number>();
  const titleCounts = new Map<string, number>();
  const names = new Map<string, string>();
  let shareTotal = 0;
  let expenseCount = 0;
  const monthTotals = new Map<string, number>();

  for (const g of groups) {
    for (const m of g.members) names.set(m.userId, m.displayName);
    for (const e of g.expenses ?? []) {
      const mine = (e.participants ?? []).find((p) => p.userId === currentUserId);
      if (!mine) continue;
      const share = Number(mine.share) || 0;
      shareTotal += share;
      expenseCount += 1;
      const cat = (e.category ?? 'General').trim() || 'General';
      catTotals.set(cat, (catTotals.get(cat) ?? 0) + share);
      const mk = isoDate(e.createdAt).slice(0, 7);
      monthTotals.set(mk, (monthTotals.get(mk) ?? 0) + share);
      const title = (e.title ?? '').trim().toLowerCase();
      if (title) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
      for (const p of e.participants ?? []) {
        if (p.userId !== currentUserId) partnerCounts.set(p.userId, (partnerCounts.get(p.userId) ?? 0) + 1);
      }
    }
  }

  if (expenseCount === 0) return [];

  const topCats = [...catTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c, t]) => `${c} (${shareTotal > 0 ? Math.round((t / shareTotal) * 100) : 0}%)`);
  const partners = [...partnerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id]) => names.get(id) ?? 'someone');
  const recentMonths = [...monthTotals.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 3);
  const monthlyAvg = recentMonths.length
    ? recentMonths.reduce((s, [, t]) => s + t, 0) / recentMonths.length
    : 0;
  const frequentTitles = [...titleCounts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);

  const lines = [
    `Top categories: ${topCats.join(', ')}`,
    `Average expense share: ${(shareTotal / expenseCount).toFixed(2)} across ${expenseCount} expenses`,
    `Recent monthly spend (your share): ~${monthlyAvg.toFixed(2)}`,
  ];
  if (partners.length) lines.push(`Most frequent split partners: ${partners.join(', ')}`);
  if (frequentTitles.length) lines.push(`Recurring purchases: ${frequentTitles.join(', ')}`);
  return lines;
}

/**
 * Rank chat messages against the question (keyword overlap, recency tiebreak)
 * and format them as citable snippets. `redact` runs per line so contact info
 * in chat never rides into a prompt (on-device or PCC).
 */
export function formatChatSnippets(
  messages: readonly ChatMessage[],
  members: readonly NamedMember[],
  question: string,
  redact: (text: string) => string,
  max = 12,
): string[] {
  const names = nameMap(members);
  const qTokens = new Set(
    question.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2),
  );
  const scored = messages
    .filter((m) => m.type === 'text' && !m.deletedForEveryone && (m.content ?? '').trim().length > 0)
    .map((m, i) => {
      const words = (m.content ?? '').toLowerCase().split(/[^a-z0-9]+/);
      let matches = 0;
      for (const w of words) if (qTokens.has(w)) matches += 1;
      return { m, i, matches };
    });
  return scored
    .sort((a, b) => b.matches - a.matches || b.i - a.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map(({ m }) => {
      const when = isoDate(typeof m.timestamp === 'number' ? m.timestamp : m.createdAt);
      const text = redact((m.content ?? '').replace(/\s+/g, ' ').slice(0, 160));
      return `${when} ${names.get(m.senderId) ?? 'someone'}: ${text}`;
    });
}

// ── Budgeted packing ─────────────────────────────────────────────────────────

export interface PackedContext {
  /** The combined prompt context, sections separated by headers. */
  context: string;
  /** Which kinds made it in (for transparency / debugging). */
  included: AiDataKind[];
}

/**
 * Fit sections into `tokenBudget` in priority order (1 first). A section that
 * doesn't fully fit is trimmed line-by-line; below 3 surviving lines it's
 * dropped instead so the model never sees a misleading fragment.
 */
export function packSections(sections: readonly ContextSection[], tokenBudget: number): PackedContext {
  const ordered = [...sections]
    .filter((s) => s.lines.length > 0)
    .sort((a, b) => a.priority - b.priority);
  const parts: string[] = [];
  const included: AiDataKind[] = [];
  let used = 0;

  for (const s of ordered) {
    const header = `## ${s.title}`;
    const headerCost = approxTokens(header) + 2;
    let lines = s.lines;
    let cost = headerCost + lines.reduce((sum, l) => sum + approxTokens(l) + 1, 0);
    while (cost > tokenBudget - used && lines.length > 3) {
      lines = lines.slice(0, lines.length - 1);
      cost = headerCost + lines.reduce((sum, l) => sum + approxTokens(l) + 1, 0);
    }
    if (cost > tokenBudget - used) continue;
    used += cost;
    parts.push(`${header}\n${lines.join('\n')}`);
    included.push(s.kind);
  }

  return { context: parts.join('\n\n'), included };
}
