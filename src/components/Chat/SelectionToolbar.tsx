import { GlassView } from '@/components/GlassView';
import { useTheme } from '@/context/ThemeContext';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Text } from 'react-native-paper';

export type SelectionAction = 'copy' | 'forward' | 'star' | 'delete' | 'deleteForEveryone';

interface SelectionToolbarProps {
  count: number;
  topInset: number;
  canDeleteForEveryone: boolean;
  canStar: boolean;
  canCopy: boolean;
  onAction: (action: SelectionAction) => void;
  onClose: () => void;
}

export const SelectionToolbar = ({
  count,
  topInset,
  canDeleteForEveryone,
  canStar,
  canCopy,
  onAction,
  onClose,
}: SelectionToolbarProps) => {
  const { theme } = useTheme();

  return (
    <View style={[styles.wrap, { paddingTop: topInset + 6 }]}>
      <GlassView style={styles.bar} intensity={50}>
        <TouchableOpacity onPress={onClose} hitSlop={10} style={styles.iconBtn}>
          <Ionicons name="close" size={22} color={theme.colors.primary} />
        </TouchableOpacity>
        <Text style={[styles.count, { color: theme.colors.onSurface }]}>{count} selected</Text>
        <View style={styles.actionsRow}>
          {canCopy && (
            <TouchableOpacity onPress={() => onAction('copy')} style={styles.actionBtn} hitSlop={6}>
              <Ionicons name="copy-outline" size={20} color={theme.colors.primary} />
            </TouchableOpacity>
          )}
          {canStar && (
            <TouchableOpacity onPress={() => onAction('star')} style={styles.actionBtn} hitSlop={6}>
              <Ionicons name="star-outline" size={20} color={theme.colors.primary} />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => onAction('forward')} style={styles.actionBtn} hitSlop={6}>
            <Ionicons name="arrow-redo" size={20} color={theme.colors.primary} />
          </TouchableOpacity>
          {canDeleteForEveryone && (
            <TouchableOpacity onPress={() => onAction('deleteForEveryone')} style={styles.actionBtn} hitSlop={6}>
              <Ionicons name="trash-bin-outline" size={20} color={theme.colors.error} />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => onAction('delete')} style={styles.actionBtn} hitSlop={6}>
            <Ionicons name="trash-outline" size={20} color={theme.colors.error} />
          </TouchableOpacity>
        </View>
      </GlassView>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 12,
    paddingBottom: 8,
    zIndex: 100,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 22,
    gap: 8,
  },
  iconBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  count: { flex: 1, fontSize: 16, fontWeight: '600', marginLeft: 4 },
  actionsRow: { flexDirection: 'row', gap: 4 },
  actionBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
  },
});

export default SelectionToolbar;
