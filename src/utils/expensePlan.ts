/**
 * expensePlan.ts — the "understand" → "retrieve" bridge of the on-device RAG
 * pipeline. The on-device model turns a free-form request into a structured
 * QueryPlan; `planToQuestion` renders that plan into a canonical question the
 * deterministic engine (`answerExpenseQuery`) answers EXACTLY with citations.
 *
 * This lets the assistant understand arbitrary phrasings while every number
 * stays computed deterministically (no LLM arithmetic). Pure module — no
 * RN/native imports (unit-tested).
 */

export type PlanIntent =
  | 'spend'
  | 'balance'
  | 'settle_up'
  | 'biggest'
  | 'count'
  | 'average'
  | 'who_most'
  | 'leaderboard'
  | 'breakdown'
  | 'paid_for'
  | 'recent'
  | 'summary'
  | 'compare'
  | 'trend'
  | 'unknown';

export type PlanTimeframe =
  | 'this_month'
  | 'last_month'
  | 'this_week'
  | 'last_week'
  | 'this_year'
  | 'today'
  | null;

export interface QueryPlan {
  intent: PlanIntent;
  /** 'me' | 'group' | a member's display name. */
  scope?: string;
  category?: string;
  /** A member for pairwise balance ("how much do I owe Bob"). */
  member?: string;
  /** For who_most: paid vs split-share. */
  metric?: 'paid' | 'share';
  timeframe?: PlanTimeframe;
}

const TF: Record<Exclude<PlanTimeframe, null>, string> = {
  this_month: 'this month',
  last_month: 'last month',
  this_week: 'this week',
  last_week: 'last week',
  this_year: 'this year',
  today: 'today',
};

const tfPhrase = (t: PlanTimeframe): string => (t && TF[t] ? ` ${TF[t]}` : '');

/** Subject word: "I" for me, the member name, else "we" (group). */
const subject = (scope?: string): string => {
  if (!scope || scope === 'group') return 'we';
  if (scope === 'me') return 'I';
  return scope;
};

/**
 * Render a plan into a canonical question string for `answerExpenseQuery`.
 * Returns '' for `unknown` so the caller falls back to the grounded LLM.
 */
export function planToQuestion(plan: QueryPlan): string {
  const tf = tfPhrase(plan.timeframe ?? null);
  const who = subject(plan.scope);

  switch (plan.intent) {
    case 'spend':
      return plan.category
        ? `how much did ${who} spend on ${plan.category}${tf}`
        : `how much did ${who} spend${tf}`;
    case 'balance':
      return plan.member ? `how much do I owe ${plan.member}` : `what is my balance`;
    case 'settle_up':
      return 'show our settle-up';
    case 'biggest':
      return `what were the biggest expenses${tf}`;
    case 'count':
      return `how many expenses are there${tf}`;
    case 'average':
      return `what is the average expense${tf}`;
    case 'who_most':
      return `who ${plan.metric === 'paid' ? 'paid' : 'spent'} the most${tf}`;
    case 'leaderboard':
      return `how much has each person ${plan.metric === 'paid' ? 'paid' : 'spent'}${tf}`;
    case 'breakdown':
      return `${plan.scope === 'me' ? 'my ' : ''}spending by category${tf}`;
    case 'paid_for':
      return `what did ${who === 'we' ? 'I' : who} pay for${tf}`;
    case 'recent':
      return 'show recent expenses';
    case 'summary':
      return `summarize${tf || ' all time'}`;
    case 'compare':
      return `compare ${plan.category ? `${plan.category} ` : ''}this month vs last month`;
    case 'trend':
      return 'spending by month';
    default:
      return '';
  }
}
