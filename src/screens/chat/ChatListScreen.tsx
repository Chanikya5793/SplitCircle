import { LiquidBackground } from '@/components/LiquidBackground';
import { ChatListSkeleton } from '@/components/SkeletonLoader';
import { ChatThreadRow } from '@/components/ChatThreadRow';
import { ArchivedFolderRow } from '@/components/ArchivedFolderRow';
import { getFloatingTabBarContentPadding } from '@/components/tabbar/tabBarMetrics';
import { ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatThread } from '@/models';
import { ROOT_SCREEN_TITLES } from '@/navigation/screenTitles';
import { useSyncRootStackTitle } from '@/navigation/useSyncRootStackTitle';
import { appAlert } from '@/utils/appAlert';
import { getChatMessages, subscribeToLocalMessages } from '@/services/localMessageStorage';
import { isChatArchived } from '@/services/archiveService';
import { isLockSessionUnlocked, markLockSessionUnlocked } from '@/services/chatLockService';
import { authenticate } from '@/services/biometrics';
import { partitionChats } from '@/utils/chatOrganization';
import { useChatListTyping } from '@/hooks/useChatListTyping';
import { lightHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text, IconButton, Portal, TouchableRipple } from 'react-native-paper';
import { StickyHeaderPill } from '@/components/ui';
import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { ChatFilterSortSheet, ChatSortField, ChatSortOrder } from '@/components/ChatFilterSortSheet';

interface ChatListScreenProps {
  onOpenThread: (thread: ChatThread) => void;
}

export const ChatListScreen = ({ onOpenThread }: ChatListScreenProps) => {
  const navigation = useNavigation<any>();
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

  // Helper to get chat display name (used by the name sort).
  const getChatTitle = useMemo(() => (thread: ChatThread) => {
    if (thread.type === 'group' && thread.groupId) {
      const group = groups.find(g => g.groupId === thread.groupId);
      return group?.name || 'Group Chat';
    }
    const otherParticipant = thread.participants.find((p) => p.userId !== user?.userId) ?? thread.participants[0];
    return otherParticipant?.displayName || 'Direct Chat';
  }, [groups, user?.userId]);

  const { isShielded, isVanished, action, settings: guardSettings } = usePrivacyGuard();
  // Full-list vanish only when the user chose "vanish" AND every chat is in
  // scope; otherwise render the list and let each row disguise itself per-scope.
  const vanishAllChats =
    action === 'vanish' && isShielded('chats') && guardSettings.chatScope.mode === 'all';

  // Per-chat unread counts — derived from local storage so the "unread" sort
  // reflects the same locally-visible state the rows render. (Each row also
  // computes its own preview/badge via ChatThreadRow; this map exists only for
  // the list-level sort.)
  const [localUnreadCounts, setLocalUnreadCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!user) return;
    const unsubs: Array<() => void> = [];

    const recompute = async (chatId: string) => {
      const msgs = await getChatMessages(chatId);
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

  // Sort Logic
  const processedThreads = useMemo(() => {
    // Scoped-sensitive chats VANISH while shielded — no masked placeholder
    // row advertising that something is hidden (and none at all in duress).
    let result = threads.filter((t) => !isVanished('chats', t.chatId));

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
  }, [threads, sortField, sortOrder, getChatTitle, localUnreadCounts, isVanished]);

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

  // Live "typing…" for the visible (pinned + active) rows. The hook caps and
  // detaches its RTDB listeners; archived/locked stay out of scope by design.
  const visibleChatIds = useMemo(
    () => [...pinnedThreads, ...activeThreads].map((t) => t.chatId),
    [pinnedThreads, activeThreads],
  );
  const typingByChat = useChatListTyping(visibleChatIds, user?.userId);

  // Opening the Locked folder requires biometrics (device fallback allowed) and
  // then NAVIGATES to the dedicated LockedChatsScreen instead of expanding
  // inline. On web there is no secure unlock — surface a notice instead.
  const handleOpenLockedFolder = async () => {
    lightHaptic();
    if (Platform.OS === 'web') {
      appAlert('Locked chats', 'Locked chats can be opened on your phone.');
      return;
    }
    if (isLockSessionUnlocked()) {
      navigation.navigate(ROUTES.APP.LOCKED_CHATS);
      return;
    }
    const ok = await authenticate('Unlock your locked chats', true);
    if (ok) {
      markLockSessionUnlocked();
      navigation.navigate(ROUTES.APP.LOCKED_CHATS);
    }
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
          renderItem={({ item }) => (
            <ChatThreadRow thread={item} variant="active" onOpenThread={onOpenThread} typingUserIds={typingByChat[item.chatId]} />
          )}
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
                  {/* Folder rows NAVIGATE to dedicated screens (WhatsApp-style)
                      so archived/locked threads never mingle with the active
                      list. Counts come from the same partition buckets. */}
                  {archivedThreads.length > 0 && (
                    <View style={styles.folderSection}>
                      <ArchivedFolderRow
                        icon="archive-outline"
                        label="Archived"
                        count={archivedThreads.length}
                        expanded={false}
                        locked
                        onPress={() => { lightHaptic(); navigation.navigate(ROUTES.APP.ARCHIVED_CHATS); }}
                      />
                    </View>
                  )}

                  {lockedThreads.length > 0 && (
                    <View style={styles.folderSection}>
                      <ArchivedFolderRow
                        icon="lock-outline"
                        label="Locked"
                        count={lockedThreads.length}
                        expanded={false}
                        locked
                        tint={theme.colors.primary}
                        onPress={() => void handleOpenLockedFolder()}
                      />
                    </View>
                  )}

                  {pinnedThreads.length > 0 && (
                    <View style={styles.pinnedSection}>
                      <Text variant="labelMedium" style={[styles.pinnedLabel, { color: theme.colors.onSurfaceVariant }]}>
                        Pinned
                      </Text>
                      {pinnedThreads.map((item) => (
                        <ChatThreadRow key={item.chatId} thread={item} variant="active" onOpenThread={onOpenThread} typingUserIds={typingByChat[item.chatId]} />
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
  empty: {
    textAlign: 'center',
    marginTop: 32,
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
