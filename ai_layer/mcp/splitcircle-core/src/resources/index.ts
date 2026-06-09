/**
 * resources/index.ts — MCP resources for splitcircle-core.
 *
 * Resources are read-only, URI-addressable data the host can attach as context.
 * All are scoped to the authenticated uid; the `{userId}` in the URI MUST equal
 * the caller's uid (we never serve another user's data).
 */

import type { DataAccess } from '../lib/dataAccess.js';
import { calculateBalances, minimizeDebts } from '../lib/balances.js';

export interface ResourceDef {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

export const resourceDefs: ResourceDef[] = [
  {
    uriTemplate: 'splitcircle://user/{userId}/expenses',
    name: 'User expenses',
    description: "The authenticated user's expenses across all groups (JSON).",
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'splitcircle://group/{groupId}/summary',
    name: 'Group summary',
    description: 'Summary of a group: members, expense count, totals (JSON).',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'splitcircle://group/{groupId}/balances',
    name: 'Group balances',
    description: 'Net balances and suggested settlements for a group (JSON).',
    mimeType: 'application/json',
  },
];

/** Resolve a resource URI to JSON content for the given authenticated uid. */
export async function readResource(uri: string, uid: string, data: DataAccess): Promise<string> {
  const u = new URL(uri.replace('splitcircle://', 'https://splitcircle/'));
  const segments = u.pathname.split('/').filter(Boolean);
  const host = u.host; // 'splitcircle'

  // splitcircle://user/{userId}/expenses
  if (host === 'splitcircle' && segments[0] === 'user' && segments[2] === 'expenses') {
    if (segments[1] !== uid) throw new Error('Forbidden: cannot read another user\'s resources');
    const groups = await data.getUserGroups(uid);
    const expenses = groups.flatMap((g) => g.expenses).filter(
      (e) => e.paidBy === uid || e.participants.some((p) => p.userId === uid),
    );
    return JSON.stringify({ expenses }, null, 2);
  }

  if (host === 'splitcircle' && segments[0] === 'group') {
    const groupId = segments[1];
    const group = await data.getGroup(uid, groupId); // enforces membership
    if (segments[2] === 'summary') {
      const total = group.expenses.reduce((s, e) => s + e.amount, 0);
      return JSON.stringify({
        groupId, name: group.name, currency: group.currency,
        members: group.members.map((m) => ({ userId: m.userId, displayName: m.displayName })),
        expenseCount: group.expenses.length, totalSpent: Number(total.toFixed(2)),
      }, null, 2);
    }
    if (segments[2] === 'balances') {
      const balances = calculateBalances(group.expenses, group.settlements);
      return JSON.stringify({
        groupId, currency: group.currency, balances, settlements: minimizeDebts(balances),
      }, null, 2);
    }
  }

  throw new Error(`Unknown resource URI: ${uri}`);
}
