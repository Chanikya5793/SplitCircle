/**
 * History handoff for newly paired devices (doc 31 §3.3 / §5 Phase 6).
 *
 * A freshly paired device starts with zero history because Signal sessions
 * carry no past messages — that limitation is inherent to the protocol, not a
 * gap in this app. This is the Signal "Synchronized Start"-shaped workaround:
 * the main device bundles its last 90 days of already-decrypted plaintext,
 * re-encrypts it under a FRESH one-time key, and relays it through CloudKit.
 *
 * CloudKit is a dumb relay here and never holds anything readable: the bundle
 * is encrypted with a random key that exists only on the two devices, and that
 * key travels inside a Signal envelope addressed to the new device.
 *
 * Two hazards the spec calls out explicitly, both handled below:
 *  - RESUMABILITY. A handoff interrupted mid-transfer (subway, elevator) must
 *    not silently leave a partial window, nor force a full restart.
 *  - The bulk import must be gated against Foundation Models work; §5 Phase 6
 *    calls that SIGSEGV risk "real and specific to this phase".
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { runExclusiveOfFoundationModels } from '../../modules/splitcircle-ai';
import {
  backupChunk,
  beginBackupSessionWithKey,
  endBackupSession,
  restoreChunk,
  restoreChunkMetadata,
} from '../../modules/splitcircle-backup';
import { getChatMessages, getLocalMessageStats, saveMessageLocally } from '@/services/localMessageStorage';
import { getCurrentDeviceId } from '@/services/pairingService';
import {
  decryptEnvelope,
  encryptForAllDevices,
  getCachedSignalDeviceId,
  listSignalDevices,
} from '@/services/signalCryptoService';
import type { ChatMessage } from '@/models';

/** §3.3 / decision #9: the bounded window a new device receives. */
const HANDOFF_WINDOW_DAYS = 90;
const MESSAGES_PER_CHUNK = 300;

const RECORD_TYPE = 'historyHandoff';
const CHECKPOINT_KEY = 'splitcircle.handoff.checkpoint';

const manifestId = (targetDeviceId: string) => `handoff-manifest-${targetDeviceId}`;
const chunkId = (targetDeviceId: string, index: number) => `handoff-${targetDeviceId}-${index}`;

interface HandoffManifest {
  version: 1;
  fromDeviceId: string;
  targetDeviceId: string;
  createdAt: number;
  windowStart: number;
  chunkCount: number;
  totalMessages: number;
  /** The bundle key, Signal-encrypted to the target device. */
  keyEnvelope: { type: number; body: string };
  /** Sender's libsignal device id, so the target can name the session. */
  senderSignalDeviceId: number;
}

interface HandoffCheckpoint {
  manifestCreatedAt: number;
  importedChunks: number[];
  messagesImported: number;
}

const encodeJson = (value: unknown): string =>
  // eslint-disable-next-line no-undef
  globalThis.btoa(unescape(encodeURIComponent(JSON.stringify(value))));

const decodeJson = <T>(base64: string): T =>
  // eslint-disable-next-line no-undef
  JSON.parse(decodeURIComponent(escape(globalThis.atob(base64)))) as T;

const randomKeyBase64 = (): string => {
  // react-native-get-random-values polyfills crypto.getRandomValues at app
  // entry, so this is real CSPRNG output rather than Math.random.
  const bytes = new Uint8Array(32);
  // eslint-disable-next-line no-undef
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  // eslint-disable-next-line no-undef
  return globalThis.btoa(binary);
};

export interface HandoffProgress {
  phase: 'preparing' | 'sending' | 'complete';
  chunksDone: number;
  chunksTotal: number;
  messagesDone: number;
}

/**
 * MAIN DEVICE: bundles the last 90 days and relays it to one newly paired
 * device.
 *
 * Returns null when there is nothing to send or the target has no published
 * keys yet — both are normal, not failures.
 */
export const sendHistoryHandoff = async (
  userId: string,
  targetDeviceId: string,
  onProgress?: (progress: HandoffProgress) => void,
): Promise<{ chunkCount: number; totalMessages: number } | null> => {
  const senderSignalDeviceId = getCachedSignalDeviceId();
  if (!senderSignalDeviceId) return null;

  const target = (await listSignalDevices(userId)).find((d) => d.deviceId === targetDeviceId);
  if (!target) return null;

  const windowStart = Date.now() - HANDOFF_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const chatIds = (await getLocalMessageStats()).map((s) => s.chatId);

  // Collect the window first so chunk boundaries — and therefore record ids —
  // are stable for a resumed run.
  const windowed: ChatMessage[] = [];
  for (const chatId of chatIds) {
    const messages = await getChatMessages(chatId);
    windowed.push(...messages.filter((m) => m.createdAt >= windowStart));
  }
  windowed.sort((a, b) => a.createdAt - b.createdAt);
  if (windowed.length === 0) return null;

  const bundleKey = randomKeyBase64();

  // The key travels inside a Signal envelope addressed to the target device,
  // so CloudKit relays something it can never read. encryptForAllDevices is
  // filtered to the single target rather than fanned out.
  const envelopes = await encryptForAllDevices(userId, bundleKey);
  const keyEnvelope = envelopes.find((e) => e.deviceId === targetDeviceId)?.envelope;
  if (!keyEnvelope) return null;

  const chunkCount = Math.ceil(windowed.length / MESSAGES_PER_CHUNK);
  onProgress?.({ phase: 'preparing', chunksDone: 0, chunksTotal: chunkCount, messagesDone: 0 });

  await beginBackupSessionWithKey(bundleKey);
  try {
    for (let index = 0; index < chunkCount; index += 1) {
      const slice = windowed.slice(index * MESSAGES_PER_CHUNK, (index + 1) * MESSAGES_PER_CHUNK);
      await backupChunk(RECORD_TYPE, chunkId(targetDeviceId, index), encodeJson(slice), {
        targetDeviceId,
        index: String(index),
      });
      onProgress?.({
        phase: 'sending',
        chunksDone: index + 1,
        chunksTotal: chunkCount,
        messagesDone: Math.min((index + 1) * MESSAGES_PER_CHUNK, windowed.length),
      });
    }
  } finally {
    await endBackupSession();
  }

  // Manifest last, same reasoning as the backup manifest: it is what the
  // receiver reads first, so it must never promise chunks that aren't there.
  // Written WITHOUT the bundle key (it carries the key envelope instead), so
  // it is readable by the target before it holds anything.
  const manifest: HandoffManifest = {
    version: 1,
    fromDeviceId: await getCurrentDeviceId(),
    targetDeviceId,
    createdAt: Date.now(),
    windowStart,
    chunkCount,
    totalMessages: windowed.length,
    keyEnvelope: { type: keyEnvelope.type, body: keyEnvelope.body },
    senderSignalDeviceId,
  };

  // The manifest itself is plaintext-to-CloudKit metadata plus an envelope
  // only the target can open, so a raw all-zero key would be misleading —
  // use the bundle key so the record shape stays uniform, and keep the
  // envelope inside readable by writing it into the metadata instead.
  await beginBackupSessionWithKey(bundleKey);
  try {
    await backupChunk(RECORD_TYPE, manifestId(targetDeviceId), encodeJson(manifest), {
      targetDeviceId,
      kind: 'manifest',
      // The envelope must be readable WITHOUT the bundle key — otherwise the
      // target could never bootstrap. Metadata is not encrypted by this layer.
      keyEnvelopeType: String(keyEnvelope.type),
      keyEnvelopeBody: keyEnvelope.body,
      senderSignalDeviceId: String(senderSignalDeviceId),
      senderUserId: userId,
      createdAt: String(manifest.createdAt),
      chunkCount: String(chunkCount),
      totalMessages: String(windowed.length),
    });
  } finally {
    await endBackupSession();
  }

  onProgress?.({
    phase: 'complete',
    chunksDone: chunkCount,
    chunksTotal: chunkCount,
    messagesDone: windowed.length,
  });
  return { chunkCount, totalMessages: windowed.length };
};

const readCheckpoint = async (): Promise<HandoffCheckpoint | null> => {
  try {
    const raw = await AsyncStorage.getItem(CHECKPOINT_KEY);
    return raw ? (JSON.parse(raw) as HandoffCheckpoint) : null;
  } catch {
    return null;
  }
};

const writeCheckpoint = async (checkpoint: HandoffCheckpoint): Promise<void> => {
  await AsyncStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
};

export const clearHandoffCheckpoint = async (): Promise<void> => {
  await AsyncStorage.removeItem(CHECKPOINT_KEY);
};

export interface HandoffImportResult {
  imported: number;
  chunksImported: number;
  chunksTotal: number;
  /** True when chunks remain — the caller should retry later, not treat this as done. */
  incomplete: boolean;
}

/**
 * NEW DEVICE: consumes a handoff bundle into local storage.
 *
 * RESUMABLE by design (§5 Phase 6): progress is checkpointed after every
 * chunk, so an interruption resumes at the next chunk instead of restarting —
 * and an incomplete run reports `incomplete: true` rather than looking
 * successful, which is the failure mode the spec explicitly warns against.
 *
 * The whole import runs on the Foundation Models single-flight queue. §5 Phase
 * 6 calls that SIGSEGV risk real and specific to this phase, so it is gated
 * explicitly rather than assumed safe by inheritance from the backup path.
 */
export const receiveHistoryHandoff = async (
  onProgress?: (progress: HandoffProgress) => void,
): Promise<HandoffImportResult | null> =>
  runExclusiveOfFoundationModels(async () => {
    const ownDeviceId = await getCurrentDeviceId();

    // Manifest metadata carries the key envelope in the clear (it is only
    // openable by us), which is what lets us bootstrap the bundle key.
    // Metadata-only read: the bundle key is inside this record's metadata as a
    // Signal envelope, so the payload cannot be decrypted until after it has
    // been read. Fetching the payload first would be circular.
    const manifestChunk = await restoreChunkMetadata(RECORD_TYPE, manifestId(ownDeviceId));
    if (!manifestChunk) return null;

    const meta = manifestChunk.metadata;
    const envelopeType = Number(meta.keyEnvelopeType);
    const envelopeBody = meta.keyEnvelopeBody;
    const senderSignalDeviceId = Number(meta.senderSignalDeviceId);
    const chunkCount = Number(meta.chunkCount);
    if (!Number.isFinite(envelopeType) || !envelopeBody || !Number.isFinite(senderSignalDeviceId)) {
      return null;
    }

    // The handoff always comes from another device of the SAME account, so the
    // Signal address to decrypt against is our own user id.
    const senderUserId = manifestChunk.metadata.senderUserId ?? '';
    if (!senderUserId) return null;
    const bundleKey = await decryptEnvelope(senderUserId, senderSignalDeviceId, {
      type: envelopeType,
      body: envelopeBody,
    });

    const existing = await readCheckpoint();
    const imported = new Set(existing?.importedChunks ?? []);
    let messagesImported = existing?.messagesImported ?? 0;

    await beginBackupSessionWithKey(bundleKey);
    try {
      for (let index = 0; index < chunkCount; index += 1) {
        if (imported.has(index)) continue;

        const chunk = await restoreChunk(RECORD_TYPE, chunkId(ownDeviceId, index));
        if (!chunk) {
          // Missing chunk: stop and report incomplete rather than skipping
          // ahead, so the window never silently has a hole in it.
          break;
        }
        const messages = decodeJson<ChatMessage[]>(chunk.payloadBase64);
        for (const message of messages) {
          await saveMessageLocally(message);
          messagesImported += 1;
        }
        imported.add(index);
        // Checkpoint AFTER the writes land, so a crash mid-chunk re-imports
        // that chunk rather than skipping it. saveMessageLocally dedupes by
        // id, so re-importing is harmless.
        await writeCheckpoint({
          manifestCreatedAt: Number(meta.createdAt ?? 0),
          importedChunks: [...imported],
          messagesImported,
        });
        onProgress?.({
          phase: 'sending',
          chunksDone: imported.size,
          chunksTotal: chunkCount,
          messagesDone: messagesImported,
        });
      }
    } finally {
      await endBackupSession();
    }

    const incomplete = imported.size < chunkCount;
    if (!incomplete) await clearHandoffCheckpoint();

    onProgress?.({
      phase: 'complete',
      chunksDone: imported.size,
      chunksTotal: chunkCount,
      messagesDone: messagesImported,
    });

    return {
      imported: messagesImported,
      chunksImported: imported.size,
      chunksTotal: chunkCount,
      incomplete,
    };
  });


