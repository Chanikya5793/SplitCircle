/**
 * wallpaperService.ts — device-local custom backgrounds (WhatsApp-style).
 *
 * Slots:
 *   app                  → photo behind every screen (replaces the blob backdrop)
 *   chat-default         → default wallpaper for ALL conversations (DMs + groups)
 *   chat:<chatId>        → per-conversation override (works for DMs and groups)
 *
 * Resolution for a conversation: chat:<id> → chat-default → none (callers fall
 * back to the app wallpaper / liquid blobs). Everything is stored offline:
 * picked photos are re-encoded and COPIED into documentDirectory/wallpapers/
 * (picker URIs are ephemeral), and slot→file mappings live in AsyncStorage.
 * Deliberately not synced to the server — backgrounds are a device preference.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Directory, File, Paths } from 'expo-file-system';

const STORAGE_KEY = 'wallpapers_v1';

export type WallpaperSlot = 'app' | 'chat-default' | `chat:${string}` | `group:${string}`;

export interface WallpaperEntry {
  /** file:// URI inside documentDirectory/wallpapers/ */
  uri: string;
  /** When the wallpaper was set (for cache-busting Image keys). */
  setAt: number;
}

type WallpaperMap = Partial<Record<string, WallpaperEntry>>;

let cache: WallpaperMap | null = null;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((l) => l());

/** Subscribe to any wallpaper change. Returns unsubscribe. */
export const onWallpapersChanged = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const loadMap = async (): Promise<WallpaperMap> => {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    cache = raw ? (JSON.parse(raw) as WallpaperMap) : {};
  } catch {
    cache = {};
  }
  return cache;
};

const persistMap = async (map: WallpaperMap) => {
  cache = map;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage full/unavailable — the in-memory cache still works this session.
  }
  notify();
};

const wallpapersDir = () => new Directory(Paths.document, 'wallpapers');

/** Synchronous read from the in-memory cache (hydrate() first at app start). */
export const getWallpaperSync = (slot: WallpaperSlot): WallpaperEntry | null =>
  (cache?.[slot] as WallpaperEntry | undefined) ?? null;

/** Resolve the wallpaper a conversation should show (per-chat → default). */
export const resolveChatWallpaperSync = (chatId: string): WallpaperEntry | null =>
  getWallpaperSync(`chat:${chatId}`) ?? getWallpaperSync('chat-default');

/** Load the slot map into memory. Call once early (LiquidBackground does). */
export const hydrateWallpapers = async (): Promise<void> => {
  await loadMap();
  notify();
};

/**
 * Let the user pick a photo, downscale it for use as a full-screen background,
 * copy it into app storage, and assign it to the slot. Returns the stored
 * entry, or null if the user cancelled (permission denials surface as throws
 * so callers can show a message).
 */
export const pickAndSetWallpaper = async (
  slot: WallpaperSlot,
): Promise<WallpaperEntry | null> => {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error('Photo library access is needed to set a background.');
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 0.9,
  });
  if (result.canceled || !result.assets[0]) return null;

  // Downscale: full-screen backgrounds never need more than ~1500px wide, and
  // large camera images (12–48MP) would otherwise cost real memory per screen.
  const manipulated = await ImageManipulator.manipulateAsync(
    result.assets[0].uri,
    [{ resize: { width: 1500 } }],
    { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG },
  );

  const dir = wallpapersDir();
  if (!dir.exists) dir.create({ intermediates: true });

  // One file per slot (slot name is filesystem-safe after replacing ':').
  const fileName = `${slot.replace(/:/g, '_')}_${Date.now()}.jpg`;
  const dest = new File(dir, fileName);
  new File(manipulated.uri).move(dest);

  const map = { ...(await loadMap()) };
  const previous = map[slot] as WallpaperEntry | undefined;
  const entry: WallpaperEntry = { uri: dest.uri, setAt: Date.now() };
  map[slot] = entry;
  await persistMap(map);

  // Remove the replaced file after the map points at the new one.
  if (previous?.uri) {
    try {
      const old = new File(previous.uri);
      if (old.exists) old.delete();
    } catch {
      // Orphaned file — harmless.
    }
  }

  return entry;
};

/** Chat slots the user has individually customized (excludes the default). */
export const listChatOverrideSlots = (): WallpaperSlot[] =>
  Object.keys(cache ?? {}).filter((k): k is WallpaperSlot => k.startsWith('chat:'));

/** Remove every per-chat override so the chat default applies everywhere. */
export const clearAllChatOverrides = async (): Promise<void> => {
  for (const slot of listChatOverrideSlots()) {
    await clearWallpaper(slot);
  }
};

/** Resolve a slot chain — first set entry wins (e.g. group override → app). */
export const resolveChainSync = (slots: WallpaperSlot[]): WallpaperEntry | null => {
  for (const slot of slots) {
    const entry = getWallpaperSync(slot);
    if (entry) return entry;
  }
  return null;
};

/** Clear a slot (per-chat clear falls back to default; default clear to blobs). */
export const clearWallpaper = async (slot: WallpaperSlot): Promise<void> => {
  const map = { ...(await loadMap()) };
  const previous = map[slot] as WallpaperEntry | undefined;
  if (!previous) return;
  delete map[slot];
  await persistMap(map);
  try {
    const old = new File(previous.uri);
    if (old.exists) old.delete();
  } catch {
    // Orphaned file — harmless.
  }
};
