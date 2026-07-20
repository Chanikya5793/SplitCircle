/**
 * aiPipelineService.test.ts — the agentic turn orchestrator (doc 24 §3) driven
 * by a SCRIPTED fake model, so routing, the data loop, clarify handling, caps,
 * and the grounding gate are pinned deterministically with no device.
 *
 * The native module wrapper and the PCC door are mocked; the TOOL REGISTRY IS
 * REAL — tool numbers in these tests are exact engine output.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { __clearAsyncStorageStore } from './mocks/async-storage';
import type { Group } from '@/models';
import type { AiThread } from '@/utils/aiThreads';

// Programmable fake model. Tests script decisions per call.
type StreamHandle = { promise: Promise<string>; cancel: () => void };
const fm = {
  routeTurn: vi.fn<(i: string, p: string) => Promise<unknown>>(),
  agentLoopStep: vi.fn<(i: string, p: string) => Promise<unknown>>(),
  generateOnDeviceText: vi.fn<(p: string, i?: string) => Promise<string>>(),
  streamed: vi.fn<(p: string, i: string, onDelta: (d: string, f: string) => void) => StreamHandle>(),
  availability: 'available' as string,
};

vi.mock('../../../modules/splitcircle-ai', () => ({
  isAgenticNativeAvailable: () => true,
  getOnDeviceAiAvailability: () => fm.availability,
  getOnDeviceContextSize: () => 4096,
  routeTurn: (i: string, p: string) => fm.routeTurn(i, p),
  agentLoopStep: (i: string, p: string) => fm.agentLoopStep(i, p),
  generateOnDeviceText: (p: string, i?: string) => fm.generateOnDeviceText(p, i),
  generateOnDeviceTextStreamed: (p: string, i: string, onDelta: (d: string, f: string) => void) =>
    fm.streamed(p, i, onDelta),
}));

vi.mock('@/services/insightsAiService', () => ({
  tryPccPrompt: vi.fn(async () => null),
}));

import { clearAgenticAnswerCache, runAgenticTurn } from '../aiPipelineService';
import {
  __clearMemoryCache,
  addItem as addMemoryItem,
  getEntityFixes,
} from '../aiMemoryService';
import { tryPccPrompt } from '@/services/insightsAiService';

const pcc = vi.mocked(tryPccPrompt);

const NOW = Date.now();

const group = {
  groupId: 'g1',
  name: 'Flat 42',
  currency: 'USD',
  updatedAt: NOW,
  members: [
    { userId: 'u1', displayName: 'Chan' },
    { userId: 'u2', displayName: 'Sam Lee' },
    { userId: 'u3', displayName: 'Samir' },
  ],
  expenses: [
    {
      expenseId: 'e1', groupId: 'g1', title: 'Groceries', category: 'Food', amount: 100,
      paidBy: 'u1', splitType: 'equal', settled: false,
      participants: [{ userId: 'u1', share: 50 }, { userId: 'u2', share: 50 }],
      createdAt: NOW - 86400000, updatedAt: NOW - 86400000,
    },
  ],
  settlements: [],
} as unknown as Group;

const thread = (messages: AiThread['messages'] = []): AiThread => ({
  threadId: 't1', surface: 'insights', scope: 'g1', title: '',
  createdAt: NOW, updatedAt: NOW, messages,
});

const baseArgs = () => ({
  thread: thread(),
  userText: 'how are we doing?',
  facts: '{"total":100}',
  group,
  currentUserId: 'u1',
});

const decision = (over: Record<string, unknown>) => ({
  intent: 'answer', confidence: 0.9, complexity: 'simple', assumption: '',
  clarifyQuestion: '', clarifyOptions: [], abstainReply: '', requests: [],
  ...over,
});

beforeEach(async () => {
  // resetAllMocks (not clearAllMocks): unconsumed mockResolvedValueOnce queues
  // must not bleed into the next test.
  vi.resetAllMocks();
  fm.availability = 'available';
  // The doc-25 answer cache is module-global — identical baseArgs would
  // cross-hit between specs without this. Memory's doc cache likewise holds
  // items after the storage underneath is wiped.
  clearAgenticAnswerCache();
  __clearMemoryCache();
  __clearAsyncStorageStore(); // memory docs etc. must not leak between specs
  await AsyncStorage.removeItem('ai_pipeline_v1');
});

describe('gating', () => {
  it('returns null when the flag is off', async () => {
    await AsyncStorage.setItem('ai_pipeline_v1', 'false');
    expect(await runAgenticTurn(baseArgs())).toBeNull();
    expect(fm.routeTurn).not.toHaveBeenCalled();
  });

  it('returns null when the model is unavailable', async () => {
    fm.availability = 'deviceNotEligible';
    expect(await runAgenticTurn(baseArgs())).toBeNull();
  });
});

describe('router intents', () => {
  it('abstain → friendly reply, no tools, no narration', async () => {
    fm.routeTurn.mockResolvedValueOnce(decision({ intent: 'abstain', abstainReply: 'Hey there!' }));
    const r = await runAgenticTurn(baseArgs());
    expect(r).toMatchObject({ role: 'assistant', text: 'Hey there!' });
    expect(fm.generateOnDeviceText).not.toHaveBeenCalled();
    expect(fm.agentLoopStep).not.toHaveBeenCalled();
  });

  it('clarify → chip options ride the reply', async () => {
    fm.routeTurn.mockResolvedValueOnce(
      decision({ intent: 'clarify', clarifyQuestion: 'Which Sam?', clarifyOptions: ['Sam Lee', 'Samir'] }),
    );
    const r = await runAgenticTurn(baseArgs());
    expect(r).toMatchObject({ role: 'clarify', text: 'Which Sam?', options: ['Sam Lee', 'Samir'] });
  });

  it('a clarify decision right after a clarify turn is demoted to answering', async () => {
    fm.routeTurn.mockResolvedValueOnce(
      decision({ intent: 'clarify', clarifyQuestion: 'Which Sam?', clarifyOptions: ['Sam Lee', 'Samir'] }),
    );
    fm.generateOnDeviceText.mockResolvedValueOnce('The total is 100 USD so far.');
    const r = await runAgenticTurn({
      ...baseArgs(),
      thread: thread([{ id: 'c1', role: 'clarify', text: 'Which Sam?', createdAt: NOW }]),
      userText: 'Sam Lee',
    });
    expect(r?.role).toBe('assistant');
  });
});

describe('the data loop', () => {
  it('executes router requests, honors loop-step continuation, narrates from real tool numbers', async () => {
    fm.routeTurn.mockResolvedValueOnce(decision({ requests: [{ tool: 'balances' }] }));
    fm.agentLoopStep
      .mockResolvedValueOnce({ done: false, requests: [{ tool: 'forecast' }] })
      .mockResolvedValueOnce({ done: true, requests: [] });
    fm.generateOnDeviceText.mockResolvedValueOnce('You are owed 50 USD overall.');

    const statuses: string[] = [];
    const r = await runAgenticTurn({ ...baseArgs(), onStatus: (s) => statuses.push(s) });

    expect(r).toMatchObject({ role: 'assistant', source: 'ondevice', text: 'You are owed 50 USD overall.' });
    expect(fm.agentLoopStep).toHaveBeenCalledTimes(2);
    // The narrator prompt carries the numbered REAL tool results.
    const narratorPrompt = fm.generateOnDeviceText.mock.calls[0][0];
    expect(narratorPrompt).toContain('T1 balances');
    expect(narratorPrompt).toContain('"yourBalance":50');
    expect(narratorPrompt).toContain('T2 forecast');
    expect(statuses.some((s) => s.includes('Writing it up'))).toBe(true);
  });

  it('caps runaway loops at the hop budget', async () => {
    fm.routeTurn.mockResolvedValueOnce(decision({ requests: [{ tool: 'balances' }] }));
    fm.agentLoopStep.mockResolvedValue({ done: false, requests: [{ tool: 'anomalies' }] });
    fm.generateOnDeviceText.mockResolvedValueOnce('The total is 100 USD.');
    const r = await runAgenticTurn(baseArgs());
    expect(r?.role).toBe('assistant');
    expect(fm.agentLoopStep.mock.calls.length).toBeLessThanOrEqual(3); // MAX_HOPS - 1
  });

  it('tool-level member ambiguity becomes a clarify with candidate chips', async () => {
    fm.routeTurn.mockResolvedValueOnce(
      decision({ requests: [{ tool: 'member_stats', member: 'sam' }] }),
    );
    fm.agentLoopStep.mockResolvedValueOnce({ done: true, requests: [] });
    const r = await runAgenticTurn(baseArgs());
    expect(r?.role).toBe('clarify');
    expect(r?.options?.sort()).toEqual(['Sam Lee', 'Samir']);
    expect(fm.generateOnDeviceText).not.toHaveBeenCalled();
  });
});

describe('narration quality gates', () => {
  it('ungrounded numbers are retried once, then the turn returns null', async () => {
    fm.routeTurn.mockResolvedValueOnce(decision({}));
    fm.generateOnDeviceText
      .mockResolvedValueOnce('You spent 99999 USD.') // invented number
      .mockResolvedValueOnce('Still 88888 USD.'); // retry also invented
    expect(await runAgenticTurn(baseArgs())).toBeNull();
    expect(fm.generateOnDeviceText).toHaveBeenCalledTimes(2);
    // The retry carries the grounding nudge in its instructions.
    expect(fm.generateOnDeviceText.mock.calls[1][1]).toContain('NOT in FACTS/TOOL RESULTS');
  });

  it('a grounded retry after a bad draft ships', async () => {
    fm.routeTurn.mockResolvedValueOnce(decision({}));
    fm.generateOnDeviceText
      .mockResolvedValueOnce('You spent 99999 USD.')
      .mockResolvedValueOnce('The group total is 100 USD.');
    const r = await runAgenticTurn(baseArgs());
    expect(r?.text).toBe('The group total is 100 USD.');
  });

  it('assumption text rides the reply for the caption', async () => {
    fm.routeTurn.mockResolvedValueOnce(decision({ assumption: 'April means April 2026' }));
    fm.generateOnDeviceText.mockResolvedValueOnce('Assuming April 2026, the total is 100 USD.');
    const r = await runAgenticTurn(baseArgs());
    expect(r?.assumption).toBe('April means April 2026');
  });

  it('router failure returns null (legacy path is the net), never throws', async () => {
    fm.routeTurn.mockRejectedValueOnce(new Error('native exploded'));
    expect(await runAgenticTurn(baseArgs())).toBeNull();
  });
});

describe('P3 PCC depth routing', () => {
  it('deep complexity + auto → PCC-first at moderate reasoning, honest badge', async () => {
    fm.routeTurn.mockResolvedValueOnce(decision({ complexity: 'deep' }));
    pcc.mockResolvedValueOnce('Deep dive: the total is 100 USD.');
    const statuses: string[] = [];
    const r = await runAgenticTurn({
      ...baseArgs(),
      userText: 'why was this month expensive?',
      onStatus: (s) => statuses.push(s),
    });
    expect(r?.source).toBe('pcc');
    expect(pcc).toHaveBeenCalledTimes(1);
    expect(pcc.mock.calls[0][2]).toBe('moderate');
    expect(statuses).toContain('Thinking deeper in Private Cloud…');
    expect(fm.generateOnDeviceText).not.toHaveBeenCalled();
  });

  it('an explicit analyze ask escalates reasoning to deep', async () => {
    fm.routeTurn.mockResolvedValueOnce(decision({ complexity: 'deep' }));
    pcc.mockResolvedValueOnce('Analysis: the total is 100 USD.');
    await runAgenticTurn({ ...baseArgs(), userText: 'analyze our spending in depth' });
    expect(pcc.mock.calls[0][2]).toBe('deep');
  });

  it('simple turns never escalate: reasoning stays local, PCC untouched', async () => {
    fm.routeTurn.mockResolvedValueOnce(decision({ complexity: 'simple' }));
    fm.generateOnDeviceText.mockResolvedValueOnce('The total is 100 USD.');
    const r = await runAgenticTurn(baseArgs());
    expect(pcc).not.toHaveBeenCalled();
    expect(r?.source).toBe('ondevice');
  });

  it('PCC unavailable on a deep turn falls back on-device, badge stays honest', async () => {
    fm.routeTurn.mockResolvedValueOnce(decision({ complexity: 'deep' }));
    pcc.mockResolvedValueOnce(null);
    fm.generateOnDeviceText.mockResolvedValueOnce('The total is 100 USD.');
    const r = await runAgenticTurn({ ...baseArgs(), userText: 'why was this month expensive?' });
    expect(r?.source).toBe('ondevice');
  });

  it("engine 'ondevice' pins local even on deep turns", async () => {
    fm.routeTurn.mockResolvedValueOnce(decision({ complexity: 'deep' }));
    fm.generateOnDeviceText.mockResolvedValueOnce('The total is 100 USD.');
    const r = await runAgenticTurn({
      ...baseArgs(),
      userText: 'why was this month expensive?',
      engine: 'ondevice',
    });
    expect(pcc).not.toHaveBeenCalled();
    expect(r?.source).toBe('ondevice');
  });
});

describe('Q1 trace + answer cache (doc 25)', () => {
  it('replies carry a full turn trace', async () => {
    fm.routeTurn.mockResolvedValueOnce(decision({ requests: [{ tool: 'balances' }] }));
    fm.agentLoopStep.mockResolvedValueOnce({ done: true, requests: [] });
    fm.generateOnDeviceText.mockResolvedValueOnce('You are owed 50 USD.');
    const r = await runAgenticTurn(baseArgs());
    expect(r?.trace).toMatchObject({
      surface: 'insights',
      scope: 'g1',
      userText: 'how are we doing?',
      intent: 'answer',
      replyRole: 'assistant',
      replyText: 'You are owed 50 USD.',
      usedLocal: false,
    });
    expect(r?.trace?.requests).toEqual([{ tool: 'balances', args: '' }]);
    expect(r?.trace?.results.some((t) => t.tool === 'balances')).toBe(true);
  });

  it('an exact-repeat question over unchanged facts answers from cache', async () => {
    fm.routeTurn.mockResolvedValueOnce(decision({}));
    fm.generateOnDeviceText.mockResolvedValueOnce('The total is 100 USD.');
    const first = await runAgenticTurn(baseArgs());
    const second = await runAgenticTurn(baseArgs());
    expect(second?.text).toBe(first?.text);
    expect(fm.routeTurn).toHaveBeenCalledTimes(1); // second turn never hit the model
  });

  it('changed facts or replay mode bypass the cache', async () => {
    fm.routeTurn.mockResolvedValue(decision({}));
    fm.generateOnDeviceText.mockResolvedValue('The total is 100 USD.');
    await runAgenticTurn(baseArgs());
    await runAgenticTurn({ ...baseArgs(), facts: '{"total":100,"count":1}' });
    await runAgenticTurn({ ...baseArgs(), replay: true });
    expect(fm.routeTurn).toHaveBeenCalledTimes(3);
  });

  it('clarify replies are never cached', async () => {
    fm.routeTurn
      .mockResolvedValueOnce(
        decision({ intent: 'clarify', clarifyQuestion: 'Which Sam?', clarifyOptions: ['Sam Lee', 'Samir'] }),
      )
      .mockResolvedValueOnce(
        decision({ intent: 'clarify', clarifyQuestion: 'Which Sam?', clarifyOptions: ['Sam Lee', 'Samir'] }),
      );
    await runAgenticTurn(baseArgs());
    const second = await runAgenticTurn(baseArgs());
    expect(second?.role).toBe('clarify');
    expect(fm.routeTurn).toHaveBeenCalledTimes(2);
  });
});

describe('P5 local-tier pinning', () => {
  it('a chat_search turn never narrates on PCC, even when deep', async () => {
    fm.routeTurn.mockResolvedValueOnce(
      decision({ complexity: 'deep', requests: [{ tool: 'chat_search', query: 'hotel' }] }),
    );
    fm.agentLoopStep.mockResolvedValueOnce({ done: true, requests: [] });
    fm.generateOnDeviceText.mockResolvedValueOnce('The total is 100 USD.');
    const r = await runAgenticTurn({
      ...baseArgs(),
      chatId: 'c1',
      userText: 'why was the hotel so expensive?',
    });
    expect(pcc).not.toHaveBeenCalled();
    expect(r?.source).toBe('ondevice');
  });

  it("engine 'pcc' removes local tools from the router's catalog", async () => {
    fm.routeTurn.mockResolvedValueOnce(decision({}));
    pcc.mockResolvedValueOnce('The total is 100 USD.');
    await runAgenticTurn({ ...baseArgs(), chatId: 'c1', engine: 'pcc' });
    expect(fm.routeTurn.mock.calls[0][0]).not.toContain('chat_search');
    expect(fm.routeTurn.mock.calls[0][0]).not.toContain('call_stats');
  });

  it('on auto with a chatId the catalog offers the local tools', async () => {
    fm.routeTurn.mockResolvedValueOnce(decision({}));
    fm.generateOnDeviceText.mockResolvedValueOnce('The total is 100 USD.');
    await runAgenticTurn({ ...baseArgs(), chatId: 'c1' });
    expect(fm.routeTurn.mock.calls[0][0]).toContain('chat_search');
    expect(fm.routeTurn.mock.calls[0][0]).toContain('call_stats');
  });
});

describe('Q2 memory (doc 25)', () => {
  it('memory rides router AND narrator instructions', async () => {
    await addMemoryItem('global', 'preference', 'keep answers short');
    fm.routeTurn.mockResolvedValueOnce(decision({}));
    fm.generateOnDeviceText.mockResolvedValueOnce('The total is 100 USD.');
    await runAgenticTurn(baseArgs());
    expect(fm.routeTurn.mock.calls[0][0]).toContain('keep answers short');
    expect(fm.generateOnDeviceText.mock.calls[0][1]).toContain('keep answers short');
  });

  it('two consistent clarify answers teach an entity fix', async () => {
    const clarifyThread = () =>
      thread([
        { id: 'u0', role: 'user', text: 'what does sam owe?', createdAt: NOW },
        { id: 'c1', role: 'clarify', text: 'Which one?', options: ['Sam Lee', 'Samir'], createdAt: NOW },
      ]);
    for (let i = 0; i < 2; i++) {
      fm.routeTurn.mockResolvedValueOnce(decision({}));
      fm.generateOnDeviceText.mockResolvedValueOnce('The total is 100 USD.');
      await runAgenticTurn({ ...baseArgs(), thread: clarifyThread(), userText: 'Sam Lee' });
    }
    expect(await getEntityFixes(['group:g1'])).toEqual({ sam: 'Sam Lee' });
  });

  it('empty memory adds nothing to the instructions', async () => {
    fm.routeTurn.mockResolvedValueOnce(decision({}));
    fm.generateOnDeviceText.mockResolvedValueOnce('The total is 100 USD.');
    await runAgenticTurn(baseArgs());
    expect(fm.routeTurn.mock.calls[0][0]).not.toContain('MEMORY');
  });
});

describe('P2 streamed narration', () => {
  it('streams cleaned partials to onDelta; final text is the stream result', async () => {
    fm.routeTurn.mockResolvedValueOnce(decision({}));
    fm.streamed.mockImplementationOnce((_p, _i, onDelta) => {
      onDelta('The total ', 'The total ');
      onDelta('is 100 USD.', 'The total is 100 USD.');
      return { promise: Promise.resolve('The total is 100 USD.'), cancel: () => {} };
    });
    const partials: string[] = [];
    const r = await runAgenticTurn({ ...baseArgs(), onDelta: (p) => partials.push(p) });
    expect(r?.text).toBe('The total is 100 USD.');
    expect(partials).toEqual(['The total', 'The total is 100 USD.']);
    // The streamed door answered — the non-streamed one was never opened.
    expect(fm.generateOnDeviceText).not.toHaveBeenCalled();
  });

  it('a streamed draft failing the grounding gate retries NON-streamed', async () => {
    fm.routeTurn.mockResolvedValueOnce(decision({}));
    fm.streamed.mockImplementationOnce((_p, _i, onDelta) => {
      onDelta('You spent 99999 USD.', 'You spent 99999 USD.');
      return { promise: Promise.resolve('You spent 99999 USD.'), cancel: () => {} };
    });
    fm.generateOnDeviceText.mockResolvedValueOnce('The total is 100 USD.');
    const r = await runAgenticTurn({ ...baseArgs(), onDelta: () => {} });
    expect(r?.text).toBe('The total is 100 USD.');
    expect(fm.streamed).toHaveBeenCalledTimes(1);
    expect(fm.generateOnDeviceText).toHaveBeenCalledTimes(1);
  });

  it('without onDelta the narrator stays on the non-streamed door', async () => {
    fm.routeTurn.mockResolvedValueOnce(decision({}));
    fm.generateOnDeviceText.mockResolvedValueOnce('The total is 100 USD.');
    const r = await runAgenticTurn(baseArgs());
    expect(r?.text).toBe('The total is 100 USD.');
    expect(fm.streamed).not.toHaveBeenCalled();
  });
});
