/**
 * onDeviceAiService.ts — Ask AI powered by Apple's on-device Foundation Models
 * (Apple Intelligence, iOS 26+). No backend, no API bill, nothing leaves the
 * phone: the group's embedded expenses are ranked locally and handed to the
 * on-device LLM as numbered, citable context.
 *
 * Returns the same `ExpenseAiAnswer` shape as the cloud `askExpenseAi`
 * callable so the UI renders both paths identically. Eligibility (iPhone 15
 * Pro+/Apple Intelligence) is exposed via `getOnDeviceAiAvailability` so the
 * UI can show a precise note on unsupported devices.
 */

import {
  askOnDevice,
  askOnDeviceAgentic,
  askOnDeviceStreamed,
  askPcc,
  donateAskActivity,
  getOnDeviceAiAvailability,
  getOnDeviceContextSize,
  getPccAvailability,
  planExpenseQuery,
  redactPII,
  subscribeAiStream,
  type OnDeviceAiAvailability,
} from '../../modules/splitcircle-ai';
import {
  isKnownTimeframeToken,
  planToQuestion,
  type PlanIntent,
  type PlanTimeframe,
  type QueryPlan,
} from '@/utils/expensePlan';
import type { Group } from '@/models';
import type { ExpenseAiAnswer } from '@/services/aiService';
import {
  buildExpenseContext,
  maxExpensesForContext,
  resolveCitedExpenses,
} from '@/utils/onDeviceAiContext';
import { getGroupAnalytics } from '@/utils/expenseAnalytics';
import { answerExpenseQuery, type QueryContext } from '@/utils/expenseQuery';
// Side-effect import: wires the persistent SQLite index into `getGroupAnalytics`
// so on-device answers are grounded from the index that survives app restarts.
import '@/services/aiIndexStore';
import {
  buildFactsLines,
  buildSectionsForKinds,
  coerceDataKinds,
  kindsSuggestedByQuestion,
  type AssistantDataSources,
} from '@/services/aiDataAccess';
import { isPccEnabled } from '@/services/aiSettings';
import {
  AI_DATA_KINDS,
  AI_DATA_KIND_DESCRIPTIONS,
  approxTokens,
  packSections,
  type AiDataKind,
  type ContextSection,
} from '@/utils/aiContextPacks';

export type { OnDeviceAiAvailability };
export { getOnDeviceAiAvailability };

/**
 * Deterministic, on-device answer for the common questions (spend by category,
 * balances, settle-up, biggest, totals, summary) computed with EXACT numbers —
 * no LLM, so no arithmetic mistakes. Works on EVERY device (no Apple
 * Intelligence required). Returns null for open-ended questions so the caller
 * can fall back to the grounded LLM.
 */
export function answerExpenseLocally(
  question: string,
  group: Group,
  currentUserId: string,
): ExpenseAiAnswer | null {
  const queryCtx: QueryContext = {
    expenses: group.expenses ?? [],
    settlements: group.settlements ?? [],
    members: group.members.map((m) => ({ userId: m.userId, displayName: m.displayName })),
    currentUserId,
    currency: group.currency,
  };
  const r = answerExpenseQuery(question, queryCtx);
  if (!r.handled) return null;
  void donateAskActivity(redactPII(question));
  return { answer: r.answer, sources: r.sources, confidence: r.confidence };
}

const PLAN_INTENTS: ReadonlySet<PlanIntent> = new Set([
  'spend', 'balance', 'settle_up', 'biggest', 'count', 'average', 'who_most',
  'leaderboard', 'breakdown', 'paid_for', 'recent', 'summary', 'compare', 'trend', 'unknown',
]);
/** Validate the raw native plan into a typed QueryPlan (guards bad model output). */
export function coercePlan(raw: { intent?: string; scope?: string; category?: string; member?: string; metric?: string; timeframe?: string }): QueryPlan {
  const intent = (raw.intent && PLAN_INTENTS.has(raw.intent as PlanIntent) ? raw.intent : 'unknown') as PlanIntent;
  const rawTf = (raw.timeframe ?? '').trim().toLowerCase();
  const timeframe = (rawTf && isKnownTimeframeToken(rawTf) ? rawTf : null) as PlanTimeframe;
  const metric = raw.metric === 'paid' ? 'paid' : raw.metric === 'share' ? 'share' : undefined;
  const clean = (s?: string) => (s && s.trim() ? s.trim() : undefined);
  return { intent, scope: clean(raw.scope), category: clean(raw.category), member: clean(raw.member), metric, timeframe };
}

/**
 * Smart RAG path: the on-device model UNDERSTANDS a free-form question (→ plan),
 * we RETRIEVE the exact answer + citations deterministically from the index, and
 * return it. Numbers never come from the model. Returns null when the model is
 * unavailable or the question maps to nothing deterministic (caller falls back).
 */
export async function answerExpenseSmart(
  question: string,
  group: Group,
  currentUserId: string,
): Promise<ExpenseAiAnswer | null> {
  if (getOnDeviceAiAvailability() !== 'available') return null;
  let raw;
  try {
    raw = await planExpenseQuery(question, group.members.map((m) => m.displayName).filter(Boolean).join(', '));
  } catch {
    return null;
  }
  const canonical = planToQuestion(coercePlan(raw));
  if (!canonical) return null;
  const ctx: QueryContext = {
    expenses: group.expenses ?? [],
    settlements: group.settlements ?? [],
    members: group.members.map((m) => ({ userId: m.userId, displayName: m.displayName })),
    currentUserId,
    currency: group.currency,
  };
  const r = answerExpenseQuery(canonical, ctx);
  if (!r.handled) return null;
  void donateAskActivity(redactPII(question));
  return { answer: r.answer, sources: r.sources, confidence: r.confidence };
}

/** Compact, exact facts block prepended to the LLM context so it never recomputes. */
function buildFactsBlock(group: Group, currentUserId: string): string {
  return [
    'Verified totals (use these EXACT numbers; do NOT recompute or add up the lines yourself):',
    ...buildFactsLines(group, currentUserId).map((l) => `- ${l}`),
  ].join('\n');
}

/** Human copy for each unavailability reason (the "sorry" notes). */
export const ON_DEVICE_UNAVAILABLE_COPY: Record<Exclude<OnDeviceAiAvailability, 'available'>, string> = {
  deviceNotEligible:
    "Sorry — the assistant runs entirely on your iPhone using Apple Intelligence, which needs an iPhone 15 Pro or newer. Your expenses still work exactly as before.",
  appleIntelligenceNotEnabled:
    'Apple Intelligence is turned off. Enable it in Settings → Apple Intelligence & Siri, then come back — answers are generated on your device.',
  modelNotReady:
    "Apple's on-device model is still downloading. Leave your iPhone on Wi-Fi and charging, then try again in a few minutes.",
  unsupportedOS:
    'Sorry — the assistant needs iOS 26 or later on an Apple Intelligence-capable iPhone (15 Pro or newer).',
};

/**
 * Ask the on-device model about this group's expenses. Throws on failure —
 * callers gate on `getOnDeviceAiAvailability() === 'available'` first.
 */
export async function askExpenseAiOnDevice(
  question: string,
  group: Group,
  currentUserId: string,
): Promise<ExpenseAiAnswer> {
  const members = group.members.map((m) => ({ userId: m.userId, displayName: m.displayName }));

  // Adapt how much history we ground in to the device's real context window:
  // iPhone Air / 17 Pro auto-run Apple's larger "Core Advanced" on-device model
  // and report a bigger window, so they get more expenses → fuller answers.
  const maxLines = maxExpensesForContext(getOnDeviceContextSize());
  const { context, selected } = buildExpenseContext(
    group.expenses,
    question,
    members,
    group.currency,
    maxLines,
  );

  if (selected.length === 0) {
    return {
      answer: "This group doesn't have any expenses yet, so there's nothing to ask about. Add a few and try again!",
      sources: [],
      confidence: 1,
    };
  }

  // Prepend exact precomputed totals so the model phrases an answer rather than
  // doing (unreliable) arithmetic over the raw lines.
  const groundedContext = `${buildFactsBlock(group, currentUserId)}\n\nExpenses:\n${context}`;
  const result = await askOnDevice(question, groundedContext);
  const cited = resolveCitedExpenses(result.sourceIndexes ?? [], selected);
  const nameOf = new Map(members.map((m) => [m.userId, m.displayName]));

  // The on-device model doesn't self-report calibrated confidence; ground it
  // in citation behavior instead (cited answers are checkable by the user).
  const confidence = cited.length > 0 ? Math.min(0.9, 0.5 + 0.1 * cited.length) : 0.35;

  // Same Siri/Spotlight donation as the cloud path (fire-and-forget). The
  // model itself runs on the raw question (all on-device), but the donated
  // string is persisted in the OS activity index, so redact PII from it first.
  void donateAskActivity(redactPII(question));

  return {
    answer: result.answer,
    sources: cited.map((e) => ({
      expenseId: e.expenseId,
      groupId: e.groupId,
      title: e.title,
      category: e.category,
      amount: e.amount,
      currency: group.currency,
      paidByName: nameOf.get(e.paidBy),
      createdAt: e.createdAt,
    })),
    confidence,
  };
}

// ── Open-ended grounded answering (pipeline v2) ──────────────────────────────
// Progressive data access + agentic fetching + streaming + PCC escalation.
// Numbers still only ever come from the verified facts / deterministic engine;
// the model understands and phrases.

/** Where an answer was generated — surfaces as a transparency badge in the UI. */
export type AnswerVia = 'onDevice' | 'pcc';

export interface GroundedAnswer extends ExpenseAiAnswer {
  via: AnswerVia;
}

export interface OpenEndedOptions {
  /** Extra data reachable beyond the current group (chat, bills, all groups). */
  sources?: AssistantDataSources;
  /** Streamed answer-so-far callback (on-device streamed path only). */
  onPartial?: (text: string) => void;
  /** Injectable clock for tests. */
  now?: number;
}

/** Must match onDeviceAiContext's budgeting (instructions + question + answer room). */
const RESERVE_TOKENS = 1400;
const APPROX_TOKENS_PER_EXPENSE_LINE = 70;
/** Context budget for a PCC ask — well under the 32K window, far above on-device. */
const PCC_CONTEXT_TOKENS = 24000;
const PCC_MAX_EXPENSE_LINES = 400;
/** Extra fetch rounds the agentic loop may run before answering best-effort. */
const MAX_AGENTIC_ROUNDS = 2;

const groundedInstructions = (isoDate: string): string =>
  `You are SplitCircle's expense assistant. Today is ${isoDate}. Answer ONLY from the data sections provided. ` +
  `The 'Verified totals' numbers are exact — phrase them; NEVER recompute, total, or invent numbers, people, or expenses. ` +
  `Be concise and specific with amounts. If the data doesn't contain the answer, say so plainly.`;

const uid = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Data kinds actually reachable given which sources the caller wired up. */
function obtainableKinds(sources: AssistantDataSources): AiDataKind[] {
  return AI_DATA_KINDS.filter((k) => {
    if (k === 'expenses' || k === 'balances' || k === 'settlements' || k === 'receipt_items') return true;
    if (k === 'recurring_bills') return Boolean(sources.getRecurringBills);
    if (k === 'chat_messages') return Boolean(sources.getChatMessages);
    return Boolean(sources.getAllGroups); // cross_group, spending_profile
  });
}

interface GroundedContext {
  context: string;
  selected: ReturnType<typeof buildExpenseContext>['selected'];
  includedKinds: AiDataKind[];
}

/**
 * Assemble the full prompt context: verified facts, the requested packs
 * (budget-trimmed), then numbered expense lines filling whatever budget
 * remains — so extra packs never silently starve the citation lines to zero.
 */
async function buildGroundedContext(
  question: string,
  group: Group,
  currentUserId: string,
  kinds: readonly AiDataKind[],
  sources: AssistantDataSources,
  tokenBudget: number,
  maxExpenseLines: number,
): Promise<GroundedContext> {
  const members = group.members.map((m) => ({ userId: m.userId, displayName: m.displayName }));
  const facts = buildFactsBlock(group, currentUserId);
  const factsTokens = approxTokens(facts) + 2;

  const extraKinds = kinds.filter((k) => k !== 'expenses' && k !== 'balances');
  const sections: ContextSection[] = await buildSectionsForKinds(
    extraKinds, question, group, currentUserId, sources,
  );
  const sectionBudget = Math.max(0, Math.floor((tokenBudget - factsTokens) * 0.45));
  const packed = packSections(sections, sectionBudget);

  const expenseBudget = tokenBudget - factsTokens - approxTokens(packed.context);
  const lineCount = Math.min(
    maxExpenseLines,
    Math.max(10, Math.floor(expenseBudget / APPROX_TOKENS_PER_EXPENSE_LINE)),
  );
  const { context: expenseLines, selected } = buildExpenseContext(
    group.expenses ?? [], question, members, group.currency, lineCount,
  );

  const parts = [facts];
  if (packed.context) parts.push(packed.context);
  if (expenseLines) parts.push(`Expenses:\n${expenseLines}`);
  return {
    context: parts.join('\n\n'),
    selected,
    includedKinds: ['balances', ...packed.included, 'expenses'],
  };
}

function toGroundedAnswer(
  answer: string,
  sourceIndexes: readonly number[] | undefined,
  selected: GroundedContext['selected'],
  group: Group,
  via: AnswerVia,
): GroundedAnswer {
  const cited = resolveCitedExpenses(sourceIndexes ?? [], selected);
  const nameOf = new Map(group.members.map((m) => [m.userId, m.displayName]));
  return {
    answer,
    sources: cited.map((e) => ({
      expenseId: e.expenseId,
      groupId: e.groupId,
      title: e.title,
      category: e.category,
      amount: e.amount,
      currency: group.currency,
      paidByName: nameOf.get(e.paidBy),
      createdAt: e.createdAt,
    })),
    confidence: cited.length > 0 ? Math.min(0.9, 0.5 + 0.1 * cited.length) : 0.35,
    via,
  };
}

/** Escalate to PCC: rebuild the packs with the big budget and deeper reasoning. */
async function answerViaPcc(
  question: string,
  group: Group,
  currentUserId: string,
  kinds: readonly AiDataKind[],
  sources: AssistantDataSources,
  isoDate: string,
): Promise<GroundedAnswer> {
  const ctx = await buildGroundedContext(
    question, group, currentUserId, kinds, sources, PCC_CONTEXT_TOKENS, PCC_MAX_EXPENSE_LINES,
  );
  const complex = kinds.length > 1 || (group.expenses?.length ?? 0) > 150;
  const res = await askPcc(question, ctx.context, groundedInstructions(isoDate), complex ? 'moderate' : 'light');
  return toGroundedAnswer(res.answer, res.sourceIndexes, ctx.selected, group, 'pcc');
}

/**
 * Answer an open-ended question grounded in as much of the user's data as it
 * needs. Strategy:
 *  1. Pick packs the QUESTION suggests (progressive data access).
 *  2. Plain questions stream token-by-token from the persistent on-device
 *     session; data-hungry ones run the agentic loop, where the model may
 *     request more packs (read-only) before answering.
 *  3. Escalate to Private Cloud Compute (user-controlled, badged) when the
 *     data outgrows the on-device window, the loop can't finish, or on-device
 *     AI is unavailable but PCC isn't.
 * Returns null when neither backend can run (caller shows the honest nudge).
 */
export async function answerOpenEndedGrounded(
  question: string,
  group: Group,
  currentUserId: string,
  opts: OpenEndedOptions = {},
): Promise<GroundedAnswer | null> {
  const sources = opts.sources ?? {};
  const onDeviceOk = getOnDeviceAiAvailability() === 'available';
  const pccOk = getPccAvailability() === 'available' && (await isPccEnabled());
  if (!onDeviceOk && !pccOk) return null;

  if ((group.expenses ?? []).length === 0) {
    return {
      answer: "This group doesn't have any expenses yet, so there's nothing to ask about. Add a few and try again!",
      sources: [],
      confidence: 1,
      via: 'onDevice',
    };
  }

  const isoDate = new Date(opts.now ?? Date.now()).toISOString().slice(0, 10);
  const sessionId = `ask:${group.groupId}`;
  const obtainable = obtainableKinds(sources);
  let kinds: AiDataKind[] = ['balances', ...kindsSuggestedByQuestion(question).filter((k) => obtainable.includes(k))];

  const window = getOnDeviceContextSize() >= 4096 ? getOnDeviceContextSize() : 4096;
  const onDeviceBudget = window - RESERVE_TOKENS;
  const estimatedNeed =
    Math.min((group.expenses ?? []).length, 200) * APPROX_TOKENS_PER_EXPENSE_LINE + kinds.length * 400;

  // Fire-and-forget Siri/Spotlight donation (query is PII-redacted first).
  void donateAskActivity(redactPII(question));

  // Straight to PCC when on-device can't run or clearly can't hold the data.
  if (!onDeviceOk || (pccOk && estimatedNeed > onDeviceBudget * 2)) {
    try {
      return await answerViaPcc(question, group, currentUserId, kinds, sources, isoDate);
    } catch {
      if (!onDeviceOk) return null;
      // PCC failed (offline/quota) — fall through to on-device.
    }
  }

  const maxLines = maxExpensesForContext(window);

  // Plain question, no extra packs in play → stream from the persistent session.
  const extraKindsPossible = obtainable.some((k) => k !== 'expenses' && k !== 'balances');
  if (kinds.length === 1 && !extraKindsPossible) {
    return streamAnswer(question, group, currentUserId, sources, sessionId, isoDate, onDeviceBudget, maxLines, opts);
  }

  // Agentic loop: answer from current packs, or fetch what the model requests.
  try {
    let ctx = await buildGroundedContext(question, group, currentUserId, kinds, sources, onDeviceBudget, maxLines);
    for (let round = 0; round <= MAX_AGENTIC_ROUNDS; round += 1) {
      const remaining = obtainable.filter((k) => !ctx.includedKinds.includes(k));
      const available = remaining.map((k) => `${k} (${AI_DATA_KIND_DESCRIPTIONS[k]})`).join(', ') || 'none';
      const step = await askOnDeviceAgentic(sessionId, question, ctx.context, available, isoDate);
      const requested = coerceDataKinds(step.needsData).filter((k) => remaining.includes(k));
      if (step.answer.trim() && requested.length === 0) {
        return toGroundedAnswer(step.answer, step.sourceIndexes, ctx.selected, group, 'onDevice');
      }
      if (requested.length === 0 || round === MAX_AGENTIC_ROUNDS) break;
      kinds = [...kinds, ...requested];
      ctx = await buildGroundedContext(question, group, currentUserId, kinds, sources, onDeviceBudget, maxLines);
    }
    // Loop couldn't finish on-device — PCC has the window for everything at once.
    if (pccOk) {
      try {
        return await answerViaPcc(question, group, currentUserId, [...new Set([...kinds, ...obtainable])], sources, isoDate);
      } catch {
        // fall through to best-effort streamed answer
      }
    }
    return streamAnswer(question, group, currentUserId, sources, sessionId, isoDate, onDeviceBudget, maxLines, opts, kinds);
  } catch {
    if (pccOk) {
      try {
        return await answerViaPcc(question, group, currentUserId, kinds, sources, isoDate);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Streamed on-device ask over the packed context (partials via opts.onPartial). */
async function streamAnswer(
  question: string,
  group: Group,
  currentUserId: string,
  sources: AssistantDataSources,
  sessionId: string,
  isoDate: string,
  tokenBudget: number,
  maxLines: number,
  opts: OpenEndedOptions,
  kinds: readonly AiDataKind[] = ['balances'],
): Promise<GroundedAnswer | null> {
  const ctx = await buildGroundedContext(question, group, currentUserId, kinds, sources, tokenBudget, maxLines);
  const requestId = uid();
  const unsubscribe = opts.onPartial
    ? subscribeAiStream((e) => {
        if (e.requestId === requestId && !e.done) opts.onPartial?.(e.text);
      })
    : () => {};
  try {
    const res = await askOnDeviceStreamed(sessionId, requestId, question, ctx.context, groundedInstructions(isoDate));
    return toGroundedAnswer(res.answer, res.sourceIndexes, ctx.selected, group, 'onDevice');
  } catch {
    return null;
  } finally {
    unsubscribe();
  }
}
