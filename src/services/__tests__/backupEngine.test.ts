/**
 * backupEngine.test.ts — backup v2's guarantees, against an in-memory CloudKit.
 * Run with `npm run test:services`.
 *
 *  - Incremental: an unchanged history uploads nothing; one new message
 *    re-sends only the batch it landed in.
 *  - Takeover guard: a device holding fewer messages than the backup in iCloud
 *    cannot replace it unless told to, and "couldn't read iCloud" is never
 *    treated as "nothing there".
 *  - Restore joins the chain, so the restored phone continues the backup.
 *  - A passphrase change re-seals everything (a skipped record would only open
 *    with the old passphrase).
 *  - Success is claimed only after iCloud returns the manifest.
 *  - Records the manifest no longer references are pruned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Fake CloudKit + native crypto ---------------------------------------
interface StoredRecord {
  recordType: string;
  payloadBase64: string;
  metadata: Record<string, string>;
  /** Passphrase it was sealed under: a different session can't open it. */
  sealedWith: string;
}

const cloud = vi.hoisted(() => ({
  records: new Map<string, StoredRecord>(),
  session: null as string | null,
  writes: [] as string[],
  deletes: [] as string[],
  dropManifestWrites: false,
  metadataReadError: null as string | null,
}));

vi.mock('../../../modules/splitcircle-backup', () => {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    runExclusive: <T,>(work: () => Promise<T>) => {
      const run = queue.then(work, work);
      queue = run.catch(() => undefined);
      return run;
    },
    hasNativeFileTransfer: () => true,
    beginBackupSession: async (passphrase: string, salt?: string) => {
      cloud.session = passphrase;
      return { salt: salt ?? `salt-${Math.random().toString(36).slice(2)}` };
    },
    endBackupSession: async () => {
      cloud.session = null;
    },
    backupChunk: async (recordType: string, recordId: string, payloadBase64: string, metadata: Record<string, string>) => {
      if (!cloud.session) throw new Error('no session');
      cloud.writes.push(recordId);
      if (recordType === 'manifest' && cloud.dropManifestWrites) return;
      cloud.records.set(recordId, { recordType, payloadBase64, metadata, sealedWith: cloud.session });
    },
    backupFile: async (recordType: string, recordId: string, filePath: string, metadata: Record<string, string>) => {
      cloud.writes.push(recordId);
      cloud.records.set(recordId, { recordType, payloadBase64: btoa(filePath), metadata, sealedWith: cloud.session! });
      return 1000;
    },
    restoreChunk: async (_type: string, recordId: string) => {
      const record = cloud.records.get(recordId);
      if (!record) return null;
      if (record.sealedWith !== cloud.session) throw new Error('decryptionFailed');
      return { recordType: record.recordType, recordId, payloadBase64: record.payloadBase64, metadata: record.metadata };
    },
    restoreChunkMetadata: async (_type: string, recordId: string) => {
      if (cloud.metadataReadError) throw new Error(cloud.metadataReadError);
      const record = cloud.records.get(recordId);
      return record ? { recordId, metadata: record.metadata } : null;
    },
    restoreFile: async (_type: string, recordId: string) => {
      const record = cloud.records.get(recordId);
      return record ? { metadata: record.metadata, bytes: 1000 } : null;
    },
    deleteRecords: async (ids: string[]) => {
      for (const id of ids) {
        cloud.deletes.push(id);
        cloud.records.delete(id);
      }
    },
    verifyBackupIntegrity: async () => true,
  };
});

// ---- Fake device ----------------------------------------------------------
const device = vi.hoisted(() => ({
  chats: new Map<string, { messageId: string; chatId: string; createdAt: number; content: string; localMediaPath?: string; mediaDownloaded?: boolean }[]>(),
  enrolledAt: 1 as number | null,
  media: false,
  moved: [] as string[],
  relinked: [] as string[],
}));

vi.mock('@/services/localMessageStorage', () => ({
  getLocalMessageStats: async () =>
    [...device.chats.entries()].map(([chatId, msgs]) => ({ chatId, count: msgs.length, latestTimestamp: null })),
  getChatMessages: async (chatId: string) => [...(device.chats.get(chatId) ?? [])],
  saveMessageLocally: async (message: { chatId: string; messageId: string }) => {
    const list = device.chats.get(message.chatId) ?? [];
    if (!list.some((m) => m.messageId === message.messageId)) list.push(message as never);
    device.chats.set(message.chatId, list);
  },
  updateMessageLocalPath: async (_chatId: string, messageId: string) => {
    device.relinked.push(messageId);
  },
}));
vi.mock('@/services/localCallStorage', () => ({ getCallHistory: async () => [], saveCallToHistory: async () => {} }));
vi.mock('@/services/mediaService', () => ({
  getLocalMediaPath: (chatId: string, messageId: string) => `/doc/media/${chatId}/${messageId}`,
}));
vi.mock('@/services/wallpaperService', () => ({ hydrateWallpapers: async () => {} }));
vi.mock('@/services/backupPassphraseService', () => ({
  getOrCreateRecoverySecret: async () => 'secret',
  getEnrolledAt: async () => device.enrolledAt,
}));
vi.mock('@/services/backupContentService', () => ({
  getBackupSelection: async () => ({ messages: true, media: device.media, callHistory: false, wallpapers: false, localSettings: false }),
}));
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: '/cache/',
  deleteAsync: async () => {},
  moveAsync: async ({ to }: { to: string }) => {
    device.moved.push(to);
  },
  documentDirectory: '/doc/',
  getInfoAsync: async () => ({ exists: true, size: 10 }),
  makeDirectoryAsync: async () => {},
  readAsStringAsync: async () => '',
  writeAsStringAsync: async () => {},
}));
vi.mock('expo-device', () => ({ deviceName: 'Test iPhone' }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BackupWouldShrinkError,
  assessTakeover,
  exportBackup,
  getBackupLedger,
  importBackup,
} from '../backupService';

const seed = (chatId: string, count: number) =>
  device.chats.set(
    chatId,
    Array.from({ length: count }, (_, i) => ({ messageId: `${chatId}-${i}`, chatId, createdAt: i + 1, content: `m${i}` })),
  );

const dataWrites = () => cloud.writes.filter((id) => id !== 'manifest-current');

/** A different phone: same iCloud, its own local storage and ledger. */
const switchToNewPhone = async () => {
  device.chats.clear();
  await AsyncStorage.clear();
};

beforeEach(async () => {
  cloud.records.clear();
  cloud.writes = [];
  cloud.deletes = [];
  cloud.session = null;
  cloud.dropManifestWrites = false;
  cloud.metadataReadError = null;
  device.chats.clear();
  device.enrolledAt = 1;
  device.media = false;
  device.moved = [];
  device.relinked = [];
  await AsyncStorage.clear();
});

describe('incremental export', () => {
  it('uploads nothing the second time and only the changed batch after a new message', async () => {
    seed('a', 1200); // 3 batches of 500/500/200
    seed('b', 10);
    await exportBackup('pass');
    expect(dataWrites()).toHaveLength(4);

    cloud.writes = [];
    await exportBackup('pass');
    expect(dataWrites()).toHaveLength(0);

    device.chats.get('a')!.push({ messageId: 'a-new', chatId: 'a', createdAt: 99999, content: 'hi' });
    cloud.writes = [];
    await exportBackup('pass');
    expect(dataWrites()).toEqual(['msg-a-2']);
  });

  it('claims success only once iCloud returns the manifest', async () => {
    seed('a', 3);
    cloud.dropManifestWrites = true;
    await expect(exportBackup('pass')).rejects.toThrow(/did not return it/);
  });

  it('prunes records the new manifest no longer references', async () => {
    seed('a', 3);
    seed('b', 3);
    await exportBackup('pass');
    device.chats.delete('b');
    await exportBackup('pass');
    expect(cloud.deletes).toEqual(['msg-b-0']);
    expect(cloud.records.has('msg-b-0')).toBe(false);
  });

  it('re-seals everything when the passphrase changes', async () => {
    seed('a', 600);
    await exportBackup('old pass');
    device.enrolledAt = 2;
    cloud.writes = [];
    await exportBackup('new pass');
    expect(dataWrites()).toEqual(['msg-a-0', 'msg-a-1']);
    for (const record of cloud.records.values()) expect(record.sealedWith).toBe('new pass');
  });
});

describe('takeover guard', () => {
  it('refuses to replace a bigger backup from a phone that did not restore it', async () => {
    seed('a', 50);
    await exportBackup('pass');

    await switchToNewPhone();
    seed('fresh', 2);
    await expect(exportBackup('pass')).rejects.toBeInstanceOf(BackupWouldShrinkError);
    expect(cloud.records.has('msg-a-0')).toBe(true);

    // Only an explicit choice replaces it.
    await exportBackup('pass', undefined, { replaceExisting: true });
    expect(cloud.records.has('msg-a-0')).toBe(false);
  });

  it('never treats an unreadable iCloud as an empty one', async () => {
    seed('a', 5);
    cloud.metadataReadError = 'network lost';
    await expect(assessTakeover()).rejects.toThrow(/Could not read/);
    await expect(exportBackup('pass')).rejects.toThrow(/Could not read/);
  });
});

describe('restore', () => {
  it('brings the history back and continues the same backup afterwards', async () => {
    seed('a', 700);
    seed('b', 4);
    await exportBackup('pass');
    const lineage = (await getBackupLedger())!.lineage;

    await switchToNewPhone();
    const result = await importBackup('pass');
    expect(result.messagesRestored).toBe(704);
    expect(device.chats.get('a')).toHaveLength(700);
    expect((await getBackupLedger())!.lineage).toBe(lineage);

    // The restored phone is part of the chain: backing up is allowed and
    // re-sends nothing, because it knows exactly what iCloud holds.
    cloud.writes = [];
    await exportBackup('pass');
    expect(dataWrites()).toHaveLength(0);
  });

  it('fails cleanly with the wrong passphrase', async () => {
    seed('a', 3);
    await exportBackup('right');
    await switchToNewPhone();
    await expect(importBackup('wrong')).rejects.toThrow();
    expect(device.chats.size).toBe(0);
  });
});

describe('media', () => {
  it('uploads each file once and restores it into place in a single download', async () => {
    device.media = true;
    device.chats.set('a', [
      { messageId: 'p1', chatId: 'a', createdAt: 1, content: '', localMediaPath: '/doc/x.jpg', mediaDownloaded: true },
      { messageId: 'p2', chatId: 'a', createdAt: 2, content: '', localMediaPath: '/doc/y.jpg', mediaDownloaded: true },
    ]);
    await exportBackup('pass');
    expect(dataWrites().filter((id) => id.startsWith('media-'))).toEqual(['media-p1', 'media-p2']);

    cloud.writes = [];
    await exportBackup('pass');
    expect(dataWrites()).toHaveLength(0);

    await switchToNewPhone();
    const result = await importBackup('pass');
    expect(result.mediaRestored).toBe(2);
    expect(device.moved).toEqual(['/doc/media/a/p1', '/doc/media/a/p2']);
    expect(device.relinked).toEqual(['p1', 'p2']);
  });
});
