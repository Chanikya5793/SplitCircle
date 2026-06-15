/**
 * assistantChat.ts — pure conversational core for the AI assistant chatbot.
 *
 * Classifies a user message into an intent and parses ACTION messages (add
 * expense, settle up) into structured drafts. The model is used elsewhere for
 * open-ended chat and rich expense parsing; this deterministic layer handles
 * routing + the simple, safety-critical parsing so every write is predictable
 * and confirmed before execution. No RN/native imports (unit-tested).
 */

export type AssistantIntent = 'add_expense' | 'settle_up' | 'question' | 'chat';

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

const lc = (s: string): string => (s ?? '').toLowerCase();

/** First monetary number in the text (ignores currency symbols), or null. */
export function parseAmount(message: string): number | null {
  const m = message.match(/(?:[$₹€£]\s*)?(\d{1,7}(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Find the first group member named in the message (full or first name). */
export function findMember(message: string, members: readonly AssistantMember[]): AssistantMember | null {
  for (const mem of members) {
    const full = (mem.displayName ?? '').trim();
    if (!full) continue;
    const first = full.split(/\s+/)[0];
    const re = (w: string) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re(full).test(message) || (first.length >= 2 && re(first).test(message))) return mem;
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
export function classifyMessage(message: string, members: readonly AssistantMember[]): AssistantIntent {
  const q = message ?? '';
  const hasMember = findMember(q, members) != null;
  const hasAmount = parseAmount(q) != null;

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
