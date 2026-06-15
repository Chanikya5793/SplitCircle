/**
 * assistantService.ts — conversational orchestrator for the AI assistant.
 *
 * Routes a user message to: a deterministic exact answer (questions), a proposed
 * ACTION the user confirms before it runs (add expense / settle up), or the
 * on-device LLM (open-ended chat). Every write is returned as a ProposedAction
 * and executed by the UI only after the user taps Confirm — the model never
 * mutates data directly.
 */

import type { Expense, Group } from '@/models';
import type { ExpenseAiAnswer, ExpenseAiSource } from '@/services/aiService';
import {
  answerExpenseLocally,
  askExpenseAiOnDevice,
  getOnDeviceAiAvailability,
} from '@/services/onDeviceAiService';
import {
  isOnDeviceExpenseNlAvailable,
  parseExpenseFromTextOnDevice,
} from '@/services/onDeviceExpenseNlService';
import {
  classifyMessage,
  detectNavTarget,
  matchExpenseByText,
  matchSettlement,
  parseExpenseEdit,
  parseSettlement,
  type NavTarget,
} from '@/utils/assistantChat';
import { pairwiseNet } from '@/utils/expenseAnalytics';
import { equalSplit } from '@/utils/smartSplitRecommender';

export type NewExpense = Omit<Expense, 'expenseId' | 'createdAt' | 'updatedAt'>;

export type ProposedAction =
  | { type: 'add_expense'; expense: NewExpense; summary: string }
  | { type: 'settle_up'; settlement: { fromUserId: string; toUserId: string; amount: number }; summary: string }
  | { type: 'delete_expense'; expenseId: string; summary: string; destructive: true }
  | { type: 'edit_expense'; expense: Expense; summary: string }
  | { type: 'delete_settlement'; settlementId: string; summary: string; destructive: true }
  | { type: 'navigate'; target: NavTarget; summary: string };

const NAV_LABELS: Record<NavTarget, string> = {
  settlements: 'Settle up',
  stats: 'Stats',
  bills: 'Recurring bills',
  add_expense: 'Add expense',
  chat: 'Group chat',
  group_info: 'Group info',
};

export interface AssistantTurn {
  reply: string;
  sources?: ExpenseAiSource[];
  action?: ProposedAction;
}

const money = (n: number, currency: string): string => `${n.toFixed(2)} ${currency}`;
const nameOf = (group: Group, userId: string, selfId: string): string =>
  userId === selfId ? 'you' : group.members.find((m) => m.userId === userId)?.displayName ?? 'someone';

/** Process one conversational turn. Pure-ish orchestration over tested layers. */
export async function processAssistantTurn(
  message: string,
  group: Group,
  currentUserId: string,
): Promise<AssistantTurn> {
  const members = group.members.map((m) => ({ userId: m.userId, displayName: m.displayName }));
  const intent = classifyMessage(message, members);

  // ── Delete expense (matched by title; destructive → explicit confirm) ──
  if (intent === 'delete_expense') {
    const match = matchExpenseByText(message, group.expenses);
    if (!match) {
      return { reply: 'Which expense should I delete? Try naming it, e.g. "delete the dinner expense".' };
    }
    return {
      reply: 'Delete this expense? This cannot be undone.',
      action: {
        type: 'delete_expense',
        expenseId: match.expenseId,
        destructive: true,
        summary: `${match.title || 'Untitled'} — ${money(match.amount, group.currency)}`,
      },
    };
  }

  // ── Edit expense (rename / amount / category) ──
  if (intent === 'edit_expense') {
    const edit = parseExpenseEdit(message, group.expenses);
    const existing = edit ? group.expenses.find((e) => e.expenseId === edit.expenseId) : undefined;
    if (!edit || !existing) {
      return { reply: 'Which expense, and what should change? e.g. "rename the dinner expense to Brunch" or "change the gas amount to 45".' };
    }
    const updated: Expense = { ...existing };
    const parts: string[] = [];
    if (edit.changes.title && edit.changes.title !== existing.title) {
      updated.title = edit.changes.title;
      parts.push(`title → "${edit.changes.title}"`);
    }
    if (edit.changes.category && edit.changes.category !== existing.category) {
      updated.category = edit.changes.category;
      parts.push(`category → ${edit.changes.category}`);
    }
    if (edit.changes.amount != null && Math.abs(edit.changes.amount - existing.amount) > 0.001) {
      updated.amount = edit.changes.amount;
      // Re-split equally among the existing participants so balances stay correct.
      const ids = (existing.participants ?? []).map((p) => p.userId);
      updated.participants = equalSplit(ids.length ? ids : group.members.map((m) => m.userId), edit.changes.amount);
      updated.splitType = 'equal';
      parts.push(`amount → ${money(edit.changes.amount, group.currency)} (re-split equally)`);
    }
    if (parts.length === 0) {
      return { reply: `"${existing.title}" already matches that — nothing to change.` };
    }
    return {
      reply: 'Apply this change?',
      action: { type: 'edit_expense', expense: updated, summary: `${existing.title}: ${parts.join(', ')}` },
    };
  }

  // ── Delete settlement ──
  if (intent === 'delete_settlement') {
    const match = matchSettlement(message, group.settlements, members);
    if (!match) {
      return { reply: 'I couldn’t find a settlement to delete. Try "delete the last settlement" or "undo the settlement with Alex".' };
    }
    const from = nameOf(group, match.fromUserId, currentUserId);
    const to = nameOf(group, match.toUserId, currentUserId);
    return {
      reply: 'Delete this settlement? This cannot be undone.',
      action: {
        type: 'delete_settlement',
        settlementId: match.settlementId,
        destructive: true,
        summary: `${from === 'you' ? 'You' : from} → ${to}: ${money(match.amount, group.currency)}`,
      },
    };
  }

  // ── Navigate / open a screen ──
  if (intent === 'navigate') {
    const target = detectNavTarget(message);
    if (!target) {
      return { reply: 'Where to? Try "open settle up", "show stats", or "open recurring bills".' };
    }
    return { reply: `Open ${NAV_LABELS[target]}?`, action: { type: 'navigate', target, summary: NAV_LABELS[target] } };
  }

  // ── Settle up (deterministic parse; works on every device) ──
  if (intent === 'settle_up') {
    const draft = parseSettlement(message, members, currentUserId);
    if (!draft) {
      return { reply: 'Who do you want to settle up with? Try "settle up with Alex" or "I paid Sam 20".' };
    }
    let amount = draft.amount;
    if (amount == null) {
      // No amount stated → use the exact bilateral balance between the two.
      const net = pairwiseNet(group.expenses, group.settlements, draft.fromUserId, draft.toUserId);
      amount = Math.abs(net);
      if (amount < 0.01) {
        return { reply: `You and ${nameOf(group, draft.toUserId, currentUserId)} are already settled up.` };
      }
    }
    const from = nameOf(group, draft.fromUserId, currentUserId);
    const to = nameOf(group, draft.toUserId, currentUserId);
    return {
      reply: `Record this settlement?`,
      action: {
        type: 'settle_up',
        settlement: { fromUserId: draft.fromUserId, toUserId: draft.toUserId, amount: Math.round(amount * 100) / 100 },
        summary: `${from === 'you' ? 'You' : from} pay ${to} ${money(Math.round(amount * 100) / 100, group.currency)}`,
      },
    };
  }

  // ── Add expense (needs the on-device NL parser) ──
  if (intent === 'add_expense') {
    if (!isOnDeviceExpenseNlAvailable()) {
      return { reply: 'I can add expenses from a sentence on Apple Intelligence iPhones (15 Pro or newer). Meanwhile, tap “Add” on the group to enter it manually.' };
    }
    const draft = await parseExpenseFromTextOnDevice(message, members, currentUserId);
    if (draft.amount <= 0 || !draft.title) {
      return { reply: 'Got it — how much was it and what for? e.g. "add $40 dinner with Alex, split equally".' };
    }
    const participants = equalSplit(draft.participantUserIds, draft.amount);
    const expense: NewExpense = {
      groupId: group.groupId,
      title: draft.title,
      category: draft.category,
      amount: draft.amount,
      paidBy: draft.paidByUserId,
      splitType: 'equal',
      participants,
      settled: false,
      notes: '',
    };
    const payer = nameOf(group, draft.paidByUserId, currentUserId);
    return {
      reply: 'Add this expense?',
      action: {
        type: 'add_expense',
        expense,
        summary: `${draft.title} — ${money(draft.amount, group.currency)} · ${draft.category} · paid by ${payer} · split ${participants.length} way${participants.length === 1 ? '' : 's'}`,
      },
    };
  }

  // ── Question → deterministic exact answer (every device) ──
  const local: ExpenseAiAnswer | null = answerExpenseLocally(message, group, currentUserId);
  if (local) {
    return { reply: local.answer, sources: local.sources };
  }

  // ── Open-ended → on-device LLM (grounded), else a gentle nudge ──
  if (getOnDeviceAiAvailability() === 'available') {
    const ans = await askExpenseAiOnDevice(message, group, currentUserId);
    return { reply: ans.answer, sources: ans.sources };
  }
  return {
    reply:
      "I can answer questions about this group's spending and balances, add expenses, and record settle-ups. Try \"how much did I spend on food?\", \"settle up with Alex\", or \"add $20 lunch\".",
  };
}
