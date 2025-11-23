import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { MessageBubble } from '@/components/MessageBubble';
import { useChat } from '@/context/ChatContext';
import type { ChatMessage, ChatThread } from '@/models';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
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
    <LiquidBackground>
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
        <GlassView style={styles.composer}>
          <TextInput
            mode="outlined"
            placeholder={placeholder}
            value={text}
            onChangeText={setText}
            style={styles.input}
            multiline
            outlineColor="rgba(0,0,0,0.1)"
            theme={{ colors: { background: 'rgba(255,255,255,0.5)' } }}
          />
          <Button mode="contained" icon="send" onPress={handleSend} disabled={!text.trim() || sending}>
            Send
          </Button>
        </GlassView>
      </KeyboardAvoidingView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
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
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    marginHorizontal: 0,
    marginBottom: 0,
  },
  input: {
    flex: 1,
  },
});

export default ChatRoomScreen;
