/**
 * currencyRatesService.ts — exchange rates with an offline-first cache.
 *
 * Rates come from the free Frankfurter API (ECB reference rates, no key).
 * Each base currency's table is cached in AsyncStorage for 24h; when the
 * network is unavailable a stale cache is still served (flagged `stale`) so
 * conversion previews keep working offline. Conversions themselves always
 * show the user the rate + its age before anything is written.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const CACHE_KEY_PREFIX = 'fx_rates_v1:';
const FRESH_MS = 24 * 60 * 60 * 1000;

export interface RateResult {
  rate: number;
  /** When the rate table was fetched (ms epoch). */
  fetchedAt: number;
  /** True when served from a cache older than 24h (offline fallback). */
  stale: boolean;
}

interface CachedTable {
  base: string;
  rates: Record<string, number>;
  fetchedAt: number;
}

/** Currencies offered in the conversion picker (superset is supported). */
export const COMMON_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'INR', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'SGD', 'AED', 'MXN',
] as const;

const loadCache = async (base: string): Promise<CachedTable | null> => {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY_PREFIX + base);
    return raw ? (JSON.parse(raw) as CachedTable) : null;
  } catch {
    return null;
  }
};

const saveCache = async (table: CachedTable): Promise<void> => {
  try {
    await AsyncStorage.setItem(CACHE_KEY_PREFIX + table.base, JSON.stringify(table));
  } catch {
    // Cache write failure is non-fatal.
  }
};

const fetchTable = async (base: string): Promise<CachedTable> => {
  const response = await fetch(`https://api.frankfurter.app/latest?from=${encodeURIComponent(base)}`);
  if (!response.ok) throw new Error(`Rate service unavailable (${response.status}).`);
  const data = (await response.json()) as { base?: string; rates?: Record<string, number> };
  if (!data?.rates || typeof data.rates !== 'object') {
    throw new Error('Rate service returned an invalid payload.');
  }
  const table: CachedTable = { base, rates: data.rates, fetchedAt: Date.now() };
  await saveCache(table);
  return table;
};

export interface RateTableResult {
  rates: Record<string, number>;
  fetchedAt: number;
  stale: boolean;
}

/**
 * Full rate table for a base currency (one fetch shows every target's rate).
 * Fresh-cache → network → stale-cache, in that order.
 */
export const getRateTable = async (from: string): Promise<RateTableResult> => {
  const base = from.toUpperCase();

  const cached = await loadCache(base);
  if (cached && Date.now() - cached.fetchedAt < FRESH_MS) {
    return { rates: cached.rates, fetchedAt: cached.fetchedAt, stale: false };
  }

  try {
    const table = await fetchTable(base);
    return { rates: table.rates, fetchedAt: table.fetchedAt, stale: false };
  } catch (error) {
    if (cached) {
      return { rates: cached.rates, fetchedAt: cached.fetchedAt, stale: true };
    }
    throw error instanceof Error ? error : new Error('Could not fetch exchange rates.');
  }
};

/**
 * Rate to multiply a `from` amount by to get the `to` amount.
 * Fresh-cache → network → stale-cache, in that order.
 */
export const getExchangeRate = async (from: string, to: string): Promise<RateResult> => {
  const base = from.toUpperCase();
  const target = to.toUpperCase();
  if (base === target) return { rate: 1, fetchedAt: Date.now(), stale: false };

  const table = await getRateTable(base);
  const rate = table.rates[target];
  if (!rate) throw new Error(`No rate available for ${base} → ${target}.`);
  return { rate, fetchedAt: table.fetchedAt, stale: table.stale };
};

/** Round to the currency's minor unit (JPY/KRW have none). */
export const roundForCurrency = (value: number, currency: string): number => {
  const zeroDecimal = ['JPY', 'KRW', 'VND', 'CLP'].includes(currency.toUpperCase());
  return zeroDecimal ? Math.round(value) : Math.round(value * 100) / 100;
};
