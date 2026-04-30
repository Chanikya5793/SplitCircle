import { ROUTES } from '@/constants';
import type { Group } from '@/models';
import type { ChatThread } from '@/models/chat';
import type { CallHistoryEntry } from '@/services/localCallStorage';

type NamedGroup = Pick<Group, 'groupId' | 'name'>;

export const ROOT_SCREEN_TITLES = {
  groups: 'Groups',
  friends: 'Friends',
  chats: 'Chats',
  calls: 'Calls',
  settings: 'Settings',
} as const;

export const SCREEN_TITLES = {
  groupDetailsFallback: 'Group',
  groupChatFallback: 'Chat',
  groupInfo: 'Group Info',
  messageInfo: 'Message Info',
  expenseDetailsFallback: 'Expense Details',
  groupStats: 'Group Stats',
  recurringBills: 'Recurring Bills',
  callDetailsFallback: 'Call Details',
  liveCall: 'Live call',
  notifications: 'Notifications',
} as const;

export const getGroupNameById = (
  groups: NamedGroup[],
  groupId?: string,
  fallback: string = ROOT_SCREEN_TITLES.groups,
): string => {
  if (!groupId) {
    return fallback;
  }

  return groups.find((group) => group.groupId === groupId)?.name || fallback;
};

export const getChatThreadTitle = (
  thread: ChatThread | undefined,
  groups: NamedGroup[],
  currentUserId?: string,
): string => {
  if (!thread) {
    return ROOT_SCREEN_TITLES.chats;
  }

  if (thread.type === 'group' && thread.groupId) {
    return getGroupNameById(groups, thread.groupId, 'Group Chat');
  }

  const otherParticipant =
    thread.participants.find((participant) => participant.userId !== currentUserId) ??
    thread.participants[0];

  return otherParticipant?.displayName || ROOT_SCREEN_TITLES.chats;
};

export const getExpenseDetailsTitle = (expenseTitle?: string): string => {
  const trimmed = expenseTitle?.trim();
  return trimmed ? trimmed : SCREEN_TITLES.expenseDetailsFallback;
};

export const getCallInfoTitle = (entry: CallHistoryEntry): string => {
  const trimmed = entry.otherParticipant.displayName?.trim();
  return trimmed ? trimmed : SCREEN_TITLES.callDetailsFallback;
};

type RouteLike = {
  name?: string;
  params?: Record<string, any>;
  state?: {
    index?: number;
    routes?: RouteLike[];
  };
};

const getNestedRouteCandidate = (route: RouteLike | undefined): RouteLike | undefined => {
  if (!route) {
    return undefined;
  }

  const nestedRoutes = route.state?.routes;
  if (Array.isArray(nestedRoutes) && nestedRoutes.length > 0) {
    const nestedIndex =
      typeof route.state?.index === 'number'
        ? Math.min(Math.max(route.state.index, 0), nestedRoutes.length - 1)
        : nestedRoutes.length - 1;

    return nestedRoutes[nestedIndex];
  }

  const nestedScreen = route.params?.screen;
  if (typeof nestedScreen === 'string') {
    return {
      name: nestedScreen,
      params: route.params?.params,
    };
  }

  return undefined;
};

export const getRouteBackLabel = (route: RouteLike | undefined): string | undefined => {
  if (!route) {
    return undefined;
  }

  const nestedRoute = getNestedRouteCandidate(route);
  if (nestedRoute) {
    const nestedLabel = getRouteBackLabel(nestedRoute);
    if (nestedLabel) {
      return nestedLabel;
    }
  }

  switch (route.name) {
    case ROUTES.APP.ROOT:
    case ROUTES.APP.GROUPS_TAB:
    case ROUTES.APP.GROUPS:
      return ROOT_SCREEN_TITLES.groups;
    case ROUTES.APP.CHAT_TAB:
      return ROOT_SCREEN_TITLES.chats;
    case ROUTES.APP.CALLS_TAB:
      return ROOT_SCREEN_TITLES.calls;
    case ROUTES.APP.SETTINGS:
      return ROOT_SCREEN_TITLES.settings;
    case ROUTES.APP.GROUP_DETAILS:
      return route.params?.initialTitle?.trim() || SCREEN_TITLES.groupDetailsFallback;
    case ROUTES.APP.GROUP_CHAT:
      return route.params?.initialTitle?.trim() || SCREEN_TITLES.groupChatFallback;
    case ROUTES.APP.GROUP_INFO:
      return SCREEN_TITLES.groupInfo;
    case ROUTES.APP.MESSAGE_INFO:
      return SCREEN_TITLES.messageInfo;
    case ROUTES.APP.EXPENSE_DETAILS:
      return getExpenseDetailsTitle(route.params?.expenseTitle);
    case ROUTES.APP.GROUP_STATS:
      return SCREEN_TITLES.groupStats;
    case ROUTES.APP.RECURRING_BILLS:
      return SCREEN_TITLES.recurringBills;
    case ROUTES.APP.CALL_INFO:
      return route.params?.entry ? getCallInfoTitle(route.params.entry) : SCREEN_TITLES.callDetailsFallback;
    case ROUTES.APP.CALL_DETAIL:
      return SCREEN_TITLES.liveCall;
    case ROUTES.APP.NOTIFICATION_SETTINGS:
      return SCREEN_TITLES.notifications;
    default:
      return undefined;
  }
};
