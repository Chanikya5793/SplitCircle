import AsyncStorage from '@react-native-async-storage/async-storage';
import type { MessageStateDoc } from '@/services/messageStateService';

const STORAGE_KEY = 'pending_message_states';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface PendingStateEntry {
  chatId: string;
  messageId: string;
  partial: Omit<MessageStateDoc, 'updatedAt'>;
  createdAt: number;
}

let draining = false;

const readQueue = async (): Promise<PendingStateEntry[]> => {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as PendingStateEntry[];
  } catch {
    return [];
  }
};

const writeQueue = async (entries: PendingStateEntry[]): Promise<void> => {
  if (entries.length === 0) {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } else {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  }
};

export const enqueue = async (
  chatId: string,
  messageId: string,
  partial: Omit<MessageStateDoc, 'updatedAt'>,
): Promise<void> => {
  try {
    const queue = await readQueue();
    queue.push({ chatId, messageId, partial, createdAt: Date.now() });
    await writeQueue(queue);
  } catch (error) {
    console.warn('pendingStateQueue: enqueue failed', error);
  }
};

export const drain = async (): Promise<void> => {
  if (draining) return;
  draining = true;

  try {
    const queue = await readQueue();
    if (queue.length === 0) return;

    const now = Date.now();
    const valid = queue.filter((e) => now - e.createdAt < MAX_AGE_MS);
    if (valid.length === 0) {
      await writeQueue([]);
      return;
    }

    const { publishMessageState } = await import('@/services/messageStateService');
    const remaining: PendingStateEntry[] = [];

    for (const entry of valid) {
      try {
        await publishMessageState(entry.chatId, entry.messageId, entry.partial);
      } catch {
        remaining.push(entry);
      }
    }

    await writeQueue(remaining);
    if (remaining.length === 0) {
      console.log('✅ pendingStateQueue: all entries drained');
    } else {
      console.log(`⚠️ pendingStateQueue: ${remaining.length} entries still pending`);
    }
  } catch (error) {
    console.warn('pendingStateQueue: drain failed', error);
  } finally {
    draining = false;
  }
};

export const getPendingCount = async (): Promise<number> => {
  const queue = await readQueue();
  return queue.length;
};
