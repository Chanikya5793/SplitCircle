// Per-user, per-group DISPLAY currency conversion. Unlike convertGroupCurrency
// (admin-only, permanently rewrites the ledger), this is a lens: any member can
// view a group's amounts in another currency, toggle back and forth, and the
// stored data never changes. Preferences live on-device only (AsyncStorage) —
// two members of the same group can each view it in their own currency.
//
// Rate resolution: a user-pinned custom rate wins; otherwise the live ECB rate
// from currencyRatesService (24h offline cache). The pref remembers the group
// currency it was created against (`base`) — if the group's real currency later
// changes (permanent conversion), the stale pref silently deactivates instead
// of converting with a wrong-base rate.

import {
  getExchangeRate,
  type RateResult,
} from '@/services/currencyRatesService';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

const STORAGE_KEY = 'display_currency_v1';

export interface DisplayCurrencyPref {
  /** Group currency this pref converts FROM (guards against base changes). */
  base: string;
  /** Currency the user wants to see. */
  target: string;
  /** User-pinned rate (base → target). Overrides the live rate while set. */
  customRate?: number;
  /** Tap-to-flip state: false = show the group currency untouched. */
  enabled: boolean;
}

export interface DisplayConversion {
  target: string;
  /** Multiply a base amount by this to get the displayed amount. */
  rate: number;
  source: 'custom' | 'live';
  /** Live-rate metadata (undefined for custom rates). */
  fetchedAt?: number;
  stale?: boolean;
}

interface DisplayCurrencyContextValue {
  /**
   * Active conversion for a group, or null when the lens is off / unresolved.
   * Pass the group's CURRENT currency so a stale pref (base mismatch) is
   * treated as off rather than converting with the wrong rate.
   */
  getConversion: (groupId: string, baseCurrency?: string) => DisplayConversion | null;
  /** Raw pref (even while toggled off) — for the picker sheet UI. */
  getPref: (groupId: string) => DisplayCurrencyPref | null;
  /** Pick a target currency (and optionally pin a custom rate). Enables the lens. */
  setDisplayCurrency: (
    groupId: string,
    base: string,
    target: string,
    customRate?: number,
  ) => Promise<void>;
  /** Flip between group currency and the chosen currency. No-op without a pref. */
  toggleDisplay: (groupId: string) => void;
  /** Forget the group's display currency entirely. */
  clearDisplay: (groupId: string) => void;
}

// Safe default so components (and tests) render without the provider: the
// lens simply never activates.
const noop = () => undefined;
const DisplayCurrencyContext = createContext<DisplayCurrencyContextValue>({
  getConversion: () => null,
  getPref: () => null,
  setDisplayCurrency: async () => undefined,
  toggleDisplay: noop,
  clearDisplay: noop,
});

const rateKey = (base: string, target: string) => `${base}:${target}`;

export const DisplayCurrencyProvider = ({ children }: { children: React.ReactNode }) => {
  const [prefs, setPrefs] = useState<Record<string, DisplayCurrencyPref>>({});
  const [liveRates, setLiveRates] = useState<Record<string, RateResult>>({});
  const hydrated = useRef(false);

  useEffect(() => {
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) setPrefs(JSON.parse(raw) as Record<string, DisplayCurrencyPref>);
      } catch {
        // Unreadable prefs → start fresh; display-only, nothing is lost.
      } finally {
        hydrated.current = true;
      }
    })();
  }, []);

  const persist = useCallback((next: Record<string, DisplayCurrencyPref>) => {
    setPrefs(next);
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
  }, []);

  const resolveLiveRate = useCallback(async (base: string, target: string) => {
    try {
      const result = await getExchangeRate(base, target);
      setLiveRates((prev) => ({ ...prev, [rateKey(base, target)]: result }));
    } catch {
      // Offline with no cache: the lens stays inactive until a rate exists.
    }
  }, []);

  // Resolve live rates for every enabled non-custom pref (on hydrate and
  // whenever prefs change). getExchangeRate serves fresh cache without I/O.
  useEffect(() => {
    for (const pref of Object.values(prefs)) {
      if (pref.enabled && pref.customRate === undefined) {
        void resolveLiveRate(pref.base, pref.target);
      }
    }
  }, [prefs, resolveLiveRate]);

  const getPref = useCallback(
    (groupId: string) => prefs[groupId] ?? null,
    [prefs],
  );

  const getConversion = useCallback(
    (groupId: string, baseCurrency?: string): DisplayConversion | null => {
      const pref = prefs[groupId];
      if (!pref || !pref.enabled) return null;
      if (baseCurrency && baseCurrency.toUpperCase() !== pref.base.toUpperCase()) return null;
      if (pref.target.toUpperCase() === pref.base.toUpperCase()) return null;
      if (pref.customRate !== undefined && pref.customRate > 0) {
        return { target: pref.target, rate: pref.customRate, source: 'custom' };
      }
      const live = liveRates[rateKey(pref.base, pref.target)];
      if (!live) return null; // still resolving (or offline with no cache)
      return {
        target: pref.target,
        rate: live.rate,
        source: 'live',
        fetchedAt: live.fetchedAt,
        stale: live.stale,
      };
    },
    [prefs, liveRates],
  );

  const setDisplayCurrency = useCallback(
    async (groupId: string, base: string, target: string, customRate?: number) => {
      const pref: DisplayCurrencyPref = {
        base: base.toUpperCase(),
        target: target.toUpperCase(),
        customRate: customRate !== undefined && customRate > 0 ? customRate : undefined,
        enabled: true,
      };
      persist({ ...prefs, [groupId]: pref });
      if (pref.customRate === undefined) {
        await resolveLiveRate(pref.base, pref.target);
      }
    },
    [prefs, persist, resolveLiveRate],
  );

  const toggleDisplay = useCallback(
    (groupId: string) => {
      const pref = prefs[groupId];
      if (!pref) return;
      persist({ ...prefs, [groupId]: { ...pref, enabled: !pref.enabled } });
    },
    [prefs, persist],
  );

  const clearDisplay = useCallback(
    (groupId: string) => {
      if (!(groupId in prefs)) return;
      const next = { ...prefs };
      delete next[groupId];
      persist(next);
    },
    [prefs, persist],
  );

  const value = useMemo(
    () => ({ getConversion, getPref, setDisplayCurrency, toggleDisplay, clearDisplay }),
    [getConversion, getPref, setDisplayCurrency, toggleDisplay, clearDisplay],
  );

  return (
    <DisplayCurrencyContext.Provider value={value}>{children}</DisplayCurrencyContext.Provider>
  );
};

export const useDisplayCurrency = () => useContext(DisplayCurrencyContext);
