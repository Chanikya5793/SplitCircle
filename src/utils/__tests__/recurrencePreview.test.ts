import { describe, expect, it } from 'vitest';
import { findNextOccurrenceAt, getRecurrenceSummary, normalizeRecurrenceRule } from '../recurrence';

describe('recurring schedule preview boundaries', () => {
  it('skips February for a bill on the 31st instead of claiming a month-end payment', () => {
    const start = Date.UTC(2026, 0, 31, 10);
    const rule = normalizeRecurrenceRule({ frequency: 'monthly', interval: 1, daysOfMonth: [31], timezoneOffsetMinutes: 0 }, start);
    expect(getRecurrenceSummary(rule)).toContain('31st');
    expect(findNextOccurrenceAt(rule, start, start)).toBe(Date.UTC(2026, 2, 31, 10));
  });
  it('preserves the saved cadence anchor for every two months', () => {
    const start = Date.UTC(2026, 0, 15, 10);
    const rule = normalizeRecurrenceRule({ frequency: 'monthly', interval: 2, daysOfMonth: [15], timezoneOffsetMinutes: 0 }, start);
    expect(findNextOccurrenceAt(rule, start, Date.UTC(2026, 1, 1))).toBe(Date.UTC(2026, 2, 15, 10));
  });
  it('uses selected weekdays and permits an occurrence exactly at the save boundary', () => {
    const start = Date.UTC(2026, 8, 21, 9);
    const rule = normalizeRecurrenceRule({ frequency: 'weekly', interval: 1, weekdays: [1, 5], timezoneOffsetMinutes: 0 }, start);
    expect(findNextOccurrenceAt(rule, start, start - 1)).toBe(start);
    expect(findNextOccurrenceAt(rule, start, start)).toBe(Date.UTC(2026, 8, 25, 9));
  });
});
