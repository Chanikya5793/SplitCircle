import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { colors } from '@/constants';
import { useChat } from '@/context/ChatContext';
import type { ChatThread } from '@/models';
import { useNavigation } from '@react-navigation/native';
import { useLayoutEffect, useRef } from 'react';
import { Animated, FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { Avatar, List, Text } from 'react-native-paper';

interface ChatListScreenProps {
  onOpenThread: (thread: ChatThread) => void;
}

export const ChatListScreen = ({ onOpenThread }: ChatListScreenProps) => {
  const navigation = useNavigation();
  const { threads, loading } = useChat();
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

  return (
    <LiquidBackground>
      <Animated.View style={[styles.stickyHeader, { opacity: headerOpacity }]}>
        <GlassView style={styles.stickyHeaderGlass}>
          <Text variant="titleMedium" style={styles.stickyHeaderTitle}>Chats</Text>
        </GlassView>
      </Animated.View>

      <View style={styles.container}>
        <FlatList
          data={threads}
          keyExtractor={(item) => item.chatId}
          renderItem={({ item }) => (
            <GlassView style={styles.chatItem}>
              <List.Item
                title={item.type === 'group' ? item.groupId ?? 'Group chat' : item.participants[1]?.displayName ?? 'Direct chat'}
                description={item.lastMessage?.content ?? 'No messages yet'}
                left={() => (
                  <Avatar.Text size={40} label={(item.participants[0]?.displayName ?? 'SC').slice(0, 2).toUpperCase()} style={{ backgroundColor: 'rgba(103, 80, 164, 0.1)' }} color="#6750A4" />
                )}
                onPress={() => onOpenThread(item)}
                titleStyle={{ fontWeight: 'bold' }}
              />
            </GlassView>
          )}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => undefined} />}
          ListEmptyComponent={<Text style={styles.empty}>No chats yet.</Text>}
          contentContainerStyle={{ padding: 16, paddingTop: 60, paddingBottom: 100 }}
          ListHeaderComponent={
            <View style={styles.headerContainer}>
              <Text variant="displaySmall" style={styles.headerTitle}>Chats</Text>
            </View>
          }
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: false }
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
    color: colors.muted,
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
    backgroundColor: 'rgba(255, 255, 255, 0.8)',
  },
  stickyHeaderTitle: {
    fontWeight: 'bold',
    color: '#333',
  },
  headerContainer: {
    paddingHorizontal: 8,
    paddingBottom: 16,
  },
  headerTitle: {
    fontWeight: 'bold',
    color: '#333',
  },
});
