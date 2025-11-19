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
    <View style={styles.container}>
      <FlatList
        data={threads}
        keyExtractor={(item) => item.chatId}
        renderItem={({ item }) => (
          <List.Item
            title={item.type === 'group' ? item.groupId ?? 'Group chat' : item.participants[1]?.displayName ?? 'Direct chat'}
            description={item.lastMessage?.content ?? 'No messages yet'}
            left={() => (
              <Avatar.Text size={40} label={(item.participants[0]?.displayName ?? 'SC').slice(0, 2).toUpperCase()} />
            )}
            onPress={() => onOpenThread(item)}
          />
        )}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => undefined} />}
        ListEmptyComponent={<Text style={styles.empty}>No chats yet.</Text>}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  empty: {
    textAlign: 'center',
    marginTop: 32,
    color: colors.muted,
  },
});
