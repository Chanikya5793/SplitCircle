import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { MessageBubble } from '@/components/MessageBubble';
import { ROUTES } from '@/constants';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatMessage, ChatThread } from '@/models';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Avatar, IconButton, Text, TextInput } from 'react-native-paper';

interface ChatRoomScreenProps {
  thread: ChatThread;
}

export const ChatRoomScreen = ({ thread }: ChatRoomScreenProps) => {
  const navigation = useNavigation();
  const { subscribeToMessages, sendMessage } = useChat();
  const { groups } = useGroups();
  const { theme, isDark } = useTheme();
  // Messages for this chat (inverted list - newest first)
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Text input state for composer
  const [text, setText] = useState('');
  // Sending flag - disables the send button while awaiting network
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const scrollY = useRef(new Animated.Value(0)).current;
  // Track focus state of the composer input so we can highlight the
  // outer container (`GlassView`) with a border that matches the app color.
  const [composerFocused, setComposerFocused] = useState(false);
  // Animated value for focus border animation (0 = unfocused, 1 = focused)
  const focusAnim = useRef(new Animated.Value(0)).current;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: '',
      headerTransparent: true,
      headerTintColor: theme.colors.primary,
    });
  }, [navigation, theme.colors.primary]);

  const headerOpacity = scrollY.interpolate({
    inputRange: [0, 40],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  useEffect(() => {
    console.log(`📺 ChatRoomScreen mounted for chat: ${thread.chatId}`);

    const unsubscribe = subscribeToMessages(thread.chatId, (items) => {
      console.log(`📨 Received ${items.length} messages in ChatRoomScreen`);
      setMessages(items);
    });

    return () => {
      console.log('👋 ChatRoomScreen unmounting');
      unsubscribe();
    };
  }, [subscribeToMessages, thread.chatId]);

  useEffect(() => {
    if (messages.length === 0) {
      return;
    }
    // Scroll to bottom (which is top for inverted list) when new messages arrive
    // But only if we are already near the bottom? For now, just scroll.
    // listRef.current?.scrollToOffset({ offset: 0, animated: true });
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
      navigation.navigate(ROUTES.APP.GROUP_INFO, { groupId: thread.groupId });
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
        <TouchableOpacity
          onPress={thread.type === 'group' ? handleHeaderPress : undefined}
          activeOpacity={0.7}
          // make header hit area predictable
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <GlassView style={styles.stickyHeaderGlass}>
            <View style={styles.headerRow}>
              {thread.type === 'group' && (
                <Avatar.Text
                  size={32}
                  label={groupInitials}
                  style={{ backgroundColor: theme.colors.primary, marginRight: 8 }}
                  color={theme.colors.onPrimary}
                />
              )}
              <Text
                variant="titleMedium"
                style={[styles.stickyHeaderTitle, { color: theme.colors.onSurface }]}
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
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      // smaller offset so composer hugs the keyboard more closely
      //keyboardVerticalOffset={Platform.OS === 'ios' ? 50 : 0}
      >
        <Pressable
          onPress={thread.type === 'group' ? handleHeaderPress : undefined}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={({ pressed }) => [styles.headerContainer, pressed && { opacity: 0.6 }]}
        >
          <View style={styles.headerRow}>
            {thread.type === 'group' && (
              <Avatar.Text
                size={48}
                label={groupInitials}
                style={{ backgroundColor: theme.colors.primary, marginRight: 12 }}
                color={theme.colors.onPrimary}
              />
            )}
            <Text variant="headlineMedium" style={[styles.headerTitle, { color: theme.colors.onSurface }]}>{title}</Text>
          </View>
        </Pressable>

        <Animated.FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.messageId || item.id || Math.random().toString()}
          renderItem={({ item, index }) => {
            const prevMessage = messages[index + 1];
            const isFirstInSequence = !prevMessage || prevMessage.senderId !== item.senderId || prevMessage.type === 'system';
            const participant = thread.participants.find(p => p.userId === item.senderId);
            const senderName = participant?.displayName || 'Unknown';

            return (
              <MessageBubble
                message={item}
                showSenderInfo={isFirstInSequence}
                senderName={senderName}
              />
            );
          }}
          style={styles.list}
          contentContainerStyle={[styles.listContent, messages.length === 0 && { flex: 1, justifyContent: 'center' }]}
          inverted={messages.length > 0}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', justifyContent: 'center', padding: 20 }}>
              <Text style={{ color: theme.colors.secondary }}>No messages yet</Text>
              <Text style={{ color: theme.colors.secondary, fontSize: 12 }}>Send a message to start chatting</Text>
            </View>
          }
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: true }
          )}
          scrollEventThrottle={16}
        />

        <View style={styles.composerWrapper}>
          <Animated.View
            style={{
              ...styles.composerAnimated,
              borderWidth: focusAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 2] }),
              borderColor: theme.colors.primary,
              borderRadius: styles.composer.borderRadius,
            }}
          >
            <GlassView style={styles.composer}>
              <TextInput
                // Use flat mode so the TextInput doesn't draw its own outline
                // when focused. We rely on the surrounding `GlassView` for
                // container radius and padding so the inner input stays visually
                // consistent with the composer.
                mode="flat"
                placeholder={placeholder}
                value={text}
                onChangeText={setText}
                style={styles.input}
                // control inner padding so text lines up with composer padding
                contentStyle={styles.inputContent}
                // ensure caret is visible
                selectionColor={theme.colors.primary}
                // Remove underline by forcing no bottom border on the inner input
                // and ensuring the TextInput doesn't render any underline color
                underlineColor="transparent"
                activeUnderlineColor="transparent"
                onFocus={() => {
                  setComposerFocused(true);
                  Animated.timing(focusAnim, { toValue: 1, duration: 150, useNativeDriver: false }).start();
                }}
                onBlur={() => {
                  setComposerFocused(false);
                  Animated.timing(focusAnim, { toValue: 0, duration: 150, useNativeDriver: false }).start();
                }}
                multiline
                numberOfLines={2}
                maxLength={1000}
                theme={{
                  colors: {
                    background: 'transparent',
                    onSurfaceVariant: theme.colors.onSurfaceVariant,
                    text: theme.colors.onSurface,
                    placeholder: theme.colors.onSurfaceVariant,
                  }
                }}
                returnKeyType="send"
                onSubmitEditing={handleSend}
                blurOnSubmit={false}
                keyboardAppearance={isDark ? 'dark' : 'light'}
              />
            </GlassView>
          </Animated.View>
          <IconButton
            icon="send"
            mode="contained"
            onPress={handleSend}
            disabled={!text.trim() || sending}
            containerColor={!text.trim() || sending ? (isDark ? '#555' : '#ccc') : theme.colors.primary}
            iconColor={theme.colors.onPrimary}
            size={28}
            style={styles.sendButton}
            accessibilityLabel="Send message"
          />
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
    // Make bottom padding larger so composer doesn't overlap list items
    paddingBottom: 10,
  },
  composerWrapper: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    // Increase horizontal padding to give the composer more breathing room
    paddingHorizontal: 12,
    // small vertical padding so composer sits nicely above keyboard
    paddingVertical: 0,
    // GAP BETWEEN KEYBOARD AND INPUT: Adjust this value to increase/decrease space
    marginBottom: 10,
  },
  composer: {
    flex: 1,
    // Container padding controls inner space around the text input
    padding: 0,
    // Larger radius makes the composer pill feel more touch-friendly
    borderRadius: 50,
  },
  input: {
    backgroundColor: 'transparent',
    // Tweak these min/max to change vertical size of the input box
    maxHeight: 120,
    minHeight: 44, // Ensure minimum touch height
    textAlignVertical: 'center',
    justifyContent: 'center',
    // Internal padding is controlled via contentStyle; keep zero here
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  inputContent: {
    // PLACEHOLDER ALIGNMENT: Adjust vertical padding to center text
    paddingVertical: 0,
    // move placeholder/text a bit to the right
    paddingLeft: 16,
    paddingRight: 8,
  },
  composerAnimated: {
    flex: 1,
    borderRadius: 50,
    overflow: 'hidden',
  },
  sendButton: {
    margin: 5,
    // Keep the send button visually aligned with the composer baseline
    marginBottom: 5.5,
    // Add a little extra touch area by increasing container size if needed
    width: 44,
    height: 44,
  },
  composerFocused: {
    borderWidth: 2,
    // borderColor handled dynamically
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
    maxWidth: '85%',
  },
  stickyHeaderTitle: {
    fontWeight: 'bold',
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
    textAlign: 'center',
  },
});

export default ChatRoomScreen;
