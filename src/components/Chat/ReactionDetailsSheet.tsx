import { useTheme } from '@/context/ThemeContext';
import type { ReactionMap } from '@/models';
import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Text } from 'react-native-paper';

interface ReactionDetailsSheetProps {
  visible: boolean;
  reactions?: ReactionMap;
  currentUserId?: string;
  /** Map of userId → displayName */
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

  const entries = reactions
    ? Object.entries(reactions).filter(([, users]) => users.length > 0)
    : [];

  const getUserName = (userId: string): string => {
    if (userId === currentUserId) return 'You';
    return participantNames?.get(userId) ?? 'User';
  };

  const handleRemove = (emoji: string) => {
    onClose();
    onRemoveReaction?.(emoji);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <View />
      </Pressable>
      <View style={styles.sheetAnchor}>
        <View style={[styles.sheet, {
          backgroundColor: isDark ? '#1c1c2e' : '#fff',
        }]}>
          <View style={styles.sheetHandle} />
          <Text
            variant="titleSmall"
            style={[styles.sheetTitle, { color: theme.colors.onSurface }]}
          >
            Reactions
          </Text>
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
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
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
    maxHeight: 400,
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
    marginBottom: 16,
    fontSize: 16,
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
