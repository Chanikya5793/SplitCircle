import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

/**
 * MapKit place search.
 *
 * Probed with `requireOptionalNativeModule` per this project's Hermes rule — a
 * hard require on a module whose native half is missing is a SIGSEGV, not a
 * catchable error. Callers fall back to address-only geocoding when absent.
 */

export interface PlaceResult {
  /** Venue or landmark name, e.g. "Blue Bottle Coffee". */
  name: string;
  /** One-line address, possibly empty for a broad result like a city. */
  address: string;
  latitude: number;
  longitude: number;
}

/** One as-you-type suggestion. `id` is only valid until the next keystroke. */
export interface PlaceCompletion {
  id: number;
  title: string;
  subtitle: string;
}

interface NativePlacesModule {
  updateCompletionQuery(query: string, latitude: number, longitude: number): Promise<void>;
  resolveCompletion(id: number): Promise<PlaceResult>;
  addListener(
    event: 'onCompletions',
    listener: (payload: { items: PlaceCompletion[] }) => void,
  ): { remove: () => void };
  searchPlaces(query: string, latitude: number, longitude: number): Promise<PlaceResult[]>;
  searchNearby(latitude: number, longitude: number, radius: number): Promise<PlaceResult[]>;
  cancelSearch(): void;
}

const nativeModule =
  Platform.OS === 'ios'
    ? requireOptionalNativeModule<NativePlacesModule>('SplitCirclePlaces')
    : null;

export const isPlaceSearchAvailable = (): boolean => nativeModule !== null;

/**
 * Search for places near a coordinate. Pass `0, 0` when the user's location is
 * unknown — results are then unbiased rather than anchored off the coast of
 * Africa, which is what a literal 0,0 region would mean.
 */
export const searchPlaces = async (
  query: string,
  near?: { latitude: number; longitude: number },
): Promise<PlaceResult[]> => {
  if (!nativeModule) return [];
  return nativeModule.searchPlaces(query, near?.latitude ?? 0, near?.longitude ?? 0);
};

/**
 * Places around a coordinate, with no search term.
 *
 * Resolves to an empty list rather than throwing — this feeds a convenience
 * section, and a failure there should quietly show nothing instead of
 * interrupting someone who can still search or drop a pin.
 */
export const searchNearby = async (
  latitude: number,
  longitude: number,
  radius = 1500,
): Promise<PlaceResult[]> => {
  if (!nativeModule) return [];
  try {
    return await nativeModule.searchNearby(latitude, longitude, radius);
  } catch {
    return [];
  }
};

/**
 * Push the current query into the incremental completer.
 *
 * Suggestions arrive through `addCompletionsListener`, not as a return value —
 * `MKLocalSearchCompleter` is a continuously-updating delegate, and it may emit
 * several times for a single keystroke as better matches resolve.
 */
export const updateCompletionQuery = async (
  query: string,
  near?: { latitude: number; longitude: number },
): Promise<void> => {
  if (!nativeModule) return;
  try {
    await nativeModule.updateCompletionQuery(query, near?.latitude ?? 0, near?.longitude ?? 0);
  } catch {
    // Throttling while typing is routine and not worth surfacing.
  }
};

/**
 * Turn a chosen suggestion into a coordinate.
 *
 * The `id` indexes the completer's CURRENT results, so resolve on tap and
 * never hold one across a keystroke — the list underneath will have moved.
 */
export const resolveCompletion = async (id: number): Promise<PlaceResult | null> => {
  if (!nativeModule) return null;
  try {
    return await nativeModule.resolveCompletion(id);
  } catch {
    return null;
  }
};

export const addCompletionsListener = (
  listener: (items: PlaceCompletion[]) => void,
): { remove: () => void } => {
  if (!nativeModule) return { remove: () => {} };
  return nativeModule.addListener('onCompletions', ({ items }) => listener(items ?? []));
};

export const cancelPlaceSearch = (): void => {
  nativeModule?.cancelSearch();
};
