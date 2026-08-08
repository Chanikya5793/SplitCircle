// ChatThreadRow — the single source of truth for a conversation row across the
// chat list and its dedicated Archived / Locked screens. It owns the swipe
// affordances (pin/lock/archive/restore/unlock), the long-press menu, and its
// own last-message preview + unread badge (subscribed from local storage), so
// every screen that lists threads renders them identically.

import { FONT_CAP } from '@/utils/a11yText';
import { GlassView } from '@/components/GlassView';
import { GroupAvatar, ListSeparator, UserAvatar } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useGroups } from '@/context/GroupContext';
import { useNotificationContext } from '@/context/NotificationContext';
import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { useTheme } from '@/context/ThemeContext';
import { usePrivacyMask } from '@/hooks/usePrivacyMask';
import type { ChatMessage, ChatThread } from '@/models';
import {
  archiveChat,
  isChatArchived,
  pinChat,
  unarchiveChat,
  unpinChat,
} from '@/services/archiveService';
import { lockChat, unlockChat } from '@/services/chatLockService';
import { getChatMessages, subscribeToLocalMessages } from '@/services/localMessageStorage';
import { appAlert } from '@/utils/appAlert';
import { isInChatMap } from '@/utils/chatOrganization';
import { resolveDisplayName } from '@/utils/identity';
import { heavyHaptic, lightHaptic, successHaptic } from '@/utils/haptics';
import { clearOpenSwipeable, setOpenSwipeable } from '@/utils/swipeableRegistry';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { usePressFeedback } from '@/hooks/usePressFeedback';
import { RectButton, Swipeable } from 'react-native-gesture-handler';
import { IconButton, List, Text } from 'react-native-paper';

export type ChatRowVariant = 'active' | 'archived' | 'locked';

// iOS-standard swipe-action colors — these are affordance colors (like the
// system Mail/Messages actions), intentionally consistent across light/dark.
const ACTION_COLOR = {
  archive: '#FF9500',
  restore: '#34C759',
  pin: '#0A84FF',
  lock: '#5E5CE6',
  unlock: '#34C759',
} as const;

const SwipeActionButton = ({
  color,
  icon,
  label,
  grouped,
  onPress,
}: {
  color: string;
  icon: string;
  label: string;
  grouped?: boolean;
  onPress: () => void;
}) => (
  <RectButton
    style={[grouped ? styles.rowActionButtonGrouped : styles.rowActionButton, { backgroundColor: color }]}
    onPress={onPress}
  >
    <IconButton icon={icon} iconColor="#fff" size={22} style={{ margin: 0 }} />
    <Text style={styles.rowActionText}>{label}</Text>
  </RectButton>
);

/**
 * Swipe wrapper for a chat row. The gesture language matches WhatsApp / iOS:
 *   • active rows  — swipe RIGHT (left actions) = Pin/Unpin, swipe LEFT
 *                    (right actions) = Lock + Archive
 *   • archived rows — swipe LEFT = Restore
 *   • locked rows   — swipe LEFT = Unlock
 * Buttons are full-height with real touch targets; opening fires a light
 * haptic and rows spring closed after an action.
 */
const SwipeableChatRow = ({
  variant,
  pinned,
  onPin,
  onArchiveToggle,
  onLock,
  onUnlock,
  children,
}: {
  variant: ChatRowVariant;
  pinned?: boolean;
  onPin?: () => void;
  onArchiveToggle?: () => void;
  onLock?: () => void;
  onUnlock?: () => void;
  children: ReactNode;
}) => {
  const swipeableRef = useRef<Swipeable>(null);

  const runAction = (fn?: () => void) => {
    heavyHaptic();
    swipeableRef.current?.close();
    fn?.();
  };

  const renderLeftActions =
    variant === 'active' && onPin
      ? () => (
          <View style={styles.rowActionLeft}>
            <SwipeActionButton
              color={ACTION_COLOR.pin}
              icon={pinned ? 'pin-off' : 'pin'}
              label={pinned ? 'Unpin' : 'Pin'}
              onPress={() => runAction(onPin)}
            />
          </View>
        )
      : undefined;

  const renderRightActions = () => {
    if (variant === 'locked') {
      return (
        <View style={styles.rowAction}>
          <SwipeActionButton color={ACTION_COLOR.unlock} icon="lock-open-variant" label="Unlock" onPress={() => runAction(onUnlock)} />
        </View>
      );
    }
    if (variant === 'archived') {
      return (
        <View style={styles.rowAction}>
          <SwipeActionButton color={ACTION_COLOR.restore} icon="archive-arrow-up" label="Restore" onPress={() => runAction(onArchiveToggle)} />
        </View>
      );
    }
    return (
      <View style={styles.rowActionRow}>
        <SwipeActionButton grouped color={ACTION_COLOR.lock} icon="lock" label="Lock" onPress={() => runAction(onLock)} />
        <SwipeActionButton grouped color={ACTION_COLOR.archive} icon="archive" label="Archive" onPress={() => runAction(onArchiveToggle)} />
      </View>
    );
  };

  return (
    <Swipeable
      ref={swipeableRef}
      renderLeftActions={renderLeftActions}
      renderRightActions={renderRightActions}
      friction={2}
      leftThreshold={40}
      rightThreshold={40}
      overshootFriction={8}
      onSwipeableWillOpen={() => {
        lightHaptic();
        setOpenSwipeable(swipeableRef.current);
      }}
      onSwipeableClose={() => clearOpenSwipeable(swipeableRef.current)}
    >
      {children}
    </Swipeable>
  );
};

interface ChatThreadRowProps {
  thread: ChatThread;
  variant: ChatRowVariant;
  /** Navigate into the thread. The row runs its own haptic + lazy-unarchive
   *  cleanup first, so callers only need to perform navigation here. */
  onOpenThread: (thread: ChatThread) => void;
  /** User ids currently typing in this chat (excluding self). When present the
   *  row shows a WhatsApp-style "typing…" label in place of the last-message
   *  preview. Callers own the RTDB subscription (see useChatListTyping). */
  typingUserIds?: string[];
}

export const ChatThreadRow = ({ thread, variant, onOpenThread, typingUserIds }: ChatThreadRowProps) => {
  const { user } = useAuth();
  const { groups } = useGroups();
  const { theme } = useTheme();
  const { pressScaleStyle, pressHighlightStyle, touchableProps } = usePressFeedback();
  const { preferences, updatePreference } = useNotificationContext();
  const { isShielded } = usePrivacyGuard();
  const { maskChatTitle: maskChatTitleRaw, maskPreview } = usePrivacyMask();
  // Group chats disguise as circle names, DMs as person names.
  const maskChatTitle = (t: string, chatId?: string) =>
    maskChatTitleRaw(t, chatId, thread.type === 'group' ? 'group' : 'person');

  const chatsAnyShielded = isShielded('chats');
  const pinnedChats = user?.pinnedChats;
  const archivedChats = user?.archivedChats;

  // Per-row *visible* last message + unread count — derived from local storage
  // so a deleted or edited message is reflected immediately. The Firestore-side
  // `thread.lastMessage` is only used as a fallback until local storage
  // hydrates.
  const [lastMessage, setLastMessage] = useState<ChatMessage | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (!user) return;
    let active = true;

    const recompute = async () => {
      const msgs = await getChatMessages(thread.chatId);
      if (!active) return;
      const sorted = [...msgs].sort((a, b) => b.createdAt - a.createdAt);
      // Walk newest-first; first item not deleted-for-me and not deleted-for-everyone wins.
      const visible =
        sorted.find(
          (m) => !m.deletedForEveryone && !(m.deletedFor ?? []).includes(user.userId),
        ) ?? null;
      setLastMessage(visible);

      const unread = msgs.filter(
        (m) =>
          m.senderId !== user.userId &&
          !m.deletedForEveryone &&
          !(m.deletedFor ?? []).includes(user.userId) &&
          (!m.readBy || !m.readBy.includes(user.userId)),
      ).length;
      setUnreadCount(unread);
    };

    void recompute();
    const unsub = subscribeToLocalMessages(thread.chatId, () => void recompute());
    return () => {
      active = false;
      unsub();
    };
  }, [thread.chatId, user]);

  const getChatTitle = (): string => {
    if (thread.type === 'group' && thread.groupId) {
      const group = groups.find((g) => g.groupId === thread.groupId);
      return group?.name || 'Group Chat';
    }
    const other = thread.participants.find((p) => p.userId !== user?.userId) ?? thread.participants[0];
    return resolveDisplayName(other, 'Direct Chat');
  };

  const getChatAvatar = (): { kind: 'group' | 'user'; photoURL?: string; name: string } => {
    if (thread.type === 'group' && thread.groupId) {
      const group = groups.find((g) => g.groupId === thread.groupId);
      return { kind: 'group', photoURL: group?.photoURL, name: group?.name || 'Group Chat' };
    }
    const other = thread.participants.find((p) => p.userId !== user?.userId) ?? thread.participants[0];
    return { kind: 'user', photoURL: other?.photoURL, name: resolveDisplayName(other, 'Direct Chat') };
  };

  const lastPreviewFor = (): string => {
    const msg = lastMessage ?? thread.lastMessage ?? null;
    if (!msg) return 'No messages yet';
    if (msg.deletedForEveryone) return '🚫 This message was deleted';
    if (user && (msg.deletedFor ?? []).includes(user.userId)) return 'No messages yet';
    return msg.content || (
      msg.type === 'image' ? '📷 Photo'
        : msg.type === 'video' ? '🎥 Video'
        : msg.type === 'audio' ? '🎵 Audio'
        : msg.type === 'file' ? '📄 Document'
        : msg.type === 'location' ? '📍 Location'
        : ''
    );
  };

  const handleOpen = () => {
    lightHaptic();
    // Lazy cleanup: if this chat auto-unarchived (new message arrived after
    // archiving), drop the stale map entry now that the user is opening it.
    if (user && archivedChats?.[thread.chatId] && !isChatArchived(archivedChats, thread)) {
      void unarchiveChat(user.userId, thread.chatId).catch(() => { /* cosmetic cleanup; safe to ignore */ });
    }
    onOpenThread(thread);
  };

  const handleArchiveToggle = async () => {
    if (!user) return;
    const archived = variant === 'archived';
    try {
      if (archived) {
        await unarchiveChat(user.userId, thread.chatId);
      } else {
        await archiveChat(user.userId, thread.chatId);
      }
      successHaptic();
    } catch (error) {
      console.error('Failed to toggle chat archive', error);
      appAlert('Error', `Failed to ${archived ? 'restore' : 'archive'} chat. Please try again.`);
    }
  };

  const handleTogglePin = async () => {
    if (!user) return;
    const pinned = isInChatMap(pinnedChats, thread.chatId);
    try {
      if (pinned) {
        await unpinChat(user.userId, thread.chatId);
      } else {
        await pinChat(user.userId, thread.chatId);
      }
      successHaptic();
    } catch (error) {
      console.error('Failed to toggle chat pin', error);
      appAlert('Error', `Failed to ${pinned ? 'unpin' : 'pin'} chat. Please try again.`);
    }
  };

  const handleLock = async () => {
    if (!user) return;
    try {
      await lockChat(user.userId, thread.chatId);
      successHaptic();
    } catch (error) {
      console.error('Failed to lock chat', error);
      appAlert('Error', 'Failed to lock chat. Please try again.');
    }
  };

  const handleUnlock = async () => {
    if (!user) return;
    try {
      await unlockChat(user.userId, thread.chatId);
      successHaptic();
    } catch (error) {
      console.error('Failed to unlock chat', error);
      appAlert('Error', 'Failed to unlock chat. Please try again.');
    }
  };

  const muted = (preferences.muteChatIds ?? []).includes(thread.chatId);

  const handleToggleMute = () => {
    const current = preferences.muteChatIds ?? [];
    const next = current.includes(thread.chatId)
      ? current.filter((id) => id !== thread.chatId)
      : [...current, thread.chatId];
    void updatePreference('muteChatIds', next);
    successHaptic();
  };

  const pinned = isInChatMap(pinnedChats, thread.chatId);
  const locked = variant === 'locked';

  const handleLongPress = () => {
    heavyHaptic();
    if (locked) {
      appAlert(maskChatTitle(getChatTitle(), thread.chatId), undefined, [
        { text: 'Unlock chat', onPress: () => void handleUnlock() },
        { text: 'Cancel', style: 'cancel' },
      ]);
      return;
    }
    const options: Array<{ text: string; onPress?: () => void; style?: 'cancel' | 'destructive' }> = [
      {
        text: muted ? 'Unmute notifications' : 'Mute notifications',
        onPress: () => handleToggleMute(),
      },
    ];
    if (variant === 'active') {
      options.push({
        text: pinned ? 'Unpin chat' : 'Pin chat',
        onPress: () => void handleTogglePin(),
      });
      options.push({ text: 'Lock chat', onPress: () => void handleLock() });
    }
    options.push({
      text: variant === 'archived' ? 'Restore chat' : 'Archive chat',
      onPress: () => void handleArchiveToggle(),
    });
    options.push({ text: 'Cancel', style: 'cancel' });
    appAlert(maskChatTitle(getChatTitle(), thread.chatId), undefined, options);
  };

  // WhatsApp-style typing label. Directs show a bare "typing…"; groups resolve
  // the typing ids to first names against the thread participants. Hidden while
  // the chats scope is shielded so a peer name can't leak past the guard.
  const typingLabel = useMemo(() => {
    if (!typingUserIds || typingUserIds.length === 0) return null;
    if (thread.type !== 'group') return 'typing…';
    const names = typingUserIds.map(
      (uid) => resolveDisplayName(thread.participants.find((p) => p.userId === uid), 'Someone').split(' ')[0],
    );
    if (names.length === 1) return `${names[0]} is typing…`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
    return `${names[0]} and ${names.length - 1} others are typing…`;
  }, [typingUserIds, thread.type, thread.participants]);

  const showTyping = !locked && !chatsAnyShielded && !!typingLabel;

  const showRight = muted || (pinned && !locked);

  return (
    <SwipeableChatRow
      variant={variant}
      pinned={pinned}
      onPin={() => void handleTogglePin()}
      onArchiveToggle={() => void handleArchiveToggle()}
      onLock={() => void handleLock()}
      onUnlock={() => void handleUnlock()}
    >
      {/* Flat mode: a bottom hairline instead of a gap. The chat list renders
          rows through several different parents (list, archived, locked), so
          the separator lives on the row rather than on each list. It is a
          SIBLING element, not a borderBottom: a border covers its whole box, so
          it could only ever be full-bleed, and a full-bleed hairline reads as a
          crack across the screen rather than a separator between rows. */}
      <Animated.View style={pressScaleStyle}>
      <GlassView
        style={[styles.chatItem, theme?.surfaceStyle === 'flat' ? styles.chatItemFlatGap : null]}
        contentStyle={styles.chatItemContent}
      >
        {/* Animated.View wraps List.Item (rather than overlaying it) so the
            highlight paints BEHIND the row's text, and inherits GlassCard's
            clip + radius. */}
        <Animated.View style={pressHighlightStyle}>
        <List.Item
          title={maskChatTitle(getChatTitle(), thread.chatId)}
          description={
            locked
              ? 'Locked chat'
              : showTyping
                ? () => (
                    <Text style={[styles.typingText, { color: theme.colors.primary }]} numberOfLines={1}>
                      {typingLabel}
                    </Text>
                  )
                : maskPreview(lastPreviewFor(), thread.chatId)
          }
          left={() => (
            <View>
              {(() => {
                const avatar = getChatAvatar();
                return avatar.kind === 'group' ? (
                  <GroupAvatar photoURL={avatar.photoURL} name={maskChatTitle(avatar.name, thread.chatId)} size={48} />
                ) : (
                  <UserAvatar photoURL={avatar.photoURL} displayName={maskChatTitle(avatar.name, thread.chatId)} size={48} />
                );
              })()}
              {!locked && !chatsAnyShielded && unreadCount > 0 && (
                <View style={[styles.unreadBadge, { backgroundColor: theme.colors.error, borderColor: theme.colors.background }]}>
                  <Text style={{ color: theme.colors.onError, fontSize: 10, fontWeight: 'bold' }} maxFontSizeMultiplier={FONT_CAP.badge}>
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </Text>
                </View>
              )}
            </View>
          )}
          right={showRight ? () => (
            <View style={styles.rightAccessory}>
              {muted && <IconButton icon="bell-off-outline" size={16} iconColor={theme.colors.onSurfaceVariant} style={styles.accessoryIcon} />}
              {pinned && !locked && <IconButton icon="pin" size={16} iconColor={theme.colors.onSurfaceVariant} style={styles.accessoryIcon} />}
            </View>
          ) : undefined}
          onPress={handleOpen}
          onLongPress={handleLongPress}
          accessibilityRole="button"
          // Unread count and pin/mute state are conveyed VISUALLY by a badge
          // and small icons; without this they are simply absent for a screen
          // reader. Rolled into the name so it is announced up front.
          accessibilityLabel={[
            maskChatTitle(getChatTitle(), thread.chatId),
            locked ? 'Locked chat' : undefined,
            !locked && !chatsAnyShielded && unreadCount > 0
              ? `${unreadCount} unread message${unreadCount === 1 ? '' : 's'}`
              : undefined,
            pinned && !locked ? 'Pinned' : undefined,
            muted ? 'Muted' : undefined,
          ]
            .filter(Boolean)
            .join(', ')}
          accessibilityHint="Opens the conversation"
          // Pin / lock / archive are swipe-only gestures — unreachable with a
          // screen reader until they are exposed as custom actions.
          accessibilityActions={[
            ...(variant === 'active' ? [{ name: 'pin', label: pinned ? 'Unpin chat' : 'Pin chat' }] : []),
            ...(variant === 'active' ? [{ name: 'lock', label: 'Lock chat' }] : []),
            ...(variant === 'locked' ? [{ name: 'unlock', label: 'Unlock chat' }] : []),
            { name: 'archive', label: variant === 'archived' ? 'Restore chat' : 'Archive chat' },
          ]}
          onAccessibilityAction={({ nativeEvent: { actionName } }) => {
            if (actionName === 'pin') void handleTogglePin();
            if (actionName === 'lock') void handleLock();
            if (actionName === 'unlock') void handleUnlock();
            if (actionName === 'archive') void handleArchiveToggle();
          }}
          {...touchableProps}
          style={[styles.chatItemRow, theme?.surfaceStyle === 'flat' && styles.chatItemRowFlat]}
          titleStyle={{ fontWeight: 'bold', fontSize: 16, color: theme.colors.onSurface }}
          descriptionStyle={{ color: theme.colors.onSurfaceVariant }}
          descriptionNumberOfLines={1}
        />
        </Animated.View>
      </GlassView>
      </Animated.View>
      <ListSeparator />
    </SwipeableChatRow>
  );
};

const styles = StyleSheet.create({
  chatItemFlatGap: {
    marginBottom: 0,
  },
  chatItem: {
    // Tightened 12 -> 6 (2026-08-07, compact density pass), matching
    // SwipeableGroupCard. Swipe-action marginBottom must stay equal to the
    // row's own or the action drifts out of alignment with the row.
    marginBottom: 6,
    borderRadius: 16,
    overflow: 'hidden',
  },
  chatItemContent: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  chatItemRow: {
    paddingHorizontal: 16,
    borderRadius: 16,
  },
  /** Full-bleed flat row: the list drops its gutter, so the text inset moves
   *  here. 20 = the 16 list gutter + 4, matching SwipeableGroupCard. */
  chatItemRowFlat: {
    paddingHorizontal: 20,
  },
  unreadBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowAction: {
    justifyContent: 'center',
    // Tightened 12 -> 6 (2026-08-07, compact density pass), matching
    // SwipeableGroupCard. Swipe-action marginBottom must stay equal to the
    // row's own or the action drifts out of alignment with the row.
    marginBottom: 6,
  },
  rowActionLeft: {
    justifyContent: 'center',
    // Tightened 12 -> 6 (2026-08-07, compact density pass), matching
    // SwipeableGroupCard. Swipe-action marginBottom must stay equal to the
    // row's own or the action drifts out of alignment with the row.
    marginBottom: 6,
  },
  rowActionRow: {
    flexDirection: 'row',
    // Tightened 12 -> 6 (2026-08-07, compact density pass), matching
    // SwipeableGroupCard. Swipe-action marginBottom must stay equal to the
    // row's own or the action drifts out of alignment with the row.
    marginBottom: 6,
  },
  rowActionButton: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    width: 84,
    borderRadius: 16,
  },
  rowActionButtonGrouped: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 80,
    borderRadius: 16,
    marginLeft: 6,
  },
  rowActionText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    marginTop: -4,
  },
  typingText: {
    fontStyle: 'italic',
    fontWeight: '600',
    fontSize: 14,
  },
  rightAccessory: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
  },
  accessoryIcon: {
    margin: 0,
  },
});

export default ChatThreadRow;
