/**
 * tools/index.ts — Registry of all splitcircle-core tools.
 */

import type { Tool } from '../lib/tool.js';
import { getExpenses } from './get_expenses.js';
import { getGroupBalances } from './get_group_balances.js';
import { getSettlementSuggestions } from './get_settlement_suggestions.js';
import { getUserGroups } from './get_user_groups.js';
import { getRecentActivity } from './get_recent_activity.js';
import { searchExpenses } from './search_expenses.js';
import { addExpense } from './add_expense.js';

export const tools: Tool<any>[] = [
  getExpenses,
  getGroupBalances,
  getSettlementSuggestions,
  getUserGroups,
  getRecentActivity,
  searchExpenses,
  addExpense,
];

export {
  getExpenses,
  getGroupBalances,
  getSettlementSuggestions,
  getUserGroups,
  getRecentActivity,
  searchExpenses,
  addExpense,
};
