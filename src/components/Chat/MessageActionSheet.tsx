import { useTheme } from '@/context/ThemeContext';
import type { ChatMessage } from '@/models';
import { formatRelativeTime } from '@/utils/format';
import { lightHaptic, mediumHaptic } from '@/utils/haptics';
import { useVideoThumbnail } from '@/utils/videoThumbnail';
import Ionicons from '@expo/vector-icons/Ionicons';
import { BlurView } from 'expo-blur';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Image,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { Text } from 'react-native-paper';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export type MessageAction =
  | 'reply'
  | 'copy'
  | 'forward'
  | 'star'
  | 'unstar'
  | 'pin'
  | 'unpin'
  | 'edit'
  | 'delete'
  | 'deleteForEveryone'
  | 'info'
  | 'select';

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

interface MessageActionSheetProps {
  visible: boolean;
  message: ChatMessage | null;
  isMine: boolean;
  isGroupChat: boolean;
  isStarred: boolean;
  isPinned: boolean;
  currentUserReactions?: string[];
  canEdit: boolean;
  canDeleteForEveryone: boolean;
  onClose: () => void;
  onReact: (emoji: string) => void;
  onAction: (action: MessageAction) => void;
}

const AVATAR_COLORS = [
  '#E57373', '#F06292', '#BA68C8', '#9575CD', '#7986CB',
  '#64B5F6', '#4FC3F7', '#4DD0E1', '#4DB6AC', '#81C784',
  '#AED581', '#FF8A65', '#D4E157', '#FFD54F', '#FFB74D',
];

const getSenderColor = (id: string) => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

const getMediaIcon = (type?: string): keyof typeof Ionicons.glyphMap => {
  switch (type) {
    case 'image': return 'image';
    case 'video': return 'videocam';
    case 'audio': return 'musical-notes';
    case 'file': return 'document';
    case 'location': return 'location';
    default: return 'chatbubble';
  }
};

export const MessagePreviewBubble = React.memo(({ message, isMine, theme, isDark }: {
  message: ChatMessage;
  isMine: boolean;
  theme: any;
  isDark: boolean;
}) => {
  const bubbleBg = isMine
    ? theme.colors.primary
    : isDark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.85)';
  const textColor = isMine ? theme.colors.onPrimary : theme.colors.onSurface;
  const metaColor = isMine ? 'rgba(255,255,255,0.7)' : theme.colors.onSurfaceVariant;

  const hasAnyRead = (message.readBy?.length ?? 0) > 0 || message.status === 'read';
  const hasAnyDelivered = hasAnyRead || (message.deliveredTo?.length ?? 0) > 0 || message.status === 'delivered';
  const tickColor = hasAnyRead ? '#35C6FF' : 'rgba(255,255,255,0.7)';

  const isVideo = message.type === 'video';
  const videoUri = isVideo ? (message.localMediaPath || message.mediaUrl) : undefined;
  const videoThumb = useVideoThumbnail(videoUri);
  const displayUri = isVideo ? videoThumb : (message.localMediaPath || message.mediaUrl);
  const hasMedia = (message.type === 'image' || message.type === 'video') && !!displayUri;

  const caption = message.content || '';
  let previewText = caption;
  if (!previewText && !hasMedia) {
    if (message.type === 'image') previewText = '📷 Photo';
    else if (message.type === 'video') previewText = '🎥 Video';
    else if (message.type === 'audio') previewText = '🎵 Audio';
    else if (message.type === 'file') previewText = '📄 Document';
    else if (message.type === 'location') previewText = '📍 Location';
  }

  if (previewText.length > 120) previewText = previewText.slice(0, 117) + '…';

  return (
    <View style={[
      previewStyles.bubble,
      { backgroundColor: bubbleBg },
      isMine ? previewStyles.bubbleMine : previewStyles.bubbleOther,
      hasMedia && previewStyles.mediaBubble,
    ]}>
      {/* Reply bar */}
      {!!message.replyTo && (
        <View style={[previewStyles.replyBar, {
          borderLeftColor: getSenderColor(message.replyTo.senderId),
          backgroundColor: isMine ? 'rgba(0,0,0,0.15)' : (isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)'),
        }]}>
          <Text
            numberOfLines={1}
            style={[previewStyles.replySender, {
              color: isMine ? 'rgba(255,255,255,0.9)' : getSenderColor(message.replyTo.senderId),
            }]}
          >
            {message.replyTo.senderName}
          </Text>
          <View style={previewStyles.replyContentRow}>
            {message.replyTo.type && message.replyTo.type !== 'text' && (
              <Ionicons
                name={getMediaIcon(message.replyTo.type)}
                size={12}
                color={isMine ? 'rgba(255,255,255,0.7)' : theme.colors.onSurfaceVariant}
                style={{ marginRight: 3 }}
              />
            )}
            <Text
              numberOfLines={1}
              style={[previewStyles.replyText, {
                color: isMine ? 'rgba(255,255,255,0.8)' : theme.colors.onSurfaceVariant,
              }]}
            >
              {message.replyTo.content}
            </Text>
          </View>
        </View>
      )}

      {/* Media thumbnail */}
      {hasMedia && (
        <View style={previewStyles.thumbnailWrap}>
          <Image source={{ uri: displayUri }} style={previewStyles.thumbnail} resizeMode="cover" />
          {message.type === 'video' && (
            <View style={previewStyles.playBadge}>
              <View style={previewStyles.playIcon}>
                <Ionicons name="play" size={12} color="#fff" style={{ marginLeft: 1 }} />
              </View>
            </View>
          )}
        </View>
      )}

      {/* Caption text — only real content, not fallback labels when thumbnail is shown */}
      {!!previewText && (
        <Text style={[previewStyles.content, hasMedia && previewStyles.captionText, { color: textColor }]} numberOfLines={hasMedia ? 2 : 4}>
          {previewText}
        </Text>
      )}

      <View style={previewStyles.meta}>
        {!!message.editedAt && (
          <Text style={[previewStyles.edited, { color: metaColor }]}>edited</Text>
        )}
        <Text style={[previewStyles.time, { color: metaColor }]}>
          {formatRelativeTime(message.createdAt)}
        </Text>
        {isMine && message.status !== 'sending' && message.status !== 'failed' && (
          hasAnyDelivered ? (
            <View style={previewStyles.doubleTick}>
              <Ionicons name="checkmark" size={12} color={tickColor} style={{ marginRight: -6 }} />
              <Ionicons name="checkmark" size={12} color={tickColor} />
            </View>
          ) : (
            <Ionicons name="checkmark" size={12} color="rgba(255,255,255,0.7)" />
          )
        )}
        {isMine && message.status === 'sending' && (
          <Ionicons name="time-outline" size={12} color={metaColor} />
        )}
      </View>
    </View>
  );
});

const previewStyles = StyleSheet.create({
  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    maxWidth: '75%',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  mediaBubble: {
    padding: 4,
    paddingBottom: 6,
  },
  bubbleMine: { alignSelf: 'flex-end', borderBottomRightRadius: 6 },
  bubbleOther: { alignSelf: 'flex-start', borderBottomLeftRadius: 6 },
  replyBar: {
    borderLeftWidth: 3,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    marginBottom: 4,
  },
  replySender: { fontSize: 12, fontWeight: '600', marginBottom: 1 },
  replyContentRow: { flexDirection: 'row', alignItems: 'center' },
  replyText: { fontSize: 13, flex: 1 },
  thumbnailWrap: {
    borderRadius: 14,
    overflow: 'hidden',
    aspectRatio: 1.3,
    maxHeight: 120,
  },
  thumbnail: {
    width: '100%',
    height: '100%',
  },
  playBadge: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: { fontSize: 16, lineHeight: 21 },
  captionText: { fontSize: 14, lineHeight: 18, paddingHorizontal: 10, marginTop: 4 },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
    marginTop: 2,
    paddingHorizontal: 6,
  },
  edited: { fontSize: 10, fontStyle: 'italic', marginRight: 2 },
  time: { fontSize: 11 },
  doubleTick: { flexDirection: 'row', alignItems: 'center' },
});

export const MessageActionSheet = ({
  visible,
  message,
  isMine,
  isGroupChat,
  isStarred,
  isPinned,
  currentUserReactions,
  canEdit,
  canDeleteForEveryone,
  onClose,
  onReact,
  onAction,
}: MessageActionSheetProps) => {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();

  const fade = useSharedValue(0);
  const scale = useSharedValue(0.92);

  useEffect(() => {
    if (visible) {
      fade.value = withTiming(1, { duration: 280, easing: Easing.out(Easing.quad) });
      scale.value = withSpring(1, { damping: 18, stiffness: 180, mass: 0.9 });
    } else {
      fade.value = withTiming(0, { duration: 200, easing: Easing.in(Easing.quad) });
      scale.value = withTiming(0.92, { duration: 200 });
    }
  }, [visible, fade, scale]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: fade.value }));
  const contentStyle = useAnimatedStyle(() => ({
    opacity: fade.value,
    transform: [{ scale: scale.value }],
  }));

  const [hoveredAction, setHoveredAction] = useState<number | null>(null);
  const hoveredActionRef = useRef<number | null>(null);
  const actionCardHeightRef = useRef(0);

  const updateActionHover = useCallback((idx: number | null) => {
    if (hoveredActionRef.current !== idx) {
      hoveredActionRef.current = idx;
      setHoveredAction(idx);
      if (idx !== null) lightHaptic();
    }
  }, []);

  if (!message) return null;

  const handleClose = () => {
    fade.value = withTiming(0, { duration: 200, easing: Easing.in(Easing.quad) }, (finished) => {
      if (finished) runOnJS(onClose)();
    });
    scale.value = withTiming(0.92, { duration: 200 });
  };

  const handleReact = (emoji: string) => {
    mediumHaptic();
    onReact(emoji);
    handleClose();
  };

  const handleAction = (action: MessageAction) => {
    lightHaptic();
    onAction(action);
    handleClose();
  };

  const cardBg = isDark ? 'rgba(45,45,48,0.88)' : 'rgba(255,255,255,0.82)';
  const divider = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';

  const items: Array<{
    key: MessageAction;
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    destructive?: boolean;
    show: boolean;
  }> = [
    { key: 'reply', icon: 'arrow-undo', label: 'Reply', show: true },
    { key: 'forward', icon: 'arrow-redo', label: 'Forward', show: true },
    { key: 'copy', icon: 'copy-outline', label: 'Copy', show: message.type === 'text' || !!message.content },
    { key: 'info', icon: 'information-circle-outline', label: 'Info', show: isMine && isGroupChat },
    {
      key: isStarred ? 'unstar' : 'star',
      icon: isStarred ? 'star' : 'star-outline',
      label: isStarred ? 'Unstar' : 'Star',
      show: true,
    },
    { key: 'edit', icon: 'create-outline', label: 'Edit', show: canEdit },
    {
      key: isPinned ? 'unpin' : 'pin',
      icon: isPinned ? 'pin' : 'pin-outline',
      label: isPinned ? 'Unpin' : 'Pin',
      show: true,
    },
    {
      key: 'deleteForEveryone',
      icon: 'trash-bin-outline',
      label: 'Delete for everyone',
      destructive: true,
      show: canDeleteForEveryone,
    },
    { key: 'delete', icon: 'trash-outline', label: 'Delete', destructive: true, show: true },
    { key: 'select', icon: 'ellipsis-horizontal', label: 'More...', show: true },
  ];

  const visibleItems = items.filter((i) => i.show);

  const getActionIndex = (locationY: number): number | null => {
    if (actionCardHeightRef.current <= 0) return null;
    const itemH = actionCardHeightRef.current / visibleItems.length;
    const idx = Math.floor(locationY / itemH);
    return idx >= 0 && idx < visibleItems.length ? idx : null;
  };

  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      animationType="none"
      onRequestClose={handleClose}
    >
      <View style={styles.root}>
        {/* Blur visual layer */}
        <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]} pointerEvents="none">
          <BlurView
            intensity={60}
            tint={isDark ? 'dark' : 'default'}
            style={StyleSheet.absoluteFill}
          />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: isDark ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.08)' }]} />
        </Animated.View>

        {/* Dismiss layer — receives taps that pass through content */}
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />

        {/* Content: reactions → bubble → actions (passes through empty-area taps) */}
        <Animated.View
          style={[styles.contentWrap, contentStyle, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20 }]}
          pointerEvents="box-none"
        >
          <View style={styles.scrollContent} pointerEvents="box-none">
            {/* Reaction strip */}
            <View style={[styles.reactionRow, { backgroundColor: cardBg }]}>
              {QUICK_REACTIONS.map((emoji) => {
                const active = currentUserReactions?.includes(emoji) ?? false;
                return (
                  <TouchableOpacity
                    key={emoji}
                    onPress={() => handleReact(emoji)}
                    style={[
                      styles.reactionButton,
                      active && {
                        backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.1)',
                        borderWidth: 1.5,
                        borderColor: theme.colors.primary,
                      },
                    ]}
                    activeOpacity={0.7}
                    hitSlop={4}
                  >
                    <Text style={styles.reactionEmoji}>{emoji}</Text>
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                onPress={() => handleReact('+')}
                style={[styles.reactionButton, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}
                activeOpacity={0.7}
              >
                <Ionicons name="add" size={20} color={isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)'} />
              </TouchableOpacity>
            </View>

            {/* Floating message bubble */}
            <View style={styles.bubbleContainer}>
              <MessagePreviewBubble
                message={message}
                isMine={isMine}
                theme={theme}
                isDark={isDark}
              />
            </View>

            {/* Action list — supports slide-to-select */}
            <View
              style={[styles.actionCard, { backgroundColor: cardBg }]}
              onLayout={(e) => {
                actionCardHeightRef.current = e.nativeEvent.layout.height;
              }}
              onStartShouldSetResponder={() => false}
              onMoveShouldSetResponder={() => true}
              onResponderGrant={(e) => {
                updateActionHover(getActionIndex(e.nativeEvent.locationY));
              }}
              onResponderMove={(e) => {
                updateActionHover(getActionIndex(e.nativeEvent.locationY));
              }}
              onResponderRelease={() => {
                if (hoveredActionRef.current !== null) {
                  handleAction(visibleItems[hoveredActionRef.current].key);
                }
                hoveredActionRef.current = null;
                setHoveredAction(null);
              }}
              onResponderTerminate={() => {
                hoveredActionRef.current = null;
                setHoveredAction(null);
              }}
            >
              <BlurView
                intensity={isDark ? 30 : 50}
                tint={isDark ? 'dark' : 'light'}
                style={StyleSheet.absoluteFill}
              />
              {visibleItems.map((item, idx) => (
                <TouchableOpacity
                  key={item.key}
                  style={[
                    styles.actionRow,
                    hoveredAction === idx && {
                      backgroundColor: item.destructive
                        ? (isDark ? 'rgba(255,80,80,0.2)' : 'rgba(255,0,0,0.08)')
                        : (isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.08)'),
                    },
                    idx < visibleItems.length - 1 && { borderBottomColor: divider, borderBottomWidth: StyleSheet.hairlineWidth },
                  ]}
                  onPress={() => handleAction(item.key)}
                  activeOpacity={0.55}
                >
                  <Text
                    style={[
                      styles.actionLabel,
                      { color: item.destructive ? theme.colors.error : theme.colors.onSurface },
                    ]}
                  >
                    {item.label}
                  </Text>
                  <Ionicons
                    name={item.icon}
                    size={20}
                    color={item.destructive ? theme.colors.error : (isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.35)')}
                  />
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  contentWrap: {
    flex: 1,
    paddingHorizontal: 20,
    justifyContent: 'center',
  },
  scrollContent: {
    flex: 1,
    justifyContent: 'center',
    gap: 12,
  },
  reactionRow: {
    flexDirection: 'row',
    alignSelf: 'center',
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderRadius: 28,
    gap: 2,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  reactionButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reactionEmoji: {
    fontSize: 22,
    lineHeight: Platform.OS === 'android' ? 28 : 26,
  },
  bubbleContainer: {
    paddingHorizontal: 4,
  },
  actionCard: {
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 13,
  },
  actionLabel: {
    fontSize: 16,
    fontWeight: '400',
  },
});

export default MessageActionSheet;
