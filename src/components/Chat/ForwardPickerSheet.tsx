import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatThread } from '@/models';
import { lightHaptic, successHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useMemo, useState } from 'react';
import {
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { Avatar, Text, TextInput } from 'react-native-paper';

interface ForwardPickerSheetProps {
  visible: boolean;
  excludeChatId?: string;
  onClose: () => void;
  onSelect: (threads: ChatThread[]) => void | Promise<void>;
}

export const ForwardPickerSheet = ({
  visible,
  excludeChatId,
  onClose,
  onSelect,
}: ForwardPickerSheetProps) => {
  const { theme, isDark } = useTheme();
  const { threads } = useChat();
  const { user } = useAuth();
  const { groups } = useGroups();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');

  const titleFor = (thread: ChatThread) => {
    if (thread.type === 'group' && thread.groupId) {
      const g = groups.find((group) => group.groupId === thread.groupId);
      return g?.name || 'Group Chat';
    }
    const other = thread.participants.find((p) => p.userId !== user?.userId) ?? thread.participants[0];
    return other?.displayName || 'Direct';
  };

  const initialsFor = (thread: ChatThread) => titleFor(thread).slice(0, 2).toUpperCase();
  const photoFor = (thread: ChatThread) => {
    if (thread.type === 'direct') {
      const other = thread.participants.find((p) => p.userId !== user?.userId);
      return other?.photoURL;
    }
    return undefined;
  };

  const filtered = useMemo(() => {
    const candidates = threads.filter((t) => t.chatId !== excludeChatId);
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((t) => titleFor(t).toLowerCase().includes(q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, excludeChatId, search, groups, user?.userId]);

  const toggle = (chatId: string) => {
    lightHaptic();
    setSelectedIds((prev) =>
      prev.includes(chatId) ? prev.filter((id) => id !== chatId) : [...prev, chatId],
    );
  };

  const handleSend = async () => {
    if (selectedIds.length === 0) return;
    const chosen = threads.filter((t) => selectedIds.includes(t.chatId));
    successHaptic();
    await onSelect(chosen);
    setSelectedIds([]);
    setSearch('');
    onClose();
  };

  const handleClose = () => {
    setSelectedIds([]);
    setSearch('');
    onClose();
  };

  const surface = isDark ? '#1a1a1f' : '#ffffff';
  const muted = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={handleClose}
    >
      <View style={styles.root}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose}>
          <View style={styles.backdrop} />
        </Pressable>
        <View style={[styles.sheet, { backgroundColor: surface }]}>
          <View style={styles.handleWrap}>
            <View style={[styles.handle, { backgroundColor: isDark ? '#555' : '#ccc' }]} />
          </View>
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.colors.onSurface }]}>Forward to</Text>
            <TouchableOpacity onPress={handleClose} hitSlop={10}>
              <Ionicons name="close" size={22} color={theme.colors.onSurfaceVariant} />
            </TouchableOpacity>
          </View>

          <View style={[styles.searchWrap, { backgroundColor: muted }]}>
            <Ionicons
              name="search"
              size={16}
              color={theme.colors.onSurfaceVariant}
              style={{ marginLeft: 12 }}
            />
            <TextInput
              mode="flat"
              dense
              placeholder="Search chats"
              value={search}
              onChangeText={setSearch}
              style={styles.searchInput}
              underlineColor="transparent"
              activeUnderlineColor="transparent"
              theme={{ colors: { background: 'transparent' } }}
            />
          </View>

          <FlatList
            data={filtered}
            keyExtractor={(item) => item.chatId}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.list}
            renderItem={({ item }) => {
              const selected = selectedIds.includes(item.chatId);
              const photo = photoFor(item);
              return (
                <TouchableOpacity
                  onPress={() => toggle(item.chatId)}
                  activeOpacity={0.7}
                  style={styles.row}
                >
                  {photo ? (
                    <Avatar.Image size={42} source={{ uri: photo }} />
                  ) : (
                    <Avatar.Text
                      size={42}
                      label={initialsFor(item)}
                      style={{ backgroundColor: theme.colors.primary }}
                      color="#fff"
                    />
                  )}
                  <View style={styles.rowText}>
                    <Text style={[styles.rowTitle, { color: theme.colors.onSurface }]} numberOfLines={1}>
                      {titleFor(item)}
                    </Text>
                    <Text style={[styles.rowSub, { color: theme.colors.onSurfaceVariant }]} numberOfLines={1}>
                      {item.type === 'group' ? 'Group' : 'Direct'}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.checkbox,
                      {
                        borderColor: selected ? theme.colors.primary : (isDark ? '#555' : '#bbb'),
                        backgroundColor: selected ? theme.colors.primary : 'transparent',
                      },
                    ]}
                  >
                    {selected && <Ionicons name="checkmark" size={14} color="#fff" />}
                  </View>
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={
              <Text style={{ textAlign: 'center', color: theme.colors.onSurfaceVariant, marginTop: 32 }}>
                No chats found
              </Text>
            }
          />

          <TouchableOpacity
            disabled={selectedIds.length === 0}
            onPress={handleSend}
            activeOpacity={0.8}
            style={[
              styles.sendButton,
              {
                backgroundColor: selectedIds.length === 0
                  ? (isDark ? '#444' : '#ccc')
                  : theme.colors.primary,
              },
            ]}
          >
            <Ionicons name="send" size={18} color="#fff" />
            <Text style={styles.sendButtonText}>
              {selectedIds.length === 0
                ? 'Select chats'
                : `Forward to ${selectedIds.length} chat${selectedIds.length === 1 ? '' : 's'}`}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 8,
    paddingBottom: Platform.OS === 'ios' ? 34 : 16,
    maxHeight: '82%',
  },
  handleWrap: { alignItems: 'center', paddingVertical: 6 },
  handle: { width: 38, height: 4, borderRadius: 2 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingTop: 6,
    paddingBottom: 12,
  },
  title: { fontSize: 18, fontWeight: '700' },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    borderRadius: 24,
    overflow: 'hidden',
  },
  searchInput: {
    flex: 1,
    backgroundColor: 'transparent',
    height: 40,
  },
  list: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 12,
  },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowSub: { fontSize: 12, marginTop: 1 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButton: {
    marginHorizontal: 16,
    marginTop: 8,
    height: 48,
    borderRadius: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  sendButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});

export default ForwardPickerSheet;
