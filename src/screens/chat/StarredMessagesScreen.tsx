import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatMessage, MessageType } from '@/models';
import { getChatMessages } from '@/services/localMessageStorage';
import { formatRelativeTime } from '@/utils/format';
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
  const navigation = useNavigation();
  const route = useRoute();
  const params = (route.params as StarredScreenParams) ?? {};
  const insets = useSafeAreaInsets();
  const { theme, isDark } = useTheme();
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
            return other?.displayName ?? 'Direct';
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

  const surface = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';

  return (
    <LiquidBackground>
      <View style={[styles.headerRow, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backWrap}
          hitSlop={8}
        >
          <GlassView style={styles.backGlass} intensity={40}>
            <Ionicons name="chevron-back" size={22} color={theme.colors.primary} />
          </GlassView>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <GlassView style={styles.titlePill} intensity={40}>
            <Ionicons name="star" size={16} color={theme.colors.primary} />
            <Text style={[styles.titleText, { color: theme.colors.onSurface }]}>
              Starred messages
            </Text>
          </GlassView>
        </View>
        <View style={{ width: 40 }} />
      </View>

      <FlatList
        data={items}
        keyExtractor={(item) => `${item.message.chatId}_${item.message.messageId || item.message.id}`}
        contentContainerStyle={[styles.list, { paddingTop: insets.top + 64 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={theme.colors.primary} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="star-outline" size={56} color={theme.colors.onSurfaceVariant} />
            <Text style={[styles.emptyTitle, { color: theme.colors.onSurface }]}>No starred messages</Text>
            <Text style={[styles.emptySub, { color: theme.colors.onSurfaceVariant }]}>
              Long-press a message and tap Star to keep it here.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={[styles.card, { backgroundColor: surface }]}>
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
          </View>
        )}
      />
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  headerRow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 10,
    gap: 6,
  },
  backWrap: { width: 40, height: 40, borderRadius: 20, overflow: 'hidden' },
  backGlass: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  titlePill: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    justifyContent: 'center',
  },
  titleText: { fontSize: 15, fontWeight: '700' },
  list: { padding: 16, gap: 10 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingTop: 64, paddingHorizontal: 32, gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '700' },
  emptySub: { fontSize: 13, textAlign: 'center' },
  card: {
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
  },
  cardHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  cardChat: { fontSize: 13, fontWeight: '700', flex: 1, paddingRight: 8 },
  cardTime: { fontSize: 11 },
  cardBody: { flexDirection: 'row', gap: 8 },
  cardContent: { flex: 1, fontSize: 14, lineHeight: 19 },
});

export default StarredMessagesScreen;
