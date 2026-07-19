/**
 * assistantFollowUp.ts — conversational memory for the Q&A path.
 *
 * The deterministic engine answers one question at a time; this module lets
 * follow-up fragments ("what about April?", "the month before that", "and for
 * food?", "what about Sam?") anchor to the PREVIOUS question instead of being
 * routed as brand-new (and usually misread) queries.
 *
 * A `LastQuery` plan is remembered after every answered question. A follow-up
 * merges the changed dimension (timeframe / category / person) into that plan
 * and re-renders it as a canonical question for `answerExpenseQuery`.
 * Pure module — no RN/native imports (unit-tested).
 */

import { parseTimeframe, previousTimeframe } from './expenseAnalytics';
import { planToQuestion, timeframeTokenToPhrase, type PlanIntent, type QueryPlan } from './expensePlan';
import { CATEGORY_SYNONYMS } from './expenseQuery';

export interface FollowUpMember {
  userId: string;
  displayName: string;
}

/** The remembered previous question, as a structured plan. */
export type LastQuery = QueryPlan;

const lc = (s: string): string => (s ?? '').toLowerCase();

const wordIn = (haystack: string, word: string): boolean =>
  new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(haystack);

// ── Timeframe label ⇄ token bridging ─────────────────────────────────────────

const LABEL_TOKENS: Record<string, string> = {
  'this month': 'this_month',
  'last month': 'last_month',
  'the past week': 'this_week',
  'this week': 'this_week',
  'the last 7 days': 'last_week',
  'last week': 'last_week',
  'this year': 'this_year',
  'last year': 'last_year',
  today: 'today',
};

/**
 * Convert a `Timeframe.label` ("in April 2025", "last month", "in Q2") back to
 * a plan token ("april_2025", "last_month", "q2"). '' when unmappable.
 */
export function timeframeLabelToToken(label: string): string {
  const l = lc(label).trim();
  if (LABEL_TOKENS[l]) return LABEL_TOKENS[l];
  const m = /^in\s+([a-z]+)(?:\s+(\d{4}))?$/.exec(l);
  if (m) {
    const token = m[2] ? `${m[1]}_${m[2]}` : m[1];
    return timeframeTokenToPhrase(token) ? token : '';
  }
  return '';
}

/**
 * Resolve a plan's `previous_period` token against the last query's timeframe:
 * "the month before that" after "April" ⇒ "march". Returns the concrete token,
 * or null when there's nothing to anchor to.
 */
export function resolvePreviousPeriodToken(
  lastTimeframeToken: string | null | undefined,
  now: number = Date.now(),
): string | null {
  const phrase = timeframeTokenToPhrase(lastTimeframeToken ?? null);
  if (!phrase) return null;
  const tf = parseTimeframe(phrase, now);
  if (!tf) return null;
  return timeframeLabelToToken(previousTimeframe(tf, now).label) || null;
}

// ── Fragment component detection ─────────────────────────────────────────────

const PREVIOUS_PERIOD_RE =
  /\b(?:the\s+)?(?:(?:month|week|quarter|year|period|one)\s+before(?:\s+that)?|previous\s+(?:month|week|quarter|year|period|one))\b|\bbefore that\b/i;

/** A category named in the text, via canonical names or synonyms. */
function detectCategoryWord(text: string): string | null {
  for (const [canonical, syns] of Object.entries(CATEGORY_SYNONYMS)) {
    if (wordIn(text, canonical) || syns.some((s) => wordIn(text, s))) return canonical;
  }
  if (wordIn(text, 'general')) return 'General';
  return null;
}

function detectMemberName(text: string, members: readonly FollowUpMember[]): string | null {
  for (const m of members) {
    const full = (m.displayName ?? '').trim();
    if (!full) continue;
    const first = full.split(/\s+/)[0];
    const core = first.replace(/[^a-zA-Z].*$/, '');
    if (wordIn(text, full) || (first.length >= 2 && wordIn(text, first)) || (core.length >= 2 && wordIn(text, core))) {
      return full;
    }
  }
  return null;
}

/** Fragment-shaped: "what/how about …", "and …", or a short tail-less phrase. */
const isFragmentShaped = (text: string): boolean => {
  const t = text.trim();
  if (/^(what|how)\s+about\b/i.test(t) || /^and\b/i.test(t) || /^what\s+of\b/i.test(t)) return true;
  return t.split(/\s+/).length <= 5;
};

/**
 * Interpret `text` as a follow-up to `last`. Returns the merged plan when the
 * message changes exactly the timeframe, category, or person of the previous
 * question — otherwise null (route it as a fresh message).
 */
export function resolveFollowUp(
  text: string,
  last: LastQuery | null | undefined,
  members: readonly FollowUpMember[],
  now: number = Date.now(),
): QueryPlan | null {
  if (!last || last.intent === 'unknown') return null;
  const t = (text ?? '').trim();
  if (!t || !isFragmentShaped(t)) return null;

  // "the month before that" — shift the previous timeframe back one period.
  if (PREVIOUS_PERIOD_RE.test(t)) {
    const token = resolvePreviousPeriodToken(last.timeframe ?? 'this_month', now);
    if (!token) return null;
    return { ...last, timeframe: token };
  }

  const merged: QueryPlan = { ...last };
  let changed = false;

  const tf = parseTimeframe(t, now);
  if (tf) {
    const token = timeframeLabelToToken(tf.label);
    if (token) {
      merged.timeframe = token;
      changed = true;
    }
  }

  const category = detectCategoryWord(t);
  if (category) {
    merged.category = category;
    changed = true;
  }

  const member = detectMemberName(t, members);
  if (member) {
    if (last.intent === 'balance') merged.member = member;
    else merged.scope = member;
    changed = true;
  } else if (/\b(just|only|for)?\s*me\b|\bmy share\b/i.test(t) && /\bme\b|\bmy\b/i.test(t)) {
    merged.scope = 'me';
    changed = true;
  } else if (/\b(the\s+)?(whole\s+)?group\b|\beveryone\b/i.test(t)) {
    merged.scope = 'group';
    changed = true;
  }

  return changed ? merged : null;
}

/**
 * Render a plan into the canonical question `answerExpenseQuery` understands,
 * resolving `previous_period` against the same plan's remembered timeframe
 * first. '' when the plan can't be rendered.
 */
export function followUpPlanToQuestion(plan: QueryPlan, now: number = Date.now()): string {
  let p = plan;
  if (p.timeframe === 'previous_period') {
    const token = resolvePreviousPeriodToken('this_month', now);
    p = { ...p, timeframe: token };
  }
  return planToQuestion(p);
}

/**
 * Build a coarse plan from a question the deterministic engine just answered,
 * so the NEXT message can follow up on it. Mirrors `answerExpenseQuery`'s
 * intent regexes at low resolution — only the dimensions follow-ups can change
 * (intent, scope, category, member, timeframe) need to be right.
 */
export function inferPlanFromQuestion(
  question: string,
  members: readonly FollowUpMember[],
  now: number = Date.now(),
): LastQuery {
  const q = (question ?? '').trim();
  const tf = parseTimeframe(q, now);
  const timeframe = tf ? timeframeLabelToToken(tf.label) || null : null;
  const category = detectCategoryWord(q);
  const memberName = detectMemberName(q, members);
  const scope = /\b(i|me|my|mine)\b/i.test(q) ? 'me' : memberName ?? 'group';

  let intent: PlanIntent = 'unknown';
  if (/\b(compare|compared to|versus|vs\.?)\b/i.test(q)) intent = 'compare';
  else if (/\b(trend|over time|by month|each month|month by month)\b/i.test(q)) intent = 'trend';
  else if (/\bsettle( ?up)?\b|\bsettlements?\b|who owes who/i.test(q)) intent = 'settle_up';
  else if (/\bowe[ds]?\b|\bbalances?\b/i.test(q)) intent = 'balance';
  else if (/\b(biggest|largest|top|most expensive|priciest|highest)\b/i.test(q)) intent = 'biggest';
  else if (/\b(paid for|pay for|did i pay|i paid|i bought)\b/i.test(q)) intent = 'paid_for';
  else if (/\b(recent|latest|most recent)\b/i.test(q)) intent = 'recent';
  else if (/\b(each (person|member|one)|per person|how much has each)\b/i.test(q)) intent = 'leaderboard';
  else if (/\b(by category|per category|category breakdown|where did (the |our |my )?money go)\b/i.test(q)) intent = 'breakdown';
  else if (/\bwho\b.*\b(paid|spent|spend)\b|biggest spender/i.test(q)) intent = 'who_most';
  else if (/\baverage\b|\bavg\b/i.test(q)) intent = 'average';
  else if (/how many\b.*\bexpenses?\b/i.test(q)) intent = 'count';
  else if (/\b(summar(y|ize|ise)|overview|recap|review)\b/i.test(q)) intent = 'summary';
  else if (/\b(spen[dt]|spending|total|cost)\b/i.test(q)) intent = 'spend';

  return {
    intent,
    scope,
    category: category ?? undefined,
    member: intent === 'balance' ? memberName ?? undefined : undefined,
    metric: /\bpaid\b/i.test(q) ? 'paid' : undefined,
    timeframe,
  };
}
