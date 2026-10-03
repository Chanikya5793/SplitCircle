import {
  isMeteredAdvancedSplitVariant,
  normalizeMonetizationOperationId,
  requiresAdvancedSplitAuthorizationOnSave,
} from '@/utils/monetizationUsage';
import { describe, expect, it } from 'vitest';

describe('monetization usage instrumentation', () => {
  it('normalizes UI and legacy Siri operation ids to the server UUID contract', () => {
    const uuid = '6A0F59D4-88A4-4A5D-923B-97AFEAF5B814';
    expect(normalizeMonetizationOperationId(uuid)).toBe(uuid.toLowerCase());
    expect(normalizeMonetizationOperationId(`siri-${uuid}`)).toBe(uuid.toLowerCase());
    expect(normalizeMonetizationOperationId('expense-123')).toBeNull();
    expect(normalizeMonetizationOperationId('')).toBeNull();
  });

  it('meters deterministic advanced tools while excluding basic and uncleared games', () => {
    expect(isMeteredAdvancedSplitVariant('itemized')).toBe(true);
    expect(isMeteredAdvancedSplitVariant('income')).toBe(true);
    expect(isMeteredAdvancedSplitVariant('equal')).toBe(false);
    expect(isMeteredAdvancedSplitVariant('gamified')).toBe(false);
  });

  it('requires authorization for eligible advanced splits on both create and edit saves', () => {
    expect(requiresAdvancedSplitAuthorizationOnSave('itemized')).toBe(true);
    expect(requiresAdvancedSplitAuthorizationOnSave('itemized', 'expense-being-edited')).toBe(true);
    expect(requiresAdvancedSplitAuthorizationOnSave('equal')).toBe(false);
    expect(requiresAdvancedSplitAuthorizationOnSave('equal', 'expense-being-edited')).toBe(false);
  });
});
