import { colors } from '@/constants';
import { useChat } from '@/context/ChatContext';
import type { ChatThread } from '@/models';
import { FlatList, StyleSheet, View } from 'react-native';
import { Button, List, Text } from 'react-native-paper';

interface CallLobbyScreenProps {
  onStartCall: (thread: ChatThread, type: 'audio' | 'video') => void;
}

export const CallLobbyScreen = ({ onStartCall }: CallLobbyScreenProps) => {
  const { threads } = useChat();

  return (
    <View style={styles.container}>
      <FlatList
        data={threads}
        keyExtractor={(item) => item.chatId}
        renderItem={({ item }) => (
          <List.Item
            title={item.participants.map((p) => p.displayName).join(', ')}
            description={item.lastMessage?.content ?? 'Start a call'}
            right={() => (
              <View style={styles.callActions}>
                <Button compact mode="text" onPress={() => onStartCall(item, 'audio')}>
                  Audio
                </Button>
                <Button compact mode="text" onPress={() => onStartCall(item, 'video')}>
                  Video
                </Button>
              </View>
            )}
          />
        )}
        ListEmptyComponent={<Text style={styles.empty}>No chats available for calls.</Text>}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  callActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  empty: {
    marginTop: 32,
    textAlign: 'center',
    color: colors.muted,
  },
});
