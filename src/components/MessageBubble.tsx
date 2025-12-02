import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatMessage } from '@/models';
import { formatRelativeTime } from '@/utils/format';
import { useRef } from 'react';
import { Animated, Image, StyleSheet, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Avatar, IconButton, Text } from 'react-native-paper';

interface MessageBubbleProps {
  message: ChatMessage;
  showSenderInfo?: boolean;
  senderName?: string;
  onSwipeReply?: (message: ChatMessage) => void;
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

export const MessageBubble = ({ message, showSenderInfo, senderName, onSwipeReply }: MessageBubbleProps) => {
  const { user } = useAuth();
  const { theme, isDark } = useTheme();
  const swipeableRef = useRef<Swipeable>(null);

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

  const renderLeftActions = (progress: Animated.AnimatedInterpolation<number>, dragX: Animated.AnimatedInterpolation<number>) => {
    const scale = dragX.interpolate({
      inputRange: [0, 50],
      outputRange: [0, 1],
      extrapolate: 'clamp',
    });

    return (
      <View style={styles.replyActionContainer}>
        <Animated.View style={{ transform: [{ scale }] }}>
          <IconButton icon="reply" iconColor={theme.colors.onSurface} size={20} />
        </Animated.View>
      </View>
    );
  };

  const onSwipeableOpen = () => {
    if (onSwipeReply) {
      onSwipeReply(message);
      swipeableRef.current?.close();
    }
  };

  // Reply preview component
  const ReplyContent = () => {
    if (!message.replyTo) return null;
    const replyColor = getSenderColor(message.replyTo.senderId);

    return (
      <View style={[styles.replyContainer, {
        borderLeftColor: replyColor,
        backgroundColor: isMine ? 'rgba(0,0,0,0.15)' : (isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)')
      }]}>
        <Text style={[styles.replySender, { color: isMine ? 'rgba(255,255,255,0.9)' : replyColor }]}>{message.replyTo.senderName}</Text>
        <Text numberOfLines={1} style={[styles.replyText, {
          color: isMine ? 'rgba(255,255,255,0.8)' : theme.colors.onSurfaceVariant
        }]}>
          {message.replyTo.content}
        </Text>
      </View>
    );
  };

  // My message (right side)
  if (isMine) {
    return (
      <Swipeable
        ref={swipeableRef}
        renderLeftActions={onSwipeReply ? renderLeftActions : undefined}
        onSwipeableOpen={onSwipeableOpen}
        friction={2}
        overshootLeft={false}
      >
        <View style={[styles.container, styles.mine, { backgroundColor: theme.colors.primary }]}>
          <ReplyContent />
          <Text style={[styles.text, { color: theme.colors.onPrimary }]}>{message.content}</Text>
          {message.mediaUrl && <Image source={{ uri: message.mediaUrl }} style={styles.image} />}
          <Text style={[styles.timestamp, { color: 'rgba(255,255,255,0.7)' }]}>{formatRelativeTime(message.createdAt)}</Text>
        </View>
      </Swipeable>
    );
  }

  // Other's message (left side with optional avatar)
  return (
    <Swipeable
      ref={swipeableRef}
      renderLeftActions={onSwipeReply ? renderLeftActions : undefined}
      onSwipeableOpen={onSwipeableOpen}
      friction={2}
      overshootLeft={false}
    >
      <View style={styles.otherRow}>
        {showSenderInfo !== undefined && (
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
        )}
        <View style={[styles.container, styles.other, { backgroundColor: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.7)' }]}>
          <ReplyContent />
          {showSenderInfo && senderName && (
            <Text style={[styles.senderName, { color: senderColor }]}>{senderName}</Text>
          )}
          <Text style={[styles.text, { color: theme.colors.onSurface }]}>{message.content}</Text>
          {message.mediaUrl && <Image source={{ uri: message.mediaUrl }} style={styles.image} />}
          <Text style={[styles.timestamp, { color: theme.colors.onSurfaceVariant }]}>{formatRelativeTime(message.createdAt)}</Text>
        </View>
      </View>
    </Swipeable>
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
    alignItems: 'flex-end',
    marginBottom: 8,
    maxWidth: '85%',
  },
  avatarContainer: {
    width: 28,
    marginRight: 8,
  },
  container: {
    padding: 12,
    borderRadius: 16,
  },
  mine: {
    maxWidth: '80%',
    marginLeft: 'auto',
    borderBottomRightRadius: 2,
    marginBottom: 8,
  },
  other: {
    flex: 1,
    borderBottomLeftRadius: 2,
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
  replyActionContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 50,
  },
  replyContainer: {
    borderLeftWidth: 3,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    marginBottom: 8,
  },
  replySender: {
    fontWeight: 'bold',
    fontSize: 12,
    marginBottom: 2,
  },
  replyText: {
    fontSize: 12,
  },
});
