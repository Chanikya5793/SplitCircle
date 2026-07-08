// Locale-aware currency formatting. Uses the device locale for grouping and
// symbol placement, and lets Intl pick the currency's own decimal rules so
// zero-decimal currencies (JPY, KRW) render correctly instead of "¥1,000.00".
// Passing `undefined` as the locale = the runtime's default (device) locale.

export const formatCurrency = (value: number, currency = 'USD'): string => {
  // Fix negative zero and small epsilon issues
  let safeValue = value;
  if (Math.abs(value) < 0.005) {
    safeValue = 0;
  }

  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
    }).format(safeValue);
  } catch (error) {
    // Fallback for invalid currency codes
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
    }).format(safeValue);
  }
};

export const sumAmounts = (values: number[]): number =>
  values.reduce((acc, current) => acc + current, 0);

export const getCurrencySymbol = (currency = 'USD'): string => {
  try {
    const parts = new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value ?? '$';
  } catch {
    return '$';
  }
};
