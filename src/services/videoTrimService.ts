// Wraps `react-native-video-trim`'s editor so callers can `await` a trim
// operation and get back either the new local URI or `null` if the user
// cancelled. The native module is event-driven (showEditor is fire-and-forget;
// results arrive asynchronously), so this file owns the listener bookkeeping
// and exposes a single Promise-based entry point.
//
// The event CHANNEL differs by architecture — see `subscribeToTrimEvents`.
// Getting that wrong does not fail loudly; it silently discards every edit the
// user made. Do not "simplify" it back to a single DeviceEventEmitter call.

import { useCallback, useEffect, useRef } from 'react';
import { DeviceEventEmitter } from 'react-native';
import VideoTrimModule, { showEditor, closeEditor, deleteFile } from 'react-native-video-trim';

/** Anything with a `remove()` — covers both event channels below. */
interface Removable {
  remove: () => void;
}

/**
 * Subscribe to the trim editor's events on whichever channel this build
 * actually uses.
 *
 * THIS WAS THE BUG. Under the New Architecture the library exposes its events
 * as TurboModule codegen emitters ON THE MODULE (`onFinishTrimming(cb)`);
 * `DeviceEventEmitter` is the OLD architecture's channel and receives nothing.
 * This app runs New Arch, so the listener never fired — while `showEditor`
 * itself is a plain method call and worked fine. The editor therefore opened,
 * trimmed, rotated, flipped and exported correctly, and then:
 *
 *   - the promise never settled, so the caller awaited forever and never
 *     swapped in the trimmed file — the ORIGINAL video got sent, with every
 *     edit silently discarded; and
 *   - `ongoing` was never cleared, so every later trim rejected with
 *     "Another trim operation is already in progress".
 *
 * One missed channel, both symptoms. Falls back to `DeviceEventEmitter` so the
 * old architecture (and any build where codegen emitters are absent) keeps
 * working.
 */
const subscribeToTrimEvents = (handlers: {
  onFinish: (event: any) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}): Removable[] => {
  const emitterModule = VideoTrimModule as unknown as Record<string, unknown>;
  const hasCodegenEvents = typeof emitterModule?.onFinishTrimming === 'function';

  if (hasCodegenEvents) {
    const bind = (name: string, fn: (payload: any) => void): Removable | null => {
      const subscribe = emitterModule[name];
      if (typeof subscribe !== 'function') return null;
      return (subscribe as (cb: (payload: any) => void) => Removable)(fn);
    };
    return [
      bind('onFinishTrimming', (event) => handlers.onFinish(event ?? {})),
      bind('onCancelTrimming', () => handlers.onCancel()),
      bind('onCancel', () => handlers.onCancel()),
      bind('onError', (event) => handlers.onError(event?.message || 'Trim failed')),
    ].filter((sub): sub is Removable => sub !== null);
  }

  return [
    DeviceEventEmitter.addListener('VideoTrim', (event: any) => {
      if (!event || typeof event !== 'object') return;
      switch (event.name) {
        case 'onFinishTrimming':
          handlers.onFinish(event);
          break;
        case 'onCancel':
        case 'onCancelTrimming':
          handlers.onCancel();
          break;
        case 'onError':
          handlers.onError(event.message || 'Trim failed');
          break;
        default:
          break;
      }
    }),
  ];
};

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
  subs: Removable[];
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
    // Reclaim the slot rather than locking the user out of trimming forever.
    //
    // This guard used to hard-reject, which turned any single dropped
    // completion event into a permanent "Another trim operation is already in
    // progress" for the rest of the app's life — with no way back short of
    // killing it. Only one editor can be on screen at a time, so if we are
    // here the previous one is already gone; settle it as cancelled, tear its
    // listeners down, and continue.
    console.warn('Reclaiming a stale trim slot — previous editor never reported completion.');
    try {
      closeEditor();
    } catch {
      /* editor may already be gone */
    }
    const stale = ongoing;
    ongoing = null;
    stale.resolve(null);
  }

  return new Promise<TrimSuccess | null>((resolve, reject) => {
    // Subscribe before invoking `showEditor` — events can fire before the
    // promise constructor returns on fast paths.
    const subs: Removable[] = [];

    const finish = (result: TrimSuccess | null) => {
      cleanup();
      resolve(result);
    };

    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };

    subs.push(
      ...subscribeToTrimEvents({
        onFinish: (event) =>
          finish({
            outputPath: event.outputPath,
            startMs: event.startTime ?? 0,
            endMs: event.endTime ?? 0,
            durationMs: event.duration ?? 0,
          }),
        onCancel: () => finish(null),
        onError: (message) => fail(new Error(message)),
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
