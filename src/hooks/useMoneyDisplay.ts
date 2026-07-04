// Guard-aware currency formatting for display components. Identical to
// formatCurrency until the privacy guard's "expenses" shield trips, then
// every amount renders redacted. Components re-render via the guard context.

import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { formatCurrency } from '@/utils/currency';
import { useCallback } from 'react';

export const useMoneyDisplay = () => {
  const { isShielded, action } = usePrivacyGuard();
  const shielded = isShielded('expenses');

  return useCallback(
    (value: number, currency?: string): string => {
      if (shielded) return action === 'vanish' ? '···' : '••••';
      return formatCurrency(value, currency);
    },
    [shielded, action],
  );
};
