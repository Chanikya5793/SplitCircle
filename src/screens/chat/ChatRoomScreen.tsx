import {
  AttachmentMenu,
  ChatSearchBar,
  ForwardPickerSheet,
  HeaderMenu,
  LocationPicker,
  MediaPreview,
  MentionAutocomplete,
  MessageActionSheet,
  PinnedMessagesBar,
  SelectionToolbar,
} from '@/components/Chat';
import { ReactionDetailsSheet } from '@/components/Chat/ReactionDetailsSheet';
import { EmojiPickerSheet } from '@/components/Chat/EmojiPickerSheet';
import type { HeaderMenuItem } from '@/components/Chat';
import type { SelectedMedia } from '@/components/Chat/AttachmentMenu';
import type { QualityLevel } from '@/components/Chat/MediaPreview';
import type { MessageAction } from '@/components/Chat/MessageActionSheet';
import type { SelectionAction } from '@/components/Chat/SelectionToolbar';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { LoadingOverlay } from '@/components/LoadingOverlay';
import { MessageBubble } from '@/components/MessageBubble';
import { ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useCallContext } from '@/context/CallContext';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { useLoadingState } from '@/context/LoadingContext';
import { useTheme } from '@/context/ThemeContext';
import { usePreventDoubleSubmit } from '@/hooks/usePreventDoubleSubmit';
import type { ChatMessage, ChatParticipant, ChatThread, MessageType, PinnedMessageRef } from '@/models';
import { processImage, processVideo } from '@/services/mediaProcessingService';
import {
  markMessageDeletedForUser,
  removeAllReactionsForUser,
  toggleMessageReaction,
  toggleMessageStar,
  updateMessageContent,
} from '@/services/localMessageStorage';
import { publishMessageState } from '@/services/messageStateService';
import { lightHaptic, mediumHaptic, successHaptic, warningHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, AppState, FlatList, InteractionManager, KeyboardAvoidingView, Platform, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Avatar, Icon, IconButton, Text, TextInput } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Edit window — WhatsApp allows edits up to 15 minutes after sending.
const EDIT_WINDOW_MS = 15 * 60 * 1000;
// Delete-for-everyone window — WhatsApp uses ~1 hour.
const DELETE_FOR_EVERYONE_WINDOW_MS = 60 * 60 * 1000;
// How long a typing presence ping stays "alive" before clients consider it stale.
const TYPING_STALE_MS = 6_000;
// Throttle typing pings — never write to Firestore more than once per interval.
const TYPING_PING_THROTTLE_MS = 2_500;

interface ChatRoomScreenProps {
  thread: ChatThread;
}

export const ChatRoomScreen = ({ thread }: ChatRoomScreenProps) => {
  const navigation = useNavigation();
  const {
    subscribeToMessages,
    sendMessage,
    markChatAsRead,
    togglePinMessage,
    deleteMessageForEveryone,
    setTyping,
  } = useChat();
  const { startCallSession } = useCallContext();
  const { user } = useAuth();
  const { groups } = useGroups();
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  // Messages for this chat (inverted list - newest first)
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Text input state for composer
  const [text, setText] = useState('');
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollY = useRef(new Animated.Value(0)).current;
  const [showScrollDown, setShowScrollDown] = useState(false);
  // Track focus state of the composer input so we can highlight the
  // outer container (`GlassView`) with a border that matches the app color.
  const [composerFocused, setComposerFocused] = useState(false);
  // Reply state
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  // Edit state — when set, the composer text replaces the message content on send.
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const inputRef = useRef<any>(null);
  // Long-press action sheet state
  const [actionTarget, setActionTarget] = useState<ChatMessage | null>(null);
  // Header overflow menu (search, gallery, starred)
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  // Forward picker state — separate from the action sheet so it can stay open while the picker animates in.
  const [forwardSource, setForwardSource] = useState<ChatMessage[] | null>(null);
  // Multi-select state
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  // Mention autocomplete state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionAnchor, setMentionAnchor] = useState<{ start: number; end: number } | null>(null);
  const [pendingMentionUserIds, setPendingMentionUserIds] = useState<string[]>([]);
  const composerSelectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  // Typing presence
  const lastTypingPingRef = useRef(0);
  const typingClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Attachment menu state
  const [attachmentMenuVisible, setAttachmentMenuVisible] = useState(false);
  // Media preview state
  const [selectedMedia, setSelectedMedia] = useState<SelectedMedia | null>(null);
  const [mediaPreviewVisible, setMediaPreviewVisible] = useState(false);
  // Location picker state
  const [locationPickerVisible, setLocationPickerVisible] = useState(false);
  // Reaction details sheet state
  const [reactionTarget, setReactionTarget] = useState<ChatMessage | null>(null);
  // Custom emoji picker (opened from + button on the action sheet's reaction strip)
  const [emojiPickerTarget, setEmojiPickerTarget] = useState<ChatMessage | null>(null);
  const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markReadInFlightRef = useRef(false);
  const { run: runSend } = usePreventDoubleSubmit();
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
    // The chat screen renders its own glass back button + title pill + call
    // actions in a single floating row, so suppress the native header to
    // avoid the back button overlapping the pill.
    navigation.setOptions({ headerShown: false });
  }, [navigation]);

  const placeAudioCall = useCallback(() => {
    lightHaptic();
    startCallSession({ chatId: thread.chatId, groupId: thread.groupId, type: 'audio' });
  }, [startCallSession, thread.chatId, thread.groupId]);

  const placeVideoCall = useCallback(() => {
    lightHaptic();
    startCallSession({ chatId: thread.chatId, groupId: thread.groupId, type: 'video' });
  }, [startCallSession, thread.chatId, thread.groupId]);

  useEffect(() => {
    if (__DEV__) console.log(`📺 ChatRoomScreen mounted for chat: ${thread.chatId}`);

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
      // Fingerprint covers every UI-relevant mutation, not just delivery/read.
      // Without reactions/star/edit/delete in here, mutations to those fields
      // would silently fail to re-render the bubble until the user left and
      // re-entered the chat.
      const statusFingerprint = items
        .map((item) => {
          const id = item.messageId || item.id;
          const deliveredCount = item.deliveredTo?.length ?? 0;
          const readCount = item.readBy?.length ?? 0;
          const reactionsHash = item.reactions
            ? Object.entries(item.reactions)
                .map(([emoji, ids]) => `${emoji}:${ids.length}`)
                .sort()
                .join(',')
            : '';
          const starredCount = item.starredBy?.length ?? 0;
          const deletedForCount = item.deletedFor?.length ?? 0;
          const deletedAll = item.deletedForEveryone ? 1 : 0;
          const editedAt = item.editedAt ?? 0;
          const contentLength = item.content?.length ?? 0;
          return `${id}:${item.status}:${deliveredCount}:${readCount}:${reactionsHash}:${starredCount}:${deletedForCount}:${deletedAll}:${editedAt}:${contentLength}`;
        })
        .join('|');
      const statusChanged = statusFingerprint !== prevStatusFingerprint;

      // Update when list composition or any tracked mutation changes.
      if (countChanged || lastIdChanged || statusChanged) {
        setMessages(items);
        prevCount = items.length;
        prevLastMessageId = lastId;
        prevStatusFingerprint = statusFingerprint;
      }

      // Throttled logging to avoid spamming the console
      const now = Date.now();
      if (__DEV__) {
        if (now - lastLogAt > LOG_INTERVAL) {
          console.log(`📨 Received ${items.length} messages in ChatRoomScreen`);
          lastLogAt = now;
        } else if (countChanged && items.length > prevCountBefore) {
          console.log(`📨 New message(s) — total: ${items.length}`);
          lastLogAt = now;
        }
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
      if (__DEV__) console.log('👋 ChatRoomScreen unmounting');
      unsubscribe();
      subscription.remove();
      if (markReadTimerRef.current) {
        clearTimeout(markReadTimerRef.current);
      }
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
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

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;

    lightHaptic();

    // Edit path — keeps the same messageId, only updates content + editedAt.
    if (editingMessage) {
      const targetId = editingMessage.messageId || editingMessage.id;
      const editedAt = Date.now();
      setText('');
      const editTarget = editingMessage;
      setEditingMessage(null);

      // Optimistic UI: patch the local in-memory list immediately so the user
      // sees the change without waiting for AsyncStorage or Firestore.
      setMessages((prev) =>
        prev.map((m) =>
          (m.messageId || m.id) === targetId
            ? { ...m, content: trimmed, editedAt }
            : m,
        ),
      );

      // Persist + broadcast in the background.
      void (async () => {
        try {
          await updateMessageContent(thread.chatId, targetId, trimmed, editedAt);
          await publishMessageState(thread.chatId, targetId, {
            editedContent: trimmed,
            editedAt,
          });
          successHaptic();
        } catch (error) {
          console.error('Failed to edit message:', error);
          setText(trimmed);
          setEditingMessage(editTarget);
          alert(error instanceof Error ? error.message : 'Failed to edit message');
        }
      })();
      return;
    }

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

    // Mentions — only attach userIds whose handle still appears in the final text
    // (user may have edited or removed them after picking).
    const finalMentions = (() => {
      if (pendingMentionUserIds.length === 0) return undefined;
      const lowered = trimmed.toLowerCase();
      return pendingMentionUserIds.filter((userId) => {
        const name = thread.participants.find((p) => p.userId === userId)?.displayName?.replace(/\s+/g, '');
        if (!name) return false;
        return lowered.includes(`@${name.toLowerCase()}`);
      });
    })();

    // Clear UI immediately — don't block on network
    setText('');
    setReplyingTo(null);
    setPendingMentionUserIds([]);
    setMentionAnchor(null);
    setMentionQuery(null);
    void setTyping(thread.chatId, false);

    void runSend(async (requestId) => {
      await sendMessage({
        chatId: thread.chatId,
        requestId,
        content: trimmed,
        groupId: thread.groupId,
        replyTo: replyData,
        mentions: finalMentions && finalMentions.length ? finalMentions : undefined,
      });
      successHaptic();
    }, { key: `chat-send-${thread.chatId}` }).catch((error) => {
      console.error('Failed to send message:', error);
      // Restore the text so the user can retry
      setText(trimmed);
      alert(error instanceof Error ? error.message : 'Failed to send message');
    });
  }, [text, replyingTo, editingMessage, pendingMentionUserIds, thread.participants, thread.chatId, thread.groupId, runSend, sendMessage, setTyping]);

  // Handle swipe reply from message bubble
  const handleSwipeReply = (message: ChatMessage) => {
    lightHaptic();
    setReplyingTo(message);
    inputRef.current?.focus();
  };

  const handleSwipeInfo = (message: ChatMessage) => {
    lightHaptic();
    // @ts-ignore - navigation route typing is intentionally loose in this app
    navigation.navigate(ROUTES.APP.MESSAGE_INFO, { message, thread, initialTitle: 'Message Info', backTitle: title });
  };

  const titleRef = useRef('');
  const handleMediaPress = useCallback((message: ChatMessage) => {
    lightHaptic();
    // @ts-ignore - navigation route typing is intentionally loose in this app
    navigation.navigate(ROUTES.APP.CHAT_MEDIA_GALLERY, {
      chatId: thread.chatId,
      title: 'Media',
      backTitle: titleRef.current,
      participants: thread.participants,
      initialMessageId: message.messageId || message.id,
    });
  }, [navigation, thread.chatId, thread.participants]);

  const handleLongPressMessage = useCallback((message: ChatMessage) => {
    mediumHaptic();
    setActionTarget(message);
  }, []);

  const handleFilePress = useCallback((message: ChatMessage) => {
    const localPath = message.localMediaPath || message.mediaUrl;
    if (!localPath) {
      Alert.alert('File Not Available', 'The file has not been downloaded yet.');
      return;
    }
    lightHaptic();
    // @ts-ignore — navigation route typing is intentionally loose in this app
    navigation.navigate(ROUTES.APP.FILE_PREVIEW, {
      uri: localPath,
      fileName: message.mediaMetadata?.fileName,
      mimeType: message.mediaMetadata?.mimeType,
      fileSize: message.mediaMetadata?.fileSize,
    });
  }, [navigation]);

  const applyReactionToggle = useCallback(async (message: ChatMessage, emoji: string) => {
    if (!user) return;
    const targetId = message.messageId || message.id;
    const next = await toggleMessageReaction(thread.chatId, targetId, user.userId, emoji);
    if (next !== undefined) {
      void publishMessageState(thread.chatId, targetId, { reactions: next });
    }
  }, [thread.chatId, user]);

  const handleReact = useCallback(async (emoji: string) => {
    if (!user || !actionTarget) return;
    if (emoji === '+') {
      // Open the full emoji picker; do not toggle anything yet.
      setEmojiPickerTarget(actionTarget);
      return;
    }
    await applyReactionToggle(actionTarget, emoji);
  }, [actionTarget, applyReactionToggle, user]);

  const handleEmojiPicked = useCallback(async (emoji: string) => {
    if (!emojiPickerTarget) return;
    await applyReactionToggle(emojiPickerTarget, emoji);
    setEmojiPickerTarget(null);
  }, [emojiPickerTarget, applyReactionToggle]);

  const handleReactionsPress = useCallback((message: ChatMessage) => {
    // Don't open the empty-state sheet — just guard at the call site.
    const hasAny = !!message.reactions && Object.values(message.reactions).some((u) => u.length > 0);
    if (!hasAny) return;
    setReactionTarget(message);
  }, []);

  const handleAction = useCallback(async (action: MessageAction) => {
    if (!actionTarget || !user) return;
    const target = actionTarget;
    const targetId = target.messageId || target.id;

    switch (action) {
      case 'reply': {
        setReplyingTo(target);
        setEditingMessage(null);
        inputRef.current?.focus?.();
        break;
      }
      case 'copy': {
        if (target.content) {
          await Clipboard.setStringAsync(target.content);
        }
        break;
      }
      case 'forward': {
        setForwardSource([target]);
        break;
      }
      case 'star':
      case 'unstar': {
        // Optimistic star toggle.
        setMessages((prev) =>
          prev.map((m) => {
            if ((m.messageId || m.id) !== targetId) return m;
            const has = m.starredBy?.includes(user.userId);
            const next = has
              ? (m.starredBy ?? []).filter((id) => id !== user.userId)
              : [...(m.starredBy ?? []), user.userId];
            return { ...m, starredBy: next };
          }),
        );
        await toggleMessageStar(thread.chatId, targetId, user.userId);
        break;
      }
      case 'edit': {
        setEditingMessage(target);
        setReplyingTo(null);
        setText(target.content);
        // Focus after a tick so the composer mounts with the text.
        setTimeout(() => inputRef.current?.focus?.(), 50);
        break;
      }
      case 'info': {
        handleSwipeInfo(target);
        break;
      }
      case 'select': {
        // Multi-select mode is Phase 2 — for now, alert so the user knows it's coming.
        Alert.alert('Select messages', 'Multi-select is coming soon.');
        break;
      }
      case 'pin':
      case 'unpin': {
        await togglePinMessage(thread.chatId, target);
        break;
      }
      case 'deleteForEveryone': {
        Alert.alert(
          'Delete for everyone?',
          'This message will be removed for everyone in the chat. They may have already seen it.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete for everyone',
              style: 'destructive',
              onPress: async () => {
                warningHaptic();
                // Optimistic flip — bubble becomes a tombstone immediately.
                setMessages((prev) =>
                  prev.map((m) =>
                    (m.messageId || m.id) === targetId
                      ? { ...m, deletedForEveryone: true, content: '' }
                      : m,
                  ),
                );
                await deleteMessageForEveryone(thread.chatId, targetId);
              },
            },
          ],
        );
        break;
      }
      case 'delete': {
        Alert.alert(
          'Delete message',
          'This message will be removed for you. Other people in the chat will still see it.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete for me',
              style: 'destructive',
              onPress: async () => {
                warningHaptic();
                // Optimistic local delete — the bubble flips to "You deleted this" tombstone.
                setMessages((prev) =>
                  prev.map((m) =>
                    (m.messageId || m.id) === targetId
                      ? { ...m, deletedFor: Array.from(new Set([...(m.deletedFor ?? []), user.userId])) }
                      : m,
                  ),
                );
                await markMessageDeletedForUser(thread.chatId, targetId, user.userId);
              },
            },
          ],
        );
        break;
      }
    }
  }, [actionTarget, thread.chatId, user, togglePinMessage, deleteMessageForEveryone]);

  // Double-tap on a bubble adds (or removes) a ❤️ reaction.
  const handleDoubleTap = useCallback(async (message: ChatMessage) => {
    if (!user) return;
    mediumHaptic();
    const targetId = message.messageId || message.id;
    const next = await toggleMessageReaction(thread.chatId, targetId, user.userId, '❤️');
    if (next !== undefined) {
      void publishMessageState(thread.chatId, targetId, { reactions: next });
    }
  }, [thread.chatId, user]);

  // ──────────────────────────── Selection mode ────────────────────────────
  const enterSelectionMode = useCallback((seed?: ChatMessage) => {
    setSelectionMode(true);
    if (seed) {
      const id = seed.messageId || seed.id;
      setSelectedIds(new Set([id]));
    } else {
      setSelectedIds(new Set());
    }
    mediumHaptic();
  }, []);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelected = useCallback((message: ChatMessage) => {
    const id = message.messageId || message.id;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectedMessages = useMemo(
    () => messages.filter((m) => selectedIds.has(m.messageId || m.id)),
    [messages, selectedIds],
  );

  const handleBulkAction = useCallback(async (action: SelectionAction) => {
    if (!user || selectedMessages.length === 0) return;

    if (action === 'forward') {
      setForwardSource([...selectedMessages]);
      exitSelectionMode();
      return;
    }

    if (action === 'copy') {
      const joined = selectedMessages
        .filter((m) => !!m.content)
        .map((m) => m.content)
        .join('\n');
      await Clipboard.setStringAsync(joined);
      exitSelectionMode();
      return;
    }

    if (action === 'star') {
      const selectedSet = new Set(selectedMessages.map((m) => m.messageId || m.id));
      // Optimistic star — toggle all at once.
      setMessages((prev) =>
        prev.map((m) => {
          const id = m.messageId || m.id;
          if (!selectedSet.has(id)) return m;
          const has = m.starredBy?.includes(user.userId);
          const next = has
            ? (m.starredBy ?? []).filter((u) => u !== user.userId)
            : [...(m.starredBy ?? []), user.userId];
          return { ...m, starredBy: next };
        }),
      );
      for (const m of selectedMessages) {
        await toggleMessageStar(thread.chatId, m.messageId || m.id, user.userId);
      }
      exitSelectionMode();
      return;
    }

    if (action === 'delete') {
      Alert.alert(
        `Delete ${selectedMessages.length} message${selectedMessages.length === 1 ? '' : 's'}`,
        'These messages will be removed for you only.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete for me',
            style: 'destructive',
            onPress: async () => {
              warningHaptic();
              const selectedSet = new Set(selectedMessages.map((m) => m.messageId || m.id));
              setMessages((prev) =>
                prev.map((m) =>
                  selectedSet.has(m.messageId || m.id)
                    ? { ...m, deletedFor: Array.from(new Set([...(m.deletedFor ?? []), user.userId])) }
                    : m,
                ),
              );
              for (const m of selectedMessages) {
                await markMessageDeletedForUser(thread.chatId, m.messageId || m.id, user.userId);
              }
              exitSelectionMode();
            },
          },
        ],
      );
      return;
    }

    if (action === 'deleteForEveryone') {
      Alert.alert(
        `Delete for everyone (${selectedMessages.length})`,
        'These messages will be removed for everyone in the chat.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete for everyone',
            style: 'destructive',
            onPress: async () => {
              warningHaptic();
              const selectedSet = new Set(selectedMessages.map((m) => m.messageId || m.id));
              setMessages((prev) =>
                prev.map((m) =>
                  selectedSet.has(m.messageId || m.id)
                    ? { ...m, deletedForEveryone: true, content: '' }
                    : m,
                ),
              );
              for (const m of selectedMessages) {
                await deleteMessageForEveryone(thread.chatId, m.messageId || m.id);
              }
              exitSelectionMode();
            },
          },
        ],
      );
      return;
    }
  }, [selectedMessages, thread.chatId, user, exitSelectionMode, deleteMessageForEveryone]);

  // ──────────────────────────── Search ────────────────────────────
  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as string[];
    return messages
      .filter((m) => m.content && !m.deletedForEveryone && !m.deletedFor?.includes(user?.userId ?? ''))
      .filter((m) => m.content.toLowerCase().includes(q))
      .map((m) => m.messageId || m.id);
  }, [messages, searchQuery, user?.userId]);

  // Reset index whenever the matches change.
  useEffect(() => {
    setSearchIndex(0);
  }, [searchQuery]);

  const jumpToSearchMatch = useCallback((index: number) => {
    if (searchMatches.length === 0) return;
    const safe = ((index % searchMatches.length) + searchMatches.length) % searchMatches.length;
    setSearchIndex(safe);
    const id = searchMatches[safe];
    const messageIdx = messages.findIndex((m) => (m.messageId || m.id) === id);
    if (messageIdx === -1) return;
    listRef.current?.scrollToIndex({ index: messageIdx, animated: true, viewPosition: 0.5 });
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedMessageId(id);
    highlightTimerRef.current = setTimeout(() => setHighlightedMessageId(null), 1400);
  }, [messages, searchMatches]);

  useEffect(() => {
    if (searchMatches.length > 0 && searchOpen) {
      jumpToSearchMatch(0);
    }
    // We intentionally only respond to changes in the matches array, not jumpToSearchMatch identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchMatches.length, searchOpen]);

  const handleForwardSelect = useCallback(async (targetThreads: ChatThread[]) => {
    if (!forwardSource || forwardSource.length === 0) return;
    const sources = forwardSource;
    setForwardSource(null);

    for (const target of targetThreads) {
      for (const source of sources) {
        const sourceSenderName = thread.participants.find((p) => p.userId === source.senderId)?.displayName;
        const baseHopCount = source.forwardedFrom?.hopCount ?? 0;
        await runSend(async (requestId) => {
          await sendMessage({
            chatId: target.chatId,
            requestId,
            content: source.content,
            type: source.type,
            mediaUri: source.localMediaPath || source.mediaUrl,
            mediaMetadata: source.mediaMetadata,
            groupId: target.groupId,
            location: source.location,
            forwardedFrom: {
              senderName: source.forwardedFrom?.senderName ?? sourceSenderName,
              hopCount: baseHopCount + 1,
            },
          });
        }, { key: `chat-forward-${target.chatId}-${Date.now()}` }).catch((error) => {
          console.error('Forward failed:', error);
        });
      }
    }
    successHaptic();
  }, [forwardSource, runSend, sendMessage, thread.participants]);

  const handleReplyPress = useCallback((messageId: string) => {
    const index = messages.findIndex(
      (m) => (m.messageId || m.id) === messageId
    );
    if (index === -1) return;

    listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });

    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedMessageId(messageId);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedMessageId(null);
    }, 1400);
  }, [messages]);

  const handleMediaSelected = async (media: SelectedMedia | SelectedMedia[]) => {
    // Batch from the gallery picker — skip the per-item preview and send
    // each item sequentially in pick order. Single-item flows (camera,
    // document, audio, location) keep the preview/confirmation step.
    if (Array.isArray(media)) {
      setAttachmentMenuVisible(false);
      await sendBatchMedia(media);
      return;
    }

    if (media.type === 'location') {
      setAttachmentMenuVisible(false);
      setLocationPickerVisible(true);
      return;
    }

    setAttachmentMenuVisible(false);
    setSelectedMedia(media);
    InteractionManager.runAfterInteractions(() => {
      setMediaPreviewVisible(true);
    });
  };

  // Core send pipeline for a single media item — called by both the preview
  // confirm flow and the batch picker. No state mutations here; the callers
  // own their UI state.
  const sendMediaItem = async (
    mediaToSend: SelectedMedia,
    caption: string,
    quality: QualityLevel,
    reply: ChatMessage | null,
    progressMessage?: (msg: string) => void,
  ) => {
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

    let replyData = undefined;
    if (reply) {
      const participant = thread.participants.find((p) => p.userId === reply.senderId);
      replyData = {
        messageId: reply.messageId,
        senderId: reply.senderId,
        senderName: participant?.displayName || 'Unknown',
        content: reply.content,
        type: reply.type,
      };
    }

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

    progressMessage?.(`Uploading ${mediaToSend.type === 'video' ? 'video' : 'attachment'}…`);

    await runSend(async (requestId) => {
      await sendMessage({
        chatId: thread.chatId,
        requestId,
        content: caption || getMediaPlaceholder(messageType),
        type: messageType,
        mediaUri: processedUri,
        groupId: thread.groupId,
        replyTo: replyData,
        mediaMetadata: Object.keys(mediaMetadata).length > 0 ? (mediaMetadata as any) : undefined,
        onStageChange: (stage, details) => {
          if (stage === 'complete') return;
          if (details?.message) progressMessage?.(details.message);
        },
      });
    }, { key: `chat-media-${thread.chatId}-${Date.now()}` });
  };

  // Single-item flow from MediaPreview confirmation.
  const handleSendMedia = async (caption: string, quality: QualityLevel) => {
    if (!selectedMedia) return;
    const mediaToSend = selectedMedia;

    mediaPipelineLoading.start(getProcessingLoadingMessage(mediaToSend.type));
    setMediaPreviewVisible(false);

    try {
      await sendMediaItem(mediaToSend, caption, quality, replyingTo, mediaPipelineLoading.setMessage);
      setSelectedMedia(null);
      setReplyingTo(null);
    } catch (error) {
      console.error('Failed to send media:', error);
      Alert.alert('Send failed', error instanceof Error ? error.message : 'Failed to send media');
    } finally {
      mediaPipelineLoading.stop();
    }
  };

  // Batch flow — fire each item sequentially. Reply context attaches only to
  // the first item; subsequent items are independent. Failures don't block
  // the rest; surface a single summary alert at the end.
  const sendBatchMedia = async (items: SelectedMedia[]) => {
    if (items.length === 0) return;

    mediaPipelineLoading.start(`Sending 1 of ${items.length}…`);
    const initialReply = replyingTo;
    setReplyingTo(null);

    let failures = 0;
    for (let i = 0; i < items.length; i++) {
      mediaPipelineLoading.setMessage(`Sending ${i + 1} of ${items.length}…`);
      try {
        await sendMediaItem(
          items[i],
          '',
          'HD',
          i === 0 ? initialReply : null,
          mediaPipelineLoading.setMessage,
        );
      } catch (error) {
        failures++;
        console.error(`Batch item ${i + 1}/${items.length} failed:`, error);
      }
    }
    mediaPipelineLoading.stop();

    if (failures > 0) {
      Alert.alert(
        'Some items failed to send',
        `${failures} of ${items.length} item${failures === 1 ? '' : 's'} couldn't be sent. They're queued — retry from the failed bubbles.`,
      );
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

  // Pre-compute participant lookup so renderItem doesn't do O(n) find per bubble
  const participantMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of thread.participants) {
      map.set(p.userId, p.displayName || 'Unknown');
    }
    return map;
  }, [thread.participants]);

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
  titleRef.current = title;

  const handleHeaderPress = () => {
    lightHaptic();
    if (thread.type === 'group' && thread.groupId) {
      // @ts-ignore - navigation types
      navigation.navigate(ROUTES.APP.GROUP_INFO, { groupId: thread.groupId, initialTitle: 'Group Info', backTitle: title });
      return;
    }
    if (thread.type === 'direct' && directParticipant?.userId) {
      // @ts-ignore - navigation types
      navigation.navigate(ROUTES.APP.FRIEND_INFO, {
        userId: directParticipant.userId,
        displayName: directParticipant.displayName,
        photoURL: directParticipant.photoURL,
        backTitle: title,
      });
    }
  };

  // Get initials for avatar — works for both group chats (group name) and
  // direct chats (the other participant's display name).
  const groupInitials = useMemo(() => {
    if (thread.type === 'group' && groupName) {
      return groupName.slice(0, 2).toUpperCase();
    }
    if (thread.type === 'direct' && directParticipant?.displayName) {
      return directParticipant.displayName.slice(0, 2).toUpperCase();
    }
    return 'SC';
  }, [thread.type, groupName, directParticipant?.displayName]);

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

  const totalRecipients = thread.participants.length - 1;
  const isGroupChat = thread.type === 'group';

  const dimmedMessageId = useMemo(() => {
    if (!actionTarget) return null;
    return actionTarget.messageId || actionTarget.id;
  }, [actionTarget]);

  // ──────────────────────────── Mentions ────────────────────────────
  // Build a userId → display-name map (no spaces) for mention rendering.
  const mentionLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of thread.participants) {
      if (p.userId === user?.userId) continue;
      map.set(p.userId, p.displayName || 'user');
    }
    return map;
  }, [thread.participants, user?.userId]);

  // Full participant name map including the current user — used by ReactionDetailsSheet.
  const allParticipantNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of thread.participants) {
      map.set(p.userId, p.displayName || 'User');
    }
    return map;
  }, [thread.participants]);

  const handleComposerSelectionChange = useCallback((event: { nativeEvent: { selection: { start: number; end: number } } }) => {
    composerSelectionRef.current = event.nativeEvent.selection;
  }, []);

  const handleComposerTextChange = useCallback((next: string) => {
    setText(next);

    // Detect a partial @mention immediately to the left of the caret.
    const caret = composerSelectionRef.current.start ?? next.length;
    const upToCaret = next.slice(0, caret);
    const atIdx = upToCaret.lastIndexOf('@');
    if (atIdx === -1) {
      setMentionQuery(null);
      setMentionAnchor(null);
      return;
    }
    const before = atIdx === 0 ? '' : upToCaret[atIdx - 1];
    const isWordBoundary = atIdx === 0 || /\s/.test(before);
    if (!isWordBoundary) {
      setMentionQuery(null);
      setMentionAnchor(null);
      return;
    }
    const candidate = upToCaret.slice(atIdx + 1);
    if (/[\s\n]/.test(candidate)) {
      setMentionQuery(null);
      setMentionAnchor(null);
      return;
    }
    setMentionQuery(candidate);
    setMentionAnchor({ start: atIdx, end: caret });

    // Throttled typing ping.
    void maybePingTyping();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.chatId]);

  const handleMentionSelect = useCallback((participant: ChatParticipant) => {
    if (!mentionAnchor) return;
    const handle = participant.displayName.replace(/\s+/g, '');
    const before = text.slice(0, mentionAnchor.start);
    const after = text.slice(mentionAnchor.end);
    const insertion = `@${handle} `;
    const next = `${before}${insertion}${after}`;
    setText(next);
    setMentionAnchor(null);
    setMentionQuery(null);
    setPendingMentionUserIds((prev) => Array.from(new Set([...prev, participant.userId])));
    // Move caret past the inserted handle on next render.
    setTimeout(() => {
      const newCaret = (before + insertion).length;
      inputRef.current?.setNativeProps?.({
        selection: { start: newCaret, end: newCaret },
      });
    }, 0);
  }, [mentionAnchor, text]);

  // ──────────────────────────── Typing presence ────────────────────────────
  const maybePingTyping = useCallback(async () => {
    const now = Date.now();
    if (now - lastTypingPingRef.current < TYPING_PING_THROTTLE_MS) return;
    lastTypingPingRef.current = now;
    try {
      await setTyping(thread.chatId, true);
    } catch {
      // Best-effort
    }
    if (typingClearTimerRef.current) clearTimeout(typingClearTimerRef.current);
    typingClearTimerRef.current = setTimeout(() => {
      void setTyping(thread.chatId, false);
      lastTypingPingRef.current = 0;
    }, TYPING_STALE_MS);
  }, [setTyping, thread.chatId]);

  useEffect(() => {
    return () => {
      if (typingClearTimerRef.current) clearTimeout(typingClearTimerRef.current);
      // Clear typing presence on screen unmount so we don't leave a ghost ping.
      void setTyping(thread.chatId, false);
    };
  }, [setTyping, thread.chatId]);

  // Other participants who are currently typing (non-stale).
  const typingNames = useMemo(() => {
    if (!thread.typing) return [] as string[];
    const now = Date.now();
    const ids = Object.entries(thread.typing)
      .filter(([userId, ts]) => userId !== user?.userId && now - (ts ?? 0) < TYPING_STALE_MS)
      .map(([userId]) => userId);
    return ids.map((id) => participantMap.get(id) ?? 'Someone');
  }, [thread.typing, user?.userId, participantMap]);

  // ──────────────────────────── Pinned messages ────────────────────────────
  const handlePinnedTap = useCallback((ref: PinnedMessageRef) => {
    const idx = messages.findIndex((m) => (m.messageId || m.id) === ref.messageId);
    if (idx === -1) return;
    listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 });
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedMessageId(ref.messageId);
    highlightTimerRef.current = setTimeout(() => setHighlightedMessageId(null), 1400);
  }, [messages]);

  const pinnedSet = useMemo(
    () => new Set(thread.pinnedMessages?.map((p) => p.messageId) ?? []),
    [thread.pinnedMessages],
  );

  const handleMentionPress = useCallback((userId: string) => {
    const participant = thread.participants.find((p) => p.userId === userId);
    if (!participant) return;
    if (thread.type === 'direct') return;
    lightHaptic();
    // @ts-ignore — navigation typing
    navigation.navigate(ROUTES.APP.FRIEND_INFO, {
      userId: participant.userId,
      displayName: participant.displayName,
      photoURL: participant.photoURL,
      backTitle: title,
    });
  }, [navigation, thread.participants, thread.type]);

  const renderItem = useCallback(({ item, index }: { item: ChatMessage; index: number }) => {
    const prevMessage = messages[index + 1]; // inverted list
    const isFirstInSequence = !prevMessage || prevMessage.senderId !== item.senderId || prevMessage.type === 'system';
    const senderName = participantMap.get(item.senderId) ?? 'Unknown';
    const itemId = item.messageId || item.id;
    return (
      <MessageBubble
        message={item}
        showSenderInfo={isGroupChat ? isFirstInSequence : undefined}
        senderName={senderName}
        onSwipeReply={selectionMode ? undefined : handleSwipeReply}
        onSwipeInfo={isGroupChat && !selectionMode ? handleSwipeInfo : undefined}
        onReplyPress={handleReplyPress}
        onMediaPress={selectionMode ? undefined : handleMediaPress}
        onLongPress={selectionMode ? undefined : handleLongPressMessage}
        onReactionsPress={handleReactionsPress}
        onFilePress={selectionMode ? undefined : handleFilePress}
        onDoubleTap={selectionMode ? undefined : handleDoubleTap}
        onMentionPress={handleMentionPress}
        selectionMode={selectionMode}
        selected={selectedIds.has(itemId)}
        onToggleSelect={toggleSelected}
        searchQuery={searchOpen ? searchQuery : undefined}
        mentionLabels={mentionLabels}
        isGroupChat={isGroupChat}
        totalRecipients={totalRecipients}
        highlighted={highlightedMessageId === itemId}
        dimmed={!!dimmedMessageId && dimmedMessageId !== itemId}
      />
    );
  }, [
    messages,
    participantMap,
    isGroupChat,
    handleSwipeReply,
    handleSwipeInfo,
    handleReplyPress,
    handleMediaPress,
    handleLongPressMessage,
    handleReactionsPress,
    handleFilePress,
    handleDoubleTap,
    handleMentionPress,
    selectionMode,
    selectedIds,
    toggleSelected,
    searchOpen,
    searchQuery,
    mentionLabels,
    totalRecipients,
    highlightedMessageId,
    dimmedMessageId,
  ]);

  return (
    <LiquidBackground>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      // smaller offset so composer hugs the keyboard more closely
      //keyboardVerticalOffset={Platform.OS === 'ios' ? 50 : 0}
      >
        <View style={[styles.headerContainer, { paddingTop: insets.top + 6 }]}>
          <View style={styles.headerRow}>
            <TouchableOpacity
              onPress={() => navigation.goBack()}
              activeOpacity={0.7}
              style={styles.headerBackButton}
              accessibilityLabel="Go back"
              accessibilityRole="button"
              hitSlop={8}
            >
              <GlassView style={styles.headerBackButtonGlass} intensity={40}>
                <Icon source="chevron-left" size={26} color={theme.colors.primary} />
              </GlassView>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleHeaderPress}
              activeOpacity={0.7}
              style={styles.headerPillTouchable}
            >
              <GlassView style={styles.headerPill} intensity={40}>
                <View style={styles.headerPillContent}>
                  {thread.type === 'direct' && directParticipant?.photoURL ? (
                    <Avatar.Image
                      size={36}
                      source={{ uri: directParticipant.photoURL }}
                      style={{ marginRight: 10 }}
                    />
                  ) : (
                    <Avatar.Text
                      size={36}
                      label={groupInitials}
                      style={{ backgroundColor: theme.colors.primary, marginRight: 10 }}
                      color={theme.colors.onPrimary}
                    />
                  )}
                  <View style={{ flexShrink: 1 }}>
                    <Text
                      variant="titleMedium"
                      style={[styles.headerTitle, { color: theme.colors.onSurface }]}
                      numberOfLines={1}
                    >
                      {title}
                    </Text>
                    {typingNames.length > 0 && (
                      <Text
                        style={[styles.headerTypingText, { color: theme.colors.primary }]}
                        numberOfLines={1}
                      >
                        {typingNames.length === 1
                          ? `${typingNames[0]} is typing…`
                          : typingNames.length === 2
                            ? `${typingNames[0]} and ${typingNames[1]} are typing…`
                            : `${typingNames[0]} and ${typingNames.length - 1} others are typing…`}
                      </Text>
                    )}
                  </View>
                </View>
              </GlassView>
            </TouchableOpacity>
            <View style={styles.headerCallActions}>
              <TouchableOpacity onPress={placeAudioCall} style={styles.headerCallButton} activeOpacity={0.7} accessibilityLabel="Audio call">
                <GlassView style={styles.headerCallButtonGlass} intensity={40}>
                  <Icon source="phone" size={18} color={theme.colors.primary} />
                </GlassView>
              </TouchableOpacity>
              <TouchableOpacity onPress={placeVideoCall} style={styles.headerCallButton} activeOpacity={0.7} accessibilityLabel="Video call">
                <GlassView style={styles.headerCallButtonGlass} intensity={40}>
                  <Icon source="video" size={18} color={theme.colors.primary} />
                </GlassView>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  lightHaptic();
                  setHeaderMenuOpen(true);
                }}
                style={styles.headerCallButton}
                activeOpacity={0.7}
                accessibilityLabel="More options"
              >
                <GlassView style={styles.headerCallButtonGlass} intensity={40}>
                  <Icon source="dots-vertical" size={18} color={theme.colors.primary} />
                </GlassView>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        <Animated.FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.messageId || item.id || `${item.createdAt}_${item.senderId}`}
          renderItem={renderItem}
          style={styles.list}
          contentContainerStyle={[
            styles.listContent,
            // Inverted FlatList: contentContainer paddingBottom lands at the
            // VISUAL TOP after the scaleY(-1) flip. Reserve space equal to the
            // expanded floating-header height so the oldest message can scroll
            // fully clear of the glass overlay; in normal scroll the messages
            // pass UNDER the header by design.
            { paddingBottom: insets.top + 70 },
            messages.length === 0 && { flex: 1, justifyContent: 'center' },
          ]}
          inverted={messages.length > 0}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', justifyContent: 'center', padding: 20 }}>
              <Text style={{ color: theme.colors.secondary }}>No messages yet</Text>
              <Text style={{ color: theme.colors.secondary, fontSize: 12 }}>Send a message to start chatting</Text>
            </View>
          }
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            {
              useNativeDriver: true,
              listener: (event: any) => {
                const offsetY = event.nativeEvent.contentOffset.y;
                setShowScrollDown(offsetY > 120);
              },
            },
          )}
          scrollEventThrottle={16}
          removeClippedSubviews={Platform.OS === 'android'}
          maxToRenderPerBatch={10}
          windowSize={10}
          initialNumToRender={15}
          onScrollToIndexFailed={({ index }) => {
            // Message not yet rendered — scroll to approximate offset then retry
            listRef.current?.scrollToOffset({
              offset: index * 80,
              animated: true,
            });
          }}
        />

        {/* Mention autocomplete — floats just above the composer when active */}
        {isGroupChat && mentionQuery !== null && (
          <MentionAutocomplete
            visible={mentionQuery !== null}
            query={mentionQuery ?? ''}
            participants={thread.participants}
            excludeUserId={user?.userId}
            onSelect={handleMentionSelect}
          />
        )}

        <GlassView style={styles.composerWrapper}>
          {/* Reply preview bar */}
          {replyingTo && !editingMessage && (
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

          {/* Edit preview bar */}
          {editingMessage && (
            <View style={styles.replyPreviewContainer}>
              <View style={[styles.replyPreview, { borderLeftColor: theme.colors.primary }]}>
                <Text style={[styles.replyPreviewSender, { color: theme.colors.primary }]}>
                  Editing message
                </Text>
                <Text numberOfLines={1} style={{ color: theme.colors.onSurfaceVariant, fontSize: 13 }}>
                  {editingMessage.content}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => {
                  setEditingMessage(null);
                  setText('');
                }}
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
                  onChangeText={handleComposerTextChange}
                  onSelectionChange={handleComposerSelectionChange}
                  style={styles.input}
                  contentStyle={styles.inputContent}
                  selectionColor={theme.colors.primary}
                  underlineColor="transparent"
                  activeUnderlineColor="transparent"
                  onFocus={() => setComposerFocused(true)}
                  onBlur={() => {
                    setComposerFocused(false);
                    // Tear down typing presence as soon as the composer loses focus.
                    void setTyping(thread.chatId, false);
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
            </View>
            <TouchableOpacity
              onPress={handleSend}
              disabled={!text.trim() || mediaPipelineLoading.loading}
              activeOpacity={0.8}
              style={[
                styles.sendButtonTouchable,
                {
                  backgroundColor:
                    !text.trim() || mediaPipelineLoading.loading
                      ? (isDark ? '#555' : '#ccc')
                      : theme.colors.primary,
                },
              ]}
              accessibilityLabel="Send message"
              accessibilityState={{
                disabled: !text.trim() || mediaPipelineLoading.loading,
                busy: mediaPipelineLoading.loading,
              }}
            >
              <Icon source="send" size={24} color={theme.colors.onPrimary} />
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
        }}
        onSend={handleSendMedia}
      />

      {/* Location Picker Modal */}
      <LocationPicker
        visible={locationPickerVisible}
        onClose={() => setLocationPickerVisible(false)}
        onSendLocation={handleSendLocation}
      />

      {/* Header overflow menu */}
      <HeaderMenu
        visible={headerMenuOpen}
        topInset={insets.top}
        onClose={() => setHeaderMenuOpen(false)}
        items={[
          {
            key: 'search',
            label: 'Search',
            icon: 'search',
            onPress: () => {
              setSearchOpen(true);
              setSearchQuery('');
            },
          },
          {
            key: 'media',
            label: 'Media, links & docs',
            icon: 'images-outline',
            onPress: () => {
              // @ts-ignore
              navigation.navigate(ROUTES.APP.CHAT_MEDIA_GALLERY, {
                chatId: thread.chatId,
                title: 'Media',
                backTitle: title,
                participants: thread.participants,
              });
            },
          },
          {
            key: 'starred',
            label: 'Starred messages',
            icon: 'star-outline',
            onPress: () => {
              // @ts-ignore
              navigation.navigate(ROUTES.APP.STARRED_MESSAGES, {
                chatId: thread.chatId,
                title: title,
              });
            },
          },
        ] satisfies HeaderMenuItem[]}
      />

      {/* Pinned messages bar — anchored under the header pill, above the message list */}
      {(thread.pinnedMessages?.length ?? 0) > 0 && !searchOpen && !selectionMode && (
        <PinnedMessagesBar
          pinned={thread.pinnedMessages!}
          topInset={insets.top}
          resolveSenderName={(id) => (id ? participantMap.get(id) : undefined)}
          onPress={handlePinnedTap}
        />
      )}

      {/* Search bar — replaces the floating header when open */}
      {searchOpen && (
        <ChatSearchBar
          query={searchQuery}
          onChange={setSearchQuery}
          matchCount={searchMatches.length}
          currentIndex={searchIndex}
          onPrev={() => jumpToSearchMatch(searchIndex - 1)}
          onNext={() => jumpToSearchMatch(searchIndex + 1)}
          onClose={() => {
            setSearchOpen(false);
            setSearchQuery('');
            setSearchIndex(0);
            setHighlightedMessageId(null);
          }}
          topInset={insets.top}
        />
      )}

      {/* Multi-select toolbar — shown above the header when selection mode is active */}
      {selectionMode && (
        <SelectionToolbar
          count={selectedIds.size}
          topInset={insets.top}
          canDeleteForEveryone={
            !!user &&
            selectedMessages.length > 0 &&
            selectedMessages.every(
              (m) =>
                m.senderId === user.userId &&
                Date.now() - m.createdAt < DELETE_FOR_EVERYONE_WINDOW_MS &&
                !m.deletedForEveryone,
            )
          }
          canStar={selectedMessages.length > 0}
          canCopy={selectedMessages.some((m) => !!m.content)}
          onAction={handleBulkAction}
          onClose={exitSelectionMode}
        />
      )}

      {/* Long-press Action Sheet */}
      <MessageActionSheet
        visible={!!actionTarget}
        message={actionTarget}
        isMine={!!actionTarget && actionTarget.senderId === user?.userId}
        isGroupChat={isGroupChat}
        isStarred={!!user && !!actionTarget?.starredBy?.includes(user.userId)}
        isPinned={!!actionTarget && pinnedSet.has(actionTarget.messageId)}
        currentUserReactions={
          user && actionTarget?.reactions
            ? Object.entries(actionTarget.reactions)
                .filter(([, ids]) => ids.includes(user.userId))
                .map(([emoji]) => emoji)
            : undefined
        }
        canEdit={
          !!actionTarget &&
          actionTarget.senderId === user?.userId &&
          actionTarget.type === 'text' &&
          Date.now() - actionTarget.createdAt < EDIT_WINDOW_MS
        }
        canDeleteForEveryone={
          !!actionTarget &&
          actionTarget.senderId === user?.userId &&
          Date.now() - actionTarget.createdAt < DELETE_FOR_EVERYONE_WINDOW_MS &&
          !actionTarget.deletedForEveryone
        }
        onClose={() => setActionTarget(null)}
        onReact={handleReact}
        onAction={async (action) => {
          if (action === 'select' && actionTarget) {
            // Replace the placeholder alert from Phase 1 with real entry into selection mode.
            const seed = actionTarget;
            setActionTarget(null);
            setTimeout(() => enterSelectionMode(seed), 80);
            return;
          }
          await handleAction(action);
        }}
      />

      {/* Forward picker — opens with the source message preselected */}
      <ForwardPickerSheet
        visible={!!forwardSource}
        excludeChatId={thread.chatId}
        onClose={() => setForwardSource(null)}
        onSelect={handleForwardSelect}
      />

      {/* Reaction details sheet */}
      <ReactionDetailsSheet
        visible={!!reactionTarget}
        reactions={reactionTarget?.reactions}
        currentUserId={user?.userId}
        participantNames={allParticipantNames}
        onRemoveReaction={async (emoji) => {
          if (!reactionTarget || !user) return;
          await applyReactionToggle(reactionTarget, emoji);
        }}
        onRemoveAll={async () => {
          if (!reactionTarget || !user) return;
          const targetId = reactionTarget.messageId || reactionTarget.id;
          const next = await removeAllReactionsForUser(thread.chatId, targetId, user.userId);
          if (next !== undefined) {
            void publishMessageState(thread.chatId, targetId, { reactions: next });
          }
        }}
        onClose={() => setReactionTarget(null)}
      />

      {/* Emoji picker sheet — opened from the + button on the reaction strip */}
      <EmojiPickerSheet
        visible={!!emojiPickerTarget}
        selectedEmojis={
          user && emojiPickerTarget?.reactions
            ? Object.entries(emojiPickerTarget.reactions)
                .filter(([, ids]) => ids.includes(user.userId))
                .map(([emoji]) => emoji)
            : undefined
        }
        onPick={handleEmojiPicked}
        onClose={() => setEmojiPickerTarget(null)}
      />

      {/* Media Processing Overlay — driven by keyed loading state */}
      <LoadingOverlay visible={mediaPipelineLoading.loading} message={mediaPipelineLoading.message ?? 'Processing media…'} />

      {/* Scroll-to-bottom FAB */}
      {showScrollDown && (
        <TouchableOpacity
          style={[styles.scrollDownButton, { backgroundColor: theme.colors.primary }]}
          onPress={() => listRef.current?.scrollToOffset({ offset: 0, animated: true })}
          activeOpacity={0.8}
          accessibilityLabel="Scroll to latest message"
        >
          <Icon source="chevron-down" size={22} color={theme.colors.onPrimary} />
        </TouchableOpacity>
      )}

    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: -4,
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: 16,
    gap: 8,
    paddingBottom: 10,
    paddingTop: 24,
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
  headerContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 12,
    paddingBottom: 12,
    zIndex: 100,
    elevation: 10,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerBackButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    overflow: 'hidden',
  },
  headerBackButtonGlass: {
    flex: 1,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerPillTouchable: {
    flex: 1,
    minWidth: 0,
  },
  headerPill: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    paddingRight: 14,
    borderRadius: 50,
  },
  headerPillContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  headerTitle: {
    fontWeight: '700',
    fontSize: 16,
    flexShrink: 1,
  },
  headerTypingText: {
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 1,
  },
  headerCallActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerCallButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    overflow: 'hidden',
  },
  headerCallButtonGlass: {
    flex: 1,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
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
  scrollDownButton: {
    position: 'absolute',
    right: 16,
    bottom: 90,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
});

export default ChatRoomScreen;
