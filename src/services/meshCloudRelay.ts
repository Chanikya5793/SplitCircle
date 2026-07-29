/**
 * Uploads group messages created while offline after Internet connectivity
 * returns. Direct nearby messages deliberately never enter this path.
 */
import { db } from '@/firebase';
import { doc, updateDoc } from 'firebase/firestore';
import {
  loadMeshMessageQueue,
  removeMeshMessage,
} from '@/services/meshMessageQueue';
import {
  queueMessage,
  queueMessageToOwnDevices,
} from '@/services/messageQueueService';
import { updateMessageStatus } from '@/services/localMessageStorage';

let flushing = false;

const previewFor = (type: string, content: string): string => {
  switch (type) {
    case 'image': return 'photo';
    case 'video': return 'video';
    case 'audio': return 'audio';
    case 'file': return 'document';
    case 'location': return 'location';
    default: return content;
  }
};

export const flushMeshCloudRelay = async (currentUserId: string): Promise<void> => {
  if (!currentUserId || flushing) return;
  flushing = true;
  try {
    const operations = await loadMeshMessageQueue();
    for (const operation of operations) {
      if (
        !operation.originOwned
        || !operation.cloudRelay
        || operation.chatType !== 'group'
        || operation.originUserId !== currentUserId
      ) {
        continue;
      }

      const recipients = operation.participantIds.filter((id) => id !== currentUserId);
      try {
        for (const recipientId of recipients) {
          await queueMessage(recipientId, operation.message, true);
        }
        await queueMessageToOwnDevices(currentUserId, operation.message, true);
        await updateDoc(doc(db, 'chats', operation.message.chatId), {
          groupId: operation.groupId ?? null,
          updatedAt: operation.message.createdAt,
          lastMessage: {
            messageId: operation.message.messageId,
            senderId: operation.message.senderId,
            type: operation.message.type,
            content: previewFor(operation.message.type, operation.message.content),
            createdAt: operation.message.createdAt,
          },
        });
        await updateMessageStatus(operation.message.chatId, operation.message.id, 'sent');
        await removeMeshMessage(operation.id);
      } catch {
        // Preserve FIFO-ish behavior and retry later. Continuing after a
        // failure can reorder a conversation on the server.
        break;
      }
    }
  } finally {
    flushing = false;
  }
};
