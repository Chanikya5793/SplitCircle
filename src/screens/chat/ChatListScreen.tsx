import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { colors } from '@/constants';
import { useChat } from '@/context/ChatContext';
import type { ChatThread } from '@/models';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { Avatar, List, Text } from 'react-native-paper';

interface ChatListScreenProps {
  onOpenThread: (thread: ChatThread) => void;
}

export const ChatListScreen = ({ onOpenThread }: ChatListScreenProps) => {
  const { threads, loading } = useChat();

  return (
    <LiquidBackground>
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
          contentContainerStyle={{ padding: 16 }}
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
});
