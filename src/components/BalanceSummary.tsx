import { GlassView } from '@/components/GlassView';
import { DisplayCurrencySheet } from '@/components/ui/DisplayCurrencySheet';
import { useDisplayCurrency } from '@/context/DisplayCurrencyContext';
import { useTheme } from '@/context/ThemeContext';
import type { Group, GroupMember } from '@/models';
import { useMoneyDisplay } from '@/hooks/useMoneyDisplay';
import { usePrivacyMask } from '@/hooks/usePrivacyMask';
import { formatRelativeTime } from '@/utils/format';
import { lightHaptic } from '@/utils/haptics';
import { needsDisplayName, resolveDisplayName } from '@/utils/identity';
import { useState } from 'react';
import { Pressable, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Text } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';


interface BalanceSummaryProps {
  group: Group;
}

export const BalanceSummary = ({ group }: BalanceSummaryProps) => {
  const fmtMoney = useMoneyDisplay(group.groupId);
  const { maskGroupText } = usePrivacyMask();
  const { getPref, getConversion, toggleDisplay } = useDisplayCurrency();
  const { theme } = useTheme();
  const [showCurrencySheet, setShowCurrencySheet] = useState(false);

  const base = (group.currency ?? 'USD').toUpperCase();
  const pref = getPref(group.groupId);
  const hasUsablePref = pref !== null && pref.base === base && pref.target !== base;
  const conversion = getConversion(group.groupId, base);

  // Tap the balances → flip between group currency and the chosen currency.
  // First tap with nothing configured opens the picker instead.
  const handleFlip = () => {
    lightHaptic();
    if (hasUsablePref) {
      toggleDisplay(group.groupId);
    } else {
      setShowCurrencySheet(true);
    }
  };

  const openSheet = () => {
    lightHaptic();
    setShowCurrencySheet(true);
  };

  const currencyPill = (
    <TouchableOpacity
      onPress={openSheet}
      accessibilityRole="button"
      accessibilityLabel="Choose a display currency"
      style={[styles.pill, { borderColor: theme.colors.primary }]}
    >
      <MaterialCommunityIcons name="swap-horizontal" size={14} color={theme.colors.primary} />
      <Text variant="labelSmall" style={{ color: theme.colors.primary, fontWeight: '600' }}>
        {conversion ? `≈ ${conversion.target}` : base}
      </Text>
    </TouchableOpacity>
  );

  const rateFootnote = conversion ? (
    <TouchableOpacity onPress={openSheet} accessibilityRole="button" accessibilityLabel="Change the display currency or rate">
      <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
        {`Shown in ${conversion.target} · 1 ${base} = ${conversion.rate.toFixed(4)} ${conversion.target} · ${
          conversion.source === 'custom'
            ? 'your custom rate'
            : conversion.stale && conversion.fetchedAt
              ? `ECB rate cached ${formatRelativeTime(conversion.fetchedAt)} (offline)`
              : conversion.fetchedAt
                ? `ECB rate, updated ${formatRelativeTime(conversion.fetchedAt)}`
                : 'ECB rate'
        }`}
      </Text>
    </TouchableOpacity>
  ) : null;

  const sheet = (
    <DisplayCurrencySheet
      visible={showCurrencySheet}
      group={group}
      onClose={() => setShowCurrencySheet(false)}
    />
  );

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
      ? theme.colors.moneyNeutral
      : member.balance > 0
        ? theme.colors.moneyPositive
        : theme.colors.moneyNegative;
    const isPlaceholder = needsDisplayName(member);
    const labelColor = archived || isPlaceholder ? theme.colors.onSurfaceVariant : theme.colors.onSurface;

    return (
      <View key={member.userId} style={styles.row}>
        <View style={styles.nameWrap}>
          <Text
            style={[styles.name, { color: labelColor }, isPlaceholder && styles.placeholderName]}
            numberOfLines={1}
          >
            {maskGroupText(resolveDisplayName(member), group.groupId, 'person')}
          </Text>
          {archived ? (
            <Text variant="labelSmall" style={[styles.formerTag, { color: theme.colors.onSurfaceVariant }]}>
              former member
            </Text>
          ) : null}
        </View>
        <Text style={[styles.amount, { color: amountColor }]}>
          {fmtMoney(member.balance, group.currency)}
        </Text>
      </View>
    );
  };

  return (
    <GlassView style={styles.container}>
      <Pressable
        onPress={handleFlip}
        accessibilityRole="button"
        accessibilityLabel={
          conversion
            ? `Balances shown in ${conversion.target}. Tap to show ${base}.`
            : `Balances shown in ${base}. Tap to view in another currency.`
        }
      >
        <View style={styles.headerRow}>
          <Text variant="titleMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
            Balances
          </Text>
          {currencyPill}
        </View>
        {activeMembers.map((m) => renderRow(m, false))}
        {archivedMembers.map((m) => renderRow(m, true))}
        {rateFootnote}
      </Pressable>
      {sheet}
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
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    marginBottom: 6,
  },
  nameWrap: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    fontWeight: '500',
  },
  placeholderName: {
    fontStyle: 'italic',
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
