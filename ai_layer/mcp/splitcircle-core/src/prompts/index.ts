/**
 * prompts/index.ts — MCP prompt templates for splitcircle-core.
 *
 * Prompts are user-controlled, parameterized templates (slash-command style) that
 * tell the host model how to combine the server's tools for a common workflow.
 */

export interface PromptArg { name: string; description: string; required: boolean }
export interface PromptDef {
  name: string;
  title: string;
  description: string;
  arguments: PromptArg[];
  build: (args: Record<string, string>) => string;
}

export const prompts: PromptDef[] = [
  {
    name: 'analyze_my_spending',
    title: 'Analyze my spending',
    description: 'Summarize the user\'s spending using their expenses.',
    arguments: [{ name: 'period', description: 'e.g. "this month", "last trip"', required: false }],
    build: (a) =>
      `Using the get_user_groups and get_expenses tools, analyze my spending${a.period ? ` for ${a.period}` : ''}. ` +
      `Break it down by category, call out the largest items, and note anything unusual. Cite the expenses you use.`,
  },
  {
    name: 'settle_up',
    title: 'Settle up',
    description: 'Explain the simplest way to settle a group.',
    arguments: [{ name: 'groupId', description: 'The group to settle', required: true }],
    build: (a) =>
      `Call get_settlement_suggestions for group ${a.groupId} and get_group_balances. ` +
      `Explain in plain language who should pay whom and why, using member names.`,
  },
  {
    name: 'review_expense',
    title: 'Review an expense',
    description: 'Review a specific expense for correctness/fairness.',
    arguments: [{ name: 'query', description: 'Describe the expense to find', required: true }],
    build: (a) =>
      `Use search_expenses to find the expense matching "${a.query}". ` +
      `Then review whether the split looks fair and consistent with similar past expenses, and explain.`,
  },
];
