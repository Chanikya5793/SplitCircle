/**
 * notificationRevoke.test.ts — the pure extractor behind the background
 * revoke handler: pulling revoke filters out of the differently-wrapped
 * silent push payloads iOS and Android deliver.
 */

import { describe, it, expect } from 'vitest';

import { extractRevokeFilters } from '../notificationRevoke';

describe('extractRevokeFilters', () => {
  it('returns nothing for empty or malformed payloads', () => {
    expect(extractRevokeFilters(null)).toEqual([]);
    expect(extractRevokeFilters(undefined)).toEqual([]);
    expect(extractRevokeFilters('not json')).toEqual([]);
    expect(extractRevokeFilters(42)).toEqual([]);
    expect(extractRevokeFilters({})).toEqual([]);
  });

  it('ignores non-revoke payloads', () => {
    expect(
      extractRevokeFilters({ type: 'expense', groupId: 'g1', expenseId: 'e1' }),
    ).toEqual([]);
  });

  it('ignores a revoke marker without any entity id', () => {
    expect(extractRevokeFilters({ type: 'revoke' })).toEqual([]);
    expect(extractRevokeFilters({ type: 'revoke', groupId: '' })).toEqual([]);
  });

  it('extracts a flat revoke payload', () => {
    expect(extractRevokeFilters({ type: 'revoke', groupId: 'g1' })).toEqual([
      { groupId: 'g1' },
    ]);
    expect(
      extractRevokeFilters({ type: 'revoke', expenseId: 'e1', deliveryId: 'd1' }),
    ).toEqual([{ expenseId: 'e1' }]);
  });

  it('extracts an APNs-style payload with data nested under body', () => {
    const payload = {
      aps: { 'content-available': 1 },
      body: { type: 'revoke', settlementId: 's1' },
    };
    expect(extractRevokeFilters(payload)).toEqual([{ settlementId: 's1' }]);
  });

  it('extracts an FCM-style payload with stringified JSON body', () => {
    const payload = {
      data: { body: JSON.stringify({ type: 'revoke', groupId: 'g9' }) },
    };
    expect(extractRevokeFilters(payload)).toEqual([{ groupId: 'g9' }]);
  });

  it('extracts an expo-notifications envelope shape', () => {
    const payload = {
      notification: {
        request: {
          content: {
            data: { type: 'revoke', expenseId: 'e7' },
          },
        },
      },
    };
    expect(extractRevokeFilters(payload)).toEqual([{ expenseId: 'e7' }]);
  });

  it('deduplicates the same filter found at multiple nesting levels', () => {
    const inner = { type: 'revoke', groupId: 'g1' };
    const payload = {
      data: inner,
      body: JSON.stringify(inner),
    };
    expect(extractRevokeFilters(payload)).toEqual([{ groupId: 'g1' }]);
  });

  it('carries multiple ids on one filter', () => {
    expect(
      extractRevokeFilters({ type: 'revoke', groupId: 'g1', chatId: 'c1' }),
    ).toEqual([{ groupId: 'g1', chatId: 'c1' }]);
  });

  it('stops descending at the depth limit instead of recursing forever', () => {
    const target = { type: 'revoke', groupId: 'deep' };
    let wrapped: Record<string, unknown> = target;
    for (let i = 0; i < 20; i += 1) {
      wrapped = { nested: wrapped };
    }
    expect(extractRevokeFilters(wrapped)).toEqual([]);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(extractRevokeFilters(cyclic)).toEqual([]);
  });
});
