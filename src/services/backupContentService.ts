/**
 * What goes into a backup (doc 31 §3.2, product-owner request 2026-07-25).
 *
 * WHY THIS IS A SHORT LIST, AND WHY THAT IS THE POINT. The request was to let
 * the user choose from "chat messages / chat media / settings / expenses /
 * profile pics / wallpapers / and more of whatever we can back up". Most of
 * that is already safe without a backup and offering it would be a lie
 * dressed as a feature:
 *
 *   - Expenses, groups, balances, settlements and recurring bills live in
 *     Firestore. They come back automatically on sign-in, on any device, with
 *     or without iCloud.
 *   - Profile pictures and display names live in Firestore/Storage, same.
 *   - Synced settings (§3.8) are already mirrored to `users/{uid}/settings`.
 *
 * Copying those into iCloud would consume the user's personal quota to
 * duplicate data that is not at risk, and — worse — a restore could resurrect
 * a stale copy over the authoritative server one. So this file offers only
 * what genuinely exists ONLY on this device, and the UI says plainly why the
 * rest isn't listed rather than leaving the user to wonder.
 *
 * Chat media is the one deliberate judgement call: it has a Firebase Storage
 * copy, so it is not strictly local-only, but that copy can be pruned and
 * needs the network to re-fetch. It is offered, and defaults OFF, because it
 * is the only category that can plausibly run into hundreds of megabytes.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export type BackupCategory = 'messages' | 'media' | 'callHistory' | 'wallpapers' | 'localSettings';

export interface BackupCategoryInfo {
  key: BackupCategory;
  label: string;
  description: string;
  /** False for categories that can be large enough to matter for quota. */
  defaultEnabled: boolean;
}

export const BACKUP_CATEGORIES: BackupCategoryInfo[] = [
  {
    key: 'messages',
    label: 'Chat messages',
    description: 'Your conversations. These exist only on this device.',
    defaultEnabled: true,
  },
  {
    key: 'media',
    label: 'Photos & videos',
    description: 'Media you sent and received. This is by far the largest part of a backup.',
    defaultEnabled: false,
  },
  {
    key: 'callHistory',
    label: 'Call history',
    description: 'Your call log. Stored only on this device.',
    defaultEnabled: true,
  },
  {
    key: 'wallpapers',
    label: 'Wallpapers & backgrounds',
    description: 'Your app, chat and group backdrops.',
    defaultEnabled: true,
  },
  {
    key: 'localSettings',
    label: 'App settings',
    description: 'Preferences that are set per device rather than synced to your account.',
    defaultEnabled: true,
  },
];

export type BackupSelection = Record<BackupCategory, boolean>;

export const DEFAULT_SELECTION: BackupSelection = BACKUP_CATEGORIES.reduce(
  (acc, category) => ({ ...acc, [category.key]: category.defaultEnabled }),
  {} as BackupSelection,
);

const SELECTION_KEY = 'splitcircle.backup.contents';

export const getBackupSelection = async (): Promise<BackupSelection> => {
  try {
    const raw = await AsyncStorage.getItem(SELECTION_KEY);
    if (!raw) return { ...DEFAULT_SELECTION };
    // Merged over the defaults so a category added in a later version is
    // enabled per its own default rather than arriving as `undefined` and
    // silently reading as "off".
    return { ...DEFAULT_SELECTION, ...(JSON.parse(raw) as Partial<BackupSelection>) };
  } catch {
    return { ...DEFAULT_SELECTION };
  }
};

export const setBackupSelection = async (selection: BackupSelection): Promise<void> => {
  await AsyncStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
};
