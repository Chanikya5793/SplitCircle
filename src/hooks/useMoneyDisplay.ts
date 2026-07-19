// Guard-aware currency formatting for display components. Identical to
// formatCurrency until either lens kicks in:
//  - Display-currency conversion (per-group, user-chosen): the value is
//    multiplied by the active rate and rendered as "≈ <target>" so converted
//    figures are visibly estimates, never mistaken for the ledger.
//  - Privacy guard "expenses" shield: amounts render per the configured style —
//    dots (••••), zeros, or decoy (fake-but-plausible, deterministic per value).
// Pass the groupId when the amount belongs to an expense group so both the
// conversion lens and All/Only/Except guard scopes apply.

import { useDisplayCurrency } from '@/context/DisplayCurrencyContext';
import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { decoyAmount } from '@/services/privacyGuardService';
import { formatCurrency } from '@/utils/currency';
import { useCallback } from 'react';

export const useMoneyDisplay = (groupId?: string) => {
  const { isShielded, action, settings, duress } = usePrivacyGuard();
  const { getConversion } = useDisplayCurrency();
  const shielded = isShielded('expenses', groupId);

  return useCallback(
    (value: number, currency?: string): string => {
      const conversion = groupId ? getConversion(groupId, currency) : null;
      const displayValue = conversion ? value * conversion.rate : value;
      const displayCurrency = conversion ? conversion.target : currency;

      if (!shielded) {
        const formatted = formatCurrency(displayValue, displayCurrency);
        return conversion ? `≈${formatted}` : formatted;
      }
      // Duress decoy world: dots/zeros/'···' on screen would betray the fake
      // unlock, so amounts always render as the consistent scaled ledger.
      if (duress) {
        return formatCurrency(decoyAmount(displayValue, groupId ?? 'global'), displayCurrency);
      }
      if (action === 'vanish') return '···';
      switch (settings.amountStyle) {
        case 'zeros':
          return formatCurrency(0, displayCurrency);
        case 'decoy':
          return formatCurrency(decoyAmount(displayValue, groupId ?? 'global'), displayCurrency);
        default:
          return '••••';
      }
    },
    [shielded, duress, action, settings.amountStyle, groupId, getConversion],
  );
};
