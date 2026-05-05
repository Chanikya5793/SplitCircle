import { useTheme } from '@/context/ThemeContext';
import type { ReactionMap } from '@/models';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Text } from 'react-native-paper';

interface ReactionsRowProps {
  reactions?: ReactionMap;
  currentUserId?: string;
  align?: 'left' | 'right';
  onPress?: () => void;
}

export const ReactionsRow = ({ reactions, currentUserId, align = 'left', onPress }: ReactionsRowProps) => {
  const { theme, isDark } = useTheme();

  if (!reactions) return null;
  const entries = Object.entries(reactions).filter(([, users]) => users.length > 0);
  if (entries.length === 0) return null;

  const total = entries.reduce((sum, [, users]) => sum + users.length, 0);
  const minePresent = currentUserId && entries.some(([, users]) => users.includes(currentUserId));

  const bg = minePresent
    ? (isDark ? 'rgba(53,198,255,0.18)' : 'rgba(31,111,235,0.12)')
    : (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)');
  const border = minePresent
    ? theme.colors.primary
    : (isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.08)');

  return (
    <View style={[styles.row, align === 'right' ? styles.alignRight : styles.alignLeft]}>
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={onPress}
        style={[styles.chip, { backgroundColor: bg, borderColor: border }]}
      >
        {entries.slice(0, 3).map(([emoji]) => (
          <Text key={emoji} style={styles.emoji}>{emoji}</Text>
        ))}
        {total > 1 && (
          <Text style={[styles.count, { color: theme.colors.onSurface }]}>{total}</Text>
        )}
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    marginTop: -4,
    marginBottom: 4,
  },
  alignLeft: { justifyContent: 'flex-start', paddingLeft: 8 },
  alignRight: { justifyContent: 'flex-end', paddingRight: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  emoji: {
    fontSize: 13,
  },
  count: {
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 3,
  },
});

export default ReactionsRow;
