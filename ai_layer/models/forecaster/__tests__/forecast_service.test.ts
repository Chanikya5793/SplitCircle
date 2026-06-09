/**
 * forecast_service.test.ts — pure ML.FORECAST row mapper (MODEL-02).
 */

import { describe, it, expect } from 'vitest';
import { mapForecastRows, toMonth, type ForecastRow } from '../forecast_service';

describe('toMonth', () => {
  it('handles BigQuery {value} timestamps and strings', () => {
    expect(toMonth({ value: '2026-07-01T00:00:00Z' })).toBe('2026-07');
    expect(toMonth('2026-12-01 00:00:00 UTC')).toBe('2026-12');
    expect(toMonth(undefined)).toBe('');
  });
});

describe('mapForecastRows', () => {
  it('maps rows, coerces strings, and clamps intervals at 0', () => {
    const rows: ForecastRow[] = [
      { user_id: 'u1', forecast_timestamp: { value: '2026-07-01T00:00:00Z' }, forecast_value: 123.456, prediction_interval_lower_bound: -5, prediction_interval_upper_bound: '180.1' },
    ];
    expect(mapForecastRows(rows)).toEqual([
      { userId: 'u1', month: '2026-07', predicted: 123.46, lower: 0, upper: 180.1 },
    ]);
  });

  it('drops rows without a user_id and tolerates junk', () => {
    expect(mapForecastRows([{ forecast_value: 10 } as ForecastRow])).toEqual([]);
    expect(mapForecastRows(undefined as any)).toEqual([]);
  });
});
