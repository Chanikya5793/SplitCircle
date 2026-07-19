/**
 * assistantService.ts — stateful conversational orchestrator for the AI assistant.
 *
 * Carries a ConversationState across turns so the bot has real continuity:
 *  - SLOT-FILLING: collects missing info one step at a time (amount → what for →
 *    who's it split between) instead of guessing, asking back with tappable
 *    choices when something is missing.
 *  - MODIFY A PROPOSAL: after it proposes an action, follow-ups like "split with
 *    everyone", "only me", "make it 50" edit that proposal instead of starting over.
 *  - INTENT SWITCH: a clear new request ("actually, add an expense") abandons the
 *    pending flow instead of being merged into it.
 *
 * Every write is returned as a ProposedAction the UI confirms before running —
 * the model never mutates data directly. Question answering stays deterministic
 * + cited (exact numbers, no LLM arithmetic); the on-device model is only used to
 * UNDERSTAND phrasing and as a last-resort fallback.
 */

import type { Expense, Group } from '@/models';
import type { ExpenseAiAnswer, ExpenseAiSource } from '@/services/aiService';
import { resetOnDeviceSession, routeMessage } from '../../modules/splitcircle-ai';
import type { AssistantDataSources } from '@/services/aiDataAccess';
import {
  answerExpenseLocally,
  answerOpenEndedGrounded,
  coercePlan,
  getOnDeviceAiAvailability,
  type AnswerVia,
} from '@/services/onDeviceAiService';
import {
  inferPlanFromQuestion,
  resolveFollowUp,
  resolvePreviousPeriodToken,
} from '@/utils/assistantFollowUp';
import { categorizeText } from '@/utils/categoryMatch';
import {
  classifyMessage,
  detectExpenseModification,
  detectMetaCommand,
  detectNavTarget,
  extractExpenseTitle,
  matchExpenseByText,
  matchSettlement,
  parseExpenseEdit,
  parseParticipants,
  parseSettlement,
  type AssistantIntent,
  type ExpenseModification,
  type NavTarget,
} from '@/utils/assistantChat';
import { pairwiseNet } from '@/utils/expenseAnalytics';
import { planToQuestion, type QueryPlan } from '@/utils/expensePlan';
import { ASSISTANT_CAPABILITIES, answerExpenseQuery, type QueryContext } from '@/utils/expenseQuery';
import { equalSplit } from '@/utils/smartSplitRecommender';

export type NewExpense = Omit<Expense, 'expenseId' | 'createdAt' | 'updatedAt'>;

export type ProposedAction =
  | { type: 'add_expense'; expense: NewExpense; summary: string }
  | { type: 'settle_up'; settlement: { fromUserId: string; toUserId: string; amount: number }; summary: string }
  | { type: 'delete_expense'; expenseId: string; summary: string; destructive: true }
  | { type: 'edit_expense'; expense: Expense; summary: string }
  | { type: 'delete_settlement'; settlementId: string; summary: string; destructive: true }
  | { type: 'navigate'; target: NavTarget; summary: string };

/** A partially-collected expense the bot is still filling in. */
export interface ExpenseDraft {
  amount?: number;
  title?: string;
  category?: string;
  paidByUserId?: string;
  participantUserIds?: string[];
}

/** A partially-collected settle-up. */
export interface SettleDraft {
  fromUserId?: string;
  toUserId?: string;
  amount?: number | null;
}

/** Conversation memory carried by the UI between turns (and persisted per group). */
export interface ConversationState {
  pending?:
    | { intent: 'add_expense'; draft: ExpenseDraft }
    | { intent: 'settle_up'; draft: SettleDraft };
  /** The last action shown as a confirm card, so the user can tweak it. */
  lastProposed?: ProposedAction;
  /**
   * The last answered question as a structured plan, so follow-up fragments
   * ("what about April?", "the month before that") anchor to it instead of
   * being routed as new (and usually misread) questions.
   */
  lastQuery?: QueryPlan;
}

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
  /** Tappable quick replies the user can pick instead of typing. */
  choices?: string[];
  /** Conversation memory to pass back into the next turn. */
  state: ConversationState;
  /** Where an open-ended answer was generated (drives the transparency badge). */
  via?: AnswerVia;
  /** Signals the UI to reset the chat (native session + persisted thread). */
  resetChat?: boolean;
}

/** Options the screen threads in: extra data sources + streaming callback. */
export interface AssistantTurnOptions {
  sources?: AssistantDataSources;
  onPartial?: (text: string) => void;
  now?: number;
}

const money = (n: number, currency: string): string => `${n.toFixed(2)} ${currency}`;

const nameOf = (group: Group, userId: string, selfId: string): string =>
  userId === selfId ? 'you' : group.members.find((m) => m.userId === userId)?.displayName ?? 'someone';

/** First monetary number in the text, or null. */
const firstAmount = (text: string): number | null => {
  const m = text.match(/(?:[$₹€£]\s*)?(\d{1,7}(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Other members' first names, for clarifying-choice chips (capped). */
const memberFirstNames = (group: Group, currentUserId: string): string[] =>
  group.members
    .filter((m) => m.userId !== currentUserId)
    .map((m) => (m.displayName ?? '').split(/\s+/)[0])
    .filter((n) => n.length > 0)
    .slice(0, 4);

const isAction = (i: AssistantIntent): boolean =>
  i === 'add_expense' || i === 'settle_up' || i === 'delete_expense' ||
  i === 'edit_expense' || i === 'delete_settlement' || i === 'navigate';

const expenseSummary = (e: NewExpense, group: Group, currentUserId: string): string => {
  const payer = nameOf(group, e.paidBy, currentUserId);
  const n = e.participants.length;
  return `${e.title} — ${money(e.amount, group.currency)} · ${e.category} · paid by ${payer} · split ${n} way${n === 1 ? '' : 's'}`;
};

/**
 * Process one conversational turn. `state` carries the memory from the previous
 * turn (slot-filling draft / last proposed action). Always returns the next
 * `state` for the caller to keep.
 */
export async function processAssistantTurn(
  message: string,
  group: Group,
  currentUserId: string,
  state: ConversationState = {},
  options: AssistantTurnOptions = {},
): Promise<AssistantTurn> {
  const text = (message ?? '').trim();
  const members = group.members.map((m) => ({ userId: m.userId, displayName: m.displayName }));
  if (!text) return { reply: 'What would you like to do?', state };

  // Global cancel/abort — clears any in-progress flow.
  if (/^(cancel|never ?mind|nvm|stop|forget it|no thanks?)\b/i.test(text)) {
    return { reply: 'Okay, cancelled. What else can I help with?', state: {} };
  }

  // 0) Chat-control / social messages handled BEFORE any model or query
  //    routing, so "clear the chat" / "hello" never leak into the spend engine
  //    (doc 17 failures #1, #2). Only when no action flow is mid-progress.
  if (!state.pending) {
    const meta = handleMetaCommand(text, group);
    if (meta) return meta;
  }

  const fresh = classifyMessage(text, members);

  // 1) Modify the pending PROPOSED expense ("split with everyone", "make it 50",
  //    "category to Food") — unless the user is clearly starting a new add.
  if (state.lastProposed?.type === 'add_expense' && fresh !== 'add_expense') {
    const mod = detectExpenseModification(text, members, currentUserId);
    if (mod) {
      const action = applyExpenseModification(state.lastProposed, mod, group, currentUserId);
      return { reply: 'Updated — add this expense?', action, state: { lastProposed: action } };
    }
  }

  // 2) Continue an in-progress slot-filling flow, unless the user switched to a
  //    different action ("actually, settle up with Sam").
  if (state.pending && !(isAction(fresh) && fresh !== state.pending.intent)) {
    if (state.pending.intent === 'add_expense') {
      return continueAddExpense(text, group, currentUserId, state.pending.draft);
    }
    if (state.pending.intent === 'settle_up') {
      return continueSettleUp(text, group, currentUserId, state.pending.draft);
    }
  }

  // 3) Fresh routing.
  switch (fresh) {
    case 'delete_expense':
      return handleDeleteExpense(text, group);
    case 'edit_expense':
      return handleEditExpense(text, group);
    case 'delete_settlement':
      return handleDeleteSettlement(text, group, currentUserId);
    case 'navigate':
      return handleNavigate(text);
    case 'settle_up':
      return continueSettleUp(text, group, currentUserId, {});
    case 'add_expense':
      return continueAddExpense(text, group, currentUserId, {});
    default:
      return answerQuestion(text, group, currentUserId, state, options);
  }
}

// ── Meta / chat-control commands ─────────────────────────────────────────────

function handleMetaCommand(text: string, group: Group): AssistantTurn | null {
  const meta = detectMetaCommand(text);
  if (!meta) return null;
  switch (meta) {
    case 'clear_chat':
      return {
        reply: 'Cleared our conversation. What would you like to do next?',
        state: {},
        resetChat: true,
      };
    case 'help':
      return { reply: ASSISTANT_CAPABILITIES, state: {} };
    case 'greeting':
      return {
        reply: `Hi! Ask me about ${group.name}'s spending and balances, or tell me to add an expense or settle up.`,
        choices: ['How much did I spend?', 'Show our settle-up', 'Add an expense'],
        state: {},
      };
    case 'thanks':
      return { reply: "You're welcome! Anything else?", state: {} };
    case 'goodbye':
      return { reply: 'See you! I’ll be here whenever you need me.', state: {} };
    default:
      return null;
  }
}

// ── Add expense (slot-filling) ───────────────────────────────────────────────

function continueAddExpense(
  text: string,
  group: Group,
  currentUserId: string,
  draft: ExpenseDraft,
): AssistantTurn {
  const members = group.members.map((m) => ({ userId: m.userId, displayName: m.displayName }));
  const d: ExpenseDraft = { ...draft };

  if (d.amount == null) {
    const a = firstAmount(text);
    if (a != null) d.amount = a;
  }
  const parts = parseParticipants(text, members, currentUserId);
  if (parts && parts.length) d.participantUserIds = parts;
  if (!d.title) {
    const t = extractExpenseTitle(text);
    if (t) d.title = t;
  }
  if (!d.category && d.title) d.category = categorizeText(d.title);
  if (!d.paidByUserId) d.paidByUserId = currentUserId;

  const pending = (): ConversationState => ({ pending: { intent: 'add_expense', draft: d } });

  if (d.amount == null) {
    return { reply: 'How much was it? e.g. "$40 for dinner".', state: pending() };
  }
  if (!d.title) {
    return { reply: `What was the ${money(d.amount, group.currency)} for? e.g. "dinner" or "groceries".`, state: pending() };
  }
  if (!d.participantUserIds || d.participantUserIds.length === 0) {
    return {
      reply: "Who's this split between?",
      choices: ['Everyone', 'Just me', ...memberFirstNames(group, currentUserId)],
      state: pending(),
    };
  }

  const participants = equalSplit(d.participantUserIds, d.amount);
  const expense: NewExpense = {
    groupId: group.groupId,
    title: d.title,
    category: d.category ?? 'General',
    amount: d.amount,
    paidBy: d.paidByUserId ?? currentUserId,
    splitType: 'equal',
    participants,
    settled: false,
    notes: '',
  };
  const action: ProposedAction = { type: 'add_expense', expense, summary: expenseSummary(expense, group, currentUserId) };
  return { reply: 'Add this expense?', action, state: { lastProposed: action } };
}

function applyExpenseModification(
  proposed: Extract<ProposedAction, { type: 'add_expense' }>,
  mod: ExpenseModification,
  group: Group,
  currentUserId: string,
): ProposedAction {
  const expense: NewExpense = { ...proposed.expense, participants: [...proposed.expense.participants] };
  if (mod.title) expense.title = mod.title;
  if (mod.category) expense.category = mod.category;
  if (mod.paidByUserId) expense.paidBy = mod.paidByUserId;

  const amount = mod.amount ?? expense.amount;
  const participantIds = mod.participants ?? expense.participants.map((p) => p.userId);
  if (mod.amount != null || mod.participants) {
    expense.amount = amount;
    expense.participants = equalSplit(participantIds, amount);
    expense.splitType = 'equal';
  }
  return { type: 'add_expense', expense, summary: expenseSummary(expense, group, currentUserId) };
}

// ── Settle up (slot-filling) ─────────────────────────────────────────────────

function continueSettleUp(
  text: string,
  group: Group,
  currentUserId: string,
  draft: SettleDraft,
): AssistantTurn {
  const members = group.members.map((m) => ({ userId: m.userId, displayName: m.displayName }));
  const d: SettleDraft = { ...draft };

  const parsed = parseSettlement(text, members, currentUserId);
  if (parsed) {
    d.fromUserId = parsed.fromUserId;
    d.toUserId = parsed.toUserId;
    if (parsed.amount != null) d.amount = parsed.amount;
  } else {
    const a = firstAmount(text);
    if (a != null) d.amount = a;
  }

  if (!d.toUserId) {
    return {
      reply: 'Who do you want to settle up with?',
      choices: memberFirstNames(group, currentUserId),
      state: { pending: { intent: 'settle_up', draft: d } },
    };
  }

  const fromUserId = d.fromUserId ?? currentUserId;
  let amount = d.amount ?? null;
  if (amount == null) {
    const net = pairwiseNet(group.expenses, group.settlements, fromUserId, d.toUserId);
    amount = Math.abs(net);
    if (amount < 0.01) {
      return { reply: `You and ${nameOf(group, d.toUserId, currentUserId)} are already settled up.`, state: {} };
    }
  }
  const rounded = Math.round(amount * 100) / 100;
  const from = nameOf(group, fromUserId, currentUserId);
  const to = nameOf(group, d.toUserId, currentUserId);
  const action: ProposedAction = {
    type: 'settle_up',
    settlement: { fromUserId, toUserId: d.toUserId, amount: rounded },
    summary: `${from === 'you' ? 'You' : from} pay ${to} ${money(rounded, group.currency)}`,
  };
  return { reply: 'Record this settlement?', action, state: { lastProposed: action } };
}

// ── Delete / edit / navigate (single-shot; ask to clarify if ambiguous) ───────

function handleDeleteExpense(text: string, group: Group): AssistantTurn {
  const match = matchExpenseByText(text, group.expenses);
  if (!match) {
    return { reply: 'Which expense should I delete? Try naming it, e.g. "delete the dinner expense".', state: {} };
  }
  const action: ProposedAction = {
    type: 'delete_expense',
    expenseId: match.expenseId,
    destructive: true,
    summary: `${match.title || 'Untitled'} — ${money(match.amount, group.currency)}`,
  };
  return { reply: 'Delete this expense? This cannot be undone.', action, state: { lastProposed: action } };
}

function handleEditExpense(text: string, group: Group): AssistantTurn {
  const edit = parseExpenseEdit(text, group.expenses);
  const existing = edit ? group.expenses.find((e) => e.expenseId === edit.expenseId) : undefined;
  if (!edit || !existing) {
    return {
      reply: 'Which expense, and what should change? e.g. "rename the dinner expense to Brunch" or "change the gas amount to 45".',
      state: {},
    };
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
    const ids = (existing.participants ?? []).map((p) => p.userId);
    updated.participants = equalSplit(ids.length ? ids : group.members.map((m) => m.userId), edit.changes.amount);
    updated.splitType = 'equal';
    parts.push(`amount → ${money(edit.changes.amount, group.currency)} (re-split equally)`);
  }
  if (parts.length === 0) {
    return { reply: `"${existing.title}" already matches that — nothing to change.`, state: {} };
  }
  const action: ProposedAction = { type: 'edit_expense', expense: updated, summary: `${existing.title}: ${parts.join(', ')}` };
  return { reply: 'Apply this change?', action, state: { lastProposed: action } };
}

function handleDeleteSettlement(text: string, group: Group, currentUserId: string): AssistantTurn {
  const members = group.members.map((m) => ({ userId: m.userId, displayName: m.displayName }));
  const match = matchSettlement(text, group.settlements, members);
  if (!match) {
    return { reply: 'I couldn’t find a settlement to delete. Try "delete the last settlement" or "undo the settlement with Alex".', state: {} };
  }
  const from = nameOf(group, match.fromUserId, currentUserId);
  const to = nameOf(group, match.toUserId, currentUserId);
  const action: ProposedAction = {
    type: 'delete_settlement',
    settlementId: match.settlementId,
    destructive: true,
    summary: `${from === 'you' ? 'You' : from} → ${to}: ${money(match.amount, group.currency)}`,
  };
  return { reply: 'Delete this settlement? This cannot be undone.', action, state: { lastProposed: action } };
}

function handleNavigate(text: string): AssistantTurn {
  const target = detectNavTarget(text);
  if (!target) {
    return { reply: 'Where to? Try "open settle up", "show stats", or "open recurring bills".', state: {} };
  }
  const action: ProposedAction = { type: 'navigate', target, summary: NAV_LABELS[target] };
  return { reply: `Open ${NAV_LABELS[target]}?`, action, state: { lastProposed: action } };
}

// ── Questions ────────────────────────────────────────────────────────────────
// Router-first pipeline: cheap deterministic answers → conversational-memory
// follow-ups → the abstaining on-device router (front-door understanding) →
// grounded open-ended answering (progressive/agentic data + streaming + PCC).
// Numbers ALWAYS come from the deterministic engine; the model only classifies,
// fills slots, and phrases.

const NUDGE =
  "I’m not sure I caught that. I can answer questions about this group’s spending and balances, add expenses, and record settle-ups.\n\nTry “how much did I spend on food?”, “settle up with Alex”, or “add $20 lunch”.";

/** Remember an answered question (as a plan) so the next turn can follow up. */
function withMemory(turn: AssistantTurn, plan: QueryPlan): AssistantTurn {
  return { ...turn, state: { ...turn.state, lastQuery: plan } };
}

const queryCtx = (group: Group, currentUserId: string, now?: number): QueryContext => ({
  expenses: group.expenses ?? [],
  settlements: group.settlements ?? [],
  members: group.members.map((m) => ({ userId: m.userId, displayName: m.displayName })),
  currentUserId,
  currency: group.currency,
  now,
});

/** Run a canonical question through the deterministic engine; null if not handled. */
function tryDeterministic(
  canonical: string,
  plan: QueryPlan,
  group: Group,
  currentUserId: string,
  now?: number,
): AssistantTurn | null {
  const r = answerExpenseQuery(canonical, queryCtx(group, currentUserId, now));
  if (!r.handled) return null;
  return withMemory({ reply: r.answer, sources: r.sources, state: {} }, plan);
}

async function answerQuestion(
  text: string,
  group: Group,
  currentUserId: string,
  state: ConversationState,
  options: AssistantTurnOptions,
): Promise<AssistantTurn> {
  const members = group.members.map((m) => ({ userId: m.userId, displayName: m.displayName }));
  const now = options.now;

  // 1) Follow-up to the previous question ("what about April?", "the month
  //    before that", "and for food?") — resolve against remembered lastQuery.
  if (state.lastQuery) {
    const merged = resolveFollowUp(text, state.lastQuery, members, now ?? Date.now());
    if (merged) {
      const canonical = renderPlan(merged, now);
      if (canonical) {
        const turn = tryDeterministic(canonical, merged, group, currentUserId, now);
        if (turn) return turn;
      }
    }
  }

  // 2) Cheap deterministic pass on the raw text (exact numbers, every device).
  const local: ExpenseAiAnswer | null = answerExpenseLocally(text, group, currentUserId);
  if (local) {
    return withMemory(
      { reply: local.answer, sources: local.sources, state: {} },
      inferPlanFromQuestion(text, members, now ?? Date.now()),
    );
  }

  // 3) Abstaining router (front-door understanding). Classifies + plans over a
  //    persistent transcript; abstains on non-money/greeting instead of
  //    fabricating. Numbers still come from the deterministic engine below.
  if (getOnDeviceAiAvailability() === 'available') {
    const routed = await routeViaModel(text, group, currentUserId, now);
    if (routed) return routed;
  }

  // 4) Grounded open-ended answering (progressive/agentic data + streaming, PCC
  //    escalation). Understands + phrases; never computes numbers.
  const grounded = await answerOpenEndedGrounded(text, group, currentUserId, {
    sources: options.sources,
    onPartial: options.onPartial,
    now,
  });
  if (grounded?.answer) {
    return withMemory(
      { reply: grounded.answer, sources: grounded.sources, via: grounded.via, state: {} },
      inferPlanFromQuestion(text, members, now ?? Date.now()),
    );
  }

  return { reply: NUDGE, state: {} };
}

/** Render a plan to a canonical question, resolving previous_period first. */
function renderPlan(plan: QueryPlan, now?: number): string {
  let p = plan;
  if (p.timeframe === 'previous_period') {
    const token = resolvePreviousPeriodToken(plan.timeframe, now ?? Date.now());
    p = { ...p, timeframe: token ?? null };
  }
  return planToQuestion(p);
}

/**
 * The abstaining router: classify the message over a persistent per-group
 * session. On abstain (greeting/small talk/non-money) reply with the model's
 * friendly line; on a question, execute its plan deterministically; on low
 * confidence, fall through to grounded answering rather than guess.
 */
async function routeViaModel(
  text: string,
  group: Group,
  currentUserId: string,
  now?: number,
): Promise<AssistantTurn | null> {
  const memberNames = group.members.map((m) => m.displayName).filter(Boolean).join(', ');
  const isoDate = new Date(now ?? Date.now()).toISOString().slice(0, 10);
  let decision;
  try {
    decision = await routeMessage(`route:${group.groupId}`, text, memberNames, isoDate);
  } catch {
    return null;
  }

  if (decision.abstain) {
    const reply = decision.chitchatReply?.trim();
    return { reply: reply || NUDGE, state: {} };
  }

  if (decision.intent === 'question') {
    const plan = coercePlan(decision.queryPlan);
    const canonical = renderPlan(plan, now);
    if (canonical) {
      const turn = tryDeterministic(canonical, plan, group, currentUserId, now);
      if (turn) return turn;
    }
    // Understood as a question but not deterministically answerable → let the
    // grounded engine handle it (caller path continues).
    return null;
  }

  // The router thinks this is an action but the deterministic action classifier
  // disagreed; trust the safe deterministic path (caller falls through).
  return null;
}
