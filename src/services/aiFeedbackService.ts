/**
 * aiFeedbackService.ts — capture + storage + replay for the AI quality
 * flywheel (doc 25 Q1).
 *
 * Live turns register their TurnTrace in a small in-memory ring keyed by the
 * reply's message id. A 👎 promotes the trace into a persisted fixture
 * (AsyncStorage — Local tier, NEVER uploaded; snapshots may embed chat
 * snippets, so they are excluded from any future export surface). A 👎 after
 * an app relaunch (trace ring gone) captures a REDUCED fixture instead.
 *
 * Replay re-runs a fixture through the live pipeline with the ORIGINAL facts
 * and thread tail — so prompt/code regressions are testable independent of
 * live-data drift — and grades the outcome on the doc-25 invariants.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Group } from '@/models';
import { runAgenticTurn } from '@/services/aiPipelineService';
import {
  FIXTURES_CAP,
  TRACE_RING_CAP,
  evaluateReplay,
  replayPassed,
  type AiFixture,
  type FeedbackReason,
  type FixtureRun,
  type TurnTrace,
} from '@/utils/aiFeedback';
import type { AiThread } from '@/utils/aiThreads';

const FIXTURES_KEY = 'ai_fixtures_v1';
const SENTIMENT_KEY = 'ai_sentiment_v1';
const EVAL_STATUS_KEY = 'ai_eval_status_v1';
const SENTIMENT_CAP = 200;

// ── Live trace ring ──────────────────────────────────────────────────────────

const traceRing = new Map<string, TurnTrace>();

/** Register a reply's turn snapshot (called by the surfaces right after append). */
export function noteTurn(messageId: string, trace: TurnTrace | undefined): void {
  if (!trace) return;
  traceRing.set(messageId, trace);
  while (traceRing.size > TRACE_RING_CAP) {
    const oldest = traceRing.keys().next().value;
    if (oldest == null) break;
    traceRing.delete(oldest);
  }
}

// ── Sentiment (👍 and the thumb-fill state) ──────────────────────────────────

type SentimentMap = Record<string, 'up' | 'down'>;

async function loadSentiments(): Promise<SentimentMap> {
  try {
    const raw = await AsyncStorage.getItem(SENTIMENT_KEY);
    return raw ? (JSON.parse(raw) as SentimentMap) : {};
  } catch {
    return {};
  }
}

async function saveSentiment(messageId: string, value: 'up' | 'down'): Promise<void> {
  try {
    const map = await loadSentiments();
    map[messageId] = value;
    const keys = Object.keys(map);
    if (keys.length > SENTIMENT_CAP) {
      for (const k of keys.slice(0, keys.length - SENTIMENT_CAP)) delete map[k];
    }
    await AsyncStorage.setItem(SENTIMENT_KEY, JSON.stringify(map));
  } catch {
    // Sentiment is best-effort chrome.
  }
}

export async function thumbsUp(messageId: string): Promise<void> {
  await saveSentiment(messageId, 'up');
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function loadFixtures(): Promise<AiFixture[]> {
  try {
    const raw = await AsyncStorage.getItem(FIXTURES_KEY);
    return raw ? (JSON.parse(raw) as AiFixture[]) : [];
  } catch {
    return [];
  }
}

async function saveFixtures(fixtures: AiFixture[]): Promise<void> {
  try {
    await AsyncStorage.setItem(FIXTURES_KEY, JSON.stringify(fixtures.slice(0, FIXTURES_CAP)));
  } catch {
    // A failed save loses one fixture, never breaks the chat.
  }
}

let fixtureSeq = 0;
const newFixtureId = (): string => `fx-${Date.now()}-${++fixtureSeq}`;

/** Context for a REDUCED capture when the live trace is gone (app relaunch). */
export interface ReducedCaptureContext {
  surface: string;
  scope: string;
  userText: string;
  replyText: string;
}

/**
 * 👎 → fixture (doc 25: auto, no curation step). Returns the stored fixture.
 */
export async function thumbsDown(
  messageId: string,
  reason: FeedbackReason | undefined,
  fallback: ReducedCaptureContext,
): Promise<AiFixture> {
  await saveSentiment(messageId, 'down');
  const live = traceRing.get(messageId);
  const trace: TurnTrace =
    live ??
    ({
      at: Date.now(),
      surface: fallback.surface,
      scope: fallback.scope,
      userText: fallback.userText,
      facts: '',
      factsHash: '',
      engine: 'auto',
      intent: 'answer',
      complexity: 'simple',
      hops: 0,
      requests: [],
      results: [],
      usedLocal: false,
      replyRole: 'assistant',
      replyText: fallback.replyText,
      durationMs: 0,
      threadTail: [],
    } satisfies TurnTrace);
  const fixture: AiFixture = {
    id: newFixtureId(),
    createdAt: Date.now(),
    reason,
    trace,
    reduced: !live,
  };
  const fixtures = await loadFixtures();
  await saveFixtures([fixture, ...fixtures]);
  return fixture;
}

export async function listFixtures(): Promise<AiFixture[]> {
  return loadFixtures();
}

export async function deleteFixture(id: string): Promise<void> {
  const fixtures = await loadFixtures();
  await saveFixtures(fixtures.filter((f) => f.id !== id));
}

export async function clearFixtures(): Promise<void> {
  try {
    await AsyncStorage.removeItem(FIXTURES_KEY);
  } catch {
    // best-effort
  }
}

// ── Replay + eval status ─────────────────────────────────────────────────────

export interface EvalStatus {
  at: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export async function getEvalStatus(): Promise<EvalStatus | null> {
  try {
    const raw = await AsyncStorage.getItem(EVAL_STATUS_KEY);
    return raw ? (JSON.parse(raw) as EvalStatus) : null;
  } catch {
    return null;
  }
}

export async function setEvalStatus(status: EvalStatus): Promise<void> {
  try {
    await AsyncStorage.setItem(EVAL_STATUS_KEY, JSON.stringify(status));
  } catch {
    // best-effort
  }
}

export interface ReplayDeps {
  /** Resolved from the fixture's scope by the eval screen; absent = skipped. */
  group?: Group;
  currentUserId: string;
  personalGroups?: { groupId: string; name: string; currency: string; expenses?: Group['expenses'] }[];
  chatId?: string;
}

/** Rebuild the conversation stub the fixture's turn ran against. */
const stubThread = (trace: TurnTrace): AiThread => ({
  threadId: 'replay',
  surface: trace.surface,
  scope: trace.scope,
  title: '',
  createdAt: 0,
  updatedAt: 0,
  messages: trace.threadTail.map((t, i) => ({
    id: `replay-${i}`,
    role: (t.role === 'user' || t.role === 'clarify' ? t.role : 'assistant') as
      | 'user'
      | 'assistant'
      | 'clarify',
    text: t.text,
    createdAt: 0,
  })),
});

/**
 * Re-run one fixture through the live pipeline and grade it. Persists the run
 * onto the fixture and returns it. Reduced fixtures (no facts) are skipped —
 * there is nothing faithful to replay.
 */
export async function replayFixture(fixture: AiFixture, deps: ReplayDeps): Promise<FixtureRun> {
  const finish = async (run: FixtureRun): Promise<FixtureRun> => {
    const fixtures = await loadFixtures();
    await saveFixtures(fixtures.map((f) => (f.id === fixture.id ? { ...f, lastRun: run } : f)));
    return run;
  };

  if (fixture.reduced || !fixture.trace.facts) {
    return finish({ at: Date.now(), verdicts: [], pass: false, skipped: 'reduced fixture (no trace)' });
  }
  const needsGroup = fixture.trace.scope !== 'personal';
  if (needsGroup && !deps.group) {
    return finish({ at: Date.now(), verdicts: [], pass: false, skipped: 'group no longer exists' });
  }

  const reply = await runAgenticTurn({
    replay: true,
    thread: stubThread(fixture.trace),
    userText: fixture.trace.userText,
    facts: fixture.trace.facts,
    group: needsGroup ? deps.group : undefined,
    currentUserId: deps.currentUserId,
    personalGroups: deps.personalGroups,
    chatId: deps.chatId,
    engine: fixture.trace.engine,
  });

  const grounding = [
    fixture.trace.facts,
    ...(reply?.trace?.results ?? []).map((r) => r.json),
  ].join('\n');
  const verdicts = evaluateReplay({
    reply: reply
      ? { role: reply.role, text: reply.text, source: reply.source, options: reply.options }
      : null,
    grounding,
    usedLocal: reply?.trace?.usedLocal ?? false,
  });
  return finish({
    at: Date.now(),
    verdicts,
    pass: replayPassed(verdicts),
    newReplyText: reply?.text,
    newRole: reply?.role,
    newSource: reply?.source,
  });
}
