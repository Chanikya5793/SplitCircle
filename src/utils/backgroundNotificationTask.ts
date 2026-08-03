/**
 * backgroundNotificationTask.ts — dismiss stale tray notifications while the
 * app is backgrounded or killed.
 *
 * The server sends a silent push (content-available on iOS, data-only on
 * Android) with a `{ type: 'revoke', ... }` payload when a group, expense,
 * or settlement is deleted. expo-notifications wakes this task with the raw
 * payload; we extract the deleted entity ids and withdraw every matching
 * tray notification — no UI, no alert, nothing visible for the revoke push
 * itself.
 *
 * IMPORTANT: `TaskManager.defineTask` must run in module scope (outside any
 * component) so the task exists when the OS launches the app headlessly.
 * This module is imported from the app entry point (index.ts).
 */

import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { dismissNotificationsForEntity } from './notifications';
import { extractRevokeFilters } from './notificationRevoke';
import { applyDecryptedPreview } from '@/services/notificationPreviewDisplay';

export const BACKGROUND_NOTIFICATION_TASK = 'background-notification-revoke';

/**
 * Applies every revoke filter found in a raw push payload. Exported so the
 * foreground path can reuse it. Best-effort: never throws.
 */
export const handleBackgroundNotificationPayload = async (
  payload: unknown,
): Promise<number> => {
  let dismissed = 0;
  try {
    const filters = extractRevokeFilters(payload);
    for (const filter of filters) {
      dismissed += await dismissNotificationsForEntity(filter);
    }
  } catch {
    // A malformed payload must never crash a headless launch.
  }

  // Message pushes now ship GENERIC copy plus a sealed preview the server
  // cannot read (doc 36 §3.2). Open it here and replace the notification with
  // the real one. Android only — see `applyDecryptedPreview`.
  //
  // Separate try/catch from the revoke handling above: these are unrelated
  // jobs, and a failure in one must not skip the other.
  try {
    await applyDecryptedPreview(extractPushData(payload));
  } catch {
    // Never throw from a headless launch. The generic notification stands.
  }
  return dismissed;
};

/**
 * Digs the `data` payload out of whatever shape the OS handed the task.
 *
 * expo-notifications delivers different envelopes per platform and per launch
 * route (cold headless launch vs backgrounded app), so this checks the known
 * nestings rather than assuming one. A wrong guess here is silent: the preview
 * simply never opens and every notification stays generic, which is exactly the
 * kind of failure that looks like "the feature doesn't work" with nothing in
 * the logs.
 */
export const extractPushData = (payload: unknown): unknown => {
  if (!payload || typeof payload !== 'object') return payload;
  const value = payload as Record<string, unknown>;

  // Android headless task: { notification: { data: {...} } }
  const notification = value.notification as Record<string, unknown> | undefined;
  if (notification?.data) return notification.data;

  // iOS / already-unwrapped: { data: {...} }
  if (value.data) return value.data;

  // Some routes hand the data object directly.
  return value;
};

if (Platform.OS !== 'web') {
  TaskManager.defineTask(
    BACKGROUND_NOTIFICATION_TASK,
    async ({ data, error }: { data: unknown; error: TaskManager.TaskManagerError | null }) => {
      if (error) {
        return;
      }
      await handleBackgroundNotificationPayload(data);
    },
  );
}

/**
 * Registers the background notification task with the OS. Safe to call more
 * than once; a failure is logged and swallowed — background revoke is an
 * enhancement, the foreground snapshot diff still cleans up on next launch.
 */
export const registerBackgroundNotificationTask = async (): Promise<void> => {
  if (Platform.OS === 'web') {
    return;
  }

  try {
    const alreadyRegistered = await TaskManager.isTaskRegisteredAsync(
      BACKGROUND_NOTIFICATION_TASK,
    );
    if (!alreadyRegistered) {
      await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
    }
  } catch (error) {
    console.warn('Failed to register background notification task:', error);
  }
};
