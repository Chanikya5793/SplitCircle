/**
 * searchService.ts — pure, on-device search engine for app-wide search.
 *
 * Everything is local: callers build a flat index of SearchItems from live
 * in-memory data (groups, expenses, settlements, friends, chats, calls, actions)
 * and this module ranks them against a query. No network, no server: results
 * are instant. Natural-language "questions" are detected here so the UI can
 * offer an on-device AI answer on top of literal matches.
 */

export type SearchItemType = 'group' | 'expense' | 'settlement' | 'friend' | 'chat' | 'message' | 'call' | 'action';

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
  // Messages are content-first: a matched word carries its own weight, so the
  // base is kept low to avoid a chatty thread crowding out people/groups.
  message: 3,
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

/**
 * True when `a` is reachable from `b` in at most one edit (insertion, deletion
 * or substitution). Dependency-free single-char Levenshtein guard used only by
 * the fuzzy fallback tier — never by strict AND matching.
 */
const withinEditDistance1 = (a: string, b: string): boolean => {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la > lb) return withinEditDistance1(b, a); // keep `a` the shorter side
  let i = 0;
  let j = 0;
  let edited = false;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (edited) return false;
    edited = true;
    if (la === lb) {
      i++;
      j++;
    } else {
      j++; // consume the extra char on the longer side
    }
  }
  return true;
};

/**
 * Typo-tolerant single-token match for the fuzzy fallback tier: a shared prefix
 * (for tokens >= 4 chars) or a single-character edit. Kept deliberately narrow
 * so the fallback surfaces near-misses without inventing matches.
 */
const isTypoMatch = (token: string, hayToken: string): boolean => {
  if (token.length < 4 || hayToken.length < 3) return false;
  if (hayToken.startsWith(token) || token.startsWith(hayToken)) return true;
  return withinEditDistance1(token, hayToken);
};

/**
 * Fallback scorer used ONLY when strict AND matching yields nothing. Applies OR
 * semantics (any token can match) plus light typo tolerance, on a compressed
 * score band so these results always rank below where a real AND hit would sit.
 * Disqualifies items that match no token at all.
 */
export const scoreItemFallback = (item: SearchItem, qTokens: string[]): number => {
  if (qTokens.length === 0) return 0;
  const title = norm(item.title);
  const hay = norm(`${item.title} ${item.subtitle ?? ''} ${item.keywords ?? ''}`);
  const hayTokens = hay.split(' ').filter(Boolean);

  let matched = 0;
  let score = 0;
  for (const t of qTokens) {
    let tokenScore = 0;
    if (title.includes(t)) tokenScore = 40;
    else if (hay.includes(t)) tokenScore = 20;
    else if (hayTokens.some((h) => isTypoMatch(t, h))) tokenScore = 12;
    if (tokenScore > 0) {
      matched++;
      score += tokenScore;
    }
  }
  if (matched === 0) return -1;

  // Reward covering more of the query, plus a fractional type weight so people
  // and groups still edge past stray keyword hits within the fallback band.
  score += matched * 8;
  score += TYPE_WEIGHT[item.type] / 2;

  if (item.recency) {
    const ageDays = (Date.now() - item.recency) / 86_400_000;
    score += Math.max(0, 10 - ageDays);
  }
  return score;
};

export const searchIndex = (query: string, index: readonly SearchItem[], limit = 40): RankedItem[] => {
  const qRaw = norm(query);
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];

  // Tier 1 — strict AND: every query token must land somewhere on the item.
  const strict: RankedItem[] = [];
  for (const item of index) {
    const score = scoreItem(item, qTokens, qRaw);
    if (score >= 0) strict.push({ ...item, score });
  }
  if (strict.length > 0) {
    strict.sort((a, b) => b.score - a.score);
    return strict.slice(0, limit);
  }

  // Tier 2 — fuzzy OR fallback: only when AND found nothing. Typo-tolerant,
  // OR semantics, compressed scores so results read as "did you mean" hits.
  const fallback: RankedItem[] = [];
  for (const item of index) {
    const score = scoreItemFallback(item, qTokens);
    if (score >= 0) fallback.push({ ...item, score });
  }
  fallback.sort((a, b) => b.score - a.score);
  return fallback.slice(0, limit);
};

/** Group ranked results by type, preserving score order within each group. */
export const groupByType = (items: RankedItem[]): Array<{ type: SearchItemType; items: RankedItem[] }> => {
  const order: SearchItemType[] = ['action', 'friend', 'group', 'chat', 'message', 'expense', 'settlement', 'call'];
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
  message: 'Messages',
  expense: 'Expenses',
  settlement: 'Settlements',
  call: 'Calls',
};

/** One run of text with a flag for whether it matched the query. */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

/** Fold a single code point for matching while preserving 1:1 length so match
 * offsets map straight back onto the original string. */
const foldChar = (c: string): string => {
  const stripped = c.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (stripped.length === 1) return stripped;
  const lower = c.toLowerCase();
  return lower.length === 1 ? lower : c;
};

/**
 * Split `text` into matched / unmatched runs against the query tokens so the UI
 * can bold or accent the parts a user actually searched for. Case- and
 * diacritic-insensitive, and returns the ORIGINAL characters (never the folded
 * form) so titles render exactly as stored.
 */
export const highlightSegments = (text: string, query: string): HighlightSegment[] => {
  if (!text) return [];
  const tokens = Array.from(new Set(tokenize(query))).filter(Boolean);
  if (tokens.length === 0) return [{ text, match: false }];

  const chars = Array.from(text);
  const folded = chars.map(foldChar).join('');
  const matched = new Array<boolean>(chars.length).fill(false);

  for (const tok of tokens) {
    let from = 0;
    for (;;) {
      const idx = folded.indexOf(tok, from);
      if (idx < 0) break;
      for (let i = idx; i < idx + tok.length; i++) matched[i] = true;
      from = idx + tok.length;
    }
  }

  const segments: HighlightSegment[] = [];
  let i = 0;
  while (i < chars.length) {
    const flag = matched[i];
    let j = i;
    while (j < chars.length && matched[j] === flag) j++;
    segments.push({ text: chars.slice(i, j).join(''), match: flag });
    i = j;
  }
  return segments;
};
