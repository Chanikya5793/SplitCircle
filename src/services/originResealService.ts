/**
 * Origin re-seal, the rebuild half (ai_layer/docs/33 §2.5, Phase 8).
 *
 * `mesh/originReseal.ts` decides WHETHER; this does it. Split that way because
 * the decision is a security rule that must be testable exhaustively without a
 * device, while this half needs the identity key and the thread.
 *
 * A device added to a thread after an envelope was sealed can never receive
 * that message: relays forward frozen ciphertext and no copy is addressed to
 * it (doc 32 §5e). Re-building the envelope from the same message against the
 * CURRENT thread re-seals it for every device now in the audience, including
 * the new one.
 *
 * ONLY THE ORIGIN DOES THIS. `evaluateReseal` refuses anything not
 * `originOwned` before any other check — a relay minting ciphertext attributed
 * to another sender is forgery, and that ordering is the guard.
 */
import type { ChatThread } from '@/models';
import {
  buildMeshMessageBody,
  signMeshMessageBody,
} from '@/services/meshMessageProtocol';
import {
  loadMeshMessageQueue,
  updateMeshMessage,
  type MeshMessageOperation,
} from '@/services/meshMessageQueue';
import { evaluateReseal } from '@/services/mesh/originReseal';

export interface ResealSummary {
  examined: number;
  resealed: number;
  /** Device ids that gained a copy, for diagnostics. */
  coveredDeviceIds: string[];
}

/**
 * Re-seals this device's own queued messages for any device that has since
 * joined their thread.
 *
 * Called on thread changes — the moment a new device can become known — rather
 * than on a timer, so it costs nothing while the audience is stable.
 */
export const resealOwnedMeshOperations = async (
  threads: readonly ChatThread[],
  originUserId: string,
  originDeviceId: string,
  currentDevicesForThread: (thread: ChatThread) => Promise<string[]>,
): Promise<ResealSummary> => {
  const summary: ResealSummary = { examined: 0, resealed: 0, coveredDeviceIds: [] };
  const operations = await loadMeshMessageQueue().catch(() => [] as MeshMessageOperation[]);
  if (operations.length === 0) return summary;

  const threadById = new Map(threads.map((thread) => [thread.chatId, thread]));

  for (const operation of operations) {
    // Cheap guards BEFORE the expensive device lookup: most operations are
    // relayed copies or already covered, and enumerating devices per operation
    // on every thread change would be the expensive part of this pass.
    if (!operation.originOwned || !operation.wireEnvelope) continue;
    const thread = threadById.get(operation.message.chatId);
    if (!thread) continue;

    summary.examined += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      const deviceIds = await currentDevicesForThread(thread);
      const verdict = evaluateReseal(operation, deviceIds, Date.now());
      if (!verdict.reseal) continue;

      // eslint-disable-next-line no-await-in-loop
      const body = await buildMeshMessageBody({
        message: operation.message,
        thread,
        originUserId,
        originDeviceId,
      });
      // Null means the thread's audience is no longer coherent (a direct chat
      // that lost a participant, or we are no longer in it). Leaving the old
      // envelope alone is correct: it still serves whoever it was sealed for.
      if (!body) continue;

      // eslint-disable-next-line no-await-in-loop
      const wireEnvelope = await signMeshMessageBody(body);
      // eslint-disable-next-line no-await-in-loop
      await updateMeshMessage({
        ...operation,
        wireEnvelope,
        recipientDeviceIds: Object.keys(body.encryptedForDevices),
        // Clear the broadcast stamp so the next topology change re-broadcasts
        // it. Without this the fresh envelope sits in the queue behind a flag
        // saying it was already sent, and the new device never sees it — the
        // exact failure this whole path exists to fix.
        meshBroadcastAt: undefined,
      });
      summary.resealed += 1;
      summary.coveredDeviceIds.push(...verdict.missingDeviceIds);
    } catch {
      // One un-resealable message must not stop the rest. The old envelope is
      // untouched, so this is a missed improvement rather than a regression.
    }
  }

  return summary;
};
