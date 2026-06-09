/**
 * activity_log.ts — Reconstruct a group activity feed from group-doc diffs
 * (Open Question #3 / RAG-06).
 *
 * DECISION: there is no stored event log today, but every change flows through a
 * `groups/{gid}` write, so we DERIVE events by diffing the before/after embedded
 * arrays (expenses, settlements, members). Pure + deterministic so it is unit
 * tested; the orchestrator can persist the events (e.g. to a `groups/{gid}/activity`
 * subcollection) and the embedding pipeline can index them for "catch me up" queries.
 *
 * Event ids are deterministic (`${type}:${refId}`) so re-processing a write is
 * idempotent (Critical Rule #5). No PII free-text (notes) is included.
 */

export type ActivityType =
  | 'expense_added'
  | 'expense_settled'
  | 'settlement_added'
  | 'member_joined'
  | 'member_left';

export interface ActivityEvent {
  eventId: string;
  groupId: string;
  type: ActivityType;
  actorId?: string;
  refId: string;
  summary: string;
  at: number;
}

interface GroupSnapshot {
  expenses?: any[];
  settlements?: any[];
  members?: any[];
}

const byId = (arr: any[] | undefined, key: string): Map<string, any> =>
  new Map((Array.isArray(arr) ? arr : []).filter((x) => x?.[key]).map((x) => [x[key] as string, x]));

const titleOf = (e: any): string => e?.title ?? e?.description ?? 'an expense';

/**
 * PURE: diff before→after and emit the new activity events (additions + the
 * settled-state transition). Deletions are intentionally not surfaced as events.
 */
export function buildActivityEvents(
  before: GroupSnapshot | undefined,
  after: GroupSnapshot | undefined,
  groupId: string,
): ActivityEvent[] {
  if (!after) return [];
  const events: ActivityEvent[] = [];

  const beforeExp = byId(before?.expenses, 'expenseId');
  for (const e of (Array.isArray(after.expenses) ? after.expenses : [])) {
    if (!e?.expenseId) continue;
    const prev = beforeExp.get(e.expenseId);
    if (!prev) {
      events.push({
        eventId: `expense_added:${e.expenseId}`, groupId, type: 'expense_added',
        actorId: e.paidBy, refId: e.expenseId,
        summary: `${titleOf(e)} (${e.amount}) added`, at: Number(e.createdAt) || 0,
      });
    } else if (!prev.settled && e.settled) {
      events.push({
        eventId: `expense_settled:${e.expenseId}`, groupId, type: 'expense_settled',
        actorId: e.paidBy, refId: e.expenseId,
        summary: `${titleOf(e)} marked settled`, at: Number(e.updatedAt) || 0,
      });
    }
  }

  const beforeSet = byId(before?.settlements, 'settlementId');
  for (const s of (Array.isArray(after.settlements) ? after.settlements : [])) {
    if (!s?.settlementId || beforeSet.has(s.settlementId)) continue;
    events.push({
      eventId: `settlement_added:${s.settlementId}`, groupId, type: 'settlement_added',
      actorId: s.fromUserId, refId: s.settlementId,
      summary: `${s.fromUserId} paid ${s.toUserId} ${s.amount}`, at: Number(s.createdAt) || 0,
    });
  }

  const beforeMem = byId(before?.members, 'userId');
  const afterMem = byId(after.members, 'userId');
  for (const [uid, m] of afterMem) {
    if (!beforeMem.has(uid)) {
      events.push({ eventId: `member_joined:${uid}`, groupId, type: 'member_joined', actorId: uid, refId: uid, summary: `${m.displayName ?? uid} joined`, at: 0 });
    }
  }
  for (const [uid, m] of beforeMem) {
    if (!afterMem.has(uid)) {
      events.push({ eventId: `member_left:${uid}`, groupId, type: 'member_left', actorId: uid, refId: uid, summary: `${m.displayName ?? uid} left`, at: 0 });
    }
  }

  return events;
}
