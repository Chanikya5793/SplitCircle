import {
  activeSendCount,
  getSendProgress,
  subscribeToAnySendProgress,
  subscribeToSendProgress,
  type SendProgress,
} from '@/services/mediaSendProgress';
import { useCallback, useSyncExternalStore } from 'react';

/**
 * Live send progress for one message.
 *
 * `useSyncExternalStore` rather than context or state-lifting: the consumer is
 * a single bubble inside a virtualized list, and upload progress ticks tens of
 * times per second per item. Routing that through context would re-render
 * every mounted bubble on every tick, on the most render-sensitive surface in
 * the app. Here, only the bubble whose entry changed re-renders.
 *
 * Returns `undefined` for any message that is not currently being sent, which
 * is the overwhelming majority — so the common case costs one Map lookup.
 */
export const useSendProgress = (messageId: string): SendProgress | undefined => {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToSendProgress(messageId, listener),
    [messageId],
  );
  const getSnapshot = useCallback(() => getSendProgress(messageId), [messageId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

/**
 * How many items are in flight right now. Drives the aggregate banner, which
 * exists for the case where the user has scrolled away from the bubbles that
 * carry their own progress.
 */
export const useActiveSendCount = (): number =>
  useSyncExternalStore(subscribeToAnySendProgress, activeSendCount, activeSendCount);
