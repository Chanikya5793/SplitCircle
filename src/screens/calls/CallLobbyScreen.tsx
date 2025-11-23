import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
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
    <LiquidBackground>
      <View style={styles.container}>
        <FlatList
          data={threads}
          keyExtractor={(item) => item.chatId}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <GlassView style={styles.card}>
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
            </GlassView>
          )}
          ListEmptyComponent={<Text style={styles.empty}>No chats available for calls.</Text>}
        />
      </View>
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
    color: colors.muted,
  },
});
