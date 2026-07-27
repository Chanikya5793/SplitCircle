/**
 * Live per-message progress for the chat media send pipeline.
 *
 * Before this existed, everything the pipeline knew about its own work went to
 * a single aggregate banner (`MediaPipelineBanner`) and the message bubble knew
 * only `status: 'sending'` — an indeterminate spinner. Two things followed from
 * that, both reported as "nothing is happening":
 *
 *  1. Compression ran BEFORE `sendMessage`, so for the entire transcode of a
 *     long video there was no bubble in the thread at all. The user tapped
 *     Send and the chat looked unchanged.
 *  2. Upload progress was fabricated (10% → 90%), so even once a bubble
 *     existed it could not say how far along a 100MB upload was.
 *
 * A module-level store rather than context: the pipeline is driven from a hook
 * that lives above the message list, and the consumer is an individual bubble
 * deep inside a virtualized `FlatList`. Routing this through context would
 * re-render every bubble on every progress tick — at ~30 ticks/sec per item,
 * on a list that is already the most render-sensitive surface in the app. With
 * an external store, `useSyncExternalStore` re-renders exactly the one bubble
 * whose entry changed.
 *
 * Entries are keyed by `messageId`, which is the same value as the pipeline's
 * `requestId`, so a retry of a failed item addresses the same slot rather than
 * leaking a second one.
 */

export type SendStage =
  | 'queued'
  | 'compressing'
  | 'uploading'
  | 'sending'
  | 'failed';

export interface SendProgress {
  stage: SendStage;
  /** 0–1 within the current stage, or null when the stage is indeterminate. */
  fraction: number | null;
  /** Bytes sent so far — only meaningful during `uploading`. */
  bytesSent?: number;
  /** Total bytes for the upload — only meaningful during `uploading`. */
  bytesTotal?: number;
  /** Set when the user can abort this item. Cleared once past the point of no return. */
  cancel?: () => void;
}

type Listener = () => void;

const entries = new Map<string, SendProgress>();
const listeners = new Map<string, Set<Listener>>();
/** Listeners that want to know about ANY change (the aggregate banner). */
const globalListeners = new Set<Listener>();

const notify = (messageId: string): void => {
  listeners.get(messageId)?.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error('mediaSendProgress listener failed', error);
    }
  });
  globalListeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error('mediaSendProgress global listener failed', error);
    }
  });
};

/**
 * Merge a partial update into a message's progress entry.
 *
 * Merging rather than replacing so a progress tick that carries only
 * `fraction` does not drop the `cancel` handle registered when the stage
 * started — losing it would strand the user with an un-abortable upload.
 */
export const setSendProgress = (
  messageId: string,
  patch: Partial<SendProgress> & Pick<SendProgress, 'stage'>,
): void => {
  const previous = entries.get(messageId);
  entries.set(messageId, {
    fraction: null,
    ...previous,
    ...patch,
  });
  notify(messageId);
};

/** Update only the fraction, leaving stage and cancel handle intact. */
export const setSendFraction = (
  messageId: string,
  fraction: number | null,
  bytes?: { sent: number; total: number },
): void => {
  const previous = entries.get(messageId);
  if (!previous) return;
  entries.set(messageId, {
    ...previous,
    fraction,
    ...(bytes ? { bytesSent: bytes.sent, bytesTotal: bytes.total } : {}),
  });
  notify(messageId);
};

/**
 * Drop a message's entry once it has reached a terminal state.
 *
 * Always call this on BOTH success and failure — a leaked entry leaves a
 * bubble showing a progress ring forever, which reads as a stuck send even
 * though the message went through.
 */
export const clearSendProgress = (messageId: string): void => {
  if (!entries.has(messageId)) return;
  entries.delete(messageId);
  notify(messageId);
};

export const getSendProgress = (messageId: string): SendProgress | undefined =>
  entries.get(messageId);

export const subscribeToSendProgress = (
  messageId: string,
  listener: Listener,
): (() => void) => {
  const existing = listeners.get(messageId) ?? new Set<Listener>();
  existing.add(listener);
  listeners.set(messageId, existing);
  return () => {
    const current = listeners.get(messageId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(messageId);
  };
};

export const subscribeToAnySendProgress = (listener: Listener): (() => void) => {
  globalListeners.add(listener);
  return () => {
    globalListeners.delete(listener);
  };
};

/** Number of items currently in flight — drives the aggregate banner. */
export const activeSendCount = (): number => entries.size;

/**
 * Abort every in-flight item. Used when the user leaves a chat mid-batch and
 * confirms they want to stop, so a cancelled batch does not keep burning CPU
 * and bandwidth in the background.
 */
export const cancelAllSends = (): void => {
  entries.forEach((entry) => {
    try {
      entry.cancel?.();
    } catch (error) {
      console.warn('cancelAllSends: cancel handle threw', error);
    }
  });
};

/**
 * Thrown by the pipeline when the user aborts an item. Callers use the name to
 * distinguish a deliberate cancel from a real failure — a cancel must not land
 * in the failed-items sheet asking the user to retry something they just
 * chose to stop.
 */
export class MediaSendCancelledError extends Error {
  constructor(message = 'Send cancelled.') {
    super(message);
    this.name = 'MediaSendCancelledError';
  }
}
