/**
 * aiFeedbackService.test.ts — 👎-to-fixture capture + replay grading (doc 25).
 * The pipeline is mocked; storage is the real AsyncStorage-backed store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __clearAsyncStorageStore } from './mocks/async-storage';
import type { TurnTrace } from '@/utils/aiFeedback';

const pipeline = {
  runAgenticTurn: vi.fn<(args: unknown) => Promise<unknown>>(),
};
vi.mock('@/services/aiPipelineService', () => ({
  runAgenticTurn: (args: unknown) => pipeline.runAgenticTurn(args),
}));

import {
  getEvalStatus,
  listFixtures,
  noteTurn,
  replayFixture,
  setEvalStatus,
  thumbsDown,
} from '../aiFeedbackService';

const trace = (over: Partial<TurnTrace> = {}): TurnTrace => ({
  at: 1,
  surface: 'insights',
  scope: 'g1',
  userText: 'aprils total?',
  facts: '{"total":125}',
  factsHash: 'h1',
  engine: 'auto',
  intent: 'answer',
  complexity: 'simple',
  hops: 1,
  requests: [{ tool: 'month_summary', args: 'april' }],
  results: [{ tool: 'month_summary', label: 'April 2026 summary', json: '{"total":125}' }],
  usedLocal: false,
  source: 'ondevice',
  replyRole: 'assistant',
  replyText: 'April came to 999 USD.',
  durationMs: 1200,
  threadTail: [{ role: 'user', text: 'aprils total?' }],
  ...over,
});

const fallback = { surface: 'insights', scope: 'g1', userText: 'q', replyText: 'r' };

beforeEach(() => {
  vi.resetAllMocks();
  __clearAsyncStorageStore();
});

describe('capture', () => {
  it('👎 with a live trace stores a FULL fixture', async () => {
    noteTurn('m1', trace());
    const fixture = await thumbsDown('m1', 'wrong_number', fallback);
    expect(fixture.reduced).toBeFalsy();
    expect(fixture.trace.userText).toBe('aprils total?');
    expect(fixture.reason).toBe('wrong_number');
    const stored = await listFixtures();
    expect(stored).toHaveLength(1);
    expect(stored[0].trace.results[0].tool).toBe('month_summary');
  });

  it('👎 without a trace (post-relaunch) stores a REDUCED fixture', async () => {
    const fixture = await thumbsDown('gone', 'too_shallow', fallback);
    expect(fixture.reduced).toBe(true);
    expect(fixture.trace.userText).toBe('q');
    expect(fixture.trace.replyText).toBe('r');
  });

  it('newest fixtures come first', async () => {
    noteTurn('a', trace({ userText: 'first' }));
    noteTurn('b', trace({ userText: 'second' }));
    await thumbsDown('a', undefined, fallback);
    await thumbsDown('b', undefined, fallback);
    const stored = await listFixtures();
    expect(stored.map((f) => f.trace.userText)).toEqual(['second', 'first']);
  });
});

describe('replay', () => {
  const group = { groupId: 'g1' } as never;

  it('grades a healthy replay as pass and persists the run', async () => {
    noteTurn('m1', trace());
    const fixture = await thumbsDown('m1', 'wrong_number', fallback);
    pipeline.runAgenticTurn.mockResolvedValueOnce({
      role: 'assistant',
      text: 'April came to 125 USD.',
      source: 'ondevice',
      trace: trace({ replyText: 'April came to 125 USD.' }),
    });
    const run = await replayFixture(fixture, { group, currentUserId: 'u1' });
    expect(run.pass).toBe(true);
    expect(run.newReplyText).toBe('April came to 125 USD.');
    // Replay must run with the ORIGINAL facts and bypass the cache.
    const args = pipeline.runAgenticTurn.mock.calls[0][0] as { facts: string; replay: boolean };
    expect(args.facts).toBe('{"total":125}');
    expect(args.replay).toBe(true);
    const stored = await listFixtures();
    expect(stored[0].lastRun?.pass).toBe(true);
  });

  it('an ungrounded replay fails numbers-grounded', async () => {
    noteTurn('m1', trace());
    const fixture = await thumbsDown('m1', undefined, fallback);
    pipeline.runAgenticTurn.mockResolvedValueOnce({
      role: 'assistant',
      text: 'April came to 99999 USD.',
      source: 'ondevice',
      trace: trace(),
    });
    const run = await replayFixture(fixture, { group, currentUserId: 'u1' });
    expect(run.pass).toBe(false);
    expect(run.verdicts.find((v) => v.check === 'numbers-grounded')?.pass).toBe(false);
  });

  it('reduced fixtures and missing groups skip instead of failing noisily', async () => {
    const reduced = await thumbsDown('gone', undefined, fallback);
    const run1 = await replayFixture(reduced, { group, currentUserId: 'u1' });
    expect(run1.skipped).toContain('reduced');

    noteTurn('m2', trace({ scope: 'deleted-group' }));
    const full = await thumbsDown('m2', undefined, fallback);
    const run2 = await replayFixture(full, { currentUserId: 'u1' });
    expect(run2.skipped).toContain('group');
    expect(pipeline.runAgenticTurn).not.toHaveBeenCalled();
  });
});

describe('eval status', () => {
  it('round-trips the summary marker', async () => {
    await setEvalStatus({ at: 5, total: 3, passed: 2, failed: 1, skipped: 0 });
    expect(await getEvalStatus()).toMatchObject({ total: 3, passed: 2, failed: 1 });
  });
});
