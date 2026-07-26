/**
 * Drives the per-device background work that Phases 3 and 6 built but never
 * connected to anything (doc 31 §5e).
 *
 * Three jobs, all of which were dead code before this file existed:
 *
 * 1. HISTORY HANDOFF, SEND SIDE. `sendHistoryHandoff` had no caller, so a
 *    newly paired companion got zero history instead of the bounded 90-day
 *    window Phase 6 exists to deliver. It cannot simply be called at the
 *    moment of confirmation: the target can only publish Signal keys AFTER it
 *    is confirmed (`publishSignalPrekeys` rejects unconfirmed devices), so at
 *    confirmation time there is nothing to encrypt the bundle key to. This
 *    polls instead, and sends as soon as the target has published.
 *
 * 2. HISTORY HANDOFF, RECEIVE SIDE. Symmetrically, a newly confirmed device
 *    has to wait for the main device to write the bundle. Both sides retry on
 *    a bounded schedule rather than once, because either device may be
 *    backgrounded or offline when the other is ready.
 *
 * 3. PREKEY REPLENISHMENT. `replenishPrekeysIfLow` also had no caller. Every
 *    session another device starts with us consumes one of our 100 one-time
 *    prekeys permanently; with nothing replenishing them, a device silently
 *    degrades to signed-prekey-only once they run out and never recovers. That
 *    is a quiet downgrade of exactly the forward secrecy those keys exist for,
 *    invisible from the UI.
 *
 * Progress is persisted so an interrupted app doesn't redo completed work, and
 * so the send side doesn't re-send a handoff every launch.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/firebase';
import { receiveHistoryHandoff, sendHistoryHandoff } from '@/services/historyHandoffService';
import {
  getCachedSignalDeviceId,
  listSignalDevices,
  replenishPrekeysIfLow,
} from '@/services/signalCryptoService';
import { getCurrentDeviceId, subscribeToPairedDevices } from '@/services/pairingService';

const HANDOFF_SENT_KEY = 'splitcircle.handoff.sentTo';
const HANDOFF_RECEIVED_KEY = 'splitcircle.handoff.received';

const readSentSet = async (): Promise<Set<string>> => {
  try {
    const raw = await AsyncStorage.getItem(HANDOFF_SENT_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
};

const markSent = async (deviceId: string): Promise<void> => {
  const set = await readSentSet();
  set.add(deviceId);
  await AsyncStorage.setItem(HANDOFF_SENT_KEY, JSON.stringify([...set]));
};

/** One-shot per device, since the receiving side imports into local storage. */
const hasReceived = async (): Promise<boolean> =>
  (await AsyncStorage.getItem(HANDOFF_RECEIVED_KEY)) === 'true';

const markReceived = async (): Promise<void> => {
  await AsyncStorage.setItem(HANDOFF_RECEIVED_KEY, 'true');
};

/** Snapshot of this account's devices, read once per pass. */
const readOwnDevices = (
  userId: string,
): Promise<{ deviceId: string; isMainDevice: boolean; pairingStatus: string }[]> =>
  new Promise((resolve) => {
    let settled = false;
    const unsubscribe = subscribeToPairedDevices(
      userId,
      (devices) => {
        if (settled) return;
        settled = true;
        resolve(
          devices.map((device) => ({
            deviceId: device.deviceId,
            isMainDevice: device.isMainDevice === true,
            pairingStatus: String(device.pairingStatus ?? ''),
          })),
        );
        unsubscribe();
      },
      () => {
        if (settled) return;
        settled = true;
        resolve([]);
        unsubscribe();
      },
    );
  });

/**
 * MAIN DEVICE: hands the history window to any confirmed device that has
 * published keys and hasn't been served yet.
 */
const runSendSide = async (userId: string, ownDeviceId: string, devices: Awaited<ReturnType<typeof readOwnDevices>>) => {
  const own = devices.find((device) => device.deviceId === ownDeviceId);
  if (!own?.isMainDevice) return;

  const sent = await readSentSet();
  const targets = devices.filter(
    (device) =>
      device.deviceId !== ownDeviceId &&
      device.pairingStatus === 'confirmed' &&
      !sent.has(device.deviceId),
  );
  if (targets.length === 0) return;

  // Only devices that have actually published are addressable; the rest are
  // simply not ready yet and get picked up on a later pass.
  const published = new Set((await listSignalDevices(userId)).map((device) => device.deviceId));

  for (const target of targets) {
    if (!published.has(target.deviceId)) continue;
    try {
      const result = await sendHistoryHandoff(userId, target.deviceId);
      // null means "nothing to send" (no history in the window, or the target
      // vanished) — a normal outcome, and marking it done stops us retrying it
      // on every foreground forever.
      await markSent(target.deviceId);
      if (result) {
        console.log(
          `History handoff sent to ${target.deviceId}: ${result.totalMessages} messages`,
        );
      }
    } catch (error) {
      // Left unmarked so the next pass retries.
      console.warn('History handoff send failed', error);
    }
  }
};

/** NEW DEVICE: imports the bundle once the main device has written it. */
const runReceiveSide = async (ownDeviceId: string, devices: Awaited<ReturnType<typeof readOwnDevices>>) => {
  const own = devices.find((device) => device.deviceId === ownDeviceId);
  if (!own || own.isMainDevice || own.pairingStatus !== 'confirmed') return;
  if (await hasReceived()) return;

  try {
    const result = await receiveHistoryHandoff();
    if (!result) return; // Bundle not written yet — retry next pass.
    // `incomplete` means the run was interrupted part-way. Deliberately NOT
    // marked done: the checkpoint lets the next pass resume at the next chunk
    // rather than restart, and claiming success on a partial window is the
    // failure mode §5 Phase 6 explicitly forbids.
    if (!result.incomplete) {
      await markReceived();
    }
  } catch (error) {
    console.warn('History handoff receive failed', error);
  }
};

/**
 * Tops up one-time prekeys when they run low.
 *
 * Reads the count from the SERVER's copy, not a local guess: peers consume
 * these by claiming them, so this device has no way to know locally how many
 * are left.
 */
const runPrekeyReplenishment = async (userId: string, ownDeviceId: string) => {
  if (getCachedSignalDeviceId() === null) return;
  try {
    const snap = await getDoc(doc(db, 'users', userId, 'signalPrekeys', ownDeviceId));
    if (!snap.exists()) return;
    const oneTime = snap.data()?.oneTimePreKeys;
    await replenishPrekeysIfLow(userId, Array.isArray(oneTime) ? oneTime.length : 0);
  } catch (error) {
    console.warn('Prekey replenishment check failed', error);
  }
};

let running = false;

/**
 * One pass of all three jobs. Safe to call often (app foreground, after device
 * registration) — every job self-checks and no-ops when there is nothing to do.
 */
export const runDeviceSyncPass = async (userId: string): Promise<void> => {
  if (running) return;
  running = true;
  try {
    const ownDeviceId = await getCurrentDeviceId();
    const devices = await readOwnDevices(userId);
    if (devices.length === 0) return;

    await runSendSide(userId, ownDeviceId, devices);
    await runReceiveSide(ownDeviceId, devices);
    await runPrekeyReplenishment(userId, ownDeviceId);
  } catch (error) {
    console.warn('Device sync pass failed', error);
  } finally {
    running = false;
  }
};

/**
 * Clears handoff bookkeeping. Called when this device's identity is wiped
 * (revocation, recovery) so a device that re-pairs later is served a fresh
 * handoff instead of being skipped because of a previous life's record.
 */
export const resetHandoffState = async (): Promise<void> => {
  await AsyncStorage.multiRemove([HANDOFF_SENT_KEY, HANDOFF_RECEIVED_KEY]);
};
