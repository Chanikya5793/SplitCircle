import type { Participant } from '@/components/BillSplit/types';
import type {
  ExpenseGamifiedMode,
  ExpenseItemCategory,
  ExpenseItemSplitConfig,
  ExpenseReceiptItem,
  ExpenseSplitMetadata,
  ExpenseSplitMethod,
  ExpenseSplitParticipantConfig,
  ExpenseTimeSplitVariant,
  ExpenseWeightedAssignment,
} from '@/models';

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Persist only inputs that are needed to reconstruct the selected method.
 * The legacy `incomeWeight` key remains for compatibility, but its value is a
 * normalized percentage weight so a literal salary never has to be stored on
 * the expense and the value remains understandable when the editor reopens.
 */
export function serializeSplitParticipantConfig(
  method: ExpenseSplitMethod,
  participants: Participant[],
  gamifiedMode?: ExpenseGamifiedMode,
): ExpenseSplitParticipantConfig[] {
  const incomeTotal = method === 'income'
    ? participants.reduce((sum, participant) => sum + Math.max(0, finiteOrZero(participant.incomeWeight)), 0)
    : 0;

  return participants.map((participant) => {
    const common: ExpenseSplitParticipantConfig = {
      userId: participant.id,
      included: participant.included,
    };

    switch (method) {
      case 'exact':
        return { ...common, exactAmount: finiteOrZero(participant.exactAmount) };
      case 'percentage':
        return { ...common, percentage: finiteOrZero(participant.percentage) };
      case 'shares':
        return { ...common, shares: finiteOrZero(participant.shares) };
      case 'adjustment':
        return { ...common, adjustment: finiteOrZero(participant.adjustment) };
      case 'income':
        return {
          ...common,
          incomeWeight: incomeTotal > 0
            ? (Math.max(0, finiteOrZero(participant.incomeWeight)) / incomeTotal) * 100
            : 0,
        };
      case 'consumption':
        return { ...common, partsConsumed: finiteOrZero(participant.partsConsumed) };
      case 'timeBased':
        return {
          ...common,
          daysStayed: finiteOrZero(participant.daysStayed),
          ...(participant.checkInDate ? { checkInDate: participant.checkInDate } : {}),
          ...(participant.checkOutDate ? { checkOutDate: participant.checkOutDate } : {}),
          ...(participant.selectedStayDates?.length
            ? { selectedStayDates: [...participant.selectedStayDates] }
            : {}),
        };
      case 'gamified':
        return gamifiedMode === 'scrooge'
          ? { ...common, historicalPaid: finiteOrZero(participant.historicalPaid) }
          : common;
      case 'equal':
      case 'itemized':
      case 'itemType':
      default:
        return common;
    }
  });
}

export interface BuildExpenseSplitMetadataInput {
  method: ExpenseSplitMethod;
  participants: Participant[];
  receiptItems?: ExpenseReceiptItem[];
  taxAmount?: number;
  taxSplitConfig?: ExpenseItemSplitConfig;
  tipAmount?: number;
  tipSplitConfig?: ExpenseItemSplitConfig;
  totalParts?: number;
  timeSplitVariant?: ExpenseTimeSplitVariant;
  timePeriodDays?: number;
  timePeriodStartDate?: string;
  timePeriodEndDate?: string;
  gamifiedMode?: ExpenseGamifiedMode;
  rouletteLoserId?: string;
  weightedAssignments?: ExpenseWeightedAssignment[];
  karmaIntensity?: number;
  itemCategories?: ExpenseItemCategory[];
}

/** Build the durable metadata for one completed split editor session. */
export function buildExpenseSplitMetadata({
  method,
  participants,
  receiptItems,
  taxAmount,
  taxSplitConfig,
  tipAmount,
  tipSplitConfig,
  totalParts,
  timeSplitVariant,
  timePeriodDays,
  timePeriodStartDate,
  timePeriodEndDate,
  gamifiedMode,
  rouletteLoserId,
  weightedAssignments,
  karmaIntensity,
  itemCategories,
}: BuildExpenseSplitMetadataInput): ExpenseSplitMetadata {
  return {
    version: 1,
    method,
    participantConfig: serializeSplitParticipantConfig(method, participants, gamifiedMode),
    ...(method === 'itemized' ? {
      receiptItems: receiptItems ?? [],
      taxAmount: finiteOrZero(taxAmount ?? 0),
      ...(taxSplitConfig ? { taxSplitConfig } : {}),
      tipAmount: finiteOrZero(tipAmount ?? 0),
      ...(tipSplitConfig ? { tipSplitConfig } : {}),
    } : {}),
    ...(method === 'consumption' ? { totalParts: finiteOrZero(totalParts ?? 0) } : {}),
    ...(method === 'timeBased' ? {
      timeSplitVariant: timeSplitVariant ?? 'dynamic',
      timePeriodDays: finiteOrZero(timePeriodDays ?? 0),
      ...(timePeriodStartDate ? { timePeriodStartDate } : {}),
      ...(timePeriodEndDate ? { timePeriodEndDate } : {}),
    } : {}),
    ...(method === 'gamified' ? {
      gamifiedMode: gamifiedMode ?? 'roulette',
      ...(gamifiedMode === 'roulette' && rouletteLoserId ? { rouletteLoserId } : {}),
      ...(gamifiedMode === 'weightedRoulette' ? {
        weightedAssignments: (weightedAssignments ?? []).map((assignment) => ({ ...assignment })),
      } : {}),
      ...(gamifiedMode === 'scrooge' ? { karmaIntensity: finiteOrZero(karmaIntensity ?? 0.5) } : {}),
    } : {}),
    ...(method === 'itemType' ? {
      itemCategories: (itemCategories ?? []).map((category) => ({
        ...category,
        excludedParticipants: [...category.excludedParticipants],
      })),
    } : {}),
  };
}
