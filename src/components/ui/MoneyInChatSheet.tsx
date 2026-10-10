// Money-in-chat admin panel (ai_layer/docs/21). Admin-gated per-group policy
// for how money surfaces in the linked chat: auto-post style, stale-debt
// nudges, who can create expenses from chat, invite links, outward sharing.
// Sheet DNA: fade scrim via the Modal, glass sheet bottom-anchored sliding up
// on a native-driver translateY; choices are STAGED and committed on Save.

import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { Group, MoneyInChatSettings } from '@/models';
import { resolveMoneyInChat } from '@/models/group';
import { appAlert } from '@/utils/appAlert';
import { lightHaptic, successHaptic } from '@/utils/haptics';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput as RNTextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassCard } from './GlassCard';
import { ScrimBackdrop } from './ScrimBackdrop';
import { SelectableChip } from './SelectableChip';

export interface MoneyInChatSheetProps {
  visible: boolean;
  group: Group;
  onClose: () => void;
}

const AUTO_POST_OPTIONS: { value: MoneyInChatSettings['autoPost']; label: string }[] = [
  { value: 'cards', label: 'Rich cards' },
  { value: 'compact', label: 'Compact lines' },
  { value: 'off', label: 'Off' },
];

const STALE_DAYS_OPTIONS = [3, 7, 14];

const CREATOR_OPTIONS: { value: MoneyInChatSettings['createFromChat']; label: string }[] = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'admins', label: 'Admins only' },
];

const CADENCE_OPTIONS: { value: MoneyInChatSettings['insights']['digestCadence']; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

const PolicySwitchRow = ({
  label,
  description,
  value,
  onValueChange,
  borderColor,
}: {
  label: string;
  description: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  borderColor: string;
}) => {
  const { theme } = useTheme();
  const toggle = () => {
    lightHaptic();
    onValueChange(!value);
  };

  return (
    <Pressable
      style={[styles.switchRow, { borderTopColor: borderColor }]}
      onPress={toggle}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value }}
    >
      <View style={styles.switchCopy}>
        <Text variant="labelMedium" style={{ color: theme.colors.onSurface }}>
          {label}
        </Text>
        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
          {description}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ true: theme.colors.primary }}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
    </Pressable>
  );
};

export const MoneyInChatSheet = ({ visible, group, onClose }: MoneyInChatSheetProps) => {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { updateMoneyInChat, updateGroupBudgets } = useGroups();

  const [staged, setStaged] = useState<MoneyInChatSettings>(resolveMoneyInChat(group.moneyInChat));
  const [budgetsDraft, setBudgetsDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Budget rows: categories seen in the group's expenses ∪ existing budgets.
  const budgetCategories = useMemo(() => {
    const cats = new Map<string, string>();
    for (const key of Object.keys(group.budgets ?? {})) cats.set(key.toLowerCase(), key);
    for (const e of group.expenses ?? []) {
      const cat = (e.category ?? '').trim();
      if (!cat || cat.toLowerCase() === 'settlement') continue;
      if (!cats.has(cat.toLowerCase())) cats.set(cat.toLowerCase(), cat);
      if (cats.size >= 8) break;
    }
    return [...cats.values()];
  }, [group.budgets, group.expenses]);

  const slide = useRef(new Animated.Value(0)).current;
  const [sheetH, setSheetH] = useState(520);
  const wasVisible = useRef(false);

  useEffect(() => {
    if (visible && !wasVisible.current) {
      setStaged(resolveMoneyInChat(group.moneyInChat));
      setBudgetsDraft(
        Object.fromEntries(Object.entries(group.budgets ?? {}).map(([k, v]) => [k, String(v)])),
      );
      slide.setValue(0);
      Animated.timing(slide, {
        toValue: 1,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
    wasVisible.current = visible;
  }, [visible, group.moneyInChat, slide]);

  const handleSave = () => {
    setSaving(true);
    const budgets: Record<string, number> = {};
    for (const [category, raw] of Object.entries(budgetsDraft)) {
      const n = Number(String(raw).replace(',', '.'));
      if (Number.isFinite(n) && n > 0) budgets[category] = n;
    }
    updateMoneyInChat(group.groupId, staged)
      .then(() => updateGroupBudgets(group.groupId, budgets))
      .then(() => {
        successHaptic();
        onClose();
      })
      .catch((error: unknown) => {
        console.warn('[MoneyInChat] Save failed:', error);
        appAlert('Could not save money settings', 'Your previous settings are still active. Try again.');
      })
      .finally(() => setSaving(false));
  };

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [sheetH + 60, 0] });
  const hairline = isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.18)';

  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay} pointerEvents="box-none">
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close Money in Chat settings"
        >
          <ScrimBackdrop pointerEvents="none" />
        </Pressable>
        <Animated.View onLayout={(e) => setSheetH(e.nativeEvent.layout.height)} style={{ transform: [{ translateY }] }}>
          <GlassCard role="floating"
            style={styles.sheet}
            contentStyle={[styles.sheetContent, { paddingBottom: insets.bottom + 10 }]}
            intensity={70}
          >
            <View style={[styles.grabber, { backgroundColor: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.2)' }]} />
            <Text variant="titleMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
              Money in chat
            </Text>
            <Text variant="bodySmall" style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
              How money shows up in this group’s chat. Applies to every member.
            </Text>

            <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 4 }}>
              <Text variant="labelMedium" style={[styles.rowLabel, { color: theme.colors.onSurface }]}>
                New expenses & settlements post as
              </Text>
              <View style={styles.chipRow}>
                {AUTO_POST_OPTIONS.map((option) => (
                  <SelectableChip
                    key={option.value}
                    label={option.label}
                    selected={staged.autoPost === option.value}
                    accessibilityRole="radio"
                    onPress={() => {
                      lightHaptic();
                      setStaged((s) => ({ ...s, autoPost: option.value }));
                    }}
                  />
                ))}
              </View>

              <PolicySwitchRow
                label="Stale-debt reminders"
                description="ManaSplit nudges the chat when a debt sits unsettled"
                value={staged.nudges.enabled}
                onValueChange={(enabled) => setStaged((s) => ({ ...s, nudges: { ...s.nudges, enabled } }))}
                borderColor={hairline}
              />
              {staged.nudges.enabled && (
                <View style={styles.chipRow}>
                  {STALE_DAYS_OPTIONS.map((days) => (
                    <SelectableChip
                      key={days}
                      label={`${days} days`}
                      selected={staged.nudges.staleDays === days}
                      accessibilityRole="radio"
                      onPress={() => {
                        lightHaptic();
                        setStaged((s) => ({ ...s, nudges: { ...s.nudges, staleDays: days } }));
                      }}
                    />
                  ))}
                </View>
              )}

              <Text
                variant="labelMedium"
                style={[styles.rowLabel, styles.rowLabelSpaced, { color: theme.colors.onSurface }]}
              >
                Who can create expenses from chat
              </Text>
              <View style={styles.chipRow}>
                {CREATOR_OPTIONS.map((option) => (
                  <SelectableChip
                    key={option.value}
                    label={option.label}
                    selected={staged.createFromChat === option.value}
                    accessibilityRole="radio"
                    onPress={() => {
                      lightHaptic();
                      setStaged((s) => ({ ...s, createFromChat: option.value }));
                    }}
                  />
                ))}
              </View>

              <PolicySwitchRow
                label="Invite links"
                description="Members can share the group invite from chat"
                value={staged.inviteLinks}
                onValueChange={(inviteLinks) => setStaged((s) => ({ ...s, inviteLinks }))}
                borderColor={hairline}
              />

              <PolicySwitchRow
                label="Share receipts outside the app"
                description="Expense and settlement cards can export as images"
                value={staged.outwardSharing}
                onValueChange={(outwardSharing) => setStaged((s) => ({ ...s, outwardSharing }))}
                borderColor={hairline}
              />

              {/* ── Insights in chat (ai_layer/docs/22) ── */}
              <Text
                variant="labelMedium"
                style={[styles.rowLabel, styles.rowLabelSpaced, { color: theme.colors.onSurface }]}
              >
                Group "wrapped" digest posts
              </Text>
              <View style={styles.chipRow}>
                {CADENCE_OPTIONS.map((option) => (
                  <SelectableChip
                    key={option.value}
                    label={option.label}
                    selected={staged.insights.digestCadence === option.value}
                    accessibilityRole="radio"
                    onPress={() => {
                      lightHaptic();
                      setStaged((s) => ({ ...s, insights: { ...s.insights, digestCadence: option.value } }));
                    }}
                  />
                ))}
              </View>

              <PolicySwitchRow
                label="Unusual-spend alerts"
                description="Post a quiet card when a spend far exceeds the usual"
                value={staged.insights.anomalyPosts}
                onValueChange={(anomalyPosts) => setStaged((s) => ({ ...s, insights: { ...s.insights, anomalyPosts } }))}
                borderColor={hairline}
              />

              <PolicySwitchRow
                label="Budget alerts"
                description="Post when a category crosses 80% or 100% of budget"
                value={staged.insights.budgetAlerts}
                onValueChange={(budgetAlerts) => setStaged((s) => ({ ...s, insights: { ...s.insights, budgetAlerts } }))}
                borderColor={hairline}
              />

              <PolicySwitchRow
                label="Fairness meter for admins only"
                description="Hide the who-pays share from non-admin members"
                value={staged.insights.fairnessAdminsOnly}
                onValueChange={(fairnessAdminsOnly) => setStaged((s) => ({ ...s, insights: { ...s.insights, fairnessAdminsOnly } }))}
                borderColor={hairline}
              />

              {/* ── Monthly category budgets ── */}
              {budgetCategories.length > 0 && (
                <>
                  <Text
                    variant="labelMedium"
                    style={[styles.rowLabel, styles.rowLabelSpaced, { color: theme.colors.onSurface }]}
                  >
                    Monthly budgets ({group.currency})
                  </Text>
                  {budgetCategories.map((category) => (
                    <View key={category} style={styles.budgetRow}>
                      <Text
                        variant="labelMedium"
                        numberOfLines={1}
                        style={[styles.budgetLabel, { color: theme.colors.onSurface }]}
                      >
                        {category}
                      </Text>
                      <RNTextInput
                        value={budgetsDraft[category] ?? ''}
                        onChangeText={(v) => setBudgetsDraft((d) => ({ ...d, [category]: v }))}
                        keyboardType="decimal-pad"
                        placeholder="no cap"
                        placeholderTextColor={theme.colors.onSurfaceVariant}
                        accessibilityLabel={`Monthly budget for ${category}`}
                        style={[
                          styles.budgetInput,
                          {
                            borderColor: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.18)',
                            color: theme.colors.onSurface,
                          },
                        ]}
                      />
                    </View>
                  ))}
                </>
              )}
            </ScrollView>

            <View
              style={[
                styles.footer,
                { borderTopColor: hairline },
              ]}
            >
              <Text
                variant="labelSmall"
                numberOfLines={2}
                style={[styles.footerSummary, { color: theme.colors.onSurfaceVariant }]}
              >
                {staged.autoPost === 'off'
                  ? 'Money stays out of this chat'
                  : `Auto-post: ${staged.autoPost === 'cards' ? 'rich cards' : 'compact lines'}${
                      staged.nudges.enabled ? ` · nudge after ${staged.nudges.staleDays}d` : ''
                    }`}
              </Text>
              <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Cancel" style={styles.cancelBtn}>
                <Text variant="labelLarge" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSave}
                disabled={saving}
                accessibilityRole="button"
                accessibilityLabel="Save Money in Chat settings"
                style={[styles.saveBtn, { backgroundColor: theme.colors.primary, opacity: saving ? 0.6 : 1 }]}
              >
                <Text variant="labelLarge" style={{ color: theme.colors.onPrimary, fontWeight: '700' }}>
                  {saving ? 'Saving…' : 'Save'}
                </Text>
              </TouchableOpacity>
            </View>
          </GlassCard>
        </Animated.View>
      </View>
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
    maxHeight: 400,
    flexGrow: 0,
  },
  rowLabel: {
    fontWeight: '600',
    marginTop: 8,
    marginBottom: 8,
  },
  rowLabelSpaced: {
    marginTop: 14,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  switchCopy: {
    flex: 1,
    gap: 1,
  },
  budgetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  budgetLabel: {
    flex: 1,
    minWidth: 0,
  },
  budgetInput: {
    width: 110,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 14,
    textAlign: 'right',
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
