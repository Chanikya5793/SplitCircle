import { db } from '@/firebase';
import type { ReactionMap } from '@/models';
import {
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  type FirestoreError,
} from 'firebase/firestore';

/**
 * Cross-device "mutation state" for an existing message.
 *
 * Lives at chats/{chatId}/messageState/{messageId}. Every mutation that needs
 * to be seen by other devices (reactions, edit, delete-for-everyone) writes a
 * merged snapshot here; clients subscribe to the collection while a chat is
 * open and reconcile into local message storage.
 *
 * This is intentionally separate from the message document model — the actual
 * message body is queued via messageQueueService and persisted locally; this
 * collection just carries the state changes that happen *after* delivery.
 */
export interface MessageStateDoc {
  reactions?: ReactionMap;
  deletedForEveryone?: boolean;
  editedContent?: string;
  editedAt?: number;
  /** Server-managed updatedAt — useful for ordering races. */
  updatedAt?: unknown;
}

const stateCollection = (chatId: string) => collection(db, 'chats', chatId, 'messageState');
const stateDoc = (chatId: string, messageId: string) => doc(stateCollection(chatId), messageId);

export const publishMessageState = async (
  chatId: string,
  messageId: string,
  partial: Omit<MessageStateDoc, 'updatedAt'>,
): Promise<void> => {
  try {
    await setDoc(
      stateDoc(chatId, messageId),
      { ...partial, updatedAt: serverTimestamp() },
      { merge: true },
    );
  } catch (error) {
    // Best-effort — local write already happened, so failure here just delays
    // cross-device convergence until the next online write.
    console.warn('publishMessageState failed', error);
  }
};

export interface IncomingMessageState {
  messageId: string;
  state: MessageStateDoc;
}

export const subscribeToMessageStates = (
  chatId: string,
  onChange: (event: IncomingMessageState) => void,
  onError?: (error: FirestoreError) => void,
): (() => void) => {
  const unsubscribe = onSnapshot(
    stateCollection(chatId),
    (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'removed') continue;
        const data = change.doc.data() as MessageStateDoc;
        onChange({ messageId: change.doc.id, state: data });
      }
    },
    (error) => {
      onError?.(error);
    },
  );

  return unsubscribe;
};
