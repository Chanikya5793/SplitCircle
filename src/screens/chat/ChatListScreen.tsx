import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatThread } from '@/models';
import { useNavigation } from '@react-navigation/native';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Animated, RefreshControl, StyleSheet, View } from 'react-native';
import { Avatar, List, Text } from 'react-native-paper';

interface ChatListScreenProps {
  onOpenThread: (thread: ChatThread) => void;
}

export const ChatListScreen = ({ onOpenThread }: ChatListScreenProps) => {
  const navigation = useNavigation();
  const { threads, loading } = useChat();
  const { groups } = useGroups();
  const { theme, isDark } = useTheme();
  const scrollY = useRef(new Animated.Value(0)).current;

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
    return thread.participants.find(p => p.userId !== thread.participantIds[0])?.displayName || 'Direct Chat';
  }, [groups]);

  // Helper to get chat initials for avatar
  const getChatInitials = useMemo(() => (thread: ChatThread) => {
    if (thread.type === 'group' && thread.groupId) {
      const group = groups.find(g => g.groupId === thread.groupId);
      return (group?.name || 'GC').slice(0, 2).toUpperCase();
    }
    const otherParticipant = thread.participants.find(p => p.userId !== thread.participantIds[0]);
    return (otherParticipant?.displayName || 'SC').slice(0, 2).toUpperCase();
  }, [groups]);

  return (
    <LiquidBackground>
      <Animated.View style={[styles.stickyHeader, { opacity: headerOpacity }]}>
        <GlassView style={styles.stickyHeaderGlass}>
          <Text variant="titleMedium" style={[styles.stickyHeaderTitle, { color: theme.colors.onSurface }]}>Chats</Text>
        </GlassView>
      </Animated.View>

      <View style={styles.container}>
        <Animated.FlatList
          data={threads}
          keyExtractor={(item) => item.chatId}
          renderItem={({ item }) => (
            <GlassView style={styles.chatItem}>
              <List.Item
                title={getChatTitle(item)}
                description={item.lastMessage?.content ?? 'No messages yet'}
                left={() => (
                  <Avatar.Text
                    size={48}
                    label={getChatInitials(item)}
                    style={{ backgroundColor: theme.colors.primary }}
                    color={theme.colors.onPrimary}
                  />
                )}
                onPress={() => onOpenThread(item)}
                titleStyle={{ fontWeight: 'bold', fontSize: 16, color: theme.colors.onSurface }}
                descriptionStyle={{ color: theme.colors.onSurfaceVariant }}
                descriptionNumberOfLines={1}
              />
            </GlassView>
          )}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => undefined} />}
          ListEmptyComponent={<Text style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>No chats yet.</Text>}
          contentContainerStyle={{ padding: 16, paddingTop: 60, paddingBottom: 100 }}
          ListHeaderComponent={
            <View style={styles.headerContainer}>
              <Text variant="displaySmall" style={[styles.headerTitle, { color: theme.colors.onSurface }]}>Chats</Text>
            </View>
          }
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: true }
          )}
          scrollEventThrottle={16}
        />
      </View>
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
});
