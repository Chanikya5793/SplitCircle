/**
 * searchService.ts — pure, on-device search engine for app-wide search.
 *
 * Everything is local: callers build a flat index of SearchItems from live
 * in-memory data (groups, expenses, settlements, friends, chats, calls, actions)
 * and this module ranks them against a query. No network, no server: results
 * are instant. Natural-language "questions" are detected here so the UI can
 * offer an on-device AI answer on top of literal matches.
 */

export type SearchItemType = 'group' | 'expense' | 'settlement' | 'friend' | 'chat' | 'call' | 'action';

export interface SearchItem {
  id: string;
  type: SearchItemType;
  title: string;
  subtitle?: string;
  /** react-native-paper / MaterialCommunityIcons glyph name. */
  icon: string;
  /** Extra searchable text (member names, notes, category, etc.). */
  keywords?: string;
  /** Navigation target. */
  route: string;
  params?: Record<string, unknown>;
  /** ms-epoch of the underlying entity, for recency tie-breaks. */
  recency?: number;
  /** Privacy-guard classification (filtered in the hook while armed). */
  guardTarget?: 'expenses' | 'chats' | 'calls' | 'friends';
  guardEntityId?: string;
}

export interface RankedItem extends SearchItem {
  score: number;
}

const norm = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const tokenize = (s: string): string[] => norm(s).split(' ').filter(Boolean);

/** Base weight per type so people/groups outrank stray keyword hits. */
const TYPE_WEIGHT: Record<SearchItemType, number> = {
  friend: 12,
  group: 12,
  chat: 8,
  expense: 6,
  settlement: 6,
  call: 5,
  action: 4,
};

/**
 * Score one item against the tokenised query. Returns -1 to disqualify when a
 * query token matches nowhere (AND semantics), so "dinner john" only surfaces
 * items mentioning BOTH.
 */
export const scoreItem = (item: SearchItem, qTokens: string[], qRaw: string): number => {
  if (qTokens.length === 0) return 0;
  const title = norm(item.title);
  const hay = norm(`${item.title} ${item.subtitle ?? ''} ${item.keywords ?? ''}`);

  let score = TYPE_WEIGHT[item.type];
  if (title === qRaw) score += 1000;
  else if (title.startsWith(qRaw)) score += 500;
  else if (qRaw.length >= 2 && title.includes(qRaw)) score += 260;

  for (const t of qTokens) {
    if (title.startsWith(t)) score += 90;
    else if (title.includes(t)) score += 60;
    else if (hay.includes(t)) score += 24;
    else return -1; // token unmatched → drop this item
  }

  // Small recency nudge (0-20) so newer entities win ties.
  if (item.recency) {
    const ageDays = (Date.now() - item.recency) / 86_400_000;
    score += Math.max(0, 20 - ageDays);
  }
  return score;
};

export const searchIndex = (query: string, index: readonly SearchItem[], limit = 40): RankedItem[] => {
  const qRaw = norm(query);
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const out: RankedItem[] = [];
  for (const item of index) {
    const score = scoreItem(item, qTokens, qRaw);
    if (score >= 0) out.push({ ...item, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
};

/** Group ranked results by type, preserving score order within each group. */
export const groupByType = (items: RankedItem[]): Array<{ type: SearchItemType; items: RankedItem[] }> => {
  const order: SearchItemType[] = ['action', 'friend', 'group', 'chat', 'expense', 'settlement', 'call'];
  const buckets = new Map<SearchItemType, RankedItem[]>();
  for (const it of items) {
    const arr = buckets.get(it.type) ?? [];
    arr.push(it);
    buckets.set(it.type, arr);
  }
  return order
    .filter((t) => buckets.has(t))
    .map((t) => ({ type: t, items: buckets.get(t)! }));
};

const QUESTION_HINTS = /\b(how|what|when|who|why|which|where|much|many|total|spend|spent|owe|owed|average|most|least|last|paid)\b/;

/** Heuristic: does the query read like a natural-language question for the AI? */
export const looksLikeQuestion = (query: string): boolean => {
  const t = tokenize(query);
  return query.trim().endsWith('?') || (t.length >= 3 && QUESTION_HINTS.test(norm(query)));
};

export const SECTION_LABELS: Record<SearchItemType, string> = {
  action: 'Quick actions',
  friend: 'People',
  group: 'Expense groups',
  chat: 'Chats',
  expense: 'Expenses',
  settlement: 'Settlements',
  call: 'Calls',
};
