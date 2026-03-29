import type { Group } from '@/models';
import type { ChatThread } from '@/models/chat';
import type { CallHistoryEntry } from '@/services/localCallStorage';

type NamedGroup = Pick<Group, 'groupId' | 'name'>;

export const ROOT_SCREEN_TITLES = {
  groups: 'Groups',
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
