import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { MessageBubble } from '@/components/MessageBubble';
import { colors } from '@/constants';
import { useChat } from '@/context/ChatContext';
import type { ChatMessage, ChatThread } from '@/models';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { Button, Text, TextInput } from 'react-native-paper';

interface ChatRoomScreenProps {
  thread: ChatThread;
}

export const ChatRoomScreen = ({ thread }: ChatRoomScreenProps) => {
  const navigation = useNavigation();
  const { subscribeToMessages, sendMessage } = useChat();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const scrollY = useRef(new Animated.Value(0)).current;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: '',
      headerTransparent: true,
      headerTintColor: colors.primary,
    });
  }, [navigation]);

  const headerOpacity = scrollY.interpolate({
    inputRange: [0, 40],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

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
  const title = thread.type === 'group' ? thread.groupId ?? 'Group chat' : thread.participants[1]?.displayName ?? 'Direct chat';

  return (
    <LiquidBackground>
      <Animated.View style={[styles.stickyHeader, { opacity: headerOpacity }]}>
        <GlassView style={styles.stickyHeaderGlass}>
          <Text variant="titleMedium" style={styles.stickyHeaderTitle} numberOfLines={1}>
            {title}
          </Text>
        </GlassView>
      </Animated.View>

      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={80}
      >
        <View style={styles.headerContainer}>
          <Text variant="headlineMedium" style={styles.headerTitle}>{title}</Text>
        </View>

        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.messageId}
          renderItem={({ item }) => <MessageBubble message={item} />}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          inverted
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: false }
          )}
          scrollEventThrottle={16}
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
    paddingTop: 60, // Space for header
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: 16,
    gap: 8,
    paddingBottom: 20,
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
    maxWidth: '80%',
  },
  stickyHeaderTitle: {
    fontWeight: 'bold',
    color: '#333',
  },
  headerContainer: {
    paddingHorizontal: 16,
    paddingBottom: 8,
    alignItems: 'center',
  },
  headerTitle: {
    fontWeight: 'bold',
    color: '#333',
    textAlign: 'center',
  },
});

export default ChatRoomScreen;
