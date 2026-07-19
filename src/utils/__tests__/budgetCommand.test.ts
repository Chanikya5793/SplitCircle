/**
 * budgetCommand.test.ts — the set_budget parser + classification (doc 24 P4).
 * The classifier ordering matters: budget commands must win over edit_expense
 * ("set…amount") and add_expense ("for" + amount), while budget QUESTIONS stay
 * on the question path.
 */
import { describe, expect, it } from 'vitest';

import { classifyMessage, parseBudgetCommand } from '../assistantChat';

const members = [
  { userId: 'u1', displayName: 'Chan' },
  { userId: 'u2', displayName: 'Maya' },
];

describe('parseBudgetCommand', () => {
  it('parses "set the Food budget to 300"', () => {
    expect(parseBudgetCommand('set the Food budget to 300')).toEqual({
      category: 'Food',
      amount: 300,
      remove: false,
    });
  });

  it('parses "budget 250 for travel" (no verb, amount present)', () => {
    expect(parseBudgetCommand('budget 250 for travel')).toEqual({
      category: 'Travel',
      amount: 250,
      remove: false,
    });
  });

  it('parses removals, keeping the category', () => {
    expect(parseBudgetCommand('remove the food budget')).toEqual({
      category: 'Food',
      amount: null,
      remove: true,
    });
  });

  it('verb without amount → command with amount null (handler asks)', () => {
    expect(parseBudgetCommand('change the shopping budget')).toEqual({
      category: 'Shopping',
      amount: null,
      remove: false,
    });
  });

  it('question-shaped budget talk is NOT a command', () => {
    expect(parseBudgetCommand('how are we doing on the food budget?')).toBeNull();
    expect(parseBudgetCommand('what is the travel budget')).toBeNull();
    expect(parseBudgetCommand('is the food budget exceeded?')).toBeNull();
  });

  it('bare mentions and non-budget text are null', () => {
    expect(parseBudgetCommand('food budget')).toBeNull();
    expect(parseBudgetCommand('set the food spending to 300')).toBeNull();
  });
});

describe('classifyMessage with set_budget', () => {
  it('budget commands classify as set_budget, beating edit/add', () => {
    expect(classifyMessage('set the Food budget to 300', members)).toBe('set_budget');
    expect(classifyMessage('budget 250 for travel', members)).toBe('set_budget');
    expect(classifyMessage('remove the food budget', members)).toBe('set_budget');
  });

  it('budget questions stay questions', () => {
    expect(classifyMessage('how are we doing on the food budget?', members)).toBe('question');
  });

  it('non-budget edits are untouched by the new branch', () => {
    expect(classifyMessage('change the gas amount to 45', members)).toBe('edit_expense');
  });
});
