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
import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import {
  bootstrapSignalIdentity,
  encryptForDevice,
  decryptFromDevice,
  establishSession,
  generatePublishableBundle,
  hasSession,
  hasSignalIdentity,
  isCryptoAvailable,
  wipeSignalState,
  type PeerBundle,
  type SignalEnvelope,
} from '../../modules/splitcircle-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
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

const INSTALL_MARKER_KEY = 'splitcircle.signal.installMarker';

/**
 * Throws away a Signal identity that outlived the sessions built on it.
 *
 * THE REINSTALL DEADLOCK THIS FIXES. On iOS, deleting an app clears its files
 * and AsyncStorage but NOT its Keychain. Our identity keypair lives in the
 * Keychain (SignalStorage.swift) while the session store is file-backed in
 * Application Support — so a reinstall brings back the same identity with no
 * sessions, and `getOrCreateInstallationId` (SecureStore) even restores the
 * same deviceId.
 *
 * Nothing could recover from that state. The reinstalled device saw its
 * published bundle's identityKey still matching its own, so it skipped
 * republishing; peers saw a live session, so they never rebuilt one. Every
 * message they sent was encrypted to a session that no longer existed on the
 * receiving side, decrypted to nothing, and rendered as a BLANK bubble —
 * permanently, with no path back. That is the "messages appear blank" and
 * "completely unreliable" report.
 *
 * The marker is the discriminator: AsyncStorage is wiped by a reinstall, the
 * Keychain is not. Identity present + marker absent means the identity is
 * orphaned, so it is discarded and a fresh one published, which is what makes
 * peers notice and rebuild. Cheap to be wrong: the worst case is one extra
 * rekey.
 */
const discardIdentityOrphanedByReinstall = async (): Promise<void> => {
  try {
    if (await AsyncStorage.getItem(INSTALL_MARKER_KEY)) return;
    if (await hasSignalIdentity()) {
      console.warn('Signal identity outlived its sessions (reinstall) — regenerating');
      await wipeSignalState();
      cachedSignalDeviceId = null;
    }
    await AsyncStorage.setItem(INSTALL_MARKER_KEY, '1');
  } catch (error) {
    console.warn('Reinstall identity check failed', error);
  }
};

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

  await discardIdentityOrphanedByReinstall();

  // Publish FIRST with a provisional bootstrap, because the server is what
  // allocates the libsignal device id and the native side needs that id to
  // form its own ProtocolAddress. Bootstrapping with a placeholder and then
  // re-bootstrapping with the real id is safe: ensureIdentity() is idempotent
  // and never mints a second identity.
  const identity = await bootstrapSignalIdentity(userId, cachedSignalDeviceId ?? 1);

  // Reuse an existing healthy publication instead of rotating on every call.
  // This runs on EVERY notification-registration sync (app launch, foreground,
  // token refresh), and republishing each time regenerated 100 one-time
  // keypairs and rewrote the whole Firestore bundle — observed 7 republishes
  // for one device in ~20 minutes. Beyond the waste, every generated one-time
  // key is persisted locally forever (they're only dropped when consumed), so
  // unconditional rotation grows the on-device store without bound.
  //
  // The identityKey comparison matters: an app reinstall keeps the Keychain
  // identity but wipes the file-backed stores, so a published bundle whose
  // identity no longer matches ours is stale and MUST be replaced — otherwise
  // peers would keep encrypting to prekeys we can no longer use.
  try {
    const existing = await getDoc(doc(db, 'users', userId, 'signalPrekeys', deviceId));
    if (existing.exists()) {
      const data = existing.data();
      const remaining = Array.isArray(data?.oneTimePreKeys) ? data.oneTimePreKeys.length : 0;
      const publishedSignalDeviceId = Number(data?.signalDeviceId);
      const identityMatches = data?.identityKey === identity.identityKey;

      if (
        identityMatches &&
        remaining > REPLENISH_THRESHOLD &&
        Number.isFinite(publishedSignalDeviceId) &&
        publishedSignalDeviceId > 0
      ) {
        await bootstrapSignalIdentity(userId, publishedSignalDeviceId);
        cachedSignalDeviceId = publishedSignalDeviceId;
        return publishedSignalDeviceId;
      }
    }
  } catch {
    // Unreadable bundle (offline, rules) — fall through and publish. A
    // redundant publish is wasteful but correct; skipping one is not.
  }

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
/**
 * Short-lived cache of the per-user device list.
 *
 * This runs on EVERY message send, once per recipient, plus again for the
 * sender's own-device mirror — so a group chat did a Firestore collection read
 * per participant per message before a single byte was encrypted. That is a
 * real, visible send latency, and the data barely changes: devices are added
 * minutes apart at most.
 *
 * The TTL is deliberately short. A stale list means a brand-new device misses
 * messages until it expires, which is a correctness cost, so this trades only
 * a few seconds of staleness — not minutes — for the round trips.
 */
const DEVICE_LIST_TTL_MS = 20_000;
const deviceListCache = new Map<
  string,
  { at: number; devices: { deviceId: string; signalDeviceId: number; identityKey: string | null }[] }
>();

/** Drops the cache for one user — call when a device is known to have changed. */
export const invalidateSignalDeviceCache = (userId?: string): void => {
  if (userId) deviceListCache.delete(userId);
  else deviceListCache.clear();
};

export const listSignalDevices = async (
  userId: string,
): Promise<{ deviceId: string; signalDeviceId: number; identityKey: string | null }[]> => {
  const cached = deviceListCache.get(userId);
  if (cached && Date.now() - cached.at < DEVICE_LIST_TTL_MS) return cached.devices;

  const snap = await getDocs(collection(db, 'users', userId, 'signalPrekeys'));
  const devices = snap.docs
    .map((d) => ({
      deviceId: d.id,
      signalDeviceId: Number(d.data()?.signalDeviceId),
      // Carried so senders can tell "same device" from "same device id, new
      // keypair" without a second read per device on every message.
      identityKey: typeof d.data()?.identityKey === 'string' ? (d.data()?.identityKey as string) : null,
    }))
    .filter((d) => Number.isFinite(d.signalDeviceId) && d.signalDeviceId > 0);

  deviceListCache.set(userId, { at: Date.now(), devices });
  return devices;
};

/**
 * The published identity key for one device, or null if it hasn't published.
 * Read from `signalPrekeys` so a caller checks the SAME key peers see, rather
 * than trusting anything held locally (§3.7 attestation verification).
 */
export const getIdentityKeyForDevice = async (
  userId: string,
  deviceId: string,
): Promise<string | null> => {
  const snap = await getDoc(doc(db, 'users', userId, 'signalPrekeys', deviceId));
  const key = snap.exists() ? snap.data()?.identityKey : null;
  return typeof key === 'string' ? key : null;
};

/**
 * Ensures a session exists with one peer device, claiming a one-time prekey
 * and running the handshake only when there isn't one already.
 *
 * Returns false rather than throwing when the peer hasn't published keys yet —
 * a device that just paired may not have published, and that must not fail the
 * whole send to every other device.
 */
/**
 * Remembers which identity key each peer session was built against.
 *
 * Without this, `hasSession()` alone decides whether to reuse a session — and
 * a session can be alive on OUR side while the peer's is gone, which is not a
 * state the peer can signal to us. That is exactly what a reinstall produces,
 * and it deadlocks: we keep encrypting to a session the peer cannot open, and
 * because we never rebuild, it never recovers.
 */
const peerIdentityKey = (peerUserId: string, peerDeviceId: string) =>
  `splitcircle.signal.peerIdentity.${peerUserId}.${peerDeviceId}`;

export const ensureSessionWithDevice = async (
  peerUserId: string,
  peerSignalDeviceId: number,
  peerDeviceId: string,
  /** The peer's CURRENTLY published identity key, when the caller has it. */
  currentIdentityKey?: string | null,
): Promise<boolean> => {
  if (!isCryptoAvailable()) return false;

  const cacheKey = peerIdentityKey(peerUserId, peerDeviceId);
  let identityChanged = false;
  if (currentIdentityKey) {
    const known = await AsyncStorage.getItem(cacheKey);
    identityChanged = known !== null && known !== currentIdentityKey;
  }

  // Reuse only when the peer is still the same peer. A changed identity means
  // the device rebuilt itself (reinstall, restore, revoke-and-repair), so our
  // session is addressed to a keypair that no longer exists.
  if (!identityChanged && (await hasSession(peerUserId, peerSignalDeviceId))) return true;

  try {
    const { data } = await claimCallable({
      targetUserId: peerUserId,
      targetDeviceId: peerDeviceId,
    });
    // processPreKeyBundle archives any existing session and starts a new one,
    // so this is also the repair path, not just first contact.
    await establishSession(peerUserId, peerSignalDeviceId, data);
    if (currentIdentityKey) await AsyncStorage.setItem(cacheKey, currentIdentityKey);
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
  excludeDeviceId?: string,
): Promise<{ deviceId: string; signalDeviceId: number; envelope: SignalEnvelope }[]> => {
  if (!isCryptoAvailable()) return [];

  // `excludeDeviceId` exists for the sender's own fan-out: a device must never
  // try to build a Signal session with ITSELF. Both sides would be the same
  // identity in the same store, which is meaningless and would corrupt the
  // store's view of that address.
  const devices = (await listSignalDevices(peerUserId)).filter(
    (device) => device.deviceId !== excludeDeviceId,
  );
  const results: { deviceId: string; signalDeviceId: number; envelope: SignalEnvelope }[] = [];

  for (const device of devices) {
    const ready = await ensureSessionWithDevice(
      peerUserId,
      device.signalDeviceId,
      device.deviceId,
      device.identityKey,
    );
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
