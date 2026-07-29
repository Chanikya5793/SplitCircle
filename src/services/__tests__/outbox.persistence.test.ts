/**
 * Offline regression coverage for the durable expense/settlement outbox.
 *
 * Firebase's JavaScript client used by the native app has no durable
 * Firestore cache here, so this queue is the last line of defence between an
 * offline edit and an app termination. These tests exercise its storage
 * contract without needing a network or Firebase emulator.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { __clearAsyncStorageStore } from './mocks/async-storage';
import { clearOutbox, enqueueOp, loadOutbox, removeOp, updateOp } from '../outbox';
import type { Expense } from '@/models/expense';
import type { OutboxOp } from '@/utils/outboxApply';

const expenseOp = (id: string): OutboxOp => ({
  id,
  kind: 'addExpense',
  groupId: 'group-1',
  createdAt: 1_000,
  expense: {
    expenseId: `expense-${id}`,
    requestId: id,
    groupId: 'group-1',
    title: 'Coffee',
    category: 'Food',
    amount: 12,
    paidBy: 'user-1',
    splitType: 'equal',
    participants: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    settled: false,
  } satisfies Expense,
});

describe('durable offline outbox', () => {
  beforeEach(async () => {
    __clearAsyncStorageStore();
    await clearOutbox();
  });

  it('keeps queued writes in insertion order until their server acknowledgement', async () => {
    await enqueueOp(expenseOp('first'));
    await enqueueOp(expenseOp('second'));

    expect((await loadOutbox()).map((op) => op.id)).toEqual(['first', 'second']);

    await removeOp('first');
    expect((await loadOutbox()).map((op) => op.id)).toEqual(['second']);
  });

  it('replaces a retry with the same id instead of creating a duplicate upload', async () => {
    await enqueueOp(expenseOp('same'));
    const replacement = { ...expenseOp('same'), attempts: 2 } as OutboxOp;

    await enqueueOp(replacement);
    expect(await loadOutbox()).toEqual([replacement]);
  });

  it('persists a media-url update and can explicitly clear all queued local work', async () => {
    const original = expenseOp('receipt');
    await enqueueOp(original);
    const updated = { ...original, fileUri: 'file:///receipt.jpg', fileName: 'receipt.jpg' } as OutboxOp;

    await updateOp(updated);
    expect(await loadOutbox()).toEqual([updated]);

    await clearOutbox();
    expect(await loadOutbox()).toEqual([]);
  });
});
