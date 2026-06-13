/**
 * onDeviceCategoryService.ts — on-device expense categorization via Apple
 * Foundation Models. Returns a category snapped onto the app's canonical list,
 * with the caller's keyword fallback when the model is unavailable or unsure.
 */

import { getOnDeviceAiAvailability, suggestExpenseCategory } from '../../modules/splitcircle-ai';
import { coerceCategory, EXPENSE_CATEGORIES } from '@/utils/categoryMatch';

export const isOnDeviceCategorizationAvailable = (): boolean =>
  getOnDeviceAiAvailability() === 'available';

/**
 * Suggest a category for `text`, validated against the canonical list. Returns
 * `fallback` if the model is unavailable or errors. Never throws.
 */
export const suggestCategoryOnDevice = async (
  text: string,
  fallback: string = 'General',
): Promise<string> => {
  const trimmed = (text ?? '').trim();
  if (!trimmed || !isOnDeviceCategorizationAvailable()) return fallback;
  try {
    const raw = await suggestExpenseCategory(trimmed.slice(0, 500));
    return coerceCategory(raw, fallback, EXPENSE_CATEGORIES);
  } catch {
    return fallback;
  }
};
