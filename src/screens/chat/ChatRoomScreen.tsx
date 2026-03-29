import { AttachmentMenu, LocationPicker, MediaPreview } from '@/components/Chat';
import type { SelectedMedia } from '@/components/Chat/AttachmentMenu';
import type { QualityLevel } from '@/components/Chat/MediaPreview';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { LoadingOverlay } from '@/components/LoadingOverlay';
import { MessageBubble } from '@/components/MessageBubble';
import { ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { useLoadingState } from '@/context/LoadingContext';
import { useTheme } from '@/context/ThemeContext';
import { usePreventDoubleSubmit } from '@/hooks/usePreventDoubleSubmit';
import type { ChatMessage, ChatThread, MessageType } from '@/models';
import { processImage, processVideo } from '@/services/mediaProcessingService';
import { lightHaptic, successHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, FlatList, KeyboardAvoidingView, Platform, StyleSheet, TouchableOpacity, View } from 'react-native';
import { ActivityIndicator, Avatar, Icon, IconButton, Text, TextInput } from 'react-native-paper';

interface ChatRoomScreenProps {
  thread: ChatThread;
}

export const ChatRoomScreen = ({ thread }: ChatRoomScreenProps) => {
  const navigation = useNavigation();
  const { subscribeToMessages, sendMessage, markChatAsRead } = useChat();
  const { user } = useAuth();
  const { groups } = useGroups();
  const { theme, isDark } = useTheme();
  // Messages for this chat (inverted list - newest first)
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Text input state for composer
  const [text, setText] = useState('');
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const scrollY = useRef(new Animated.Value(0)).current;
  // Track focus state of the composer input so we can highlight the
  // outer container (`GlassView`) with a border that matches the app color.
  const [composerFocused, setComposerFocused] = useState(false);
  // Reply state
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const inputRef = useRef<any>(null);
  // Attachment menu state
  const [attachmentMenuVisible, setAttachmentMenuVisible] = useState(false);
  // Media preview state
  const [selectedMedia, setSelectedMedia] = useState<SelectedMedia | null>(null);
  const [mediaPreviewVisible, setMediaPreviewVisible] = useState(false);
  // Location picker state
  const [locationPickerVisible, setLocationPickerVisible] = useState(false);
  const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markReadInFlightRef = useRef(false);
  const { loading: sending, run: runSend } = usePreventDoubleSubmit();
  const mediaPipelineLoading = useLoadingState(`chat-media:${thread.chatId}`);

  const requestMarkAsRead = useCallback(() => {
    if (markReadTimerRef.current) {
      clearTimeout(markReadTimerRef.current);
    }

    markReadTimerRef.current = setTimeout(() => {
      if (markReadInFlightRef.current) {
        return;
      }

      markReadInFlightRef.current = true;
      void markChatAsRead(thread.chatId).finally(() => {
        markReadInFlightRef.current = false;
      });
    }, 100);
  }, [markChatAsRead, thread.chatId]);

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

    // Reduce noisy logging and unnecessary state updates:
    // - Update messages when list composition or delivery/read state changes.
    // - Throttle console logging to once per LOG_INTERVAL, otherwise only log new messages.
    let lastLogAt = 0;
    const LOG_INTERVAL = 30_000; // 30s
    let prevCount = 0;
    let prevLastMessageId: string | null = null;
    let prevStatusFingerprint = '';

    const unsubscribe = subscribeToMessages(thread.chatId, (items) => {
      // Keep the previous count/last id for comparisons
      const prevCountBefore = prevCount;
      const prevLastIdBefore = prevLastMessageId;

      const lastItem = items[0]; // inverted list: incoming array has newest first
      const lastId = lastItem?.messageId || lastItem?.id || null;

      const countChanged = items.length !== prevCountBefore;
      const lastIdChanged = lastId !== prevLastIdBefore;
      const statusFingerprint = items
        .map((item) => {
          const id = item.messageId || item.id;
          const deliveredCount = item.deliveredTo?.length ?? 0;
          const readCount = item.readBy?.length ?? 0;
          return `${id}:${item.status}:${deliveredCount}:${readCount}`;
        })
        .join('|');
      const statusChanged = statusFingerprint !== prevStatusFingerprint;

      // Update when list composition or delivery/read status changes.
      if (countChanged || lastIdChanged || statusChanged) {
        setMessages(items);
        prevCount = items.length;
        prevLastMessageId = lastId;
        prevStatusFingerprint = statusFingerprint;
      }

      // Throttled logging to avoid spamming the console
      const now = Date.now();
      if (now - lastLogAt > LOG_INTERVAL) {
        console.log(`📨 Received ${items.length} messages in ChatRoomScreen`);
        lastLogAt = now;
      } else if (countChanged && items.length > prevCountBefore) {
        // If new messages arrived and we are within the throttle window,
        // log a concise "new messages" note.
        console.log(`📨 New message(s) — total: ${items.length}`);
        lastLogAt = now;
      }
    });

    // Mark all messages as read when opening the chat
    requestMarkAsRead();

    // Also mark as read when app comes back to foreground
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        requestMarkAsRead();
      }
    });

    return () => {
      console.log('👋 ChatRoomScreen unmounting');
      unsubscribe();
      subscription.remove();
      if (markReadTimerRef.current) {
        clearTimeout(markReadTimerRef.current);
      }
    };
  }, [requestMarkAsRead, subscribeToMessages, thread.chatId]);

  useEffect(() => {
    if (messages.length === 0) {
      return;
    }
    // Scroll to bottom (which is top for inverted list) when new messages arrive
    // But only if we are already near the bottom? For now, just scroll.
    // listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, [messages.length]);

  // If chat is open and a new incoming message appears, mark it as read immediately.
  useEffect(() => {
    if (!user || messages.length === 0) {
      return;
    }

    const hasUnreadIncoming = messages.some(
      (message) =>
        message.senderId !== user.userId &&
        (!message.readBy || !message.readBy.includes(user.userId))
    );

    if (!hasUnreadIncoming) {
      return;
    }

    requestMarkAsRead();
  }, [messages, requestMarkAsRead, user]);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    try {
      await runSend(async (requestId) => {
        lightHaptic();

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
          requestId,
          content: trimmed,
          groupId: thread.groupId,
          replyTo: replyData,
        });
        successHaptic();
        setText('');
        setReplyingTo(null);
      }, { key: `chat-send-${thread.chatId}` });
    } catch (error) {
      console.error('Failed to send message:', error);
      alert(error instanceof Error ? error.message : 'Failed to send message');
    }
  };

  // Handle swipe reply from message bubble
  const handleSwipeReply = (message: ChatMessage) => {
    lightHaptic();
    setReplyingTo(message);
    inputRef.current?.focus();
  };

  const handleSwipeInfo = (message: ChatMessage) => {
    lightHaptic();
    // @ts-ignore - navigation route typing is intentionally loose in this app
    navigation.navigate(ROUTES.APP.MESSAGE_INFO, { message, thread });
  };

  const handleMediaSelected = async (media: SelectedMedia) => {
    if (media.type === 'location') {
      setAttachmentMenuVisible(false);
      setLocationPickerVisible(true);
      return;
    }

    mediaPipelineLoading.start(getPreviewLoadingMessage(media.type));
    setAttachmentMenuVisible(false);
    setSelectedMedia(media);
    requestAnimationFrame(() => {
      setMediaPreviewVisible(true);
    });
  };

  // Handle sending media with optional caption
  const handleSendMedia = async (caption: string, quality: QualityLevel) => {
    if (!selectedMedia) return;
    const mediaToSend = selectedMedia;

    // Show processing overlay FIRST, then close preview — this avoids
    // a blank flash between preview dismissal and overlay appearance.
    mediaPipelineLoading.start(getProcessingLoadingMessage(mediaToSend.type));
    setMediaPreviewVisible(false);

    try {
      // Process media based on quality selection
      let processedUri = mediaToSend.uri;
      let processedWidth = mediaToSend.width;
      let processedHeight = mediaToSend.height;
      let processedSize = mediaToSend.fileSize;

      if (mediaToSend.type === 'image' || mediaToSend.type === 'camera') {
        const result = await processImage(mediaToSend.uri, quality);
        processedUri = result.uri;
        processedWidth = result.width;
        processedHeight = result.height;
        processedSize = result.size;
      } else if (mediaToSend.type === 'video') {
        const result = await processVideo(mediaToSend.uri, quality);
        processedUri = result.uri;
        if (result.width > 0) processedWidth = result.width;
        if (result.height > 0) processedHeight = result.height;
        processedSize = result.size;
      }

      // Map attachment type to message type
      let messageType: MessageType;
      switch (mediaToSend.type) {
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
      const mediaMetadata: Record<string, unknown> = {};
      if (mediaToSend.fileName) mediaMetadata.fileName = mediaToSend.fileName;
      if (processedSize) mediaMetadata.fileSize = processedSize;
      if (mediaToSend.mimeType) mediaMetadata.mimeType = mediaToSend.mimeType;
      if (processedWidth) mediaMetadata.width = processedWidth;
      if (processedHeight) mediaMetadata.height = processedHeight;
      if (mediaToSend.duration) mediaMetadata.duration = mediaToSend.duration;
      if (processedWidth && processedHeight) {
        mediaMetadata.aspectRatio = processedWidth / processedHeight;
      }

      // Update overlay message to uploading phase
      mediaPipelineLoading.setMessage(
        `Uploading ${mediaToSend.type === 'video' ? 'video' : 'attachment'}…`,
      );

      // Send the message directly - ChatContext handles upload
      await runSend(async (requestId) => {
        await sendMessage({
          chatId: thread.chatId,
          requestId,
          content: caption || getMediaPlaceholder(messageType),
          type: messageType,
          mediaUri: processedUri,
          groupId: thread.groupId,
          replyTo: replyData,
          mediaMetadata: Object.keys(mediaMetadata).length > 0 ? mediaMetadata as any : undefined,
          onStageChange: (stage, details) => {
            if (stage === 'complete') {
              return;
            }

            if (details?.message) {
              mediaPipelineLoading.setMessage(details.message);
            }
          },
        });
      }, { key: `chat-media-${thread.chatId}` });

      setSelectedMedia(null);
      setReplyingTo(null);
    } catch (error) {
      console.error('Failed to send media:', error);
      alert(error instanceof Error ? error.message : 'Failed to send media');
    } finally {
      mediaPipelineLoading.stop();
    }
  };

  // Handle sending location
  const handleSendLocation = async (location: { latitude: number; longitude: number; address?: string }) => {
    try {
      await runSend(async (requestId) => {
        await sendMessage({
          chatId: thread.chatId,
          requestId,
          content: '📍 Location',
          type: 'location',
          groupId: thread.groupId,
          location,
        });
      }, { key: `chat-location-${thread.chatId}` });
    } catch (error) {
      console.error('Failed to send location:', error);
      alert('Failed to send location');
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
  const directParticipant = useMemo(
    () => thread.participants.find((p) => p.userId !== user?.userId) ?? thread.participants[0],
    [thread.participants, user?.userId],
  );
  const title = thread.type === 'group'
    ? groupName || 'Group Chat'
    : directParticipant?.displayName || 'Direct Chat';

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

  const getPreviewLoadingMessage = useCallback((type: SelectedMedia['type']) => {
    switch (type) {
      case 'video':
        return 'Preparing video preview…';
      case 'image':
      case 'camera':
        return 'Preparing photo preview…';
      case 'document':
        return 'Opening document preview…';
      case 'audio':
        return 'Opening audio preview…';
      default:
        return 'Preparing attachment…';
    }
  }, []);

  const getProcessingLoadingMessage = useCallback((type: SelectedMedia['type']) => {
    switch (type) {
      case 'video':
        return 'Preparing video for upload…';
      case 'image':
      case 'camera':
        return 'Optimizing photo…';
      case 'document':
        return 'Preparing document…';
      case 'audio':
        return 'Preparing audio…';
      default:
        return 'Preparing attachment…';
    }
  }, []);

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
                onSwipeInfo={thread.type === 'group' ? handleSwipeInfo : undefined}
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
              onPress={mediaPipelineLoading.loading ? undefined : () => setAttachmentMenuVisible(true)}
              containerColor={isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)'}
              iconColor={theme.colors.onSurfaceVariant}
              size={24}
              style={styles.attachButton}
              accessibilityLabel="Add attachment"
              disabled={mediaPipelineLoading.loading}
            />
            <View
              style={[
                styles.composerAnimated,
                composerFocused && { borderWidth: 2, borderColor: theme.colors.primary },
              ]}
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
                  onFocus={() => setComposerFocused(true)}
                  onBlur={() => setComposerFocused(false)}
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
                  onSubmitEditing={() => {
                    void handleSend();
                  }}
                  blurOnSubmit={false}
                  keyboardAppearance={isDark ? 'dark' : 'light'}
                />
              </GlassView>
            </View>
            <TouchableOpacity
              onPress={() => {
                void handleSend();
              }}
              disabled={!text.trim() || sending || mediaPipelineLoading.loading}
              activeOpacity={0.8}
              style={[
                styles.sendButtonTouchable,
                {
                  backgroundColor:
                    !text.trim() || sending || mediaPipelineLoading.loading
                      ? (isDark ? '#555' : '#ccc')
                      : theme.colors.primary,
                },
              ]}
              accessibilityLabel="Send message"
              accessibilityState={{
                disabled: !text.trim() || sending || mediaPipelineLoading.loading,
                busy: sending || mediaPipelineLoading.loading,
              }}
            >
              {sending ? (
                <ActivityIndicator animating size="small" color={theme.colors.onPrimary} />
              ) : (
                <Icon source="send" size={24} color={theme.colors.onPrimary} />
              )}
            </TouchableOpacity>
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
          mediaPipelineLoading.stop();
        }}
        onSend={handleSendMedia}
        onPreviewReady={() => {
          mediaPipelineLoading.stop();
        }}
      />

      {/* Location Picker Modal */}
      <LocationPicker
        visible={locationPickerVisible}
        onClose={() => setLocationPickerVisible(false)}
        onSendLocation={handleSendLocation}
      />

      {/* Media Processing Overlay — driven by keyed loading state */}
      <LoadingOverlay visible={mediaPipelineLoading.loading} message={mediaPipelineLoading.message ?? 'Processing media…'} />

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
  sendButtonTouchable: {
    margin: 5,
    marginBottom: 5.5,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
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
