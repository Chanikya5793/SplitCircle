export const formatCurrency = (value: number, currency = 'USD'): string => {
  // Fix negative zero and small epsilon issues
  let safeValue = value;
  if (Math.abs(value) < 0.005) {
    safeValue = 0;
  }

  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
    }).format(safeValue);
  } catch (error) {
    // Fallback for invalid currency codes
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(safeValue);
  }
};

export const sumAmounts = (values: number[]): number =>
  values.reduce((acc, current) => acc + current, 0);
