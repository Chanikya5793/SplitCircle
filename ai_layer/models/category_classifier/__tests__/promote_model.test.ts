/**
 * promote_model.test.ts — the pure promotion-gate decision (no BigQuery).
 */

import { describe, it, expect, vi } from 'vitest';

// Avoid loading the real BigQuery client when importing the module.
vi.mock('@google-cloud/bigquery', () => ({ BigQuery: class {} }));

import { evaluateGate } from '../promote_model';

describe('evaluateGate', () => {
  it('passes when accuracy and f1 clear the bar', () => {
    const g = evaluateGate({ accuracy: 0.84, f1_score: 0.71 });
    expect(g.pass).toBe(true);
    expect(g.reasons).toEqual([]);
    expect(g.accuracy).toBe(0.84);
  });

  it('fails and explains when accuracy is below the bar', () => {
    const g = evaluateGate({ accuracy: 0.72, f1_score: 0.71 });
    expect(g.pass).toBe(false);
    expect(g.reasons[0]).toMatch(/accuracy 0.720 < 0.8/);
  });

  it('fails on weak macro f1 even with acceptable accuracy', () => {
    const g = evaluateGate({ accuracy: 0.9, f1_score: 0.4 });
    expect(g.pass).toBe(false);
    expect(g.reasons.some((r) => r.includes('f1'))).toBe(true);
  });

  it('coerces string metrics and missing fields to 0 (fails closed)', () => {
    const g = evaluateGate({ accuracy: '0.81' as any });
    expect(g.accuracy).toBe(0.81);
    expect(g.f1).toBe(0);
    expect(g.pass).toBe(false);
  });

  it('honors custom thresholds', () => {
    expect(evaluateGate({ accuracy: 0.7, f1_score: 0.7 }, 0.65, 0.65).pass).toBe(true);
  });
});
