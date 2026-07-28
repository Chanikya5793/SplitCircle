import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * The last handful of places shared from this device.
 *
 * Local-only, by the Architecture DNA: where someone has shared their location
 * is about as sensitive as data in this app gets, and it has no reason to leave
 * the phone. Nothing here is synced, backed up, or sent to a server.
 */

export interface RecentPlace {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  /** Unix ms of the most recent share, so the list can stay recency-ordered. */
  usedAt: number;
}

const STORAGE_KEY = '@splitcircle/recent_places';
const MAX_ENTRIES = 10;

/**
 * Two shares of "the same place" are never byte-identical — GPS drift moves the
 * coordinate a few metres every time. Rounding to ~11m (4 decimal places) makes
 * repeat visits collapse into one entry instead of filling the list with near
 * duplicates of the same café.
 */
const keyFor = (latitude: number, longitude: number): string =>
  `${latitude.toFixed(4)},${longitude.toFixed(4)}`;

export const getRecentPlaces = async (): Promise<RecentPlace[]> => {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is RecentPlace =>
          !!entry &&
          typeof entry.latitude === 'number' &&
          typeof entry.longitude === 'number',
      )
      .sort((a, b) => (b.usedAt ?? 0) - (a.usedAt ?? 0));
  } catch (error) {
    console.warn('Could not read recent places', error);
    return [];
  }
};

/**
 * Record a share. Re-sharing a known place moves it to the top and refreshes
 * its label rather than adding a second row.
 */
export const rememberPlace = async (
  place: Omit<RecentPlace, 'usedAt'>,
): Promise<void> => {
  try {
    const existing = await getRecentPlaces();
    const key = keyFor(place.latitude, place.longitude);
    const deduped = existing.filter((p) => keyFor(p.latitude, p.longitude) !== key);
    const next: RecentPlace[] = [
      { ...place, usedAt: Date.now() },
      ...deduped,
    ].slice(0, MAX_ENTRIES);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    // Never block a send on bookkeeping.
    console.warn('Could not save recent place', error);
  }
};

export const clearRecentPlaces = async (): Promise<void> => {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn('Could not clear recent places', error);
  }
};
