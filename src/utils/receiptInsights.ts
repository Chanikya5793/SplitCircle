/**
 * receiptInsights.ts — pure helper to turn stored ReceiptInsights into labeled
 * display rows for the Expense Details "More info" section. No RN imports.
 */

import type { ReceiptInsights } from '@/models/expense';

export interface InsightRow {
  label: string;
  value: string;
}

/**
 * Build display rows from receipt insights, in a stable order, skipping empty
 * fields. `formatSavings` formats the savings amount in the group's currency.
 */
export const buildReceiptInsightRows = (
  insights: ReceiptInsights | null | undefined,
  formatSavings: (amount: number) => string,
): InsightRow[] => {
  if (!insights) return [];
  const rows: InsightRow[] = [];
  if (insights.merchantAddress?.trim()) rows.push({ label: 'Address', value: insights.merchantAddress.trim() });
  if (insights.merchantPhone?.trim()) rows.push({ label: 'Phone', value: insights.merchantPhone.trim() });
  if (insights.paymentMethod?.trim()) rows.push({ label: 'Payment', value: insights.paymentMethod.trim() });
  if (typeof insights.savings === 'number' && Number.isFinite(insights.savings) && insights.savings > 0) {
    rows.push({ label: 'You saved', value: formatSavings(insights.savings) });
  }
  if (insights.returnPolicy?.trim()) rows.push({ label: 'Returns', value: insights.returnPolicy.trim() });
  return rows;
};
