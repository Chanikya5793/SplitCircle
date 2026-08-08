/**
 * insightsChatService.ts — orchestration for the insights chat overlay (doc 23).
 *
 * Hybrid routing, read-only:
 *  - group scope: money-math questions go to the DETERMINISTIC engine first
 *    (answerExpenseLocally — exact numbers, citations); everything else goes to
 *    the narrative model grounded in the current facts blob.
 *  - personal scope: narrative-only (facts numbers are final and quotable).
 *
 * Stateless model calls: every turn assembles instructions + facts + rolling
 * summary + recent verbatim turns (aiThreads.assembleInsightsPrompt), so cold
 * starts replay cleanly and the context budget stays under our control. When
 * assembly overflows, older turns are folded into thread.summary on-device.
 */

import type { Group } from '@/models';
import { noteTurn } from '@/services/aiFeedbackService';
import { runAgenticTurn } from '@/services/aiPipelineService';
import * as threadStore from '@/services/aiThreadStore';
import {
  processAssistantTurn,
  type ConversationState,
  type ProposedAction,
} from '@/services/assistantService';
import { tryPccPrompt } from '@/services/insightsAiService';
import { answerExpenseLocally } from '@/services/onDeviceAiService';
import { classifyMessage } from '@/utils/assistantChat';
import {
  assembleInsightsPrompt,
  deterministicThreadTitle,
  hashFacts,
  isSmallTalk,
  pickFreshInsight,
  repeatsRecent,
  selectRollup,
  shouldResumeThread,
  transcriptBlock,
  wantsFreshInsight,
  type AiThread,
  type AiThreadMessage,
} from '@/utils/aiThreads';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { stripModelDecorations } from '@/utils/aiText';
import { questionContext } from '@/utils/statsInsights';
import {
  generateOnDeviceText,
  getOnDeviceAiAvailability,
  getOnDeviceContextSize,
} from '../../modules/splitcircle-ai';

export const INSIGHTS_SURFACE = 'insights';
export const PERSONAL_SCOPE = 'personal';

/** Tokens reserved for the model's reply inside the context window. */
const RESPONSE_RESERVE = 1024;
const DEFAULT_CONTEXT = 4096;
/** PCC's 32K window, minus a generous reserve (doc 17 §3). */
const PCC_BUDGET = 24000;

const INSTRUCTIONS =
  "You are SplitCircle's spending-insights assistant, chatting about a group's " +
  'expense statistics. You are given FACTS blocks as JSON — every number in ' +
  'them is final. Rules:\n' +
  '- Answer the CURRENT question directly and conversationally.\n' +
  '- Quote numbers only from the FACTS blocks; NEVER compute, total, or invent numbers.\n' +
  '- NEVER repeat an earlier answer from the conversation. When asked for ' +
  'something new or more, pick a fact that has NOT been discussed yet; if ' +
  'everything notable is covered, say so briefly and suggest what to ask.\n' +
  '- Suggest practical next steps (budgets, settling up, reminders) but you ' +
  'cannot perform actions yourself.\n' +
  '- If a NOTE says the data changed since the conversation started, acknowledge it naturally.\n' +
  '- 1-3 short, friendly sentences. No lists, no JSON, no preamble.';

const RETRY_NUDGE =
  '\n(Important: your draft repeated an earlier answer. Give a DIFFERENT ' +
  'insight from the FACTS that has not been mentioned in this conversation.)';

/** The chat affordance only exists when a narrative model is live. */
export const insightsChatAvailable = (): boolean => getOnDeviceAiAvailability() === 'available';

// ── Write actions in insights chat (doc 24 P4) ───────────────────────────────

/** Confirm-card payload carried on an assistant message (`message.payload`). */
export interface ActionPayload {
  action: ProposedAction;
  state: 'pending' | 'done' | 'cancelled';
}

/** Message payload → typed action payload (payload is unknown by design). */
export function actionPayloadOf(payload: unknown): ActionPayload | null {
  const p = payload as ActionPayload | undefined;
  return p && typeof p === 'object' && p.action && typeof p.action.type === 'string' ? p : null;
}

/** Intents that delegate to the assistant's write machinery. `navigate` stays
 * out — the insights overlay has no navigation stack of its own. */
const WRITE_INTENTS = new Set([
  'add_expense', 'settle_up', 'delete_expense', 'edit_expense', 'delete_settlement', 'set_budget',
  'memory_add',
]);

/** Pending confirm cards older than this retire on thread resume (doc 17 A.7:
 * retire STALE cards, never an in-flight one). */
const STALE_CARD_MS = 10 * 60 * 1000;

const sweepStaleCards = (thread: AiThread, now: number): AiThread => {
  let changed = false;
  const messages = thread.messages.map((m) => {
    const p = actionPayloadOf(m.payload);
    if (p && p.state === 'pending' && now - m.createdAt > STALE_CARD_MS) {
      changed = true;
      return { ...m, payload: { ...p, state: 'cancelled' as const } };
    }
    return m;
  });
  return changed ? { ...thread, messages } : thread;
};

// ── User-selected engine (doc 23 rev: user chooses model) ────────────────────

export type EnginePref = 'auto' | 'ondevice' | 'pcc';
const ENGINE_PREF_KEY = 'insights_engine_v1';

export async function getEnginePref(): Promise<EnginePref> {
  try {
    const raw = await AsyncStorage.getItem(ENGINE_PREF_KEY);
    return raw === 'ondevice' || raw === 'pcc' ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

export async function setEnginePref(pref: EnginePref): Promise<void> {
  try {
    await AsyncStorage.setItem(ENGINE_PREF_KEY, pref);
  } catch {
    // Best-effort.
  }
}

const budgetTokens = (): number =>
  Math.max(1536, (getOnDeviceContextSize() || DEFAULT_CONTEXT) - RESPONSE_RESERVE);

const contextChip = (nowMs: number): AiThreadMessage => {
  const d = new Date(nowMs);
  return {
    id: threadStore.newMessageId(),
    role: 'context',
    text: `Context updated · ${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}`,
    createdAt: nowMs,
  };
};

export interface OpenThreadResult {
  thread: AiThread;
  /** True when this open injected fresh facts into an older thread. */
  driftDetected: boolean;
}

/**
 * Resume the scope's latest thread (injecting fresh facts + a context chip when
 * the data drifted) or seed a new one from the current narrative.
 */
export async function openInsightsThread(args: {
  scope: string;
  facts: string;
  narrative: string;
  seedTitle: string;
  /** Which engine wrote the narrative — the seed message's badge. */
  seedSource?: 'ondevice' | 'pcc';
  forceNew?: boolean;
}): Promise<OpenThreadResult> {
  const now = Date.now();
  const factsHash = hashFacts(args.facts);

  // Fresh-by-default (doc 23 rev): auto-resume ONLY a recent thread — mid-
  // session continuity — never yesterday's conversation. Older threads stay
  // one tap away in history.
  if (!args.forceNew) {
    const existing = await threadStore.latestThread(INSIGHTS_SURFACE, args.scope);
    if (existing && shouldResumeThread(existing, now)) {
      // Doc 17 A.7 / doc 24 P4: retire STALE pending confirm cards on resume
      // (never fresh ones — a mid-flow draft survives an app switch).
      const swept = sweepStaleCards(existing, now);
      if (swept.factsHash !== factsHash) {
        const drifted: AiThread = {
          ...swept,
          factsHash,
          messages: [...swept.messages, contextChip(now)],
        };
        return { thread: await threadStore.saveThread(drifted), driftDetected: true };
      }
      return {
        thread: swept === existing ? existing : await threadStore.saveThread(swept),
        driftDetected: false,
      };
    }
  }

  const seed: AiThreadMessage = {
    id: threadStore.newMessageId(),
    role: 'assistant',
    text: args.narrative,
    source: args.seedSource ?? 'ondevice',
    createdAt: now,
  };
  const thread = await threadStore.createThread({
    surface: INSIGHTS_SURFACE,
    scope: args.scope,
    title: deterministicThreadTitle(args.seedTitle, now),
    factsHash,
    messages: [seed],
  });
  return { thread, driftDetected: false };
}

export interface SendResult {
  thread: AiThread;
  reply: AiThreadMessage;
}

/**
 * Run one chat turn: append the user message, answer (deterministic-first for
 * group scope, narrative otherwise), roll up old turns if the prompt
 * overflowed, and refresh the title after the first real exchange.
 */
export async function sendInsightsMessage(args: {
  thread: AiThread;
  userText: string;
  facts: string;
  /** Heuristic insight cards — the deterministic "something new" inventory. */
  cards?: { title: string; body: string }[];
  /** Present for group scope — enables the deterministic exact-answer path. */
  group?: Group;
  currentUserId?: string;
  /** Personal scope: cross-group rows for the agentic personal tools (doc 24). */
  personalGroups?: { groupId: string; name: string; currency: string; expenses?: Group['expenses'] }[];
  /** The group's chat id (doc 24 P5) — unlocks on-device-only chat_search. */
  chatId?: string;
  /** True when this thread was resumed against changed data. */
  drifted?: boolean;
  /** User-selected engine (doc 23 rev). Defaults to 'auto'. */
  engine?: EnginePref;
  /** P2 — loop progress line for the pending bubble ("Pulling April 2026…"). */
  onStatus?: (line: string) => void;
  /** P2 — streamed narration (cleaned accumulated text). Final reply is authoritative. */
  onDelta?: (partial: string) => void;
}): Promise<SendResult> {
  const now = Date.now();
  const userMsg: AiThreadMessage = {
    id: threadStore.newMessageId(),
    role: 'user',
    text: args.userText,
    createdAt: now,
  };

  let reply: AiThreadMessage | null = null;

  // 0) Small talk never reaches a model (doc 17's #1 lesson): instant friendly
  //    reply, no engine badge — no engine was involved.
  if (isSmallTalk(args.userText)) {
    reply = {
      id: threadStore.newMessageId(),
      role: 'assistant',
      text:
        `Hey! I'm here to talk through ${args.group?.name ?? 'your'} spending. ` +
        'Ask me why a category changed, about a month, a member, or a merchant — ' +
        'or say "summary" for exact totals.',
      createdAt: Date.now(),
    };
  }

  // 0b) "Something new / what else" — serve the next UNUSED heuristic insight
  //     card verbatim. Real, pre-written, deterministic; the small model loops
  //     on open-ended asks, so it never gets them.
  if (!reply && args.cards?.length && wantsFreshInsight(args.userText)) {
    const fresh = pickFreshInsight(args.cards, args.thread.messages);
    reply = {
      id: threadStore.newMessageId(),
      role: 'assistant',
      text: fresh
        ? `${fresh.title} — ${fresh.body}`
        : "That's everything notable I see in the current data — ask about a " +
          'specific category, member, month, or merchant, or say "summary" for exact totals.',
      source: fresh ? 'deterministic' : undefined,
      createdAt: Date.now(),
    };
  }

  // 1) Deterministic engine first — exact numbers with citations, no model.
  if (!reply && args.group && args.currentUserId) {
    try {
      const local = answerExpenseLocally(args.userText, args.group, args.currentUserId);
      if (local) {
        reply = {
          id: threadStore.newMessageId(),
          role: 'assistant',
          text: local.answer,
          source: 'deterministic',
          sources: local.sources,
          createdAt: Date.now(),
        };
      }
    } catch {
      // Fall through to the narrative model.
    }
  }

  // 0c) WRITE actions (doc 24 P4): action-shaped messages and in-progress
  //     action flows delegate to the assistant's proven machinery — same
  //     slot-filling, same ProposedAction, model never writes. Conversation
  //     state rides thread.meta so multi-turn drafts survive.
  let assistantStatePatch: ConversationState | null = null;
  if (!reply && args.group && args.currentUserId) {
    const prevState = (args.thread.meta?.assistantState as ConversationState | undefined) ?? {};
    const midFlow = !!(prevState.pending || prevState.lastProposed);
    const intent = classifyMessage(
      args.userText,
      args.group.members.map((m) => ({ userId: m.userId, displayName: m.displayName })),
    );
    if (WRITE_INTENTS.has(intent) || midFlow) {
      const turn = await processAssistantTurn(args.userText, args.group, args.currentUserId, prevState);
      assistantStatePatch = turn.state;
      const payload: ActionPayload | undefined =
        turn.action && turn.action.type !== 'navigate'
          ? { action: turn.action, state: 'pending' }
          : undefined;
      reply = {
        id: threadStore.newMessageId(),
        role: 'assistant',
        text: turn.reply,
        options: turn.choices,
        payload,
        createdAt: Date.now(),
      };
    }
  }

  // 1b) Agentic pipeline (doc 24 P1): router → data loop → adaptive narration,
  // with ask-back clarify chips. Null (old binary / flag off / no reply) falls
  // through to the legacy one-shot narrative below — never worse than before.
  if (!reply) {
    const last = args.thread.messages[args.thread.messages.length - 1];
    const turn = await runAgenticTurn({
      thread: args.thread,
      userText: args.userText,
      facts: args.facts,
      group: args.group,
      currentUserId: args.currentUserId ?? '',
      personalGroups: args.personalGroups,
      chatId: args.chatId,
      engine: args.engine,
      drifted: args.drifted,
      resolvedClarify: last?.role === 'clarify',
      onStatus: args.onStatus,
      onDelta: args.onDelta,
    });
    if (turn) {
      reply = {
        id: threadStore.newMessageId(),
        role: turn.role === 'clarify' ? 'clarify' : 'assistant',
        text: turn.text,
        source: turn.source,
        options: turn.options,
        assumption: turn.assumption,
        evidence: turn.evidence,
        createdAt: Date.now(),
      };
      // Doc 25: register the turn snapshot so a later 👎 can capture it.
      noteTurn(reply.id, turn.trace);
    }
  }

  // 2) LEGACY narrative model grounded in facts + thread memory. When the
  // question names a month/category/member/merchant, targeted deterministic
  // aggregates ride along (doc 23 enrichment) so the model isn't limited to
  // the top-5 summary facts. Runs only when the agentic pipeline declined.
  if (!reply) {
    const extraFacts = args.group
      ? questionContext(args.userText, args.group.expenses ?? [], args.group.members ?? [], now)
      : null;
    const assembleWith = (budget: number, instructions = INSTRUCTIONS) =>
      assembleInsightsPrompt({
        instructions,
        facts: args.facts,
        extraFacts: extraFacts ?? undefined,
        summary: args.thread.summary,
        messages: [...args.thread.messages, userMsg],
        userText: args.userText,
        budgetTokens: budget,
        driftNote: args.drifted
          ? 'The group data has changed since this conversation started — the facts below are current.'
          : '',
      });

    const assembled = assembleWith(budgetTokens());
    const engine = args.engine ?? 'auto';
    let text = '';
    let source: 'ondevice' | 'pcc' = 'ondevice';

    // User picked PCC → it answers first with the big window. Auto escalates
    // only on overflow (doc 17 §C.2). Either way tryPccPrompt is a no-op until
    // entitlement/eligibility — the badge always shows what actually ANSWERED.
    if (engine === 'pcc' || (engine === 'auto' && assembled.needsRollup)) {
      const viaPcc = await tryPccPrompt(assembleWith(PCC_BUDGET).prompt);
      if (viaPcc) {
        text = viaPcc;
        source = 'pcc';
      }
    }

    if (!text) {
      try {
        // generateText (not askOnDevice): the assembled prompt carries the
        // real instructions; the Q&A door's numbered-lines persona fought
        // them and produced deflections/Q&A phrasing.
        text = (await generateOnDeviceText(assembled.prompt)).trim();
      } catch {
        // On-device failed mid-session — PCC below is the last resort.
      }
    }
    // On-device-only mode never falls through to PCC.
    if (!text && engine !== 'ondevice') {
      const viaPcc = await tryPccPrompt(assembled.prompt);
      if (viaPcc) {
        text = viaPcc;
        source = 'pcc';
      }
    }
    // Strip BEFORE the empty check — pure-markdown junk strips to '', which
    // must fail over to the error path, never ship as an empty bubble.
    text = stripModelDecorations(text);
    if (!text) throw new Error('No model available for a reply.');

    // Anti-loop guard: small models echo themselves. One nudged retry, then
    // an honest fallback — a repeat is never shipped as an answer.
    if (repeatsRecent(text, args.thread.messages)) {
      try {
        const retry = await generateOnDeviceText(
          assembleWith(budgetTokens(), INSTRUCTIONS + RETRY_NUDGE).prompt,
        );
        const retryText = stripModelDecorations(retry);
        if (retryText && !repeatsRecent(retryText, args.thread.messages)) {
          text = retryText;
          source = 'ondevice';
        } else {
          text = '';
        }
      } catch {
        text = '';
      }
      if (!text) {
        reply = {
          id: threadStore.newMessageId(),
          role: 'assistant',
          text:
            "I've covered that already — try asking about a specific category, " +
            'member, month, or merchant, or say "summary" for exact totals.',
          createdAt: Date.now(),
        };
      }
    }

    if (!reply) {
      reply = {
        id: threadStore.newMessageId(),
        role: 'assistant',
        text,
        source,
        createdAt: Date.now(),
      };
    }
  }

  let thread: AiThread = {
    ...args.thread,
    ...(assistantStatePatch != null
      ? { meta: { ...args.thread.meta, assistantState: assistantStatePatch } }
      : {}),
    messages: [...args.thread.messages, userMsg, reply],
  };
  thread = await rollupIfNeeded(thread, args.facts);
  thread = await ensureTitle(thread);
  thread = await threadStore.saveThread(thread);
  return { thread, reply };
}

/**
 * Resolve a confirm card (doc 24 P4): flip its payload state, clear the
 * assistant draft state, optionally append a confirmation line, persist.
 * The EXECUTION of the action happens in the UI layer (GroupContext mutators)
 * BEFORE calling this with outcome 'done'.
 */
export async function resolveInsightsAction(args: {
  thread: AiThread;
  messageId: string;
  outcome: 'done' | 'cancelled';
  confirmationText?: string;
}): Promise<AiThread> {
  const messages = args.thread.messages.map((m) => {
    if (m.id !== args.messageId) return m;
    const p = actionPayloadOf(m.payload);
    return p ? { ...m, payload: { ...p, state: args.outcome } } : m;
  });
  let thread: AiThread = {
    ...args.thread,
    messages,
    meta: { ...args.thread.meta, assistantState: {} },
  };
  if (args.confirmationText) {
    thread = {
      ...thread,
      messages: [
        ...thread.messages,
        {
          id: threadStore.newMessageId(),
          role: 'assistant',
          text: args.confirmationText,
          createdAt: Date.now(),
        },
      ],
    };
  }
  return threadStore.saveThread(thread);
}

/** Fold older verbatim turns into the rolling summary when the prompt overflows. */
async function rollupIfNeeded(thread: AiThread, facts: string): Promise<AiThread> {
  const probe = assembleInsightsPrompt({
    instructions: INSTRUCTIONS,
    facts,
    summary: thread.summary,
    messages: thread.messages,
    userText: '',
    budgetTokens: budgetTokens(),
  });
  if (!probe.needsRollup) return thread;

  const { fold } = selectRollup(thread.messages);
  if (fold.length === 0) return thread;
  try {
    const result = await generateOnDeviceText(
      (thread.summary ? `EARLIER SUMMARY:\n${thread.summary}\n\n` : '') +
        `CONVERSATION:\n${transcriptBlock(fold)}`,
      'You summarize a conversation between a user and a spending-insights ' +
        'assistant in 3-4 short factual sentences: what was asked, what was ' +
        'concluded, any suggestions made. Plain text only, no preamble.',
      { deterministic: true },
    );
    const summary = stripModelDecorations(result);
    if (!summary) return thread;
    const foldIds = new Set(fold.map((m) => m.id));
    return {
      ...thread,
      summary,
      messages: thread.messages.map((m) => (foldIds.has(m.id) ? { ...m, inSummary: true } : m)),
    };
  } catch {
    return thread; // Prompt assembly already drops overflow turns — safe to skip.
  }
}

/** Model-written 3–5 word title after the first real exchange (once). */
async function ensureTitle(thread: AiThread): Promise<AiThread> {
  if (thread.meta?.titled === true) return thread;
  const hasExchange =
    thread.messages.some((m) => m.role === 'user') &&
    thread.messages.filter((m) => m.role === 'assistant').length >= 2; // seed + one reply
  if (!hasExchange) return thread;
  try {
    const result = await generateOnDeviceText(
      transcriptBlock(thread.messages.slice(-6)),
      'Write a 3-5 word title for this conversation about group spending. ' +
        'Reply with the title only — plain words, no quotes, no punctuation, no emoji.',
      { deterministic: true },
    );
    const title = stripModelDecorations(result)
      .replace(/^title:\s*/i, '')
      .replace(/["'.]/g, '')
      .slice(0, 40);
    return { ...thread, title: title || thread.title, meta: { ...thread.meta, titled: true } };
  } catch {
    return { ...thread, meta: { ...thread.meta, titled: true } };
  }
}
