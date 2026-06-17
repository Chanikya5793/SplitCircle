/**
 * assistantChat.ts — pure conversational core for the AI assistant chatbot.
 *
 * Classifies a user message into an intent and parses ACTION messages (add
 * expense, settle up) into structured drafts. The model is used elsewhere for
 * open-ended chat and rich expense parsing; this deterministic layer handles
 * routing + the simple, safety-critical parsing so every write is predictable
 * and confirmed before execution. No RN/native imports (unit-tested).
 */

export type AssistantIntent =
  | 'add_expense'
  | 'settle_up'
  | 'delete_expense'
  | 'edit_expense'
  | 'delete_settlement'
  | 'navigate'
  | 'clear_chat'
  | 'question'
  | 'chat';

/** Where a "navigate" intent wants to go (screen maps this to a route). */
export type NavTarget = 'settlements' | 'stats' | 'bills' | 'add_expense' | 'chat' | 'group_info';

export interface MatchableExpense {
  expenseId: string;
  title: string;
  amount: number;
  createdAt: number;
}

export interface MatchableSettlement {
  settlementId: string;
  fromUserId: string;
  toUserId: string;
  amount: number;
  createdAt: number;
}

export interface ExpenseEdit {
  expenseId: string;
  changes: { title?: string; amount?: number; category?: string };
}

export interface AssistantMember {
  userId: string;
  displayName: string;
}

export interface SettlementDraft {
  fromUserId: string;
  toUserId: string;
  /** null ⇒ caller should fill from the exact pairwise balance. */
  amount: number | null;
}

import { coerceCategory } from './categoryMatch';

const lc = (s: string): string => (s ?? '').toLowerCase();

const reWord = (w: string): RegExp =>
  new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');

/**
 * Name forms to match a member against: full name, first token, and the
 * alphabetic "core" of the first token so a display name like "Ram12" or
 * "Soumya_k" still matches when the user just types "ram" / "soumya".
 */
const nameForms = (mem: AssistantMember): string[] => {
  const full = (mem.displayName ?? '').trim();
  if (!full) return [];
  const first = full.split(/\s+/)[0];
  const core = first.replace(/[^a-zA-Z].*$/, ''); // "Ram12" → "Ram"
  const forms = [full];
  if (first.length >= 2) forms.push(first);
  if (core.length >= 2 && core.toLowerCase() !== first.toLowerCase()) forms.push(core);
  return forms;
};

/** Does the message name this member (full / first / alphabetic-core)? */
const mentionsMember = (q: string, mem: AssistantMember): boolean =>
  nameForms(mem).some((w) => reWord(w).test(q));

const EVERYONE_RE = /\b(everyone|everybody|all of us|the (whole )?group|all members|the others|us all)\b/i;
const ME_RE = /\b(me|myself|i)\b/i;

/**
 * Resolve which members an expense should be split between, from natural text.
 * "everyone"/"the group" → all; "just/only me" → me; "me and Ram" / "with Ram
 * and Sam" → those members (the payer is included by default when others are
 * named, since "split with Ram" conventionally means you + Ram). Returns null
 * when no participants are expressed. Pure + offline.
 */
export function parseParticipants(
  message: string,
  members: readonly AssistantMember[],
  currentUserId: string,
): string[] | null {
  const q = message ?? '';
  if (EVERYONE_RE.test(q)) return members.map((m) => m.userId);

  const named = members.filter((m) => m.userId !== currentUserId && mentionsMember(q, m)).map((m) => m.userId);
  const mentionsMe = ME_RE.test(q) || /\bour(s)?\b/i.test(q);

  if (named.length > 0) {
    const set = new Set(named);
    set.add(currentUserId); // the payer participates by default
    return Array.from(set);
  }
  if (mentionsMe) return [currentUserId];
  return null;
}

/**
 * Extract an expense title from free text: "$100 for gas" → "Gas"; when the text
 * is just a label ("dinner") use it directly. Strips amounts and filler. Returns
 * '' when nothing usable remains.
 */
export function extractExpenseTitle(message: string): string {
  const q = (message ?? '').trim();
  const forMatch = q.match(/\bfor\s+(.+)$/i);
  let title = forMatch ? forMatch[1] : q;
  title = title
    .replace(/(?:[$₹€£]\s*)?\d{1,7}(?:\.\d{1,2})?/g, ' ') // amounts
    .replace(/\b(i|want|wanna|to|would|like|can|could|you|need|let'?s|do|please|add|create|log|record|new|a|an|the|expense|split|with|just|only|me|us|our|my|everyone|everybody|paid|by|of|it|that|this|was|is|for|some)\b/gi, ' ')
    .replace(/[^a-z0-9 &'/-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return '';
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export interface ExpenseModification {
  participants?: string[];
  category?: string;
  amount?: number;
  title?: string;
  paidByUserId?: string;
}

/**
 * Detect a modification to an already-proposed expense ("split with everyone",
 * "only me", "make it 50", "category to Food", "paid by Sam"). Returns null when
 * the message isn't a recognizable tweak. Pure + offline.
 */
export function detectExpenseModification(
  message: string,
  members: readonly AssistantMember[],
  currentUserId: string,
): ExpenseModification | null {
  const q = message ?? '';
  const mod: ExpenseModification = {};

  // Participants — only when the message is clearly about splitting/sharing.
  if (/\b(split|share|divide|between|among|everyone|everybody|just|only)\b/i.test(q) || /\bwith\b/i.test(q)) {
    const parts = parseParticipants(q, members, currentUserId);
    if (parts && parts.length > 0) mod.participants = parts;
  }

  // Category — "category to Food" / "as Food", or a category keyword.
  if (/\bcategor/i.test(q)) {
    const m = q.match(/\b(?:to|as|=)\s+([a-z ]+)$/i);
    if (m) mod.category = coerceCategory(m[1].trim());
  }

  // Amount — explicit correction wording only (avoid grabbing unrelated numbers).
  if (/\b(make it|change|set|actually|it was|it's|amount|cost|price|instead)\b/i.test(q)) {
    const a = parseAmount(q);
    if (a != null) mod.amount = a;
  }

  // Title — "rename to X" / "call it X" / "name it X".
  if (/\b(rename|call it|name it|title)\b/i.test(q)) {
    const m = q.match(/\b(?:to|it)\s+(.+)$/i);
    if (m) mod.title = m[1].trim().replace(/["'.]+$/g, '');
  }

  // Paid by — "paid by Sam" / "Sam paid".
  if (/\bpaid by\b/i.test(q) || /\bpaid\b/i.test(q)) {
    const payer = members.find((m) => mentionsMember(q, m));
    if (payer) mod.paidByUserId = payer.userId;
  }

  return Object.keys(mod).length > 0 ? mod : null;
}

/** First monetary number in the text (ignores currency symbols), or null. */
export function parseAmount(message: string): number | null {
  const m = message.match(/(?:[$₹€£]\s*)?(\d{1,7}(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Find the first group member named in the message (full / first / name-core). */
export function findMember(message: string, members: readonly AssistantMember[]): AssistantMember | null {
  for (const mem of members) {
    if (mentionsMember(message, mem)) return mem;
  }
  return null;
}

const SETTLE_RE = /\b(settle( up)?|settled|repaid|paid .* back|mark .* paid|record (a )?payment)\b/i;
const ADD_EXPENSE_RE = /\b(add|create|log|record|new)\b[^?]*\bexpense\b/i;
const PAID_FOR_RE = /\b(i|we)\s+(paid|spent|bought)\b/i;

/**
 * Classify a message. Actions are detected before questions so "settle up with
 * Bob $20" (action) isn't confused with "show our settlements" (question).
 * Ambiguous/general messages fall to `question` (handled deterministically) and
 * then `chat` (LLM) by the orchestrator.
 */
const DELETE_RE = /\b(delete|remove|undo|get rid of)\b/i;
const NAVIGATE_RE = /\b(open|go to|take me to|jump to|navigate to)\b/i;

const SHOW_RE = /\b(show|list|view|see|display|what (are|is|were)|tell me)\b/i;
const HELP_RE = /\b(help|what (all )?can (you|u|i) (do|ask|help)|what (do|are) you (do|capable|able)|what can you answer|how (do|does) (this|you|it) work|commands?|capabilities|who are you|what are you)\b/i;
// Chat-control / meta ("clear the chat", "start over", "reset conversation"). Caught
// before everything else so it can never leak to the model as a spend query.
const CLEAR_CHAT_RE = /\b(clear|reset|wipe|erase|start over|restart)\b[^?]*\b(chat|conversation|convo|history|messages?)\b|^\s*(clear|reset|start over|new chat)\s*$/i;

export function classifyMessage(message: string, members: readonly AssistantMember[]): AssistantIntent {
  const q = message ?? '';
  const hasMember = findMember(q, members) != null;
  const hasAmount = parseAmount(q) != null;

  // Chat-control / meta-command. Must precede DELETE/SHOW so "clear the chat" and
  // "delete this conversation" don't get read as delete-expense or a spend query.
  if (CLEAR_CHAT_RE.test(q)) return 'clear_chat';

  // Help / capabilities → handled deterministically by the question engine.
  if (HELP_RE.test(q)) return 'question';

  // Delete settlement / expense (require the noun to stay safe / unambiguous).
  if (DELETE_RE.test(q) && /\bsettlements?\b|\bpayment\b/i.test(q)) return 'delete_settlement';
  if (DELETE_RE.test(q) && /\bexpense\b/i.test(q)) return 'delete_expense';

  // Edit expense ("rename ... to ...", "change ... amount to ...", "set category to ...").
  if (
    /\b(rename|change|set|update|edit|make)\b/i.test(q) &&
    /\bexpense\b|\bamount\b|\bcategor|\bname\b|\btitle\b|\brename\b|\bcost\b|\bprice\b/i.test(q)
  ) {
    return 'edit_expense';
  }

  // Navigate ("open settle up", "take me to stats").
  if (NAVIGATE_RE.test(q) && detectNavTarget(q) != null) return 'navigate';

  // "Show/list the settle-ups" is a QUESTION (display the plan), not the settle ACTION.
  if (SHOW_RE.test(q) && /\bsettle|settlements?\b/i.test(q)) return 'question';

  // Settle: explicit settle wording, or "paid <member>" / "<member> paid" with a member.
  if (SETTLE_RE.test(q) && (hasMember || /\bsettle( up)?\b/i.test(q))) return 'settle_up';

  // Add expense: explicit "add expense", or "I paid/spent/bought ..." with an
  // amount that isn't a person-to-person settlement.
  if (ADD_EXPENSE_RE.test(q)) return 'add_expense';
  if (PAID_FOR_RE.test(q) && hasAmount && !hasMember) return 'add_expense';
  if (/\bfor\b/i.test(q) && hasAmount && !SETTLE_RE.test(q)) return 'add_expense';

  return 'question';
}

/**
 * Parse a settlement message into a draft. Returns null if no member is found.
 * Direction: "I paid Bob" ⇒ me→Bob; "Bob paid me" ⇒ Bob→me; "settle up with
 * Bob" ⇒ me→Bob. `amount` is null when not stated (caller fills from pairwise).
 */
export function parseSettlement(
  message: string,
  members: readonly AssistantMember[],
  currentUserId: string,
): SettlementDraft | null {
  const member = findMember(message, members.filter((m) => m.userId !== currentUserId));
  if (!member) return null;
  const amount = parseAmount(message);
  const q = lc(message);
  const first = lc((member.displayName ?? '').split(/\s+/)[0] || member.displayName);

  // "<member> paid [me]" ⇒ member is the payer (member → me).
  const memberPaid = new RegExp(`\\b${first}\\b[^.]*\\bpaid\\b`).test(q) || /\bpaid me\b/.test(q);
  if (memberPaid && !/\bi paid\b/.test(q)) {
    return { fromUserId: member.userId, toUserId: currentUserId, amount };
  }
  // Default + "I paid <member>" / "settle up with <member>" ⇒ me → member.
  return { fromUserId: currentUserId, toUserId: member.userId, amount };
}

/** Detect which screen a "navigate" message wants (null if none). */
export function detectNavTarget(message: string): NavTarget | null {
  const q = lc(message);
  if (/\bsettle|settlement/.test(q)) return 'settlements';
  if (/\bstats|statistics|charts?|spending breakdown\b/.test(q)) return 'stats';
  if (/\bbills?|recurring\b/.test(q)) return 'bills';
  if (/\badd (an )?expense|new expense\b/.test(q)) return 'add_expense';
  if (/\bchat|messages?\b/.test(q)) return 'chat';
  if (/\bgroup info|members|settings\b/.test(q)) return 'group_info';
  return null;
}

const STOPWORDS = new Set([
  'delete', 'remove', 'undo', 'get', 'rid', 'of', 'the', 'expense', 'my', 'our', 'last',
  'that', 'this', 'a', 'an', 'for', 'please', 'can', 'you', 'cancel',
  // edit-related, so matching keys on the existing title, not the new value
  'rename', 'change', 'set', 'update', 'edit', 'make', 'to', 'as', 'amount', 'category',
  'name', 'title', 'cost', 'price',
]);

/** Best-matching expense for a delete request, by title-token overlap then recency. */
export function matchExpenseByText<T extends MatchableExpense>(message: string, expenses: readonly T[]): T | null {
  const tokens = new Set(
    lc(message).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t)),
  );
  let best: T | null = null;
  let bestScore = 0;
  for (const e of expenses) {
    const titleTokens = lc(e.title ?? '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    let overlap = 0;
    for (const t of titleTokens) if (tokens.has(t)) overlap += 1;
    const score = overlap * 1_000_000_000 + (e.createdAt || 0); // overlap dominates; recency breaks ties
    if (overlap > 0 && score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}

/** Most recent settlement to delete; narrows to one involving a named member. */
export function matchSettlement<T extends MatchableSettlement>(
  message: string,
  settlements: readonly T[],
  members: readonly AssistantMember[],
): T | null {
  const member = findMember(message, members);
  const pool = member
    ? settlements.filter((s) => s.fromUserId === member.userId || s.toUserId === member.userId)
    : settlements;
  if (pool.length === 0) return null;
  return [...pool].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
}

/**
 * Parse an edit request into the matched expense + the changed fields
 * (title / amount / category). Returns null if no expense matches or no change
 * is detected. Heuristic — the UI shows a before/after confirm card.
 */
export function parseExpenseEdit<T extends MatchableExpense>(message: string, expenses: readonly T[]): ExpenseEdit | null {
  const match = matchExpenseByText(message, expenses);
  if (!match) return null;
  const q = message;
  const changes: ExpenseEdit['changes'] = {};

  // Category: "category to Food" / "as Food".
  if (/\bcategor/i.test(q)) {
    const m = q.match(/\b(?:to|as|=)\s+([a-z]+)/i);
    if (m) changes.category = coerceCategory(m[1]);
  }

  // Title: "rename ... to X" / "name it X" / "title to X" → trailing text.
  if (/\b(rename|call it|name|title)\b/i.test(q) && !/\bcategor/i.test(q)) {
    const m = q.match(/\bto\s+(.+)$/i) || q.match(/\bcall it\s+(.+)$/i);
    if (m) changes.title = m[1].trim().replace(/["'.]+$/g, '');
  }

  // Amount: a number with edit/cost wording, unless this was a title edit.
  if (changes.title == null) {
    const amt = parseAmount(q);
    if (amt != null && /\b(amount|cost|price|change|set|make|update|to)\b/i.test(q)) changes.amount = amt;
  }

  return Object.keys(changes).length > 0 ? { expenseId: match.expenseId, changes } : null;
}
