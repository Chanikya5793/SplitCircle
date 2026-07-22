/**
 * aiPipelineService.ts — the one-brain agentic turn orchestrator (doc 24 §3).
 *
 * Owns steps 2-5 of a turn: router → data loop → narration. The surfaces keep
 * their deterministic guards and exact fast path (answerExpenseLocally) and
 * call `runAgenticTurn` where they previously fell through to the one-shot
 * model. Returns null whenever the pipeline can't produce a reply (binary too
 * old, model unavailable, narration failed) — callers fall back to the legacy
 * path, so this can never make things worse than before.
 *
 * P1 scope: complete (non-streamed) answers; loop hops always on-device; PCC
 * used only for narration overflow/failure or the user's 'pcc' engine pick
 * (complexity-based depth routing is P3). Every model call rides serializeFm.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Group } from '@/models';
import { tryPccPrompt } from '@/services/insightsAiService';
import { hashFacts, repeatsRecent, type AiThread } from '@/utils/aiThreads';
import {
  ANSWER_CACHE_CAP,
  THREAD_TAIL_CAP,
  TRACE_FACTS_CAP,
  TRACE_JSON_CAP,
  answerCacheKey,
  capText,
  type TurnTrace,
} from '@/utils/aiFeedback';
import {
  MAX_HOPS,
  LOOP_WALL_MS,
  assembleHopPrompt,
  assembleNarratorPrompt,
  assembleRouterPrompt,
  coerceDecision,
  coerceLoopStep,
  loopInstructions,
  narratorInstructions,
  routerInstructions,
  type AgentDecision,
} from '@/utils/aiLoop';
import {
  executeToolRequests,
  statusLineFor,
  toolCatalog,
  toolTier,
  type CallStatsResult,
  type ChatSearchResult,
  type ToolCtx,
  type ToolRequest,
  type ToolResult,
} from '@/utils/aiTools';
import { getCallHistory } from '@/services/localCallStorage';
import { getChatMessages } from '@/services/localMessageStorage';
import {
  getEntityFixes,
  getInjection as getMemoryInjection,
  recordClarifyPick,
  recordTurnPattern,
} from '@/services/aiMemoryService';
import { extractClarifyAlias } from '@/utils/aiMemory';
import type { Timeframe } from '@/utils/expenseAnalytics';
import { numbersGrounded, stripChatDecorations } from '@/utils/aiText';
import {
  agentLoopStep,
  generateOnDeviceText,
  generateOnDeviceTextStreamed,
  getOnDeviceAiAvailability,
  getOnDeviceContextSize,
  isAgenticNativeAvailable,
  routeTurn,
} from '../../modules/splitcircle-ai';

// ── Feature flag (doc 24 P1: capability-gated, default ON) ───────────────────

const PIPELINE_FLAG_KEY = 'ai_pipeline_v1';

export async function getAgenticPipelineEnabled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(PIPELINE_FLAG_KEY);
    return raw == null ? true : raw === 'true';
  } catch {
    return true;
  }
}

export async function setAgenticPipelineEnabled(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(PIPELINE_FLAG_KEY, String(enabled));
  } catch {
    // Best-effort.
  }
}

/** Flag AND binary AND model — old binaries auto-stay on the legacy path. */
export async function agenticPipelineActive(): Promise<boolean> {
  if (!isAgenticNativeAvailable()) return false;
  if (getOnDeviceAiAvailability() !== 'available') return false;
  return getAgenticPipelineEnabled();
}

// ── Turn API ─────────────────────────────────────────────────────────────────

export interface AgenticTurnArgs {
  /** "the group Goa Trip" vs personal — drives instructions + tool scope. */
  scopeLabel?: string;
  thread: AiThread;
  userText: string;
  /** Base facts blob (buildStatsFacts / assistant facts). Final numbers. */
  facts: string;
  group?: Group;
  currentUserId: string;
  personalGroups?: { groupId: string; name: string; currency: string; expenses?: Group['expenses'] }[];
  /** The group's chat id (doc 24 P5) — unlocks the on-device-only chat_search tool. */
  chatId?: string;
  recurringMonthly?: number;
  recurringBills?: { title: string; amount: number; frequency?: string }[];
  drifted?: boolean;
  /** True when this message answers a clarify chip — never re-clarify. */
  resolvedClarify?: boolean;
  engine?: 'auto' | 'ondevice' | 'pcc';
  /** Loop progress ("Pulling April 2026…") — rendered from P2; safe to omit. */
  onStatus?: (line: string) => void;
  /**
   * P2 — live narration: called with the CLEANED accumulated text as it
   * streams. The returned reply text is authoritative (it passed the
   * grounding/repeat gates); a rejected streamed draft is replaced silently.
   */
  onDelta?: (partial: string) => void;
  /** Doc 25 — eval replay: bypass the answer cache and never write to it. */
  replay?: boolean;
}

export interface AgenticReply {
  role: 'assistant' | 'clarify';
  text: string;
  source?: 'ondevice' | 'pcc';
  /** Clarify chips (role 'clarify'). */
  options?: string[];
  /** Stated reading under mild ambiguity — rendered as a caption (doc 24). */
  assumption?: string;
  /** Doc 25 — the full turn snapshot; a 👎 turns it into an eval fixture. */
  trace?: TurnTrace;
}

// Per-turn answer cache (doc 25 latency polish): identical question over
// identical facts returns instantly. Session-only; local-tier turns are never
// cached (chat/call data can change without moving the facts hash).
const answerCache = new Map<string, { reply: AgenticReply; trace: TurnTrace }>();

/** Test hook — the cache is module-global and would bleed between specs. */
export function clearAgenticAnswerCache(): void {
  answerCache.clear();
}

/** PCC's 32K window minus a generous reserve (doc 17 §3). */
const PCC_BUDGET = 24_000;
const RESPONSE_RESERVE = 1024;
const DEFAULT_CONTEXT = 4096;

const budgetTokens = (): number =>
  Math.max(1536, (getOnDeviceContextSize() || DEFAULT_CONTEXT) - RESPONSE_RESERVE);

const dateLine = (now: number): string =>
  new Date(now).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

const GROUNDING_NUDGE =
  '\n- IMPORTANT: your previous draft contained a number that is NOT in FACTS/TOOL RESULTS, or repeated an earlier answer. Write a fresh reply using only numbers present in the blocks.';

const shortDate = (ms: number): string =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/**
 * LOCAL-TIER providers (doc 24 P5). This data lives only on the device (the
 * app's Local storage tier) and the tools it feeds pin the turn on-device —
 * assembled prompts containing it never reach PCC.
 */
function chatSearchProvider(
  chatId: string,
  nameOf: (userId: string) => string,
): NonNullable<ToolCtx['chatSearch']> {
  return async (query: string, tf: Timeframe | null): Promise<ChatSearchResult> => {
    const messages = await getChatMessages(chatId);
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
    const hits = messages.filter(
      (m) =>
        typeof m.content === 'string' &&
        m.content.length > 0 &&
        (!tf || (m.createdAt >= tf.startMs && m.createdAt <= tf.endMs)) &&
        terms.some((t) => m.content.toLowerCase().includes(t)),
    );
    return {
      matches: hits.length,
      rows: hits.slice(-5).map((m) => ({
        text: m.content.slice(0, 140),
        from: nameOf(m.senderId),
        date: shortDate(m.createdAt),
      })),
    };
  };
}

function callStatsProvider(chatId: string | undefined): NonNullable<ToolCtx['callStats']> {
  return async (member: string | undefined, tf: Timeframe | null): Promise<CallStatsResult> => {
    const rows = await getCallHistory();
    const q = (member ?? '').toLowerCase();
    const filtered = rows.filter(
      (r) =>
        (!chatId || r.chatId === chatId) &&
        (!tf || (r.startedAt >= tf.startMs && r.startedAt <= tf.endMs)) &&
        (!q || r.otherParticipant.displayName.toLowerCase().includes(q)),
    );
    const last = filtered.reduce<number | null>(
      (mx, r) => (mx == null || r.startedAt > mx ? r.startedAt : mx),
      null,
    );
    return {
      calls: filtered.length,
      totalMinutes: Math.round(filtered.reduce((s, r) => s + (r.duration || 0), 0) / 60),
      missed: filtered.filter((r) => r.status === 'missed').length,
      lastCall: last == null ? null : shortDate(last),
    };
  };
}

/** Build the ToolCtx the registry executes against. */
function buildToolCtx(a: AgenticTurnArgs, now: number): ToolCtx {
  return {
    now,
    currentUserId: a.currentUserId,
    group: a.group
      ? {
          groupId: a.group.groupId,
          name: a.group.name,
          currency: a.group.currency || 'USD',
          members: (a.group.members ?? []).map((m) => ({ userId: m.userId, displayName: m.displayName })),
          expenses: a.group.expenses ?? [],
          settlements: a.group.settlements ?? [],
          budgets: a.group.budgets,
          updatedAt: a.group.updatedAt,
        }
      : undefined,
    personalGroups: a.personalGroups,
    recurringMonthly: a.recurringMonthly,
    recurringBills: a.recurringBills,
    chatSearch:
      a.chatId && a.group
        ? chatSearchProvider(
            a.chatId,
            (userId) =>
              a.group?.members?.find((m) => m.userId === userId)?.displayName ?? 'someone',
          )
        : undefined,
    callStats: callStatsProvider(a.chatId),
  };
}

/**
 * Run one agentic turn: route → gather (≤3 loop hops, ~10s wall) → narrate.
 * Returns null when no reply could be produced — the caller's legacy path is
 * the safety net. Never throws.
 */
export async function runAgenticTurn(args: AgenticTurnArgs): Promise<AgenticReply | null> {
  try {
    if (!(await agenticPipelineActive())) return null;
    const started = Date.now();
    const now = started;

    // A message that directly follows a clarify IS its answer — infer here so
    // every caller gets loop-proof ask-backs without extra plumbing.
    const lastMsg = args.thread.messages[args.thread.messages.length - 1];
    const resolvedClarify = args.resolvedClarify === true || lastMsg?.role === 'clarify';
    const memScope = args.group ? `group:${args.group.groupId}` : 'personal';

    // Doc 25 Q2 — silent entity-fix learning: a message answering a clarify
    // whose options shared an ambiguous alias records the pick; two consistent
    // picks promote a fix and the alias never asks again. This runs BEFORE the
    // answer cache — an answered clarify must teach even when the reply is a
    // cache hit — and is awaited so the write can't race the next turn.
    if (
      !args.replay &&
      resolvedClarify &&
      lastMsg?.role === 'clarify' &&
      (lastMsg.options?.length ?? 0) >= 2
    ) {
      const priorUser = [...args.thread.messages].reverse().find((m) => m.role === 'user');
      const alias = extractClarifyAlias(priorUser?.text ?? '', lastMsg.options ?? []);
      const choice = lastMsg.options?.find(
        (o) => o.trim().toLowerCase() === args.userText.trim().toLowerCase(),
      );
      if (alias && choice) await recordClarifyPick(memScope, alias, choice);
    }

    // Doc 25: exact-repeat questions over unchanged facts answer instantly.
    const factsHash = hashFacts(args.facts);
    const cacheKey = answerCacheKey(
      args.thread.surface,
      args.thread.scope,
      factsHash,
      args.userText,
      args.engine ?? 'auto',
      resolvedClarify,
    );
    if (!args.replay) {
      const hit = answerCache.get(cacheKey);
      if (hit) return { ...hit.reply, trace: hit.trace };
    }

    const ctx = buildToolCtx(args, now);
    const g = ctx.group;
    // Doc 25 Q2 — memory rides every turn: the MEMORY block into instructions
    // (user chose it may reach PCC too) and entity fixes into the tool layer.
    const memScopes = ['global', memScope];
    const [memoryBlock, entityFixes] = await Promise.all([
      getMemoryInjection(memScopes),
      getEntityFixes(memScopes),
    ]);
    if (Object.keys(entityFixes).length > 0) ctx.entityFixes = entityFixes;
    const withMemory = (instructions: string): string =>
      memoryBlock ? `${instructions}\n\n${memoryBlock}` : instructions;
    const scopeLabel =
      args.scopeLabel ?? (g ? `the group "${g.name}"` : 'your personal spending across all groups');
    const categories = g
      ? [...new Set(g.expenses.map((e) => ((e.category ?? 'General').trim() || 'General')))]
      : [];
    // P5 privacy rule: local-tier tools (chat/calls) are never OFFERED when the
    // user pinned Private Cloud; on 'auto' they're offered, and using one pins
    // the whole turn on-device (narration included).
    const includeLocal = (args.engine ?? 'auto') !== 'pcc';
    const filter = { includeLocal };
    const catalog = toolCatalog(ctx, filter);
    const date = dateLine(now);

    // ── Step 2: router ──────────────────────────────────────────────────────
    const routerPrompt = assembleRouterPrompt({
      facts: args.facts,
      summary: args.thread.summary,
      messages: args.thread.messages,
      userText: args.userText,
      budgetTokens: budgetTokens(),
      driftNote: args.drifted
        ? 'The data has changed since this conversation started — the facts below are current.'
        : '',
      resolvedClarify,
    });
    const decision: AgentDecision = coerceDecision(
      await routeTurn(
        withMemory(
          routerInstructions({
            scopeLabel,
            memberNames: g ? g.members.map((m) => m.displayName).filter(Boolean) : [],
            categories,
            dateLine: date,
            toolCatalog: catalog,
          }),
        ),
        routerPrompt.prompt,
      ),
    );

    // Doc 25 Q2 — observed-pattern counters (toggle-respected in the service).
    if (!args.replay && decision.requests.length > 0) {
      void recordTurnPattern(memScopes[1], {
        category: decision.requests[0].category,
        period: decision.requests[0].month,
      });
    }

    // Doc 25 trace scaffolding — hoisted so every return path can snapshot.
    const results: ToolResult[] = [];
    const executedRequests: { tool: string; args: string }[] = [];
    let loopSteps = 0;
    // True once a local-tier tool ran — the turn is pinned on-device (doc 24 P5).
    let usedLocal = false;
    const makeTrace = (reply: {
      role: 'assistant' | 'clarify';
      text: string;
      source?: 'ondevice' | 'pcc';
    }): TurnTrace => ({
      at: now,
      surface: args.thread.surface,
      scope: args.thread.scope,
      userText: args.userText,
      facts: capText(args.facts, TRACE_FACTS_CAP),
      factsHash,
      engine: args.engine ?? 'auto',
      intent: decision.intent,
      complexity: decision.complexity,
      assumption: decision.assumption || undefined,
      hops: loopSteps,
      requests: executedRequests,
      results: results.map((r) => ({
        tool: r.tool,
        label: r.label,
        json: capText(r.json, TRACE_JSON_CAP),
        error: r.error,
      })),
      usedLocal,
      source: reply.source,
      replyRole: reply.role,
      replyText: reply.text,
      durationMs: Date.now() - started,
      threadTail: args.thread.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'clarify')
        .slice(-THREAD_TAIL_CAP)
        .map((m) => ({ role: m.role, text: capText(m.text, 300) })),
    });

    if (decision.intent === 'abstain') {
      const reply: AgenticReply = {
        role: 'assistant',
        text:
          stripChatDecorations(decision.abstainReply) ||
          `Hey! Ask me anything about ${g ? `${g.name}'s` : 'your'} spending — a month, a person, a category, or say "summary" for exact totals.`,
        source: 'ondevice',
      };
      return { ...reply, trace: makeTrace({ role: 'assistant', text: reply.text, source: 'ondevice' }) };
    }

    if (decision.intent === 'clarify' && !resolvedClarify) {
      const reply: AgenticReply = {
        role: 'clarify',
        text: decision.clarifyQuestion,
        options: decision.clarifyOptions,
        source: 'ondevice',
      };
      return { ...reply, trace: makeTrace({ role: 'clarify', text: reply.text, source: 'ondevice' }) };
    }

    // ── Step 4: data loop (router's requests are hop 1) ─────────────────────
    const seenKeys = new Set<string>();
    let requests: ToolRequest[] = decision.requests;
    while (requests.length > 0) {
      if (args.onStatus) args.onStatus(statusLineFor(requests[0], ctx));
      if (includeLocal && requests.some((r) => toolTier(r.tool) === 'local')) usedLocal = true;
      executedRequests.push(
        ...requests.map((r) => ({
          tool: r.tool,
          args: [r.month, r.monthB, r.category, r.member, r.merchant, r.query]
            .filter(Boolean)
            .join(' '),
        })),
      );
      results.push(...(await executeToolRequests(requests, ctx, seenKeys, filter)));
      requests = [];
      // Ask "enough?" only while hops + time remain (router + narrator excluded
      // from MAX_HOPS' loop share: ≤ MAX_HOPS-1 step calls).
      if (loopSteps >= MAX_HOPS - 1 || Date.now() - started > LOOP_WALL_MS) break;
      if (results.length === 0) break;
      try {
        loopSteps += 1;
        const step = coerceLoopStep(
          await agentLoopStep(
            loopInstructions(catalog),
            assembleHopPrompt({
              userText: args.userText,
              results,
              hop: loopSteps,
              maxHops: MAX_HOPS - 1,
            }),
          ),
        );
        if (step.done) break;
        requests = step.requests;
      } catch {
        break; // Loop-step failure isn't fatal — narrate what we have.
      }
    }

    // A member arg that matched several people surfaces as ambiguity data —
    // turn it into a clarify with the candidates as chips (doc 24 §6).
    if (!resolvedClarify) {
      for (const r of results) {
        try {
          const parsed = JSON.parse(r.json) as { ambiguous?: string[] };
          if (parsed.ambiguous && parsed.ambiguous.length >= 2) {
            const reply: AgenticReply = {
              role: 'clarify',
              text: `Which one do you mean?`,
              options: parsed.ambiguous.slice(0, 4),
              source: 'ondevice',
            };
            return { ...reply, trace: makeTrace({ role: 'clarify', text: reply.text, source: 'ondevice' }) };
          }
        } catch {
          // Non-JSON results can't carry ambiguity.
        }
      }
    }

    // ── Step 5: narration (complete answers in P1 — streaming is P2) ────────
    if (args.onStatus) args.onStatus('Writing it up…');
    const narratorArgs = {
      scopeLabel,
      currency: g ? g.currency || 'USD' : 'each group’s own currency',
      dateLine: date,
    };
    const assemble = (budget: number) =>
      assembleNarratorPrompt({
        facts: args.facts,
        results,
        assumption: decision.assumption || undefined,
        summary: args.thread.summary,
        messages: args.thread.messages,
        userText: args.userText,
        budgetTokens: budget,
        driftNote: args.drifted
          ? 'The data has changed since this conversation started — the facts below are current.'
          : '',
      });

    const assembled = assemble(budgetTokens());
    const grounding = [args.facts, ...results.map((r) => r.json)].join('\n');
    const engine = args.engine ?? 'auto';
    const overflow = assembled.tokens > budgetTokens();

    // P3 depth routing (doc 24): router-judged deep turns go PCC-first with
    // real reasoning; an explicit analyze ask earns .deep. On-device pref pins
    // local; PCC unavailability falls through gracefully (badge stays honest).
    const deepTurn = decision.complexity === 'deep';
    const wantsDeep = /\b(analy[sz]e|deep ?dive|in depth|thorough(ly)?|detailed breakdown)\b/i.test(
      args.userText,
    );
    const reasoning: 'light' | 'moderate' | 'deep' = deepTurn
      ? wantsDeep
        ? 'deep'
        : 'moderate'
      : 'light';

    let text = '';
    let source: 'ondevice' | 'pcc' = 'ondevice';

    const narrateOnDevice = async (nudge = ''): Promise<string> => {
      const instr = withMemory(narratorInstructions(narratorArgs)) + nudge;
      // Stream only the FIRST draft — a retry after a failed gate would
      // re-stream text the UI already replaced.
      if (args.onDelta && !nudge) {
        const { promise } = generateOnDeviceTextStreamed(assembled.prompt, instr, (_delta, full) => {
          args.onDelta?.(stripChatDecorations(full));
        });
        return stripChatDecorations(await promise);
      }
      const out = await generateOnDeviceText(assembled.prompt, instr);
      return stripChatDecorations(out);
    };
    const narratePcc = async (): Promise<string> => {
      const big = assemble(PCC_BUDGET);
      // Memory may ride PCC prompts — explicit doc-25 user decision.
      const out = await tryPccPrompt(big.prompt, withMemory(narratorInstructions(narratorArgs)), reasoning);
      return stripChatDecorations(out ?? '');
    };

    // Local-tier pin: a turn that touched chat/call data NEVER narrates on PCC
    // — the assembled prompt carries that data (doc 24 privacy-tier rule).
    const pccAllowed = !usedLocal;
    if (pccAllowed && (engine === 'pcc' || (engine === 'auto' && (overflow || deepTurn)))) {
      if (deepTurn && args.onStatus) args.onStatus('Thinking deeper in Private Cloud…');
      text = await narratePcc();
      if (text) source = 'pcc';
    }
    if (!text) {
      try {
        text = await narrateOnDevice();
        source = 'ondevice';
      } catch {
        text = '';
      }
    }
    if (!text && engine !== 'ondevice' && pccAllowed) {
      text = await narratePcc();
      if (text) source = 'pcc';
    }
    if (!text) return null;

    // Quality gates: grounded numbers + no self-repeats. One nudged retry.
    const bad = (t: string): boolean =>
      !t || !numbersGrounded(t, grounding) || repeatsRecent(t, args.thread.messages);
    if (bad(text)) {
      try {
        const retry = await narrateOnDevice(GROUNDING_NUDGE);
        text = bad(retry) ? '' : retry;
        source = 'ondevice';
      } catch {
        text = '';
      }
    }
    if (!text) return null;

    const reply: AgenticReply = {
      role: 'assistant',
      text,
      source,
      assumption: decision.assumption || undefined,
    };
    const trace = makeTrace({ role: 'assistant', text, source });
    // Cache exact-repeat answers (never local-tier turns, never during replay).
    if (!args.replay && !usedLocal) {
      answerCache.set(cacheKey, { reply, trace });
      if (answerCache.size > ANSWER_CACHE_CAP) {
        const oldest = answerCache.keys().next().value;
        if (oldest != null) answerCache.delete(oldest);
      }
    }
    return { ...reply, trace };
  } catch {
    return null; // Legacy path is the safety net — the pipeline never throws.
  }
}
