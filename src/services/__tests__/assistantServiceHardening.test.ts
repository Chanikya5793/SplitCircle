import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Group } from '@/models';

const pipeline = vi.hoisted(() => ({ runAgenticTurn: vi.fn() }));
const device = vi.hoisted(() => ({
  answerExpenseLocally: vi.fn(),
  askExpenseAiOnDevice: vi.fn(),
  availability: vi.fn(() => 'available'),
}));

vi.mock('@/services/aiPipelineService', () => ({ runAgenticTurn: pipeline.runAgenticTurn }));
vi.mock('@/services/onDeviceAiService', () => ({
  answerExpenseLocally: device.answerExpenseLocally,
  askExpenseAiOnDevice: device.askExpenseAiOnDevice,
  getOnDeviceAiAvailability: device.availability,
}));
vi.mock('@/services/aiMemoryService', () => ({ addItem: vi.fn(async () => undefined) }));

import { processAssistantTurn } from '../assistantService';

const NOW = 1_700_000_000_000;
const group = {
  groupId: 'g1',
  name: 'Flat',
  currency: 'USD',
  updatedAt: NOW,
  members: [
    { userId: 'u1', displayName: 'Chan', role: 'owner', balance: 0 },
    { userId: 'u2', displayName: 'Maya', role: 'member', balance: 0 },
  ],
  expenses: [{
    expenseId: 'e1',
    revision: 3,
    groupId: 'g1',
    title: 'Dinner',
    category: 'Food',
    amount: 60,
    paidBy: 'u1',
    splitType: 'equal',
    participants: [{ userId: 'u1', share: 30 }, { userId: 'u2', share: 30 }],
    settled: false,
    createdAt: NOW - 100,
    updatedAt: NOW - 50,
  }],
  settlements: [{
    settlementId: 's1',
    fromUserId: 'u2',
    toUserId: 'u1',
    amount: 30,
    createdAt: NOW - 20,
    status: 'completed',
  }],
} as Group;

const agentic = {
  thread: {
    threadId: 't1', surface: 'assistant', scope: 'g1', title: '',
    createdAt: NOW, updatedAt: NOW, messages: [],
  },
  facts: '{"total":60}',
};

beforeEach(() => {
  vi.resetAllMocks();
  device.availability.mockReturnValue('available');
  device.answerExpenseLocally.mockReturnValue(null);
  device.askExpenseAiOnDevice.mockResolvedValue(null);
  pipeline.runAgenticTurn.mockResolvedValue(null);
});

describe('assistant hardening metadata', () => {
  it('labels deterministic fast-path answers explicitly', async () => {
    device.answerExpenseLocally.mockReturnValueOnce({
      answer: 'You spent 30 USD.',
      sources: [{ expenseId: 'e1', groupId: 'g1', title: 'Dinner', amount: 60, currency: 'USD' }],
    });
    const turn = await processAssistantTurn('how much did I spend?', group, 'u1');
    expect(turn).toMatchObject({ reply: 'You spent 30 USD.', engineSource: 'deterministic' });
  });

  it('forwards the actual model engine and typed capability evidence', async () => {
    pipeline.runAgenticTurn.mockResolvedValueOnce({
      role: 'assistant',
      text: 'The balance is 30 USD.',
      source: 'pcc',
      evidence: [{
        kind: 'capability', tool: 'balances', version: 1, title: 'Balances',
        dataClasses: ['persistent_money'],
      }],
    });
    const turn = await processAssistantTurn('explain our balance', group, 'u1', {}, agentic);
    expect(turn.engineSource).toBe('pcc');
    expect(turn.evidence).toEqual([
      expect.objectContaining({ tool: 'balances', version: 1, dataClasses: ['persistent_money'] }),
    ]);
  });

  it('labels the legacy on-device fallback honestly', async () => {
    device.askExpenseAiOnDevice.mockResolvedValueOnce({ answer: 'The total is 60 USD.', sources: [] });
    const turn = await processAssistantTurn('explain this group', group, 'u1');
    expect(turn.engineSource).toBe('ondevice');
  });

  it('captures the expense version on destructive proposals', async () => {
    const turn = await processAssistantTurn('delete the dinner expense', group, 'u1');
    expect(turn.action).toMatchObject({
      type: 'delete_expense',
      expenseId: 'e1',
      expectedRevision: 3,
      expectedUpdatedAt: NOW - 50,
    });
  });

  it('gives legacy settlements a revision-one delete guard', async () => {
    const turn = await processAssistantTurn('delete the last settlement', group, 'u1');
    expect(turn.action).toMatchObject({
      type: 'delete_settlement',
      settlementId: 's1',
      expectedRevision: 1,
    });
  });
});
