import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatThread } from '@/models';
import { lightHaptic } from '@/utils/haptics';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { Avatar, Button, List, Text, IconButton, Portal, TouchableRipple } from 'react-native-paper';
import { ChatFilterSortSheet, ChatSortField, ChatSortOrder } from '@/components/ChatFilterSortSheet';

interface CallLobbyScreenProps {
  onStartCall: (thread: ChatThread, type: 'audio' | 'video') => void;
}

export const CallLobbyScreen = ({ onStartCall }: CallLobbyScreenProps) => {
  const navigation = useNavigation();
  const { threads } = useChat();
  const { groups } = useGroups();
  const { theme, isDark } = useTheme();
  const { user } = useAuth();
  const scrollY = useRef(new Animated.Value(0)).current;

  // Filter & Sort State
  const [filterVisible, setFilterVisible] = useState(false);
  const [sortField, setSortField] = useState<ChatSortField>('updatedAt');
  const [sortOrder, setSortOrder] = useState<ChatSortOrder>('desc');

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: '',
      headerTransparent: true,
      headerRight: () => (
        <IconButton
          icon="history"
          onPress={() => {
            lightHaptic();
            (navigation as any).navigate('CallHistory');
          }}
          iconColor={theme.colors.primary}
        />
      ),
    });
  }, [navigation, theme]);

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
    return thread.participants.find(p => p.userId !== thread.participantIds[0])?.displayName || 'Direct Chat';
  }, [groups]);

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

  return (
    <LiquidBackground>
      <Animated.View style={[styles.stickyHeader, { opacity: headerOpacity }]}>
        <GlassView style={styles.stickyHeaderGlass}>
          <Text variant="titleMedium" style={[styles.stickyHeaderTitle, { color: theme.colors.onSurface }]}>Calls</Text>
        </GlassView>
      </Animated.View>

      <View style={styles.container}>
        <Animated.FlatList
          data={processedThreads}
          keyExtractor={(item) => item.chatId}
          contentContainerStyle={[styles.listContent, { paddingTop: 60, paddingBottom: 100 }]}
          ListHeaderComponent={
            <View style={styles.headerContainer}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text variant="displaySmall" style={[styles.headerTitle, { color: theme.colors.onSurface }]}>Calls</Text>

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
                </View>
              </View>
            </View>
          }
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: true }
          )}
          scrollEventThrottle={16}
          renderItem={({ item }) => {
            // Get the other participant (not the current user)
            const firstOtherParticipant = user 
              ? item.participants.find(p => p.userId !== user.userId)
              : item.participants[0];
            return (
              <GlassView style={styles.card}>
                <List.Item
                  title={getChatTitle(item)}
                  description={item.lastMessage?.content ?? 'Start a call'}
                  titleStyle={{ color: theme.colors.onSurface }}
                  descriptionStyle={{ color: theme.colors.onSurfaceVariant }}
                  left={() => (
                    <Avatar.Image
                      size={48}
                      source={
                        firstOtherParticipant?.photoURL
                          ? { uri: firstOtherParticipant.photoURL }
                          : require('../../../assets/icon.png')
                      }
                      style={{ marginVertical: 8 }}
                    />
                  )}
                  right={() => (
                    <View style={styles.callActions}>
                      <IconButton
                        icon="phone"
                        size={24}
                        iconColor={theme.colors.primary}
                        onPress={() => {
                          lightHaptic();
                          onStartCall(item, 'audio');
                        }}
                      />
                      <IconButton
                        icon="video"
                        size={24}
                        iconColor={theme.colors.primary}
                        onPress={() => {
                          lightHaptic();
                          onStartCall(item, 'video');
                        }}
                      />
                    </View>
                  )}
                />
              </GlassView>
            );
          }}
          ListEmptyComponent={<Text style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>No contacts available for calls.</Text>}
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
  listContent: {
    padding: 16,
    gap: 12,
  },
  card: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  callActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  empty: {
    marginTop: 32,
    textAlign: 'center',
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
