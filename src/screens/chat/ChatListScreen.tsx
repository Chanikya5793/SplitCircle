import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { ChatListSkeleton } from '@/components/SkeletonLoader';
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
import { archiveChat, isChatArchived, unarchiveChat } from '@/services/archiveService';
import { useNotificationContext } from '@/context/NotificationContext';
import { heavyHaptic, lightHaptic, successHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { RectButton, Swipeable } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar, List, Text, IconButton, Portal, TouchableRipple } from 'react-native-paper';
import { GroupAvatar, UserAvatar, StickyHeaderPill} from '@/components/ui';
import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { usePrivacyMask } from '@/hooks/usePrivacyMask';
import { ChatFilterSortSheet, ChatSortField, ChatSortOrder } from '@/components/ChatFilterSortSheet';

interface ChatListScreenProps {
  onOpenThread: (thread: ChatThread) => void;
}

/**
 * Swipe-left wrapper for a chat row. Archive on active rows, Restore on
 * archived rows — mirrors the group-list gesture so the whole app speaks the
 * same swipe language.
 */
const SwipeableChatRow = ({
  archived,
  onArchiveToggle,
  children,
}: {
  archived: boolean;
  onArchiveToggle: () => void;
  children: React.ReactNode;
}) => {
  const swipeableRef = useRef<Swipeable>(null);

  const renderRightActions = () => (
    <View style={styles.rowAction}>
      <RectButton
        style={[styles.rowActionButton, { backgroundColor: archived ? '#34C759' : '#FF9500' }]}
        onPress={() => {
          heavyHaptic();
          swipeableRef.current?.close();
          onArchiveToggle();
        }}
      >
        <IconButton icon={archived ? 'archive-arrow-up' : 'archive'} iconColor="#fff" size={22} style={{ margin: 0 }} />
        <Text style={styles.rowActionText}>{archived ? 'Restore' : 'Archive'}</Text>
      </RectButton>
    </View>
  );

  return (
    <Swipeable
      ref={swipeableRef}
      renderRightActions={renderRightActions}
      friction={2}
      rightThreshold={40}
      overshootRight={false}
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
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const scrollY = useRef(new Animated.Value(0)).current;
  const listBottomPadding = getFloatingTabBarContentPadding(insets.bottom, 56);

  // Filter & Sort State
  const [filterVisible, setFilterVisible] = useState(false);
  const [sortField, setSortField] = useState<ChatSortField>('updatedAt');
  const [sortOrder, setSortOrder] = useState<ChatSortOrder>('desc');
  const [showArchived, setShowArchived] = useState(false);
  const { preferences, updatePreference } = useNotificationContext();
  useSyncRootStackTitle(ROOT_SCREEN_TITLES.chats);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: '',
      headerTransparent: true,
    });
  }, [navigation]);

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

  // Helper to get chat initials for avatar
  const getChatInitials = useMemo(() => (thread: ChatThread) => {
    if (thread.type === 'group' && thread.groupId) {
      const group = groups.find(g => g.groupId === thread.groupId);
      return (group?.name || 'GC').slice(0, 2).toUpperCase();
    }
    const otherParticipant = thread.participants.find((p) => p.userId !== user?.userId) ?? thread.participants[0];
    return (otherParticipant?.displayName || 'SC').slice(0, 2).toUpperCase();
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

  // Per-user chat archive with WhatsApp-style auto-unarchive: a thread whose
  // last message is newer than its archivedAt renders as active again.
  const archivedChats = user?.archivedChats;
  const activeThreads = useMemo(
    () => processedThreads.filter(t => !isChatArchived(archivedChats, t)),
    [processedThreads, archivedChats],
  );
  const archivedThreads = useMemo(
    () => processedThreads.filter(t => isChatArchived(archivedChats, t)),
    [processedThreads, archivedChats],
  );

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

  const isChatMuted = (chatId: string) => (preferences.muteChatIds ?? []).includes(chatId);

  const handleToggleMute = (thread: ChatThread) => {
    const current = preferences.muteChatIds ?? [];
    const next = current.includes(thread.chatId)
      ? current.filter(id => id !== thread.chatId)
      : [...current, thread.chatId];
    void updatePreference('muteChatIds', next);
    successHaptic();
  };

  const handleLongPressThread = (thread: ChatThread, archived: boolean) => {
    heavyHaptic();
    const muted = isChatMuted(thread.chatId);
    appAlert(
      maskChatTitle(getChatTitle(thread), thread.chatId),
      undefined,
      [
        {
          text: muted ? 'Unmute notifications' : 'Mute notifications',
          onPress: () => handleToggleMute(thread),
        },
        {
          text: archived ? 'Restore chat' : 'Archive chat',
          onPress: () => void handleArchiveToggle(thread, archived),
        },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  };

  const renderThreadRow = (item: ChatThread, archived: boolean) => (
    <SwipeableChatRow archived={archived} onArchiveToggle={() => void handleArchiveToggle(item, archived)}>
      <GlassView style={styles.chatItem} contentStyle={styles.chatItemContent}>
        <List.Item
          title={maskChatTitle(getChatTitle(item), item.chatId)}
          description={maskPreview(lastPreviewFor(item), item.chatId)}
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
              {!chatsAnyShielded && (localUnreadCounts[item.chatId] ?? 0) > 0 && (
                <View style={[styles.unreadBadge, { backgroundColor: theme.colors.error, borderColor: theme.colors.background }]}>
                  <Text style={{ color: theme.colors.onError, fontSize: 10, fontWeight: 'bold' }}>
                    {(localUnreadCounts[item.chatId] ?? 0) > 9 ? '9+' : localUnreadCounts[item.chatId]}
                  </Text>
                </View>
              )}
            </View>
          )}
          right={isChatMuted(item.chatId) ? () => (
            <IconButton icon="bell-off-outline" size={16} iconColor={theme.colors.onSurfaceVariant} style={styles.mutedIcon} />
          ) : undefined}
          onPress={() => handleOpenThread(item)}
          onLongPress={() => handleLongPressThread(item, archived)}
          style={styles.chatItemRow}
          titleStyle={{ fontWeight: 'bold', fontSize: 16, color: theme.colors.onSurface }}
          descriptionStyle={{ color: theme.colors.onSurfaceVariant }}
          descriptionNumberOfLines={1}
        />
      </GlassView>
    </SwipeableChatRow>
  );

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
          renderItem={({ item }) => renderThreadRow(item, false)}
          ListFooterComponent={
            !vanishAllChats && archivedThreads.length > 0 ? (
              <View style={styles.archivedSection}>
                <TouchableRipple
                  onPress={() => { lightHaptic(); setShowArchived(prev => !prev); }}
                  style={styles.archivedToggle}
                  borderless
                >
                  <View style={styles.archivedToggleRow}>
                    <IconButton icon="archive-outline" size={20} iconColor={theme.colors.onSurfaceVariant} style={{ margin: 0 }} />
                    <Text variant="titleSmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}>
                      Archived ({archivedThreads.length})
                    </Text>
                    <IconButton
                      icon={showArchived ? 'chevron-up' : 'chevron-down'}
                      size={20}
                      iconColor={theme.colors.onSurfaceVariant}
                      style={{ margin: 0 }}
                    />
                  </View>
                </TouchableRipple>
                {showArchived && archivedThreads.map((item) => (
                  <React.Fragment key={item.chatId}>
                    {renderThreadRow(item, true)}
                  </React.Fragment>
                ))}
              </View>
            ) : null
          }
          ListEmptyComponent={
            loading ? (
              <View>
                <ChatListSkeleton />
                <ChatListSkeleton />
                <ChatListSkeleton />
              </View>
            ) : (
              <Text style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>
                {archivedThreads.length > 0 && !vanishAllChats ? 'All your chats are archived.' : 'No chats yet.'}
              </Text>
            )
          }
          contentContainerStyle={{ padding: 16, paddingTop: insets.top + 24, paddingBottom: listBottomPadding }}
          ListHeaderComponent={
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
                  {/* Badge can show if non-default sort is active? Or maybe just sorting doesn't need a badge. 
                      User only had Badge for currency filter count in groups. 
                      Let's stick to simple button for now unless we add filtering logic later. */}
                </View>
              </View>
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
  rowActionButton: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    width: 84,
    borderRadius: 16,
  },
  rowActionText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    marginTop: -4,
  },
  mutedIcon: {
    margin: 0,
    alignSelf: 'center',
  },
  archivedSection: {
    marginTop: 16,
  },
  archivedToggle: {
    borderRadius: 16,
    marginBottom: 12,
  },
  archivedToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
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
