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
import { Animated, FlatList, Keyboard, Platform, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Avatar, IconButton, Text, TextInput } from 'react-native-paper';

interface ChatRoomScreenProps {
  thread: ChatThread;
}

const AVATAR_COLORS = [
  '#E57373', '#F06292', '#BA68C8', '#9575CD', '#7986CB',
  '#64B5F6', '#4FC3F7', '#4DD0E1', '#4DB6AC', '#81C784',
  '#AED581', '#FF8A65', '#D4E157', '#FFD54F', '#FFB74D'
];

const getSenderColor = (id: string) => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

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

  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const inputRef = useRef<any>(null);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: '',
      headerTransparent: true,
      headerTintColor: theme.colors.primary,
    });
  }, [navigation, theme.colors.primary]);

  const headerOpacity = 1; // Persistent header

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
      let replyData = undefined;
      if (replyingTo) {
        const participant = thread.participants.find(p => p.userId === replyingTo.senderId);
        replyData = {
          messageId: replyingTo.messageId,
          senderId: replyingTo.senderId,
          senderName: participant?.displayName || 'Unknown',
          content: replyingTo.content,
        };
      }

      await sendMessage({
        chatId: thread.chatId,
        content: trimmed,
        groupId: thread.groupId,
        replyTo: replyData
      });
      setText('');
      setReplyingTo(null);
    } finally {
      setSending(false);
    }
  };

  const handleSwipeReply = (message: ChatMessage) => {
    setReplyingTo(message);
    inputRef.current?.focus();
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

  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const showSubscription = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e: any) => {
        setKeyboardHeight(e.endCoordinates.height);
      }
    );
    const hideSubscription = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        setKeyboardHeight(0);
      }
    );

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  const isInverted = messages.length > 0;
  // Base padding for composer (approx 100) + keyboard height
  const bottomPadding = 160 + keyboardHeight;

  return (
    <LiquidBackground>
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
              onSwipeReply={handleSwipeReply}
            />
          );
        }}
        style={styles.list}
        contentContainerStyle={[
          styles.listContent,
          isInverted
            ? { paddingTop: bottomPadding, paddingBottom: 120 } // Inverted: Top=Bottom(Composer+Keyboard), Bottom=Top(Header)
            : { paddingTop: 120, paddingBottom: bottomPadding }, // Normal: Top=Header, Bottom=Composer+Keyboard
          messages.length === 0 && { flex: 1, justifyContent: 'center', paddingTop: 0, paddingBottom: 0 }
        ]}
        inverted={isInverted}
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

      <Animated.View style={[styles.stickyHeader, { opacity: headerOpacity }]} pointerEvents="box-none">
        <TouchableOpacity
          onPress={thread.type === 'group' ? handleHeaderPress : undefined}
          activeOpacity={0.7}
          hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
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

      <View
        style={[styles.composerContainer, { bottom: keyboardHeight }]}
        pointerEvents="auto"
      >
        {replyingTo && (
          <View style={[styles.replyPreview, { backgroundColor: isDark ? '#1E1E1E' : '#F5F5F5', borderLeftColor: getSenderColor(replyingTo.senderId) }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.replyPreviewSender, { color: getSenderColor(replyingTo.senderId) }]}>
                {thread.participants.find(p => p.userId === replyingTo.senderId)?.displayName || 'Unknown'}
              </Text>
              <Text numberOfLines={1} style={{ color: theme.colors.onSurfaceVariant }}>
                {replyingTo.content}
              </Text>
            </View>
            <IconButton
              icon="close"
              size={20}
              onPress={() => setReplyingTo(null)}
              iconColor={theme.colors.onSurfaceVariant}
            />
          </View>
        )}

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
                ref={inputRef}
                mode="flat"
                placeholder={placeholder}
                value={text}
                onChangeText={setText}
                style={styles.input}
                contentStyle={styles.inputContent}
                selectionColor={theme.colors.primary}
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
      </View>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  list: {
    ...StyleSheet.absoluteFillObject,
  },
  listContent: {
    paddingHorizontal: 16,
    gap: 8,
  },
  composerContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingBottom: 10, // Base padding from bottom
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
    minHeight: 44,
    textAlignVertical: 'center',
    justifyContent: 'center',
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  inputContent: {
    paddingVertical: 0,
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
    marginBottom: 5.5,
    width: 44,
    height: 44,
  },
  composerFocused: {
    borderWidth: 2,
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
  headerTitle: {
    fontWeight: 'bold',
    textAlign: 'center',
  },
  replyPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 8,
    borderLeftWidth: 4,
  },
  replyPreviewSender: {
    fontWeight: 'bold',
    marginBottom: 2,
  },
});

export default ChatRoomScreen;
