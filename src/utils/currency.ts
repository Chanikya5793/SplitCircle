export const formatCurrency = (value: number, currency = 'USD'): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value);

export const sumAmounts = (values: number[]): number =>
  values.reduce((acc, current) => acc + current, 0);
