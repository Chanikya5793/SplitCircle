/**
 * Per-transport user preferences (ai_layer/docs/33 §4.1, Phase 7).
 *
 * A master switch plus one toggle per transport. Nearby messaging uses radios
 * that cost battery and are, to some users, a privacy question — "which radios
 * may this app use" is theirs to answer, not something to infer.
 *
 * SYNCHRONOUS READS. The transport switch consults this on every send and every
 * reachability check, so an async read would either block the hot path or make
 * the answer arrive after the decision. Preferences are loaded once at startup
 * into an in-memory snapshot and written back asynchronously.
 *
 * FAIL OPEN. An unreadable or absent preference means ENABLED. A storage
 * failure must never silently disable someone's nearby messaging — that is
 * indistinguishable from the transport being broken, which is exactly the class
 * of invisible failure doc 32 §10.1 and doc 34 §0.2 cost days each.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { TransportId } from './transport';

const STORAGE_KEY = 'splitcircle.mesh.transportPrefs.v1';

export interface TransportPreferences {
  /** Master switch. Off disables every transport regardless of the rest. */
  nearbyEnabled: boolean;
  /** Per-transport. Absent means enabled. */
  disabledTransports: TransportId[];
}

const DEFAULTS: TransportPreferences = {
  nearbyEnabled: true,
  disabledTransports: [],
};

let snapshot: TransportPreferences = { ...DEFAULTS };
const listeners = new Set<() => void>();

const notify = (): void => listeners.forEach((listener) => listener());

/** Validates a stored blob. Anything unexpected falls back to defaults. */
export const parseTransportPreferences = (value: unknown): TransportPreferences => {
  if (!value || typeof value !== 'object') return { ...DEFAULTS };
  const raw = value as Record<string, unknown>;
  const disabled = Array.isArray(raw.disabledTransports)
    ? raw.disabledTransports.filter(
      (id): id is TransportId => id === 'mpc' || id === 'ble' || id === 'lan',
    )
    : [];
  return {
    // Only an explicit `false` disables. A missing or malformed value fails
    // open, per this module's header.
    nearbyEnabled: raw.nearbyEnabled !== false,
    disabledTransports: [...new Set(disabled)],
  };
};

/** Loads once at startup. Safe to call repeatedly. */
export const loadTransportPreferences = async (): Promise<TransportPreferences> => {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    snapshot = parseTransportPreferences(raw ? JSON.parse(raw) : null);
  } catch {
    snapshot = { ...DEFAULTS };
  }
  notify();
  return snapshot;
};

/** The current preferences. Synchronous by design — see the header. */
export const getTransportPreferences = (): TransportPreferences => snapshot;

/**
 * Whether a transport may be used right now.
 *
 * The master switch wins: an individually-enabled transport is still off when
 * nearby is off as a whole, which is what a master switch has to mean.
 */
export const isTransportEnabled = (id: TransportId): boolean =>
  snapshot.nearbyEnabled && !snapshot.disabledTransports.includes(id);

export const setNearbyEnabled = async (enabled: boolean): Promise<void> => {
  snapshot = { ...snapshot, nearbyEnabled: enabled };
  notify();
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)).catch(() => undefined);
};

export const setTransportEnabled = async (
  id: TransportId,
  enabled: boolean,
): Promise<void> => {
  const disabled = new Set(snapshot.disabledTransports);
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  snapshot = { ...snapshot, disabledTransports: [...disabled] };
  notify();
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)).catch(() => undefined);
};

/** For `useSyncExternalStore` in the settings UI. */
export const subscribeToTransportPreferences = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Test seam. */
export const __resetTransportPreferences = (): void => {
  snapshot = { ...DEFAULTS };
  listeners.clear();
};
