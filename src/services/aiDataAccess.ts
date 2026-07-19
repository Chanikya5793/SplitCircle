/**
 * aiDataAccess.ts — progressive data access for the AI pipeline.
 *
 * The assistant no longer sees only a fixed slice of one group's expenses.
 * Based on the question (keyword heuristics) and on what the model explicitly
 * asks for mid-conversation (agentic read path), this service loads and
 * formats additional packs: settlements, recurring bills, receipt items,
 * cross-group aggregates, chat snippets, and the personal spending profile.
 *
 * All data stays inside the on-device / Private Cloud Compute boundary; chat
 * snippets are PII-redacted before they enter any prompt.
 */

import type { ChatMessage } from '@/models/chat';
import type { Group } from '@/models/group';
import type { RecurringBill } from '@/models/recurringBill';
import { redactPII } from '../../modules/splitcircle-ai';
import {
  AI_DATA_KINDS,
  buildSpendingProfileLines,
  formatChatSnippets,
  formatCrossGroupLines,
  formatReceiptItemLines,
  formatRecurringBillLines,
  formatSettlementLines,
  type AiDataKind,
  type ContextSection,
} from '@/utils/aiContextPacks';
import { getGroupAnalytics } from '@/utils/expenseAnalytics';

/**
 * How the pipeline reaches data beyond the current group. All optional — a
 * caller that can't provide a source simply disables the packs that need it.
 * Injected by the screen (which owns contexts) so the pipeline stays testable.
 */
export interface AssistantDataSources {
  /** Every group the user belongs to — enables cross_group + spending_profile. */
  getAllGroups?: () => readonly Group[];
  /** This group's chat messages — enables chat_messages. */
  getChatMessages?: () => Promise<readonly ChatMessage[]>;
  /** This group's recurring bills — enables recurring_bills. */
  getRecurringBills?: () => Promise<readonly RecurringBill[]>;
}

/** Exact, precomputed facts — the model phrases these, never recomputes them. */
export function buildFactsLines(group: Group, currentUserId: string): string[] {
  const a = getGroupAnalytics(group, currentUserId);
  const cur = group.currency || 'USD';
  const topCats = a.byCategory.slice(0, 5).map((c) => `${c.category} ${c.total.toFixed(2)}`).join(', ');
  const bal =
    Math.abs(a.userBalance) < 0.01
      ? 'settled up'
      : a.userBalance < 0
        ? `you owe ${Math.abs(a.userBalance).toFixed(2)} ${cur}`
        : `you're owed ${a.userBalance.toFixed(2)} ${cur}`;
  const lines = [
    `Total group spend: ${a.totalSpend.toFixed(2)} ${cur} across ${a.count} expenses`,
    `Your total share: ${a.userShareTotal.toFixed(2)} ${cur}; you paid: ${a.userPaidTotal.toFixed(2)} ${cur}`,
    `Your balance: ${bal}`,
  ];
  if (topCats) lines.push(`Spend by category: ${topCats}`);
  return lines;
}

/** Packs worth pre-fetching for this question, before the model even asks. */
export function kindsSuggestedByQuestion(question: string): AiDataKind[] {
  const q = (question ?? '').toLowerCase();
  const kinds: AiDataKind[] = [];
  if (/\bsettl|paid (\w+ )?back|payment history|repaid\b/.test(q)) kinds.push('settlements');
  if (/\bbills?\b|\brecurring\b|\bsubscription/.test(q)) kinds.push('recurring_bills');
  if (/\bitems?\b|\breceipt|\bordered\b|\bline.item/.test(q)) kinds.push('receipt_items');
  if (/\ball (my |our )?groups\b|\bacross groups\b|\bevery group\b|\beverywhere\b|\boverall\b|\bin total across\b/.test(q)) {
    kinds.push('cross_group');
  }
  if (/\bchat\b|\bsaid\b|\bdiscussed\b|\bdecided\b|\bmentioned\b|\btalked\b|\bagreed\b|\bconversation\b/.test(q)) {
    kinds.push('chat_messages');
  }
  if (/\busually\b|\btypically\b|\bnormally\b|\bhabits?\b|\bmy profile\b|\bon average do i\b/.test(q)) {
    kinds.push('spending_profile');
  }
  return kinds;
}

/** Validate model-requested kind strings down to the known vocabulary. */
export function coerceDataKinds(raw: readonly string[] | null | undefined): AiDataKind[] {
  if (!raw) return [];
  const known = new Set<string>(AI_DATA_KINDS);
  const out: AiDataKind[] = [];
  for (const k of raw) {
    const t = (k ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (known.has(t) && !out.includes(t as AiDataKind)) out.push(t as AiDataKind);
  }
  return out;
}

/**
 * Load + format the requested packs. Kinds whose source is missing or empty
 * are silently skipped (the model is told what it DID get via section
 * headers). Never throws — a failed source just drops its pack.
 */
export async function buildSectionsForKinds(
  kinds: readonly AiDataKind[],
  question: string,
  group: Group,
  currentUserId: string,
  sources: AssistantDataSources = {},
): Promise<ContextSection[]> {
  const members = group.members.map((m) => ({ userId: m.userId, displayName: m.displayName }));
  const currency = group.currency || 'USD';
  const sections: ContextSection[] = [];

  for (const kind of kinds) {
    try {
      switch (kind) {
        case 'balances':
          sections.push({ kind, title: 'Verified totals (use these EXACT numbers)', lines: buildFactsLines(group, currentUserId), priority: 1 });
          break;
        case 'settlements':
          sections.push({
            kind,
            title: 'Settlement history',
            lines: formatSettlementLines(group.settlements ?? [], members, currency),
            priority: 2,
          });
          break;
        case 'receipt_items':
          sections.push({
            kind,
            title: 'Itemized receipt lines',
            lines: formatReceiptItemLines(group.expenses ?? [], currency),
            priority: 3,
          });
          break;
        case 'recurring_bills': {
          const bills = (await sources.getRecurringBills?.()) ?? [];
          sections.push({
            kind,
            title: 'Recurring bills',
            lines: formatRecurringBillLines(bills, members, currency),
            priority: 3,
          });
          break;
        }
        case 'cross_group': {
          const groups = sources.getAllGroups?.() ?? [];
          if (groups.length > 0) {
            sections.push({
              kind,
              title: "All the user's groups (verified totals)",
              lines: formatCrossGroupLines(groups, currentUserId),
              priority: 2,
            });
          }
          break;
        }
        case 'chat_messages': {
          const msgs = (await sources.getChatMessages?.()) ?? [];
          sections.push({
            kind,
            title: 'Group chat snippets (may be relevant)',
            lines: formatChatSnippets(msgs, members, question, redactPII),
            priority: 2,
          });
          break;
        }
        case 'spending_profile': {
          const groups = sources.getAllGroups?.() ?? [group];
          sections.push({
            kind,
            title: "User's spending profile (local, private)",
            lines: buildSpendingProfileLines(groups, currentUserId),
            priority: 4,
          });
          break;
        }
        case 'expenses':
          // Expense lines are built by the caller (numbered for citations).
          break;
      }
    } catch {
      // A failed pack never breaks the answer — the model just gets less data.
    }
  }

  return sections.filter((s) => s.lines.length > 0);
}
