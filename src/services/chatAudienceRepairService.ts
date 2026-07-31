/**
 * Client half of the chat-audience repair (ai_layer/docs/32 §5d).
 *
 * `ChatContext`'s thread snapshot already unions `participantIds` with
 * `participants[].userId` locally, which is enough for THIS device to address
 * nearby messages correctly. This asks the server to make that union the
 * stored truth, which fixes the one case a local union provably cannot: a user
 * missing from `participantIds` never matches the `array-contains` query that
 * loads their chat list, so that device never receives the document it would
 * need to repair. Someone else who can see the chat has to fix it for them.
 *
 * Deliberately fire-and-forget and heavily throttled — it runs off a snapshot
 * listener that can fire repeatedly, and a failed repair is not worth
 * interrupting anyone over. The local union means nothing on this device is
 * waiting on it.
 */
import { app } from '@/firebase';
import { getFunctions, httpsCallable } from 'firebase/functions';

const functions = getFunctions(app);

interface RepairChatAudienceResponse {
  repaired: boolean;
  participantIds: string[];
}

const repairCallable = httpsCallable<{ chatId: string }, RepairChatAudienceResponse>(
  functions,
  'repairChatAudience',
);

/**
 * Chats this app session has already asked the server to repair. Prevents a
 * chatty snapshot listener from re-requesting the same repair on every update
 * — including the update the repair itself produces, which would otherwise
 * make this self-triggering.
 */
const requested = new Set<string>();

export const requestChatAudienceRepair = async (chatIds: string[]): Promise<void> => {
  for (const chatId of chatIds) {
    if (!chatId || requested.has(chatId)) continue;
    requested.add(chatId);
    try {
      await repairCallable({ chatId });
    } catch (error) {
      // Never surfaced: the local union already keeps this device correct, and
      // the repair is an opportunistic fix for everyone else. console.error
      // rather than warn so it is visible in a Release device log if this ever
      // needs diagnosing (CLAUDE.md).
      console.error('Chat audience repair failed', chatId, error);
    }
  }
};

/** Test seam — the throttle is module state that would leak between cases. */
export const __resetChatAudienceRepairThrottle = (): void => {
  requested.clear();
};

/**
 * Treats a chat doc's two membership representations as one logical set.
 *
 * `participantIds` and `participants[].userId` are supposed to agree; older
 * clients did not keep them in lockstep. Reading only the stored
 * `participantIds` meant a stale array won, and for a DIRECT chat that made
 * `resolveMeshThreadAudience` return null — it requires exactly two people —
 * so every nearby envelope for that thread was rejected on send AND receive,
 * silently. Unioning is safe because both arrays are already part of the same
 * document: this can surface a member the local copy was ignoring, never
 * invent one.
 *
 * `diverged` reports that the stored `participantIds` was missing someone,
 * which is what makes the server-side repair worth requesting.
 */
export const reconcileChatAudience = (data: {
  participantIds?: unknown;
  participants?: unknown;
}): { participantIds: string[]; diverged: boolean } => {
  const stored = Array.isArray(data.participantIds)
    ? data.participantIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  const fromParticipants = Array.isArray(data.participants)
    ? data.participants
      .map((participant) => (participant as { userId?: unknown } | null)?.userId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];

  const participantIds = [...new Set([...stored, ...fromParticipants])];
  return { participantIds, diverged: participantIds.length !== stored.length };
};
