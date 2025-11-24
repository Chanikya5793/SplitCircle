import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { MessageBubble } from '@/components/MessageBubble';
import { colors, ROUTES } from '@/constants';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import type { ChatMessage, ChatThread } from '@/models';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, KeyboardAvoidingView, Platform, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Avatar, Button, Text, TextInput } from 'react-native-paper';

interface ChatRoomScreenProps {
  thread: ChatThread;
}

export const ChatRoomScreen = ({ thread }: ChatRoomScreenProps) => {
  const navigation = useNavigation();
  const { subscribeToMessages, sendMessage } = useChat();
  const { groups } = useGroups();
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

  // Get proper group name if this is a group chat
  const groupName = useMemo(() => {
    if (thread.type === 'group' && thread.groupId) {
      const group = groups.find(g => g.groupId === thread.groupId);
      return group?.name || 'Group Chat';
    }
    return null;
  }, [thread.type, thread.groupId, groups]);

  const placeholder = useMemo(() => (thread.type === 'group' ? 'Type a message...' : 'Message user'), [thread.type]);
  const title = thread.type === 'group'
    ? groupName || 'Group Chat'
    : thread.participants.find(p => p.userId !== thread.participantIds[0])?.displayName || 'Direct Chat';

  const handleHeaderPress = () => {
    if (thread.type === 'group' && thread.groupId) {
      // @ts-ignore - navigation types
      navigation.navigate(ROUTES.APP.GROUP_DETAILS, { groupId: thread.groupId });
    }
  };

  // Get group initials for avatar
  const groupInitials = useMemo(() => {
    if (thread.type === 'group' && groupName) {
      return groupName.slice(0, 2).toUpperCase();
    }
    return 'GC';
  }, [thread.type, groupName]);

  return (
    <LiquidBackground>
      <Animated.View style={[styles.stickyHeader, { opacity: headerOpacity }]}>
        <TouchableOpacity onPress={thread.type === 'group' ? handleHeaderPress : undefined} activeOpacity={0.7}>
          <GlassView style={styles.stickyHeaderGlass}>
            <View style={styles.headerRow}>
              {thread.type === 'group' && (
                <Avatar.Text
                  size={32}
                  label={groupInitials}
                  style={{ backgroundColor: colors.primary, marginRight: 8 }}
                  color="#fff"
                />
              )}
              <Text
                variant="titleMedium"
                style={styles.stickyHeaderTitle}
                numberOfLines={1}
              >
                {title}
              </Text>
            </View>
          </GlassView>
        </TouchableOpacity>
      </Animated.View>

      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={90}
      >
        <TouchableOpacity onPress={thread.type === 'group' ? handleHeaderPress : undefined} activeOpacity={0.8}>
          <View style={styles.headerContainer}>
            <View style={styles.headerRow}>
              {thread.type === 'group' && (
                <Avatar.Text
                  size={48}
                  label={groupInitials}
                  style={{ backgroundColor: colors.primary, marginRight: 12 }}
                  color="#fff"
                />
              )}
              <Text variant="headlineMedium" style={styles.headerTitle}>{title}</Text>
            </View>
          </View>
        </TouchableOpacity>

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

        <View style={styles.composerContainer}>
          <GlassView style={styles.composer}>
            <TextInput
              mode="outlined"
              placeholder={placeholder}
              value={text}
              onChangeText={setText}
              style={styles.input}
              outlineColor="transparent"
              activeOutlineColor={colors.primary}
              theme={{
                colors: {
                  background: 'transparent',
                  onSurfaceVariant: '#999'
                }
              }}
              returnKeyType="send"
              onSubmitEditing={handleSend}
              blurOnSubmit={false}
              dense
            />
            <Button
              mode="contained"
              icon="send"
              onPress={handleSend}
              disabled={!text.trim() || sending}
              style={styles.sendButton}
              contentStyle={styles.sendButtonContent}
            >
              Send
            </Button>
          </GlassView>
        </View>
      </KeyboardAvoidingView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 60,
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: 16,
    gap: 8,
    paddingBottom: 20,
  },
  composerContainer: {
    paddingHorizontal: 0,
    paddingBottom: 0,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: 12,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  input: {
    flex: 1,
    backgroundColor: 'transparent',
    maxHeight: 100,
  },
  sendButton: {
    alignSelf: 'flex-end',
  },
  sendButtonContent: {
    paddingVertical: 4,
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
    paddingHorizontal: 16,
    borderRadius: 24,
    backgroundColor: 'rgba(255, 255, 255, 0.8)',
    maxWidth: '85%',
  },
  stickyHeaderTitle: {
    fontWeight: 'bold',
    color: '#333',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerContainer: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    alignItems: 'center',
  },
  headerTitle: {
    fontWeight: 'bold',
    color: '#333',
    textAlign: 'center',
  },
});

export default ChatRoomScreen;
