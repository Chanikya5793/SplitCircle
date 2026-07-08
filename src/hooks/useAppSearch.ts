/**
 * useAppSearch — assembles a live, on-device search index from everything the
 * app already holds in memory (groups, expenses, friends, chats, calls) plus a
 * few quick actions, and exposes a fast ranked search over it. Respects the
 * privacy guard: while armed, shielded entities are dropped from the index so
 * search can't leak what the rest of the app is hiding.
 */

import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { ROUTES } from '@/constants/routes';
import { getCallHistory, type CallHistoryEntry } from '@/services/localCallStorage';
import { subscribeToFriends, type Friend } from '@/services/friendsService';
import { searchIndex, type SearchItem } from '@/services/searchService';
import type { AppSearchScope } from '@/services/searchScope';
import { formatCurrency } from '@/utils/currency';
import { useCallback, useEffect, useMemo, useState } from 'react';

const STATIC_ACTIONS: SearchItem[] = [
  { id: 'act-settings', type: 'action', title: 'Settings', subtitle: 'Appearance, security, account', icon: 'cog-outline', keywords: 'preferences account theme wallpaper', route: ROUTES.APP.SETTINGS },
  { id: 'act-ondevice-ai', type: 'action', title: 'On-device AI', subtitle: "What's indexed on this device", icon: 'sparkles', keywords: 'apple intelligence assistant privacy index', route: ROUTES.APP.AI_INDEX },
  { id: 'act-notifications', type: 'action', title: 'Notification settings', subtitle: 'Push and alerts', icon: 'bell-outline', keywords: 'alerts push mute', route: ROUTES.APP.NOTIFICATION_SETTINGS },
  { id: 'act-friends', type: 'action', title: 'Friends', subtitle: 'People you split with', icon: 'account-multiple-outline', keywords: 'contacts people balances', route: ROUTES.APP.FRIENDS },
  { id: 'act-calls', type: 'action', title: 'Calls', subtitle: 'Call history', icon: 'phone-outline', keywords: 'phone video history', route: ROUTES.APP.CALLS_TAB },
];

export const useAppSearch = () => {
  const { groups } = useGroups();
  const { threads } = useChat();
  const { user } = useAuth();
  const guard = usePrivacyGuard();

  const [friends, setFriends] = useState<Friend[]>([]);
  const [calls, setCalls] = useState<CallHistoryEntry[]>([]);

  useEffect(() => {
    if (!user?.userId) return;
    return subscribeToFriends(user.userId, setFriends);
  }, [user?.userId]);

  useEffect(() => {
    void getCallHistory().then(setCalls);
  }, []);

  const index = useMemo<SearchItem[]>(() => {
    const items: SearchItem[] = [...STATIC_ACTIONS];
    const shielded = (target: 'expenses' | 'chats' | 'calls' | 'friends', entityId?: string) =>
      guard.active && guard.isShielded(target, entityId);

    // Friends
    for (const f of friends) {
      if (f.hidden) continue;
      if (shielded('friends')) break;
      items.push({
        id: `friend-${f.userId}`,
        type: 'friend',
        title: f.displayName || 'Someone',
        subtitle: 'Friend',
        icon: 'account-circle-outline',
        route: ROUTES.APP.FRIEND_INFO,
        params: { userId: f.userId, displayName: f.displayName, photoURL: f.photoURL, backTitle: 'Search' },
        recency: f.lastInteractionAt,
        guardTarget: 'friends',
        guardEntityId: f.userId,
      });
    }

    // Groups + their expenses
    for (const g of groups) {
      const names: Record<string, string> = {};
      for (const m of [...(g.members ?? []), ...(g.archivedMembers ?? [])]) {
        names[m.userId] = (m as { displayName?: string }).displayName || m.userId;
      }

      if (!shielded('expenses', g.groupId)) {
        items.push({
          id: `group-${g.groupId}`,
          type: 'group',
          title: g.name,
          subtitle: `${(g.members ?? []).length} members · ${g.currency}`,
          icon: 'account-group-outline',
          keywords: Object.values(names).join(' '),
          route: ROUTES.APP.GROUPS_TAB,
          params: { screen: ROUTES.APP.GROUP_DETAILS, params: { groupId: g.groupId } },
          recency: g.updatedAt,
          guardTarget: 'expenses',
          guardEntityId: g.groupId,
        });

        items.push(
          {
            id: `act-add-expense-${g.groupId}`,
            type: 'action',
            title: `Add expense to ${g.name}`,
            subtitle: 'Create a new split',
            icon: 'plus-circle-outline',
            keywords: `new bill receipt split ${g.name} expense`,
            route: ROUTES.APP.ADD_EXPENSE,
            params: { groupId: g.groupId, backTitle: 'Search' },
            recency: g.updatedAt,
            guardTarget: 'expenses',
            guardEntityId: g.groupId,
          },
          {
            id: `act-settle-${g.groupId}`,
            type: 'action',
            title: `Settle up in ${g.name}`,
            subtitle: 'Record a payment',
            icon: 'handshake-outline',
            keywords: `pay payment settle balance owe owed ${g.name}`,
            route: ROUTES.APP.SETTLEMENTS,
            params: { groupId: g.groupId, backTitle: 'Search' },
            recency: g.updatedAt,
            guardTarget: 'expenses',
            guardEntityId: g.groupId,
          },
          {
            id: `act-stats-${g.groupId}`,
            type: 'action',
            title: `Stats for ${g.name}`,
            subtitle: 'Spending charts and trends',
            icon: 'chart-pie',
            keywords: `analytics chart spending trends totals ${g.name}`,
            route: ROUTES.APP.GROUP_STATS,
            params: { groupId: g.groupId, backTitle: 'Search' },
            recency: g.updatedAt,
            guardTarget: 'expenses',
            guardEntityId: g.groupId,
          },
          {
            id: `act-recurring-${g.groupId}`,
            type: 'action',
            title: `Recurring bills in ${g.name}`,
            subtitle: 'Scheduled expenses',
            icon: 'repeat',
            keywords: `subscriptions rent monthly automatic bills ${g.name}`,
            route: ROUTES.APP.RECURRING_BILLS,
            params: { groupId: g.groupId, backTitle: 'Search' },
            recency: g.updatedAt,
            guardTarget: 'expenses',
            guardEntityId: g.groupId,
          },
          {
            id: `act-group-info-${g.groupId}`,
            type: 'action',
            title: `${g.name} info`,
            subtitle: 'Members, invite code, photo',
            icon: 'information-outline',
            keywords: `members invite settings photo info ${g.name}`,
            route: ROUTES.APP.GROUP_INFO,
            params: { groupId: g.groupId, initialTitle: 'Group Info', backTitle: 'Search' },
            recency: g.updatedAt,
            guardTarget: 'expenses',
            guardEntityId: g.groupId,
          },
        );

        for (const e of g.expenses ?? []) {
          items.push({
            id: `expense-${e.expenseId}`,
            type: 'expense',
            title: e.title,
            subtitle: `${formatCurrency(e.amount, g.currency)} · ${e.category} · ${g.name}`,
            icon: 'receipt-text-outline',
            keywords: `${e.category} ${e.notes ?? ''} ${names[e.paidBy] ?? ''} ${g.name}`,
            route: ROUTES.APP.EXPENSE_DETAILS,
            params: { groupId: g.groupId, expenseId: e.expenseId, expenseTitle: e.title, backTitle: 'Search' },
            recency: e.updatedAt || e.createdAt,
            guardTarget: 'expenses',
            guardEntityId: g.groupId,
          });
        }

        for (const s of g.settlements ?? []) {
          const from = names[s.fromUserId] ?? 'Someone';
          const to = names[s.toUserId] ?? 'someone';
          items.push({
            id: `settlement-${s.settlementId}`,
            type: 'settlement',
            title: `${from} paid ${to}`,
            subtitle: `${formatCurrency(s.amount, g.currency)} · ${g.name}${s.note ? ` · ${s.note}` : ''}`,
            icon: 'cash-check',
            keywords: `${from} ${to} ${s.note ?? ''} settle settlement payment paid ${g.name}`,
            route: ROUTES.APP.SETTLEMENTS,
            params: { groupId: g.groupId, settlementId: s.settlementId, backTitle: 'Search' },
            recency: s.createdAt,
            guardTarget: 'expenses',
            guardEntityId: g.groupId,
          });
        }
      }
    }

    // Chats
    for (const t of threads) {
      if (shielded('chats', t.chatId)) continue;
      const title =
        t.type === 'group'
          ? groups.find((g) => g.groupId === t.groupId)?.name ?? 'Group chat'
          : t.participants.find((p) => p.userId !== user?.userId)?.displayName ?? 'Chat';
      const preview =
        guard.active && guard.settings.hidePreviews
          ? undefined
          : t.lastMessage?.type === 'text'
            ? t.lastMessage?.content
            : undefined;
      items.push({
        id: `chat-${t.chatId}`,
        type: 'chat',
        title,
        subtitle: preview || (t.type === 'group' ? 'Group chat' : 'Direct chat'),
        icon: t.type === 'group' ? 'forum-outline' : 'message-text-outline',
        keywords: t.participants.map((p) => p.displayName).join(' '),
        route: ROUTES.APP.GROUP_CHAT,
        params: { chatId: t.chatId, initialTitle: title, backTitle: 'Search' },
        recency: t.lastMessage?.createdAt,
        guardTarget: 'chats',
        guardEntityId: t.chatId,
      });
    }

    // Calls
    if (!shielded('calls')) {
      for (const c of calls) {
        const who = c.otherParticipant?.displayName || 'Unknown';
        items.push({
          id: `call-${c.callId}`,
          type: 'call',
          title: who,
          subtitle: `${c.type === 'video' ? 'Video' : 'Voice'} call · ${c.direction ?? ''}`,
          icon: c.type === 'video' ? 'video-outline' : 'phone-outline',
          route: ROUTES.APP.CALLS_TAB,
          recency: c.startedAt,
          guardTarget: 'calls',
        });
      }
    }

    return items;
  }, [groups, threads, friends, calls, user?.userId, guard.active, guard.settings]);

  const itemMatchesScope = useCallback((item: SearchItem, scope: AppSearchScope) => {
    if (scope === 'all') return true;
    if (scope === 'expenses') {
      return (
        item.type === 'group' ||
        item.type === 'expense' ||
        item.type === 'settlement' ||
        item.type === 'friend' ||
        item.guardTarget === 'expenses' ||
        item.guardTarget === 'friends' ||
        item.route === ROUTES.APP.FRIENDS
      );
    }
    if (scope === 'chat') {
      return item.type === 'chat' || item.route === ROUTES.APP.CHAT_TAB || item.route === ROUTES.APP.GROUP_CHAT;
    }
    if (scope === 'calls') {
      return item.type === 'call' || item.route === ROUTES.APP.CALLS_TAB;
    }
    return (
      item.type === 'action' &&
      (item.route === ROUTES.APP.SETTINGS ||
        item.route === ROUTES.APP.NOTIFICATION_SETTINGS ||
        item.route === ROUTES.APP.AI_INDEX)
    );
  }, []);

  const search = useCallback(
    (query: string, scope: AppSearchScope = 'all') =>
      searchIndex(query, index.filter((item) => itemMatchesScope(item, scope))),
    [index, itemMatchesScope],
  );
  const firstSearchableGroupId = useMemo(
    () => index.find((item) => item.type === 'group')?.guardEntityId,
    [index],
  );

  return { search, indexSize: index.length, firstSearchableGroupId };
};
