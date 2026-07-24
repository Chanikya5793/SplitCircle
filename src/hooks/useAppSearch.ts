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
import { SETTINGS_REGISTRY } from '@/constants/settingsRegistry';
import { getCallHistory, type CallHistoryEntry } from '@/services/localCallStorage';
import { subscribeToFriends, type Friend } from '@/services/friendsService';
import { getChatMessagesPaginated } from '@/services/localMessageStorage';
import { searchIndex, type SearchItem } from '@/services/searchService';
import { formatCurrency } from '@/utils/currency';
import { resolveDisplayName } from '@/utils/identity';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Search is universal (doc 20: scope chips were deliberately removed), so
// this is only load-bearing as a type for the ranking helpers below — every
// call site here hardcodes 'all'. There used to be a separate live
// last-active-scope tracker (services/searchScope.ts); it was write-only
// (nothing ever read it) and was removed rather than kept running unused.
export type AppSearchScope = 'expenses' | 'chat' | 'calls' | 'settings' | 'all';

// How many recent messages per thread are folded into global search. Capped so
// the index stays small and the async build never blocks typing.
const MESSAGE_INDEX_PER_THREAD = 200;
// Longest message snippet kept as a result title — keeps rows tidy and scoring cheap.
const MESSAGE_SNIPPET_MAX = 140;
// Debounce for rebuilding the (non-message) index when underlying data churns.
const INDEX_BUILD_DEBOUNCE_MS = 150;

const STATIC_ACTIONS: SearchItem[] = [
  { id: 'act-settings', type: 'action', title: 'Settings', subtitle: 'Appearance, security, account', icon: 'cog-outline', keywords: 'preferences account theme wallpaper', route: ROUTES.APP.SETTINGS },
  { id: 'act-ondevice-ai', type: 'action', title: 'On-device AI', subtitle: "What's indexed on this device", icon: 'sparkles', keywords: 'apple intelligence assistant privacy index', route: ROUTES.APP.AI_INDEX },
  { id: 'act-notifications', type: 'action', title: 'Notification settings', subtitle: 'Push and alerts', icon: 'bell-outline', keywords: 'alerts push mute', route: ROUTES.APP.NOTIFICATION_SETTINGS },
  { id: 'act-friends', type: 'action', title: 'Friends', subtitle: 'People you split with', icon: 'account-multiple-outline', keywords: 'contacts people balances', route: ROUTES.APP.FRIENDS },
  { id: 'act-calls', type: 'action', title: 'Calls', subtitle: 'Call history', icon: 'phone-outline', keywords: 'phone video history', route: ROUTES.APP.CALLS_TAB },
];

// Per-item settings tier: every individual setting (toggle/row) drawn from the
// declarative registry so users can search a specific preference and deep-link
// straight to it. Each carries a `highlight` param the target screen uses to
// scroll the row into view and pulse it. Always available (no user data). These
// use the existing 'action' item type so no changes to searchService are needed;
// the settings scope narrows them to the right screens.
const SETTINGS_ACTIONS: SearchItem[] = SETTINGS_REGISTRY.map((entry) => ({
  id: `setting-${entry.id}`,
  type: 'action',
  title: entry.title,
  subtitle: entry.subtitle,
  icon: entry.icon,
  keywords: `${entry.keywords.join(' ')} ${entry.section} setting settings`,
  route: entry.route,
  params: { highlight: entry.id, backTitle: 'Search' },
}));

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

  // Keep the latest groups reachable from the async message-index build without
  // making that effect re-run on every unrelated group change (e.g. an expense
  // edit) — the ref is read only to resolve group-chat titles.
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  // Base index (everything except messages) — built off the render path in a
  // debounced effect keyed on the underlying data, then stored in state. This
  // replaces the old per-render useMemo flatten so typing never triggers a
  // full rebuild.
  const buildBaseIndex = useCallback((): SearchItem[] => {
    const items: SearchItem[] = [...STATIC_ACTIONS, ...SETTINGS_ACTIONS];
    const shielded = (target: 'expenses' | 'chats' | 'calls' | 'friends', entityId?: string) =>
      guard.active && guard.isShielded(target, entityId);

    // Friends
    for (const f of friends) {
      if (f.hidden) continue;
      if (shielded('friends')) break;
      items.push({
        id: `friend-${f.userId}`,
        type: 'friend',
        title: resolveDisplayName(f, 'Someone'),
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
        names[m.userId] = resolveDisplayName(m, 'Someone');
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
      // Locked chats live behind the biometric folder — they must never leak
      // through global search (title, preview, or navigability).
      if (user?.lockedChats?.[t.chatId]) continue;
      const title =
        t.type === 'group'
          ? groups.find((g) => g.groupId === t.groupId)?.name ?? 'Group chat'
          : resolveDisplayName(t.participants.find((p) => p.userId !== user?.userId), 'Chat');
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
        const who = resolveDisplayName(c.otherParticipant, 'Unknown');
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, threads, friends, calls, user?.userId, user?.lockedChats, guard.active, guard.settings]);

  const [baseIndex, setBaseIndex] = useState<SearchItem[]>([]);
  const [messageIndex, setMessageIndex] = useState<SearchItem[]>([]);

  // Debounced base-index build: coalesces bursts of data changes into a single
  // off-render rebuild instead of reflattening on every keystroke/render.
  useEffect(() => {
    const t = setTimeout(() => setBaseIndex(buildBaseIndex()), INDEX_BUILD_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [buildBaseIndex]);

  // Message tier: cached history folded into search, capped per thread and built
  // asynchronously (awaiting AsyncStorage yields between threads) so it never
  // stutters the UI. Results publish progressively as threads are scanned.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const collected: SearchItem[] = [];
      for (const t of threads) {
        if (cancelled) return;
        // Never index a chat the privacy guard is actively shielding, and
        // never index message BODIES at all once "hide previews" is on — the
        // base chat-item tier above already withholds the preview text for
        // that setting; this tier was the one place full message content
        // still leaked in as searchable result titles regardless of it.
        if (guard.active && (guard.isShielded('chats', t.chatId) || guard.settings.hidePreviews)) continue;
        // Never index message bodies of a locked chat — the biometric gate
        // would be meaningless if its content surfaced in search results.
        if (user?.lockedChats?.[t.chatId]) continue;

        let page: { messages: import('@/models').ChatMessage[] };
        try {
          page = await getChatMessagesPaginated(t.chatId, { limit: MESSAGE_INDEX_PER_THREAD });
        } catch {
          continue;
        }
        if (cancelled) return;

        const chatTitle =
          t.type === 'group'
            ? groupsRef.current.find((g) => g.groupId === t.groupId)?.name ?? 'Group chat'
            : resolveDisplayName(t.participants.find((p) => p.userId !== user?.userId), 'Chat');

        for (const m of page.messages) {
          if (m.type !== 'text') continue;
          if (m.deletedForEveryone) continue;
          if (user?.userId && m.deletedFor?.includes(user.userId)) continue;
          const content = (m.content ?? '').trim();
          if (!content) continue;
          const msgId = m.messageId || m.id;
          collected.push({
            id: `message-${msgId}`,
            type: 'message',
            title: content.length > MESSAGE_SNIPPET_MAX ? `${content.slice(0, MESSAGE_SNIPPET_MAX)}…` : content,
            subtitle: chatTitle,
            icon: 'message-text-outline',
            route: ROUTES.APP.GROUP_CHAT,
            params: { chatId: t.chatId, initialTitle: chatTitle, backTitle: 'Search', messageId: msgId },
            recency: m.createdAt,
            guardTarget: 'chats',
            guardEntityId: t.chatId,
          });
        }

        if (!cancelled) setMessageIndex([...collected]);
      }
      if (!cancelled) setMessageIndex(collected);
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, user?.userId, user?.lockedChats, guard.active, guard.settings]);

  // Full index is a cheap concat of the two tiers — no expensive reflatten.
  const index = useMemo<SearchItem[]>(() => [...baseIndex, ...messageIndex], [baseIndex, messageIndex]);

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
      return (
        item.type === 'chat' ||
        item.type === 'message' ||
        item.route === ROUTES.APP.CHAT_TAB ||
        item.route === ROUTES.APP.GROUP_CHAT
      );
    }
    if (scope === 'calls') {
      return item.type === 'call' || item.route === ROUTES.APP.CALLS_TAB;
    }
    return (
      item.type === 'action' &&
      (item.route === ROUTES.APP.SETTINGS ||
        item.route === ROUTES.APP.NOTIFICATION_SETTINGS ||
        item.route === ROUTES.APP.AI_INDEX ||
        item.route === ROUTES.APP.OFFLINE_SYNC)
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

  // Dynamic, scope-aware "try this" suggestions drawn from the user's real data
  // (recent groups, frequently-contacted friends, recent call peers) instead of
  // a hardcoded list. Privacy-guard-shielded entities are never suggested.
  const getSuggestions = useCallback(
    (scope: AppSearchScope): string[] => {
      const byRecency = (a?: number, b?: number) => (b ?? 0) - (a ?? 0);
      const shielded = (target: 'expenses' | 'chats' | 'calls' | 'friends', entityId?: string) =>
        guard.active && guard.isShielded(target, entityId);
      const uniq = (arr: string[]) =>
        Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));

      const groupNames = shielded('expenses')
        ? []
        : uniq(
            [...groups]
              .filter((g) => !shielded('expenses', g.groupId))
              .sort((a, b) => byRecency(a.updatedAt, b.updatedAt))
              .map((g) => g.name),
          );
      const friendNames = shielded('friends')
        ? []
        : uniq(
            [...friends]
              .filter((f) => !f.hidden && !shielded('friends', f.userId))
              .sort((a, b) => byRecency(a.lastInteractionAt, b.lastInteractionAt))
              .map((f) => resolveDisplayName(f, '')),
          );
      const callNames = shielded('calls')
        ? []
        : uniq(
            [...calls]
              .sort((a, b) => byRecency(a.startedAt, b.startedAt))
              .map((c) => resolveDisplayName(c.otherParticipant, '')),
          );

      switch (scope) {
        case 'expenses':
          return uniq([...groupNames, ...friendNames]).slice(0, 6);
        case 'chat':
          return uniq([...friendNames, ...groupNames]).slice(0, 6);
        case 'calls':
          return callNames.slice(0, 6);
        case 'settings':
          return ['Privacy', 'Notifications', 'AI index', 'Theme', 'Account'];
        default:
          return uniq([...groupNames.slice(0, 3), ...friendNames.slice(0, 3)]).slice(0, 6);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, friends, calls, guard.active],
  );

  return { search, indexSize: index.length, firstSearchableGroupId, getSuggestions };
};
