import { EmptyState } from '@/components/ui/EmptyState';
// LockedChatsScreen — dedicated destination for locked conversations. It is
// only ever reached AFTER a successful Face ID / passcode unlock from the chat
// list's "Locked" folder row (which marks the shared unlock session). To keep
// locked chats private, the screen gates on that session and pops itself the
// moment the app is backgrounded (chatLockService clears the session then), so
// returning to the foreground forces a fresh unlock.

import { ChatThreadRow } from '@/components/ChatThreadRow';
import { LiquidBackground } from '@/components/LiquidBackground';
import { FloatingDetailHeader, floatingDetailHeaderHeight } from '@/components/ui';
import { ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { useGroups } from '@/context/GroupContext';
import type { ChatThread } from '@/models';
import { getChatThreadTitle } from '@/navigation/screenTitles';
import { isChatArchived } from '@/services/archiveService';
import { isLockSessionUnlocked } from '@/services/chatLockService';
import { partitionChats } from '@/utils/chatOrganization';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useMemo } from 'react';
import { AppState, FlatList, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const LockedChatsScreen = () => {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { threads: allThreads } = useChat();
  // Same vanish rule as the chat list: a chat hidden there (and every shielded
  // chat in duress) must not be one tap away under this folder.
  const { isVanished } = usePrivacyGuard();
  const threads = useMemo(() => allThreads.filter((t) => !isVanished('chats', t.chatId)), [allThreads, isVanished]);
  const { groups } = useGroups();
  const { user } = useAuth();

  const archivedChats = user?.archivedChats;
  const pinnedChats = user?.pinnedChats;
  const lockedChats = user?.lockedChats;

  const lockedThreads = useMemo(
    () =>
      partitionChats(threads, {
        getId: (t) => t.chatId,
        isArchived: (t) => isChatArchived(archivedChats, t),
        pinnedChats,
        lockedChats,
      }).locked,
    [threads, archivedChats, pinnedChats, lockedChats],
  );

  useEffect(() => {
    // Reachable only right after a biometric unlock. If the session isn't
    // active (defensive — e.g. a stale deep link), bounce straight back.
    if (!isLockSessionUnlocked()) {
      navigation.goBack();
      return;
    }
    const sub = AppState.addEventListener('change', (state) => {
      // chatLockService clears the shared unlock session on background; pop the
      // screen so locked chats aren't revealed when the app returns.
      if (state === 'background') {
        navigation.goBack();
      }
    });
    return () => sub.remove();
  }, [navigation]);

  const openThread = (thread: ChatThread) => {
    navigation.navigate(ROUTES.APP.GROUP_CHAT, {
      chatId: thread.chatId,
      initialTitle: getChatThreadTitle(thread, groups, user?.userId),
      backTitle: 'Locked',
    });
  };

  const headerHeight = floatingDetailHeaderHeight(insets.top);

  return (
    <LiquidBackground>
      <FloatingDetailHeader title="Locked chats" />

      <FlatList
        data={lockedThreads}
        keyExtractor={(item) => item.chatId}
        renderItem={({ item }) => (
          <ChatThreadRow thread={item} variant="locked" onOpenThread={openThread} />
        )}
        contentContainerStyle={[
          styles.list,
          { paddingTop: headerHeight + 12, paddingBottom: insets.bottom + 24 },
        ]}
        ListEmptyComponent={
          <EmptyState
            icon="lock-outline"
            title="No locked chats"
            hint="Long-press a chat and choose Lock chat to protect it."
          />
        }
      />
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  list: { padding: 16 },
});

export default LockedChatsScreen;
