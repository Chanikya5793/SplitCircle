/**
 * Declares, per individual per-user setting, whether its value syncs across
 * a user's paired devices (Firestore `users/{uid}/settings/{key}`) or stays
 * local to whichever device set it (AsyncStorage only) — doc 31 §3.8.
 *
 * This is a DIFFERENT registry from `@/constants/settingsRegistry` (that one
 * is UI-search/deep-link metadata for the Settings screens; this one is
 * sync-scope metadata consumed by `settingsSyncService`). Don't conflate them
 * — a setting can appear in both, for unrelated reasons.
 *
 * Only a representative slice of settings is registered here for now
 * (doc 31 Phase 0 scope). Populating every existing per-user setting is
 * Phase 8's job — see doc 31 §5.
 */

export type SettingScope = 'synced' | 'local';

export interface SettingSyncDescriptor {
  key: string;
  scope: SettingScope;
  /**
   * Only meaningful when scope is 'local'. If true, the user may explicitly
   * opt this setting into syncing anyway — the call site is responsible for
   * showing the tradeoff explainer before flipping it (doc 31 §3.8's Privacy
   * Guard example: "every linked device shares the same duress passphrase
   * and decoy state").
   */
  userOverridable?: boolean;
}

export const SETTINGS_SYNC_KEYS = {
  /** Whether THIS device rings for incoming calls (#13) — local by definition. */
  ringOnThisDevice: 'ringOnThisDevice',
  /** Privacy Guard / duress-mode sync opt-in (#12) — local by default, overridable. */
  privacyGuardSyncState: 'privacyGuardSyncState',
  /** iCloud backup frequency (#16) — synced; only the main device acts on it. */
  backupFrequency: 'backupFrequency',
  /** Whether scheduled/manual backups may use cellular data (#16) — synced. */
  backupAllowCellular: 'backupAllowCellular',
} as const;

export type SettingsSyncKey = (typeof SETTINGS_SYNC_KEYS)[keyof typeof SETTINGS_SYNC_KEYS];

export const SETTINGS_SYNC_REGISTRY: Record<SettingsSyncKey, SettingSyncDescriptor> = {
  [SETTINGS_SYNC_KEYS.ringOnThisDevice]: {
    key: SETTINGS_SYNC_KEYS.ringOnThisDevice,
    scope: 'local',
  },
  [SETTINGS_SYNC_KEYS.privacyGuardSyncState]: {
    key: SETTINGS_SYNC_KEYS.privacyGuardSyncState,
    scope: 'local',
    userOverridable: true,
  },
  [SETTINGS_SYNC_KEYS.backupFrequency]: {
    key: SETTINGS_SYNC_KEYS.backupFrequency,
    scope: 'synced',
  },
  [SETTINGS_SYNC_KEYS.backupAllowCellular]: {
    key: SETTINGS_SYNC_KEYS.backupAllowCellular,
    scope: 'synced',
  },
};

export const getSettingScope = (key: SettingsSyncKey): SettingScope =>
  SETTINGS_SYNC_REGISTRY[key].scope;

export const isSettingUserOverridable = (key: SettingsSyncKey): boolean =>
  SETTINGS_SYNC_REGISTRY[key].userOverridable === true;
