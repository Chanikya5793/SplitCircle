/**
 * Chat audience reconciliation (ai_layer/docs/32 §5d, Scenario E).
 *
 * A chat doc carries membership twice — `participantIds` and
 * `participants[].userId` — and old clients did not keep them in lockstep.
 * Reading only the stored array let a stale copy win, which for a DIRECT chat
 * made `resolveMeshThreadAudience` return null (it demands exactly two), so
 * every nearby envelope for that thread was rejected on send AND receive with
 * no feedback to either side.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectLogged } from '@/testing/expectLogged';

const callable = vi.hoisted(() => ({ invoke: vi.fn(async () => ({ data: {} })) }));

vi.mock('@/firebase', () => ({ app: {} }));
vi.mock('firebase/functions', () => ({
  getFunctions: () => ({}),
  httpsCallable: () => callable.invoke,
}));

import {
  __resetChatAudienceRepairThrottle,
  reconcileChatAudience,
  requestChatAudienceRepair,
} from '../chatAudienceRepairService';

describe('reconcileChatAudience', () => {
  it('recovers a member present only in participants[]', () => {
    // The exact Scenario E shape: participantIds went stale at one entry
    // while the richer array still knew about both people.
    expect(reconcileChatAudience({
      participantIds: ['userA'],
      participants: [{ userId: 'userA' }, { userId: 'userB' }],
    })).toEqual({ participantIds: ['userA', 'userB'], diverged: true });
  });

  it('recovers a member present only in participantIds', () => {
    expect(reconcileChatAudience({
      participantIds: ['userA', 'userB'],
      participants: [{ userId: 'userA' }],
    })).toEqual({ participantIds: ['userA', 'userB'], diverged: false });
  });

  it('reports no divergence when the two agree', () => {
    expect(reconcileChatAudience({
      participantIds: ['userA', 'userB'],
      participants: [{ userId: 'userA' }, { userId: 'userB' }],
    })).toEqual({ participantIds: ['userA', 'userB'], diverged: false });
  });

  it('never invents or duplicates a member', () => {
    const { participantIds } = reconcileChatAudience({
      participantIds: ['userA', 'userA'],
      participants: [{ userId: 'userA' }],
    });
    expect(participantIds).toEqual(['userA']);
  });

  it('tolerates missing, malformed and null-ish entries', () => {
    expect(reconcileChatAudience({})).toEqual({ participantIds: [], diverged: false });
    expect(reconcileChatAudience({
      participantIds: ['userA', '', null, 7],
      participants: [null, { userId: '' }, { noUserId: true }, { userId: 'userB' }],
    })).toEqual({ participantIds: ['userA', 'userB'], diverged: true });
  });
});

describe('requestChatAudienceRepair', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetChatAudienceRepairThrottle();
  });

  it('asks the server once per chat, not once per snapshot', async () => {
    // This runs off a snapshot listener that re-fires constantly — including
    // for the update the repair itself writes, which would otherwise make it
    // self-triggering.
    await requestChatAudienceRepair(['chat-1']);
    await requestChatAudienceRepair(['chat-1', 'chat-2']);

    expect(callable.invoke).toHaveBeenCalledTimes(2);
    expect(callable.invoke).toHaveBeenNthCalledWith(1, { chatId: 'chat-1' });
    expect(callable.invoke).toHaveBeenNthCalledWith(2, { chatId: 'chat-2' });
  });

  it('swallows a failed repair — the local union already keeps this device correct', async () => {
    callable.invoke.mockRejectedValueOnce(new Error('unavailable'));
    // Swallowing is correct — the local union already keeps this device right —
    // but a repair that never succeeds leaves OTHER devices wrong, so the
    // failure must not be invisible.
    await expectLogged('Chat audience repair failed', () =>
      expect(requestChatAudienceRepair(['chat-1'])).resolves.toBeUndefined());
  });

  it('ignores empty ids', async () => {
    await requestChatAudienceRepair(['']);
    expect(callable.invoke).not.toHaveBeenCalled();
  });
});
