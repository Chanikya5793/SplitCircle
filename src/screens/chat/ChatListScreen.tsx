import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { ChatListSkeleton } from '@/components/SkeletonLoader';
import { ArchivedFolderRow } from '@/components/ArchivedFolderRow';
import { getFloatingTabBarContentPadding } from '@/components/tabbar/tabBarMetrics';
import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatMessage, ChatThread } from '@/models';
import { ROOT_SCREEN_TITLES } from '@/navigation/screenTitles';
import { useSyncRootStackTitle } from '@/navigation/useSyncRootStackTitle';
import { appAlert } from '@/utils/appAlert';
import { getChatMessages, subscribeToLocalMessages } from '@/services/localMessageStorage';
import { archiveChat, isChatArchived, pinChat, unarchiveChat, unpinChat } from '@/services/archiveService';
import {
  isLockSessionUnlocked,
  lockChat,
  markLockSessionUnlocked,
  unlockChat,
} from '@/services/chatLockService';
import { authenticate } from '@/services/biometrics';
import { isInChatMap, partitionChats } from '@/utils/chatOrganization';
import { useNotificationContext } from '@/context/NotificationContext';
import { heavyHaptic, lightHaptic, successHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, Platform, StyleSheet, View } from 'react-native';
import { RectButton, Swipeable } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { List, Text, IconButton, Portal, TouchableRipple } from 'react-native-paper';
import { GroupAvatar, UserAvatar, StickyHeaderPill} from '@/components/ui';
import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { usePrivacyMask } from '@/hooks/usePrivacyMask';
import { ChatFilterSortSheet, ChatSortField, ChatSortOrder } from '@/components/ChatFilterSortSheet';

interface ChatListScreenProps {
  onOpenThread: (thread: ChatThread) => void;
}

type RowVariant = 'active' | 'archived' | 'locked';

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
  variant: RowVariant;
  pinned?: boolean;
  onPin?: () => void;
  onArchiveToggle?: () => void;
  onLock?: () => void;
  onUnlock?: () => void;
  children: React.ReactNode;
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
      onSwipeableWillOpen={lightHaptic}
    >
      {children}
    </Swipeable>
  );
};

export const ChatListScreen = ({ onOpenThread }: ChatListScreenProps) => {
  const navigation = useNavigation();
  const { threads, loading } = useChat();
  const { user } = useAuth();
  const { groups } = useGroups();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const scrollY = useRef(new Animated.Value(0)).current;
  const listBottomPadding = getFloatingTabBarContentPadding(insets.bottom, 56);

  // Filter & Sort State
  const [filterVisible, setFilterVisible] = useState(false);
  const [sortField, setSortField] = useState<ChatSortField>('updatedAt');
  const [sortOrder, setSortOrder] = useState<ChatSortOrder>('desc');
  const [showArchived, setShowArchived] = useState(false);
  // Locked folder: a successful biometric unlock reveals it for this session
  // only (re-armed when the app backgrounds). Seeded from the shared module
  // session so an unlock performed elsewhere (e.g. the in-room gate) carries.
  const [lockedUnlocked, setLockedUnlocked] = useState(isLockSessionUnlocked());
  const [lockedExpanded, setLockedExpanded] = useState(false);
  const { preferences, updatePreference } = useNotificationContext();
  useSyncRootStackTitle(ROOT_SCREEN_TITLES.chats);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: '',
      headerTransparent: true,
    });
  }, [navigation]);

  // Re-arm the locked folder whenever the app goes to the background so a
  // borrowed/unlocked phone can't reveal locked chats after a real switch away.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        // chatLockService's own module-scope listener clears the shared
        // session; this listener only resets the folder's local UI state.
        setLockedUnlocked(false);
        setLockedExpanded(false);
      }
    });
    return () => sub.remove();
  }, []);

  // Slide the glass pill in with a TRANSFORM (not opacity): fractional alpha
  // on an ancestor kills UIVisualEffectView materials (see StickyHeaderPill).
  const headerTranslate = scrollY.interpolate({
    inputRange: [0, 60],
    outputRange: [-160, 0],
    extrapolate: 'clamp',
  });

  // Helper to get chat display name
  const getChatTitle = useMemo(() => (thread: ChatThread) => {
    if (thread.type === 'group' && thread.groupId) {
      const group = groups.find(g => g.groupId === thread.groupId);
      return group?.name || 'Group Chat';
    }
    const otherParticipant = thread.participants.find((p) => p.userId !== user?.userId) ?? thread.participants[0];
    return otherParticipant?.displayName || 'Direct Chat';
  }, [groups, user?.userId]);

  // Photo + kind for the row avatar: group photo for group threads, the other
  // participant's profile photo for DMs; initials render as the fallback.
  const { isShielded, action, settings: guardSettings } = usePrivacyGuard();
  const { maskChatTitle, maskPreview } = usePrivacyMask();
  // Full-list vanish only when the user chose "vanish" AND every chat is in
  // scope; otherwise render the list and disguise rows per-scope below.
  const vanishAllChats =
    action === 'vanish' && isShielded('chats') && guardSettings.chatScope.mode === 'all';
  const chatsAnyShielded = isShielded('chats');

  const getChatAvatar = useMemo(() => (thread: ChatThread): { kind: 'group' | 'user'; photoURL?: string; name: string } => {
    if (thread.type === 'group' && thread.groupId) {
      const group = groups.find(g => g.groupId === thread.groupId);
      return { kind: 'group', photoURL: group?.photoURL, name: group?.name || 'Group Chat' };
    }
    const otherParticipant = thread.participants.find((p) => p.userId !== user?.userId) ?? thread.participants[0];
    return { kind: 'user', photoURL: otherParticipant?.photoURL, name: otherParticipant?.displayName || 'Direct Chat' };
  }, [groups, user?.userId]);

  // Per-chat *visible* last message — derived from local storage so a deleted
  // or edited message is reflected immediately. The Firestore-side
  // `thread.lastMessage` is only used as a fallback when local storage hasn't
  // hydrated yet.
  const [localLastMessages, setLocalLastMessages] = useState<Record<string, ChatMessage | null>>({});
  const [localUnreadCounts, setLocalUnreadCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!user) return;
    const unsubs: Array<() => void> = [];

    const recompute = async (chatId: string) => {
      const msgs = await getChatMessages(chatId);
      const sorted = [...msgs].sort((a, b) => b.createdAt - a.createdAt);

      // Walk newest-first; first item not deleted-for-me and not deleted-for-everyone wins.
      const visible = sorted.find(
        (m) =>
          !m.deletedForEveryone &&
          !(m.deletedFor ?? []).includes(user.userId),
      ) ?? null;
      setLocalLastMessages((prev) => {
        const prevId = prev[chatId]?.messageId ?? prev[chatId]?.id ?? null;
        const nextId = visible?.messageId ?? visible?.id ?? null;
        const sameContent = (prev[chatId]?.content ?? '') === (visible?.content ?? '');
        if (prevId === nextId && sameContent) return prev;
        return { ...prev, [chatId]: visible };
      });

      // Derive unread count from local messages
      const unread = msgs.filter(
        (m) =>
          m.senderId !== user.userId &&
          !m.deletedForEveryone &&
          !(m.deletedFor ?? []).includes(user.userId) &&
          (!m.readBy || !m.readBy.includes(user.userId)),
      ).length;
      setLocalUnreadCounts((prev) => {
        if (prev[chatId] === unread) return prev;
        return { ...prev, [chatId]: unread };
      });
    };

    for (const t of threads) {
      void recompute(t.chatId);
      unsubs.push(subscribeToLocalMessages(t.chatId, () => void recompute(t.chatId)));
    }
    return () => {
      for (const u of unsubs) u();
    };
  }, [threads, user]);

  const lastPreviewFor = (thread: ChatThread): string => {
    const msg = localLastMessages[thread.chatId] ?? thread.lastMessage ?? null;
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

  // Sort Logic
  const processedThreads = useMemo(() => {
    let result = [...threads];

    result.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'name':
          const nameA = getChatTitle(a);
          const nameB = getChatTitle(b);
          comparison = nameA.localeCompare(nameB);
          break;
        case 'unread':
          comparison = (localUnreadCounts[a.chatId] ?? 0) - (localUnreadCounts[b.chatId] ?? 0);
          break;
        case 'updatedAt':
          // Use updatedAt or lastMessage.timestamp or fall back to 0
          const timeA = a.updatedAt || (a.lastMessage?.timestamp ? new Date(a.lastMessage.timestamp).getTime() : 0);
          const timeB = b.updatedAt || (b.lastMessage?.timestamp ? new Date(b.lastMessage.timestamp).getTime() : 0);
          comparison = timeA - timeB;
          break;
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [threads, sortField, sortOrder, getChatTitle, localUnreadCounts]);

  // Per-user organization: locked chats hide entirely behind a biometric
  // folder (locked wins), archived collapse into a folder, pinned float atop
  // the active list. Archive uses WhatsApp-style auto-unarchive.
  const archivedChats = user?.archivedChats;
  const pinnedChats = user?.pinnedChats;
  const lockedChats = user?.lockedChats;
  const buckets = useMemo(
    () =>
      partitionChats(processedThreads, {
        getId: (t) => t.chatId,
        isArchived: (t) => isChatArchived(archivedChats, t),
        pinnedChats,
        lockedChats,
      }),
    [processedThreads, archivedChats, pinnedChats, lockedChats],
  );
  const pinnedThreads = buckets.pinned;
  const activeThreads = buckets.active;
  const archivedThreads = buckets.archived;
  const lockedThreads = buckets.locked;

  const handleOpenThread = (thread: ChatThread) => {
    lightHaptic();
    // Lazy cleanup: if this chat auto-unarchived (new message arrived after
    // archiving), drop the stale map entry now that the user is opening it.
    if (user && archivedChats?.[thread.chatId] && !isChatArchived(archivedChats, thread)) {
      void unarchiveChat(user.userId, thread.chatId).catch(() => { /* cosmetic cleanup; safe to ignore */ });
    }
    onOpenThread(thread);
  };

  const handleArchiveToggle = async (thread: ChatThread, archived: boolean) => {
    if (!user) return;
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

  const handleTogglePin = async (thread: ChatThread, pinned: boolean) => {
    if (!user) return;
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

  const handleLock = async (thread: ChatThread) => {
    if (!user) return;
    try {
      await lockChat(user.userId, thread.chatId);
      successHaptic();
    } catch (error) {
      console.error('Failed to lock chat', error);
      appAlert('Error', 'Failed to lock chat. Please try again.');
    }
  };

  const handleUnlock = async (thread: ChatThread) => {
    if (!user) return;
    try {
      await unlockChat(user.userId, thread.chatId);
      successHaptic();
    } catch (error) {
      console.error('Failed to unlock chat', error);
      appAlert('Error', 'Failed to unlock chat. Please try again.');
    }
  };

  // Opening the Locked folder requires biometrics (device fallback allowed).
  // On web there is no secure unlock — surface a notice instead.
  const handleOpenLockedFolder = async () => {
    lightHaptic();
    if (Platform.OS === 'web') {
      appAlert('Locked chats', 'Locked chats can be opened on your phone.');
      return;
    }
    if (lockedUnlocked) {
      setLockedExpanded((prev) => !prev);
      return;
    }
    const ok = await authenticate('Unlock your locked chats', true);
    if (ok) {
      markLockSessionUnlocked();
      setLockedUnlocked(true);
      setLockedExpanded(true);
    }
  };

  const isChatMuted = (chatId: string) => (preferences.muteChatIds ?? []).includes(chatId);

  const handleToggleMute = (thread: ChatThread) => {
    const current = preferences.muteChatIds ?? [];
    const next = current.includes(thread.chatId)
      ? current.filter(id => id !== thread.chatId)
      : [...current, thread.chatId];
    void updatePreference('muteChatIds', next);
    successHaptic();
  };

  const handleLongPressThread = (thread: ChatThread, variant: RowVariant) => {
    heavyHaptic();
    if (variant === 'locked') {
      appAlert(maskChatTitle(getChatTitle(thread), thread.chatId), undefined, [
        { text: 'Unlock chat', onPress: () => void handleUnlock(thread) },
        { text: 'Cancel', style: 'cancel' },
      ]);
      return;
    }
    const muted = isChatMuted(thread.chatId);
    const pinned = isInChatMap(pinnedChats, thread.chatId);
    const options: Array<{ text: string; onPress?: () => void; style?: 'cancel' | 'destructive' }> = [
      {
        text: muted ? 'Unmute notifications' : 'Mute notifications',
        onPress: () => handleToggleMute(thread),
      },
    ];
    if (variant === 'active') {
      options.push({
        text: pinned ? 'Unpin chat' : 'Pin chat',
        onPress: () => void handleTogglePin(thread, pinned),
      });
      options.push({ text: 'Lock chat', onPress: () => void handleLock(thread) });
    }
    options.push({
      text: variant === 'archived' ? 'Restore chat' : 'Archive chat',
      onPress: () => void handleArchiveToggle(thread, variant === 'archived'),
    });
    options.push({ text: 'Cancel', style: 'cancel' });
    appAlert(maskChatTitle(getChatTitle(thread), thread.chatId), undefined, options);
  };

  const renderThreadRow = (item: ChatThread, variant: RowVariant) => {
    const pinned = isInChatMap(pinnedChats, item.chatId);
    const locked = variant === 'locked';
    const muted = isChatMuted(item.chatId);
    const showRight = muted || (pinned && !locked);
    return (
      <SwipeableChatRow
        variant={variant}
        pinned={pinned}
        onPin={() => void handleTogglePin(item, pinned)}
        onArchiveToggle={() => void handleArchiveToggle(item, variant === 'archived')}
        onLock={() => void handleLock(item)}
        onUnlock={() => void handleUnlock(item)}
      >
        <GlassView style={styles.chatItem} contentStyle={styles.chatItemContent}>
          <List.Item
            title={maskChatTitle(getChatTitle(item), item.chatId)}
            description={locked ? 'Locked chat' : maskPreview(lastPreviewFor(item), item.chatId)}
            left={() => (
              <View>
                {(() => {
                  const avatar = getChatAvatar(item);
                  return avatar.kind === 'group' ? (
                    <GroupAvatar photoURL={avatar.photoURL} name={maskChatTitle(avatar.name, item.chatId)} size={48} />
                  ) : (
                    <UserAvatar photoURL={avatar.photoURL} displayName={maskChatTitle(avatar.name, item.chatId)} size={48} />
                  );
                })()}
                {!locked && !chatsAnyShielded && (localUnreadCounts[item.chatId] ?? 0) > 0 && (
                  <View style={[styles.unreadBadge, { backgroundColor: theme.colors.error, borderColor: theme.colors.background }]}>
                    <Text style={{ color: theme.colors.onError, fontSize: 10, fontWeight: 'bold' }}>
                      {(localUnreadCounts[item.chatId] ?? 0) > 9 ? '9+' : localUnreadCounts[item.chatId]}
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
            onPress={() => handleOpenThread(item)}
            onLongPress={() => handleLongPressThread(item, variant)}
            style={styles.chatItemRow}
            titleStyle={{ fontWeight: 'bold', fontSize: 16, color: theme.colors.onSurface }}
            descriptionStyle={{ color: theme.colors.onSurfaceVariant }}
            descriptionNumberOfLines={1}
          />
        </GlassView>
      </SwipeableChatRow>
    );
  };

  const otherBucketCount = pinnedThreads.length + archivedThreads.length + lockedThreads.length;

  return (
    <LiquidBackground>
      <Animated.View
        style={[
          styles.stickyHeader,
          { transform: [{ translateY: headerTranslate }], paddingTop: insets.top + 8 },
        ]}
      >
        <StickyHeaderPill style={styles.stickyHeaderGlass}>
          <Text variant="titleMedium" style={[styles.stickyHeaderTitle, { color: theme.colors.onSurface }]}>Chats</Text>
        </StickyHeaderPill>
      </Animated.View>

      <View style={styles.container}>
        <Animated.FlatList
          data={vanishAllChats ? [] : activeThreads}
          keyExtractor={(item) => item.chatId}
          renderItem={({ item }) => renderThreadRow(item, 'active')}
          ListEmptyComponent={
            loading ? (
              <View>
                <ChatListSkeleton />
                <ChatListSkeleton />
                <ChatListSkeleton />
              </View>
            ) : vanishAllChats || otherBucketCount > 0 ? null : (
              <Text style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>
                No chats yet.
              </Text>
            )
          }
          contentContainerStyle={{ padding: 16, paddingTop: insets.top + 24, paddingBottom: listBottomPadding }}
          ListHeaderComponent={
            <View>
              <View style={styles.headerContainer}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text variant="displaySmall" style={[styles.headerTitle, { color: theme.colors.onSurface }]}>Chats</Text>

                  <View>
                    <TouchableRipple
                      onPress={() => { lightHaptic(); setFilterVisible(true); }}
                      style={[styles.filterButton, { backgroundColor: theme.colors.skeleton }]}
                      borderless
                    >
                      <View style={styles.filterButtonContent}>
                        <IconButton icon="filter-variant" size={24} iconColor={theme.colors.onSurface} style={{ margin: 0 }} />
                      </View>
                    </TouchableRipple>
                  </View>
                </View>
              </View>

              {!vanishAllChats && (
                <>
                  {archivedThreads.length > 0 && (
                    <View style={styles.folderSection}>
                      <ArchivedFolderRow
                        icon="archive-outline"
                        label="Archived"
                        count={archivedThreads.length}
                        expanded={showArchived}
                        onPress={() => { lightHaptic(); setShowArchived((prev) => !prev); }}
                      />
                      {showArchived && archivedThreads.map((item) => (
                        <React.Fragment key={item.chatId}>{renderThreadRow(item, 'archived')}</React.Fragment>
                      ))}
                    </View>
                  )}

                  {lockedThreads.length > 0 && (
                    <View style={styles.folderSection}>
                      <ArchivedFolderRow
                        icon="lock-outline"
                        label="Locked"
                        count={lockedThreads.length}
                        expanded={lockedExpanded}
                        locked
                        tint={theme.colors.primary}
                        onPress={() => void handleOpenLockedFolder()}
                      />
                      {lockedUnlocked && lockedExpanded && lockedThreads.map((item) => (
                        <React.Fragment key={item.chatId}>{renderThreadRow(item, 'locked')}</React.Fragment>
                      ))}
                    </View>
                  )}

                  {pinnedThreads.length > 0 && (
                    <View style={styles.pinnedSection}>
                      <Text variant="labelMedium" style={[styles.pinnedLabel, { color: theme.colors.onSurfaceVariant }]}>
                        Pinned
                      </Text>
                      {pinnedThreads.map((item) => (
                        <React.Fragment key={item.chatId}>{renderThreadRow(item, 'active')}</React.Fragment>
                      ))}
                    </View>
                  )}
                </>
              )}
            </View>
          }
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: true }
          )}
          scrollEventThrottle={16}
        />
      </View>

      <Portal>
        <ChatFilterSortSheet
          visible={filterVisible}
          onClose={() => setFilterVisible(false)}
          sortField={sortField}
          sortOrder={sortOrder}
          onSortFieldChange={setSortField}
          onSortOrderChange={setSortOrder}
        />
      </Portal>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  chatItem: {
    marginBottom: 12,
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
  empty: {
    textAlign: 'center',
    marginTop: 32,
  },
  rowAction: {
    justifyContent: 'center',
    marginBottom: 12,
  },
  rowActionLeft: {
    justifyContent: 'center',
    marginBottom: 12,
  },
  rowActionRow: {
    flexDirection: 'row',
    marginBottom: 12,
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
  rightAccessory: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
  },
  accessoryIcon: {
    margin: 0,
  },
  folderSection: {
    marginTop: 4,
  },
  pinnedSection: {
    marginTop: 4,
  },
  pinnedLabel: {
    marginLeft: 8,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  stickyHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    paddingHorizontal: 16,
    paddingBottom: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stickyHeaderGlass: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 20,
  },
  stickyHeaderTitle: {
    fontWeight: 'bold',
  },
  headerContainer: {
    paddingHorizontal: 8,
    paddingBottom: 16,
  },
  headerTitle: {
    fontWeight: 'bold',
  },
  filterButton: {
    borderRadius: 50,
    width: 44,
    height: 44,
    overflow: 'hidden',
  },
  filterButtonContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
