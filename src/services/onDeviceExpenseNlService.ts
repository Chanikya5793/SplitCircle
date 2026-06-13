/**
 * onDeviceExpenseNlService.ts — natural-language expense entry via Apple
 * Foundation Models. Turns "$40 dinner with Alice & Bob, split equally" into a
 * resolved expense draft, fully on-device.
 */

import { getOnDeviceAiAvailability, parseExpenseFromText } from '../../modules/splitcircle-ai';
import { mapNlExpense, type NlMember, type NlParsedExpense } from '@/utils/expenseNlParse';

export type { NlParsedExpense };

export const isOnDeviceExpenseNlAvailable = (): boolean =>
  getOnDeviceAiAvailability() === 'available';

/**
 * Parse `text` into a resolved expense draft. Throws when the model is
 * unavailable — callers gate on `isOnDeviceExpenseNlAvailable()` first.
 */
export const parseExpenseFromTextOnDevice = async (
  text: string,
  members: readonly NlMember[],
  currentUserId: string,
): Promise<NlParsedExpense> => {
  const memberNames = members.map((m) => m.displayName).filter(Boolean).join(', ');
  const currentUserName = members.find((m) => m.userId === currentUserId)?.displayName ?? 'me';
  const raw = await parseExpenseFromText(text.trim(), memberNames, currentUserName);
  return mapNlExpense(raw, members, currentUserId);
};
