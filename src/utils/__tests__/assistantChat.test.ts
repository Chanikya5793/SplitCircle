/**
 * assistantChat.test.ts — intent classification + settlement parsing (pure).
 */

import { describe, expect, it } from 'vitest';
import {
  classifyMessage,
  detectNavTarget,
  findMember,
  matchExpenseByText,
  matchSettlement,
  parseAmount,
  parseExpenseEdit,
  parseSettlement,
} from '../assistantChat';

const members = [
  { userId: 'u1', displayName: 'Alice Smith' },
  { userId: 'u2', displayName: 'Bob' },
];

describe('parseAmount', () => {
  it('extracts the first amount, ignoring currency symbols', () => {
    expect(parseAmount('I paid $40.50 for dinner')).toBe(40.5);
    expect(parseAmount('settle 20 with Bob')).toBe(20);
    expect(parseAmount('₹2,558 lunch')).toBe(2); // first run of digits (no grouping) — acceptable
    expect(parseAmount('no numbers here')).toBeNull();
  });
});

describe('findMember', () => {
  it('matches full and first name', () => {
    expect(findMember('pay Bob back', members)?.userId).toBe('u2');
    expect(findMember('I owe alice', members)?.userId).toBe('u1');
    expect(findMember('nobody here', members)).toBeNull();
  });
});

describe('classifyMessage', () => {
  it('detects add_expense', () => {
    expect(classifyMessage('add an expense for groceries', members)).toBe('add_expense');
    expect(classifyMessage('I paid $40 for dinner', members)).toBe('add_expense');
    expect(classifyMessage('log 12 for coffee', members)).toBe('add_expense');
  });

  it('detects settle_up', () => {
    expect(classifyMessage('settle up with Bob', members)).toBe('settle_up');
    expect(classifyMessage('I paid Bob back 50', members)).toBe('settle_up');
    expect(classifyMessage('mark Bob paid 30', members)).toBe('settle_up');
  });

  it('detects delete_expense and navigate', () => {
    expect(classifyMessage('delete the dinner expense', members)).toBe('delete_expense');
    expect(classifyMessage('open settle up', members)).toBe('navigate');
    expect(classifyMessage('take me to stats', members)).toBe('navigate');
  });

  it('detects edit_expense and delete_settlement', () => {
    expect(classifyMessage('rename the dinner expense to Brunch', members)).toBe('edit_expense');
    expect(classifyMessage('change the gas amount to 45', members)).toBe('edit_expense');
    expect(classifyMessage('delete the last settlement', members)).toBe('delete_settlement');
  });

  it('routes plain questions to question', () => {
    expect(classifyMessage('how much did I spend on food?', members)).toBe('question');
    expect(classifyMessage('show our settlements', members)).toBe('question'); // no member+amount ⇒ Q&A
    expect(classifyMessage('who paid the most?', members)).toBe('question');
  });

  // Screenshot bug #2: "Clear the chat" returned a spend number from the model.
  it('routes chat-control meta-commands to clear_chat', () => {
    expect(classifyMessage('clear the chat', members)).toBe('clear_chat');
    expect(classifyMessage('clear chat', members)).toBe('clear_chat');
    expect(classifyMessage('reset the conversation', members)).toBe('clear_chat');
    expect(classifyMessage('start over', members)).toBe('clear_chat');
    expect(classifyMessage('wipe the history', members)).toBe('clear_chat');
    expect(classifyMessage('new chat', members)).toBe('clear_chat');
  });

  it('does not confuse delete-expense with clear_chat', () => {
    expect(classifyMessage('delete this expense', members)).toBe('delete_expense');
    expect(classifyMessage('delete the dinner expense', members)).toBe('delete_expense');
  });
});

describe('detectNavTarget', () => {
  it('maps phrases to targets', () => {
    expect(detectNavTarget('open settle up')).toBe('settlements');
    expect(detectNavTarget('show me the stats')).toBe('stats');
    expect(detectNavTarget('go to recurring bills')).toBe('bills');
    expect(detectNavTarget('add an expense')).toBe('add_expense');
    expect(detectNavTarget('open the weather app')).toBeNull();
  });
});

describe('matchExpenseByText', () => {
  const expenses = [
    { expenseId: 'e1', title: 'Sushi dinner', amount: 40, createdAt: 1 },
    { expenseId: 'e2', title: 'Gas refill', amount: 30, createdAt: 2 },
    { expenseId: 'e3', title: 'Dinner with Sam', amount: 80, createdAt: 3 },
  ];

  it('matches by title token; recency breaks ties', () => {
    expect(matchExpenseByText('delete the gas expense', expenses)?.expenseId).toBe('e2');
    // "dinner" matches e1 and e3 → newer (e3) wins
    expect(matchExpenseByText('remove the dinner expense', expenses)?.expenseId).toBe('e3');
  });

  it('returns null when nothing matches', () => {
    expect(matchExpenseByText('delete the rent expense', expenses)).toBeNull();
  });
});

describe('parseExpenseEdit', () => {
  const expenses = [
    { expenseId: 'e1', title: 'Sushi dinner', amount: 40, createdAt: 1 },
    { expenseId: 'e2', title: 'Gas refill', amount: 30, createdAt: 2 },
  ];

  it('parses an amount change', () => {
    expect(parseExpenseEdit('change the gas amount to 45', expenses)).toEqual({ expenseId: 'e2', changes: { amount: 45 } });
  });

  it('parses a rename', () => {
    expect(parseExpenseEdit('rename the sushi dinner to Brunch', expenses)).toEqual({ expenseId: 'e1', changes: { title: 'Brunch' } });
  });

  it('parses a category change (coerced to canonical)', () => {
    expect(parseExpenseEdit('set the gas category to transport', expenses)).toEqual({ expenseId: 'e2', changes: { category: 'Transport' } });
  });

  it('returns null when no expense matches', () => {
    expect(parseExpenseEdit('change the rent amount to 100', expenses)).toBeNull();
  });
});

describe('matchSettlement', () => {
  const settlements = [
    { settlementId: 's1', fromUserId: 'u1', toUserId: 'u2', amount: 20, createdAt: 1 },
    { settlementId: 's2', fromUserId: 'u2', toUserId: 'u1', amount: 30, createdAt: 2 },
  ];

  it('picks the most recent overall', () => {
    expect(matchSettlement('delete the last settlement', settlements, members)?.settlementId).toBe('s2');
  });

  it('narrows to a named member (most recent involving them)', () => {
    // both involve Bob(u2); newest is s2
    expect(matchSettlement('undo the settlement with Bob', settlements, members)?.settlementId).toBe('s2');
  });

  it('returns null with no settlements', () => {
    expect(matchSettlement('delete settlement', [], members)).toBeNull();
  });
});

describe('parseSettlement', () => {
  it('"I paid Bob 50" ⇒ me → Bob', () => {
    expect(parseSettlement('I paid Bob 50', members, 'u1')).toEqual({ fromUserId: 'u1', toUserId: 'u2', amount: 50 });
  });

  it('"Bob paid me 30" ⇒ Bob → me', () => {
    expect(parseSettlement('Bob paid me 30', members, 'u1')).toEqual({ fromUserId: 'u2', toUserId: 'u1', amount: 30 });
  });

  it('"settle up with Bob" ⇒ me → Bob, amount null', () => {
    expect(parseSettlement('settle up with Bob', members, 'u1')).toEqual({ fromUserId: 'u1', toUserId: 'u2', amount: null });
  });

  it('returns null when no member named', () => {
    expect(parseSettlement('settle up', members, 'u1')).toBeNull();
  });
});
