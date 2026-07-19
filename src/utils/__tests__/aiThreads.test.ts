import { describe, expect, it } from 'vitest';
import {
  assembleInsightsPrompt,
  deterministicThreadTitle,
  estimateTokens,
  hashFacts,
  isSmallTalk,
  pickFreshInsight,
  pruneThreads,
  repeatsRecent,
  shouldResumeThread,
  wantsFreshInsight,
  selectRollup,
  transcriptBlock,
  type AiThread,
  type AiThreadMessage,
} from '../aiThreads';

const NOW = new Date(2026, 6, 17, 12, 0, 0).getTime();

let seq = 0;
const msg = (over: Partial<AiThreadMessage>): AiThreadMessage => ({
  id: `m${++seq}`,
  role: 'user',
  text: 'hello',
  createdAt: NOW + seq,
  ...over,
});

const thread = (over: Partial<AiThread>): AiThread => ({
  threadId: `t${++seq}`,
  surface: 'insights',
  scope: 'g1',
  title: 'T',
  createdAt: NOW,
  updatedAt: NOW + seq,
  messages: [],
  ...over,
});

describe('hashFacts / estimateTokens', () => {
  it('hashes deterministically and detects drift', () => {
    expect(hashFacts('abc')).toBe(hashFacts('abc'));
    expect(hashFacts('abc')).not.toBe(hashFacts('abd'));
  });

  it('estimates ~chars/4 tokens', () => {
    expect(estimateTokens('12345678')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('deterministicThreadTitle', () => {
  it('combines seed and date, truncating long seeds', () => {
    expect(deterministicThreadTitle('General up 497%', NOW)).toBe('General up 497% · Jul 17');
    expect(deterministicThreadTitle('', NOW)).toBe('Insights · Jul 17');
    expect(deterministicThreadTitle('x'.repeat(60), NOW).length).toBeLessThan(45);
  });
});

describe('pruneThreads', () => {
  it('keeps the newest N by updatedAt', () => {
    const threads = Array.from({ length: 25 }, (_, i) => thread({ updatedAt: NOW + i }));
    const kept = pruneThreads(threads, 20);
    expect(kept).toHaveLength(20);
    expect(kept[0].updatedAt).toBe(NOW + 24);
    expect(kept.every((t) => t.updatedAt >= NOW + 5)).toBe(true);
  });
});

describe('assembleInsightsPrompt', () => {
  const base = {
    instructions: 'Be helpful.',
    facts: '{"total":753}',
    userText: 'why did it jump?',
    budgetTokens: 4096,
  };

  it('includes facts, summary, drift note, and verbatim turns', () => {
    const out = assembleInsightsPrompt({
      ...base,
      summary: 'We discussed rent.',
      driftNote: 'Data changed since the thread started.',
      messages: [
        msg({ role: 'user', text: 'hi' }),
        msg({ role: 'assistant', text: 'hello there' }),
        msg({ role: 'context', text: 'Context updated' }), // excluded
      ],
    });
    expect(out.prompt).toContain('CURRENT FACTS');
    expect(out.prompt).toContain('We discussed rent.');
    expect(out.prompt).toContain('NOTE: Data changed');
    expect(out.prompt).toContain('User: hi');
    expect(out.prompt).toContain('Assistant: hello there');
    expect(out.prompt).not.toContain('Context updated');
    expect(out.prompt.endsWith('User: why did it jump?\nAssistant:')).toBe(true);
    expect(out.needsRollup).toBe(false);
  });

  it('drops oldest turns and flags rollup when over budget', () => {
    const long = Array.from({ length: 30 }, (_, i) =>
      msg({ role: i % 2 ? 'assistant' : 'user', text: `turn ${i} ${'x'.repeat(400)}` }),
    );
    const out = assembleInsightsPrompt({ ...base, messages: long, budgetTokens: 1200 });
    expect(out.needsRollup).toBe(true);
    expect(out.tokens).toBeLessThanOrEqual(1200);
    // Newest turns survive, oldest are dropped from the prompt.
    expect(out.prompt).toContain('turn 29');
    expect(out.prompt).not.toContain('turn 0 ');
  });

  it('includes per-question extra facts when provided', () => {
    const out = assembleInsightsPrompt({
      ...base,
      extraFacts: '{"months":[{"month":"April 2026","total":100}]}',
      messages: [],
    });
    expect(out.prompt).toContain('EXTRA FACTS FOR THIS QUESTION');
    expect(out.prompt).toContain('April 2026');
  });

  it('excludes turns already folded into the summary', () => {
    const out = assembleInsightsPrompt({
      ...base,
      summary: 'Old stuff.',
      messages: [
        msg({ role: 'user', text: 'ancient question', inSummary: true }),
        msg({ role: 'user', text: 'fresh question' }),
      ],
    });
    expect(out.prompt).not.toContain('ancient question');
    expect(out.prompt).toContain('fresh question');
  });
});

describe('selectRollup', () => {
  it('folds all but the most recent N verbatim turns', () => {
    const messages = Array.from({ length: 10 }, (_, i) => msg({ text: `t${i}` }));
    const { fold, keep } = selectRollup(messages, 6);
    expect(fold.map((m) => m.text)).toEqual(['t0', 't1', 't2', 't3']);
    expect(keep).toHaveLength(6);
  });

  it('folds nothing for short threads and skips context/inSummary rows', () => {
    const messages = [
      msg({ text: 'a', inSummary: true }),
      msg({ role: 'context', text: 'chip' }),
      msg({ text: 'b' }),
    ];
    const { fold, keep } = selectRollup(messages, 6);
    expect(fold).toHaveLength(0);
    expect(keep.map((m) => m.text)).toEqual(['b']);
  });
});

describe('shouldResumeThread', () => {
  it('resumes only within the continuation window', () => {
    expect(shouldResumeThread({ updatedAt: NOW - 5 * 60_000 }, NOW)).toBe(true);
    expect(shouldResumeThread({ updatedAt: NOW - 20 * 60_000 }, NOW)).toBe(false);
    expect(shouldResumeThread(null, NOW)).toBe(false);
  });
});

describe('conversation quality guards', () => {
  it('repeatsRecent catches an effectively-identical recent assistant reply', () => {
    const messages = [
      msg({ role: 'assistant', text: 'Shopping expenses were $7.30 in June 2026.' }),
      msg({ role: 'user', text: 'tell me something new' }),
    ];
    expect(repeatsRecent('Shopping expenses were $7.30 in June 2026!', messages)).toBe(true);
    expect(repeatsRecent('General is up 497% this month.', messages)).toBe(false);
    // Only recent assistant turns count.
    const old = [
      msg({ role: 'assistant', text: 'ancient repeated line' }),
      ...Array.from({ length: 4 }, (_, i) => msg({ role: 'assistant', text: `fresh ${i}` })),
    ];
    expect(repeatsRecent('ancient repeated line', old)).toBe(false);
  });

  it('wantsFreshInsight catches open-ended asks but not specific questions', () => {
    for (const t of ['tell me something new', 'What else?', 'more', 'anything else', 'tell me more']) {
      expect(wantsFreshInsight(t)).toBe(true);
    }
    for (const t of ['why did food jump?', 'summary', 'June', 'more about food']) {
      expect(wantsFreshInsight(t)).toBe(false);
    }
  });

  it('pickFreshInsight returns the first card not yet surfaced in the thread', () => {
    const cards = [
      { title: 'General up 497%', body: 'Above pace.' },
      { title: 'No settle-up in 13 days', body: 'Debts are open.' },
    ];
    const messages = [msg({ role: 'assistant', text: 'General up 497% — Above pace.' })];
    expect(pickFreshInsight(cards, messages)?.title).toBe('No settle-up in 13 days');
    const exhausted = [
      ...messages,
      msg({ role: 'assistant', text: 'No settle-up in 13 days — Debts are open.' }),
    ];
    expect(pickFreshInsight(cards, exhausted)).toBeNull();
    expect(pickFreshInsight(cards, [])?.title).toBe('General up 497%');
  });

  it('isSmallTalk catches greetings and acks but not real questions', () => {
    for (const t of ['Hey', 'hi!', 'thanks', 'ok', 'Good morning', "what's up?"]) {
      expect(isSmallTalk(t)).toBe(true);
    }
    for (const t of ['hey why did food jump?', 'summary', 'tell me something new', 'June']) {
      expect(isSmallTalk(t)).toBe(false);
    }
  });
});

describe('transcriptBlock', () => {
  it('labels roles and skips context chips', () => {
    const out = transcriptBlock([
      msg({ role: 'user', text: 'q' }),
      msg({ role: 'context', text: 'chip' }),
      msg({ role: 'assistant', text: 'a' }),
    ]);
    expect(out).toBe('User: q\nAssistant: a');
  });
});
