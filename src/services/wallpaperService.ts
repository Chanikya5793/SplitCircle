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

export type BlobTrio = [string, string, string];

/**
 * A resolved wallpaper. Either a still PHOTO (uri rebuilt on read) or the
 * signature animated BLOB backdrop in a colour palette (rendered live by
 * LiquidBackground, not an image).
 */
export type WallpaperEntry =
  | { kind: 'photo'; uri: string; setAt: number }
  | { kind: 'blob'; light: BlobTrio; dark: BlobTrio; adaptive?: boolean; setAt: number };

/**
 * What we actually persist. For photos we store the FILE NAME only, never an
 * absolute path: iOS changes the app's data-container UUID on every
 * install/update, so a stored absolute file:// URI goes stale after a new build
 * (the file survives, the path doesn't) — that was the "wallpaper disappears
 * after updating" bug. We rebuild the URI from the live document dir on read.
 */
type StoredEntry =
  | { kind: 'photo'; file: string; setAt: number }
  | { kind: 'blob'; light: BlobTrio; dark: BlobTrio; adaptive?: boolean; setAt: number };

type WallpaperMap = Partial<Record<string, StoredEntry>>;

let cache: WallpaperMap | null = null;
const listeners = new Set<() => void>();

// Every mutation below does an unlocked load-modify-persist (spread the
// current map, change one slot, persist the whole map back). Two concurrent
// writes to DIFFERENT slots (e.g. app wallpaper + chat-default set in quick
// succession, or an onChanged callback firing mid-write) can both read the
// same starting snapshot and then persist their own — whichever commits
// last silently overwrites the other slot's update. Chaining every mutation
// through this queue serializes them so each one always starts from the
// result of the previous, not a stale snapshot.
let writeQueue: Promise<unknown> = Promise.resolve();
const withWriteLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const notify = () => listeners.forEach((l) => l());

/** Subscribe to any wallpaper change. Returns unsubscribe. */
export const onWallpapersChanged = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Filename → absolute URI against the CURRENT container (see StoredEntry). */
const basename = (p: string): string => p.split('/').pop() ?? p;
const resolveUri = (file: string): string => new File(wallpapersDir(), file).uri;
const toEntry = (stored: StoredEntry): WallpaperEntry =>
  stored.kind === 'blob'
    ? { kind: 'blob', light: stored.light, dark: stored.dark, adaptive: stored.adaptive, setAt: stored.setAt }
    : { kind: 'photo', uri: resolveUri(stored.file), setAt: stored.setAt };

type RawStored = { kind?: string; file?: string; uri?: string; light?: BlobTrio; dark?: BlobTrio; adaptive?: boolean; setAt?: number };

const loadMap = async (): Promise<WallpaperMap> => {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, RawStored>) : {};
    // Migrate: v1 stored an absolute `uri`; v2 stored `{file}` with no kind.
    let migrated = false;
    const next: WallpaperMap = {};
    for (const [slot, entry] of Object.entries(parsed)) {
      if (!entry) continue;
      const setAt = entry.setAt ?? Date.now();
      if (entry.kind === 'blob' && entry.light && entry.dark) {
        next[slot] = { kind: 'blob', light: entry.light, dark: entry.dark, adaptive: entry.adaptive, setAt };
      } else if (entry.file) {
        next[slot] = { kind: 'photo', file: entry.file, setAt };
        if (entry.kind !== 'photo') migrated = true;
      } else if (entry.uri) {
        next[slot] = { kind: 'photo', file: basename(entry.uri), setAt };
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

  return withWriteLock(async () => {
    const map = { ...(await loadMap()) };
    const previous = map[slot];
    map[slot] = { kind: 'photo', file: fileName, setAt: Date.now() };
    await persistMap(map);
    deletePreviousFile(previous);
    return toEntry(map[slot]!);
  });
};

/** Delete the backing image file of a replaced/cleared PHOTO entry. */
const deletePreviousFile = (previous: StoredEntry | undefined) => {
  if (previous?.kind !== 'photo') return;
  try {
    const old = new File(wallpapersDir(), previous.file);
    if (old.exists) old.delete();
  } catch {
    // Orphaned file — harmless.
  }
};

/** Set a slot to the animated liquid-blob backdrop in a colour palette (or, when
 *  adaptive, following the app's live accent theme). */
export const setWallpaperBlob = async (
  slot: WallpaperSlot,
  light: BlobTrio,
  dark: BlobTrio,
  adaptive?: boolean,
): Promise<WallpaperEntry> => {
  return withWriteLock(async () => {
    const map = { ...(await loadMap()) };
    const previous = map[slot];
    map[slot] = { kind: 'blob', light, dark, adaptive, setAt: Date.now() };
    await persistMap(map);
    deletePreviousFile(previous); // frees the old photo file if we replaced one
    return toEntry(map[slot]!);
  });
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

/**
 * Make one surface use the exact wallpaper of another surface. Photos are
 * copied into a distinct durable file (so clearing one slot cannot delete the
 * other); animated/blob entries retain their palette and adaptive behavior.
 * If the source has no explicit wallpaper, clearing the target restores its
 * natural fallback chain instead.
 */
export const copyWallpaper = async (
  sourceSlot: WallpaperSlot,
  targetSlot: WallpaperSlot,
): Promise<WallpaperEntry | null> => {
  if (sourceSlot === targetSlot) return getWallpaperSync(targetSlot);
  const map = await loadMap();
  const source = map[sourceSlot];

  if (!source) {
    await clearWallpaper(targetSlot);
    return null;
  }

  if (source.kind === 'photo') {
    return storeAsWallpaper(targetSlot, resolveUri(source.file), 'copy');
  }

  return withWriteLock(async () => {
    // Re-read inside the lock rather than reusing the outer `map` — that
    // snapshot was taken before the lock was granted and may be stale by now.
    const fresh = { ...(await loadMap()) };
    const previous = fresh[targetSlot];
    fresh[targetSlot] = {
      kind: 'blob' as const,
      light: [...source.light] as BlobTrio,
      dark: [...source.dark] as BlobTrio,
      adaptive: source.adaptive,
      setAt: Date.now(),
    };
    await persistMap(fresh);
    deletePreviousFile(previous);
    return toEntry(fresh[targetSlot]!);
  });
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
  return withWriteLock(async () => {
    const map = { ...(await loadMap()) };
    const previous = map[slot];
    if (!previous) return;
    delete map[slot];
    await persistMap(map);
    deletePreviousFile(previous);
  });
};
