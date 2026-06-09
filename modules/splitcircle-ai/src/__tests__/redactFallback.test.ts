/**
 * redactFallback.test.ts — JS PII redaction fallback (parity with the server
 * redactPII and the iOS NSDataDetector behavior for the common cases).
 */

import { describe, it, expect } from 'vitest';
import { redactPIIFallback } from '../redactFallback';

describe('redactPIIFallback', () => {
  it('redacts emails and phone numbers', () => {
    expect(redactPIIFallback('pay sam.t+x@example.co.uk back')).toBe('pay [email] back');
    expect(redactPIIFallback('call +1 (415) 555-0199 re: rent')).toBe('call [phone] re: rent');
  });

  it('leaves dates, amounts, and normal text alone', () => {
    expect(redactPIIFallback('dinner 2026-05-10 was 1234.56')).toBe('dinner 2026-05-10 was 1234.56');
    expect(redactPIIFallback('how much on food this month?')).toBe('how much on food this month?');
  });

  it('handles empty input', () => {
    expect(redactPIIFallback('')).toBe('');
  });
});
