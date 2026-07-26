/**
 * Device retirement / promotion safety gate (doc 31 §3.7, Phase 7).
 *
 * This is the code path where a bug causes IRREVERSIBLE user data loss: it is
 * what tells someone "yes, it's safe to wipe or give away your old phone". Two
 * rules follow from that and are load-bearing throughout:
 *
 *   1. Nothing here may EVER report ready on incomplete evidence. Every unknown
 *      resolves to blocked, never to "probably fine".
 *   2. The second-device check must perform REAL DECRYPTION, never a metadata
 *      comparison (§3.7 point 3). A structurally-intact-but-corrupted backup
 *      must not pass — if the verifier only re-derives counts from CloudKit
 *      metadata, the ciphertext never round-trips and the gate is gameable.
 */

import { restoreChunk } from '../../modules/splitcircle-backup';
import { signWithIdentity, verifyWithIdentity } from '../../modules/splitcircle-crypto';
import { getLocalMessageStats } from '@/services/localMessageStorage';
import { getLastBackupInfo } from '@/services/backupRunner';
import { getCurrentDeviceId } from '@/services/pairingService';
import { getIdentityKeyForDevice, listSignalDevices } from '@/services/signalCryptoService';
import {
  RECORD_TYPE,
  readBackupManifest,
  type BackupManifest,
} from '@/services/backupService';
import { backupChunk, beginBackupSession, endBackupSession } from '../../modules/splitcircle-backup';

/** A backup older than this is treated as stale — §3.7 forces a fresh one. */
const MAX_BACKUP_AGE_MS = 24 * 60 * 60 * 1000;

export const ATTESTATION_RECORD_ID = 'retirement-attestation';
export const VERIFIED_RECORD_ID_PREFIX = 'restore-verified-';

export interface RetirementBlocker {
  code:
    | 'no_backup'
    | 'backup_stale'
    | 'count_mismatch'
    | 'no_attestation'
    | 'no_verifier'
    | 'awaiting_verification'
    | 'icloud_unavailable'
    | 'messages_excluded';
  /** Plain language, per §3.7 point 5 — shown to the user verbatim. */
  message: string;
}

export interface RetirementReadiness {
  canRetire: boolean;
  blockers: RetirementBlocker[];
  manifest: BackupManifest | null;
  /** Devices other than this one that have published keys — potential verifiers. */
  otherDeviceCount: number;
}

interface RetirementAttestation {
  version: 1;
  deviceId: string;
  createdAt: number;
  /** Snapshot of what the backup claimed, so a verifier checks the SAME manifest. */
  chats: { chatId: string; count: number; latestTimestamp: number | null }[];
  totalMessages: number;
  /** base64 signature over the canonical payload, by the Signal identity key. */
  signature: string;
  identityKey: string;
}

interface RestoreVerified {
  version: 1;
  verifierDeviceId: string;
  verifiedAt: number;
  /** Batches actually decrypted, so a caller can see the check was real. */
  batchesDecrypted: number;
  totalMessagesSeen: number;
  attestationCreatedAt: number;
  /**
   * Signature over the canonical ack payload by the VERIFIER's identity key.
   *
   * Without this the ack was forgeable: the attestation was signed but the ack
   * was not, so anyone who could write to the container could publish a
   * "verified" record and unlock retirement without any backup ever being
   * read. Found in the Phase 6/7 adversarial review.
   */
  signature: string;
}

const encodeJson = (value: unknown): string =>
  // eslint-disable-next-line no-undef
  globalThis.btoa(unescape(encodeURIComponent(JSON.stringify(value))));

const decodeJson = <T>(base64: string): T =>
  // eslint-disable-next-line no-undef
  JSON.parse(decodeURIComponent(escape(globalThis.atob(base64)))) as T;

/**
 * The exact bytes an attestation signs. Stable field order matters — a
 * verifier must reconstruct this byte-for-byte, so it can never depend on
 * JSON key ordering from elsewhere.
 */
const ackPayload = (a: Omit<RestoreVerified, 'signature'>): string =>
  encodeJson({
    version: a.version,
    verifierDeviceId: a.verifierDeviceId,
    verifiedAt: a.verifiedAt,
    batchesDecrypted: a.batchesDecrypted,
    totalMessagesSeen: a.totalMessagesSeen,
    attestationCreatedAt: a.attestationCreatedAt,
  });

const attestationPayload = (a: Omit<RetirementAttestation, 'signature' | 'identityKey'>): string =>
  encodeJson({
    version: a.version,
    deviceId: a.deviceId,
    createdAt: a.createdAt,
    totalMessages: a.totalMessages,
    chats: [...a.chats]
      .sort((x, y) => x.chatId.localeCompare(y.chatId))
      .map((c) => ({ chatId: c.chatId, count: c.count, latestTimestamp: c.latestTimestamp })),
  });

/**
 * Compares what is on THIS device against what the backup manifest claims.
 *
 * Reports a gap when local holds MORE than the backup does — that is
 * unbacked-up data and the whole point of the gate. The reverse (backup holds
 * more) is normal: the backup legitimately retains history this device has
 * since pruned.
 */
const reconcile = async (
  manifest: BackupManifest,
): Promise<{ ok: boolean; missingChats: string[]; missingMessages: number }> => {
  const local = await getLocalMessageStats();
  const byChat = new Map(manifest.chats.map((c) => [c.chatId, c]));

  const missingChats: string[] = [];
  let missingMessages = 0;

  for (const stat of local) {
    const backed = byChat.get(stat.chatId);
    if (!backed) {
      if (stat.count > 0) {
        missingChats.push(stat.chatId);
        missingMessages += stat.count;
      }
      continue;
    }
    if (stat.count > backed.count) {
      missingChats.push(stat.chatId);
      missingMessages += stat.count - backed.count;
    }
  }

  return { ok: missingChats.length === 0, missingChats, missingMessages };
};

/**
 * Assesses whether this device may be retired.
 *
 * Every failure path adds a blocker rather than throwing, so the UI can show
 * all reasons at once instead of one-at-a-time whack-a-mole.
 */
export const assessRetirementReadiness = async (
  userId: string,
  passphrase: string,
): Promise<RetirementReadiness> => {
  const blockers: RetirementBlocker[] = [];
  let manifest: BackupManifest | null = null;

  try {
    manifest = await readBackupManifest(passphrase);
  } catch {
    blockers.push({
      code: 'icloud_unavailable',
      message: 'Couldn’t read your iCloud backup. Check your connection and try again.',
    });
  }

  if (!manifest) {
    if (blockers.length === 0) {
      blockers.push({
        code: 'no_backup',
        message: 'No backup has been made yet.',
      });
    }
    return { canRetire: false, blockers, manifest: null, otherDeviceCount: 0 };
  }

  const last = await getLastBackupInfo();
  if (!last) {
    blockers.push({
      code: 'no_backup',
      message: 'This device hasn’t completed a backup yet.',
    });
  } else if (Date.now() - last.completedAt > MAX_BACKUP_AGE_MS) {
    blockers.push({
      code: 'backup_stale',
      message: 'Your last backup is more than a day old. Back up again before retiring this device.',
    });
  }

  // Selectable content (backupContentService) means "is the backup complete?"
  // is only meaningful relative to what was MEANT to be in it. A backup with
  // messages turned off still reconciles as a gap against local history — the
  // check below catches it — but it would report "N chats haven't finished
  // backing up", blaming a transfer that never started. Naming the real cause
  // matters here more than anywhere else in the app: the user is about to wipe
  // the only device holding these messages.
  const messagesIncluded = manifest.contents
    ? manifest.contents.messages === true
    : true; // Pre-selection backups are messages-only by definition.
  if (!messagesIncluded) {
    blockers.push({
      code: 'messages_excluded',
      message:
        'Chat messages are turned off in your backup settings, so your conversations are not in this backup. Turn them on and back up again before retiring this device.',
    });
  }

  const gap = await reconcile(manifest);
  if (!gap.ok && messagesIncluded) {
    blockers.push({
      code: 'count_mismatch',
      message:
        gap.missingChats.length === 1
          ? `1 chat hasn’t finished backing up (${gap.missingMessages} messages).`
          : `${gap.missingChats.length} chats haven’t finished backing up (${gap.missingMessages} messages).`,
    });
  }

  const ownDeviceId = await getCurrentDeviceId();
  const others = (await listSignalDevices(userId)).filter((d) => d.deviceId !== ownDeviceId);

  // §3.7 point 4: a single-device user has no independent verifier, so the
  // ONLY safe route is pair-new-device-first. This is deliberately a hard
  // blocker rather than an "informational self-check" alternative — a
  // self-check would look equally valid to the user and prove nothing.
  if (others.length === 0) {
    blockers.push({
      code: 'no_verifier',
      message:
        'Set up your new device and pair it first. Another device has to confirm it can actually read your backup before this one can be retired.',
    });
  } else {
    const attestation = await readAttestation(passphrase);
    if (!attestation) {
      blockers.push({
        code: 'no_attestation',
        message: 'Start the retirement check to publish your backup details for your other device.',
      });
    } else {
      const ack = await readVerifiedAck(userId, passphrase, others.map((d) => d.deviceId));
      if (!ack) {
        blockers.push({
          code: 'awaiting_verification',
          message: 'Waiting for your other device to confirm it received and could read your backup.',
        });
      } else if (ack.attestationCreatedAt !== attestation.createdAt) {
        // An ack for an OLDER attestation says nothing about the current
        // backup — treating it as valid is exactly the gameable path §3.7
        // point 3 warns about.
        blockers.push({
          code: 'awaiting_verification',
          message: 'Your backup changed since it was last confirmed. Waiting for a fresh confirmation.',
        });
      }
    }
  }

  return {
    canRetire: blockers.length === 0,
    blockers,
    manifest,
    otherDeviceCount: others.length,
  };
};

const readAttestation = async (passphrase: string): Promise<RetirementAttestation | null> => {
  await beginBackupSession(passphrase);
  try {
    const chunk = await restoreChunk(RECORD_TYPE.manifest, ATTESTATION_RECORD_ID);
    return chunk ? decodeJson<RetirementAttestation>(chunk.payloadBase64) : null;
  } catch {
    return null;
  } finally {
    await endBackupSession();
  }
};

/**
 * Reads an ack from another device AND verifies its signature against that
 * device's published identity key.
 *
 * An unverified ack is discarded rather than trusted: writing to the container
 * proves only iCloud access, and this gate is what unlocks wiping a phone.
 */
const readVerifiedAck = async (
  userId: string,
  passphrase: string,
  deviceIds: string[],
): Promise<RestoreVerified | null> => {
  const candidates: RestoreVerified[] = [];

  await beginBackupSession(passphrase);
  try {
    for (const deviceId of deviceIds) {
      const chunk = await restoreChunk(RECORD_TYPE.manifest, `${VERIFIED_RECORD_ID_PREFIX}${deviceId}`);
      if (chunk) candidates.push(decodeJson<RestoreVerified>(chunk.payloadBase64));
    }
  } catch {
    return null;
  } finally {
    await endBackupSession();
  }

  for (const ack of candidates) {
    const identityKey = await getIdentityKeyForDevice(userId, ack.verifierDeviceId);
    if (!identityKey) continue;
    const valid = await verifyWithIdentity(
      ackPayload({
        version: ack.version,
        verifierDeviceId: ack.verifierDeviceId,
        verifiedAt: ack.verifiedAt,
        batchesDecrypted: ack.batchesDecrypted,
        totalMessagesSeen: ack.totalMessagesSeen,
        attestationCreatedAt: ack.attestationCreatedAt,
      }),
      ack.signature ?? '',
      identityKey,
    ).catch(() => false);
    if (valid) return ack;
  }
  return null;
};

/**
 * Publishes this device's signed attestation of what its backup contains, so
 * another device can verify that exact snapshot.
 *
 * Signed with the Signal identity key: writing to the container proves only
 * iCloud access, whereas the signature proves this is the device peers already
 * know.
 */
export const publishRetirementAttestation = async (
  userId: string,
  passphrase: string,
  manifest: BackupManifest,
): Promise<void> => {
  const deviceId = await getCurrentDeviceId();
  const base = {
    version: 1 as const,
    deviceId,
    createdAt: Date.now(),
    totalMessages: manifest.totalMessages,
    chats: manifest.chats.map((c) => ({
      chatId: c.chatId,
      count: c.count,
      latestTimestamp: c.latestTimestamp,
    })),
  };

  const payload = attestationPayload(base);
  const signature = await signWithIdentity(payload);

  // The verifier needs our PUBLISHED identity key to check the signature.
  // Read it back from signalPrekeys rather than trusting anything local, so
  // the key checked is the same one peers already see.
  const identityKey = await getIdentityKeyForDevice(userId, deviceId);
  if (!identityKey) {
    throw new Error('This device has not published its encryption keys yet.');
  }

  const attestation: RetirementAttestation = { ...base, signature, identityKey };

  await beginBackupSession(passphrase);
  try {
    await backupChunk(RECORD_TYPE.manifest, ATTESTATION_RECORD_ID, encodeJson(attestation), {});
  } finally {
    await endBackupSession();
  }
};

/**
 * Run on the OTHER device: actually restores and DECRYPTS every batch the
 * attestation names, then acks.
 *
 * Decryption is the point (§3.7 point 3). `restoreChunk` fails on an
 * auth-tag mismatch, so a batch that is present-but-corrupt throws here rather
 * than being counted — which is precisely what a metadata-only check would
 * miss.
 */
export const verifyBackupAsSecondDevice = async (
  passphrase: string,
): Promise<{ ok: boolean; batchesDecrypted: number; failures: string[] }> => {
  const attestation = await readAttestation(passphrase);
  if (!attestation) {
    return { ok: false, batchesDecrypted: 0, failures: ['No attestation published yet.'] };
  }

  // A device must not verify its OWN attestation. §3.7's trust anchor is an
  // INDEPENDENT device proving the backup is readable; self-verification
  // proves nothing and would collapse the two-device requirement to one.
  // (readAnyVerification only looks at other devices' acks, so this was
  // already mitigated — but relying on that coupling is fragile, so refuse
  // explicitly at the source.)
  const ownDeviceId = await getCurrentDeviceId();
  if (attestation.deviceId === ownDeviceId) {
    return {
      ok: false,
      batchesDecrypted: 0,
      failures: ['This device published the attestation — another device has to verify it.'],
    };
  }

  const signatureValid = await verifyWithIdentity(
    attestationPayload(attestation),
    attestation.signature,
    attestation.identityKey,
  ).catch(() => false);
  if (!signatureValid) {
    // Refuse rather than verify an attestation we can't attribute — otherwise
    // anyone with container write access could declare a backup complete.
    return { ok: false, batchesDecrypted: 0, failures: ['Attestation signature is not valid.'] };
  }

  const manifest = await readBackupManifest(passphrase);
  if (!manifest) {
    return { ok: false, batchesDecrypted: 0, failures: ['Backup manifest could not be read.'] };
  }

  const failures: string[] = [];
  let batchesDecrypted = 0;
  let totalMessagesSeen = 0;

  await beginBackupSession(passphrase);
  try {
    for (const chat of manifest.chats) {
      for (const id of chat.batchIds) {
        try {
          const chunk = await restoreChunk(RECORD_TYPE.message, id);
          if (!chunk) {
            failures.push(id);
            continue;
          }
          // Parse too, not just decrypt: a batch that decrypts to garbage is
          // still unusable history.
          const messages = decodeJson<unknown[]>(chunk.payloadBase64);
          totalMessagesSeen += Array.isArray(messages) ? messages.length : 0;
          batchesDecrypted += 1;
        } catch {
          failures.push(id);
        }
      }
    }
  } finally {
    await endBackupSession();
  }

  if (failures.length > 0) {
    return { ok: false, batchesDecrypted, failures };
  }

  const ackBase = {
    version: 1 as const,
    verifierDeviceId: await getCurrentDeviceId(),
    verifiedAt: Date.now(),
    batchesDecrypted,
    totalMessagesSeen,
    attestationCreatedAt: attestation.createdAt,
  };
  const ack: RestoreVerified = {
    ...ackBase,
    signature: await signWithIdentity(ackPayload(ackBase)),
  };

  await beginBackupSession(passphrase);
  try {
    await backupChunk(
      RECORD_TYPE.manifest,
      `${VERIFIED_RECORD_ID_PREFIX}${ack.verifierDeviceId}`,
      encodeJson(ack),
      {},
    );
  } finally {
    await endBackupSession();
  }

  return { ok: true, batchesDecrypted, failures: [] };
};

/** The typed phrase §3.7 point 5 requires for the unsafe escape hatch. */
export const FORCE_RETIRE_PHRASE = 'DELETE MY CHAT HISTORY';
