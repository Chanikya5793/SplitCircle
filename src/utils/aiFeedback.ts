/**
 * aiFeedback.ts — pure types + logic for the AI quality flywheel (doc 25 Q1).
 *
 * A 👎 on an assistant bubble snapshots the WHOLE turn (TurnTrace) into a
 * replayable fixture. Replays assert INVARIANTS — universal health checks —
 * never snapshot equality: the captured turn was bad (that's why it was
 * thumbed down), so "matches the original" would enforce the bug. The eval
 * screen shows old-vs-new replies for the human judgment call; the automated
 * verdict covers what CAN be checked mechanically.
 *
 * Pure module (vitest-covered); storage lives in aiFeedbackService.
 */

import { numbersGrounded } from './aiText';

// ── Turn traces ──────────────────────────────────────────────────────────────

export interface TraceToolResult {
  tool: string;
  label: string;
  /** Result JSON, capped — big payloads truncate with a marker. */
  json: string;
  error?: string;
}

export interface TurnTrace {
  at: number;
  surface: string;
  scope: string;
  userText: string;
  /** The exact facts blob the turn ran with — replays reuse it so prompt
   * regressions are testable independent of live-data drift. Capped. */
  facts: string;
  factsHash: string;
  engine: 'auto' | 'ondevice' | 'pcc';
  intent: 'answer' | 'clarify' | 'abstain';
  complexity: string;
  assumption?: string;
  /** Loop-step count (router excluded). */
  hops: number;
  requests: { tool: string; args: string }[];
  results: TraceToolResult[];
  usedLocal: boolean;
  source?: 'ondevice' | 'pcc';
  replyRole: 'assistant' | 'clarify';
  replyText: string;
  durationMs: number;
  /** Last few turns (role+text) so replays rebuild the conversation stub. */
  threadTail: { role: string; text: string }[];
}

export type FeedbackReason = 'wrong_number' | 'didnt_answer' | 'too_shallow' | 'other';

export const FEEDBACK_REASON_LABELS: Record<FeedbackReason, string> = {
  wrong_number: 'Wrong number',
  didnt_answer: "Didn't answer",
  too_shallow: 'Too shallow',
  other: 'Something else',
};

export interface ReplayVerdict {
  check: string;
  pass: boolean;
  note?: string;
}

export interface FixtureRun {
  at: number;
  verdicts: ReplayVerdict[];
  pass: boolean;
  newReplyText?: string;
  newRole?: string;
  newSource?: string;
  /** Set when the replay couldn't run (group gone, pipeline off). */
  skipped?: string;
}

export interface AiFixture {
  id: string;
  createdAt: number;
  reason?: FeedbackReason;
  trace: TurnTrace;
  /** True when captured without a live trace (app relaunched before the 👎). */
  reduced?: boolean;
  lastRun?: FixtureRun;
}

export const FIXTURES_CAP = 100;
export const TRACE_RING_CAP = 20;
export const TRACE_JSON_CAP = 2000;
export const TRACE_FACTS_CAP = 4000;
export const THREAD_TAIL_CAP = 6;

export const capText = (s: string, cap: number): string =>
  s.length <= cap ? s : `${s.slice(0, cap)}…[truncated]`;

// ── Replay invariants (doc 25: routing + gates, never number equality) ───────

export interface ReplayOutcome {
  reply: {
    role: 'assistant' | 'clarify';
    text: string;
    source?: string;
    options?: string[];
  } | null;
  /** facts + replay tool-result JSONs — the grounding corpus of the NEW run. */
  grounding: string;
  usedLocal: boolean;
}

const CANNED_FALLBACKS =
  /I've covered that already|That's everything notable|couldn't reach the on-device model/i;

/** Universal health checks over a replayed turn. */
export function evaluateReplay(outcome: ReplayOutcome): ReplayVerdict[] {
  const verdicts: ReplayVerdict[] = [];
  const reply = outcome.reply;

  verdicts.push({
    check: 'reply-produced',
    pass: !!reply && reply.text.trim().length > 0,
    note: reply ? undefined : 'pipeline returned null (legacy fallback would have run)',
  });
  if (!reply) return verdicts;

  if (reply.role === 'assistant') {
    verdicts.push({
      check: 'numbers-grounded',
      pass: numbersGrounded(reply.text, outcome.grounding),
      note: 'every number must appear in facts/tool results',
    });
    verdicts.push({
      check: 'no-canned-fallback',
      pass: !CANNED_FALLBACKS.test(reply.text),
    });
  }
  if (reply.role === 'clarify') {
    const n = reply.options?.length ?? 0;
    verdicts.push({
      check: 'clarify-shape',
      pass: reply.text.trim().length > 0 && n >= 2 && n <= 4,
      note: 'a clarify needs a question and 2-4 tappable options',
    });
  }
  verdicts.push({
    check: 'local-pin',
    pass: !outcome.usedLocal || reply.source !== 'pcc',
    note: 'turns that touched chat/call data must not answer via PCC',
  });
  return verdicts;
}

export const replayPassed = (verdicts: readonly ReplayVerdict[]): boolean =>
  verdicts.every((v) => v.pass);

// ── Per-turn answer cache keys (doc 25 latency polish) ───────────────────────

export const ANSWER_CACHE_CAP = 50;

const normQuestion = (s: string): string =>
  (s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Identical question over identical facts in the same scope ⇒ same answer. */
export function answerCacheKey(
  surface: string,
  scope: string,
  factsHash: string,
  userText: string,
): string {
  return `${surface}|${scope}|${factsHash}|${normQuestion(userText)}`;
}
