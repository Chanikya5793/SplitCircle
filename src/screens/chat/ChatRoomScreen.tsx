import { MessageBubble } from '@/components/MessageBubble';
import { colors } from '@/constants';
import { useChat } from '@/context/ChatContext';
import type { ChatMessage, ChatThread } from '@/models';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { Button, TextInput } from 'react-native-paper';

interface ChatRoomScreenProps {
  thread: ChatThread;
}

export const ChatRoomScreen = ({ thread }: ChatRoomScreenProps) => {
  const { subscribeToMessages, sendMessage } = useChat();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  useEffect(() => {
    const unsubscribe = subscribeToMessages(thread.chatId, (items) => setMessages(items));
    return unsubscribe;
  }, [subscribeToMessages, thread.chatId]);

  useEffect(() => {
    if (messages.length === 0) {
      return;
    }
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [messages.length]);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    setSending(true);
    try {
      await sendMessage({ chatId: thread.chatId, content: trimmed, groupId: thread.groupId });
      setText('');
    } finally {
      setSending(false);
    }
  };

  const placeholder = useMemo(() => (thread.type === 'group' ? 'Message group' : 'Message user'), [thread.type]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={80}
    >
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.messageId}
        renderItem={({ item }) => <MessageBubble message={item} />}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        inverted
      />
      <View style={styles.composer}>
        <TextInput
          mode="outlined"
          placeholder={placeholder}
          value={text}
          onChangeText={setText}
          style={styles.input}
          multiline
        />
        <Button mode="contained" icon="send" onPress={handleSend} disabled={!text.trim() || sending}>
          Send
        </Button>
      </View>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: 16,
    gap: 8,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
    backgroundColor: colors.surface,
  },
  input: {
    flex: 1,
  },
});

export default ChatRoomScreen;
