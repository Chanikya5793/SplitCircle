/**
 * embedding_text.test.ts — buildEmbeddingText + redactPII (PII, Critical Rule #3).
 * Free text (title/notes) must never carry emails or phone numbers into Vertex.
 */

import { describe, it, expect } from 'vitest';
import { buildEmbeddingText, redactPII } from '../embedding/embedding_client';

describe('redactPII', () => {
  it('redacts email addresses', () => {
    expect(redactPII('pay sam.t+x@example.co.uk back')).toBe('pay [email] back');
  });

  it('redacts phone-like sequences (9+ digits, separators allowed)', () => {
    expect(redactPII('call +1 (415) 555-0199 re: rent')).toBe('call [phone] re: rent');
    expect(redactPII('venmo 4155550199')).toBe('venmo [phone]');
  });

  it('leaves dates and amounts alone (fewer than 9 digits)', () => {
    expect(redactPII('dinner 2026-05-10 was 1234.56')).toBe('dinner 2026-05-10 was 1234.56');
  });
});

describe('buildEmbeddingText', () => {
  it('composes the standard recall text', () => {
    const text = buildEmbeddingText({
      title: 'Dinner', category: 'food', amount: 40, currency: '$',
      createdAt: Date.parse('2026-05-10'), participantNames: ['Alex', 'Sam'], notes: 'tip included',
    });
    expect(text).toBe('Dinner · category: food · amount: $40.00 · date: 2026-05-10 · with: Alex, Sam · notes: tip included');
  });

  it('scrubs PII from title and notes before embedding', () => {
    const text = buildEmbeddingText({
      title: 'Refund to a@b.com',
      amount: 5,
      notes: 'his number is 415-555-0199',
    });
    expect(text).not.toContain('a@b.com');
    expect(text).not.toContain('0199');
    expect(text).toContain('[email]');
    expect(text).toContain('[phone]');
  });
});
