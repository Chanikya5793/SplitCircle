// Shared resolver for the URI that should actually be passed to <Image> /
// <Video> for a chat message. Replaces the naive `localMediaPath ?? mediaUrl`
// pattern that left bubbles showing dark cells when the local file was
// missing (stale path from a reinstall, cache eviction, etc.).
//
// Strategy:
//   1. If `localMediaPath` is set, statelessly check it exists on disk.
//      Yes → use it (fast, offline, no network).
//      No  → forget it, try the remote URL.
//   2. If we have a `mediaUrl` and we're not the sender, try to materialize
//      a fresh local copy via `downloadMedia` (cached forever after).
//      If that fails, stream the remote URL directly so the user still sees
//      *something* instead of an empty tile.
//   3. Expose a `handleLoadError` callback for the consuming Image — if even
//      the URI we picked fails at render time (e.g. expired auth token on a
//      cached download URL), we swap to the original `mediaUrl` once. This
//      catches the stale-local-path race where `mediaExistsLocally` returned
//      true but the file is unreadable.
//
// Cross-cell de-dup: `downloadMedia` already short-circuits when the local
// path exists, so 10 cells in one album hitting it in parallel is cheap.

import { downloadMedia, mediaExistsLocally } from '@/services/mediaService';
import {
  buildStamp,
  getCachedRender,
  updateCachedRender,
} from '@/services/messageRenderCache';
import { useCallback, useEffect, useState } from 'react';

export interface ResolvedMediaState {
  /** The URI that should be rendered. `undefined` while still resolving. */
  uri: string | undefined;
  /** True only while we're actively downloading the remote file. Use to show
   *  a spinner over the cell so the user knows something is happening. */
  isDownloading: boolean;
  /** True if every fallback we tried failed. Use to show a "broken" tile. */
  errored: boolean;
  /** Wire into <Image onError={...}>. Will retry by switching to mediaUrl
   *  once if we haven't already. */
  handleLoadError: () => void;
}

interface ResolveInput {
  type: string;
  localMediaPath?: string;
  mediaUrl?: string;
  /** True when the current user is the sender — skips re-downloading from
   *  Firebase (we wrote the file ourselves and shouldn't need to fetch it). */
  isFromMe?: boolean;
  chatId: string;
  messageId: string;
  fileName?: string;
  /** Mutable-field timestamps used to version the render cache. Pass the
   *  message's updatedAt/createdAt/status straight through — the hook
   *  derives a stamp so edits and status changes auto-invalidate. */
  updatedAt?: number;
  createdAt?: number;
  timestamp?: number;
  editedAt?: number;
  status?: string;
  deletedForEveryone?: boolean;
}

const NON_MEDIA = new Set(['text', 'system', 'call', 'location']);

export const useResolvedMediaUri = (input: ResolveInput): ResolvedMediaState => {
  const stamp = buildStamp(input);
  // Seed optimistically from the message so the first render flashes
  // *something*. The effect verifies the file and corrects if needed.
  // We no longer trust the render cache for initial state because cached
  // paths go stale after reinstalls / cache evictions, and Image doesn't
  // reliably fire onError for missing local files on all platforms.
  const initial = input.localMediaPath ?? input.mediaUrl;
  const [uri, setUri] = useState<string | undefined>(initial);
  const [isDownloading, setIsDownloading] = useState(false);
  const [errored, setErrored] = useState(false);
  // Tracks whether we already retried from a render-time onError so we don't
  // loop on a permanently broken source.
  const [retriedFromError, setRetriedFromError] = useState(false);

  useEffect(() => {
    if (NON_MEDIA.has(input.type)) return;
    let cancelled = false;
    setRetriedFromError(false);

    (async () => {
      // Cache fast path — verify the cached file still exists on disk before
      // trusting it. Local paths go stale after reinstalls (documentDirectory
      // UUID changes) or when iOS evicts caches under disk pressure.
      const hit = getCachedRender(input.chatId, input.messageId, stamp);
      if (hit?.mediaUri) {
        const still = await mediaExistsLocally(hit.mediaUri);
        if (cancelled) return;
        if (still) {
          setUri(hit.mediaUri);
          setErrored(false);
          return;
        }
        // Stale — fall through to full resolution below.
      }

      // 1. Prefer local if we can confirm the file exists.
      if (input.localMediaPath) {
        const exists = await mediaExistsLocally(input.localMediaPath);
        if (cancelled) return;
        if (exists) {
          setUri(input.localMediaPath);
          setErrored(false);
          updateCachedRender(input.chatId, input.messageId, stamp, {
            mediaUri: input.localMediaPath,
          });
          return;
        }
      }

      // 2. No usable local copy. For received media, materialize a fresh
      //    local file from the remote URL so subsequent renders are offline.
      if (input.mediaUrl && !input.isFromMe) {
        setIsDownloading(true);
        try {
          const fileName = input.fileName || `${input.type}_${input.messageId}`;
          const result = await downloadMedia(input.mediaUrl, input.chatId, input.messageId, fileName);
          if (cancelled) return;
          setUri(result.localPath);
          setErrored(false);
          updateCachedRender(input.chatId, input.messageId, stamp, {
            mediaUri: result.localPath,
          });
        } catch (err) {
          if (cancelled) return;
          console.warn('Media resolve: download failed, streaming remote', err);
          // Last-ditch: stream the remote URL directly so the cell isn't
          // empty. If even that fails, `handleLoadError` flips `errored`.
          setUri(input.mediaUrl);
          setErrored(false);
        } finally {
          if (!cancelled) setIsDownloading(false);
        }
        return;
      }

      // 3. Sender-side or no permission to download — stream remote.
      if (input.mediaUrl) {
        setUri(input.mediaUrl);
        setErrored(false);
        return;
      }

      // 4. Nothing left to try.
      setUri(undefined);
      setErrored(true);
    })();

    return () => { cancelled = true; };
  }, [
    input.type,
    input.localMediaPath,
    input.mediaUrl,
    input.isFromMe,
    input.chatId,
    input.messageId,
    input.fileName,
    stamp,
  ]);

  const handleLoadError = useCallback(() => {
    // Image failed to render — most commonly a stale local file that passed
    // the `exists` check but isn't readable. Fall back to the remote URL
    // exactly once; further failures escalate to the `errored` state so the
    // cell can show a broken-image indicator.
    if (retriedFromError) {
      setErrored(true);
      return;
    }
    setRetriedFromError(true);
    if (input.mediaUrl && uri !== input.mediaUrl) {
      setUri(input.mediaUrl);
    } else {
      setErrored(true);
    }
  }, [retriedFromError, input.mediaUrl, uri]);

  return { uri, isDownloading, errored, handleLoadError };
};
