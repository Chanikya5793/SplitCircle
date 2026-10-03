import { EmptyState } from '@/components/ui/EmptyState';
// ArchivedChatsScreen — dedicated destination for the chat list's "Archived"
// folder. WhatsApp-style: the folder row navigates here instead of expanding
// inline, so archived threads never mingle with pinned/active chats. Rows use
// the shared ChatThreadRow (identical swipe/long-press behavior).

import { ChatThreadRow } from '@/components/ChatThreadRow';
import { LiquidBackground } from '@/components/LiquidBackground';
import { FloatingDetailHeader, floatingDetailHeaderHeight } from '@/components/ui';
import { ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import type { ChatThread } from '@/models';
import { getChatThreadTitle } from '@/navigation/screenTitles';
import { isChatArchived } from '@/services/archiveService';
import { partitionChats } from '@/utils/chatOrganization';
import { useNavigation } from '@react-navigation/native';
import { useMemo } from 'react';
import { FlatList, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const ArchivedChatsScreen = () => {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
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

  const headerHeight = floatingDetailHeaderHeight(insets.top);

  return (
    <LiquidBackground>
      <FloatingDetailHeader title="Archived" />

      <FlatList
        data={archivedThreads}
        keyExtractor={(item) => item.chatId}
        renderItem={({ item }) => (
          <ChatThreadRow thread={item} variant="archived" onOpenThread={openThread} />
        )}
        contentContainerStyle={[
          styles.list,
          { paddingTop: headerHeight + 12, paddingBottom: insets.bottom + 24 },
        ]}
        ListEmptyComponent={
          <EmptyState
            icon="archive-outline"
            title="No archived chats"
            hint="Long-press a chat and choose Archive chat to move it here."
          />
        }
      />
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  list: { padding: 16 },
});

export default ArchivedChatsScreen;
