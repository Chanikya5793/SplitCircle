/**
 * insightsChatWrites.test.ts — insights chat write delegation (doc 24 P4).
 * Pins: action-shaped messages route to the assistant machinery (payload
 * confirm cards, conversation state in thread.meta), resolveInsightsAction
 * flips card state, and stale pending cards retire on thread resume.
 *
 * The model layer is fully mocked (runAgenticTurn → null) so ONLY the
 * deterministic write path is under test; the thread store is real over the
 * in-memory AsyncStorage mock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __clearAsyncStorageStore } from './mocks/async-storage';
import type { Group } from '@/models';

vi.mock('../../../modules/splitcircle-ai', () => ({
  isAgenticNativeAvailable: () => false,
  getOnDeviceAiAvailability: () => 'available',
  getOnDeviceContextSize: () => 4096,
  generateOnDeviceText: vi.fn(async () => ''),
  generateOnDeviceTextStreamed: vi.fn(),
  routeTurn: vi.fn(),
  agentLoopStep: vi.fn(),
  askOnDevice: vi.fn(async () => ({ answer: '', sourceIndexes: [] })),
  planExpenseQuery: vi.fn(async () => ({})),
  redactPII: (t: string) => t,
  donateAskActivity: vi.fn(async () => undefined),
}));
vi.mock('@/services/insightsAiService', () => ({
  tryPccPrompt: vi.fn(async () => null),
}));
vi.mock('@/services/aiPipelineService', () => ({
  runAgenticTurn: vi.fn(async () => null),
}));

import * as threadStore from '../aiThreadStore';
import {
  actionPayloadOf,
  INSIGHTS_SURFACE,
  openInsightsThread,
  resolveInsightsAction,
  sendInsightsMessage,
} from '../insightsChatService';
import type { ConversationState } from '../assistantService';

const NOW = Date.now();

const group = {
  groupId: 'g1',
  name: 'Flat 42',
  currency: 'USD',
  updatedAt: NOW,
  budgets: { Food: 200 },
  members: [
    { userId: 'u1', displayName: 'Chan' },
    { userId: 'u2', displayName: 'Maya' },
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

const freshThread = () =>
  threadStore.createThread({
    surface: INSIGHTS_SURFACE,
    scope: 'g1',
    title: 'test',
    messages: [
      { id: 'seed', role: 'assistant' as const, text: 'Here are your insights.', createdAt: NOW },
    ],
  });

beforeEach(() => {
  __clearAsyncStorageStore();
});

describe('write delegation (doc 24 P4)', () => {
  it('"set the Food budget to 300" produces a pending set_budget confirm card', async () => {
    const thread = await freshThread();
    const { reply, thread: next } = await sendInsightsMessage({
      thread,
      userText: 'set the Food budget to 300',
      facts: '{"total":100}',
      group,
      currentUserId: 'u1',
    });
    const payload = actionPayloadOf(reply.payload);
    expect(payload?.state).toBe('pending');
    expect(payload?.action).toMatchObject({ type: 'set_budget', category: 'Food', amount: 300 });
    expect(payload?.action.summary).toContain('was 200.00 USD'); // update, not create
    // The assistant's conversation memory rides thread.meta.
    const state = next.meta?.assistantState as ConversationState;
    expect(state.lastProposed?.type).toBe('set_budget');
  });

  it('an add-expense phrase delegates to the assistant machinery', async () => {
    const thread = await freshThread();
    const { reply, thread: next } = await sendInsightsMessage({
      thread,
      userText: 'add 20 for lunch',
      facts: '{"total":100}',
      group,
      currentUserId: 'u1',
    });
    // Slot-filling may propose immediately or ask back with chips — both are
    // the assistant flow working; either way the state patch must land.
    const payload = actionPayloadOf(reply.payload);
    expect(payload?.action.type ?? 'asked').toMatch(/add_expense|asked/);
    expect(payload || reply.options?.length || reply.text.length).toBeTruthy();
    expect(next.meta?.assistantState).toBeDefined();
  });

  it('question-shaped messages do NOT delegate (fall through to Q paths)', async () => {
    const thread = await freshThread();
    // With every model mocked to silence, reaching the narrative path (i.e.
    // NOT the write delegation) surfaces as this exact throw.
    await expect(
      sendInsightsMessage({
        thread,
        userText: 'how are we doing on the food budget?',
        facts: '{"total":100}',
        group,
        currentUserId: 'u1',
      }),
    ).rejects.toThrow('No model available for a reply.');
  });

  it('resolveInsightsAction flips the card and clears the draft state', async () => {
    const thread = await freshThread();
    const { reply, thread: withCard } = await sendInsightsMessage({
      thread,
      userText: 'set the Food budget to 300',
      facts: '{"total":100}',
      group,
      currentUserId: 'u1',
    });
    const done = await resolveInsightsAction({
      thread: withCard,
      messageId: reply.id,
      outcome: 'done',
      confirmationText: '✓ Budget set.',
    });
    const card = done.messages.find((m) => m.id === reply.id);
    expect(actionPayloadOf(card?.payload)?.state).toBe('done');
    expect(done.messages[done.messages.length - 1].text).toBe('✓ Budget set.');
    expect(done.meta?.assistantState).toEqual({});
  });
});

describe('stale-card sweep on resume (doc 17 A.7)', () => {
  it('retires pending cards older than the window, keeps fresh ones', async () => {
    const thread = await freshThread();
    const staleMs = NOW - 11 * 60 * 1000;
    const stale = {
      ...thread,
      messages: [
        ...thread.messages,
        {
          id: 'old-card', role: 'assistant' as const, text: 'Add this?', createdAt: staleMs,
          payload: { action: { type: 'set_budget', category: 'Food', amount: 300, summary: 'x' }, state: 'pending' },
        },
        {
          id: 'fresh-card', role: 'assistant' as const, text: 'Add this too?', createdAt: NOW - 60_000,
          payload: { action: { type: 'set_budget', category: 'Travel', amount: 100, summary: 'y' }, state: 'pending' },
        },
      ],
    };
    await threadStore.saveThread(stale);

    const { thread: resumed } = await openInsightsThread({
      scope: 'g1',
      facts: '{"total":100}',
      narrative: 'seed',
      seedTitle: 'seed',
    });
    expect(resumed.threadId).toBe(thread.threadId); // resumed, not recreated
    const oldCard = actionPayloadOf(resumed.messages.find((m) => m.id === 'old-card')?.payload);
    const freshCard = actionPayloadOf(resumed.messages.find((m) => m.id === 'fresh-card')?.payload);
    expect(oldCard?.state).toBe('cancelled');
    expect(freshCard?.state).toBe('pending');
  });
});
