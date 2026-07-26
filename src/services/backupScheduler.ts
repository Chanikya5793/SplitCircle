/**
 * Automatic backup scheduling (doc 31 §3.6, Phase 5).
 *
 * Uses `expo-background-task`, which wraps `BGProcessingTaskRequest` and runs a
 * registered JS task when iOS decides to. Registering the task in module scope
 * is required — the OS may launch the app headlessly straight into the handler,
 * and a task defined later inside a component would not exist yet. This mirrors
 * the pattern `backgroundNotificationTask` already uses for silent pushes.
 *
 * WHAT THIS CANNOT PROMISE: iOS alone decides when a processing task actually
 * runs, and it may never run on a device that is rarely charged or is under
 * Low Power Mode. §3.6's copy is deliberately honest about that, and this file
 * must not be "improved" into predicting a next-run time.
 */

import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { auth } from '@/firebase';
import { runBackupNow } from '@/services/backupRunner';
import {
  FREQUENCY_INTERVAL_MS,
  getBackupFrequency,
  type BackupFrequency,
} from '@/services/backupSettingsService';

export const BACKUP_TASK_NAME = 'com.splitcircle.app.backup.scheduled';

TaskManager.defineTask(BACKUP_TASK_NAME, async () => {
  try {
    const userId = auth.currentUser?.uid;
    if (!userId) return BackgroundTask.BackgroundTaskResult.Success;

    const frequency = await getBackupFrequency(userId);
    if (frequency === 'off') return BackgroundTask.BackgroundTaskResult.Success;

    // runBackupNow enforces every precondition itself — passphrase, iCloud
    // reachability, main-device-only, AND the cellular preference. That is why
    // those checks live in the runner rather than the UI: this headless path
    // gets them for free instead of re-deriving them and drifting.
    await runBackupNow(userId);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    // A blocked or failed run is NOT a task failure — reporting failure would
    // make iOS back off scheduling us. The stale-backup banner is what surfaces
    // a persistently failing backup to the user.
    return BackgroundTask.BackgroundTaskResult.Success;
  }
});

/**
 * Registers (or updates) the OS-level schedule.
 *
 * `minimumInterval` is a FLOOR, not a promise: iOS runs the task no more often
 * than this, and frequently much less. Called on app start and whenever the
 * frequency setting changes.
 */
export const syncBackupSchedule = async (frequency: BackupFrequency): Promise<void> => {
  try {
    const registered = await TaskManager.isTaskRegisteredAsync(BACKUP_TASK_NAME);

    if (frequency === 'off') {
      if (registered) await BackgroundTask.unregisterTaskAsync(BACKUP_TASK_NAME);
      return;
    }

    // Re-registering with a new interval is the supported way to change it;
    // there is no separate "update" call.
    if (registered) await BackgroundTask.unregisterTaskAsync(BACKUP_TASK_NAME);

    await BackgroundTask.registerTaskAsync(BACKUP_TASK_NAME, {
      // Expo takes minutes.
      minimumInterval: FREQUENCY_INTERVAL_MS[frequency] / 60000,
    });
  } catch (error) {
    // Never let scheduling failure break app start — the manual "Back up now"
    // path still works, and the stale banner still warns.
    console.warn('Could not update backup schedule', error);
  }
};

/** Whether the OS-level task is currently registered — shown in the UI so the
 * automatic-backup claim is based on real state rather than the stored setting
 * alone. */
export const isBackupScheduled = async (): Promise<boolean> => {
  try {
    return await TaskManager.isTaskRegisteredAsync(BACKUP_TASK_NAME);
  } catch {
    return false;
  }
};
