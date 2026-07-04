// Guard-aware currency formatting for display components. Identical to
// formatCurrency until the privacy guard's "expenses" shield trips, then
// amounts render per the configured style: dots (••••), zeros, or decoy
// (fake-but-plausible, deterministic per value). Pass the groupId when the
// amount belongs to an expense group so All/Only/Except scopes apply.

import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { decoyAmount } from '@/services/privacyGuardService';
import { formatCurrency } from '@/utils/currency';
import { useCallback } from 'react';

export const useMoneyDisplay = (groupId?: string) => {
  const { isShielded, action, settings } = usePrivacyGuard();
  const shielded = isShielded('expenses', groupId);

  return useCallback(
    (value: number, currency?: string): string => {
      if (!shielded) return formatCurrency(value, currency);
      if (action === 'vanish') return '···';
      switch (settings.amountStyle) {
        case 'zeros':
          return formatCurrency(0, currency);
        case 'decoy':
          return formatCurrency(decoyAmount(value), currency);
        default:
          return '••••';
      }
    },
    [shielded, action, settings.amountStyle],
  );
};
