/**
 * Tests for the conversational core that fixes the chatbot regressions:
 * participant parsing, title extraction, proposal modification, smarter category,
 * and the classifier guards (help, show-settle-up, intent switching).
 */

import { describe, expect, it } from 'vitest';
import { categorizeText } from '../categoryMatch';
import {
  classifyMessage,
  detectExpenseModification,
  extractExpenseTitle,
  parseParticipants,
  type AssistantMember,
} from '../assistantChat';

const members: AssistantMember[] = [
  { userId: 'me', displayName: 'Chan' },
  { userId: 'ram', displayName: 'Ram12' },
  { userId: 'soumya', displayName: 'Soumya_k' },
];

describe('parseParticipants', () => {
  it('"everyone" → all members', () => {
    expect(parseParticipants('split with everyone', members, 'me')?.sort()).toEqual(['me', 'ram', 'soumya']);
  });
  it('"just me" → only me', () => {
    expect(parseParticipants('just me', members, 'me')).toEqual(['me']);
  });
  it('"only me" → only me', () => {
    expect(parseParticipants('split it only with me', members, 'me')).toEqual(['me']);
  });
  it('"me and ram" → me + ram (the regression: was 1 way)', () => {
    expect(parseParticipants('100 for rent. Just me and ram', members, 'me')?.sort()).toEqual(['me', 'ram']);
  });
  it('"with ram and soumya" includes the payer by default', () => {
    expect(parseParticipants('split it with ram and soumya', members, 'me')?.sort()).toEqual(['me', 'ram', 'soumya']);
  });
  it('returns null when no one is named', () => {
    expect(parseParticipants('100 for gas', members, 'me')).toBeNull();
  });
});

describe('extractExpenseTitle', () => {
  it('pulls the title after "for"', () => {
    expect(extractExpenseTitle('$100 for gas')).toBe('Gas');
  });
  it('uses a bare label', () => {
    expect(extractExpenseTitle('dinner')).toBe('Dinner');
  });
  it('strips amount + filler', () => {
    expect(extractExpenseTitle('add an expense of $100 for restaurant bill')).toBe('Restaurant bill');
  });
  it('returns empty when there is no real title', () => {
    expect(extractExpenseTitle('I want to add an expense')).toBe('');
  });
});

describe('categorizeText', () => {
  it('gas → Transport', () => expect(categorizeText('gas')).toBe('Transport'));
  it('rent → Utilities', () => expect(categorizeText('rent')).toBe('Utilities'));
  it('restaurant bill → Food', () => expect(categorizeText('restaurant bill')).toBe('Food'));
  it('unknown → General', () => expect(categorizeText('xyz widget')).toBe('General'));
});

describe('detectExpenseModification', () => {
  it('"split with everyone" → all participants', () => {
    const m = detectExpenseModification('split it with everyone', members, 'me');
    expect(m?.participants?.sort()).toEqual(['me', 'ram', 'soumya']);
  });
  it('"only me" → just me', () => {
    const m = detectExpenseModification('split it only with me', members, 'me');
    expect(m?.participants).toEqual(['me']);
  });
  it('"make it 50" → amount change', () => {
    expect(detectExpenseModification('make it 50', members, 'me')?.amount).toBe(50);
  });
  it('"category to Food" → category change', () => {
    expect(detectExpenseModification('change category to Food', members, 'me')?.category).toBe('Food');
  });
  it('returns null for an unrelated message', () => {
    expect(detectExpenseModification('how much did I spend', members, 'me')).toBeNull();
  });
});

describe('classifyMessage guards', () => {
  it('"what all can you do?" → question (help), not chat', () => {
    expect(classifyMessage('what all can you do?', members)).toBe('question');
  });
  it('"show the settle ups in the group" → question, not settle action', () => {
    expect(classifyMessage('show the settle ups in the group', members)).toBe('question');
  });
  it('"I want to add an expense" → add_expense (not settle)', () => {
    expect(classifyMessage('I want to add an expense', members)).toBe('add_expense');
  });
  it('"settle up with Ram" → settle_up', () => {
    expect(classifyMessage('settle up with Ram', members)).toBe('settle_up');
  });
  it('"$100 for gas" → add_expense', () => {
    expect(classifyMessage('$100 for gas', members)).toBe('add_expense');
  });
});
