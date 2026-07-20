/**
 * aiFeedback.test.ts — replay invariants + cache keys (doc 25 Q1). The
 * invariants are universal health checks (the captured turn was BAD — snapshot
 * equality would enforce the bug), so each check is pinned individually.
 */
import { describe, expect, it } from 'vitest';

import {
  answerCacheKey,
  capText,
  evaluateReplay,
  replayPassed,
  type ReplayOutcome,
} from '../aiFeedback';

const outcome = (over: Partial<ReplayOutcome>): ReplayOutcome => ({
  reply: { role: 'assistant', text: 'The total is 100 USD.', source: 'ondevice' },
  grounding: '{"total":100}',
  usedLocal: false,
  ...over,
});

const verdictFor = (o: ReplayOutcome, check: string) =>
  evaluateReplay(o).find((v) => v.check === check);

describe('evaluateReplay', () => {
  it('a healthy grounded answer passes everything', () => {
    const verdicts = evaluateReplay(outcome({}));
    expect(replayPassed(verdicts)).toBe(true);
  });

  it('null reply fails reply-produced and stops there', () => {
    const verdicts = evaluateReplay(outcome({ reply: null }));
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ check: 'reply-produced', pass: false });
  });

  it('invented numbers fail numbers-grounded', () => {
    const v = verdictFor(
      outcome({ reply: { role: 'assistant', text: 'You spent 99999 USD.' } }),
      'numbers-grounded',
    );
    expect(v?.pass).toBe(false);
  });

  it('canned fallbacks fail no-canned-fallback', () => {
    const v = verdictFor(
      outcome({ reply: { role: 'assistant', text: "I've covered that already — try something else." } }),
      'no-canned-fallback',
    );
    expect(v?.pass).toBe(false);
  });

  it('a local-tier turn answered by PCC fails local-pin', () => {
    const v = verdictFor(
      outcome({ usedLocal: true, reply: { role: 'assistant', text: 'The total is 100 USD.', source: 'pcc' } }),
      'local-pin',
    );
    expect(v?.pass).toBe(false);
    expect(
      verdictFor(
        outcome({ usedLocal: true, reply: { role: 'assistant', text: 'The total is 100 USD.', source: 'ondevice' } }),
        'local-pin',
      )?.pass,
    ).toBe(true);
  });

  it('clarify shape needs a question and 2-4 options', () => {
    const good = outcome({
      reply: { role: 'clarify', text: 'Which Sam?', options: ['Sam Lee', 'Samir'] },
    });
    const bad = outcome({ reply: { role: 'clarify', text: 'Which Sam?', options: ['Sam Lee'] } });
    expect(verdictFor(good, 'clarify-shape')?.pass).toBe(true);
    expect(verdictFor(bad, 'clarify-shape')?.pass).toBe(false);
    // Clarifies skip the grounding check — they carry no numbers claim.
    expect(verdictFor(good, 'numbers-grounded')).toBeUndefined();
  });
});

describe('answerCacheKey', () => {
  it('normalizes punctuation/case/whitespace in the question', () => {
    expect(answerCacheKey('insights', 'g1', 'h1', 'Aprils total?')).toBe(
      answerCacheKey('insights', 'g1', 'h1', '  aprils   TOTAL '),
    );
  });

  it('scope, surface, and facts hash all partition the cache', () => {
    const base = answerCacheKey('insights', 'g1', 'h1', 'total?');
    expect(answerCacheKey('assistant', 'g1', 'h1', 'total?')).not.toBe(base);
    expect(answerCacheKey('insights', 'g2', 'h1', 'total?')).not.toBe(base);
    expect(answerCacheKey('insights', 'g1', 'h2', 'total?')).not.toBe(base);
  });
});

describe('capText', () => {
  it('marks truncation and leaves short text alone', () => {
    expect(capText('short', 10)).toBe('short');
    expect(capText('x'.repeat(20), 10)).toBe(`${'x'.repeat(10)}…[truncated]`);
  });
});
