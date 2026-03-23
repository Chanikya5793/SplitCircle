import {
  computeAdjustment,
  computeConsumption,
  computeEqual,
  computeExact,
  computeIncome,
  computeItemType,
  computeItemized,
  computeKarma,
  computePercentage,
  computeShares,
  computeStandardTimeBased,
  computeTimeBased,
  roundCents,
} from '@/components/BillSplit/splitMath';
import type { Participant } from '@/components/BillSplit/types';
import type {
  Expense,
  ExpenseSplitMetadata,
  ExpenseSplitMethod,
  ExpenseTimeSplitVariant,
  ParticipantShare,
  SplitType,
} from '@/models';

import { formatCurrency } from './currency';

const METHOD_LABELS: Record<ExpenseSplitMethod, string> = {
  equal: 'Equal',
  exact: 'Exact amounts',
  percentage: 'Percentages',
  shares: 'Shares',
  adjustment: 'Adjustments',
  itemized: 'Itemized receipt',
  income: 'By income',
  consumption: 'Consumption',
  timeBased: 'Time-based',
  gamified: 'Fun mode',
  itemType: 'By category',
};

const GAMIFIED_LABELS = {
  roulette: 'Credit card roulette',
  weightedRoulette: 'Weighted roulette',
  scrooge: 'Karma split',
} as const;

const TIME_VARIANT_LABELS: Record<ExpenseTimeSplitVariant, string> = {
  dynamic: 'Dynamic by days stayed',
  standard: 'Standard period proration',
};

export interface ExpenseSplitDetailRow {
  label: string;
  value: string;
}

export interface ExpenseSplitDetails {
  label: string;
  note: string;
  rows: ExpenseSplitDetailRow[];
}

function formatDateLabel(value?: string): string | null {
  if (!value) return null;

  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const day = Number(dayText);
  const date = new Date(year, monthIndex, day);

  if (
    Number.isNaN(date.getTime())
    || date.getFullYear() !== year
    || date.getMonth() !== monthIndex
    || date.getDate() !== day
  ) {
    return null;
  }

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function getLegacySplitLabel(splitType: SplitType): string {
  switch (splitType) {
    case 'equal':
      return 'Equal';
    case 'percentage':
      return 'Percentages';
    case 'shares':
      return 'Shares';
    case 'custom':
    default:
      return 'Custom amounts';
  }
}

function getMethodNote(metadata: ExpenseSplitMetadata): string {
  switch (metadata.method) {
    case 'equal':
      return 'Everyone included shares the total evenly.';
    case 'exact':
      return 'Each person had a manual amount saved for this expense.';
    case 'percentage':
      return 'Each share was calculated from saved percentages.';
    case 'shares':
      return 'Each share was calculated from saved share counts.';
    case 'adjustment':
      return 'The total was split from an even base with individual adjustments.';
    case 'itemized':
      return 'Receipt items, tax, and tip were used to build the final shares.';
    case 'income':
      return 'Shares were weighted using saved income inputs.';
    case 'consumption':
      return 'Shares were weighted using saved consumption amounts.';
    case 'timeBased':
      return metadata.timeSplitVariant === 'standard'
        ? 'The total was prorated across a shared period.'
        : 'The total was weighted by each person’s saved stay duration.';
    case 'gamified':
      switch (metadata.gamifiedMode) {
        case 'weightedRoulette':
          return 'A randomized percentage draw decided each person’s share.';
        case 'scrooge':
          return 'Past payment history was used to rebalance this split.';
        case 'roulette':
        default:
          return 'One saved draw picked who pays the full amount.';
      }
    case 'itemType':
      return 'Specific categories were excluded for some people before the remainder was shared.';
    default:
      return 'This expense uses a saved split configuration.';
  }
}

function withComputedAmounts(participants: Participant[], shares: ParticipantShare[]): Participant[] {
  const shareMap = Object.fromEntries(shares.map((entry) => [entry.userId, entry.share]));
  return participants.map((participant) => ({
    ...participant,
    computedAmount: roundCents(shareMap[participant.id] ?? 0),
  }));
}

export function getExpenseSplitLabel(expense: Pick<Expense, 'splitMetadata' | 'splitType'>): string {
  if (!expense.splitMetadata) {
    return getLegacySplitLabel(expense.splitType);
  }

  if (expense.splitMetadata.method === 'gamified') {
    return GAMIFIED_LABELS[expense.splitMetadata.gamifiedMode ?? 'roulette'];
  }

  if (expense.splitMetadata.method === 'timeBased' && expense.splitMetadata.timeSplitVariant) {
    return expense.splitMetadata.timeSplitVariant === 'standard'
      ? 'Time-based (standard)'
      : 'Time-based';
  }

  return METHOD_LABELS[expense.splitMetadata.method];
}

export function inferExpenseSplitMetadata(
  expense: Pick<Expense, 'amount' | 'participants' | 'splitMetadata' | 'splitType'>,
): ExpenseSplitMetadata {
  if (expense.splitMetadata) {
    return expense.splitMetadata;
  }

  const participantConfig = expense.participants.map((participant) => ({
    userId: participant.userId,
    included: true,
    exactAmount: participant.share,
    computedAmount: participant.share,
  }));

  if (expense.splitType === 'equal') {
    return {
      version: 1,
      method: 'equal',
      participantConfig,
    };
  }

  if (expense.splitType === 'percentage') {
    const percentageTotal = expense.participants.reduce((sum, participant) => sum + participant.share, 0);
    const looksLikePercentages = Math.abs(percentageTotal - 100) < 0.5;

    if (looksLikePercentages) {
      return {
        version: 1,
        method: 'percentage',
        participantConfig: expense.participants.map((participant) => ({
          userId: participant.userId,
          included: true,
          percentage: participant.share,
        })),
      };
    }
  }

  return {
    version: 1,
    method: 'exact',
    participantConfig,
  };
}

export function computeParticipantsFromSplitMetadata(
  amount: number,
  participants: Participant[],
  metadata?: ExpenseSplitMetadata,
): Participant[] {
  if (!metadata) {
    return participants;
  }

  switch (metadata.method) {
    case 'equal':
      return computeEqual(amount, participants);
    case 'exact':
      return computeExact(participants);
    case 'percentage':
      return computePercentage(amount, participants);
    case 'shares':
      return computeShares(amount, participants);
    case 'adjustment':
      return computeAdjustment(amount, participants);
    case 'itemized':
      return computeItemized(
        metadata.receiptItems ?? [],
        metadata.taxAmount ?? 0,
        metadata.tipAmount ?? 0,
        participants,
        metadata.taxSplitConfig,
        metadata.tipSplitConfig,
      );
    case 'income':
      return computeIncome(amount, participants);
    case 'consumption':
      return computeConsumption(amount, metadata.totalParts ?? 0, participants);
    case 'timeBased':
      return metadata.timeSplitVariant === 'standard'
        ? computeStandardTimeBased(amount, metadata.timePeriodDays ?? 1, participants)
        : computeTimeBased(amount, participants);
    case 'gamified':
      if (metadata.gamifiedMode === 'weightedRoulette') {
        return computePercentage(amount, participants);
      }

      if (metadata.gamifiedMode === 'scrooge') {
        return computeKarma(amount, participants, metadata.karmaIntensity ?? 0.5);
      }

      if (metadata.rouletteLoserId) {
        return participants.map((participant) => ({
          ...participant,
          computedAmount: participant.id === metadata.rouletteLoserId ? roundCents(amount) : 0,
        }));
      }

      return participants;
    case 'itemType':
      return computeItemType(amount, metadata.itemCategories ?? [], participants);
    default:
      return participants;
  }
}

export function toParticipantShares(participants: Participant[]): ParticipantShare[] {
  return participants
    .filter((participant) => participant.included)
    .map((participant) => ({
      userId: participant.id,
      share: roundCents(participant.computedAmount),
    }));
}

export function getExpenseSplitDetails(
  expense: Pick<Expense, 'amount' | 'participants' | 'splitMetadata' | 'splitType'>,
  memberMap: Record<string, string>,
  currency: string,
): ExpenseSplitDetails {
  const metadata = inferExpenseSplitMetadata(expense);
  const rows: ExpenseSplitDetailRow[] = [];
  const included = metadata.participantConfig.filter((participant) => participant.included);

  rows.push({
    label: 'People included',
    value: `${included.length}`,
  });

  switch (metadata.method) {
    case 'percentage':
      included.forEach((participant) => {
        rows.push({
          label: memberMap[participant.userId] || 'Unknown',
          value: `${participant.percentage ?? 0}%`,
        });
      });
      break;
    case 'shares':
      included.forEach((participant) => {
        const shareCount = participant.shares ?? 0;
        rows.push({
          label: memberMap[participant.userId] || 'Unknown',
          value: `${shareCount} ${shareCount === 1 ? 'share' : 'shares'}`,
        });
      });
      break;
    case 'adjustment':
      included.forEach((participant) => {
        rows.push({
          label: memberMap[participant.userId] || 'Unknown',
          value: `${participant.adjustment && participant.adjustment > 0 ? '+' : ''}${formatCurrency(participant.adjustment ?? 0, currency)}`,
        });
      });
      break;
    case 'itemized':
      rows.push({
        label: 'Items',
        value: `${metadata.receiptItems?.length ?? 0}`,
      });
      rows.push({
        label: 'Tax',
        value: formatCurrency(metadata.taxAmount ?? 0, currency),
      });
      rows.push({
        label: 'Tip',
        value: formatCurrency(metadata.tipAmount ?? 0, currency),
      });
      break;
    case 'income':
      included.forEach((participant) => {
        rows.push({
          label: memberMap[participant.userId] || 'Unknown',
          value: formatCurrency(participant.incomeWeight ?? 0, currency),
        });
      });
      break;
    case 'consumption':
      rows.push({
        label: 'Total parts',
        value: `${metadata.totalParts ?? 0}`,
      });
      included.forEach((participant) => {
        const parts = participant.partsConsumed ?? 0;
        rows.push({
          label: memberMap[participant.userId] || 'Unknown',
          value: `${parts} ${parts === 1 ? 'part' : 'parts'}`,
        });
      });
      break;
    case 'timeBased': {
      rows.push({
        label: 'Rule',
        value: TIME_VARIANT_LABELS[metadata.timeSplitVariant ?? 'dynamic'],
      });

      const startLabel = formatDateLabel(metadata.timePeriodStartDate);
      const endLabel = formatDateLabel(metadata.timePeriodEndDate);
      if (startLabel && endLabel) {
        rows.push({
          label: 'Period',
          value: `${startLabel} - ${endLabel}`,
        });
      } else if (metadata.timePeriodDays) {
        rows.push({
          label: 'Period length',
          value: `${metadata.timePeriodDays} ${metadata.timePeriodDays === 1 ? 'day' : 'days'}`,
        });
      }

      included.forEach((participant) => {
        const savedDays = participant.selectedStayDates?.length ?? participant.daysStayed ?? 0;
        rows.push({
          label: memberMap[participant.userId] || 'Unknown',
          value: `${savedDays} ${savedDays === 1 ? 'day' : 'days'}`,
        });
      });
      break;
    }
    case 'gamified':
      if (metadata.gamifiedMode === 'weightedRoulette') {
        (metadata.weightedAssignments ?? []).forEach((assignment) => {
          rows.push({
            label: memberMap[assignment.userId] || 'Unknown',
            value: `${assignment.percentage}%`,
          });
        });
      } else if (metadata.gamifiedMode === 'scrooge') {
        const intensity = metadata.karmaIntensity ?? 0.5;
        const intensityLabel = intensity >= 1 ? 'Full' : intensity >= 0.75 ? 'Strong' : intensity >= 0.5 ? 'Moderate' : 'Gentle';
        rows.push({
          label: 'Intensity',
          value: intensityLabel,
        });
      } else if (metadata.rouletteLoserId) {
        rows.push({
          label: 'Selected payer',
          value: memberMap[metadata.rouletteLoserId] || 'Unknown',
        });
      }
      break;
    case 'itemType':
      (metadata.itemCategories ?? []).forEach((category) => {
        const excludedNames = category.excludedParticipants
          .map((userId) => memberMap[userId] || 'Unknown')
          .join(', ');
        rows.push({
          label: category.label,
          value: excludedNames
            ? `${formatCurrency(category.amount, currency)} · excludes ${excludedNames}`
            : formatCurrency(category.amount, currency),
        });
      });
      break;
    case 'equal':
    case 'exact':
    default:
      break;
  }

  const note = expense.splitMetadata
    ? getMethodNote(metadata)
    : expense.splitType === 'custom'
      ? 'This expense only saved the final shares, so the original advanced mode is not fully recoverable.'
      : getMethodNote(metadata);

  return {
    label: getExpenseSplitLabel(expense),
    note,
    rows,
  };
}

export function computeSharesFromExpenseSplit(
  amount: number,
  participants: Participant[],
  metadata?: ExpenseSplitMetadata,
): ParticipantShare[] {
  return toParticipantShares(computeParticipantsFromSplitMetadata(amount, participants, metadata));
}

export function syncParticipantsWithShares(
  participants: Participant[],
  shares: ParticipantShare[],
): Participant[] {
  return withComputedAmounts(participants, shares);
}
