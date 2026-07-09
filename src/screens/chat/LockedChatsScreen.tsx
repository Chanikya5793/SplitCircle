// LockedChatsScreen — dedicated destination for locked conversations. It is
// only ever reached AFTER a successful Face ID / passcode unlock from the chat
// list's "Locked" folder row (which marks the shared unlock session). To keep
// locked chats private, the screen gates on that session and pops itself the
// moment the app is backgrounded (chatLockService clears the session then), so
// returning to the foreground forces a fresh unlock.

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
import { isLockSessionUnlocked } from '@/services/chatLockService';
import { partitionChats } from '@/utils/chatOrganization';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useMemo } from 'react';
import { AppState, FlatList, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const LockedChatsScreen = () => {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { theme, isDark } = useTheme();
  const { threads } = useChat();
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

  const HEADER_TOP_PAD = insets.top + 18;
  const HEADER_HEIGHT = HEADER_TOP_PAD + 44 + 12;

  return (
    <LiquidBackground>
      <View
        style={[
          styles.headerRow,
          {
            paddingTop: HEADER_TOP_PAD,
            borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
          },
        ]}
      >
        <View style={styles.headerBtn}>
          <GlassBackButton />
        </View>
        <Text numberOfLines={1} style={[styles.titleText, { color: theme.colors.onSurface }]}>
          Locked chats
        </Text>
        <View style={styles.headerBtn} />
      </View>

      <FlatList
        data={lockedThreads}
        keyExtractor={(item) => item.chatId}
        renderItem={({ item }) => (
          <ChatThreadRow thread={item} variant="locked" onOpenThread={openThread} />
        )}
        contentContainerStyle={[
          styles.list,
          { paddingTop: HEADER_HEIGHT + 12, paddingBottom: insets.bottom + 24 },
        ]}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>
            No locked chats.
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

export default LockedChatsScreen;
