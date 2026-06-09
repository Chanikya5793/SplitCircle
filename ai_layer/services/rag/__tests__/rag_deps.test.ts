/**
 * rag_deps.test.ts — Unit tests for the production RAGDeps adapter's pure pieces
 * (embedded-array hydration mapping) and the vertex_client REST mappers.
 * No live GCP/Firestore (Critical Rule #7).
 */

import { describe, it, expect } from 'vitest';
import { memberNameMap, expenseDocFromGroup } from '../rag_deps';
import { buildQueryRestricts, mapNeighborsResponse, mapGenerateResponse } from '../vertex_client';

const groupDoc = {
  currency: '$',
  members: [
    { userId: 'u1', displayName: 'Alex' },
    { userId: 'u2', displayName: 'Sam' },
  ],
  archivedMembers: [{ userId: 'u3', displayName: 'Robin' }],
  expenses: [
    {
      expenseId: 'e1', amount: 40, category: 'food', paidBy: 'u1',
      participants: [{ userId: 'u1' }, { userId: 'u2' }], notes: 'tip included',
      createdAt: 111, description: 'Dinner', // drift: only description set
    },
    { expenseId: 'e2', title: 'Taxi', amount: 18, paidBy: 'u3', participants: [{ userId: 'u3' }], createdAt: 222 },
  ],
};

describe('expenseDocFromGroup (embedded-array hydration)', () => {
  it('extracts an expense and resolves payer/participant names + currency', () => {
    const doc = expenseDocFromGroup(groupDoc, 'g1', 'e1');
    expect(doc).toMatchObject({
      expenseId: 'e1', groupId: 'g1', amount: 40, category: 'food',
      currency: '$', paidBy: 'u1', paidByName: 'Alex', createdAt: 111,
    });
    expect(doc!.participantNames).toEqual(['Alex', 'Sam']);
  });

  it('tolerates title/description drift (uses description as title fallback)', () => {
    expect(expenseDocFromGroup(groupDoc, 'g1', 'e1')!.title).toBe('Dinner');
    expect(expenseDocFromGroup(groupDoc, 'g1', 'e2')!.title).toBe('Taxi');
  });

  it('resolves names from archivedMembers too', () => {
    expect(expenseDocFromGroup(groupDoc, 'g1', 'e2')!.paidByName).toBe('Robin');
  });

  it('returns null for a missing group or expense', () => {
    expect(expenseDocFromGroup(undefined, 'g1', 'e1')).toBeNull();
    expect(expenseDocFromGroup(groupDoc, 'g1', 'nope')).toBeNull();
  });

  it('memberNameMap merges active + archived members', () => {
    expect(memberNameMap(groupDoc)).toEqual({ u1: 'Alex', u2: 'Sam', u3: 'Robin' });
  });
});

describe('vertex_client pure mappers', () => {
  it('builds user-only restricts, adding group when provided', () => {
    expect(buildQueryRestricts('u1')).toEqual([{ namespace: 'user', allowList: ['u1'] }]);
    expect(buildQueryRestricts('u1', 'g1')).toEqual([
      { namespace: 'user', allowList: ['u1'] },
      { namespace: 'group', allowList: ['g1'] },
    ]);
  });

  it('maps findNeighbors response to a ranked, id-filtered list', () => {
    const json = {
      nearestNeighbors: [{
        neighbors: [
          { datapoint: { datapointId: 'g1:e1' }, distance: 0.1 },
          { datapoint: { datapointId: 'g1:e2' }, distance: 0.3 },
          { datapoint: {}, distance: 0.9 }, // dropped (no id)
        ],
      }],
    };
    expect(mapNeighborsResponse(json)).toEqual([
      { datapointId: 'g1:e1', distance: 0.1 },
      { datapointId: 'g1:e2', distance: 0.3 },
    ]);
    expect(mapNeighborsResponse({})).toEqual([]);
  });

  it('maps Gemini response to text + token usage', () => {
    const json = {
      candidates: [{ content: { parts: [{ text: 'You spent $40 ' }, { text: '[1].' }] } }],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 12 },
    };
    expect(mapGenerateResponse(json)).toEqual({ text: 'You spent $40 [1].', promptTokens: 120, candidateTokens: 12 });
  });
});
