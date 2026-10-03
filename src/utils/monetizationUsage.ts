import type { ExpenseSplitMetadata } from '@/models';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ELIGIBLE_ADVANCED_SPLIT_VARIANTS = new Set<ExpenseSplitMetadata['method']>([
  'itemized',
  'income',
  'consumption',
  'timeBased',
  'itemType',
]);

export const isMeteredAdvancedSplitVariant = (
  method: ExpenseSplitMetadata['method'],
): method is 'itemized' | 'income' | 'consumption' | 'timeBased' | 'itemType' =>
  ELIGIBLE_ADVANCED_SPLIT_VARIANTS.has(method);

/**
 * Saving is the billable completion boundary. It applies equally to a newly
 * created expense and to an edited expense that is saved with an eligible
 * advanced split, so edit mode must never become an implicit quota bypass.
 */
export const requiresAdvancedSplitAuthorizationOnSave = (
  method: ExpenseSplitMetadata['method'],
  _expenseId?: string,
): boolean => isMeteredAdvancedSplitVariant(method);

/**
 * The shadow endpoint requires UUID v4 operation ids. UI mutations already
 * use bare UUIDs, while the native Siri queue historically prefixes the same
 * UUID with `siri-`. Normalize only those two known forms so retries remain
 * deterministic and malformed ids never poison the durable usage queue.
 */
export const normalizeMonetizationOperationId = (value: string): string | null => {
  const trimmed = value.trim();
  if (UUID_V4_PATTERN.test(trimmed)) return trimmed.toLowerCase();

  const siriCandidate = trimmed.replace(/^siri-/i, '');
  return siriCandidate !== trimmed && UUID_V4_PATTERN.test(siriCandidate)
    ? siriCandidate.toLowerCase()
    : null;
};
