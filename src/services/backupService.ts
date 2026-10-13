/**
 * Backup export/import orchestration (doc 31 §3.2), version 2.
 *
 * This layer decides WHAT gets backed up and in what records. The native
 * module encrypts each record and handles CloudKit retry/backoff; the provider
 * underneath does dumb store I/O. Nothing here ever sees a key.
 *
 * What v2 changed, and why each one matters:
 *  - INCREMENTAL. A local ledger remembers what is already in iCloud (a hash
 *    per record), and only records whose content changed are uploaded. v1
 *    re-uploaded the whole history — media included — on every run, under a
 *    fresh salt, which a background task (a few minutes at most) could never
 *    finish for a real account. With the ledger an interrupted run resumes
 *    where it stopped instead of starting over.
 *  - LINEAGE. Every backup chain has an id, stored in the manifest and in the
 *    ledger. A device that did not write (or restore) the backup currently in
 *    iCloud is not allowed to silently replace it — see `assessTakeover`. v1's
 *    new-phone flow made the phone "main" without importing anything, and its
 *    first backup then overwrote the real one with an empty history.
 *  - NATIVE MEDIA. Files are read and written by the native module; v1 moved
 *    each one through JS as a base64 string, which capped media at 24MB.
 *  - VERIFIED. After the manifest is written it is read back from iCloud, so a
 *    run only reports success once the backup is actually there.
 *  - PRUNED. Records the new manifest no longer references (a deleted chat,
 *    media taken out of the selection) are deleted, not left on the user's
 *    iCloud quota forever.
 *
 * Shape is still one-shot bulk export (main device only) and one-shot bulk
 * import — NOT continuous sync. §3.2 chose that deliberately over CKSyncEngine.
 */

import {
  backupChunk,
  backupFile,
  beginBackupSession,
  deleteRecords,
  endBackupSession,
  hasNativeFileTransfer,
  restoreChunk,
  restoreChunkMetadata,
  restoreFile,
  runExclusive,
  verifyBackupIntegrity,
} from '../../modules/splitcircle-backup';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import {
  cacheDirectory,
  deleteAsync,
  documentDirectory,
  getInfoAsync,
  moveAsync,
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
import { getEnrolledAt, getOrCreateRecoverySecret } from '@/services/backupPassphraseService';
import { getBackupSelection, type BackupCategory } from '@/services/backupContentService';
import * as Device from 'expo-device';
import type { ChatMessage } from '@/models';

/** Messages per record — comfortably inside CloudKit's ~1MB non-asset limit. */
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

const MANIFEST_ID = 'manifest-current';
const CALL_HISTORY_ID = 'callHistory-current';
const WALLPAPERS_ID = 'wallpapers-current';
const LOCAL_SETTINGS_ID = 'localSettings-current';

/**
 * Per-chat integrity summary, computed AT WRITE TIME (§3.2). The retirement
 * gate (§3.7) reads this and nothing else, so it must describe exactly what
 * landed.
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
  version: 1 | 2;
  createdAt: number;
  /** Base64 KDF salt. Without this the backup cannot be opened, ever. */
  salt: string;
  chats: ChatManifestEntry[];
  totalMessages: number;
  /** Id of the backup chain this manifest belongs to (v2). */
  lineage?: string;
  /** SHA-256 preimage of the server's §3.12 recovery verifier. */
  recoverySecret?: string;
  /** Which categories this backup contains (absent = messages only, v1). */
  contents?: Partial<Record<BackupCategory, boolean>>;
  mediaIds?: string[];
  /** Files skipped for size (v1's bridge limit, v2's native ceiling). */
  mediaSkippedTooLarge?: number;
  callHistoryCount?: number;
  /** Bytes STORED per category for the whole backup, not just this run. */
  sizes?: Partial<Record<BackupCategory, number>>;
}

export interface BackupProgress {
  phase: 'preparing' | 'messages' | 'media' | 'extras' | 'manifest' | 'verifying' | 'complete';
  chatsDone: number;
  chatsTotal: number;
  messagesDone: number;
  category?: BackupCategory;
  filesDone?: number;
  filesTotal?: number;
  /** Bytes actually uploaded this run (unchanged records cost nothing). */
  bytesDone?: number;
}

// ---------------------------------------------------------------------------
// Encoding + hashing

const encodeJson = (value: unknown): string =>
  // eslint-disable-next-line no-undef
  globalThis.btoa(unescape(encodeURIComponent(JSON.stringify(value))));

const decodeJson = <T>(base64: string): T =>
  // eslint-disable-next-line no-undef
  JSON.parse(decodeURIComponent(escape(globalThis.atob(base64)))) as T;

/** FNV-1a. Only for the manifest's batch-id checksum (a corruption check). */
const checksum = (input: string): string => {
  let hash = 0xcbf29ce4;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/**
 * Content hash for the ledger. SHA-256, not FNV: a collision here would mean
 * SKIPPING a record that changed, i.e. silently losing new messages from the
 * backup, so a 32-bit hash is not acceptable for this job.
 */
const contentHash = (payload: string): Promise<string> =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, payload);

const base64Bytes = (payload: string): number => Math.floor((payload.length * 3) / 4);

const batchId = (chatId: string, index: number): string => `msg-${chatId}-${index}`;
const mediaRecordId = (messageId: string): string => `media-${messageId}`;

const newLineage = (): string => Crypto.randomUUID();

// ---------------------------------------------------------------------------
// The ledger: what this device knows is already in iCloud.

interface LedgerRecord {
  /** Content hash of what was uploaded ('file' for immutable media). */
  h: string;
  /** Plaintext bytes, for the per-category size totals. */
  b: number;
  c: BackupCategory;
}

export interface BackupLedger {
  /** The backup chain these records belong to. */
  lineage: string;
  /** Salt the records were sealed under — reused so unchanged ones stay valid. */
  salt: string | null;
  /**
   * When the passphrase they were sealed with was set. A different value means
   * the passphrase changed, so every record must be re-sealed — skipping an
   * "unchanged" one would leave it readable only with the OLD passphrase.
   */
  passphraseSetAt?: number | null;
  records: Record<string, LedgerRecord>;
}

const LEDGER_KEY = 'splitcircle.backup.ledger.v2';

export const getBackupLedger = async (): Promise<BackupLedger | null> => {
  try {
    const raw = await AsyncStorage.getItem(LEDGER_KEY);
    return raw ? (JSON.parse(raw) as BackupLedger) : null;
  } catch {
    return null;
  }
};

const saveLedger = (ledger: BackupLedger): Promise<void> =>
  AsyncStorage.setItem(LEDGER_KEY, JSON.stringify(ledger)).catch(() => {});

/**
 * Forgets what is in iCloud (keeps the lineage). Called when the passphrase
 * changes: every record must be re-sealed under the new key, and the next run
 * does exactly that because nothing matches the ledger any more.
 */
export const resetBackupLedgerRecords = async (): Promise<void> => {
  const ledger = await getBackupLedger();
  if (ledger) await saveLedger({ ...ledger, salt: null, records: {} });
};

const sizesFrom = (records: Record<string, LedgerRecord>): Partial<Record<BackupCategory, number>> => {
  const sizes: Partial<Record<BackupCategory, number>> = {};
  for (const record of Object.values(records)) sizes[record.c] = (sizes[record.c] ?? 0) + record.b;
  return sizes;
};

// ---------------------------------------------------------------------------
// Summary: readable WITHOUT the passphrase.

export interface BackupSummary {
  createdAt: number;
  totalMessages: number;
  chatCount: number;
  mediaCount: number;
  bytes: number;
  deviceName: string | null;
  /** Absent on v1 backups. */
  lineage: string | null;
  sizes: Partial<Record<BackupCategory, number>>;
  contents: Partial<Record<BackupCategory, boolean>> | null;
}

/** Set when the last summary read failed for a reason other than "no backup". */
export let lastSummaryReadError: string | null = null;

/**
 * Reads the backup summary from the manifest record's metadata — which the
 * passphrase layer does not wrap, so no session or passphrase is needed. That
 * is what lets a just-signed-in phone show what a restore would bring back.
 * It lives in the user's PRIVATE CloudKit database and holds counts, bytes and
 * a timestamp, never content.
 *
 * Returns null when there is no backup. Throws-to-null with
 * `lastSummaryReadError` set when iCloud could not be read — callers that must
 * tell "no backup" from "couldn't check" read that.
 */
export const readBackupSummary = async (): Promise<BackupSummary | null> => {
  lastSummaryReadError = null;
  try {
    const chunk = await restoreChunkMetadata(RECORD_TYPE.manifest, MANIFEST_ID);
    const meta = chunk?.metadata;
    if (!meta?.summaryCreatedAt) return null;
    const num = (value: string | undefined): number => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const json = <T,>(value: string | undefined): T | null => {
      try {
        return value ? (JSON.parse(value) as T) : null;
      } catch {
        return null;
      }
    };
    return {
      createdAt: num(meta.summaryCreatedAt),
      totalMessages: num(meta.summaryTotalMessages),
      chatCount: num(meta.summaryChatCount),
      mediaCount: num(meta.summaryMediaCount),
      bytes: num(meta.summaryBytes),
      deviceName: meta.summaryDeviceName || null,
      lineage: meta.summaryLineage || null,
      sizes: json<Partial<Record<BackupCategory, number>>>(meta.summarySizes) ?? {},
      contents: json<Partial<Record<BackupCategory, boolean>>>(meta.summaryContents),
    };
  } catch (error) {
    lastSummaryReadError = error instanceof Error ? error.message : String(error);
    return null;
  }
};

// ---------------------------------------------------------------------------
// Takeover: may THIS device write over what is in iCloud?

export interface TakeoverAssessment {
  remote: BackupSummary | null;
  /** This device wrote or restored the backup that is in iCloud now. */
  sameChain: boolean;
  /** Messages this device would back up. */
  localMessages: number;
  /**
   * Writing now would REPLACE a backup holding more messages than this device
   * has — the new-phone / reinstall case. Never allowed implicitly.
   */
  wouldShrink: boolean;
}

export const assessTakeover = async (): Promise<TakeoverAssessment> => {
  const [remote, ledger, stats] = await Promise.all([
    readBackupSummary(),
    getBackupLedger(),
    getLocalMessageStats(),
  ]);
  if (!remote && lastSummaryReadError) {
    // "Couldn't check" must never be read as "nothing there" — that is
    // precisely how an empty phone would overwrite a real backup.
    throw new Error(`Could not read the backup in iCloud: ${lastSummaryReadError}`);
  }
  const localMessages = stats.reduce((sum, stat) => sum + stat.count, 0);
  const sameChain = Boolean(remote && ledger && remote.lineage && remote.lineage === ledger.lineage);
  const wouldShrink = Boolean(remote && !sameChain && remote.totalMessages > localMessages);
  return { remote, sameChain, localMessages, wouldShrink };
};

// ---------------------------------------------------------------------------
// Export

/** Device-scoped preferences worth carrying to a new phone — an ALLOW-LIST.
 *  Security state (app lock, privacy guard, lockout counters) is deliberately
 *  excluded, as are identity and regenerable caches. */
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

const WALLPAPER_CONFIG_KEY = 'wallpapers_v1';
const WALLPAPER_DIRECTORY = `${documentDirectory}wallpapers/`;

/**
 * Media ceilings. Native transfer memory-maps the file and seals it once, so
 * it handles anything a chat can hold; the base64 fallback (an app binary
 * older than v2's native functions) keeps v1's 24MB ceiling, since there the
 * whole file sits in the JS heap.
 */
const MAX_NATIVE_MEDIA_BYTES = 400 * 1024 * 1024;
const MAX_BRIDGE_MEDIA_BYTES = 24 * 1024 * 1024;

export interface ExportOptions {
  /** Explicitly start a NEW backup chain over whatever is in iCloud. */
  replaceExisting?: boolean;
}

export class BackupWouldShrinkError extends Error {
  constructor(readonly remote: BackupSummary, readonly localMessages: number) {
    super(
      `iCloud has a larger backup (${remote.totalMessages} messages) than this device (${localMessages}).`,
    );
    this.name = 'BackupWouldShrinkError';
  }
}

/**
 * Full (incremental) export.
 *
 * Record order is messages → extras → media → manifest, and the manifest is
 * written LAST: it is the index a restore reads first, so it must only ever
 * describe records that already landed. The ledger is saved after every chat
 * and every media file, so an interrupted run (iOS ending a background task)
 * resumes from there.
 */
export const exportBackup = (
  passphrase: string,
  onProgress?: (progress: BackupProgress) => void,
  options: ExportOptions = {},
): Promise<BackupManifest> =>
  runExclusive(async () => {
    const takeover = await assessTakeover();
    if (takeover.wouldShrink && !options.replaceExisting && takeover.remote) {
      throw new BackupWouldShrinkError(takeover.remote, takeover.localMessages);
    }

    // Continue the chain this device knows, or start a new one. A missing
    // remote manifest means the ledger describes nothing that still exists
    // (iCloud data deleted, or never written), so it is discarded too.
    const prior = await getBackupLedger();
    const continuing = takeover.sameChain && !options.replaceExisting && prior;
    const ledger: BackupLedger = continuing
      ? { ...prior, records: { ...prior.records } }
      : {
          // Adopting a v1 backup this device wrote keeps it as one chain with
          // no gap; anything else is a fresh chain.
          lineage: newLineage(),
          salt: null,
          records: {},
        };

    // Starting a new chain over an existing backup (an explicit replace, or
    // adopting a v1 backup): its records are not in this device's ledger, so
    // nothing would ever prune them. Read the old manifest — in its own
    // session, before ours opens — to learn their ids. If it doesn't open
    // with this passphrase they're left as they are, which wastes quota but
    // never risks data.
    const previousIds = new Set<string>();
    if (!continuing && takeover.remote) {
      try {
        await beginBackupSession(passphrase);
        const old = await restoreChunk(RECORD_TYPE.manifest, MANIFEST_ID);
        if (old) {
          const previous = decodeJson<BackupManifest>(old.payloadBase64);
          for (const chat of previous.chats) for (const id of chat.batchIds) previousIds.add(id);
          for (const id of previous.mediaIds ?? []) previousIds.add(id);
          [CALL_HISTORY_ID, WALLPAPERS_ID, LOCAL_SETTINGS_ID].forEach((id) => previousIds.add(id));
        }
      } catch {
        // Different passphrase or unreadable: nothing to prune.
      } finally {
        await endBackupSession();
      }
    }

    const passphraseSetAt = await getEnrolledAt();
    if ((ledger.passphraseSetAt ?? null) !== passphraseSetAt) {
      ledger.salt = null;
      ledger.passphraseSetAt = passphraseSetAt;
    }
    const { salt } = await beginBackupSession(passphrase, ledger.salt ?? undefined);
    if (ledger.salt !== salt) {
      // A new key means nothing already uploaded can be read with it.
      ledger.salt = salt;
      ledger.records = {};
    }
    await saveLedger(ledger);

    const selection = await getBackupSelection();
    let bytesDone = 0;

    /** Uploads a JSON record only if its content changed since last time. */
    const putJson = async (
      category: BackupCategory,
      recordType: string,
      recordId: string,
      payload: string,
      metadata: Record<string, string> = {},
    ): Promise<void> => {
      const hash = await contentHash(payload);
      if (ledger.records[recordId]?.h === hash) return;
      await backupChunk(recordType, recordId, payload, metadata);
      const bytes = base64Bytes(payload);
      ledger.records[recordId] = { h: hash, b: bytes, c: category };
      bytesDone += bytes;
    };

    try {
      const chatIds = (await getLocalMessageStats()).map((stat) => stat.chatId);
      onProgress?.({ phase: 'preparing', chatsDone: 0, chatsTotal: chatIds.length, messagesDone: 0 });

      const chats: ChatManifestEntry[] = [];
      let messagesDone = 0;

      if (selection.messages) {
        for (const [chatIndex, chatId] of chatIds.entries()) {
          const messages = await getChatMessages(chatId);
          // Oldest-first so batch N always holds the same messages across
          // runs: only the newest batch of an active chat changes, which is
          // what makes the incremental skip effective.
          const ordered = [...messages].sort((a, b) => a.createdAt - b.createdAt);
          const batchIds: string[] = [];
          for (let offset = 0; offset < ordered.length; offset += MESSAGES_PER_BATCH) {
            const slice = ordered.slice(offset, offset + MESSAGES_PER_BATCH);
            const id = batchId(chatId, batchIds.length);
            await putJson('messages', RECORD_TYPE.message, id, encodeJson(slice), {
              chatId,
              index: String(batchIds.length),
            });
            batchIds.push(id);
            messagesDone += slice.length;
          }
          chats.push({
            chatId,
            count: ordered.length,
            latestTimestamp: ordered.length > 0 ? ordered[ordered.length - 1].createdAt : null,
            batchChecksum: checksum(batchIds.join('|')),
            batchIds,
          });
          await saveLedger(ledger);
          onProgress?.({
            phase: 'messages',
            chatsDone: chatIndex + 1,
            chatsTotal: chatIds.length,
            messagesDone,
            category: 'messages',
            bytesDone,
          });
        }
      }

      const extra = (category: BackupCategory) =>
        onProgress?.({
          phase: 'extras',
          chatsDone: chatIds.length,
          chatsTotal: chatIds.length,
          messagesDone,
          category,
          bytesDone,
        });

      let callHistoryCount = 0;
      if (selection.callHistory) {
        extra('callHistory');
        const entries = await getCallHistory();
        callHistoryCount = entries.length;
        if (entries.length > 0) {
          await putJson('callHistory', RECORD_TYPE.callHistory, CALL_HISTORY_ID, encodeJson(entries));
        }
      }

      if (selection.wallpapers) {
        extra('wallpapers');
        const raw = await AsyncStorage.getItem(WALLPAPER_CONFIG_KEY);
        if (raw) {
          const map = JSON.parse(raw) as Record<string, { kind?: string; file?: string } | undefined>;
          const files: Record<string, string> = {};
          for (const entry of Object.values(map)) {
            if (entry?.kind !== 'photo' || !entry.file) continue;
            try {
              files[entry.file] = await readAsStringAsync(`${WALLPAPER_DIRECTORY}${entry.file}`, {
                encoding: 'base64',
              });
            } catch {
              // A slot pointing at a missing file is a local inconsistency.
            }
          }
          await putJson('wallpapers', RECORD_TYPE.wallpapers, WALLPAPERS_ID, encodeJson({ map, files }));
        }
      }

      if (selection.localSettings) {
        extra('localSettings');
        const pairs = await AsyncStorage.multiGet(LOCAL_SETTINGS_KEYS);
        const values: Record<string, string> = {};
        for (const [key, value] of pairs) {
          if (typeof value === 'string') values[key] = value;
        }
        if (Object.keys(values).length > 0) {
          await putJson('localSettings', RECORD_TYPE.localSettings, LOCAL_SETTINGS_ID, encodeJson(values));
        }
      }

      // Media: one record per file, immutable by message id, so a file that
      // is already in iCloud is never sent again.
      const mediaIds: string[] = [];
      let mediaSkippedTooLarge = 0;
      if (selection.media) {
        const native = hasNativeFileTransfer();
        const ceiling = native ? MAX_NATIVE_MEDIA_BYTES : MAX_BRIDGE_MEDIA_BYTES;
        const candidates: { chatId: string; message: ChatMessage }[] = [];
        for (const chatId of chatIds) {
          for (const message of await getChatMessages(chatId)) {
            if (message.localMediaPath && message.mediaDownloaded) candidates.push({ chatId, message });
          }
        }
        let filesDone = 0;
        for (const { chatId, message } of candidates) {
          const id = mediaRecordId(message.messageId);
          try {
            if (!ledger.records[id]) {
              const info = await getInfoAsync(message.localMediaPath!);
              if (!info.exists) continue;
              const size = typeof info.size === 'number' ? info.size : 0;
              if (size > ceiling) {
                mediaSkippedTooLarge += 1;
                continue;
              }
              const metadata = {
                chatId,
                messageId: message.messageId,
                fileName: message.mediaMetadata?.fileName ?? '',
              };
              let bytes: number;
              if (native) {
                bytes = await backupFile(RECORD_TYPE.media, id, message.localMediaPath!, metadata);
              } else {
                const payload = await readAsStringAsync(message.localMediaPath!, { encoding: 'base64' });
                await backupChunk(RECORD_TYPE.media, id, payload, metadata);
                bytes = base64Bytes(payload);
              }
              ledger.records[id] = { h: 'file', b: bytes, c: 'media' };
              bytesDone += bytes;
              await saveLedger(ledger);
            }
            mediaIds.push(id);
          } catch {
            // One unreadable file must not abort an otherwise good backup.
          } finally {
            filesDone += 1;
            onProgress?.({
              phase: 'media',
              chatsDone: chatIds.length,
              chatsTotal: chatIds.length,
              messagesDone,
              category: 'media',
              filesDone,
              filesTotal: candidates.length,
              bytesDone,
            });
          }
        }
      }

      // Everything the new manifest references. Ledger entries outside it are
      // pruned below, after the manifest has landed.
      const referenced = new Set<string>([
        ...chats.flatMap((chat) => chat.batchIds),
        ...mediaIds,
        ...(selection.callHistory && callHistoryCount > 0 ? [CALL_HISTORY_ID] : []),
        ...(selection.wallpapers && ledger.records[WALLPAPERS_ID] ? [WALLPAPERS_ID] : []),
        ...(selection.localSettings && ledger.records[LOCAL_SETTINGS_ID] ? [LOCAL_SETTINGS_ID] : []),
      ]);
      const live: Record<string, LedgerRecord> = {};
      for (const id of referenced) if (ledger.records[id]) live[id] = ledger.records[id];
      const sizes = sizesFrom(live);
      const totalBytes = Object.values(sizes).reduce((sum: number, n) => sum + (n ?? 0), 0);

      const manifest: BackupManifest = {
        version: 2,
        createdAt: Date.now(),
        salt,
        lineage: ledger.lineage,
        chats,
        totalMessages: messagesDone,
        recoverySecret: await getOrCreateRecoverySecret(),
        contents: selection,
        mediaIds,
        mediaSkippedTooLarge,
        callHistoryCount,
        sizes,
      };
      onProgress?.({ phase: 'manifest', chatsDone: chatIds.length, chatsTotal: chatIds.length, messagesDone, bytesDone });

      await backupChunk(RECORD_TYPE.manifest, MANIFEST_ID, encodeJson(manifest), {
        summaryVersion: '2',
        summaryCreatedAt: String(manifest.createdAt),
        summaryTotalMessages: String(manifest.totalMessages),
        summaryChatCount: String(chats.length),
        summaryMediaCount: String(mediaIds.length),
        summaryBytes: String(totalBytes),
        summarySizes: JSON.stringify(sizes),
        summaryContents: JSON.stringify(selection),
        summaryLineage: ledger.lineage,
        summaryDeviceName: Device.deviceName ?? '',
      });

      // Read it back. v1 once reported "194 messages, 612 KB" for a backup
      // that never reached iCloud; success is now claimed only after iCloud
      // returns the record we just wrote.
      onProgress?.({ phase: 'verifying', chatsDone: chatIds.length, chatsTotal: chatIds.length, messagesDone, bytesDone });
      const landed = await restoreChunkMetadata(RECORD_TYPE.manifest, MANIFEST_ID);
      if (landed?.metadata?.summaryCreatedAt !== String(manifest.createdAt)) {
        throw new Error('The backup was written but iCloud did not return it. Try again.');
      }

      // Prune what the manifest no longer references. Best effort: a failed
      // delete only leaves unreferenced bytes behind, never breaks a restore.
      const stale = [...new Set([...Object.keys(ledger.records), ...previousIds])].filter((id) => !referenced.has(id));
      try {
        await deleteRecords(stale);
        for (const id of stale) delete ledger.records[id];
      } catch {
        // Retried naturally on the next run.
      }
      await saveLedger(ledger);

      onProgress?.({ phase: 'complete', chatsDone: chatIds.length, chatsTotal: chatIds.length, messagesDone, bytesDone });
      return manifest;
    } finally {
      // Always drop the key, including on failure.
      await endBackupSession();
    }
  });

// ---------------------------------------------------------------------------
// Manifest read / verify

/**
 * Reads and decrypts the manifest — what proves the passphrase is right.
 * Fetched by KNOWN id: CloudKit has no queryable index for a fresh install.
 */
export const readBackupManifest = (passphrase: string): Promise<BackupManifest | null> =>
  runExclusive(async () => {
    await beginBackupSession(passphrase);
    try {
      const chunk = await restoreChunk(RECORD_TYPE.manifest, MANIFEST_ID);
      if (!chunk) return null;
      return decodeJson<BackupManifest>(chunk.payloadBase64);
    } finally {
      await endBackupSession();
    }
  });

/**
 * Verifies a backup against its own manifest for §3.7's retirement gate:
 * every batch must be present AND decrypt.
 */
export const verifyBackup = (
  passphrase: string,
  manifest: BackupManifest,
): Promise<{ ok: boolean; missing: string[] }> =>
  runExclusive(async () => {
    const missing: string[] = [];
    await beginBackupSession(passphrase, manifest.salt);
    try {
      for (const chat of manifest.chats) {
        if (checksum(chat.batchIds.join('|')) !== chat.batchChecksum) {
          missing.push(...chat.batchIds);
          continue;
        }
        for (const id of chat.batchIds) {
          const chunk = await restoreChunk(RECORD_TYPE.message, id);
          if (!chunk) missing.push(id);
        }
      }
    } finally {
      await endBackupSession();
    }
    return { ok: missing.length === 0, missing };
  });

// ---------------------------------------------------------------------------
// Import

export interface RestoreProgress {
  phase: 'manifest' | 'messages' | 'extras' | 'media' | 'complete';
  chatsDone: number;
  chatsTotal: number;
  messagesRestored: number;
  filesDone?: number;
  filesTotal?: number;
}

export interface RestoreResult {
  messagesRestored: number;
  /** Batches named by the manifest that could not be read. */
  missingBatches: string[];
  mediaRestored: number;
  mediaFailed: number;
  /** Local settings were restored and apply after a relaunch. */
  needsRestart: boolean;
}

const manifestHas = (manifest: BackupManifest, category: BackupCategory): boolean =>
  manifest.contents ? manifest.contents[category] === true : category === 'messages';

/**
 * Full import onto a new/promoted main device. Merges: everything already on
 * the device is kept (saveMessageLocally dedupes by id).
 *
 * On success the device JOINS the backup's chain: the ledger takes the
 * manifest's lineage and salt and records the hashes of exactly what was read,
 * so this device's next backup continues that backup instead of being refused
 * as a takeover — and only uploads what changed since.
 */
export const importBackup = (
  passphrase: string,
  onProgress?: (progress: RestoreProgress) => void,
): Promise<RestoreResult> =>
  runExclusive(async () => {
    await beginBackupSession(passphrase);
    try {
      const manifestChunk = await restoreChunk(RECORD_TYPE.manifest, MANIFEST_ID);
      if (!manifestChunk) throw new Error('No backup was found in iCloud.');
      const manifest = decodeJson<BackupManifest>(manifestChunk.payloadBase64);
      const records: Record<string, LedgerRecord> = {};
      const total = manifest.chats.length;
      onProgress?.({ phase: 'manifest', chatsDone: 0, chatsTotal: total, messagesRestored: 0 });

      let messagesRestored = 0;
      const missingBatches: string[] = [];
      for (const [chatIndex, chat] of manifest.chats.entries()) {
        for (const id of chat.batchIds) {
          const chunk = await restoreChunk(RECORD_TYPE.message, id);
          if (!chunk) {
            missingBatches.push(id);
            continue;
          }
          for (const message of decodeJson<ChatMessage[]>(chunk.payloadBase64)) {
            await saveMessageLocally(message);
            messagesRestored += 1;
          }
          records[id] = { h: await contentHash(chunk.payloadBase64), b: base64Bytes(chunk.payloadBase64), c: 'messages' };
        }
        onProgress?.({ phase: 'messages', chatsDone: chatIndex + 1, chatsTotal: total, messagesRestored });
      }

      onProgress?.({ phase: 'extras', chatsDone: total, chatsTotal: total, messagesRestored });

      if (manifestHas(manifest, 'callHistory')) {
        const chunk = await restoreChunk(RECORD_TYPE.callHistory, CALL_HISTORY_ID);
        if (chunk) {
          for (const entry of decodeJson<CallHistoryEntry[]>(chunk.payloadBase64)) {
            await saveCallToHistory(entry);
          }
          records[CALL_HISTORY_ID] = { h: await contentHash(chunk.payloadBase64), b: base64Bytes(chunk.payloadBase64), c: 'callHistory' };
        }
      }

      if (manifestHas(manifest, 'wallpapers')) {
        const chunk = await restoreChunk(RECORD_TYPE.wallpapers, WALLPAPERS_ID);
        if (chunk) {
          const { map, files } = decodeJson<{ map: Record<string, unknown>; files: Record<string, string> }>(
            chunk.payloadBase64,
          );
          // Files first, so the slot map never points at images not yet there.
          await makeDirectoryAsync(WALLPAPER_DIRECTORY, { intermediates: true }).catch(() => {});
          for (const [fileName, base64] of Object.entries(files ?? {})) {
            await writeAsStringAsync(`${WALLPAPER_DIRECTORY}${fileName}`, base64, { encoding: 'base64' }).catch(
              () => {},
            );
          }
          await AsyncStorage.setItem(WALLPAPER_CONFIG_KEY, JSON.stringify(map));
          // wallpaperService caches the map; re-hydrate so it shows now.
          await hydrateWallpapers().catch(() => {});
          records[WALLPAPERS_ID] = { h: await contentHash(chunk.payloadBase64), b: base64Bytes(chunk.payloadBase64), c: 'wallpapers' };
        }
      }

      let needsRestart = false;
      if (manifestHas(manifest, 'localSettings')) {
        const chunk = await restoreChunk(RECORD_TYPE.localSettings, LOCAL_SETTINGS_ID);
        if (chunk) {
          const values = decodeJson<Record<string, string>>(chunk.payloadBase64);
          // Re-filtered on the way in: a backup is attacker-influenced input.
          const entries = Object.entries(values).filter(([key]) => LOCAL_SETTINGS_KEYS.includes(key));
          if (entries.length > 0) {
            await AsyncStorage.multiSet(entries);
            needsRestart = true;
          }
          records[LOCAL_SETTINGS_ID] = { h: await contentHash(chunk.payloadBase64), b: base64Bytes(chunk.payloadBase64), c: 'localSettings' };
        }
      }

      let mediaRestored = 0;
      let mediaFailed = 0;
      if (manifestHas(manifest, 'media')) {
        const ids = manifest.mediaIds ?? [];
        const native = hasNativeFileTransfer();
        for (const [index, id] of ids.entries()) {
          try {
            // One download per file. Where it belongs (chat + file name) is in
            // the record's metadata, which arrives WITH it — so the native path
            // writes to a temporary file first and it is moved into place.
            let bytes = 0;
            let meta: Record<string, string> | undefined;
            let staged: string | null = null;
            if (native) {
              staged = `${cacheDirectory}restore-${id}`;
              const result = await restoreFile(RECORD_TYPE.media, id, staged);
              if (!result) {
                mediaFailed += 1;
                continue;
              }
              bytes = result.bytes;
              meta = result.metadata;
            } else {
              const chunk = await restoreChunk(RECORD_TYPE.media, id);
              if (!chunk) {
                mediaFailed += 1;
                continue;
              }
              bytes = base64Bytes(chunk.payloadBase64);
              meta = chunk.metadata;
              staged = null;
              const { chatId: c, messageId: m, fileName: f } = meta ?? {};
              if (c && m) {
                const target = getLocalMediaPath(c, m, f || m);
                await makeDirectoryAsync(target.slice(0, target.lastIndexOf('/')), { intermediates: true }).catch(() => {});
                await writeAsStringAsync(target, chunk.payloadBase64, { encoding: 'base64' });
              }
            }
            const { chatId, messageId, fileName } = meta ?? {};
            if (!chatId || !messageId) {
              if (staged) await deleteAsync(staged, { idempotent: true }).catch(() => {});
              mediaFailed += 1;
              continue;
            }
            const localPath = getLocalMediaPath(chatId, messageId, fileName || messageId);
            if (staged) {
              await makeDirectoryAsync(localPath.slice(0, localPath.lastIndexOf('/')), { intermediates: true }).catch(() => {});
              await deleteAsync(localPath, { idempotent: true }).catch(() => {});
              await moveAsync({ from: staged, to: localPath });
            }
            // Point the restored message at the restored file, or the bubble
            // would still show as not-downloaded.
            await updateMessageLocalPath(chatId, messageId, localPath);
            records[id] = { h: 'file', b: bytes, c: 'media' };
            mediaRestored += 1;
          } catch {
            mediaFailed += 1;
          } finally {
            onProgress?.({
              phase: 'media',
              chatsDone: total,
              chatsTotal: total,
              messagesRestored,
              filesDone: index + 1,
              filesTotal: ids.length,
            });
          }
        }
      }

      // Join the chain (see above). A v1 backup has no lineage; the restore
      // adopts it under a new one, recorded in the next manifest.
      // The restoring passphrase becomes this device's (see the caller), so
      // the records are valid under whatever enrollment time it gets: the
      // caller enrolls first, and passphraseSetAt is read after that.
      await saveLedger({
        lineage: manifest.lineage ?? newLineage(),
        salt: manifest.salt,
        passphraseSetAt: await getEnrolledAt(),
        records,
      });

      onProgress?.({ phase: 'complete', chatsDone: total, chatsTotal: total, messagesRestored });
      return { messagesRestored, missingBatches, mediaRestored, mediaFailed, needsRestart };
    } finally {
      await endBackupSession();
    }
  });

export { verifyBackupIntegrity };
