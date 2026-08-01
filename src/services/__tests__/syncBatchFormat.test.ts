/**
 * Gap-fill batch format (ai_layer/docs/34 §3.1/§3.2, step 4).
 *
 * Weighted toward the security-relevant invariants rather than happy-path
 * packing. A batch is history handed over by another device: if it can quietly
 * return a subset, omit messages, or claim a range it did not serve, the
 * requester has no way to tell that from "there was nothing more" — and doc 34
 * §0.2 is what silent sync failure costs.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_SYNC_BATCH_BYTES,
  isBatchForRequest,
  needsContinuation,
  packSyncBatch,
  parseSyncBatchBody,
} from '../syncBatchFormat';
import type { ChatMessage } from '@/models';

const msg = (id: string, createdAt: number, chatId = 'chat-1'): ChatMessage => ({
  id,
  messageId: id,
  chatId,
  senderId: 'u1',
  content: 'hello',
  type: 'text',
  createdAt,
  timestamp: createdAt,
} as unknown as ChatMessage);

describe('packSyncBatch', () => {
  it('includes only messages newer than the requested watermark', () => {
    const body = packSyncBatch('chat-1', 100, [
      msg('old', 50), msg('edge', 100), msg('new', 150),
    ]);
    expect(body.messages.map((m) => m.id)).toEqual(['new']);
  });

  it('orders oldest first so a truncated batch is self-resuming', () => {
    // Newest-first would leave a permanent hole in the middle that nothing
    // would ever ask for again.
    const body = packSyncBatch('chat-1', 0, [msg('c', 300), msg('a', 100), msg('b', 200)]);
    expect(body.messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('reports complete when it served everything available', () => {
    const body = packSyncBatch('chat-1', 0, [msg('a', 100), msg('b', 200)]);
    expect(body.complete).toBe(true);
    expect(body.until).toBe(200);
  });

  it('marks truncation explicitly and points `until` at what it actually sent', () => {
    // The requester must be able to tell "that is everything" from "there is
    // more" — otherwise a byte cap silently becomes data loss.
    const many = Array.from({ length: 400 }, (_, i) => msg(`m${i}`, 1000 + i));
    const body = packSyncBatch('chat-1', 0, many, 2_000);

    expect(body.complete).toBe(false);
    expect(body.messages.length).toBeLessThan(many.length);
    expect(body.until).toBe(body.messages[body.messages.length - 1].createdAt);
    expect(needsContinuation(body)).toBe(true);
  });

  it('bounds by BYTES, not message count', () => {
    // 200 text messages and 200 with media metadata differ by orders of
    // magnitude; a count cap either wastes the budget or blows it.
    const fat = Array.from({ length: 50 }, (_, i) => ({
      ...msg(`m${i}`, 1000 + i),
      content: 'x'.repeat(500),
    } as ChatMessage));
    const body = packSyncBatch('chat-1', 0, fat, 5_000);
    expect(JSON.stringify(body.messages).length).toBeLessThanOrEqual(6_000);
    expect(body.complete).toBe(false);
  });

  it('still sends a single message that alone exceeds the budget', () => {
    // Refusing would stall the gap permanently on one oversized message, which
    // is strictly worse than one oversized batch.
    const huge = { ...msg('huge', 1000), content: 'x'.repeat(10_000) } as ChatMessage;
    const body = packSyncBatch('chat-1', 0, [huge], 100);
    expect(body.messages).toHaveLength(1);
    expect(body.complete).toBe(true);
  });

  it('produces an empty, complete batch when there is genuinely nothing', () => {
    const body = packSyncBatch('chat-1', 500, [msg('old', 100)]);
    expect(body.messages).toEqual([]);
    expect(body.complete).toBe(true);
    expect(needsContinuation(body)).toBe(false);
  });

  it('defaults to the shared byte budget', () => {
    expect(MAX_SYNC_BATCH_BYTES).toBe(256 * 1024);
    expect(packSyncBatch('chat-1', 0, [msg('a', 1)]).complete).toBe(true);
  });
});

describe('parseSyncBatchBody', () => {
  it('round-trips a packed batch through JSON', () => {
    const body = packSyncBatch('chat-1', 0, [msg('a', 100), msg('b', 200)]);
    expect(parseSyncBatchBody(JSON.parse(JSON.stringify(body)))).toEqual(body);
  });

  it('rejects garbage rather than throwing into the receive path', () => {
    for (const bad of [null, undefined, 'nope', 42, {}, { v: 2 }]) {
      expect(parseSyncBatchBody(bad)).toBeNull();
    }
  });

  it('rejects a batch whose range ends before it starts', () => {
    const body = { ...packSyncBatch('chat-1', 500, []), until: 100 };
    expect(parseSyncBatchBody(body)).toBeNull();
  });

  it('rejects the WHOLE batch when any message is malformed', () => {
    // Dropping the bad member silently would make the batch quietly lossy,
    // which is exactly what this format exists to prevent.
    const body = packSyncBatch('chat-1', 0, [msg('a', 100)]);
    const tampered = { ...body, messages: [...body.messages, { id: 'no-chat-id' }] };
    expect(parseSyncBatchBody(tampered)).toBeNull();
  });
});

describe('isBatchForRequest', () => {
  const request = { chatId: 'chat-1', sinceTimestamp: 100 };

  it('accepts a batch that matches what was asked for', () => {
    expect(isBatchForRequest(packSyncBatch('chat-1', 100, [msg('a', 150)]), request)).toBe(true);
  });

  it('accepts a responder serving from EARLIER than asked', () => {
    // Redundant but harmless — the requester dedupes by message id.
    expect(isBatchForRequest(packSyncBatch('chat-1', 50, [msg('a', 150)]), request)).toBe(true);
  });

  it('REJECTS a responder serving from later than asked', () => {
    // This is the omission attack: starting late silently skips everything
    // between what was requested and what was sent, and the gap looks closed.
    expect(isBatchForRequest(packSyncBatch('chat-1', 500, [msg('a', 600)]), request)).toBe(false);
  });

  it('rejects a batch for a different chat', () => {
    expect(isBatchForRequest(packSyncBatch('chat-2', 100, [msg('a', 150, 'chat-2')]), request))
      .toBe(false);
  });

  it('rejects a batch smuggling a message from another chat', () => {
    const body = packSyncBatch('chat-1', 100, [msg('a', 150)]);
    const tampered = { ...body, messages: [...body.messages, msg('x', 160, 'chat-99')] };
    expect(isBatchForRequest(tampered, request)).toBe(false);
  });

  it('rejects a batch containing a message outside its own claimed range', () => {
    const body = packSyncBatch('chat-1', 100, [msg('a', 150)]);
    const tampered = { ...body, messages: [...body.messages, msg('sneaky', 10)] };
    expect(isBatchForRequest(tampered, request)).toBe(false);
  });
});
