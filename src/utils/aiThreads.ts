/**
 * aiThreads.ts — pure logic for the app-wide AI thread framework (doc 23).
 *
 * No RN/native imports so it stays vitest-testable. Threads are local-only
 * (the app's Local tier — never Firestore), keyed `surface:scope`
 * (`insights:<groupId>`, `insights:personal`, `assistant:<groupId>`).
 *
 * Chat calls are STATELESS by design: every turn re-assembles instructions +
 * facts + thread memory into one prompt, so cold starts replay cleanly and the
 * context budget is under our control (native FM transcripts are in-memory
 * only). Overflow policy is a rolling summary: older turns fold into a
 * model-written digest, recent turns stay verbatim.
 */

export type AiThreadRole = 'user' | 'assistant' | 'context';
export type AiAnswerSource = 'ondevice' | 'pcc' | 'deterministic';

export interface AiThreadSource {
  expenseId?: string;
  groupId?: string;
  title?: string;
  category?: string;
  amount: number;
  currency?: string;
}

export interface AiThreadMessage {
  id: string;
  role: AiThreadRole;
  text: string;
  createdAt: number;
  /** Which engine produced an assistant message. */
  source?: AiAnswerSource;
  /** Deterministic citations (tappable expense refs). */
  sources?: AiThreadSource[];
  /** True once this turn has been folded into thread.summary (display-only). */
  inSummary?: boolean;
  /** Surface-specific extras (e.g. the assistant's action/confirm-card data). */
  payload?: unknown;
}

export interface AiThread {
  threadId: string;
  surface: string;
  scope: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Rolling digest of turns marked inSummary. */
  summary?: string;
  /** Hash of the facts blob last injected, to detect drift on resume. */
  factsHash?: string;
  messages: AiThreadMessage[];
  /** Free-form per-surface state (e.g. the assistant's ConversationState). */
  meta?: Record<string, unknown>;
}

export const THREADS_PER_SCOPE_CAP = 20;

/** ~4 chars/token — the standard cheap estimate; errs high on JSON. */
export const estimateTokens = (s: string): number => Math.ceil((s ?? '').length / 4);

/** Same tiny hash the insights cache uses — cheap facts-drift detection. */
export function hashFacts(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h);
}

/** Fallback title when the model can't produce one: seed + short date. */
export function deterministicThreadTitle(seed: string, nowMs: number): string {
  const d = new Date(nowMs);
  const date = `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}`;
  const trimmed = (seed ?? '').trim();
  return trimmed ? `${trimmed.slice(0, 34)} · ${date}` : `Insights · ${date}`;
}

/** Newest-first ordering, capped; returns threads to KEEP (prune the rest). */
export function pruneThreads(threads: readonly AiThread[], cap = THREADS_PER_SCOPE_CAP): AiThread[] {
  return [...threads].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(1, cap));
}

const roleLabel = (m: AiThreadMessage): string => (m.role === 'user' ? 'User' : 'Assistant');

/** Verbatim transcript block for the given turns (context chips excluded). */
export function transcriptBlock(messages: readonly AiThreadMessage[]): string {
  return messages
    .filter((m) => m.role !== 'context')
    .map((m) => `${roleLabel(m)}: ${m.text}`)
    .join('\n');
}

export interface AssembledPrompt {
  prompt: string;
  /** True when older turns should be folded into the summary before the NEXT turn. */
  needsRollup: boolean;
  /** Token estimate of the assembled prompt. */
  tokens: number;
}

export interface AssembleArgs {
  instructions: string;
  /** Current facts JSON (final numbers — the model quotes, never computes). */
  facts: string;
  /** Per-question targeted facts (doc 23 enrichment) — '' / undefined when none. */
  extraFacts?: string;
  /** Rolling digest of older turns ('' when none). */
  summary?: string;
  /** Full stored messages; only those NOT inSummary are replayed verbatim. */
  messages: readonly AiThreadMessage[];
  /** The new user message for this turn. */
  userText: string;
  /** Total token budget (context window minus response reserve). */
  budgetTokens: number;
  /** One-line drift note when facts changed since the thread started ('' = none). */
  driftNote?: string;
}

/**
 * Assemble the full stateless prompt for one chat turn. Recent verbatim turns
 * are included newest-last; if the whole assembly overflows the budget, the
 * oldest verbatim turns are dropped from THIS prompt and `needsRollup` asks the
 * caller to fold them into the summary for future turns.
 */
export function assembleInsightsPrompt(args: AssembleArgs): AssembledPrompt {
  const { instructions, facts, extraFacts, summary, messages, userText, budgetTokens, driftNote } = args;

  const head =
    `${instructions}\n\n` +
    (driftNote ? `NOTE: ${driftNote}\n\n` : '') +
    `CURRENT FACTS (final numbers — quote, never recompute):\n${facts}\n\n` +
    (extraFacts?.trim()
      ? `EXTRA FACTS FOR THIS QUESTION (same rules — quote, never recompute):\n${extraFacts.trim()}\n\n`
      : '') +
    (summary?.trim() ? `EARLIER IN THIS CONVERSATION (summary):\n${summary.trim()}\n\n` : '');
  const tail = `\nUser: ${userText}\nAssistant:`;

  const verbatim = messages.filter((m) => !m.inSummary && m.role !== 'context');
  const fixed = estimateTokens(head) + estimateTokens(tail);

  // Walk from the newest turn backwards, keeping as many verbatim turns as fit.
  const kept: AiThreadMessage[] = [];
  let used = fixed;
  for (let i = verbatim.length - 1; i >= 0; i--) {
    const t = estimateTokens(`${roleLabel(verbatim[i])}: ${verbatim[i].text}\n`);
    if (used + t > budgetTokens) break;
    used += t;
    kept.unshift(verbatim[i]);
  }

  const body = kept.length ? `CONVERSATION SO FAR:\n${transcriptBlock(kept)}\n` : '';
  const prompt = head + body + tail;
  return {
    prompt,
    // Turns that didn't fit verbatim should be summarized so their content
    // isn't lost from future prompts.
    needsRollup: kept.length < verbatim.length,
    tokens: estimateTokens(prompt),
  };
}

/** Auto-resume only a RECENT thread (mid-session continuity); anything older
 * gets a fresh thread by default — history keeps the old one reachable. */
export const RESUME_WINDOW_MS = 15 * 60 * 1000;

export function shouldResumeThread(
  latest: Pick<AiThread, 'updatedAt'> | null | undefined,
  nowMs: number,
  windowMs = RESUME_WINDOW_MS,
): boolean {
  if (!latest) return false;
  return nowMs - latest.updatedAt < windowMs;
}

// ── Conversation quality guards (doc 23) ─────────────────────────────────────

const normalizeReply = (s: string): string =>
  (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * True when `reply` is (effectively) identical to one of the last few
 * assistant messages — small on-device models loop; a repeat is never an
 * acceptable answer to a new question.
 */
export function repeatsRecent(
  reply: string,
  messages: readonly AiThreadMessage[],
  lookback = 3,
): boolean {
  const n = normalizeReply(reply);
  if (!n) return false;
  return messages
    .filter((m) => m.role === 'assistant')
    .slice(-lookback)
    .some((m) => normalizeReply(m.text) === n);
}

/** "Give me something new/else/more" — served from the deterministic insight
 * inventory (heuristic cards), never from the model (which loops on these). */
export function wantsFreshInsight(text: string): boolean {
  const t = (text ?? '').trim().toLowerCase();
  return (
    /\b(something (new|else|different)|what else|anything else|tell me more|more insights?|another (one|insight)|next insight|any other)\b/.test(
      t,
    ) || /^(more|next|else|another)[!,.? ]*$/.test(t)
  );
}

const normalizeTitle = (s: string): string =>
  (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** First insight card whose headline hasn't appeared in the thread yet. */
export function pickFreshInsight<T extends { title: string; body: string }>(
  cards: readonly T[],
  messages: readonly AiThreadMessage[],
): T | null {
  const seen = messages
    .filter((m) => m.role === 'assistant')
    .map((m) => normalizeTitle(m.text))
    .join(' | ');
  return cards.find((c) => !seen.includes(normalizeTitle(c.title))) ?? null;
}

/** Greetings / acks / small talk — answered instantly, never sent to a model. */
export function isSmallTalk(text: string): boolean {
  return /^(hey+|hi+|hello|yo|sup|hola|howdy|thanks?( you| u)?|thx|ty|ok(ay)?|cool|nice|great|lol|haha+|good (morning|afternoon|evening|night)|what'?s ?up|how (are|r) (you|u)\??)[!,.? ]*$/i.test(
    (text ?? '').trim(),
  );
}

export interface RollupSplit {
  /** Turns to fold into the summary (oldest first). */
  fold: AiThreadMessage[];
  /** Recent turns that stay verbatim. */
  keep: AiThreadMessage[];
}

/**
 * Choose which verbatim turns to fold into the rolling summary: everything
 * except the most recent `keepRecent` non-context turns.
 */
export function selectRollup(messages: readonly AiThreadMessage[], keepRecent = 6): RollupSplit {
  const verbatim = messages.filter((m) => !m.inSummary && m.role !== 'context');
  if (verbatim.length <= keepRecent) return { fold: [], keep: verbatim };
  return {
    fold: verbatim.slice(0, verbatim.length - keepRecent),
    keep: verbatim.slice(verbatim.length - keepRecent),
  };
}
