import { colors, darkColors, spacing } from '@/constants';
import { useTheme } from '@/context/ThemeContext';
import { formatCurrency, getCurrencySymbol } from '@/utils/currency';
import { selectionHaptic } from '@/utils/haptics';
import React, { useCallback } from 'react';
import { StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { Checkbox, Text } from 'react-native-paper';
import Animated, { FadeInDown, Layout } from 'react-native-reanimated';
import type { BasicSplitMethod, Participant } from './types';

interface ParticipantRowProps {
  participant: Participant;
  index: number;
  activeMethod: BasicSplitMethod;
  currency: string;
  onToggle: (id: string) => void;
  onExactChange: (id: string, value: string) => void;
  onPercentageChange: (id: string, value: string) => void;
  onSharesChange: (id: string, value: string) => void;
  onAdjustmentChange: (id: string, value: string) => void;
}

const AVATAR_COLORS = ['#4F46E5', '#0891B2', '#059669', '#D97706', '#DC2626', '#7C3AED'];

function getInitials(name: string): string {
  return name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2);
}

export const ParticipantRow = React.memo(({
  participant: p,
  index,
  activeMethod,
  currency,
  onToggle,
  onExactChange,
  onPercentageChange,
  onSharesChange,
  onAdjustmentChange,
}: ParticipantRowProps) => {
  const { isDark, theme } = useTheme();
  const palette = isDark ? darkColors : colors;
  const avatarColor = AVATAR_COLORS[index % AVATAR_COLORS.length];

  const handleToggle = useCallback(() => {
    selectionHaptic();
    onToggle(p.id);
  }, [p.id, onToggle]);

  const renderInputForMethod = () => {
    if (!p.included) return null;

    switch (activeMethod) {
      case 'exact':
        return (
          <View style={styles.inputRow}>
            <Text style={[styles.prefix, { color: palette.muted }]}>{getCurrencySymbol(currency)}</Text>
            <TextInput
              style={[styles.input, { color: theme.colors.onSurface, borderColor: palette.border }]}
              value={p.exactAmount > 0 ? p.exactAmount.toString() : ''}
              onChangeText={(v) => onExactChange(p.id, v)}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={palette.muted}
            />
          </View>
        );
      case 'percentage':
        return (
          <View style={styles.inputRow}>
            <TextInput
              style={[styles.input, { color: theme.colors.onSurface, borderColor: palette.border }]}
              value={p.percentage > 0 ? p.percentage.toString() : ''}
              onChangeText={(v) => onPercentageChange(p.id, v)}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={palette.muted}
            />
            <Text style={[styles.suffix, { color: palette.muted }]}>%</Text>
          </View>
        );
      case 'shares':
        return (
          <View style={styles.shareControls}>
            <TouchableOpacity
              style={[styles.shareBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}
              onPress={() => {
                selectionHaptic();
                onSharesChange(p.id, Math.max(0, p.shares - 1).toString());
                

              }}
            >
              <Text style={[styles.shareBtnText, { color: theme.colors.onSurface }]}>−</Text>
            </TouchableOpacity>
            <Text style={[styles.shareValue, { color: theme.colors.onSurface }]}>{p.shares}</Text>
            <TouchableOpacity
              style={[styles.shareBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}
              onPress={() => {
                selectionHaptic();
                onSharesChange(p.id, (p.shares + 1).toString());
              }}
            >
              <Text style={[styles.shareBtnText, { color: theme.colors.onSurface }]}>+</Text>
            </TouchableOpacity>
          </View>
        );
      case 'adjustment':
        return (
          <View style={styles.inputRow}>
            <Text style={[styles.prefix, { color: palette.muted }]}>{`±${getCurrencySymbol(currency)}`}</Text>
            <TextInput
              style={[styles.input, { color: theme.colors.onSurface, borderColor: palette.border }]}
              value={p.adjustment !== 0 ? p.adjustment.toString() : ''}
              onChangeText={(v) => onAdjustmentChange(p.id, v)}
              keyboardType="numeric"
              placeholder="0.00"
              placeholderTextColor={palette.muted}
            />
          </View>
        );
      default:
        return null;
    }
  };

  return (
    <Animated.View
      entering={FadeInDown.delay(index * 40).springify()}
      layout={Layout.springify()}
    >
      <View style={[styles.row, { opacity: p.included ? 1 : 0.45 }]}>
        <TouchableOpacity onPress={handleToggle} style={styles.leftSection} activeOpacity={0.7}>
          <View style={[styles.avatar, { backgroundColor: avatarColor }]}>
            <Text style={styles.initials}>{getInitials(p.name)}</Text>
          </View>
          <View style={styles.nameCol}>
            <Text variant="bodyLarge" style={[styles.name, { color: theme.colors.onSurface }]}>
              {p.name}
            </Text>
            {p.included && p.computedAmount > 0 && (
              <Text variant="bodySmall" style={{ color: palette.muted }}>
                {formatCurrency(p.computedAmount, currency)}
              </Text>
            )}
          </View>
        </TouchableOpacity>

        <View style={styles.rightSection}>
          {renderInputForMethod()}
          <Checkbox
            status={p.included ? 'checked' : 'unchecked'}
            onPress={handleToggle}
            color={theme.colors.primary}
          />
        </View>
      </View>
    </Animated.View>
  );
});

// ── Full participant list ────────────────────────────────────────────────────
interface ParticipantListProps {
  participants: Participant[];
  activeMethod: BasicSplitMethod;
  currency: string;
  onToggle: (id: string) => void;
  onExactChange: (id: string, value: string) => void;
  onPercentageChange: (id: string, value: string) => void;
  onSharesChange: (id: string, value: string) => void;
  onAdjustmentChange: (id: string, value: string) => void;
  onSelectAll: () => void;
  allSelected: boolean;
}

export const ParticipantList = React.memo(({
  participants,
  activeMethod,
  currency,
  onToggle,
  onExactChange,
  onPercentageChange,
  onSharesChange,
  onAdjustmentChange,
  onSelectAll,
  allSelected,
}: ParticipantListProps) => {
  const { theme, isDark } = useTheme();
  const palette = isDark ? darkColors : colors;

  return (
    <View style={styles.listContainer}>
      <View style={styles.listHeader}>
        <Text variant="titleSmall" style={{ color: palette.muted, fontWeight: '600' }}>
          Split between
        </Text>
        <TouchableOpacity onPress={onSelectAll} activeOpacity={0.7}>
          <Text variant="labelMedium" style={{ color: theme.colors.primary, fontWeight: '600' }}>
            {allSelected ? 'Deselect All' : 'Select All'}
          </Text>
        </TouchableOpacity>
      </View>
      {participants.map((p, index) => (
        <ParticipantRow
          key={p.id}
          participant={p}
          index={index}
          activeMethod={activeMethod}
          currency={currency}
          onToggle={onToggle}
          onExactChange={onExactChange}
          onPercentageChange={onPercentageChange}
          onSharesChange={onSharesChange}
          onAdjustmentChange={onAdjustmentChange}
        />
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  listContainer: {
    paddingHorizontal: spacing.md,
  },
  listHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128,128,128,0.15)',
  },
  leftSection: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: {
    color: '#FFF',
    fontWeight: '700',
    fontSize: 14,
  },
  nameCol: {
    gap: 2,
  },
  name: {
    fontWeight: '600',
  },
  rightSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  prefix: {
    fontSize: 14,
    fontWeight: '500',
  },
  suffix: {
    fontSize: 14,
    fontWeight: '500',
  },
  input: {
    width: 72,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'right',
  },
  shareControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  shareBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareBtnText: {
    fontSize: 18,
    fontWeight: '600',
  },
  shareValue: {
    fontSize: 16,
    fontWeight: '700',
    minWidth: 20,
    textAlign: 'center',
  },
});
