/**
 * Client orchestration for per-device Signal sessions (doc 31 §3.3, Phase 3).
 *
 * Sits between the native crypto module (which owns all key material and never
 * exposes a private key) and Firestore (which carries only PUBLIC bundles and
 * ciphertext). Nothing here ever sees a secret.
 *
 * Session lifecycle, per §3.3's Sesame-style model: every paired device is its
 * own Signal endpoint with its own identity, so a message is encrypted N times
 * — once per recipient device, and once per OTHER device of the sender.
 */

import { app, db } from '@/firebase';
import { collection, getDocs } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import {
  bootstrapSignalIdentity,
  encryptForDevice,
  decryptFromDevice,
  establishSession,
  generatePublishableBundle,
  hasSession,
  isCryptoAvailable,
  type PeerBundle,
  type SignalEnvelope,
} from '../../modules/splitcircle-crypto';
import { getCurrentDeviceId } from '@/services/pairingService';

/**
 * How many one-time prekeys to publish per rotation. Each is consumed by one
 * incoming session, so this bounds how many peers can start a session with
 * strongest forward secrecy before we replenish. Signal's own clients use ~100.
 */
const ONE_TIME_PREKEY_COUNT = 100;

/** Below this many remaining, republish. */
const REPLENISH_THRESHOLD = 20;

interface PublishResponse {
  signalDeviceId: number;
}

interface ClaimedPeerBundle extends PeerBundle {
  deviceId: string;
  signalDeviceId: number;
  exhausted: boolean;
}

const functions = getFunctions(app);

const publishCallable = httpsCallable<
  { deviceId: string; bundle: unknown },
  PublishResponse
>(functions, 'publishSignalPrekeys');

const claimCallable = httpsCallable<
  { targetUserId: string; targetDeviceId: string },
  ClaimedPeerBundle
>(functions, 'claimSignalPreKey');

/** This device's libsignal small-integer id, cached after bootstrap. */
let cachedSignalDeviceId: number | null = null;

/**
 * Creates this device's Signal identity (if absent), publishes a fresh prekey
 * bundle, and caches the small-integer device id the server allocated.
 *
 * Safe and cheap to call on every sign-in: identity creation is idempotent
 * native-side, and republishing prekeys is the intended rotation mechanism.
 * Returns null when crypto isn't available (non-iOS / pod missing) so callers
 * can degrade explicitly rather than crash.
 */
export const initializeSignalForDevice = async (
  userId: string,
): Promise<number | null> => {
  if (!isCryptoAvailable()) return null;

  const deviceId = await getCurrentDeviceId();

  // Publish FIRST with a provisional bootstrap, because the server is what
  // allocates the libsignal device id and the native side needs that id to
  // form its own ProtocolAddress. Bootstrapping with a placeholder and then
  // re-bootstrapping with the real id is safe: ensureIdentity() is idempotent
  // and never mints a second identity.
  await bootstrapSignalIdentity(userId, 1);
  const bundle = await generatePublishableBundle(ONE_TIME_PREKEY_COUNT);
  const { data } = await publishCallable({ deviceId, bundle });

  // Re-bootstrap with the authoritative id so encrypt/decrypt use the same
  // local address peers will address us by.
  await bootstrapSignalIdentity(userId, data.signalDeviceId);
  cachedSignalDeviceId = data.signalDeviceId;
  return data.signalDeviceId;
};

export const getCachedSignalDeviceId = (): number | null => cachedSignalDeviceId;

/**
 * Every device of `userId` that has published encryption keys.
 *
 * Reads `signalPrekeys` directly rather than `pairedDevices`: only the former
 * is readable across users (public key material by design), and — critically —
 * its rule doesn't depend on document contents, so a LIST query is provable and
 * won't hit the Firestore query-provability wall that forced group joining
 * server-side (see CLAUDE.md).
 */
export const listSignalDevices = async (
  userId: string,
): Promise<{ deviceId: string; signalDeviceId: number }[]> => {
  const snap = await getDocs(collection(db, 'users', userId, 'signalPrekeys'));
  return snap.docs
    .map((d) => ({
      deviceId: d.id,
      signalDeviceId: Number(d.data()?.signalDeviceId),
    }))
    .filter((d) => Number.isFinite(d.signalDeviceId) && d.signalDeviceId > 0);
};

/**
 * Ensures a session exists with one peer device, claiming a one-time prekey
 * and running the handshake only when there isn't one already.
 *
 * Returns false rather than throwing when the peer hasn't published keys yet —
 * a device that just paired may not have published, and that must not fail the
 * whole send to every other device.
 */
export const ensureSessionWithDevice = async (
  peerUserId: string,
  peerSignalDeviceId: number,
  peerDeviceId: string,
): Promise<boolean> => {
  if (!isCryptoAvailable()) return false;
  if (await hasSession(peerUserId, peerSignalDeviceId)) return true;

  try {
    const { data } = await claimCallable({
      targetUserId: peerUserId,
      targetDeviceId: peerDeviceId,
    });
    await establishSession(peerUserId, peerSignalDeviceId, data);
    return true;
  } catch {
    return false;
  }
};

/**
 * Encrypts one plaintext for every device of `peerUserId`, skipping devices we
 * can't establish a session with.
 *
 * The caller decides what to do with a partial result — dropping a device
 * silently would mean that device never sees the message, so this reports
 * exactly which devices are covered.
 */
export const encryptForAllDevices = async (
  peerUserId: string,
  plaintextBase64: string,
): Promise<{ deviceId: string; signalDeviceId: number; envelope: SignalEnvelope }[]> => {
  if (!isCryptoAvailable()) return [];

  const devices = await listSignalDevices(peerUserId);
  const results: { deviceId: string; signalDeviceId: number; envelope: SignalEnvelope }[] = [];

  for (const device of devices) {
    const ready = await ensureSessionWithDevice(peerUserId, device.signalDeviceId, device.deviceId);
    if (!ready) continue;
    try {
      const envelope = await encryptForDevice(peerUserId, device.signalDeviceId, plaintextBase64);
      results.push({ deviceId: device.deviceId, signalDeviceId: device.signalDeviceId, envelope });
    } catch {
      // One device's ratchet failing must not block delivery to the others.
    }
  }

  return results;
};

/** Decrypts an envelope addressed to this device. Returns base64 plaintext. */
export const decryptEnvelope = async (
  senderUserId: string,
  senderSignalDeviceId: number,
  envelope: SignalEnvelope,
): Promise<string> => decryptFromDevice(senderUserId, senderSignalDeviceId, envelope);

/**
 * Republishes prekeys when the one-time supply runs low. Cheap no-op when
 * healthy, so it's safe to call opportunistically (e.g. on app foreground).
 */
export const replenishPrekeysIfLow = async (
  userId: string,
  remainingOneTimeKeys: number,
): Promise<void> => {
  if (!isCryptoAvailable()) return;
  if (remainingOneTimeKeys > REPLENISH_THRESHOLD) return;
  await initializeSignalForDevice(userId);
};
