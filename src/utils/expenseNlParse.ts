/**
 * expenseNlParse.ts — pure mapping from the on-device NL parse output onto the
 * app's expense shape: resolve member names → user ids, coerce category, clamp
 * the amount, default the payer. No RN/native imports (unit-tested).
 */

import { coerceCategory } from './categoryMatch';

export interface NlMember {
  userId: string;
  displayName: string;
}

export interface NlParsedRaw {
  title?: string;
  amount?: number;
  category?: string;
  paidByName?: string;
  participantNames?: string[];
  splitEqually?: boolean;
  date?: string;
}

export interface NlParsedExpense {
  title: string;
  amount: number;
  category: string;
  paidByUserId: string;
  participantUserIds: string[];
  splitEqually: boolean;
  /** Epoch ms if a valid date was parsed, else null. */
  createdAt: number | null;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Resolve a free-text name to a member id: exact, then prefix/contains match. */
export function resolveMemberId(name: string, members: readonly NlMember[]): string | null {
  const n = norm(name);
  if (!n) return null;
  const exact = members.find((m) => norm(m.displayName) === n);
  if (exact) return exact.userId;
  // First-name / contains either direction.
  const partial = members.find((m) => {
    const mn = norm(m.displayName);
    const first = norm(m.displayName.split(/\s+/)[0] ?? '');
    return mn.startsWith(n) || n.startsWith(first) || mn.includes(n) || n.includes(mn);
  });
  return partial?.userId ?? null;
}

const parseDateMs = (date: string | undefined): number | null => {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) return null;
  const ms = new Date(`${date.trim()}T12:00:00`).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Map the raw NL parse onto a resolved draft. `members` is the group's members,
 * `currentUserId` is the fallback payer and default-everyone anchor.
 */
export function mapNlExpense(
  raw: NlParsedRaw,
  members: readonly NlMember[],
  currentUserId: string,
): NlParsedExpense {
  const amount = typeof raw.amount === 'number' && Number.isFinite(raw.amount) && raw.amount > 0
    ? Math.round(raw.amount * 100) / 100
    : 0;

  const paidByUserId =
    (raw.paidByName ? resolveMemberId(raw.paidByName, members) : null) ?? currentUserId;

  // Resolve named participants; dedupe; empty/unresolved ⇒ everyone.
  const resolved: string[] = [];
  for (const name of raw.participantNames ?? []) {
    const id = resolveMemberId(name, members);
    if (id && !resolved.includes(id)) resolved.push(id);
  }
  const participantUserIds = resolved.length > 0 ? resolved : members.map((m) => m.userId);

  return {
    title: (raw.title ?? '').trim(),
    amount,
    category: coerceCategory(raw.category, 'General'),
    paidByUserId,
    participantUserIds,
    splitEqually: raw.splitEqually !== false,
    createdAt: parseDateMs(raw.date),
  };
}
