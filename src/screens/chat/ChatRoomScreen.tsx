import { AttachmentMenu, ATTACHMENT_MENU_ANIMATION_DURATION, MediaPreview } from '@/components/Chat';
import type { SelectedMedia } from '@/components/Chat/AttachmentMenu';
import type { QualityLevel } from '@/components/Chat/MediaPreview';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { LoadingOverlay } from '@/components/LoadingOverlay';
import { MessageBubble } from '@/components/MessageBubble';
import { ROUTES } from '@/constants';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatMessage, ChatThread, MediaMetadata, MessageType } from '@/models';
import { processImage, processVideo } from '@/services/mediaProcessingService';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, FlatList, KeyboardAvoidingView, Platform, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Avatar, IconButton, Text, TextInput } from 'react-native-paper';

interface ChatRoomScreenProps {
  thread: ChatThread;
}

export const ChatRoomScreen = ({ thread }: ChatRoomScreenProps) => {
  const navigation = useNavigation();
  const { subscribeToMessages, sendMessage, markChatAsRead } = useChat();
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
  // Reply state
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const inputRef = useRef<any>(null);
  // Attachment menu state
  const [attachmentMenuVisible, setAttachmentMenuVisible] = useState(false);
  // Media preview state
  const [selectedMedia, setSelectedMedia] = useState<SelectedMedia | null>(null);
  const [mediaPreviewVisible, setMediaPreviewVisible] = useState(false);
  // Media processing state
  const [isProcessingMedia, setIsProcessingMedia] = useState(false);

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

    // Use refs to properly scope closure variables across multiple calls
    const lastLogAtRef = { current: 0 };
    const LOG_INTERVAL = 30_000; // 30s
    const prevCountRef = { current: 0 };
    const prevLastMessageIdRef = { current: null as string | null };

    const unsubscribe = subscribeToMessages(thread.chatId, (items) => {
      // Keep the previous count/last id for comparisons
      const prevCountBefore = prevCountRef.current;
      const prevLastIdBefore = prevLastMessageIdRef.current;

      const lastItem = items[0]; // inverted list: incoming array has newest first
      const lastId = lastItem?.messageId || lastItem?.id || null;

      const countChanged = items.length !== prevCountBefore;
      const lastIdChanged = lastId !== prevLastIdBefore;

      // Only update state if it's a meaningful change to reduce re-renders
      if (countChanged || lastIdChanged) {
      setMessages(items);
      prevCountRef.current = items.length;
      prevLastMessageIdRef.current = lastId;
      }

      // Throttled logging to avoid spamming the console
      const now = Date.now();
      if (now - lastLogAtRef.current > LOG_INTERVAL) {
      console.log(`📨 Received ${items.length} messages in ChatRoomScreen`);
      lastLogAtRef.current = now;
      } else if (countChanged && items.length > prevCountBefore) {
      // If new messages arrived and we are within the throttle window,
      // log a concise "new messages" note.
      console.log(`📨 New message(s) — total: ${items.length}`);
      lastLogAtRef.current = now;
      }
    });

    // Mark all messages as read when opening the chat
    markChatAsRead(thread.chatId);

    // Also mark as read when app comes back to foreground
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        markChatAsRead(thread.chatId);
      }
    });

    return () => {
      console.log('👋 ChatRoomScreen unmounting');
      unsubscribe();
      subscription.remove();
    };
  }, [subscribeToMessages, thread.chatId, markChatAsRead]);

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
      // Build replyTo data if replying
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
      await sendMessage({ chatId: thread.chatId, content: trimmed, groupId: thread.groupId, replyTo: replyData });
      setText('');
      setReplyingTo(null);
    } finally {
      setSending(false);
    }
  };

  // Handle swipe reply from message bubble
  const handleSwipeReply = (message: ChatMessage) => {
    setReplyingTo(message);
    inputRef.current?.focus();
  };

  // Handle media selection from attachment menu
  const handleMediaSelected = (media: SelectedMedia) => {
    // Close attachment menu first
    setAttachmentMenuVisible(false);
    
    // Wait for menu close animation to finish before showing preview
    // Add small buffer to ensure smooth transition
    setTimeout(() => {
      setSelectedMedia(media);
      setMediaPreviewVisible(true);
    }, ATTACHMENT_MENU_ANIMATION_DURATION + 50);
  };

  // Handle sending media with optional caption
  const handleSendMedia = async (caption: string, quality: QualityLevel) => {
    if (!selectedMedia) return;
    
    setMediaPreviewVisible(false);
    setIsProcessingMedia(true);
    
    try {
      // Process media based on quality selection
      let processedUri = selectedMedia.uri;
      let processedWidth = selectedMedia.width;
      let processedHeight = selectedMedia.height;
      let processedSize = selectedMedia.fileSize;

      if (selectedMedia.type === 'image' || selectedMedia.type === 'camera') {
        const result = await processImage(selectedMedia.uri, quality);
        processedUri = result.uri;
        processedWidth = result.width;
        processedHeight = result.height;
        processedSize = result.size;
      } else if (selectedMedia.type === 'video') {
        const result = await processVideo(selectedMedia.uri, quality);
        processedUri = result.uri;
        // Video processing might not return dimensions if we can't read them easily
        if (result.width > 0) processedWidth = result.width;
        if (result.height > 0) processedHeight = result.height;
        processedSize = result.size;
      }

      // Map attachment type to message type
      let messageType: MessageType;
      switch (selectedMedia.type) {
        case 'camera':
        case 'image':
          messageType = 'image';
          break;
        case 'video':
          messageType = 'video';
          break;
        case 'audio':
          messageType = 'audio';
          break;
        case 'document':
          messageType = 'file';
          break;
        case 'location':
          messageType = 'location';
          break;
        default:
          messageType = 'file';
      }

      // Build replyTo data if replying
      let replyData = undefined;
      if (replyingTo) {
        const participant = thread.participants.find(p => p.userId === replyingTo.senderId);
        replyData = {
          messageId: replyingTo.messageId,
          senderId: replyingTo.senderId,
          senderName: participant?.displayName || 'Unknown',
          content: replyingTo.content,
          type: replyingTo.type,
        };
      }

      // Build mediaMetadata with only defined values
      const mediaMetadata: Partial<MediaMetadata> = {};
      if (selectedMedia.fileName) mediaMetadata.fileName = selectedMedia.fileName;
      if (processedSize) mediaMetadata.fileSize = processedSize;
      if (selectedMedia.mimeType) mediaMetadata.mimeType = selectedMedia.mimeType;
      if (processedWidth) mediaMetadata.width = processedWidth;
      if (processedHeight) mediaMetadata.height = processedHeight;
      if (selectedMedia.duration) mediaMetadata.duration = selectedMedia.duration;
      if (processedWidth && processedHeight) {
        mediaMetadata.aspectRatio = processedWidth / processedHeight;
      }

      // Send the message directly - ChatContext handles upload
      await sendMessage({
        chatId: thread.chatId,
        content: caption || getMediaPlaceholder(messageType),
        type: messageType,
        mediaUri: processedUri,
        groupId: thread.groupId,
        replyTo: replyData,
        mediaMetadata: Object.keys(mediaMetadata).length > 0 ? mediaMetadata : undefined,
      });
      
      setSelectedMedia(null);
      setReplyingTo(null);
    } catch (error) {
      console.error('Failed to send media:', error);
      // Show error to user
      alert(error instanceof Error ? error.message : 'Failed to send media');
    } finally {
      setIsProcessingMedia(false);
    }
  };

  // Get placeholder text for media messages
  const getMediaPlaceholder = (type: MessageType): string => {
    switch (type) {
      case 'image': return '📷 Photo';
      case 'video': return '🎥 Video';
      case 'audio': return '🎵 Audio';
      case 'file': return '📄 Document';
      case 'location': return '📍 Location';
      default: return '📎 Attachment';
    }
  };

  // Get sender color for reply preview
  const getSenderColor = (id: string) => {
    const AVATAR_COLORS = [
      '#E57373', '#F06292', '#BA68C8', '#9575CD', '#7986CB',
      '#64B5F6', '#4FC3F7', '#4DD0E1', '#4DB6AC', '#81C784',
    ];
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = id.charCodeAt(i) + ((hash << 5) - hash);
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
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
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        // smaller offset so composer hugs the keyboard more closely
        //keyboardVerticalOffset={Platform.OS === 'ios' ? 50 : 0}
      >
        <View style={styles.headerContainer}>
          <TouchableOpacity
            onPress={thread.type === 'group' ? handleHeaderPress : undefined}
            activeOpacity={thread.type === 'group' ? 0.7 : 1}
          >
            <GlassView style={styles.headerPill} intensity={5}>
              <View style={styles.headerPillContent}>
                {thread.type === 'group' && (
                  <Avatar.Text
                    size={40}
                    label={groupInitials}
                    style={{ backgroundColor: theme.colors.primary, marginRight: 10 }}
                    color={theme.colors.onPrimary}
                  />
                )}
                <Text variant="titleLarge" style={[styles.headerTitle, { color: theme.colors.onSurface }]}>{title}</Text>
              </View>
            </GlassView>
          </TouchableOpacity>
        </View>

        <Animated.FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.messageId || item.id || `${item.createdAt}_${item.senderId}`}
          renderItem={({ item, index }) => {
            // Show sender info for first message in a sequence (group chats)
            const prevMessage = messages[index + 1]; // +1 because inverted
            const isFirstInSequence = !prevMessage || prevMessage.senderId !== item.senderId || prevMessage.type === 'system';
            const participant = thread.participants.find(p => p.userId === item.senderId);
            const senderName = participant?.displayName || 'Unknown';
            // Calculate total recipients for group chat receipt display (excluding sender)
            const totalRecipients = thread.participants.length - 1;

            return (
              <MessageBubble
                message={item}
                showSenderInfo={thread.type === 'group' ? isFirstInSequence : undefined}
                senderName={senderName}
                onSwipeReply={handleSwipeReply}
                isGroupChat={thread.type === 'group'}
                totalRecipients={totalRecipients}
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

        <GlassView style={styles.composerWrapper}>
          {/* Reply preview bar */}
          {replyingTo && (
            <View style={styles.replyPreviewContainer}>
              <View style={[styles.replyPreview, { 
                borderLeftColor: getSenderColor(replyingTo.senderId)
              }]}>
                <Text style={[styles.replyPreviewSender, { color: getSenderColor(replyingTo.senderId) }]}>
                  {thread.participants.find(p => p.userId === replyingTo.senderId)?.displayName || 'Unknown'}
                </Text>
                <Text numberOfLines={1} style={{ color: theme.colors.onSurfaceVariant, fontSize: 13 }}>
                  {replyingTo.content}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setReplyingTo(null)}
                style={[styles.replyCloseButton, { backgroundColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)' }]}
                activeOpacity={0.6}
              >
                <IconButton
                  icon="close"
                  size={22}
                  iconColor={theme.colors.onSurfaceVariant}
                  style={{ margin: 0 }}
                />
              </TouchableOpacity>
            </View>
          )}
          
          <View style={styles.inputRow}>
            {/* Attachment button (WhatsApp-style +) */}
            <IconButton
              icon="plus"
              mode="contained"
              onPress={() => setAttachmentMenuVisible(true)}
              containerColor={isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)'}
              iconColor={theme.colors.onSurfaceVariant}
              size={24}
              style={styles.attachButton}
              accessibilityLabel="Add attachment"
            />
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
                dense
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
                numberOfLines={1}
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
        </GlassView>
      </KeyboardAvoidingView>

      {/* Attachment Menu (WhatsApp-style bottom sheet) */}
      <AttachmentMenu
        visible={attachmentMenuVisible}
        onClose={() => setAttachmentMenuVisible(false)}
        onMediaSelected={handleMediaSelected}
      />

      {/* Media Preview Modal */}
      <MediaPreview
        media={selectedMedia}
        visible={mediaPreviewVisible}
        onClose={() => {
          setMediaPreviewVisible(false);
          setSelectedMedia(null);
        }}
        onSend={handleSendMedia}
      />

      {/* Processing Overlay */}
      <LoadingOverlay visible={isProcessingMedia} message="Processing media..." />
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
    overflow: 'visible',
  },
  listContent: {
    padding: 16,
    gap: 8,
    paddingBottom: 10,
  },
  composerWrapper: {
    marginTop: -20,
    paddingHorizontal: 12,
    paddingVertical: 16,
    marginBottom: -2,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
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
    maxHeight: 120,
    minHeight: 44,
    paddingTop: 0,
    paddingBottom: 0,
    marginTop: 0,
    marginBottom: 0,
  },
  inputContent: {
    paddingTop: 15,
    paddingBottom: 10,
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
  attachButton: {
    margin: 5,
    marginBottom: 5.5,
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
    paddingTop: 8,
    paddingBottom: 12,
    alignItems: 'center',
    zIndex: 100,
    elevation: 10,
  },
  headerPill: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 50,
  },
  headerPillContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerTitle: {
    fontWeight: 'bold',
    fontSize: 28,
    textAlign: 'center',
  },
  replyPreviewContainer: {
    position: 'relative',
    marginBottom: 8,
  },
  replyPreview: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    paddingRight: 40,
    borderRadius: 12,
    borderLeftWidth: 3,
  },
  replyCloseButton: {
    position: 'absolute',
    right: 8,
    top: '50%',
    transform: [{ translateY: -16 }],
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  replyPreviewSender: {
    fontWeight: 'bold',
    fontSize: 13,
    marginBottom: 2,
  },
  sendingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  },
  sendingContent: {
    alignItems: 'center',
    padding: 24,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.8)',
  },
});

export default ChatRoomScreen;
