import { useTheme } from '@/context/ThemeContext';
import type { ChatMessage } from '@/models';
import { lightHaptic, mediumHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect } from 'react';
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
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

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
  currentUserReaction?: string;
  /** Whether the message is editable — only own text messages within an edit window. */
  canEdit: boolean;
  /** Whether the message can be deleted for everyone (own message within window). */
  canDeleteForEveryone: boolean;
  onClose: () => void;
  onReact: (emoji: string) => void;
  onAction: (action: MessageAction) => void;
}

export const MessageActionSheet = ({
  visible,
  message,
  isMine,
  isGroupChat,
  isStarred,
  isPinned,
  currentUserReaction,
  canEdit,
  canDeleteForEveryone,
  onClose,
  onReact,
  onAction,
}: MessageActionSheetProps) => {
  const { theme, isDark } = useTheme();

  const slide = useSharedValue(40);
  const fade = useSharedValue(0);
  const reactionScale = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      fade.value = withTiming(1, { duration: 180, easing: Easing.out(Easing.quad) });
      slide.value = withSpring(0, { damping: 22, stiffness: 220 });
      reactionScale.value = withDelay(
        80,
        withSpring(1, { damping: 14, stiffness: 200 }),
      );
    } else {
      reactionScale.value = withTiming(0, { duration: 120 });
      slide.value = withTiming(40, { duration: 160 });
      fade.value = withTiming(0, { duration: 160 });
    }
  }, [visible, fade, slide, reactionScale]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: fade.value }));
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: slide.value }],
    opacity: fade.value,
  }));
  const reactionStripStyle = useAnimatedStyle(() => ({
    transform: [{ scale: reactionScale.value }],
    opacity: reactionScale.value,
  }));

  if (!message) return null;

  const handleClose = () => {
    fade.value = withTiming(0, { duration: 140 }, (finished) => {
      if (finished) runOnJS(onClose)();
    });
    slide.value = withTiming(40, { duration: 140 });
    reactionScale.value = withTiming(0, { duration: 100 });
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

  const surface = isDark ? 'rgba(28,28,32,0.98)' : 'rgba(255,255,255,0.98)';
  const divider = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

  const items: Array<{
    key: MessageAction;
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    destructive?: boolean;
    show: boolean;
  }> = [
    { key: 'reply', icon: 'arrow-undo', label: 'Reply', show: true },
    { key: 'copy', icon: 'copy-outline', label: 'Copy', show: message.type === 'text' || !!message.content },
    { key: 'forward', icon: 'arrow-redo', label: 'Forward', show: true },
    {
      key: isStarred ? 'unstar' : 'star',
      icon: isStarred ? 'star' : 'star-outline',
      label: isStarred ? 'Unstar' : 'Star',
      show: true,
    },
    {
      key: isPinned ? 'unpin' : 'pin',
      icon: isPinned ? 'pin' : 'pin-outline',
      label: isPinned ? 'Unpin' : 'Pin',
      show: true,
    },
    { key: 'edit', icon: 'create-outline', label: 'Edit', show: canEdit },
    { key: 'info', icon: 'information-circle-outline', label: 'Info', show: isMine && isGroupChat },
    { key: 'select', icon: 'checkbox-outline', label: 'Select', show: true },
    {
      key: 'deleteForEveryone',
      icon: 'trash-bin-outline',
      label: 'Delete for everyone',
      destructive: true,
      show: canDeleteForEveryone,
    },
    { key: 'delete', icon: 'trash-outline', label: 'Delete for me', destructive: true, show: true },
  ];

  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      animationType="none"
      onRequestClose={handleClose}
    >
      <View style={styles.root}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose}>
          <Animated.View style={[styles.backdrop, backdropStyle]} />
        </Pressable>

        <View style={styles.contentWrap} pointerEvents="box-none">
          {/* Reaction row */}
          <Animated.View style={[styles.reactionRow, { backgroundColor: surface }, reactionStripStyle]}>
            {QUICK_REACTIONS.map((emoji) => {
              const active = currentUserReaction === emoji;
              return (
                <TouchableOpacity
                  key={emoji}
                  onPress={() => handleReact(emoji)}
                  style={[
                    styles.reactionButton,
                    active && {
                      backgroundColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)',
                    },
                  ]}
                  activeOpacity={0.7}
                  hitSlop={6}
                >
                  <Text style={styles.reactionEmoji}>{emoji}</Text>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity
              onPress={() => handleReact('+')}
              style={styles.reactionButton}
              activeOpacity={0.7}
            >
              <Ionicons name="add" size={20} color={theme.colors.onSurface} />
            </TouchableOpacity>
          </Animated.View>

          {/* Action sheet */}
          <Animated.View style={[styles.sheet, { backgroundColor: surface }, sheetStyle]}>
            {items
              .filter((i) => i.show)
              .map((item, idx, arr) => (
                <TouchableOpacity
                  key={item.key}
                  style={[
                    styles.actionRow,
                    idx < arr.length - 1 && { borderBottomColor: divider, borderBottomWidth: StyleSheet.hairlineWidth },
                  ]}
                  onPress={() => handleAction(item.key)}
                  activeOpacity={0.6}
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
                    color={item.destructive ? theme.colors.error : theme.colors.onSurface}
                  />
                </TouchableOpacity>
              ))}
          </Animated.View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  contentWrap: {
    width: '86%',
    maxWidth: 360,
    alignItems: 'stretch',
    gap: 10,
  },
  reactionRow: {
    flexDirection: 'row',
    alignSelf: 'center',
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderRadius: 30,
    gap: 2,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  reactionButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reactionEmoji: {
    fontSize: 22,
    lineHeight: Platform.OS === 'android' ? 28 : 26,
  },
  sheet: {
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  actionLabel: {
    fontSize: 16,
    fontWeight: '500',
  },
});

export default MessageActionSheet;
