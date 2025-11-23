import { colors } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import type { ChatMessage } from '@/models';
import { formatRelativeTime } from '@/utils/format';
import { Image, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

interface MessageBubbleProps {
  message: ChatMessage;
}

export const MessageBubble = ({ message }: MessageBubbleProps) => {
  const { user } = useAuth();
  const isMine = user?.userId === message.senderId;
  return (
    <View style={[styles.container, isMine ? styles.mine : styles.other]}>
      <Text style={[styles.text, isMine && styles.mineText]}>{message.content}</Text>
      {message.mediaUrl && <Image source={{ uri: message.mediaUrl }} style={styles.image} />}
      <Text style={[styles.timestamp, isMine && styles.mineText]}>{formatRelativeTime(message.createdAt)}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    maxWidth: '80%',
    padding: 12,
    borderRadius: 16,
    marginBottom: 8,
  },
  mine: {
    backgroundColor: colors.primary,
    marginLeft: 'auto',
    borderBottomRightRadius: 2,
  },
  other: {
    backgroundColor: 'rgba(255, 255, 255, 0.7)',
    borderBottomLeftRadius: 2,
  },
  text: {
    color: colors.muted,
  },
  mineText: {
    color: colors.surface,
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
