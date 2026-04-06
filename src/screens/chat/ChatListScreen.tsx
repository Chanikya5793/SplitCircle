import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { ChatListSkeleton } from '@/components/SkeletonLoader';
import { getFloatingTabBarContentPadding } from '@/components/tabbar/tabBarMetrics';
import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatThread } from '@/models';
import { ROOT_SCREEN_TITLES } from '@/navigation/screenTitles';
import { useSyncRootStackTitle } from '@/navigation/useSyncRootStackTitle';
import { lightHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, RefreshControl, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar, List, Text, IconButton, Portal, TouchableRipple } from 'react-native-paper';
import { ChatFilterSortSheet, ChatSortField, ChatSortOrder } from '@/components/ChatFilterSortSheet';

interface ChatListScreenProps {
  onOpenThread: (thread: ChatThread) => void;
}

export const ChatListScreen = ({ onOpenThread }: ChatListScreenProps) => {
  const navigation = useNavigation();
  const { threads, loading } = useChat();
  const { user } = useAuth();
  const { groups } = useGroups();
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const scrollY = useRef(new Animated.Value(0)).current;
  const listBottomPadding = getFloatingTabBarContentPadding(insets.bottom, 20);

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

  const headerOpacity = scrollY.interpolate({
    inputRange: [0, 40],
    outputRange: [0, 1],
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

  // Helper to get chat initials for avatar
  const getChatInitials = useMemo(() => (thread: ChatThread) => {
    if (thread.type === 'group' && thread.groupId) {
      const group = groups.find(g => g.groupId === thread.groupId);
      return (group?.name || 'GC').slice(0, 2).toUpperCase();
    }
    const otherParticipant = thread.participants.find((p) => p.userId !== user?.userId) ?? thread.participants[0];
    return (otherParticipant?.displayName || 'SC').slice(0, 2).toUpperCase();
  }, [groups, user?.userId]);

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
          comparison = a.unreadCount - b.unreadCount;
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
  }, [threads, sortField, sortOrder, getChatTitle]);

  const handleOpenThread = (thread: ChatThread) => {
    lightHaptic();
    onOpenThread(thread);
  };

  return (
    <LiquidBackground>
      <Animated.View style={[styles.stickyHeader, { opacity: headerOpacity }]}>
        <GlassView style={styles.stickyHeaderGlass}>
          <Text variant="titleMedium" style={[styles.stickyHeaderTitle, { color: theme.colors.onSurface }]}>Chats</Text>
        </GlassView>
      </Animated.View>

      <View style={styles.container}>
        <Animated.FlatList
          data={processedThreads}
          keyExtractor={(item) => item.chatId}
          renderItem={({ item }) => (
            <GlassView style={styles.chatItem}>
              <List.Item
                title={getChatTitle(item)}
                description={item.lastMessage?.content ?? 'No messages yet'}
                left={() => (
                  <View>
                    <Avatar.Text
                      size={48}
                      label={getChatInitials(item)}
                      style={{ backgroundColor: theme.colors.primary }}
                      color={theme.colors.onPrimary}
                    />
                    {item.unreadCount > 0 && (
                      <View style={[styles.unreadBadge, { backgroundColor: theme.colors.error, borderColor: theme.colors.background }]}>
                        <Text style={{ color: theme.colors.onError, fontSize: 10, fontWeight: 'bold' }}>
                          {item.unreadCount > 9 ? '9+' : item.unreadCount}
                        </Text>
                      </View>
                    )}
                  </View>
                )}
                onPress={() => handleOpenThread(item)}
                titleStyle={{ fontWeight: 'bold', fontSize: 16, color: theme.colors.onSurface }}
                descriptionStyle={{ color: theme.colors.onSurfaceVariant }}
                descriptionNumberOfLines={1}
              />
            </GlassView>
          )}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => undefined} />}
          ListEmptyComponent={
            loading ? (
              <View>
                <ChatListSkeleton />
                <ChatListSkeleton />
                <ChatListSkeleton />
              </View>
            ) : (
              <Text style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>No chats yet.</Text>
            )
          }
          contentContainerStyle={{ padding: 16, paddingTop: 60, paddingBottom: listBottomPadding }}
          ListHeaderComponent={
            <View style={styles.headerContainer}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text variant="displaySmall" style={[styles.headerTitle, { color: theme.colors.onSurface }]}>Chats</Text>

                <View>
                  <TouchableRipple
                    onPress={() => { lightHaptic(); setFilterVisible(true); }}
                    style={[styles.filterButton, { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)' }]}
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
  stickyHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    paddingTop: 50,
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
