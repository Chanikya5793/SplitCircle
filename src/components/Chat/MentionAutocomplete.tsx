import { GlassCard } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import type { ChatParticipant } from '@/models';
import { lightHaptic } from '@/utils/haptics';
import { resolveDisplayName, resolveInitials } from '@/utils/identity';
import { useMemo } from 'react';
import { FlatList, StyleSheet, TouchableOpacity } from 'react-native';
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
      .filter((p) => !q || resolveDisplayName(p, 'Someone').toLowerCase().includes(q))
      .slice(0, MAX_VISIBLE);
  }, [participants, query, excludeUserId]);

  if (!visible || filtered.length === 0) return null;

  const divider = isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.18)';

  return (
    <GlassCard role="floating" style={styles.root}>
      <FlatList
        data={filtered}
        keyboardShouldPersistTaps="always"
        keyExtractor={(item) => item.userId}
        renderItem={({ item, index }) => {
          const name = resolveDisplayName(item, 'Someone');
          return (
            <TouchableOpacity
              onPress={() => {
                lightHaptic();
                onSelect(item);
              }}
              activeOpacity={0.7}
              style={[
                styles.row,
                // No dividers between list items in flat mode (2026-08-07).
                index < filtered.length - 1 && theme?.surfaceStyle !== 'flat' && {
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
                  label={resolveInitials(name)}
                  style={{ backgroundColor: theme.colors.primary }}
                  labelStyle={{ fontSize: 11, lineHeight: 28 }}
                  color="#fff"
                />
              )}
              <Text style={[styles.name, { color: theme.colors.onSurface }]} numberOfLines={1}>
                {name}
              </Text>
            </TouchableOpacity>
          );
        }}
      />
    </GlassCard>
  );
};

const styles = StyleSheet.create({
  root: {
    marginHorizontal: 12,
    marginBottom: 6,
    borderRadius: 16,
    maxHeight: 220,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 12,
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
