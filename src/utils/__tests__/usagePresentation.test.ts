import { describe, expect, it } from 'vitest';
import type { MonetizationFeatureUsage } from '@/models/monetization';
import {
  computeLocalActivity,
  describeLedgerItem,
  formatUsageDay,
  meterView,
  summarizeDaily,
} from '../usagePresentation';

const NOW = new Date(2026, 9, 9, 12, 0).getTime();

const feature = (overrides: Partial<MonetizationFeatureUsage>): MonetizationFeatureUsage => ({
  featureId: 'ai.expense_on_device_turn',
  label: 'AI assistant messages',
  unit: { one: 'message', other: 'messages' },
  rule: { kind: 'metered', limit: 3, cadence: 'day' },
  used: 1,
  reserved: 0,
  limit: 3,
  remaining: 2,
  windowStartMs: null,
  resetsAt: NOW + 2 * 3_600_000,
  creditCost: null,
  previews: null,
  ...overrides,
});

describe('usage meters', () => {
  it('counts in-flight reservations so the bar never under-reports', () => {
    const view = meterView(feature({ used: 1, reserved: 1, remaining: 1 }), NOW);
    expect(view.headline).toBe('2 of 3 used');
    expect(view.tone).toBe('normal');
    expect(view.detail).toBe('Resets in 2 hours');
  });

  it('flags the last uses and a spent allowance in words, not only color', () => {
    expect(meterView(feature({ limit: 10, used: 8, remaining: 2 }), NOW).tone).toBe('nearLimit');
    const spent = meterView(feature({ used: 3, remaining: 0 }), NOW);
    expect(spent).toMatchObject({ tone: 'usedUp', headline: 'All 3 used', overage: 'More with a higher plan' });
    expect(meterView(feature({ used: 3, remaining: 0, creditCost: 2 }), NOW).overage)
      .toBe('Then 2 credits each, with your OK');
  });

  it('never draws a bar for an unlimited allowance', () => {
    const view = meterView(feature({ rule: { kind: 'unlimited_local' }, limit: null, remaining: null, used: 14 }), NOW);
    expect(view).toMatchObject({ fraction: null, tone: 'unlimited', headline: '14 messages this period' });
  });
});

describe('30-day summary', () => {
  it('totals days and features and finds the busiest day', () => {
    const summary = summarizeDaily([
      { day: '2026-10-07', counts: { 'ai.expense_on_device_turn': 2 }, creditsSpent: 0 },
      { day: '2026-10-08', counts: {}, creditsSpent: 0 },
      { day: '2026-10-09', counts: { 'ai.expense_on_device_turn': 1, 'provider.security_check': 3 }, creditsSpent: 2 },
    ]);
    expect(summary).toMatchObject({ totalUses: 6, creditsSpent: 2, activeDays: 2, max: 4 });
    expect(summary.busiestDay).toEqual({ day: '2026-10-09', total: 4 });
    expect(summary.byFeature).toEqual([
      { featureId: 'ai.expense_on_device_turn', total: 3 },
      { featureId: 'provider.security_check', total: 3 },
    ]);
  });

  it('formats a UTC day key without drifting a day in western time zones', () => {
    expect(formatUsageDay('2026-10-01')).toMatch(/Oct 1$|^1 Oct$/);
  });
});

describe('credit history', () => {
  const labels = { 'provider.security_check': 'Link safety checks' };
  it('explains each ledger entry in plain words', () => {
    expect(describeLedgerItem({
      id: 'a', type: 'apple_credit_purchase', status: 'settled', creditDelta: 80,
      balanceAfter: 80, featureId: null, productId: 'p', createdAt: NOW,
    }, labels)).toMatchObject({ title: 'Bought Mana Credits', amount: '+80', direction: 'credit' });
    expect(describeLedgerItem({
      id: 'b', type: 'operation_reservation', status: 'spent', creditDelta: -2,
      balanceAfter: 78, featureId: 'provider.security_check', productId: null, createdAt: NOW,
    }, labels)).toMatchObject({ title: 'Link safety checks', amount: '−2', direction: 'debit' });
    expect(describeLedgerItem({
      id: 'c', type: 'operation_reservation', status: 'released', creditDelta: 0,
      balanceAfter: 80, featureId: 'provider.security_check', productId: null, createdAt: NOW,
    }, labels)).toMatchObject({ amount: '—', direction: 'none', note: 'Not charged — it didn’t complete' });
  });
});

describe('local activity', () => {
  it('counts only what this person paid or settled, this month vs last', () => {
    const monthStart = new Date(2026, 9, 1).getTime();
    const activity = computeLocalActivity([
      {
        hidden: false,
        updatedAt: NOW,
        expenses: [
          { paidBy: 'me', createdAt: monthStart + 1 },
          { paidBy: 'friend', createdAt: monthStart + 1 },
          { paidBy: 'me', createdAt: monthStart - 5 * 86_400_000 },
        ],
        settlements: [{ fromUserId: 'friend', toUserId: 'me', createdAt: monthStart + 10 }],
      },
      { hidden: true, updatedAt: NOW, expenses: [{ paidBy: 'me', createdAt: monthStart + 1 }], settlements: [] },
    ] as never, 'me', NOW);
    expect(activity).toEqual({
      expensesThisMonth: 1,
      expensesLastMonth: 1,
      settlementsThisMonth: 1,
      activeGroups: 1,
    });
  });
});
