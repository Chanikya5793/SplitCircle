/**
 * widgetService.ts — projects the user's group balances into the compact snapshot
 * the iOS home-screen / lock-screen / Control-Center widgets render.
 *
 * The widget runs in a SEPARATE process (a Widget Extension) that can't see the
 * app's storage, so the only channel is the App Group container. This service
 * computes balances through the SAME `expenseAnalytics` engine the rest of the app
 * uses (numbers never diverge from what the app shows) and hands the bytes to the
 * native `writeWidgetSnapshot`, which writes `widget.json` into the App Group and
 * reloads WidgetKit. See ai_layer/docs/19 for the full widget architecture.
 *
 * Best-effort and never throws into the caller (widgets are non-critical chrome).
 */

import { writeWidgetSnapshot, type WidgetGroupBalance } from '../../modules/splitcircle-ai';
import { getGroupAnalytics } from '@/utils/expenseAnalytics';
import type { Group } from '@/models';

/** Cap so the snapshot stays tiny — the widget only ever shows a handful. */
const MAX_WIDGET_GROUPS = 12;

/**
 * Recompute every group's balance for `userId` and publish the widget snapshot.
 * Called from the same place the offline group cache is refreshed
 * (`groupCache.persistGroups`) so the widget tracks the app 1:1.
 */
export function publishWidgetSnapshot(userId: string, groups: Group[]): void {
  if (!userId) return;
  try {
    const balances: WidgetGroupBalance[] = groups.slice(0, MAX_WIDGET_GROUPS).map((g) => {
      const a = getGroupAnalytics(g, userId);
      return {
        id: g.groupId,
        name: g.name || 'Group',
        memberCount: g.members?.length ?? 0,
        balance: a.userBalance,
        currency: g.currency || 'USD',
      };
    });
    writeWidgetSnapshot({ userId, updatedAt: Date.now(), groups: balances });
  } catch {
    // Best-effort — never break the cache-write path over a widget refresh.
  }
}
