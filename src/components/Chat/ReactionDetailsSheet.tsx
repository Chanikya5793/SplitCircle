import { GlassCard } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import type { ReactionMap } from '@/models';
import { lightHaptic } from '@/utils/haptics';
import { BlurView } from 'expo-blur';
import React, { useEffect } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
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

interface ReactionDetailsSheetProps {
  visible: boolean;
  reactions?: ReactionMap;
  currentUserId?: string;
  participantNames?: Map<string, string>;
  onRemoveReaction?: (emoji: string) => void;
  onClose: () => void;
}

export const ReactionDetailsSheet = ({
  visible,
  reactions,
  currentUserId,
  participantNames,
  onRemoveReaction,
  onClose,
}: ReactionDetailsSheetProps) => {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();

  const fade = useSharedValue(0);
  const translateY = useSharedValue(300);

  useEffect(() => {
    if (visible) {
      fade.value = withTiming(1, { duration: 200, easing: Easing.out(Easing.quad) });
      translateY.value = withSpring(0, { damping: 25, stiffness: 300, mass: 0.8 });
    } else {
      fade.value = withTiming(0, { duration: 150 });
      translateY.value = withTiming(300, { duration: 150 });
    }
  }, [visible, fade, translateY]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: fade.value }));
  // Transform-only — an ancestor's fractional opacity kills the native iOS 26
  // glass material on the sheet's GlassCard (DESIGN.md's native-material kill
  // list). The backdrop above already fades independently on the same `fade`
  // value, so dropping opacity here doesn't change how the reveal reads.
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const entries = reactions
    ? Object.entries(reactions).filter(([, users]) => users.length > 0)
    : [];

  const getUserName = (userId: string): string => {
    if (userId === currentUserId) return 'You';
    return participantNames?.get(userId) ?? 'User';
  };

  const handleClose = () => {
    fade.value = withTiming(0, { duration: 150, easing: Easing.in(Easing.quad) });
    translateY.value = withTiming(300, { duration: 200, easing: Easing.in(Easing.quad) }, (finished) => {
      if (finished) runOnJS(onClose)();
    });
  };

  const handleRemove = (emoji: string) => {
    lightHaptic();
    handleClose();
    onRemoveReaction?.(emoji);
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
        {/* Blur backdrop */}
        <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]} pointerEvents="none">
          <BlurView
            intensity={40}
            tint={isDark ? 'dark' : 'default'}
            style={StyleSheet.absoluteFill}
          />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: isDark ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.08)' }]} />
        </Animated.View>

        {/* Dismiss layer */}
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />

        {/* Sheet — anchored to bottom, passes through touches above */}
        <View style={styles.sheetContainer} pointerEvents="box-none">
          <Animated.View style={[styles.sheetWrap, sheetStyle]}>
            <GlassCard
              style={styles.sheetGlass}
              contentStyle={[styles.sheetContent, { paddingBottom: insets.bottom + 16 }]}
            >
            <View style={styles.handle} />
            <Text
              variant="titleSmall"
              style={[styles.title, { color: theme.colors.onSurface }]}
            >
              Reactions
            </Text>
            <ScrollView
              bounces={false}
              showsVerticalScrollIndicator={false}
              style={styles.scroll}
            >
              {entries.map(([emoji, users]) => (
                <View key={emoji} style={styles.emojiGroup}>
                  <View style={styles.emojiHeaderRow}>
                    <Text style={styles.emojiIcon}>{emoji}</Text>
                    <Text style={[styles.emojiCount, { color: theme.colors.onSurfaceVariant }]}>
                      {users.length}
                    </Text>
                  </View>
                  {users.map((userId) => {
                    const isMe = userId === currentUserId;
                    return (
                      <TouchableOpacity
                        key={userId}
                        style={[
                          styles.reactorRow,
                          {
                            backgroundColor: isMe
                              ? (isDark ? 'rgba(53,198,255,0.1)' : 'rgba(31,111,235,0.06)')
                              : 'transparent',
                          },
                        ]}
                        activeOpacity={isMe ? 0.6 : 1}
                        onPress={isMe ? () => handleRemove(emoji) : undefined}
                        disabled={!isMe}
                      >
                        <View style={styles.reactorInfo}>
                          <View style={[styles.reactorAvatar, { backgroundColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)' }]}>
                            <Text style={styles.reactorInitial}>
                              {getUserName(userId).charAt(0).toUpperCase()}
                            </Text>
                          </View>
                          <Text style={[styles.reactorName, { color: theme.colors.onSurface }]}>
                            {getUserName(userId)}
                          </Text>
                        </View>
                        {isMe && (
                          <Text style={[styles.tapToRemove, { color: theme.colors.primary }]}>
                            Tap to remove
                          </Text>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ))}
              {entries.length === 0 && (
                <Text style={[styles.emptyText, { color: theme.colors.onSurfaceVariant }]}>
                  No reactions yet
                </Text>
              )}
            </ScrollView>
            </GlassCard>
          </Animated.View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  sheetContainer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetWrap: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
    elevation: 20,
  },
  sheetGlass: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    maxHeight: 420,
  },
  sheetContent: {
    paddingTop: 12,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(128,128,128,0.4)',
    alignSelf: 'center',
    marginBottom: 14,
  },
  title: {
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 16,
    fontSize: 16,
  },
  scroll: {
    paddingHorizontal: 16,
  },
  emojiGroup: {
    marginBottom: 16,
  },
  emojiHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  emojiIcon: {
    fontSize: 24,
  },
  emojiCount: {
    fontSize: 13,
    fontWeight: '600',
  },
  reactorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    marginBottom: 2,
  },
  reactorInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  reactorAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reactorInitial: {
    fontSize: 14,
    fontWeight: '600',
  },
  reactorName: {
    fontSize: 15,
    fontWeight: '500',
  },
  tapToRemove: {
    fontSize: 12,
    fontWeight: '500',
  },
  emptyText: {
    textAlign: 'center',
    fontSize: 14,
    paddingVertical: 20,
  },
});
