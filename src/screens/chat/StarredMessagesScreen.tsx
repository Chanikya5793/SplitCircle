import { EmptyState } from '@/components/ui/EmptyState';
import { LiquidBackground } from '@/components/LiquidBackground';
import { FloatingDetailHeader, floatingDetailHeaderHeight, GlassCard } from '@/components/ui';
import { ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import { useTheme } from '@/context/ThemeContext';
import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import type { ChatMessage, MessageType } from '@/models';
import { getChatMessages } from '@/services/localMessageStorage';
import { formatRelativeTime } from '@/utils/format';
import { resolveDisplayName } from '@/utils/identity';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface StarredScreenParams {
  chatId?: string;
  title?: string;
}

interface StarredItem {
  message: ChatMessage;
  chatTitle: string;
}

const iconForType = (type: MessageType): keyof typeof Ionicons.glyphMap => {
  switch (type) {
    case 'image': return 'image-outline';
    case 'video': return 'videocam-outline';
    case 'audio': return 'musical-notes-outline';
    case 'file': return 'document-outline';
    case 'location': return 'location-outline';
    default: return 'chatbubble-outline';
  }
};

export const StarredMessagesScreen = () => {
  const navigation = useNavigation<any>();
  const route = useRoute();
  const params = (route.params as StarredScreenParams) ?? {};
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const { isShielded: guardIsShielded, isLockedDown: guardIsLockedDown } = usePrivacyGuard();
  const starredShielded = guardIsShielded('chats');
  // Lock copy only outside duress — in the decoy world this reads as a
  // normal empty starred list instead of advertising hidden content.
  const starredLocked = guardIsLockedDown('chats');
  const { threads } = useChat();
  const { user } = useAuth();

  const [items, setItems] = useState<StarredItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setRefreshing(true);
    try {
      const targetThreads = params.chatId
        ? threads.filter((t) => t.chatId === params.chatId)
        : threads;

      const buckets = await Promise.all(
        targetThreads.map(async (t) => {
          const msgs = await getChatMessages(t.chatId);
          const titleForThread = (() => {
            if (t.type === 'group') {
              return params.title ?? 'Group';
            }
            const other = t.participants.find((p) => p.userId !== user.userId) ?? t.participants[0];
            return resolveDisplayName(other, 'Direct');
          })();
          return msgs
            .filter((m) => m.starredBy?.includes(user.userId) && !m.deletedFor?.includes(user.userId))
            .map((message) => ({ message, chatTitle: titleForThread } satisfies StarredItem));
        }),
      );

      const flat = buckets.flat();
      flat.sort((a, b) => b.message.createdAt - a.message.createdAt);
      setItems(flat);
    } finally {
      setRefreshing(false);
    }
  }, [user, threads, params.chatId, params.title]);

  useEffect(() => {
    void load();
  }, [load]);

  const headerHeight = floatingDetailHeaderHeight(insets.top);

  return (
    <LiquidBackground>
      <FloatingDetailHeader title="Starred messages" />

      <FlatList
        data={starredShielded ? [] : items}
        keyExtractor={(item) => `${item.message.chatId}_${item.message.messageId || item.message.id}`}
        contentContainerStyle={[styles.list, { paddingTop: headerHeight + 12, paddingBottom: insets.bottom + 24 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={theme.colors.primary} />}
        ListEmptyComponent={
          starredLocked ? (
          <View style={styles.empty}>
            <Ionicons name={starredLocked ? 'lock-closed-outline' : 'star-outline'} size={56} color={theme.colors.onSurfaceVariant} />
            <Text style={[styles.emptyTitle, { color: theme.colors.onSurface }]}>
              {starredLocked ? 'Hidden' : 'No starred messages'}
            </Text>
            <Text style={[styles.emptySub, { color: theme.colors.onSurfaceVariant }]}>
              {starredLocked ? 'Shake again or enter your code to reveal.' : 'Long-press a message and tap Star to keep it here.'}
            </Text>
          </View>
          ) : (
            <EmptyState
              icon="star-outline"
              title="No starred messages"
              hint="Long-press a message and tap Star to keep it here."
            />
          )
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.cardPress}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={`Open chat ${item.chatTitle}`}
            onPress={() =>
              navigation.navigate(ROUTES.APP.GROUP_CHAT, {
                chatId: item.message.chatId,
                initialTitle: item.chatTitle,
                backTitle: 'Starred',
              })
            }
          >
            <GlassCard style={styles.card} contentStyle={styles.cardContentWrap}>
            <View style={styles.cardHeaderRow}>
              <Text style={[styles.cardChat, { color: theme.colors.primary }]} numberOfLines={1}>
                {item.chatTitle}
              </Text>
              <Text style={[styles.cardTime, { color: theme.colors.onSurfaceVariant }]}>
                {formatRelativeTime(item.message.createdAt)}
              </Text>
            </View>
            <View style={styles.cardBody}>
              <Ionicons
                name={iconForType(item.message.type)}
                size={16}
                color={theme.colors.onSurfaceVariant}
                style={{ marginTop: 2 }}
              />
              <Text
                numberOfLines={4}
                style={[styles.cardContent, { color: theme.colors.onSurface }]}
              >
                {item.message.content || '(no text)'}
              </Text>
            </View>
            </GlassCard>
          </TouchableOpacity>
        )}
      />
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  list: { padding: 16, gap: 10 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingTop: 64, paddingHorizontal: 32, gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '700' },
  emptySub: { fontSize: 13, textAlign: 'center' },
  cardPress: {
    marginBottom: 10,
  },
  card: {
    borderRadius: 14,
  },
  cardContentWrap: {
    padding: 12,
  },
  cardHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  cardChat: { fontSize: 13, fontWeight: '700', flex: 1, paddingRight: 8 },
  cardTime: { fontSize: 11 },
  cardBody: { flexDirection: 'row', gap: 8 },
  cardContent: { flex: 1, fontSize: 14, lineHeight: 19 },
});

export default StarredMessagesScreen;
