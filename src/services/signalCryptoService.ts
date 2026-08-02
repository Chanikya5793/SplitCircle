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
import {
  normalizeSignalDeviceDirectory,
  resolveSignalDeviceDirectory,
  type SignalDeviceDirectoryEntry,
} from '@/services/signalDeviceDirectory';

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
const SIGNAL_DEVICE_ID_KEY = 'splitcircle.signal.deviceId';

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
      // console.error, not warn: a Release bundle drops console.warn entirely
      // (CLAUDE.md), and this function exists specifically to repair a prior
      // "messages appear blank, permanently" bug — if it fires, or fails, in
      // the field that has to leave a trace.
      console.error('Signal identity outlived its sessions (reinstall) — regenerating');
      await wipeSignalState();
      cachedSignalDeviceId = null;
      await AsyncStorage.removeItem(SIGNAL_DEVICE_ID_KEY);
    }
    await AsyncStorage.setItem(INSTALL_MARKER_KEY, '1');
  } catch (error) {
    console.error('Reinstall identity check failed', error);
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
        await AsyncStorage.setItem(SIGNAL_DEVICE_ID_KEY, String(publishedSignalDeviceId));
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
  await AsyncStorage.setItem(SIGNAL_DEVICE_ID_KEY, String(data.signalDeviceId));
  return data.signalDeviceId;
};

export const getCachedSignalDeviceId = (): number | null => cachedSignalDeviceId;

/** Restores the authoritative small Signal device id on a cold offline boot. */
export const getPersistedSignalDeviceId = async (): Promise<number | null> => {
  if (cachedSignalDeviceId) return cachedSignalDeviceId;
  try {
    const raw = await AsyncStorage.getItem(SIGNAL_DEVICE_ID_KEY);
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 127) {
      cachedSignalDeviceId = parsed;
      return parsed;
    }
  } catch {
    // Missing/corrupt local state means secure mesh cannot start yet.
  }
  return null;
};

/**
 * Manual "reset encryption" — the escape hatch when automatic repair hasn't.
 *
 * Throws away this device's Signal identity, every session, and all cached
 * peer state, then republishes a fresh bundle. Peers notice the changed
 * identity and rebuild on their next send.
 *
 * This exists because session breakage has repeatedly been UNRECOVERABLE from
 * the user's side: the failure looks like ordinary message trouble, and every
 * automatic repair so far has had a case it couldn't see. A button that
 * definitely works is worth more than another inference that might.
 *
 * COST, stated plainly to the caller: messages already sitting undelivered for
 * this device stay undecryptable — they are addressed to the identity being
 * discarded. It fixes the future, never the past.
 */
export const resetEncryptionIdentity = async (userId: string): Promise<void> => {
  await wipeSignalState();
  cachedSignalDeviceId = null;
  await AsyncStorage.removeItem(SIGNAL_DEVICE_ID_KEY);

  // Drop every cached peer identity and repair flag, so nothing carries a
  // belief about a session that no longer exists.
  try {
    const keys = await AsyncStorage.getAllKeys();
    const stale = keys.filter(
      (key) =>
        key.startsWith('splitcircle.signal.peerIdentity.') ||
        key.startsWith('splitcircle.signal.needsRebuild.'),
    );
    if (stale.length > 0) await AsyncStorage.multiRemove(stale);
  } catch {
    // Non-fatal: a stale cache entry now refers to an identity we no longer
    // hold, which the identity comparison treats as changed anyway.
  }

  await initializeSignalForDevice(userId);
};

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
  { at: number; devices: SignalDeviceDirectoryEntry[] }
>();
const durableDeviceListKey = (userId: string): string =>
  `splitcircle.signal.deviceList.${userId}`;
const DURABLE_DEVICE_LIST_PREFIX = 'splitcircle.signal.deviceList.';

const loadDurableSignalDevices = async (
  userId: string,
): Promise<SignalDeviceDirectoryEntry[]> => {
  try {
    const raw = await AsyncStorage.getItem(durableDeviceListKey(userId));
    return normalizeSignalDeviceDirectory(raw ? JSON.parse(raw) : null);
  } catch {
    return [];
  }
};

export type SignalNetworkPolicy = 'network-preferred' | 'cache-only';

/** Drops the cache for one user — call when a device is known to have changed. */
export const invalidateSignalDeviceCache = (userId?: string): void => {
  if (userId) deviceListCache.delete(userId);
  else deviceListCache.clear();
};

/** Forces a server refresh when Internet is known to be reachable. */
export const refreshSignalDeviceDirectory = async (
  userId: string,
): Promise<SignalDeviceDirectoryEntry[]> => {
  deviceListCache.delete(userId);
  return listSignalDevices(userId);
};

export const listSignalDevices = async (
  userId: string,
  networkPolicy: SignalNetworkPolicy = 'network-preferred',
): Promise<SignalDeviceDirectoryEntry[]> => {
  const cached = deviceListCache.get(userId);
  const durable = await loadDurableSignalDevices(userId);

  if (networkPolicy === 'cache-only') {
    // Nearby sends run precisely when Firebase may be unreachable. Never await
    // a Firestore read here: React Native's memory-only Firestore client can
    // leave getDocs pending until connectivity returns instead of rejecting.
    // Merge memory with the durable snapshot because an earlier empty/partial
    // cache result must not hide devices that were successfully saved online.
    const devices = resolveSignalDeviceDirectory({
      remote: cached?.devices ?? [],
      durable,
      remoteFromCache: true,
    });
    deviceListCache.set(userId, { at: Date.now(), devices });
    return devices;
  }

  if (cached && Date.now() - cached.at < DEVICE_LIST_TTL_MS) return cached.devices;

  try {
    const snap = await getDocs(collection(db, 'users', userId, 'signalPrekeys'));
    const remote = normalizeSignalDeviceDirectory(snap.docs
      .map((d) => ({
        deviceId: d.id,
        signalDeviceId: Number(d.data()?.signalDeviceId),
        // Carried so senders can tell "same device" from "same device id, new
        // keypair" without a second read per device on every message.
        identityKey: typeof d.data()?.identityKey === 'string' ? (d.data()?.identityKey as string) : null,
      })));
    const devices = resolveSignalDeviceDirectory({
      remote,
      durable,
      remoteFromCache: snap.metadata.fromCache,
    });

    deviceListCache.set(userId, { at: Date.now(), devices });
    if (!snap.metadata.fromCache) {
      // Only a server-backed result is authoritative enough to replace the
      // durable directory. This contains public keys only, never private data.
      void AsyncStorage.setItem(durableDeviceListKey(userId), JSON.stringify(devices));
    }
    return devices;
  } catch (error) {
    if (durable.length > 0) {
      deviceListCache.set(userId, { at: Date.now(), devices: durable });
      return durable;
    }
    throw error;
  }
};

/**
 * Commits the public identity learned through an explicit nearby pairing.
 *
 * The same installation UUID can remain in a former account's durable
 * directory after sign-out. A successful human code ceremony is a stronger,
 * newer binding than that stale cache, so this transaction removes the UUID
 * from every other cached owner before adding the verified peer. Private key
 * material never enters AsyncStorage.
 */
export const persistPairedSignalDevice = async ({
  userId,
  deviceId,
  signalDeviceId,
  identityKey,
}: {
  userId: string;
  deviceId: string;
  signalDeviceId: number;
  identityKey: string;
}): Promise<void> => {
  if (
    !userId
    || !deviceId
    || !Number.isFinite(signalDeviceId)
    || signalDeviceId <= 0
    || !identityKey
  ) {
    throw new Error('Invalid paired Signal device identity.');
  }

  const keys = (await AsyncStorage.getAllKeys())
    .filter((key) => key.startsWith(DURABLE_DEVICE_LIST_PREFIX));
  const targetKey = durableDeviceListKey(userId);
  if (!keys.includes(targetKey)) keys.push(targetKey);
  const rows = await AsyncStorage.multiGet(keys);
  const writes: [string, string][] = [];

  for (const [key, raw] of rows) {
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      // A corrupt public cache must not prevent an explicit re-pair. Rebuild
      // only that cache row from the verified device below.
    }
    const devices = normalizeSignalDeviceDirectory(parsed)
      .filter((device) => device.deviceId !== deviceId);
    if (key === targetKey) {
      devices.push({ deviceId, signalDeviceId, identityKey });
    }
    writes.push([key, JSON.stringify(devices)]);
  }

  await AsyncStorage.multiSet(writes);
  deviceListCache.clear();
};

/** Public identity key cached during an earlier online sync, for mesh checks. */
export const getCachedPeerIdentityKey = async (
  userId: string,
  deviceId: string,
): Promise<string | null> => {
  const inMemory = deviceListCache.get(userId)?.devices
    .find((device) => device.deviceId === deviceId)?.identityKey;
  if (inMemory) return inMemory;

  try {
    const raw = await AsyncStorage.getItem(durableDeviceListKey(userId));
    const devices = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(devices)) return null;
    const match = devices.find(
      (device) => device?.deviceId === deviceId && typeof device?.identityKey === 'string',
    );
    return match?.identityKey ?? null;
  } catch {
    return null;
  }
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

/**
 * Keyed by the libsignal SMALL-INT id, not the installation uuid.
 *
 * The decrypting side only ever learns `senderSignalDeviceId` — the string
 * installation id is not in a delivered payload for an ordinary recipient
 * message. Keying on the uuid meant the flag written on failure could never be
 * found by the sender path that has to act on it, so the repair silently did
 * nothing for exactly the messages it was built for. Both sides know the
 * small-int id, so both sides agree on this key.
 */
const repairFlagKey = (peerUserId: string, peerSignalDeviceId: number) =>
  `splitcircle.signal.needsRebuild.${peerUserId}.${peerSignalDeviceId}`;

/**
 * Marks a peer's session as broken so the next send rebuilds it.
 *
 * THE CASE THE IDENTITY COMPARISON ALONE CANNOT COVER. That check only fires
 * when a PREVIOUSLY CACHED identity differs from the published one — so for
 * any session established before the cache existed, `known` is null, no change
 * is detected, `hasSession()` reports true, and the dead session is reused
 * forever. Every session predating that fix is in exactly this state.
 *
 * A failed decrypt is the ground truth that no amount of comparing keys can
 * replace: it means the session is unusable RIGHT NOW, whatever the metadata
 * says. Recording it here makes the next outbound message rebuild from a fresh
 * prekey bundle, which also hands the peer a new PreKey message so their side
 * re-establishes too. One round trip and the pair is healed.
 */
export const markSessionForRebuild = async (
  peerUserId: string,
  peerSignalDeviceId: number,
): Promise<void> => {
  try {
    await AsyncStorage.setItem(repairFlagKey(peerUserId, peerSignalDeviceId), '1');
  } catch {
    // Best-effort; the identity comparison is still a second line of defence.
  }
};

export const ensureSessionWithDevice = async (
  peerUserId: string,
  peerSignalDeviceId: number,
  peerDeviceId: string,
  /** The peer's CURRENTLY published identity key, when the caller has it. */
  currentIdentityKey?: string | null,
  networkPolicy: SignalNetworkPolicy = 'network-preferred',
): Promise<boolean> => {
  if (!isCryptoAvailable()) return false;

  const cacheKey = peerIdentityKey(peerUserId, peerDeviceId);
  const flagKey = repairFlagKey(peerUserId, peerSignalDeviceId);

  // A decrypt against this peer has already failed, so the session is known
  // bad regardless of what the keys look like. Checked FIRST because it is
  // evidence, not inference.
  const needsRebuild = (await AsyncStorage.getItem(flagKey)) !== null;

  let identityChanged = false;
  if (currentIdentityKey) {
    const known = await AsyncStorage.getItem(cacheKey);
    identityChanged = known !== null && known !== currentIdentityKey;
    // Adopt on first sight so a LATER change is detectable. Without this, a
    // session that predates the cache never becomes comparable.
    if (known === null) await AsyncStorage.setItem(cacheKey, currentIdentityKey);
  }

  // Reuse only when the peer is still the same peer. A changed identity means
  // the device rebuilt itself (reinstall, restore, revoke-and-repair), so our
  // session is addressed to a keypair that no longer exists.
  if (!needsRebuild && !identityChanged && (await hasSession(peerUserId, peerSignalDeviceId))) {
    return true;
  }

  // Establishing or repairing a session claims a server-held prekey bundle.
  // Nearby delivery must finish (or fail visibly) without waiting for that
  // network operation, so it may reuse prepared sessions but never create one.
  if (networkPolicy === 'cache-only') return false;

  try {
    const { data } = await claimCallable({
      targetUserId: peerUserId,
      targetDeviceId: peerDeviceId,
    });
    // processPreKeyBundle archives any existing session and starts a new one,
    // so this is also the repair path, not just first contact.
    await establishSession(peerUserId, peerSignalDeviceId, data);
    if (currentIdentityKey) await AsyncStorage.setItem(cacheKey, currentIdentityKey);
    await AsyncStorage.removeItem(flagKey);
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
  networkPolicy: SignalNetworkPolicy = 'network-preferred',
): Promise<{ deviceId: string; signalDeviceId: number; envelope: SignalEnvelope }[]> => {
  if (!isCryptoAvailable()) return [];

  // `excludeDeviceId` exists for the sender's own fan-out: a device must never
  // try to build a Signal session with ITSELF. Both sides would be the same
  // identity in the same store, which is meaningless and would corrupt the
  // store's view of that address.
  const devices = (await listSignalDevices(peerUserId, networkPolicy)).filter(
    (device) => device.deviceId !== excludeDeviceId,
  );
  const results: { deviceId: string; signalDeviceId: number; envelope: SignalEnvelope }[] = [];

  for (const device of devices) {
    const ready = await ensureSessionWithDevice(
      peerUserId,
      device.signalDeviceId,
      device.deviceId,
      device.identityKey,
      networkPolicy,
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

/**
 * Builds every currently published Signal session while Internet is available.
 * Nearby messages can then encrypt exclusively from durable device metadata
 * and native session state, with no Firebase dependency at send time.
 */
export const prepareSignalSessionsForUser = async (
  peerUserId: string,
): Promise<{ ready: number; total: number }> => {
  if (!peerUserId || !isCryptoAvailable()) return { ready: 0, total: 0 };

  const devices = await listSignalDevices(peerUserId, 'network-preferred');
  let ready = 0;
  for (const device of devices) {
    if (await ensureSessionWithDevice(
      peerUserId,
      device.signalDeviceId,
      device.deviceId,
      device.identityKey,
      'network-preferred',
    )) {
      ready += 1;
    }
  }
  return { ready, total: devices.length };
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
