import { GlassView } from '@/components/GlassView';
import { colors } from '@/constants';
import { useTheme } from '@/context/ThemeContext';
import type { Group } from '@/models';
import { formatCurrency } from '@/utils/currency';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

interface BalanceSummaryProps {
  group: Group;
}

export const BalanceSummary = ({ group }: BalanceSummaryProps) => {
  const { theme } = useTheme();

  return (
    <GlassView style={styles.container}>
      <Text variant="titleMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
        Balances
      </Text>
      {group.members.map((member) => (
        <View key={member.userId} style={styles.row}>
          <Text style={[styles.name, { color: theme.colors.onSurface }]}>{member.displayName}</Text>
          <Text style={[styles.amount, member.balance >= 0 ? styles.positive : { color: theme.colors.error }]}>
            {formatCurrency(member.balance, group.currency)}
          </Text>
        </View>
      ))}
    </GlassView>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 10,
    gap: 6,
    borderRadius: 16,
  },
  title: {
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  name: {
    fontWeight: '500',
  },
  amount: {
    fontWeight: '600',
  },
  positive: {
    color: colors.success,
  },
});
