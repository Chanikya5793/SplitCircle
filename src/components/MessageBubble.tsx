import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatMessage } from '@/models';
import { formatRelativeTime } from '@/utils/format';
import { Image, StyleSheet, View } from 'react-native';
import { Avatar, Text } from 'react-native-paper';

interface MessageBubbleProps {
  message: ChatMessage;
  showSenderInfo?: boolean;
  senderName?: string;
}

const AVATAR_COLORS = [
  '#E57373', '#F06292', '#BA68C8', '#9575CD', '#7986CB',
  '#64B5F6', '#4FC3F7', '#4DD0E1', '#4DB6AC', '#81C784',
  '#AED581', '#FF8A65', '#D4E157', '#FFD54F', '#FFB74D'
];

const getSenderColor = (id: string) => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

export const MessageBubble = ({ message, showSenderInfo, senderName }: MessageBubbleProps) => {
  const { user } = useAuth();
  const { theme, isDark } = useTheme();

  if (message.type === 'system') {
    return (
      <View style={styles.systemContainer}>
        <View style={[styles.systemBubble, { backgroundColor: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)' }]}>
          <Text style={[styles.systemText, { color: theme.colors.onSurfaceVariant }]}>{message.content}</Text>
        </View>
      </View>
    );
  }

  const isMine = user?.userId === message.senderId;
  const senderColor = !isMine && message.senderId ? getSenderColor(message.senderId) : theme.colors.primary;
  const initials = senderName ? senderName.slice(0, 2).toUpperCase() : '??';

  if (isMine) {
    return (
      <View style={[
        styles.container,
        styles.mine,
        { backgroundColor: theme.colors.primary }
      ]}>
        <Text style={[styles.text, { color: theme.colors.onPrimary }]}>{message.content}</Text>
        {message.mediaUrl && <Image source={{ uri: message.mediaUrl }} style={styles.image} />}
        <Text style={[styles.timestamp, { color: 'rgba(255,255,255,0.7)' }]}>{formatRelativeTime(message.createdAt)}</Text>
      </View>
    );
  }

  return (
    <View style={styles.otherRow}>
      <View style={styles.avatarContainer}>
        {showSenderInfo && (
          <Avatar.Text
            size={28}
            label={initials}
            style={{ backgroundColor: senderColor }}
            color="#FFF"
            labelStyle={{ fontSize: 12, lineHeight: 28 }}
          />
        )}
      </View>
      <View style={[
        styles.container,
        styles.other,
        { backgroundColor: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.7)' }
      ]}>
        {showSenderInfo && senderName && (
          <Text style={[styles.senderName, { color: senderColor }]}>{senderName}</Text>
        )}
        <Text style={[styles.text, { color: theme.colors.onSurface }]}>{message.content}</Text>
        {message.mediaUrl && <Image source={{ uri: message.mediaUrl }} style={styles.image} />}
        <Text style={[styles.timestamp, { color: theme.colors.onSurfaceVariant }]}>{formatRelativeTime(message.createdAt)}</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  systemContainer: {
    alignItems: 'center',
    marginVertical: 12,
    width: '100%',
  },
  systemBubble: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  systemText: {
    fontSize: 12,
    textAlign: 'center',
  },
  otherRow: {
    flexDirection: 'row',
    // The avatar is aligned with the TOP of the bubble.
    alignItems: 'flex-start',
    marginBottom: 8,
    maxWidth: '85%',
  },
  avatarContainer: {
    width: 28,
    marginRight: 8,
    // If we want top alignment, flex-start is correct.
  },
  container: {
    padding: 12,
    borderRadius: 16,
    // marginBottom is handled by wrapper for 'other', but for 'mine' we need it.
  },
  mine: {
    maxWidth: '80%',
    marginLeft: 'auto',
    borderBottomRightRadius: 2,
    marginBottom: 8,
  },
  other: {
    flex: 1, // Take remaining space in row
    borderBottomLeftRadius: 2,
    borderTopLeftRadius: 16, // Ensure rounded top left even with avatar
  },
  senderName: {
    fontSize: 12,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  text: {
    // color handled dynamically
  },
  timestamp: {
    fontSize: 10,
    marginTop: 4,
    textAlign: 'right',
  },
  image: {
    marginTop: 8,
    width: 160,
    height: 160,
    borderRadius: 12,
  },
});
