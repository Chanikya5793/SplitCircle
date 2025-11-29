import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatMessage } from '@/models';
import { formatRelativeTime } from '@/utils/format';
import { Image, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

interface MessageBubbleProps {
  message: ChatMessage;
}

export const MessageBubble = ({ message }: MessageBubbleProps) => {
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
  return (
    <View style={[
      styles.container,
      isMine
        ? [styles.mine, { backgroundColor: theme.colors.primary }]
        : [styles.other, { backgroundColor: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.7)' }]
    ]}>
      <Text style={[styles.text, { color: isMine ? theme.colors.onPrimary : theme.colors.onSurface }]}>{message.content}</Text>
      {message.mediaUrl && <Image source={{ uri: message.mediaUrl }} style={styles.image} />}
      <Text style={[styles.timestamp, { color: isMine ? 'rgba(255,255,255,0.7)' : theme.colors.onSurfaceVariant }]}>{formatRelativeTime(message.createdAt)}</Text>
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
  container: {
    maxWidth: '80%',
    padding: 12,
    borderRadius: 16,
    marginBottom: 8,
  },
  mine: {
    marginLeft: 'auto',
    borderBottomRightRadius: 2,
  },
  other: {
    borderBottomLeftRadius: 2,
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
