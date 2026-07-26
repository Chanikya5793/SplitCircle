/**
 * Per-device preferences (doc 31 §3.8, Phase 8).
 *
 * These two keys were declared in `settingsSyncRegistry.ts` from Phase 0 and
 * then referenced by NOTHING — the registry described a model no code
 * consulted. This is the layer that actually reads them.
 *
 * Both are `local` scope, and that is the point rather than an implementation
 * shortcut: "should THIS phone ring?" and "is Privacy Guard active HERE?" are
 * questions whose right answer differs per device by definition. Syncing them
 * would mean turning off the ringer on a bedside iPad also silences the phone
 * in your pocket.
 */

import {
  SETTINGS_SYNC_KEYS,
  isSettingUserOverridable,
} from '@/config/settingsSyncRegistry';
import { getSetting, setSetting } from '@/services/settingsSyncService';

/**
 * Whether this device rings for incoming calls (decision #13).
 *
 * Defaults to true: a device that silently stops ringing is a missed call the
 * user never learns about, so the failure mode of the default has to be noise
 * rather than silence.
 */
export const getRingOnThisDevice = async (userId: string): Promise<boolean> =>
  getSetting<boolean>(userId, SETTINGS_SYNC_KEYS.ringOnThisDevice, true);

export const setRingOnThisDevice = async (userId: string, value: boolean): Promise<void> =>
  setSetting<boolean>(userId, SETTINGS_SYNC_KEYS.ringOnThisDevice, value);

/**
 * Whether Privacy Guard state follows this account across devices
 * (decision #12).
 *
 * Off by default. Privacy Guard's whole purpose is that a specific device in a
 * specific situation shows a disguised view; propagating "shielded" to every
 * device would both defeat that and, in the duress scenario the feature exists
 * for, potentially signal to an observer that something was triggered
 * elsewhere. `userOverridable` in the registry is what allows a user to opt
 * into syncing anyway — checked here rather than assumed.
 */
export const getPrivacyGuardSyncEnabled = async (userId: string): Promise<boolean> => {
  if (!isSettingUserOverridable(SETTINGS_SYNC_KEYS.privacyGuardSyncState)) return false;
  return getSetting<boolean>(userId, SETTINGS_SYNC_KEYS.privacyGuardSyncState, false);
};

export const setPrivacyGuardSyncEnabled = async (
  userId: string,
  value: boolean,
): Promise<void> =>
  setSetting<boolean>(userId, SETTINGS_SYNC_KEYS.privacyGuardSyncState, value);
