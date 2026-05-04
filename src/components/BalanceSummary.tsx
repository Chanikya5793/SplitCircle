import { GlassView } from '@/components/GlassView';
import { colors } from '@/constants';
import { useTheme } from '@/context/ThemeContext';
import type { Group, GroupMember } from '@/models';
import { formatCurrency } from '@/utils/currency';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';


interface BalanceSummaryProps {
  group: Group;
}

export const BalanceSummary = ({ group }: BalanceSummaryProps) => {
  const { theme } = useTheme();

  const activeMembers = group.members ?? [];
  const archivedMembers = (group.archivedMembers ?? []).filter(
    (m) => Math.abs(m.balance) >= 0.005,
  );
  const allSettled =
    activeMembers.every((m) => Math.abs(m.balance) < 0.005) && archivedMembers.length === 0;

  if (allSettled) {
    return (
      <GlassView style={[styles.container, styles.settledContainer]}>
        <View style={styles.settledContent}>
          <View style={[styles.iconContainer, { backgroundColor: theme.colors.primaryContainer }]}>
            <MaterialCommunityIcons name="check-decagram" size={32} color={theme.colors.primary} />
          </View>
          <View>
            <Text variant="titleMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
              All settled up!
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              No one owes anything.
            </Text>
          </View>
        </View>
      </GlassView>
    );
  }

  const renderRow = (member: GroupMember, archived: boolean) => {
    const isSettled = Math.abs(member.balance) < 0.005;
    const amountColor = isSettled
      ? colors.success
      : member.balance > 0
        ? colors.success
        : theme.colors.error;
    const labelColor = archived ? theme.colors.onSurfaceVariant : theme.colors.onSurface;

    return (
      <View key={member.userId} style={styles.row}>
        <View style={styles.nameWrap}>
          <Text style={[styles.name, { color: labelColor }]} numberOfLines={1}>
            {member.displayName}
          </Text>
          {archived ? (
            <Text variant="labelSmall" style={[styles.formerTag, { color: theme.colors.onSurfaceVariant }]}>
              former member
            </Text>
          ) : null}
        </View>
        <Text style={[styles.amount, { color: amountColor }]}>
          {formatCurrency(member.balance, group.currency)}
        </Text>
      </View>
    );
  };

  return (
    <GlassView style={styles.container}>
      <Text variant="titleMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
        Balances
      </Text>
      {activeMembers.map((m) => renderRow(m, false))}
      {archivedMembers.map((m) => renderRow(m, true))}
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
    gap: 12,
  },
  nameWrap: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    fontWeight: '500',
  },
  formerTag: {
    fontStyle: 'italic',
    marginTop: 2,
  },
  amount: {
    fontWeight: '600',
  },
  settledContainer: {
    paddingVertical: 16,
    paddingHorizontal: 20,
    backgroundColor: 'rgba(0, 255, 0, 0.05)',
  },
  settledContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    justifyContent: 'center',
  },
  iconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
