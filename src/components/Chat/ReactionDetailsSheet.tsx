import { useTheme } from '@/context/ThemeContext';
import type { ReactionMap } from '@/models';
import { BlurView } from 'expo-blur';
import React, { memo, useMemo } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Text } from 'react-native-paper';
import Animated, { SlideInDown } from 'react-native-reanimated';

interface ReactionDetailsSheetProps {
  visible: boolean;
  reactions?: ReactionMap;
  currentUserId?: string;
  /** Map of userId → displayName */
  participantNames?: Map<string, string>;
  onRemoveReaction?: (emoji: string) => void;
  /** Strip every reaction by the current user from this message. */
  onRemoveAll?: () => void;
  onClose: () => void;
}

export const ReactionDetailsSheet = memo(({
  visible,
  reactions,
  currentUserId,
  participantNames,
  onRemoveReaction,
  onRemoveAll,
  onClose,
}: ReactionDetailsSheetProps) => {
  const { theme, isDark } = useTheme();

  const entries = useMemo(
    () => (reactions ? Object.entries(reactions).filter(([, users]) => users.length > 0) : []),
    [reactions]
  );

  const myReactionCount = useMemo(() => {
    if (!currentUserId) return 0;
    return entries.reduce((acc, [, users]) => acc + (users.includes(currentUserId) ? 1 : 0), 0);
  }, [entries, currentUserId]);

  const getUserName = (userId: string): string => {
    if (userId === currentUserId) return 'You';
    return participantNames?.get(userId) ?? 'User';
  };

  const handleRemove = (emoji: string) => {
    onClose();
    onRemoveReaction?.(emoji);
  };

  const handleRemoveAll = () => {
    onClose();
    onRemoveAll?.();
  };

  const surface = (theme.colors as any).elevation?.level3 ?? theme.colors.surface;
  const myRowBg = `${theme.colors.primary}1A`; // ~10% primary
  const avatarBg = theme.colors.surfaceVariant ?? (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)');

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <BlurView
          intensity={15}
          tint={isDark ? 'dark' : 'light'}
          style={StyleSheet.absoluteFill}
        />
      </Pressable>
      <Animated.View style={styles.sheetAnchor} entering={SlideInDown.duration(300)}>
        <View style={[styles.sheet, { backgroundColor: surface }]}>
          <View style={styles.sheetHandle} />
          <Text
            variant="titleSmall"
            style={[styles.sheetTitle, { color: theme.colors.onSurface }]}
          >
            Reactions
          </Text>

          {myReactionCount >= 2 && (
            <TouchableOpacity
              onPress={handleRemoveAll}
              style={[styles.removeAllButton, { borderColor: theme.colors.error }]}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Remove all my reactions from this message"
            >
              <Text style={[styles.removeAllText, { color: theme.colors.error }]}>
                Remove all my reactions
              </Text>
            </TouchableOpacity>
          )}

          <ScrollView
            bounces={false}
            showsVerticalScrollIndicator={false}
            style={styles.sheetScroll}
          >
            {entries.map(([emoji, users]) => (
              <View key={emoji} style={styles.emojiGroup}>
                <View style={styles.emojiHeaderRow}>
                  <Text style={styles.emojiHeader}>{emoji}</Text>
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
                        { backgroundColor: isMe ? myRowBg : 'transparent' },
                      ]}
                      activeOpacity={isMe ? 0.6 : 1}
                      onPress={isMe ? () => handleRemove(emoji) : undefined}
                      disabled={!isMe}
                      accessibilityRole={isMe ? 'button' : undefined}
                      accessibilityLabel={isMe ? `Remove your ${emoji} reaction` : `${getUserName(userId)} reacted with ${emoji}`}
                    >
                      <View style={styles.reactorInfo}>
                        <View style={[styles.reactorAvatar, { backgroundColor: avatarBg }]}>
                          <Text style={[styles.reactorInitial, { color: theme.colors.onSurface }]}>
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
        </View>
      </Animated.View>
    </Modal>
  );
});

ReactionDetailsSheet.displayName = 'ReactionDetailsSheet';

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.1)',
  },
  sheetAnchor: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingBottom: 40,
    paddingTop: 12,
    maxHeight: 460,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 20,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(128,128,128,0.3)',
    alignSelf: 'center',
    marginBottom: 14,
  },
  sheetTitle: {
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
    fontSize: 16,
  },
  removeAllButton: {
    alignSelf: 'center',
    marginHorizontal: 16,
    marginBottom: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: 1,
  },
  removeAllText: {
    fontSize: 13,
    fontWeight: '600',
  },
  sheetScroll: {
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
  emojiHeader: {
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
