/**
 * outbox.ts — durable on-device write queue (AsyncStorage).
 *
 * The Firebase JS SDK is memory-cache-only on React Native: a write made offline
 * is held in memory and lost if the app is killed before reconnecting. To make
 * offline writes durable ("queue them on the device to send to the cloud"), every
 * create (add expense / settle up) is mirrored here BEFORE the network write and
 * removed once the server acknowledges it. On launch and on reconnect the queue
 * is replayed (GroupContext.flushOutbox). Replays are idempotent — the writes use
 * arrayUnion + a stable requestId, so re-applying an already-synced op is a no-op.
 *
 * Best-effort and never throws into the data path.
 */

import { getItem, setItem } from '@/utils/storage';
import type { OutboxOp } from '@/utils/outboxApply';

const KEY = 'write_outbox_v1';

/** All pending ops, oldest first. */
export async function loadOutbox(): Promise<OutboxOp[]> {
  try {
    const ops = await getItem<OutboxOp[]>(KEY);
    return Array.isArray(ops) ? ops : [];
  } catch {
    return [];
  }
}

async function saveOutbox(ops: OutboxOp[]): Promise<void> {
  try {
    await setItem(KEY, ops);
  } catch {
    // Non-blocking: queueing must never break the write path.
  }
}

/** Add an op (idempotent by id — a re-enqueue replaces the existing entry). */
export async function enqueueOp(op: OutboxOp): Promise<void> {
  const ops = await loadOutbox();
  const next = ops.filter((o) => o.id !== op.id);
  next.push(op);
  await saveOutbox(next);
}

/** Remove an op once it has been acknowledged by the server. */
export async function removeOp(id: string): Promise<void> {
  const ops = await loadOutbox();
  await saveOutbox(ops.filter((o) => o.id !== id));
}

/** Replace an op in place (e.g. after a receipt upload resolves its URL). */
export async function updateOp(op: OutboxOp): Promise<void> {
  const ops = await loadOutbox();
  await saveOutbox(ops.map((o) => (o.id === op.id ? op : o)));
}

/** Clear everything (e.g. on sign-out). */
export async function clearOutbox(): Promise<void> {
  await saveOutbox([]);
}
