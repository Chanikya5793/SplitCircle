/**
 * notifications.ts — Proactive-nudge logic for splitcircle-notifications (Sprint 7).
 *
 * Pure functions over data we already have (settlements + diff counts): which
 * payments are overdue, and a one-line activity digest. No PII free text. These
 * feed the notifications MCP tools / scheduled nudges; tested without any backend.
 */

export interface Settlement {
  settlementId: string;
  fromUserId: string;
  toUserId: string;
  amount: number;
  status?: string;
  createdAt?: number;
}

export interface OverdueSettlement {
  settlementId: string;
  fromUserId: string;
  toUserId: string;
  amount: number;
  ageDays: number;
}

const DAY_MS = 86_400_000;

/** Pending settlements older than `thresholdDays`, oldest first. */
export function findOverdueSettlements(
  settlements: Settlement[],
  now: number,
  thresholdDays = 7,
): OverdueSettlement[] {
  return (Array.isArray(settlements) ? settlements : [])
    .filter((s) => s && s.status !== 'completed' && typeof s.createdAt === 'number')
    .map((s) => ({
      settlementId: s.settlementId,
      fromUserId: s.fromUserId,
      toUserId: s.toUserId,
      amount: s.amount,
      ageDays: Math.floor((now - (s.createdAt as number)) / DAY_MS),
    }))
    .filter((s) => s.ageDays >= thresholdDays)
    .sort((a, b) => b.ageDays - a.ageDays);
}

export interface DigestInput {
  newExpenses?: number;
  newSettlements?: number;
  overdue?: OverdueSettlement[];
}

/** A friendly one-line "since you last checked" digest. */
export function buildActivityDigest(d: DigestInput): string {
  const parts: string[] = [];
  if (d.newExpenses) parts.push(`${d.newExpenses} new expense${d.newExpenses === 1 ? '' : 's'}`);
  if (d.newSettlements) parts.push(`${d.newSettlements} settlement${d.newSettlements === 1 ? '' : 's'}`);
  const overdue = d.overdue ?? [];
  if (overdue.length) parts.push(`${overdue.length} overdue payment${overdue.length === 1 ? '' : 's'} (oldest ${overdue[0].ageDays}d)`);
  return parts.length ? `Since you last checked: ${parts.join(', ')}.` : 'No new activity.';
}
