import { useTheme } from '@/context/ThemeContext';
import type { ChatParticipant } from '@/models';
import { lightHaptic } from '@/utils/haptics';
import { useMemo } from 'react';
import { FlatList, Platform, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Avatar, Text } from 'react-native-paper';

interface MentionAutocompleteProps {
  visible: boolean;
  query: string;
  participants: ChatParticipant[];
  excludeUserId?: string;
  onSelect: (participant: ChatParticipant) => void;
}

const MAX_VISIBLE = 5;

export const MentionAutocomplete = ({
  visible,
  query,
  participants,
  excludeUserId,
  onSelect,
}: MentionAutocompleteProps) => {
  const { theme, isDark } = useTheme();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return participants
      .filter((p) => p.userId !== excludeUserId)
      .filter((p) => !q || p.displayName.toLowerCase().includes(q))
      .slice(0, MAX_VISIBLE);
  }, [participants, query, excludeUserId]);

  if (!visible || filtered.length === 0) return null;

  const surface = isDark ? '#1c1c20' : '#ffffff';
  const divider = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: surface,
          borderColor: divider,
        },
      ]}
    >
      <FlatList
        data={filtered}
        keyboardShouldPersistTaps="always"
        keyExtractor={(item) => item.userId}
        renderItem={({ item, index }) => (
          <TouchableOpacity
            onPress={() => {
              lightHaptic();
              onSelect(item);
            }}
            activeOpacity={0.7}
            style={[
              styles.row,
              index < filtered.length - 1 && {
                borderBottomColor: divider,
                borderBottomWidth: StyleSheet.hairlineWidth,
              },
            ]}
          >
            {item.photoURL ? (
              <Avatar.Image size={28} source={{ uri: item.photoURL }} />
            ) : (
              <Avatar.Text
                size={28}
                label={item.displayName.slice(0, 2).toUpperCase()}
                style={{ backgroundColor: theme.colors.primary }}
                labelStyle={{ fontSize: 11, lineHeight: 28 }}
                color="#fff"
              />
            )}
            <Text style={[styles.name, { color: theme.colors.onSurface }]} numberOfLines={1}>
              {item.displayName}
            </Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  root: {
    marginHorizontal: 12,
    marginBottom: 6,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    maxHeight: 220,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 12,
    elevation: Platform.OS === 'android' ? 4 : 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  name: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
  },
});

export default MentionAutocomplete;
