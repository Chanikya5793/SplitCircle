import * as VideoThumbnails from 'expo-video-thumbnails';
import { useEffect, useState } from 'react';

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
