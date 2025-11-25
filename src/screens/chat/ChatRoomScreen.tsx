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
import { Avatar, IconButton, Text, TextInput } from 'react-native-paper';

interface ChatRoomScreenProps {
  thread: ChatThread;
}

export const ChatRoomScreen = ({ thread }: ChatRoomScreenProps) => {
  const navigation = useNavigation();
  const { subscribeToMessages, sendMessage } = useChat();
  const { groups } = useGroups();
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

        <View style={styles.composerWrapper}>
          <GlassView style={{ ...styles.composer, ...(composerFocused ? styles.composerFocused : {}) }}>
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
              selectionColor={colors.primary}
              // Remove underline by forcing no bottom border on the inner input
              // and ensuring the TextInput doesn't render any underline color
              underlineColor="transparent"
              activeUnderlineColor="transparent"
              onFocus={() => setComposerFocused(true)}
              onBlur={() => setComposerFocused(false)}
              multiline
              numberOfLines={2}
              maxLength={1000}
              theme={{
                colors: {
                  background: 'transparent',
                  onSurfaceVariant: '#999'
                }
              }}
              returnKeyType="send"
              onSubmitEditing={handleSend}
              blurOnSubmit={false}
            />
          </GlassView>
          <IconButton
            icon="send"
            mode="contained"
            onPress={handleSend}
            disabled={!text.trim() || sending}
            containerColor={!text.trim() || sending ? '#ccc' : colors.primary}
            iconColor="#fff"
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
    // Vertical padding affects how snug the composer sits above the keyboard
    paddingVertical: 0,
  },
  composer: {
    flex: 1,
    // Container padding controls inner space around the text input
    padding: 12,
    // Larger radius makes the composer pill feel more touch-friendly
    borderRadius: 50,
  },
  input: {
    backgroundColor: 'transparent',
    // Tweak these min/max to change vertical size of the input box
    maxHeight: 120,
    minHeight: 40,
    // make sure the inner text isn't clipped on Android
    textAlignVertical: 'center',
    // Internal padding is controlled via contentStyle; keep zero here
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  inputContent: {
    // controls the inner padding of the react-native-paper TextInput
    paddingVertical: 10,
    // move placeholder/text a bit to the right
    paddingLeft: 16,
    paddingRight: 8,
  },
  sendButton: {
    margin: 0,
    // Keep the send button visually aligned with the composer baseline
    marginBottom: 20,
    // Add a little extra touch area by increasing container size if needed
    width: 44,
    height: 44,
  },
  composerFocused: {
    borderWidth: 2,
    borderColor: colors.primary,
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
