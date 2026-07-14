/**
 * widgetService.ts — projects the user's group data into the shared snapshot that
 * powers BOTH the iOS widgets AND the headless Siri/Shortcuts read intents.
 *
 * The widget + a Siri App Intent both run in contexts that can't see the app's
 * storage or JS runtime, so the only channel is the App Group container. This
 * service computes everything through the SAME `expenseAnalytics` engine the app
 * uses (numbers never diverge) and hands the bytes to native `writeWidgetSnapshot`,
 * which writes `widget.json` and reloads WidgetKit. See ai_layer/docs/19.
 *
 * The widget reads only the balance summary; the richer fields (per-member balances,
 * categories, who-you-owe, recent expenses) let Siri answer "what did I spend on food
 * in Tahoe", "how much do I owe Sarah", "show my recent expenses" without launching
 * the app. Best-effort — never throws into the caller.
 */

import { writeWidgetSnapshot, type WidgetGroupBalance } from '../../modules/splitcircle-ai';
import { getGroupAnalytics } from '@/utils/expenseAnalytics';
import { writeWidgetSnapshotMirror } from '@/services/aiIndexStore';
import type { Group } from '@/models';

/** Cap so the snapshot stays small — Siri/widgets only ever show a handful. */
const MAX_WIDGET_GROUPS = 12;
const MAX_RECENT_EXPENSES = 8;
const MAX_CATEGORIES = 8;

/**
 * Recompute every group's balances + activity for `userId` and publish the shared
 * snapshot. Called from `groupCache.persistGroups` so it tracks the app 1:1.
 */
export function publishWidgetSnapshot(userId: string, groups: Group[]): void {
  if (!userId) return;
  try {
    const balances: WidgetGroupBalance[] = groups.slice(0, MAX_WIDGET_GROUPS).map((g) => {
      const a = getGroupAnalytics(g, userId);

      // userId → display name, incl. members who have left (archivedMembers).
      const nameOf = (uid: string): string => {
        const m = g.members.find((x) => x.userId === uid)
          ?? g.archivedMembers?.find((x) => x.userId === uid);
        return m?.displayName || 'Someone';
      };

      const members = g.members.map((m) => ({
        id: m.userId,
        name: m.displayName || 'Someone',
        balance: a.balances[m.userId] ?? 0,
      }));

      const categories = a.byCategory.slice(0, MAX_CATEGORIES).map((c) => ({
        category: c.category,
        total: c.total,
      }));

      // debts is the minimized settle-up plan (from/to are userIds). Split into the
      // current user's perspective so "how much do I owe X" is a direct lookup.
      const youOwe = a.debts
        .filter((d) => d.from === userId)
        .map((d) => ({ name: nameOf(d.to), amount: d.amount }));
      const owesYou = a.debts
        .filter((d) => d.to === userId)
        .map((d) => ({ name: nameOf(d.from), amount: d.amount }));

      const recentExpenses = [...(g.expenses ?? [])]
        .sort((x, y) => (y.createdAt ?? 0) - (x.createdAt ?? 0))
        .slice(0, MAX_RECENT_EXPENSES)
        .map((e) => ({
          id: `${g.groupId}::${e.expenseId}`,
          title: e.title || 'Expense',
          amount: e.amount,
          category: e.category || 'General',
          date: e.createdAt ?? 0,
          paidByName: nameOf(e.paidBy),
        }));

      return {
        id: g.groupId,
        name: g.name || 'Group',
        memberCount: g.members?.length ?? 0,
        balance: a.userBalance,
        currency: g.currency || 'USD',
        totalSpend: a.totalSpend,
        count: a.count,
        members,
        categories,
        youOwe,
        owesYou,
        recentExpenses,
      };
    });
    const snapshot = { userId, updatedAt: Date.now(), groups: balances };
    // Channel 1: App Group container — the widget process's only readable source
    // (no-ops until the App Group capability is provisioned; see docs/19).
    writeWidgetSnapshot(snapshot);
    // Channel 2: SQLite mirror in the app's own container — readable by in-process
    // headless Siri/Shortcuts intents TODAY, without the App Group entitlement. This
    // is what makes "check my balance", "recent expenses", "what do I owe X" work.
    writeWidgetSnapshotMirror(userId, JSON.stringify(snapshot));
  } catch {
    // Best-effort — never break the cache-write path over a snapshot refresh.
  }
}
