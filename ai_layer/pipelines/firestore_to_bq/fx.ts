/**
 * fx.ts — Multi-currency normalization for the BigQuery warehouse (Open Question #5).
 *
 * DECISION: store BOTH the native amount/currency AND a normalized amount in a
 * single reporting currency, so cross-currency analytics (totals, forecasts) are
 * sound while the native value is preserved for display/audit.
 *
 * Rates are config-driven (env `FX_RATES`, a JSON map of ISO code -> units of the
 * base currency per 1 unit of that code) so this stays pure + testable and has no
 * network dependency; a production deploy points it at a daily FX table/job. An
 * unknown currency yields a NULL normalized amount (never a wrong number).
 */

export interface FxConfig {
  base: string;
  rates: Record<string, number>; // amount_base = amount * rates[currency]; rates[base] = 1
}

export interface NormalizedAmount {
  amount_normalized: number | null;
  normalized_currency: string;
  fx_rate: number | null;
}

/** Load FX config from env. `NORMALIZED_CURRENCY` (default USD) + `FX_RATES` JSON. */
export function loadFxConfig(): FxConfig {
  const base = (process.env.NORMALIZED_CURRENCY || 'USD').toUpperCase();
  let rates: Record<string, number> = {};
  try {
    const parsed = JSON.parse(process.env.FX_RATES || '{}');
    if (parsed && typeof parsed === 'object') rates = parsed as Record<string, number>;
  } catch {
    rates = {};
  }
  rates[base] = 1; // identity for the base currency
  return { base, rates };
}

/** PURE: convert a native amount into the base currency, or NULL if no rate. */
export function fxNormalize(amount: number, currency: string | undefined, cfg: FxConfig): NormalizedAmount {
  const cur = (currency || cfg.base).toUpperCase();
  const rate = cfg.rates[cur];
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    return { amount_normalized: null, normalized_currency: cfg.base, fx_rate: null };
  }
  return {
    amount_normalized: Number((amount * rate).toFixed(2)),
    normalized_currency: cfg.base,
    fx_rate: rate,
  };
}
