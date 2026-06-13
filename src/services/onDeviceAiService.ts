/**
 * onDeviceAiService.ts — Ask AI powered by Apple's on-device Foundation Models
 * (Apple Intelligence, iOS 26+). No backend, no API bill, nothing leaves the
 * phone: the group's embedded expenses are ranked locally and handed to the
 * on-device LLM as numbered, citable context.
 *
 * Returns the same `ExpenseAiAnswer` shape as the cloud `askExpenseAi`
 * callable so the UI renders both paths identically. Eligibility (iPhone 15
 * Pro+/Apple Intelligence) is exposed via `getOnDeviceAiAvailability` so the
 * UI can show a precise note on unsupported devices.
 */

import {
  askOnDevice,
  donateAskActivity,
  getOnDeviceAiAvailability,
  getOnDeviceContextSize,
  type OnDeviceAiAvailability,
} from '../../modules/splitcircle-ai';
import type { Group } from '@/models';
import type { ExpenseAiAnswer } from '@/services/aiService';
import {
  buildExpenseContext,
  maxExpensesForContext,
  resolveCitedExpenses,
} from '@/utils/onDeviceAiContext';

export type { OnDeviceAiAvailability };
export { getOnDeviceAiAvailability };

/** Human copy for each unavailability reason (the "sorry" notes). */
export const ON_DEVICE_UNAVAILABLE_COPY: Record<Exclude<OnDeviceAiAvailability, 'available'>, string> = {
  deviceNotEligible:
    "Sorry — the assistant runs entirely on your iPhone using Apple Intelligence, which needs an iPhone 15 Pro or newer. Your expenses still work exactly as before.",
  appleIntelligenceNotEnabled:
    'Apple Intelligence is turned off. Enable it in Settings → Apple Intelligence & Siri, then come back — answers are generated on your device.',
  modelNotReady:
    "Apple's on-device model is still downloading. Leave your iPhone on Wi-Fi and charging, then try again in a few minutes.",
  unsupportedOS:
    'Sorry — the assistant needs iOS 26 or later on an Apple Intelligence-capable iPhone (15 Pro or newer).',
};

/**
 * Ask the on-device model about this group's expenses. Throws on failure —
 * callers gate on `getOnDeviceAiAvailability() === 'available'` first.
 */
export async function askExpenseAiOnDevice(
  question: string,
  group: Group,
): Promise<ExpenseAiAnswer> {
  const members = group.members.map((m) => ({ userId: m.userId, displayName: m.displayName }));

  // Adapt how much history we ground in to the device's real context window:
  // iPhone Air / 17 Pro auto-run Apple's larger "Core Advanced" on-device model
  // and report a bigger window, so they get more expenses → fuller answers.
  const maxLines = maxExpensesForContext(getOnDeviceContextSize());
  const { context, selected } = buildExpenseContext(
    group.expenses,
    question,
    members,
    group.currency,
    maxLines,
  );

  if (selected.length === 0) {
    return {
      answer: "This group doesn't have any expenses yet, so there's nothing to ask about. Add a few and try again!",
      sources: [],
      confidence: 1,
    };
  }

  const result = await askOnDevice(question, context);
  const cited = resolveCitedExpenses(result.sourceIndexes ?? [], selected);
  const nameOf = new Map(members.map((m) => [m.userId, m.displayName]));

  // The on-device model doesn't self-report calibrated confidence; ground it
  // in citation behavior instead (cited answers are checkable by the user).
  const confidence = cited.length > 0 ? Math.min(0.9, 0.5 + 0.1 * cited.length) : 0.35;

  // Same Siri/Spotlight donation as the cloud path (fire-and-forget).
  void donateAskActivity(question);

  return {
    answer: result.answer,
    sources: cited.map((e) => ({
      expenseId: e.expenseId,
      groupId: e.groupId,
      title: e.title,
      category: e.category,
      amount: e.amount,
      currency: group.currency,
      paidByName: nameOf.get(e.paidBy),
      createdAt: e.createdAt,
    })),
    confidence,
  };
}
