import { MessageStatusIndicator } from '@/components/Chat/MessageStatusIndicator';
import { GlassCard } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import type { ChatMessage } from '@/models';
import { formatRelativeTime } from '@/utils/format';
import { errorHaptic, lightHaptic, mediumHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { BlurView } from 'expo-blur';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
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

const MessagePreviewBubble = React.memo(({ message, isMine, theme, isDark }: {
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

  let previewText = message.content || '';
  if (message.type === 'image') previewText = previewText || '📷 Photo';
  else if (message.type === 'video') previewText = previewText || '🎥 Video';
  else if (message.type === 'audio') previewText = previewText || '🎵 Audio';
  else if (message.type === 'file') previewText = previewText || '📄 Document';
  else if (message.type === 'location') previewText = previewText || '📍 Location';

  if (previewText.length > 120) previewText = previewText.slice(0, 117) + '…';

  return (
    <View style={[
      previewStyles.bubble,
      { backgroundColor: bubbleBg },
      isMine ? previewStyles.bubbleMine : previewStyles.bubbleOther,
    ]}>
      <Text style={[previewStyles.content, { color: textColor }]} numberOfLines={4}>
        {previewText}
      </Text>
      <View style={previewStyles.meta}>
        <Text style={[previewStyles.time, { color: metaColor }]}>
          {formatRelativeTime(message.createdAt)}
        </Text>
        {/* Shared with MessageBubble and AlbumBubble (doc 35). This was a THIRD
            hand-rolled copy, and the worst of them: 'failed' rendered no mark at
            all (the sheet for a message that never sent looked identical to one
            in flight), while 'undecryptable' fell into the first branch and drew
            a confident delivered tick. */}
        {isMine && (
          <MessageStatusIndicator
            status={message.status}
            deliveredCount={message.deliveredTo?.length || 0}
            readCount={message.readBy?.length || 0}
          />
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
    maxWidth: '80%',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  bubbleMine: { alignSelf: 'flex-end', borderBottomRightRadius: 6 },
  bubbleOther: { alignSelf: 'flex-start', borderBottomLeftRadius: 6 },
  content: { fontSize: 16, lineHeight: 21 },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
    marginTop: 2,
  },
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
      fade.value = withTiming(1, { duration: 180, easing: Easing.out(Easing.quad) });
      scale.value = withSpring(1, { damping: 22, stiffness: 320, mass: 0.8 });
    } else {
      fade.value = withTiming(0, { duration: 120, easing: Easing.in(Easing.quad) });
      scale.value = withTiming(0.92, { duration: 120 });
    }
  }, [visible, fade, scale]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: fade.value }));
  // Transform-only — an ancestor's fractional opacity kills the native iOS 26
  // glass material on the GlassCards below (DESIGN.md's native-material kill
  // list). The backdrop above already fades independently on the same `fade`
  // value, so dropping opacity here doesn't change how the reveal reads.
  const contentStyle = useAnimatedStyle(() => ({
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
    fade.value = withTiming(0, { duration: 120, easing: Easing.in(Easing.quad) }, (finished) => {
      if (finished) runOnJS(onClose)();
    });
    scale.value = withTiming(0.92, { duration: 120 });
  };

  const handleReact = (emoji: string) => {
    mediumHaptic();
    onReact(emoji);
    handleClose();
  };

  const handleAction = (action: MessageAction) => {
    if (action === 'delete' || action === 'deleteForEveryone') {
      errorHaptic();
    } else {
      lightHaptic();
    }
    onAction(action);
    handleClose();
  };

  const divider = isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.18)';

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
            <View style={styles.reactionRowWrap}>
              <GlassCard style={styles.reactionRowGlass} contentStyle={styles.reactionRowContent}>
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
              </GlassCard>
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
              style={styles.actionCardWrap}
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
              <GlassCard style={styles.actionCardGlass}>
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
              </GlassCard>
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
  reactionRowWrap: {
    alignSelf: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  reactionRowGlass: {
    borderRadius: 28,
  },
  reactionRowContent: {
    flexDirection: 'row',
    paddingHorizontal: 6,
    paddingVertical: 6,
    gap: 2,
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
  actionCardWrap: {
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  actionCardGlass: {
    borderRadius: 14,
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
