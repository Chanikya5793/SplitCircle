// Group currency conversion — pick a target currency, review the live (or
// cached-offline) exchange rate, then convert every amount in the group in
// one transaction. Admin-gated upstream; this sheet handles rate fetching,
// the confirmation dialog (rate + age + expense count), and busy states.

import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { Group } from '@/models';
import {
  COMMON_CURRENCIES,
  getExchangeRate,
} from '@/services/currencyRatesService';
import { formatRelativeTime } from '@/utils/format';
import { lightHaptic, successHaptic } from '@/utils/haptics';
import React, { useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { ActivityIndicator, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface CurrencyConvertSheetProps {
  visible: boolean;
  group: Group;
  onClose: () => void;
}

export const CurrencyConvertSheet = ({ visible, group, onClose }: CurrencyConvertSheetProps) => {
  const { theme, isDark } = useTheme();
  const { convertGroupCurrency } = useGroups();
  const insets = useSafeAreaInsets();
  const [busyCurrency, setBusyCurrency] = useState<string | null>(null);

  const surface = isDark ? '#1c1c20' : '#ffffff';
  const options = COMMON_CURRENCIES.filter((c) => c !== group.currency?.toUpperCase());

  const handlePick = async (target: string) => {
    lightHaptic();
    setBusyCurrency(target);
    try {
      const { rate, fetchedAt, stale } = await getExchangeRate(group.currency, target);
      const expenseCount = group.expenses?.length ?? 0;
      const rateLine = `1 ${group.currency} = ${rate.toFixed(4)} ${target}`;
      const ageLine = stale
        ? `Offline — using rates cached ${formatRelativeTime(fetchedAt)}.`
        : 'European Central Bank reference rate.';
      Alert.alert(
        `Convert to ${target}?`,
        `${rateLine}\n${ageLine}\n\nEvery amount in this group (${expenseCount} ${expenseCount === 1 ? 'expense' : 'expenses'}, settlements, and balances) will be converted. This can't be undone automatically.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Convert',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                try {
                  await convertGroupCurrency(group.groupId, target, rate);
                  successHaptic();
                  onClose();
                } catch (error) {
                  Alert.alert(
                    'Conversion failed',
                    error instanceof Error ? error.message : 'Please try again.',
                  );
                }
              })();
            },
          },
        ],
      );
    } catch (error) {
      Alert.alert('Exchange rate', error instanceof Error ? error.message : 'Could not fetch rates.');
    } finally {
      setBusyCurrency(null);
    }
  };

  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close currency picker" />
      <View style={[styles.sheet, { backgroundColor: surface, paddingBottom: insets.bottom + 12 }]}>
        <View style={[styles.grabber, { backgroundColor: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)' }]} />
        <Text variant="titleMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
          Convert currency
        </Text>
        <Text variant="bodySmall" style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
          Currently {group.currency} · pick the new group currency
        </Text>
        <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 8 }}>
          {options.map((code) => (
            <TouchableOpacity
              key={code}
              onPress={() => void handlePick(code)}
              disabled={busyCurrency !== null}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Convert to ${code}`}
              style={[
                styles.row,
                { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' },
              ]}
            >
              <Text variant="bodyLarge" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                {code}
              </Text>
              {busyCurrency === code ? (
                <ActivityIndicator size="small" color={theme.colors.primary} />
              ) : null}
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',  // modal scrim — intentionally scheme-independent
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 8,
    maxHeight: '65%',
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 10,
  },
  title: {
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitle: {
    textAlign: 'center',
    marginTop: 2,
    marginBottom: 8,
  },
  list: {
    paddingHorizontal: 20,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
