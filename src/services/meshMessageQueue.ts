import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChatMessage, ChatThread } from '@/models';

const STORAGE_KEY = 'nearby_message_queue_v1';
const MAX_MESH_MESSAGE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface MeshMessageOperation {
  id: string;
  message: ChatMessage;
  chatType: ChatThread['type'];
  groupId?: string;
  participantIds: string[];
  /** Installation ids that actually have a Signal-wrapped copy in the signed
   * envelope. Native transport targets only these peers, so unrelated trusted
   * contacts never receive another conversation's public envelope metadata. */
  recipientDeviceIds?: string[];
  originUserId: string;
  originOwned: boolean;
  cloudRelay: boolean;
  wireEnvelope?: string;
  nearbyAttachment?: {
    transferId: string;
    chunkCount: number;
    /** Permanent local plaintext path, used by the group cloud relay. */
    localPath?: string;
    fileName: string;
    mimeType: string;
  };
  createdAt: number;
  meshBroadcastAt?: number;
}

let writeChain: Promise<void> = Promise.resolve();
const processingOperationIds = new Set<string>();

const withQueueLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = writeChain;
  let release!: () => void;
  writeChain = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
};

const readUnlocked = async (): Promise<MeshMessageOperation[]> => {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - MAX_MESH_MESSAGE_AGE_MS;
    return parsed.filter(
      (item): item is MeshMessageOperation =>
        Boolean(item)
        && typeof item.id === 'string'
        && typeof item.createdAt === 'number'
        && item.createdAt >= cutoff,
    );
  } catch {
    return [];
  }
};

const writeUnlocked = async (operations: MeshMessageOperation[]): Promise<void> => {
  if (operations.length === 0) {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } else {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(operations));
  }
};

export const loadMeshMessageQueue = async (): Promise<MeshMessageOperation[]> =>
  withQueueLock(readUnlocked);

/**
 * Atomically reserves an unseen operation before any stateful Signal decrypt.
 *
 * Nearby gossip deliberately replays envelopes. A Signal ciphertext is not an
 * idempotent input, though: decrypting the same ratchet message twice raises a
 * duplicate-message error. The durable queue used to be checked only AFTER
 * decrypt, so every replay could poison an otherwise healthy session and make
 * all later offline sends fail. The in-memory reservation also closes the
 * small race where two native receive events for the same new envelope arrive
 * before either one has been persisted.
 */
export const claimMeshMessageProcessing = async (id: string): Promise<boolean> =>
  withQueueLock(async () => {
    const current = await readUnlocked();
    if (
      processingOperationIds.has(id)
      || current.some((item) => item.id === id)
    ) {
      return false;
    }
    processingOperationIds.add(id);
    return true;
  });

export const releaseMeshMessageProcessing = (id: string): void => {
  processingOperationIds.delete(id);
};

/** Returns true only when this operation was not already seen. */
export const enqueueMeshMessage = async (operation: MeshMessageOperation): Promise<boolean> =>
  withQueueLock(async () => {
    const current = await readUnlocked();
    if (current.some((item) => item.id === operation.id)) return false;
    current.push(operation);
    await writeUnlocked(current);
    return true;
  });

export const updateMeshMessage = async (operation: MeshMessageOperation): Promise<void> =>
  withQueueLock(async () => {
    const current = await readUnlocked();
    await writeUnlocked(current.map((item) => item.id === operation.id ? operation : item));
  });

export const removeMeshMessage = async (id: string): Promise<void> =>
  withQueueLock(async () => {
    const current = await readUnlocked();
    await writeUnlocked(current.filter((item) => item.id !== id));
  });

export const clearMeshMessageQueue = async (): Promise<void> =>
  withQueueLock(async () => {
    processingOperationIds.clear();
    await writeUnlocked([]);
  });
