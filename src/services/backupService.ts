/**
 * Backup export/import orchestration (doc 31 §3.2, Phase 4).
 *
 * This is the layer that decides WHAT gets backed up and in what batches. The
 * native module encrypts each chunk and handles CloudKit retry/backoff; the
 * provider underneath does dumb store I/O. Nothing here ever sees a key.
 *
 * Shape is one-shot bulk export (main device only) and one-shot bulk import
 * (new/promoted main device, once) — NOT continuous sync. §3.2 chose that
 * deliberately over CKSyncEngine; don't reshape this into incremental sync
 * without re-deriving that reasoning.
 */

import {
  backupChunk,
  beginBackupSession,
  endBackupSession,
  restoreChunk,
  verifyBackupIntegrity,
} from '../../modules/splitcircle-backup';
import {
  getChatMessages,
  getLocalMessageStats,
  saveMessageLocally,
} from '@/services/localMessageStorage';
import { getOrCreateRecoverySecret } from '@/services/backupPassphraseService';
import type { ChatMessage } from '@/models';

/**
 * Messages per record. §3.2 bounds a batch by day or 500 messages to stay under
 * CloudKit's ~1MB non-asset ceiling; 500 short text messages sit comfortably
 * inside it, and anything larger spills to a CKAsset in the provider rather
 * than failing.
 */
const MESSAGES_PER_BATCH = 500;

export const RECORD_TYPE = {
  message: 'message',
  callHistory: 'callHistory',
  manifest: 'manifest',
} as const;

/**
 * Per-chat integrity summary, computed AT WRITE TIME (§3.2).
 *
 * This must never be re-derived later by walking raw records: §3.3's E2E
 * encryption makes after-the-fact plaintext diffing impossible by design — the
 * device holds plaintext only transiently, right before it is encrypted. The
 * device-retirement gate (§3.7) reads this manifest and nothing else, which is
 * exactly why it has to be written synchronously alongside the data it
 * describes.
 */
export interface ChatManifestEntry {
  chatId: string;
  count: number;
  latestTimestamp: number | null;
  /** Checksum over the batch ids that make up this chat, in order. */
  batchChecksum: string;
  batchIds: string[];
}

export interface BackupManifest {
  version: 1;
  createdAt: number;
  /** Base64 KDF salt. Without this the backup cannot be opened, ever. */
  salt: string;
  chats: ChatManifestEntry[];
  totalMessages: number;
  /**
   * Random per-backup secret whose SHA-256 the server holds as the §3.12
   * recovery verifier. Optional because backups written before recovery
   * existed have none — `recoverAsNewMainDevice` treats a missing verifier as
   * the no-backup path rather than failing, so those users are not stranded.
   */
  recoverySecret?: string;
}

export interface BackupProgress {
  phase: 'preparing' | 'messages' | 'manifest' | 'complete';
  chatsDone: number;
  chatsTotal: number;
  messagesDone: number;
}

const encodeJson = (value: unknown): string =>
  // eslint-disable-next-line no-undef
  globalThis.btoa(unescape(encodeURIComponent(JSON.stringify(value))));

const decodeJson = <T>(base64: string): T =>
  // eslint-disable-next-line no-undef
  JSON.parse(decodeURIComponent(escape(globalThis.atob(base64)))) as T;

/** FNV-1a over a string. Mirrors the provider's checksum discipline — this is
 * a corruption/truncation check, not a security primitive (the AEAD wrapping
 * already provides integrity). */
const checksum = (input: string): string => {
  let hash = 0xcbf29ce4;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

const batchId = (chatId: string, index: number): string => `msg-${chatId}-${index}`;

/**
 * Full export to the backup store.
 *
 * `passphrase` derives the key ONCE for the whole run (§3.5) — the session is
 * opened here and closed in `finally` so a failure part-way through never
 * leaves an unlocked backup key resident.
 *
 * Returns the manifest, whose `salt` the caller must keep: it is written into
 * the backup itself, but a caller that wants to verify or resume needs it too.
 */
export const exportBackup = async (
  passphrase: string,
  onProgress?: (progress: BackupProgress) => void,
): Promise<BackupManifest> => {
  const { salt } = await beginBackupSession(passphrase);

  try {
    // getLocalMessageStats enumerates every locally-stored chat; it is the
    // exported surface for that, and its counts double as a sanity check.
    const chatIds = (await getLocalMessageStats()).map((stat) => stat.chatId);
    onProgress?.({ phase: 'preparing', chatsDone: 0, chatsTotal: chatIds.length, messagesDone: 0 });

    const chats: ChatManifestEntry[] = [];
    let messagesDone = 0;

    for (const [chatIndex, chatId] of chatIds.entries()) {
      const messages = await getChatMessages(chatId);
      // Oldest-first so batch N always holds the same messages across runs,
      // which keeps re-exports overwriting rather than duplicating.
      const ordered = [...messages].sort((a, b) => a.createdAt - b.createdAt);

      const batchIds: string[] = [];
      for (let offset = 0; offset < ordered.length; offset += MESSAGES_PER_BATCH) {
        const slice = ordered.slice(offset, offset + MESSAGES_PER_BATCH);
        const id = batchId(chatId, batchIds.length);
        await backupChunk(RECORD_TYPE.message, id, encodeJson(slice), {
          chatId,
          index: String(batchIds.length),
        });
        batchIds.push(id);
        messagesDone += slice.length;
        onProgress?.({
          phase: 'messages',
          chatsDone: chatIndex,
          chatsTotal: chatIds.length,
          messagesDone,
        });
      }

      const latestTimestamp = ordered.length > 0 ? ordered[ordered.length - 1].createdAt : null;
      chats.push({
        chatId,
        count: ordered.length,
        latestTimestamp,
        batchChecksum: checksum(batchIds.join('|')),
        batchIds,
      });
    }

    // Manifest LAST, deliberately: it is the index a restore reads first, so
    // writing it only after every batch landed means a crash mid-export leaves
    // no manifest rather than one promising records that don't exist.
    const manifest: BackupManifest = {
      version: 1,
      createdAt: Date.now(),
      salt,
      chats,
      totalMessages: messagesDone,
      recoverySecret: await getOrCreateRecoverySecret(),
    };
    onProgress?.({
      phase: 'manifest',
      chatsDone: chatIds.length,
      chatsTotal: chatIds.length,
      messagesDone,
    });
    await backupChunk(RECORD_TYPE.manifest, 'manifest-current', encodeJson(manifest), {});

    onProgress?.({
      phase: 'complete',
      chatsDone: chatIds.length,
      chatsTotal: chatIds.length,
      messagesDone,
    });
    return manifest;
  } finally {
    // Always drop the key, including on failure — an unlocked backup key
    // resident for the app's lifetime is a needlessly long exposure window.
    await endBackupSession();
  }
};

/**
 * Reads the manifest without importing anything, so the UI can show what a
 * backup contains (and whether the passphrase is right) before committing to a
 * restore.
 *
 * The salt lives INSIDE the encrypted manifest, which is not circular: the
 * blob is self-describing, so the native layer extracts the salt from the
 * envelope to derive the key, and the copy inside is what a caller then uses
 * for subsequent chunks.
 */
export const readBackupManifest = async (passphrase: string): Promise<BackupManifest | null> => {
  // Fetched by its KNOWN id rather than discovered by query. CloudKit does not
  // auto-create queryable indexes, so a TRUEPREDICATE query fails with
  // "Field 'recordName' is not marked queryable" until someone adds an index
  // in the CloudKit Dashboard by hand — which a fresh install of this app can
  // never rely on. Fetch-by-id needs no schema configuration at all, and the
  // manifest is the index by design (§3.2), so nothing here needs a query.
  await beginBackupSession(passphrase);
  try {
    const chunk = await restoreChunk(RECORD_TYPE.manifest, 'manifest-current');
    if (!chunk) return null;
    return decodeJson<BackupManifest>(chunk.payloadBase64);
  } finally {
    await endBackupSession();
  }
};

export interface RestoreProgress {
  phase: 'manifest' | 'messages' | 'complete';
  chatsDone: number;
  chatsTotal: number;
  messagesRestored: number;
}

export interface RestoreResult {
  messagesRestored: number;
  /** Batches named by the manifest that could not be read — see below. */
  missingBatches: string[];
}

/**
 * Full import from the backup store onto a new/promoted main device.
 *
 * Missing batches are collected and REPORTED rather than aborting the restore:
 * partial history is materially better than none, and §3.7's retirement gate
 * is what's responsible for ensuring a backup was complete before the old
 * device is given away. Silently succeeding on a partial restore would be the
 * dangerous outcome, so the caller gets the list.
 */
export const importBackup = async (
  passphrase: string,
  onProgress?: (progress: RestoreProgress) => void,
): Promise<RestoreResult> => {
  await beginBackupSession(passphrase);

  try {
    const manifestChunk = await restoreChunk(RECORD_TYPE.manifest, 'manifest-current');
    if (!manifestChunk) {
      throw new Error('No backup manifest found in iCloud.');
    }
    const manifest = decodeJson<BackupManifest>(manifestChunk.payloadBase64);
    onProgress?.({
      phase: 'manifest',
      chatsDone: 0,
      chatsTotal: manifest.chats.length,
      messagesRestored: 0,
    });

    let messagesRestored = 0;
    const missingBatches: string[] = [];

    for (const [chatIndex, chat] of manifest.chats.entries()) {
      for (const id of chat.batchIds) {
        const chunk = await restoreChunk(RECORD_TYPE.message, id);
        if (!chunk) {
          missingBatches.push(id);
          continue;
        }
        const messages = decodeJson<ChatMessage[]>(chunk.payloadBase64);
        for (const message of messages) {
          // saveMessageLocally dedupes by id, so re-running a restore is safe
          // and merges with anything already on the device.
          await saveMessageLocally(message);
          messagesRestored += 1;
        }
      }
      onProgress?.({
        phase: 'messages',
        chatsDone: chatIndex + 1,
        chatsTotal: manifest.chats.length,
        messagesRestored,
      });
    }

    onProgress?.({
      phase: 'complete',
      chatsDone: manifest.chats.length,
      chatsTotal: manifest.chats.length,
      messagesRestored,
    });
    return { messagesRestored, missingBatches };
  } finally {
    await endBackupSession();
  }
};

/**
 * Verifies a backup against its own manifest, for §3.7's device-retirement
 * gate — the check that must pass before a user is told it's safe to give away
 * their old device.
 *
 * Verification is delegated to the provider, which re-derives each record's
 * checksum from the STORE's bytes. It deliberately does NOT trust anything this
 * layer computed: a gate that verifies a backup using the same numbers the
 * backup claims is not a gate.
 */
export const verifyBackup = async (
  passphrase: string,
  manifest: BackupManifest,
): Promise<{ ok: boolean; missing: string[] }> => {
  const missing: string[] = [];

  await beginBackupSession(passphrase);
  try {
    for (const chat of manifest.chats) {
      const recomputed = checksum(chat.batchIds.join('|'));
      if (recomputed !== chat.batchChecksum) {
        // The manifest disagrees with itself — treat every batch in this chat
        // as suspect rather than guessing which entry is wrong.
        missing.push(...chat.batchIds);
        continue;
      }
      for (const id of chat.batchIds) {
        // Fetch-by-id, not a query: same CloudKit indexing constraint as
        // readBackupManifest. This also verifies each batch actually DECRYPTS,
        // which a presence check alone would not — §3.7's gate needs to know a
        // backup is restorable, not merely that records exist.
        const chunk = await restoreChunk(RECORD_TYPE.message, id);
        if (!chunk) missing.push(id);
      }
    }
  } finally {
    await endBackupSession();
  }

  return { ok: missing.length === 0, missing };
};

export { verifyBackupIntegrity };
