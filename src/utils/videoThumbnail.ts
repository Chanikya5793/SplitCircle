import { mediaExistsLocally } from '@/services/mediaService';
import {
  getCachedRender,
  updateCachedRender,
} from '@/services/messageRenderCache';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { useEffect, useState } from 'react';

// In-memory URI → thumb-URI map. Acts as the session-level cache and an
// inflight de-dup for parallel callers asking for the same source URI. The
// *persistent* cache (across app launches) lives in `messageRenderCache`
// and is consulted before this — see `useCachedVideoThumbnail` below.
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
const failed = new Set<string>();

async function generate(uri: string): Promise<string | null> {
  const cached = cache.get(uri);
  if (cached) return cached;
  if (failed.has(uri)) return null;
  const existing = inflight.get(uri);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const { uri: thumbUri } = await VideoThumbnails.getThumbnailAsync(uri, {
        time: 0,
        quality: 0.5,
      });
      cache.set(uri, thumbUri);
      return thumbUri;
    } catch {
      failed.add(uri);
      return null;
    } finally {
      inflight.delete(uri);
    }
  })();
  inflight.set(uri, promise);
  return promise;
}

/**
 * Lightweight hook for callers without message context (e.g. the
 * MediaPreview's thumbnail strip rendering picker assets). Uses only the
 * in-memory cache — no persistence across app launches.
 */
export function useVideoThumbnail(videoUri: string | undefined): string | undefined {
  const [thumb, setThumb] = useState<string | undefined>(
    videoUri ? cache.get(videoUri) : undefined,
  );

  useEffect(() => {
    if (!videoUri) {
      setThumb(undefined);
      return;
    }
    const cached = cache.get(videoUri);
    if (cached) {
      setThumb(cached);
      return;
    }
    let cancelled = false;
    setThumb(undefined);
    generate(videoUri).then((u) => {
      if (!cancelled && u) setThumb(u);
    });
    return () => {
      cancelled = true;
    };
  }, [videoUri]);

  return thumb;
}

/**
 * Persistent variant — backed by `messageRenderCache`. Use this from chat
 * bubbles where you have a message id + version stamp. First-app-launch
 * after a fresh install still pays the generation cost, but every launch
 * after that hits the cache and renders the thumbnail without re-running
 * expo-video-thumbnails on the video file.
 *
 * Verifies the cached thumbnail file still exists on disk (iOS can evict
 * files from cacheDirectory under pressure) and regenerates on a miss.
 */
export function useCachedVideoThumbnail(opts: {
  videoUri: string | undefined;
  chatId: string;
  messageId: string;
  stamp: string;
}): string | undefined {
  const { videoUri, chatId, messageId, stamp } = opts;
  const cached = videoUri ? cache.get(videoUri) : undefined;
  const persisted = videoUri ? getCachedRender(chatId, messageId, stamp)?.videoThumbUri : undefined;
  const [thumb, setThumb] = useState<string | undefined>(cached ?? persisted);

  useEffect(() => {
    if (!videoUri) {
      setThumb(undefined);
      return;
    }
    let cancelled = false;

    (async () => {
      // 1. In-memory hit — return immediately.
      const sessionHit = cache.get(videoUri);
      if (sessionHit) {
        setThumb(sessionHit);
        return;
      }

      // 2. Persisted hit — verify the file still exists; iOS can evict
      //    cacheDirectory files under disk pressure.
      const persistedHit = getCachedRender(chatId, messageId, stamp)?.videoThumbUri;
      if (persistedHit) {
        const ok = await mediaExistsLocally(persistedHit);
        if (cancelled) return;
        if (ok) {
          cache.set(videoUri, persistedHit);
          setThumb(persistedHit);
          return;
        }
      }

      // 3. Cold path — generate.
      const fresh = await generate(videoUri);
      if (cancelled) return;
      if (fresh) {
        setThumb(fresh);
        updateCachedRender(chatId, messageId, stamp, { videoThumbUri: fresh });
      }
    })();

    return () => { cancelled = true; };
  }, [videoUri, chatId, messageId, stamp]);

  return thumb;
}
