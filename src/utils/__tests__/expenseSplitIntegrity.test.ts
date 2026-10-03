import {
  computeEqual,
  computeIncome,
  computeItemized,
  computeKarma,
  computePercentage,
  computeShares,
  computeStandardTimeBased,
  computeTimeBased,
  toCents,
} from '@/components/BillSplit/splitMath';
import type { Participant } from '@/components/BillSplit/types';
import { computeParticipantsFromSplitMetadata } from '@/utils/expenseSplit';
import {
  buildExpenseSplitMetadata,
  serializeSplitParticipantConfig,
} from '@/utils/expenseSplitMetadata';
import { describe, expect, it } from 'vitest';

const participant = (id: string, overrides: Partial<Participant> = {}): Participant => ({
  id,
  name: id.toUpperCase(),
  included: true,
  exactAmount: 0,
  percentage: 0,
  shares: 1,
  adjustment: 0,
  incomeWeight: 1,
  daysStayed: 1,
  partsConsumed: 0,
  rouletteWeight: 25,
  historicalPaid: 0,
  computedAmount: 0,
  ...overrides,
});

const allocatedCents = (participants: Participant[]): number => participants.reduce(
  (sum, entry) => sum + toCents(entry.computedAmount),
  0,
);

describe('advanced split monetary integrity', () => {
  it('allocates exact cents and always sums valid proportional methods to the total', () => {
    const total = 10.01;
    const expectedCents = toCents(total);

    const equal = computeEqual(total, [participant('a'), participant('b'), participant('c')]);
    expect(equal.map((entry) => entry.computedAmount)).toEqual([3.34, 3.34, 3.33]);

    const percentage = computePercentage(total, [
      participant('a', { percentage: 33.33 }),
      participant('b', { percentage: 33.33 }),
      participant('c', { percentage: 33.34 }),
    ]);
    const shares = computeShares(total, [
      participant('a', { shares: 1 }),
      participant('b', { shares: 2 }),
      participant('c', { shares: 3 }),
    ]);
    const income = computeIncome(total, [
      participant('a', { incomeWeight: 1 }),
      participant('b', { incomeWeight: 2 }),
      participant('c', { incomeWeight: 3 }),
    ]);
    const dynamicTime = computeTimeBased(total, [
      participant('a', { daysStayed: 1 }),
      participant('b', { daysStayed: 2 }),
      participant('c', { daysStayed: 3 }),
    ]);
    const standardTime = computeStandardTimeBased(total, 30, [
      participant('a', { daysStayed: 30 }),
      participant('b', { daysStayed: 20 }),
      participant('c', { daysStayed: 10 }),
    ]);
    const karma = computeKarma(total, [
      participant('a', { historicalPaid: 50 }),
      participant('b', { historicalPaid: 100 }),
      participant('c', { historicalPaid: 200 }),
    ], 0.75);

    for (const result of [equal, percentage, shares, income, dynamicTime, standardTime, karma]) {
      expect(allocatedCents(result)).toBe(expectedCents);
      expect(result.every((entry) => Number.isInteger(toCents(entry.computedAmount)))).toBe(true);
    }
  });

  it('preserves receipt tax and tip overrides across metadata rebuild and rehydration', () => {
    const participants = [participant('a'), participant('b')];
    const taxSplitConfig = { mode: 'percentage' as const, data: { a: 25, b: 75 } };
    const tipSplitConfig = { mode: 'shares' as const, data: { a: 1, b: 2 } };
    const metadata = buildExpenseSplitMetadata({
      method: 'itemized',
      participants,
      receiptItems: [{ id: 'meal', name: 'Meal', price: 10, assignedTo: ['a', 'b'] }],
      taxAmount: 1,
      taxSplitConfig,
      tipAmount: 0.03,
      tipSplitConfig,
    });

    expect(metadata.taxSplitConfig).toEqual(taxSplitConfig);
    expect(metadata.tipSplitConfig).toEqual(tipSplitConfig);
    expect(metadata.participantConfig).toEqual([
      { userId: 'a', included: true },
      { userId: 'b', included: true },
    ]);

    const direct = computeItemized(
      metadata.receiptItems ?? [],
      metadata.taxAmount ?? 0,
      metadata.tipAmount ?? 0,
      participants,
      metadata.taxSplitConfig,
      metadata.tipSplitConfig,
    );
    const rehydrated = computeParticipantsFromSplitMetadata(11.03, participants, metadata);

    expect(rehydrated.map((entry) => entry.computedAmount)).toEqual(
      direct.map((entry) => entry.computedAmount),
    );
    expect(allocatedCents(rehydrated)).toBe(1103);
  });

  it('stores normalized income weights without unrelated participant fields', () => {
    const configs = serializeSplitParticipantConfig('income', [
      participant('a', { incomeWeight: 50_000, historicalPaid: 900, exactAmount: 77 }),
      participant('b', { incomeWeight: 100_000, historicalPaid: 100, exactAmount: 23 }),
    ]);

    expect(configs[0]).toMatchObject({ userId: 'a', included: true });
    expect(configs[0].incomeWeight).toBeCloseTo(100 / 3, 12);
    expect(configs[1]).toMatchObject({ userId: 'b', included: true });
    expect(configs[1].incomeWeight).toBeCloseTo(200 / 3, 12);
    expect(configs.reduce((sum, config) => sum + (config.incomeWeight ?? 0), 0)).toBeCloseTo(100, 12);
    expect(configs.every((config) => !('historicalPaid' in config) && !('exactAmount' in config))).toBe(true);
  });

  it('rehydrates Double Wheel amounts from durable assignments with cent-safe rounding', () => {
    const participants = [participant('a'), participant('b'), participant('c')];
    const metadata = buildExpenseSplitMetadata({
      method: 'gamified',
      gamifiedMode: 'weightedRoulette',
      participants,
      weightedAssignments: [
        { userId: 'a', percentage: 33 },
        { userId: 'b', percentage: 33 },
        { userId: 'c', percentage: 34 },
      ],
    });

    const rehydrated = computeParticipantsFromSplitMetadata(10.01, participants, metadata);

    expect(rehydrated.map((entry) => entry.computedAmount)).toEqual([3.3, 3.3, 3.41]);
    expect(allocatedCents(rehydrated)).toBe(1001);
    expect(metadata.participantConfig.every((config) => !('percentage' in config))).toBe(true);
  });

  it('keeps legacy Double Wheel percentage-only records readable', () => {
    const participants = [
      participant('a', { percentage: 40 }),
      participant('b', { percentage: 60 }),
    ];
    const rehydrated = computeParticipantsFromSplitMetadata(10.01, participants, {
      version: 1,
      method: 'gamified',
      gamifiedMode: 'weightedRoulette',
      participantConfig: [
        { userId: 'a', included: true, percentage: 40 },
        { userId: 'b', included: true, percentage: 60 },
      ],
    });

    expect(rehydrated.map((entry) => entry.computedAmount)).toEqual([4, 6.01]);
    expect(allocatedCents(rehydrated)).toBe(1001);
  });

  it('persists only the inputs required by time and Karma modes', () => {
    const timed = serializeSplitParticipantConfig('timeBased', [participant('a', {
      daysStayed: 4,
      checkInDate: '2026-09-01',
      checkOutDate: '2026-09-04',
      selectedStayDates: ['2026-09-01', '2026-09-03'],
      incomeWeight: 999,
    })]);
    const karma = serializeSplitParticipantConfig('gamified', [
      participant('a', { historicalPaid: 125, percentage: 60 }),
    ], 'scrooge');

    expect(timed).toEqual([{
      userId: 'a',
      included: true,
      daysStayed: 4,
      checkInDate: '2026-09-01',
      checkOutDate: '2026-09-04',
      selectedStayDates: ['2026-09-01', '2026-09-03'],
    }]);
    expect(karma).toEqual([{ userId: 'a', included: true, historicalPaid: 125 }]);
  });
});
