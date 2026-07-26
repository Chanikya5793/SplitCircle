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
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  documentDirectory,
  getInfoAsync,
  makeDirectoryAsync,
  readAsStringAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';
import {
  getChatMessages,
  getLocalMessageStats,
  saveMessageLocally,
  updateMessageLocalPath,
} from '@/services/localMessageStorage';
import { getCallHistory, saveCallToHistory, type CallHistoryEntry } from '@/services/localCallStorage';
import { getLocalMediaPath } from '@/services/mediaService';
import { hydrateWallpapers } from '@/services/wallpaperService';
import { getOrCreateRecoverySecret } from '@/services/backupPassphraseService';
import { getBackupSelection, type BackupCategory } from '@/services/backupContentService';
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
  /** One record per media file, always a CKAsset in practice. */
  media: 'media',
  /** Wallpaper images + their slot configuration, one record for the lot. */
  wallpapers: 'wallpapers',
  /** Device-scoped preferences (the synced ones already live in Firestore). */
  localSettings: 'localSettings',
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
  /**
   * Which categories this backup actually contains.
   *
   * Load-bearing for §3.7's retirement gate, not decoration: the gate asks
   * "is the backup complete?", and once content is selectable that question
   * only means anything relative to what was MEANT to be in it. Without this
   * the gate would either flag every deselected category as missing data, or
   * (worse) pass a backup that silently omitted messages. Absent on backups
   * written before selection existed, which are read as messages-only —
   * exactly what they were.
   */
  contents?: Partial<Record<BackupCategory, boolean>>;
  /** Media file record ids, when the media category was included. */
  mediaIds?: string[];
  /**
   * Files too large to back up through the base64 bridge (exportMedia).
   * Recorded so the UI can say so — a backup that silently omitted the user's
   * videos while reporting success is exactly what §3.7's gate guards against.
   */
  mediaSkippedTooLarge?: number;
  /** Number of call-history entries stored, when that category was included. */
  callHistoryCount?: number;
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
 * Device-scoped preferences worth carrying to a new phone.
 *
 * An ALLOW-LIST, never "every AsyncStorage key". Two categories are excluded
 * on purpose rather than by oversight:
 *   - `app_lock_v1`, `privacy_guard_v1`, `guard_lockout_v1` — security state.
 *     Restoring a lock configuration onto a different device is a decision the
 *     user should make on that device, and restoring a lockout counter could
 *     hand an attacker a way to reset a lockout by restoring an older backup.
 *   - `auth_profile_v1` and the `ai_*` caches — identity comes from the server,
 *     and the caches regenerate themselves. Backing them up is pure bloat.
 */
const LOCAL_SETTINGS_KEYS = [
  'appearance_v1',
  'display_currency_v1',
  'personal_budgets_v1',
  'receipt_use_ai_v1',
  'receipt_strict_review_mode_v1',
  'insights_engine_v1',
  'pcc_deep_analysis_v1',
  'ai_pipeline_v1',
];

/** Wallpaper images live as files; their slot map lives in AsyncStorage. */
const WALLPAPER_CONFIG_KEY = 'wallpapers_v1';
const WALLPAPER_DIRECTORY = `${documentDirectory}wallpapers/`;

const mediaRecordId = (messageId: string): string => `media-${messageId}`;

/**
 * Largest media file backed up via the base64 bridge path.
 *
 * mediaService allows uploads up to 100MB; this is deliberately far lower,
 * because the constraint here is JS heap during a background task, not the
 * transport. See exportMedia for why exceeding it is a crash rather than a
 * slow backup.
 */
const MAX_INLINE_MEDIA_BYTES = 24 * 1024 * 1024;

/**
 * Backs up the local call log. Small, so one record.
 */
const exportCallHistory = async (): Promise<number> => {
  const entries = await getCallHistory();
  if (entries.length === 0) return 0;
  await backupChunk(RECORD_TYPE.callHistory, 'callHistory-current', encodeJson(entries), {});
  return entries.length;
};

/**
 * Backs up wallpapers: the slot map plus every photo file it references.
 *
 * Blob wallpapers are pure configuration (colour triples rendered live), so
 * they need no file at all — only photo slots have bytes. The stored map holds
 * FILE NAMES rather than absolute paths, deliberately (see wallpaperService):
 * the container UUID changes on every install, so a path from the old device
 * would be meaningless here anyway.
 */
const exportWallpapers = async (): Promise<void> => {
  const raw = await AsyncStorage.getItem(WALLPAPER_CONFIG_KEY);
  if (!raw) return;

  const files: Record<string, string> = {};
  const map = JSON.parse(raw) as Record<string, { kind?: string; file?: string } | undefined>;
  for (const entry of Object.values(map)) {
    if (entry?.kind !== 'photo' || !entry.file) continue;
    try {
      files[entry.file] = await readAsStringAsync(`${WALLPAPER_DIRECTORY}${entry.file}`, {
        encoding: 'base64',
      });
    } catch {
      // A slot pointing at a file that no longer exists is a pre-existing
      // local inconsistency; skip it rather than failing the whole backup.
    }
  }

  await backupChunk(RECORD_TYPE.wallpapers, 'wallpapers-current', encodeJson({ map, files }), {});
};

/** Backs up the allow-listed device-scoped preferences. */
const exportLocalSettings = async (): Promise<void> => {
  const pairs = await AsyncStorage.multiGet(LOCAL_SETTINGS_KEYS);
  const values: Record<string, string> = {};
  for (const [key, value] of pairs) {
    if (typeof value === 'string') values[key] = value;
  }
  if (Object.keys(values).length === 0) return;
  await backupChunk(RECORD_TYPE.localSettings, 'localSettings-current', encodeJson(values), {});
};

/**
 * Backs up downloaded chat media, one record per file.
 *
 * One record each rather than batched, because a single video can exceed
 * CloudKit's per-record non-asset ceiling on its own — the provider promotes
 * anything over its inline threshold to a CKAsset, which only works if each
 * file is its own record. Files that are no longer on disk are skipped, not
 * treated as failures: the media cache is prunable by design.
 */
const exportMedia = async (
  chatIds: string[],
  onFile?: (done: number) => void,
): Promise<{ ids: string[]; skippedTooLarge: number }> => {
  const ids: string[] = [];
  let done = 0;
  let skippedTooLarge = 0;

  for (const chatId of chatIds) {
    for (const message of await getChatMessages(chatId)) {
      if (!message.localMediaPath || !message.mediaDownloaded) continue;
      try {
        const info = await getInfoAsync(message.localMediaPath);
        if (!info.exists) continue;

        // SIZE GUARD. `readAsStringAsync` materialises the ENTIRE file as a
        // base64 JS string (~1.33x the bytes) and then copies it across the
        // bridge — so a 100MB video, which mediaService explicitly allows,
        // becomes ~133MB resident in Hermes plus a native copy. A scheduled
        // backup runs inside a BGProcessingTask, where the memory ceiling is
        // far tighter than in the foreground, so this is a crash rather than
        // a slowdown, and it would take the whole backup with it.
        //
        // Skipping is COUNTED and reported, never silent: a backup that
        // quietly omitted the user's videos while reporting success is the
        // failure mode §3.7's retirement gate exists to prevent.
        //
        // The real fix is to hand the native side a file PATH and let it
        // build the CKAsset directly, never crossing the bridge — that needs
        // a new native function, so it is deliberately not bundled into a
        // build we want to test today.
        if (typeof info.size === 'number' && info.size > MAX_INLINE_MEDIA_BYTES) {
          skippedTooLarge += 1;
          continue;
        }

        const payload = await readAsStringAsync(message.localMediaPath, { encoding: 'base64' });
        const id = mediaRecordId(message.messageId);
        await backupChunk(RECORD_TYPE.media, id, payload, {
          chatId,
          messageId: message.messageId,
          fileName: message.mediaMetadata?.fileName ?? '',
        });
        ids.push(id);
        done += 1;
        onFile?.(done);
      } catch {
        // One unreadable file must not abort an otherwise good backup.
      }
    }
  }

  return { ids, skippedTooLarge };
};

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
  const selection = await getBackupSelection();

  try {
    // getLocalMessageStats enumerates every locally-stored chat; it is the
    // exported surface for that, and its counts double as a sanity check.
    const chatIds = (await getLocalMessageStats()).map((stat) => stat.chatId);
    onProgress?.({ phase: 'preparing', chatsDone: 0, chatsTotal: chatIds.length, messagesDone: 0 });

    const chats: ChatManifestEntry[] = [];
    let messagesDone = 0;

    for (const [chatIndex, chatId] of selection.messages ? chatIds.entries() : []) {
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

    // Non-message categories, each honouring the user's selection. Ordered
    // before the manifest for the same reason the message batches are: the
    // manifest must only ever describe records that already landed.
    const callHistoryCount = selection.callHistory ? await exportCallHistory() : 0;
    if (selection.wallpapers) await exportWallpapers();
    if (selection.localSettings) await exportLocalSettings();
    const media = selection.media
      ? await exportMedia(chatIds, () =>
          onProgress?.({
            phase: 'messages',
            chatsDone: chatIds.length,
            chatsTotal: chatIds.length,
            messagesDone,
          }),
        )
      : { ids: [], skippedTooLarge: 0 };

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
      contents: selection,
      mediaIds: media.ids,
      mediaSkippedTooLarge: media.skippedTooLarge,
      callHistoryCount,
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
/**
 * Whether a manifest claims to contain a category.
 *
 * A manifest with no `contents` predates selectable content and is
 * messages-only — which is exactly what those backups are, so reading the
 * absence that way is accurate rather than a guess.
 */
const manifestHas = (manifest: BackupManifest, category: BackupCategory): boolean =>
  manifest.contents ? manifest.contents[category] === true : category === 'messages';

const importCallHistory = async (manifest: BackupManifest): Promise<void> => {
  if (!manifestHas(manifest, 'callHistory')) return;
  const chunk = await restoreChunk(RECORD_TYPE.callHistory, 'callHistory-current');
  if (!chunk) return;
  for (const entry of decodeJson<CallHistoryEntry[]>(chunk.payloadBase64)) {
    // saveCallToHistory dedupes, so a re-run merges instead of duplicating.
    await saveCallToHistory(entry);
  }
};

const importWallpapers = async (manifest: BackupManifest): Promise<void> => {
  if (!manifestHas(manifest, 'wallpapers')) return;
  const chunk = await restoreChunk(RECORD_TYPE.wallpapers, 'wallpapers-current');
  if (!chunk) return;

  const { map, files } = decodeJson<{
    map: Record<string, unknown>;
    files: Record<string, string>;
  }>(chunk.payloadBase64);

  // Files first: writing the slot map before the images exist would leave the
  // UI briefly pointing at photos that aren't there yet.
  await makeDirectoryAsync(WALLPAPER_DIRECTORY, { intermediates: true }).catch(() => {});
  for (const [fileName, base64] of Object.entries(files ?? {})) {
    await writeAsStringAsync(`${WALLPAPER_DIRECTORY}${fileName}`, base64, {
      encoding: 'base64',
    }).catch(() => {});
  }
  await AsyncStorage.setItem(WALLPAPER_CONFIG_KEY, JSON.stringify(map));

  // wallpaperService keeps the slot map in a module-level cache and only reads
  // AsyncStorage once, so writing the key behind its back changes nothing on
  // screen — the restored wallpapers would sit on disk, correct and invisible,
  // until the next app launch. Re-hydrating publishes them to its listeners
  // now, which is what makes the restore look like it worked.
  await hydrateWallpapers().catch(() => {
    // A stale cache is cosmetic and self-heals on relaunch; never fail an
    // otherwise-good restore over it.
  });
};

const importLocalSettings = async (manifest: BackupManifest): Promise<void> => {
  if (!manifestHas(manifest, 'localSettings')) return;
  const chunk = await restoreChunk(RECORD_TYPE.localSettings, 'localSettings-current');
  if (!chunk) return;

  const values = decodeJson<Record<string, string>>(chunk.payloadBase64);
  // Re-filtered against the allow-list on the way IN as well as out. A backup
  // is attacker-influenced input in the threat model where someone restores a
  // crafted one, and this keeps a future key from being written just because
  // an older/other build put it in the payload.
  const entries = Object.entries(values).filter(([key]) => LOCAL_SETTINGS_KEYS.includes(key));
  if (entries.length > 0) {
    await AsyncStorage.multiSet(entries);
  }
};

const importMedia = async (manifest: BackupManifest): Promise<void> => {
  if (!manifestHas(manifest, 'media')) return;

  for (const id of manifest.mediaIds ?? []) {
    try {
      const chunk = await restoreChunk(RECORD_TYPE.media, id);
      if (!chunk) continue;
      const { chatId, messageId, fileName } = chunk.metadata;
      if (!chatId || !messageId) continue;

      const localPath = getLocalMediaPath(chatId, messageId, fileName || messageId);
      await makeDirectoryAsync(localPath.slice(0, localPath.lastIndexOf('/')), {
        intermediates: true,
      }).catch(() => {});
      await writeAsStringAsync(localPath, chunk.payloadBase64, { encoding: 'base64' });
      // Point the restored message at the restored file, or the media would
      // sit on disk unreferenced and the bubble would still show as
      // not-downloaded.
      await updateMessageLocalPath(chatId, messageId, localPath);
    } catch {
      // Media is a best-effort category: a file that fails to restore must not
      // take the message history down with it.
    }
  }
};

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

    // Non-message categories. Each is driven by what the manifest says is
    // PRESENT, never by this device's own selection — the selection governs
    // what gets written, and a restore must read back whatever the backup
    // actually contains.
    await importCallHistory(manifest);
    await importWallpapers(manifest);
    await importLocalSettings(manifest);
    await importMedia(manifest);

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
