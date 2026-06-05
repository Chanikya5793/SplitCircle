import { GlassView } from '@/components/GlassView';
import { useTheme } from '@/context/ThemeContext';
import type { MessageType, PinnedMessageRef } from '@/models';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Text } from 'react-native-paper';

interface PinnedMessagesBarProps {
  pinned: PinnedMessageRef[];
  topInset: number;
  resolveSenderName?: (senderId?: string) => string | undefined;
  onPress: (ref: PinnedMessageRef) => void;
}

const iconForType = (type?: MessageType): keyof typeof Ionicons.glyphMap => {
  switch (type) {
    case 'image': return 'image';
    case 'video': return 'videocam';
    case 'audio': return 'musical-notes';
    case 'file': return 'document';
    case 'location': return 'location';
    default: return 'pin';
  }
};

const previewFor = (ref: PinnedMessageRef): string => {
  if (ref.contentPreview) return ref.contentPreview;
  switch (ref.type) {
    case 'image': return 'Photo';
    case 'video': return 'Video';
    case 'audio': return 'Audio message';
    case 'file': return 'Document';
    case 'location': return 'Location';
    default: return 'Pinned message';
  }
};

export const PinnedMessagesBar = ({ pinned, topInset, resolveSenderName, onPress }: PinnedMessagesBarProps) => {
  const { theme } = useTheme();
  const [index, setIndex] = useState(0);

  if (pinned.length === 0) return null;
  const safeIndex = Math.min(index, pinned.length - 1);
  const current = pinned[safeIndex];
  const senderName = resolveSenderName?.(current.senderId);

  const handleTap = () => {
    onPress(current);
    if (pinned.length > 1) {
      setIndex((prev) => (prev + 1) % pinned.length);
    }
  };

  return (
    <View
      style={[styles.wrap, { top: topInset + 56 }]}
      pointerEvents="box-none"
    >
      <TouchableOpacity onPress={handleTap} activeOpacity={0.85} style={styles.touchable}>
        <GlassView style={styles.bar} intensity={50}>
          <View style={[styles.accent, { backgroundColor: theme.colors.primary }]} />
          <Ionicons
            name={iconForType(current.type)}
            size={14}
            color={theme.colors.primary}
            style={{ marginRight: 8 }}
          />
          <View style={{ flex: 1 }}>
            <Text style={[styles.title, { color: theme.colors.primary }]} numberOfLines={1}>
              Pinned message
              {pinned.length > 1 ? `  ·  ${safeIndex + 1}/${pinned.length}` : ''}
            </Text>
            <Text
              style={[styles.preview, { color: theme.colors.onSurface }]}
              numberOfLines={1}
            >
              {senderName ? `${senderName}: ` : ''}{previewFor(current)}
            </Text>
          </View>
          {pinned.length > 1 && (
            <Ionicons name="chevron-forward" size={16} color={theme.colors.onSurfaceVariant} />
          )}
        </GlassView>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 80,
  },
  touchable: {
    borderRadius: 14,
    overflow: 'hidden',
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    paddingLeft: 14,
    borderRadius: 14,
  },
  accent: {
    position: 'absolute',
    left: 0,
    top: 4,
    bottom: 4,
    width: 3,
    borderRadius: 2,
  },
  title: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  preview: {
    fontSize: 13,
    marginTop: 1,
  },
});

export default PinnedMessagesBar;
