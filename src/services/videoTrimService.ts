// Wraps `react-native-video-trim`'s editor so callers can `await` a trim
// operation and get back either the new local URI or `null` if the user
// cancelled. The native module is event-driven (showEditor is fire-and-
// forget; results arrive via DeviceEventEmitter), so this file owns the
// listener bookkeeping and exposes a single Promise-based entry point.

import { useCallback, useEffect, useRef } from 'react';
import { DeviceEventEmitter, type EmitterSubscription } from 'react-native';
import { showEditor, closeEditor, deleteFile } from 'react-native-video-trim';

export interface TrimSuccess {
  outputPath: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface TrimAttemptOptions {
  /** Hard upper bound for the resulting clip in ms (e.g. derived from the
   *  upload cap and the user's chosen quality bitrate). The editor enforces
   *  this with its own `maxDuration` so the user can't drag past it. */
  maxDurationMs?: number;
  /** Optional helper text shown in the editor's header. */
  headerText?: string;
}

interface OngoingTrim {
  resolve: (result: TrimSuccess | null) => void;
  reject: (error: Error) => void;
  subs: EmitterSubscription[];
}

let ongoing: OngoingTrim | null = null;

const cleanup = () => {
  if (!ongoing) return;
  for (const sub of ongoing.subs) {
    try { sub.remove(); } catch { /* noop */ }
  }
  ongoing = null;
};

/**
 * Open the native trim editor for a local video URI. Resolves with the new
 * URI + range when the user confirms a trim, or with `null` if they cancel.
 * Rejects on a hard error (file not loadable, native error). Only one trim
 * can be in flight at a time — concurrent calls reject immediately.
 */
export const trimVideoInteractive = (
  uri: string,
  options: TrimAttemptOptions = {},
): Promise<TrimSuccess | null> => {
  if (ongoing) {
    return Promise.reject(new Error('Another trim operation is already in progress.'));
  }

  return new Promise<TrimSuccess | null>((resolve, reject) => {
    // Subscribe before invoking `showEditor` — events can fire before the
    // promise constructor returns on fast paths.
    const subs: EmitterSubscription[] = [];

    const finish = (result: TrimSuccess | null) => {
      cleanup();
      resolve(result);
    };

    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };

    subs.push(
      DeviceEventEmitter.addListener('VideoTrim', (event: any) => {
        if (!event || typeof event !== 'object') return;
        switch (event.name) {
          case 'onFinishTrimming':
            finish({
              outputPath: event.outputPath,
              startMs: event.startTime ?? 0,
              endMs: event.endTime ?? 0,
              durationMs: event.duration ?? 0,
            });
            break;
          case 'onCancel':
          case 'onCancelTrimming':
            finish(null);
            break;
          case 'onError':
            fail(new Error(event.message || 'Trim failed'));
            break;
          default:
            break;
        }
      }),
    );

    ongoing = { resolve: finish, reject: fail, subs };

    showEditor(uri, {
      saveToPhoto: false,
      removeAfterSavedToPhoto: false,
      removeAfterFailedToSavePhoto: false,
      enablePreciseTrimming: true,
      autoplay: false,
      closeWhenFinish: true,
      enableCancelDialog: false,
      enableSaveDialog: false,
      headerText: options.headerText ?? 'Trim video',
      maxDuration: options.maxDurationMs ?? -1,
      minDuration: 1000,
      fullScreenModalIOS: true,
      saveButtonText: 'Use trimmed clip',
      cancelButtonText: 'Cancel',
    });
  });
};

/** Force-close any open editor — called on screen unmount/dispose. */
export const cancelTrim = (): void => {
  if (!ongoing) return;
  try { closeEditor(); } catch { /* noop */ }
  ongoing.resolve(null);
  cleanup();
};

/** Best-effort cleanup of a trimmed file once we no longer need it (e.g. the
 *  user re-trimmed and we have a newer output). Errors are swallowed because
 *  it's purely housekeeping. */
export const deleteTrimOutput = async (path: string): Promise<void> => {
  try { await deleteFile(path); } catch { /* noop */ }
};

/**
 * React hook variant — auto-cancels any in-flight trim if the host component
 * unmounts. Use this from screens / modals so we don't leave the editor
 * dangling on navigation.
 */
export const useInteractiveVideoTrim = () => {
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
    cancelTrim();
  }, []);

  return useCallback(async (uri: string, options?: TrimAttemptOptions) => {
    const result = await trimVideoInteractive(uri, options);
    if (!mountedRef.current) {
      // Component is gone — drop the output to avoid leaking files.
      if (result?.outputPath) void deleteTrimOutput(result.outputPath);
      return null;
    }
    return result;
  }, []);
};
