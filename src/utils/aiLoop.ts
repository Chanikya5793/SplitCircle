/**
 * aiLoop.ts — the agentic turn protocol for the one-brain pipeline (doc 24).
 *
 * Pure module: ALL prompt text + decision coercion + budgets live here in JS so
 * behavior is vitest-testable and hot-swappable — the native layer only hosts
 * the guided-generation structs (routeTurn / agentLoopStep) and free-text
 * generation. Every call is STATELESS (doc 23 rationale, now app-wide): each
 * hop re-assembles instructions + facts + tool results + thread memory.
 *
 * Iron rule carried in every prompt: the model plans, requests, and narrates —
 * it NEVER computes. Numbers exist only in FACTS / TOOL RESULTS blocks.
 */

import {
  estimateTokens,
  transcriptBlock,
  type AiThreadMessage,
} from './aiThreads';
import {
  MAX_REQUESTS_PER_HOP,
  toolResultsBlock,
  type ToolRequest,
  type ToolResult,
} from './aiTools';

// ── Caps (doc 24 §2 latency decision) ────────────────────────────────────────

/** Max model hops per turn: 1 router + up to 3 loop steps on-device. */
export const MAX_HOPS = 4;
/** PCC hops are network round-trips — one fewer (used from P3). */
export const MAX_HOPS_PCC = 3;
/** Wall-clock cap for the data loop; the narrator still runs after it trips. */
export const LOOP_WALL_MS = 10_000;
/** Recent verbatim turns offered to the router/narrator. */
export const RECENT_TURNS = 6;

// ── Decision shapes (JS mirrors of the native @Generable structs) ────────────

export type AgentIntent = 'answer' | 'clarify' | 'abstain';
export type AgentComplexity = 'simple' | 'moderate' | 'deep';

export interface AgentDecision {
  intent: AgentIntent;
  confidence: number;
  complexity: AgentComplexity;
  /** Stated assumption when mildly ambiguous ('' = none). */
  assumption: string;
  clarifyQuestion: string;
  clarifyOptions: string[];
  /** Friendly reply used when intent is 'abstain' ('' → caller's canned copy). */
  abstainReply: string;
  requests: ToolRequest[];
}

export interface LoopStepDecision {
  done: boolean;
  requests: ToolRequest[];
}

/** Raw dictionaries as the native module returns them (everything optional). */
export interface RawToolRequest {
  tool?: string; month?: string; monthB?: string; category?: string; member?: string;
  merchant?: string; query?: string; n?: number; months?: number;
}
export interface RawAgentDecision {
  intent?: string; confidence?: number; complexity?: string; assumption?: string;
  clarifyQuestion?: string; clarifyOptions?: string[]; abstainReply?: string;
  requests?: RawToolRequest[];
}
export interface RawLoopStep {
  done?: boolean;
  requests?: RawToolRequest[];
}

const cleanStr = (s: unknown): string => (typeof s === 'string' ? s.trim() : '');

function coerceRequests(raw: readonly RawToolRequest[] | undefined): ToolRequest[] {
  return (raw ?? [])
    .map((r) => ({
      tool: cleanStr(r.tool),
      month: cleanStr(r.month) || undefined,
      monthB: cleanStr(r.monthB) || undefined,
      category: cleanStr(r.category) || undefined,
      member: cleanStr(r.member) || undefined,
      merchant: cleanStr(r.merchant) || undefined,
      query: cleanStr(r.query) || undefined,
      n: Number(r.n) > 0 ? Math.floor(Number(r.n)) : undefined,
      months: Number(r.months) > 0 ? Math.floor(Number(r.months)) : undefined,
    }))
    .filter((r) => r.tool.length > 0)
    .slice(0, MAX_REQUESTS_PER_HOP);
}

/** Guard bad model output into a safe decision (mirrors coercePlan's job). */
export function coerceDecision(raw: RawAgentDecision): AgentDecision {
  const intent: AgentIntent =
    raw.intent === 'clarify' ? 'clarify' : raw.intent === 'abstain' ? 'abstain' : 'answer';
  const complexity: AgentComplexity =
    raw.complexity === 'deep' ? 'deep' : raw.complexity === 'moderate' ? 'moderate' : 'simple';
  const options = [...new Set((raw.clarifyOptions ?? []).map(cleanStr).filter(Boolean))].slice(0, 4);
  const clarifyQuestion = cleanStr(raw.clarifyQuestion);
  return {
    // A clarify without a question can't render — degrade to answering.
    intent: intent === 'clarify' && !clarifyQuestion ? 'answer' : intent,
    confidence: Math.min(1, Math.max(0, Number(raw.confidence) || 0)),
    complexity,
    assumption: cleanStr(raw.assumption),
    clarifyQuestion,
    clarifyOptions: options,
    abstainReply: cleanStr(raw.abstainReply),
    requests: coerceRequests(raw.requests),
  };
}

export function coerceLoopStep(raw: RawLoopStep): LoopStepDecision {
  const requests = coerceRequests(raw.requests);
  return { done: raw.done === true || requests.length === 0, requests };
}

// ── Instructions (system prompts) ────────────────────────────────────────────

export interface RouterArgs {
  /** "the group Goa Trip" / "your personal cross-group spending". */
  scopeLabel: string;
  memberNames: string[];
  /** Categories actually present in the data. */
  categories: string[];
  /** Current date, spelled out — the model has no clock. */
  dateLine: string;
  /** One line per available tool (aiTools.toolCatalog). */
  toolCatalog: string;
}

export function routerInstructions(a: RouterArgs): string {
  return [
    `You are SplitCircle's money assistant for ${a.scopeLabel}. Today is ${a.dateLine}.`,
    a.memberNames.length ? `Members: ${a.memberNames.join(', ')}. Copy names EXACTLY when filling member args.` : '',
    a.categories.length ? `Categories present: ${a.categories.join(', ')}.` : '',
    '',
    'You NEVER compute numbers. You decide what data is needed; tools return exact numbers.',
    'Available tools:',
    a.toolCatalog,
    '',
    'For each user message produce ONE decision:',
    '- intent "abstain": greetings, thanks, small talk, or anything not about money/this data. Write a one-line friendly abstainReply. No requests.',
    '- intent "clarify": ONLY when the answer would materially differ between readings (a name matches several members; a month could be two different years; the target of "he/that" is unrecoverable). Ask ONE short clarifyQuestion with 2-4 clarifyOptions the user can tap. Never clarify twice in a row.',
    '- intent "answer": everything else. List the tool requests needed FIRST (up to 3; only what the question needs — the FACTS block may already suffice, then request nothing). For mild ambiguity do NOT clarify: proceed and state your reading in "assumption" (e.g. "April means April 2026").',
    '- complexity: "simple" for direct lookups, "moderate" for one comparison or trail, "deep" for multi-step "why"/analysis questions.',
    '- confidence: how sure you are you understood the request (0-1).',
    '',
    'Examples:',
    'Message: "how much on food in april?" → answer, requests [category_breakdown month:"april"], assumption "April 2026".',
    'Message: "why was last month so expensive?" → answer, complexity deep, requests [compare_ranges month:"last month" monthB:"2 months ago", top_expenses month:"last month"].',
    'Message: "hello!" → abstain, abstainReply "Hey! Ask me anything about the spending here — a month, a person, a category, or say summary."',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Loop-step instructions: same contract, narrowed to continue/stop. */
export function loopInstructions(toolCatalog: string): string {
  return [
    'You are gathering data to answer a money question. You NEVER compute numbers.',
    'Given the TOOL RESULTS so far, decide: is this enough to answer well?',
    '- Enough → done=true, no requests.',
    '- A result raised something that must be checked (a spike, an ambiguity note, a named month/person without data yet) → done=false and request ONLY the missing pieces (up to 3).',
    'Never re-request data already present. Available tools:',
    toolCatalog,
  ].join('\n');
}

export interface NarratorArgs {
  scopeLabel: string;
  currency: string;
  dateLine: string;
}

/** Adaptive-verbosity narrator (doc 24 kills the 1-3-sentence cap). */
export function narratorInstructions(a: NarratorArgs): string {
  return [
    `You are SplitCircle's money assistant for ${a.scopeLabel}, writing the final reply. Today is ${a.dateLine}. Amounts are in ${a.currency}.`,
    'Rules:',
    '- Every number you write MUST appear verbatim in FACTS or TOOL RESULTS. Never total, average, subtract, or invent numbers. It is fine to say a figure is not in the data.',
    '- Match length to the question: a direct lookup gets 1-3 sentences; a "why"/comparison/analysis may take up to 3 short paragraphs. No padding, no boilerplate.',
    '- For 3+ parallel items you may use short "- " dash lines; otherwise plain sentences. No markdown headers, no bold, no JSON, no preamble.',
    '- Answer the CURRENT question directly; never repeat an earlier answer from the conversation.',
    '- If an ASSUMPTION line is present, weave it in naturally ("Assuming you mean April 2026, …").',
    '- If a NOTE says the data changed since the conversation started, acknowledge it briefly.',
    '- End with ONE practical next step when it genuinely helps (settle up, set a budget, check an expense) — you cannot perform actions yourself.',
  ].join('\n');
}

// ── Prompt assembly (stateless, budget-aware) ────────────────────────────────

export interface TurnPromptArgs {
  facts: string;
  summary?: string;
  messages: readonly AiThreadMessage[];
  userText: string;
  budgetTokens: number;
  driftNote?: string;
  /** Set when this message answers a clarify — the router must not re-clarify. */
  resolvedClarify?: boolean;
}

export interface AssembledTurnPrompt {
  prompt: string;
  tokens: number;
  /** True when older turns should fold into the rolling summary. */
  needsRollup: boolean;
}

/** Fit as many recent verbatim turns as the budget allows (newest kept). */
function fitTurns(
  messages: readonly AiThreadMessage[],
  fixedTokens: number,
  budgetTokens: number,
): { block: string; dropped: boolean } {
  // Clarify turns count as assistant context ("you asked which Sam…").
  const verbatim = messages
    .filter((m) => !m.inSummary && (m.role === 'user' || m.role === 'assistant' || m.role === 'clarify'))
    .slice(-RECENT_TURNS);
  const kept: AiThreadMessage[] = [];
  let used = fixedTokens;
  for (let i = verbatim.length - 1; i >= 0; i--) {
    const t = estimateTokens(`${verbatim[i].role}: ${verbatim[i].text}\n`);
    if (used + t > budgetTokens) break;
    used += t;
    kept.unshift(verbatim[i]);
  }
  return {
    block: kept.length ? `CONVERSATION SO FAR:\n${transcriptBlock(kept)}\n\n` : '',
    dropped: kept.length < verbatim.length,
  };
}

/** The router's per-turn prompt (its instructions ride separately). */
export function assembleRouterPrompt(a: TurnPromptArgs): AssembledTurnPrompt {
  const head =
    (a.driftNote ? `NOTE: ${a.driftNote}\n\n` : '') +
    `FACTS (final numbers — quote only, never recompute):\n${a.facts}\n\n` +
    (a.summary?.trim() ? `EARLIER IN THIS CONVERSATION (summary):\n${a.summary.trim()}\n\n` : '');
  const tail =
    (a.resolvedClarify
      ? 'The user just answered your clarifying question — decide and proceed, do NOT clarify again.\n'
      : '') + `Message: ${a.userText}`;
  const fixed = estimateTokens(head) + estimateTokens(tail);
  const turns = fitTurns(a.messages, fixed, a.budgetTokens);
  const prompt = head + turns.block + tail;
  return { prompt, tokens: estimateTokens(prompt), needsRollup: turns.dropped };
}

/** A loop hop's prompt: the question + everything gathered so far. */
export function assembleHopPrompt(args: {
  userText: string;
  results: readonly ToolResult[];
  hop: number;
  maxHops: number;
}): string {
  return (
    `Question: ${args.userText}\n\n` +
    `TOOL RESULTS so far:\n${toolResultsBlock(args.results)}\n\n` +
    `Hop ${args.hop} of ${args.maxHops}. Enough to answer, or is something specific missing?`
  );
}

export interface NarratorPromptArgs extends TurnPromptArgs {
  results: readonly ToolResult[];
  assumption?: string;
}

/** The narrator's prompt: facts + tool results + memory + the question. */
export function assembleNarratorPrompt(a: NarratorPromptArgs): AssembledTurnPrompt {
  const head =
    (a.driftNote ? `NOTE: ${a.driftNote}\n\n` : '') +
    `FACTS (final numbers — quote only, never recompute):\n${a.facts}\n\n` +
    (a.results.length
      ? `TOOL RESULTS (final numbers — quote only, never recompute):\n${toolResultsBlock(a.results)}\n\n`
      : '') +
    (a.assumption ? `ASSUMPTION: ${a.assumption}\n\n` : '') +
    (a.summary?.trim() ? `EARLIER IN THIS CONVERSATION (summary):\n${a.summary.trim()}\n\n` : '');
  const tail = `\nUser: ${a.userText}\nAssistant:`;
  const fixed = estimateTokens(head) + estimateTokens(tail);
  const turns = fitTurns(a.messages, fixed, a.budgetTokens);
  const prompt = head + turns.block + tail;
  return { prompt, tokens: estimateTokens(prompt), needsRollup: turns.dropped };
}
