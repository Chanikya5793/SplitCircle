// React binding for wallpaperService — re-renders when any wallpaper changes.
// `chatId` resolves per-chat → chat-default; omit it for the app-wide slot.

import {
  getWallpaperSync,
  hydrateWallpapers,
  onWallpapersChanged,
  resolveChainSync,
  resolveChatWallpaperSync,
  type WallpaperEntry,
  type WallpaperSlot,
} from '@/services/wallpaperService';
import { useEffect, useState } from 'react';

let hydrationStarted = false;

const useResolved = (resolve: () => WallpaperEntry | null, dep: string | undefined) => {
  const [entry, setEntry] = useState<WallpaperEntry | null>(resolve);

  useEffect(() => {
    if (!hydrationStarted) {
      hydrationStarted = true;
      void hydrateWallpapers();
    }
    const unsubscribe = onWallpapersChanged(() => setEntry(resolve()));
    // Re-resolve immediately in case hydration finished between render and effect.
    setEntry(resolve());
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep]);

  return entry;
};

/** Wallpaper for a conversation (per-chat → chat default), or the app slot. */
export const useWallpaper = (chatId?: string): WallpaperEntry | null =>
  useResolved(
    () => (chatId ? resolveChatWallpaperSync(chatId) : getWallpaperSync('app')),
    chatId,
  );

/** A single slot with no fallback chain — for settings rows. */
export const useWallpaperSlot = (slot: WallpaperSlot): WallpaperEntry | null =>
  useResolved(() => getWallpaperSync(slot), slot);

/** First set slot in the chain wins — for screens with custom fallbacks. */
export const useWallpaperChain = (slots: WallpaperSlot[]): WallpaperEntry | null =>
  useResolved(() => resolveChainSync(slots), slots.join('|'));
