import type { ParticipantShare, SplitType } from '@/models';

export const computeSplit = (
  amount: number,
  splitType: SplitType,
  participantIds: string[],
  customShares?: ParticipantShare[],
): ParticipantShare[] => {
  if (splitType === 'custom' && customShares?.length) {
    return customShares;
  }

  if (splitType === 'percentage' && customShares?.length) {
    return customShares.map((entry) => ({
      ...entry,
      share: (entry.share / 100) * amount,
    }));
  }

  const perHead = amount / participantIds.length;
  return participantIds.map((userId) => ({
    userId,
    share: Number(perHead.toFixed(2)),
  }));
};
