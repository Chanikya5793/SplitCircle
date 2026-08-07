// Display-currency lens picker. Unlike CurrencyConvertSheet (permanent,
// admin-only ledger rewrite), this only changes what THIS user sees: pick a
// currency to view the group in, optionally pin a custom rate, and every
// converted amount renders with a "≈" marker while the ledger stays untouched.
//
// Sheet DNA (DESIGN.md): fade scrim via the Modal, GLASS sheet bottom-anchored
// sliding up on a native-driver translateY. Selection is STAGED locally and
// committed on Save — per-tap context writes would re-render every converted
// amount behind the modal and read as lag.

import { useDisplayCurrency } from '@/context/DisplayCurrencyContext';
import { useTheme } from '@/context/ThemeContext';
import type { Group } from '@/models';
import {
  COMMON_CURRENCIES,
  getRateTable,
  type RateTableResult,
} from '@/services/currencyRatesService';
import { formatRelativeTime } from '@/utils/format';
import { lightHaptic, successHaptic } from '@/utils/haptics';
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput as RNTextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassCard } from './GlassCard';

export interface DisplayCurrencySheetProps {
  visible: boolean;
  group: Group;
  onClose: () => void;
}

export const DisplayCurrencySheet = ({ visible, group, onClose }: DisplayCurrencySheetProps) => {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { getPref, setDisplayCurrency, toggleDisplay } = useDisplayCurrency();

  const base = (group.currency ?? 'USD').toUpperCase();

  // Staged choice — nothing touches the context until Save.
  // null target = off (show the group currency).
  const [staged, setStaged] = useState<string | null>(null);
  const [rateText, setRateText] = useState('');
  // Whether the RATE TEXT was actually typed by the user, as opposed to
  // seeded programmatically (a fresh currency tap, or reopening the sheet).
  // This — not a numeric comparison against the live rate — is what "custom"
  // means; see isCustom below.
  const [userEditedRate, setUserEditedRate] = useState(false);
  const [table, setTable] = useState<RateTableResult | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);

  // Entrance: sheet slides UP from below while the Modal's fade brings the
  // scrim in softly (WallpaperPickerSheet pattern). Native driver only.
  const slide = useRef(new Animated.Value(0)).current;
  const [sheetH, setSheetH] = useState(520);

  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      // Seed staging from the saved pref once per open.
      const pref = getPref(group.groupId);
      const usable = pref && pref.base === base && pref.target !== base ? pref : null;
      setStaged(usable && usable.enabled ? usable.target : null);
      setRateText(usable?.customRate !== undefined ? String(usable.customRate) : '');
      setUserEditedRate(usable?.customRate !== undefined);
      setTableError(null);
      slide.setValue(0);
      Animated.timing(slide, {
        toValue: 1,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      getRateTable(base)
        .then(setTable)
        .catch((error: unknown) =>
          setTableError(error instanceof Error ? error.message : 'Could not fetch rates.'),
        );
    }
    wasVisible.current = visible;
  }, [visible, base, group.groupId, getPref, slide]);

  const liveRate = staged ? table?.rates[staged] : undefined;
  const parsedRate = Number(rateText.replace(',', '.'));
  const rateValid = Number.isFinite(parsedRate) && parsedRate > 0;
  // Only a rate the user actually typed counts as "custom". Comparing the
  // live rate against the displayed toFixed(4) value would treat the display
  // rounding itself as an edit — the rounding error routinely exceeds any
  // sane tolerance, so merely tapping a currency would falsely pin it.
  const isCustom = rateValid && userEditedRate;

  const stageTarget = (code: string) => {
    lightHaptic();
    setStaged(code);
    const live = table?.rates[code];
    setRateText(live ? live.toFixed(4) : '');
    setUserEditedRate(false);
  };

  const handleRateTextChange = (text: string) => {
    setRateText(text);
    setUserEditedRate(true);
  };

  const stageOff = () => {
    lightHaptic();
    setStaged(null);
  };

  const handleSave = () => {
    successHaptic();
    if (!staged) {
      const pref = getPref(group.groupId);
      if (pref?.enabled) toggleDisplay(group.groupId);
    } else {
      void setDisplayCurrency(group.groupId, base, staged, isCustom ? parsedRate : undefined);
    }
    onClose();
  };

  const summaryLine = !staged
    ? `Off — amounts in ${base}`
    : isCustom
      ? `≈ ${staged} · 1 ${base} = ${parsedRate} (your rate)`
      : liveRate !== undefined
        ? `≈ ${staged} · 1 ${base} = ${liveRate.toFixed(4)} (ECB${table?.stale ? ', cached' : ''})`
        : tableError
          ? `≈ ${staged} · waiting for a rate`
          : `≈ ${staged} · fetching rate…`;

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [sheetH + 60, 0] });
  const hairline = isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.18)';
  const inputBorder = isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.18)';

  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        pointerEvents="box-none"
      >
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close display currency picker" />
        <Animated.View
          onLayout={(e) => setSheetH(e.nativeEvent.layout.height)}
          style={{ transform: [{ translateY }] }}
        >
          <GlassCard role="floating"
            style={styles.sheet}
            contentStyle={[styles.sheetContent, { paddingBottom: insets.bottom + 10 }]}
            intensity={70}
          >
            <View style={[styles.grabber, { backgroundColor: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.2)' }]} />
            <Text variant="titleMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
              View in another currency
            </Text>
            <Text variant="bodySmall" style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
              Display only — everything stays recorded in {base}. Converted amounts are marked ≈.
            </Text>

            <ScrollView
              style={styles.list}
              contentContainerStyle={{ paddingBottom: 4 }}
              keyboardShouldPersistTaps="handled"
            >
              {/* Off row: the group's own currency. */}
              <TouchableOpacity
                onPress={stageOff}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`Show amounts in ${base}, the group currency`}
                style={[
                  styles.row,
                  { borderBottomColor: hairline },
                ]}
              >
                <View>
                  <Text variant="bodyLarge" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                    {base}
                  </Text>
                  <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    Group currency
                  </Text>
                </View>
                {staged === null ? <Icon source="check" size={20} color={theme.colors.primary} /> : null}
              </TouchableOpacity>

              {COMMON_CURRENCIES.filter((code) => code !== base).map((code) => (
                <TouchableOpacity
                  key={code}
                  onPress={() => stageTarget(code)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`View amounts in ${code}`}
                  style={[
                  styles.row,
                  { borderBottomColor: hairline },
                ]}
                >
                  <View>
                    <Text variant="bodyLarge" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                      {code}
                    </Text>
                    <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      {table?.rates[code]
                        ? `1 ${base} = ${table.rates[code].toFixed(4)} ${code}${table.stale ? ` · cached ${formatRelativeTime(table.fetchedAt)}` : ''}`
                        : tableError
                          ? 'Live rate unavailable'
                          : '…'}
                    </Text>
                  </View>
                  {staged === code ? <Icon source="check" size={20} color={theme.colors.primary} /> : null}
                </TouchableOpacity>
              ))}
            </ScrollView>

            {staged ? (
              <View
                style={[
                  styles.ratePanel,
                  { borderTopColor: hairline },
                ]}
              >
                <View style={styles.rateEditRow}>
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                    1 {base} =
                  </Text>
                  <RNTextInput
                    value={rateText}
                    onChangeText={handleRateTextChange}
                    keyboardType="decimal-pad"
                    accessibilityLabel="Exchange rate"
                    placeholder="rate"
                    placeholderTextColor={theme.colors.onSurfaceVariant}
                    style={[styles.rateInput, { borderColor: inputBorder, color: theme.colors.onSurface }]}
                  />
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                    {staged}
                  </Text>
                </View>
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 6 }}>
                  {isCustom
                    ? 'Custom rate — it stays pinned until you change it here.'
                    : 'ECB reference rate. Edit it to pin your own.'}
                </Text>
              </View>
            ) : null}

            {/* Docked commit bar: summary left, Cancel + Save right. */}
            <View style={[styles.footer, { borderTopColor: hairline }]}>
              <Text
                variant="labelSmall"
                numberOfLines={2}
                style={[styles.footerSummary, { color: theme.colors.onSurfaceVariant }]}
              >
                {summaryLine}
              </Text>
              <TouchableOpacity
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                style={styles.cancelBtn}
              >
                <Text variant="labelLarge" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSave}
                accessibilityRole="button"
                accessibilityLabel="Save display currency"
                style={[styles.saveBtn, { backgroundColor: theme.colors.primary }]}
              >
                <Text variant="labelLarge" style={{ color: theme.colors.onPrimary, fontWeight: '700' }}>
                  Save
                </Text>
              </TouchableOpacity>
            </View>
          </GlassCard>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)', // full-screen scrim — fades with the Modal
  },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  sheetContent: {
    paddingTop: 8,
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
    marginBottom: 6,
    paddingHorizontal: 24,
  },
  list: {
    paddingHorizontal: 20,
    maxHeight: 320,
    flexGrow: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  ratePanel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 8,
  },
  rateEditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rateInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    fontVariant: ['tabular-nums'],
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  footerSummary: {
    flex: 1,
  },
  cancelBtn: {
    paddingVertical: 10,
    paddingHorizontal: 6,
  },
  saveBtn: {
    paddingVertical: 10,
    paddingHorizontal: 22,
    borderRadius: 999,
  },
});
