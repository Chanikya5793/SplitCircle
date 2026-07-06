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
import { Asset } from 'expo-asset';
import { Directory, File, Paths } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

const STORAGE_KEY = 'wallpapers_v1';

export type WallpaperSlot = 'app' | 'chat-default' | `chat:${string}` | `group:${string}`;

export interface WallpaperEntry {
  /** Absolute file:// URI, resolved against the CURRENT document dir on read. */
  uri: string;
  /** When the wallpaper was set (for cache-busting Image keys). */
  setAt: number;
}

/**
 * What we actually persist: the FILE NAME only, never an absolute path. iOS
 * changes the app's data-container UUID on every install/update, so a stored
 * absolute file:// URI goes stale after a new build (the file survives, the
 * path doesn't) — that was the "wallpaper disappears after updating" bug. We
 * store just the name and rebuild the URI from the live document dir on read.
 */
interface StoredEntry {
  file: string;
  setAt: number;
}

type WallpaperMap = Partial<Record<string, StoredEntry>>;

let cache: WallpaperMap | null = null;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((l) => l());

/** Subscribe to any wallpaper change. Returns unsubscribe. */
export const onWallpapersChanged = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Filename → absolute URI against the CURRENT container (see StoredEntry). */
const basename = (p: string): string => p.split('/').pop() ?? p;
const resolveUri = (file: string): string => new File(wallpapersDir(), file).uri;
const toEntry = (stored: StoredEntry): WallpaperEntry => ({ uri: resolveUri(stored.file), setAt: stored.setAt });

const loadMap = async (): Promise<WallpaperMap> => {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, { file?: string; uri?: string; setAt?: number }>) : {};
    // Migrate v1 entries that stored an absolute `uri` → keep only the filename.
    let migrated = false;
    const next: WallpaperMap = {};
    for (const [slot, entry] of Object.entries(parsed)) {
      if (!entry) continue;
      if (entry.file) {
        next[slot] = { file: entry.file, setAt: entry.setAt ?? Date.now() };
      } else if (entry.uri) {
        next[slot] = { file: basename(entry.uri), setAt: entry.setAt ?? Date.now() };
        migrated = true;
      }
    }
    cache = next;
    if (migrated) {
      try {
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // migration is best-effort; the in-memory map is already fixed
      }
    }
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
export const getWallpaperSync = (slot: WallpaperSlot): WallpaperEntry | null => {
  const stored = cache?.[slot];
  return stored ? toEntry(stored) : null;
};

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

  return storeAsWallpaper(slot, manipulated.uri, 'move');
};

/** Copy/move a local image file into app storage and point the slot at it. */
const storeAsWallpaper = async (
  slot: WallpaperSlot,
  sourceUri: string,
  mode: 'move' | 'copy',
): Promise<WallpaperEntry> => {
  const dir = wallpapersDir();
  if (!dir.exists) dir.create({ intermediates: true });

  // One file per slot (slot name is filesystem-safe after replacing ':').
  const fileName = `${slot.replace(/:/g, '_')}_${Date.now()}.jpg`;
  const dest = new File(dir, fileName);
  const source = new File(sourceUri);
  if (mode === 'move') source.move(dest);
  else source.copy(dest);

  const map = { ...(await loadMap()) };
  const previous = map[slot];
  map[slot] = { file: fileName, setAt: Date.now() };
  await persistMap(map);

  // Remove the replaced file after the map points at the new one.
  if (previous?.file) {
    try {
      const old = new File(wallpapersDir(), previous.file);
      if (old.exists) old.delete();
    } catch {
      // Orphaned file — harmless.
    }
  }

  return toEntry(map[slot]!);
};

/**
 * Set a slot from a bundled catalog wallpaper (a require()'d asset module).
 * Copies the asset into the wallpapers dir so entries survive OTA updates
 * (bundled asset paths change per update; our copies don't).
 */
export const setWallpaperFromBundled = async (
  slot: WallpaperSlot,
  assetModule: number,
): Promise<WallpaperEntry> => {
  const asset = Asset.fromModule(assetModule);
  await asset.downloadAsync(); // no-op locally; guarantees localUri
  if (!asset.localUri) throw new Error('Wallpaper asset unavailable.');
  return storeAsWallpaper(slot, asset.localUri, 'copy');
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
  const previous = map[slot];
  if (!previous) return;
  delete map[slot];
  await persistMap(map);
  try {
    const old = new File(wallpapersDir(), previous.file);
    if (old.exists) old.delete();
  } catch {
    // Orphaned file — harmless.
  }
};
