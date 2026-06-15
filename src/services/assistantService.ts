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
import { classifyMessage, parseSettlement } from '@/utils/assistantChat';
import { pairwiseNet } from '@/utils/expenseAnalytics';
import { equalSplit } from '@/utils/smartSplitRecommender';

export type NewExpense = Omit<Expense, 'expenseId' | 'createdAt' | 'updatedAt'>;

export type ProposedAction =
  | { type: 'add_expense'; expense: NewExpense; summary: string }
  | { type: 'settle_up'; settlement: { fromUserId: string; toUserId: string; amount: number }; summary: string };

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
