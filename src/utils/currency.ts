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

// Hermes' Intl has no `NumberFormat.formatToParts`, so reading the symbol from
// the parts threw and every currency fell back to "$" — an INR group's split
// editor showed "$" beside each amount. Strip the number out of a formatted
// zero instead, which works on every engine and keeps the locale's own symbol
// ("₹", "€", "CHF", "CA$").
export const getCurrencySymbol = (currency = 'USD'): string => {
  try {
    const symbol = formatCurrency(0, currency || 'USD')
      .replace(/[\d.,'\s\u00a0\u202f\u2212-]/g, '');
    return symbol || currency || '$';
  } catch {
    return currency || '$';
  }
};
