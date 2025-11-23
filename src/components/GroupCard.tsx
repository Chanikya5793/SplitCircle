import { GlassView } from '@/components/GlassView';
import { colors } from '@/constants';
import type { Group } from '@/models';
import { formatCurrency } from '@/utils/currency';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Avatar, IconButton, Text } from 'react-native-paper';

interface GroupCardProps {
  group: Group;
  onPress?: () => void;
}

export const GroupCard = ({ group, onPress }: GroupCardProps) => {
  const total = group.expenses.reduce((sum, expense) => sum + expense.amount, 0);
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.8}>
      <GlassView style={styles.container}>
        <View style={styles.header}>
          <Avatar.Text size={48} label={group.name.slice(0, 2).toUpperCase()} style={{ backgroundColor: 'rgba(103, 80, 164, 0.1)' }} color="#6750A4" />
          <View style={styles.meta}>
            <Text variant="titleMedium" style={{ fontWeight: 'bold' }}>{group.name}</Text>
            <Text variant="bodySmall" style={styles.subtitle}>
              {group.members.length} members · {group.currency}
            </Text>
          </View>
          <IconButton icon="chevron-right" onPress={onPress} accessibilityLabel="Open group" />
        </View>
        <Text variant="bodyMedium" style={styles.total}>
          Total spent {formatCurrency(total, group.currency)}
        </Text>
      </GlassView>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  container: {
    borderRadius: 24,
    padding: 16,
    marginBottom: 12,
    marginHorizontal: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  meta: {
    flex: 1,
    marginLeft: 12,
  },
  subtitle: {
    color: colors.muted,
  },
  total: {
    marginTop: 12,
    fontWeight: '600',
    textAlign: 'right',
    color: '#6750A4',
  },
});
