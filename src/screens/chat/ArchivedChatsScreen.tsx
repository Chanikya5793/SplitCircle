// ArchivedChatsScreen — dedicated destination for the chat list's "Archived"
// folder. WhatsApp-style: the folder row navigates here instead of expanding
// inline, so archived threads never mingle with pinned/active chats. Rows use
// the shared ChatThreadRow (identical swipe/long-press behavior).

import { ChatThreadRow } from '@/components/ChatThreadRow';
import { LiquidBackground } from '@/components/LiquidBackground';
import { GlassBackButton } from '@/components/ui';
import { ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatThread } from '@/models';
import { getChatThreadTitle } from '@/navigation/screenTitles';
import { isChatArchived } from '@/services/archiveService';
import { partitionChats } from '@/utils/chatOrganization';
import { useNavigation } from '@react-navigation/native';
import { useMemo } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const ArchivedChatsScreen = () => {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { theme, isDark } = useTheme();
  const { threads } = useChat();
  const { groups } = useGroups();
  const { user } = useAuth();

  const archivedChats = user?.archivedChats;
  const pinnedChats = user?.pinnedChats;
  const lockedChats = user?.lockedChats;

  // Same partitioning as the chat list — this screen simply surfaces the
  // `archived` bucket that the list now hides behind its folder row.
  const archivedThreads = useMemo(
    () =>
      partitionChats(threads, {
        getId: (t) => t.chatId,
        isArchived: (t) => isChatArchived(archivedChats, t),
        pinnedChats,
        lockedChats,
      }).archived,
    [threads, archivedChats, pinnedChats, lockedChats],
  );

  const openThread = (thread: ChatThread) => {
    navigation.navigate(ROUTES.APP.GROUP_CHAT, {
      chatId: thread.chatId,
      initialTitle: getChatThreadTitle(thread, groups, user?.userId),
      backTitle: 'Archived',
    });
  };

  const HEADER_TOP_PAD = insets.top + 18;
  const HEADER_HEIGHT = HEADER_TOP_PAD + 44 + 12;

  return (
    <LiquidBackground>
      <View
        style={[
          styles.headerRow,
          { paddingTop: HEADER_TOP_PAD },
          // No dividers anywhere in flat mode (2026-08-07).
          theme?.surfaceStyle === 'flat'
            ? { borderBottomWidth: 0 }
            : { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' },
        ]}
      >
        <View style={styles.headerBtn}>
          <GlassBackButton />
        </View>
        <Text numberOfLines={1} style={[styles.titleText, { color: theme.colors.onSurface }]}>
          Archived
        </Text>
        <View style={styles.headerBtn} />
      </View>

      <FlatList
        data={archivedThreads}
        keyExtractor={(item) => item.chatId}
        renderItem={({ item }) => (
          <ChatThreadRow thread={item} variant="archived" onOpenThread={openThread} />
        )}
        contentContainerStyle={[
          styles.list,
          { paddingTop: HEADER_HEIGHT + 12, paddingBottom: insets.bottom + 24 },
        ]}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>
            No archived chats.
          </Text>
        }
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
    paddingHorizontal: 8,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  titleText: { flex: 1, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  list: { padding: 16 },
  empty: { textAlign: 'center', marginTop: 32 },
});

export default ArchivedChatsScreen;
