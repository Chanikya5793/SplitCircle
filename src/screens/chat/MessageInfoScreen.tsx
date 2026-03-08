import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatMessage, ChatParticipant, ChatThread, MessageType } from '@/models';
import {
    listenForMessageReceipts,
    registerReceiptParticipant,
    type ReceiptData,
} from '@/services/messageQueueService';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
    Animated,
    LayoutAnimation,
    StyleSheet,
    View,
} from 'react-native';
import { Avatar, Divider, Text } from 'react-native-paper';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

interface MessageInfoRouteParams {
  message: ChatMessage;
  thread: ChatThread;
}

interface ReceiptRow {
  participant: ChatParticipant;
  deliveredAt?: number;
  readAt?: number;
}

const AVATAR_COLORS = [
  '#E57373', '#F06292', '#BA68C8', '#9575CD', '#7986CB',
  '#64B5F6', '#4FC3F7', '#4DD0E1', '#4DB6AC', '#81C784',
  '#AED581', '#FF8A65', '#D4E157', '#FFD54F', '#FFB74D',
];

const getAvatarColor = (id: string): string => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

const getInitials = (name: string): string => {
  const normalized = name.trim();
  if (!normalized) {
    return '??';
  }

  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }

  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
};

const formatReceiptTime = (epochMs: number): string => {
  const date = new Date(epochMs);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  if (isToday) return `Today, ${time}`;
  if (isYesterday) return `Yesterday, ${time}`;

  const day = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${day}, ${time}`;
};

const getMediaPreview = (type: MessageType): { icon: keyof typeof Ionicons.glyphMap; label: string } => {
  switch (type) {
    case 'image':
      return { icon: 'image', label: 'Photo' };
    case 'video':
      return { icon: 'videocam', label: 'Video' };
    case 'audio':
      return { icon: 'musical-notes', label: 'Audio' };
    case 'file':
      return { icon: 'document', label: 'Document' };
    case 'location':
      return { icon: 'location', label: 'Location' };
    case 'call':
      return { icon: 'call', label: 'Call' };
    case 'system':
      return { icon: 'notifications', label: 'System message' };
    default:
      return { icon: 'chatbubble', label: 'Message' };
  }
};

export const MessageInfoScreen = () => {
  const navigation = useNavigation();
  const route = useRoute();
  const { theme, isDark } = useTheme();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const scrollY = useRef(new Animated.Value(0)).current;
  const { message, thread } = route.params as MessageInfoRouteParams;
  const [receiptMap, setReceiptMap] = useState<Record<string, ReceiptData>>({});

  const headerOpacity = scrollY.interpolate({
    inputRange: [0, 60],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  const titleOpacity = scrollY.interpolate({
    inputRange: [0, 80],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  useLayoutEffect(() => {
    navigation.setOptions({
      title: '',
      headerTransparent: true,
      headerTintColor: theme.colors.primary,
    });
  }, [navigation, theme.colors.primary]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: () => void = () => undefined;

    const start = async () => {
      if (user?.userId) {
        try {
          await registerReceiptParticipant(message.chatId, user.userId);
        } catch (error) {
          console.warn('⚠️ Could not register receipt participant for Message Info:', error);
        }
      }

      if (disposed) {
        return;
      }

      unsubscribe = listenForMessageReceipts(message.chatId, message.messageId, (receipts) => {
        if (disposed) {
          return;
        }

        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setReceiptMap(receipts);
      });
    };

    void start();

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [message.chatId, message.messageId, user?.userId]);

  const recipients = useMemo(() => {
    return thread.participants.filter((participant) => participant.userId !== message.senderId);
  }, [thread.participants, message.senderId]);

  const { readByRows, deliveredRows, pendingRows } = useMemo(() => {
    const read: ReceiptRow[] = [];
    const delivered: ReceiptRow[] = [];
    const pending: ChatParticipant[] = [];

    for (const participant of recipients) {
      const receipt = receiptMap[participant.userId];

      if (receipt?.read) {
        read.push({
          participant,
          deliveredAt: receipt.deliveredAt,
          readAt: receipt.readAt,
        });
        continue;
      }

      if (receipt?.delivered) {
        delivered.push({
          participant,
          deliveredAt: receipt.deliveredAt,
        });
        continue;
      }

      pending.push(participant);
    }

    read.sort((a, b) => (b.readAt ?? b.deliveredAt ?? 0) - (a.readAt ?? a.deliveredAt ?? 0));
    delivered.sort((a, b) => (b.deliveredAt ?? 0) - (a.deliveredAt ?? 0));
    pending.sort((a, b) => a.displayName.localeCompare(b.displayName));

    return {
      readByRows: read,
      deliveredRows: delivered,
      pendingRows: pending,
    };
  }, [receiptMap, recipients]);

  const preview = getMediaPreview(message.type);
  const neutralTickColor = isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.5)';

  const renderAvatar = (participant: ChatParticipant) => {
    if (participant.photoURL) {
      return <Avatar.Image size={42} source={{ uri: participant.photoURL }} />;
    }

    return (
      <Avatar.Text
        size={42}
        label={getInitials(participant.displayName)}
        style={{ backgroundColor: getAvatarColor(participant.userId) }}
        color="#FFF"
      />
    );
  };

  const renderSectionHeader = (
    title: string,
    icon: keyof typeof Ionicons.glyphMap,
    iconColor: string,
    count: number
  ) => {
    return (
      <View style={styles.sectionHeaderRow}>
        <View style={styles.sectionHeaderTitleRow}>
          <Ionicons name={icon} size={18} color={iconColor} />
          <Text variant="titleMedium" style={[styles.sectionHeaderTitle, { color: theme.colors.onSurface }]}>
            {title}
          </Text>
        </View>
        <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
          {count}
        </Text>
      </View>
    );
  };

  const renderTimedRow = (row: ReceiptRow, timestamp: number | undefined) => {
    return (
      <View style={styles.recipientRow}>
        {renderAvatar(row.participant)}
        <View style={styles.recipientTextBlock}>
          <Text variant="titleSmall" style={{ color: theme.colors.onSurface }} numberOfLines={1}>
            {row.participant.displayName}
          </Text>
          {typeof timestamp === 'number' && (
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {formatReceiptTime(timestamp)}
            </Text>
          )}
        </View>
      </View>
    );
  };

  const renderUntimedRow = (participant: ChatParticipant) => {
    return (
      <View style={styles.recipientRow}>
        {renderAvatar(participant)}
        <View style={styles.recipientTextBlock}>
          <Text variant="titleSmall" style={{ color: theme.colors.onSurface }} numberOfLines={1}>
            {participant.displayName}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <LiquidBackground>
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <Animated.View style={[styles.stickyHeader, { opacity: headerOpacity, paddingTop: insets.top }]}>
          <GlassView style={styles.stickyHeaderGlass}>
            <Text variant="titleMedium" style={[styles.stickyHeaderTitle, { color: theme.colors.onSurface }]}>
              Message Info
            </Text>
          </GlassView>
        </Animated.View>

        <Animated.ScrollView
          style={styles.scrollView}
          contentContainerStyle={{ paddingTop: insets.top + 48, paddingBottom: 100 }}
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: true }
          )}
          scrollEventThrottle={16}
        >
          <Animated.View style={[styles.titleContainer, { opacity: titleOpacity }]}>
            <Text variant="headlineSmall" style={[styles.screenTitle, { color: theme.colors.onSurface }]}>
              Message Info
            </Text>
          </Animated.View>

          <GlassView style={styles.previewCard}>
            <View style={[styles.previewBubble, { backgroundColor: theme.colors.primary }]}>
              {message.type === 'text' ? (
                <Text style={[styles.previewText, { color: theme.colors.onPrimary }]}>
                  {message.content}
                </Text>
              ) : (
                <View style={styles.previewMediaRow}>
                  <Ionicons name={preview.icon} size={18} color={theme.colors.onPrimary} />
                  <Text style={[styles.previewText, { color: theme.colors.onPrimary }]}>
                    {preview.label}
                  </Text>
                </View>
              )}
              <Text style={[styles.previewTime, { color: 'rgba(255,255,255,0.75)' }]}>
                {formatReceiptTime(message.createdAt)}
              </Text>
            </View>
          </GlassView>

          <GlassView style={styles.section}>
            {renderSectionHeader('Read by', 'checkmark-done', '#53BDEB', readByRows.length)}
            {readByRows.length === 0 && (
              <Text variant="bodySmall" style={[styles.emptyText, { color: theme.colors.onSurfaceVariant }]}>
                Nobody has read this message yet.
              </Text>
            )}
            {readByRows.map((row, index) => (
              <View key={row.participant.userId}>
                {renderTimedRow(row, row.readAt ?? row.deliveredAt)}
                {index < readByRows.length - 1 && <Divider style={styles.rowDivider} />}
              </View>
            ))}
          </GlassView>

          <GlassView style={styles.section}>
            {renderSectionHeader('Delivered to', 'checkmark-done', neutralTickColor, deliveredRows.length)}
            {deliveredRows.length === 0 && (
              <Text variant="bodySmall" style={[styles.emptyText, { color: theme.colors.onSurfaceVariant }]}>
                No delivery-only recipients right now.
              </Text>
            )}
            {deliveredRows.map((row, index) => (
              <View key={row.participant.userId}>
                {renderTimedRow(row, row.deliveredAt)}
                {index < deliveredRows.length - 1 && <Divider style={styles.rowDivider} />}
              </View>
            ))}
          </GlassView>

          {pendingRows.length > 0 && (
            <GlassView style={styles.section}>
              {renderSectionHeader('Not yet delivered', 'checkmark', neutralTickColor, pendingRows.length)}
              {pendingRows.map((participant, index) => (
                <View key={participant.userId}>
                  {renderUntimedRow(participant)}
                  {index < pendingRows.length - 1 && <Divider style={styles.rowDivider} />}
                </View>
              ))}
            </GlassView>
          )}
        </Animated.ScrollView>
      </SafeAreaView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  scrollView: {
    flex: 1,
  },
  stickyHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    paddingHorizontal: 16,
    paddingBottom: 10,
    alignItems: 'center',
  },
  stickyHeaderGlass: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 28,
  },
  stickyHeaderTitle: {
    fontWeight: '700',
  },
  titleContainer: {
    alignItems: 'center',
    marginBottom: 12,
  },
  screenTitle: {
    fontWeight: '700',
  },
  previewCard: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 16,
    padding: 10,
  },
  previewBubble: {
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  previewText: {
    fontSize: 15,
    lineHeight: 20,
  },
  previewMediaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  previewTime: {
    fontSize: 11,
    marginTop: 8,
    textAlign: 'right',
  },
  section: {
    marginHorizontal: 16,
    marginBottom: 14,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  sectionHeaderTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sectionHeaderTitle: {
    fontWeight: '700',
  },
  emptyText: {
    marginTop: 2,
    marginBottom: 4,
  },
  recipientRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
  },
  recipientTextBlock: {
    flex: 1,
    marginLeft: 12,
  },
  rowDivider: {
    opacity: 0.35,
  },
});

export default MessageInfoScreen;
