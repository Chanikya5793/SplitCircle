/**
 * Per-transport preferences (ai_layer/docs/33 §4.1, Phase 7).
 *
 * The behaviour that matters is what happens when things go WRONG: a storage
 * failure that silently disabled someone's nearby messaging would be
 * indistinguishable from the radio being broken, which is the invisible-failure
 * class that has cost this project days more than once.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STORAGE_KEY,
  __resetTransportPreferences,
  loadTransportPreferences,
  getTransportPreferences,
  isTransportEnabled,
  parseTransportPreferences,
  setNearbyEnabled,
  setTransportEnabled,
} from '../mesh/transportPreferences';

beforeEach(async () => {
  __resetTransportPreferences();
  await AsyncStorage.clear();
  vi.restoreAllMocks();
});

/**
 * The fail-open guarantee lives in `loadTransportPreferences`'s try/catch, and
 * nothing here used to call it (doc 35). The old "FAILS OPEN" test only fed
 * pre-parsed values into `parseTransportPreferences`, a pure function that was
 * already safe — so a regression making the LOAD rethrow, which is where the
 * risk actually is, would have gone completely undetected and silently disabled
 * someone's nearby messaging with no signal anywhere.
 */
describe('the real load path fails open', () => {
  it('enables everything when nothing is stored', async () => {
    const prefs = await loadTransportPreferences();
    expect(prefs.nearbyEnabled).toBe(true);
    expect(prefs.disabledTransports).toEqual([]);
  });

  it('enables everything when the stored value is corrupt JSON', async () => {
    // JSON.parse throws here, INSIDE the try — the case parseTransportPreferences
    // can never see, because it is only reached with an already-parsed value.
    await AsyncStorage.setItem(STORAGE_KEY, '{not json');
    await expect(loadTransportPreferences()).resolves.toMatchObject({
      nearbyEnabled: true,
    });
    expect(isTransportEnabled('ble')).toBe(true);
  });

  it('enables everything when storage itself throws', async () => {
    vi.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(loadTransportPreferences()).resolves.toMatchObject({
      nearbyEnabled: true,
    });
  });

  it('still honours a VALID stored preference — fail-open must not mean ignore', async () => {
    await setNearbyEnabled(false);
    __resetTransportPreferences();
    const prefs = await loadTransportPreferences();
    expect(prefs.nearbyEnabled).toBe(false);
  });
});

describe('defaults and failure modes', () => {
  it('is enabled by default', () => {
    expect(isTransportEnabled('ble')).toBe(true);
    expect(isTransportEnabled('mpc')).toBe(true);
  });

  it('FAILS OPEN on unreadable stored data', () => {
    // Disabling someone's messaging because a read failed is worse than
    // ignoring a corrupt preference.
    for (const bad of [null, undefined, 'nonsense', 42, []]) {
      expect(parseTransportPreferences(bad).nearbyEnabled).toBe(true);
    }
  });

  it('treats a missing flag as enabled, and only explicit false as off', () => {
    expect(parseTransportPreferences({}).nearbyEnabled).toBe(true);
    expect(parseTransportPreferences({ nearbyEnabled: false }).nearbyEnabled).toBe(false);
  });

  it('discards unknown transport ids rather than trusting stored input', () => {
    const parsed = parseTransportPreferences({ disabledTransports: ['ble', 'evil', 7] });
    expect(parsed.disabledTransports).toEqual(['ble']);
  });

  it('de-duplicates a repeated id', () => {
    expect(parseTransportPreferences({ disabledTransports: ['ble', 'ble'] }).disabledTransports)
      .toEqual(['ble']);
  });
});

describe('the master switch', () => {
  it('overrides an individually-enabled transport', async () => {
    // That is what a master switch has to mean; anything else is a lie in the UI.
    await setNearbyEnabled(false);
    expect(isTransportEnabled('mpc')).toBe(false);
    expect(isTransportEnabled('ble')).toBe(false);
  });

  it('restores per-transport choices when turned back on', async () => {
    await setTransportEnabled('ble', false);
    await setNearbyEnabled(false);
    await setNearbyEnabled(true);
    expect(isTransportEnabled('ble')).toBe(false);
    expect(isTransportEnabled('mpc')).toBe(true);
  });
});

describe('per-transport toggles', () => {
  it('disables and re-enables one transport without touching the others', async () => {
    await setTransportEnabled('ble', false);
    expect(isTransportEnabled('ble')).toBe(false);
    expect(isTransportEnabled('mpc')).toBe(true);

    await setTransportEnabled('ble', true);
    expect(isTransportEnabled('ble')).toBe(true);
    expect(getTransportPreferences().disabledTransports).toEqual([]);
  });
});
