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

/**
 * Timeframe token from the model. Beyond the fixed relative words, explicit
 * tokens are accepted: a month name ("april", "april_2025"), a quarter
 * ("q2", "q2_2025"), a year ("year_2025"), and "previous_period" (the period
 * before the last question's — resolved by the follow-up layer). Anything
 * unrecognized is treated as all-time.
 */
export type PlanTimeframe =
  | 'this_month'
  | 'last_month'
  | 'this_week'
  | 'last_week'
  | 'this_year'
  | 'today'
  | 'previous_period'
  | (string & {})
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

const TF: Record<string, string> = {
  this_month: 'this month',
  last_month: 'last month',
  this_week: 'this week',
  last_week: 'last week',
  this_year: 'this year',
  today: 'today',
};

const MONTH_TOKEN_RE =
  /^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:[_\s-](\d{4}))?$/;
const QUARTER_TOKEN_RE = /^q([1-4])(?:[_\s-](\d{4}))?$/;
const YEAR_TOKEN_RE = /^(?:year[_\s-])?(20\d\d)$/;

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Render a timeframe token as a natural-language phrase (leading space
 * included) that `parseTimeframe` understands, e.g. 'april_2025' → ' in April
 * 2025'. '' for unknown tokens (⇒ all-time). `previous_period` is resolved by
 * the follow-up layer before rendering and yields '' here.
 */
export function timeframeTokenToPhrase(token: PlanTimeframe): string {
  if (!token) return '';
  const t = token.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return '';
  if (TF[t]) return ` ${TF[t]}`;
  const m = MONTH_TOKEN_RE.exec(t);
  if (m) return ` in ${cap(m[1])}${m[2] ? ` ${m[2]}` : ''}`;
  const q = QUARTER_TOKEN_RE.exec(t);
  if (q) return ` in Q${q[1]}${q[2] ? ` ${q[2]}` : ''}`;
  const y = YEAR_TOKEN_RE.exec(t);
  if (y) return ` in ${y[1]}`;
  return '';
}

/** True when the token names a timeframe `timeframeTokenToPhrase` can render. */
export const isKnownTimeframeToken = (token: string): boolean =>
  timeframeTokenToPhrase(token) !== '' || token === 'previous_period';

const tfPhrase = (t: PlanTimeframe): string => timeframeTokenToPhrase(t);

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
