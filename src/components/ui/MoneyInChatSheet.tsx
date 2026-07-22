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
      .catch((error: unknown) =>
        appAlert('Money in chat', error instanceof Error ? error.message : 'Could not save settings.'),
      )
      .finally(() => setSaving(false));
  };

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [sheetH + 60, 0] });
  const hairline = isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.18)';

  const chip = (selected: boolean) => [
    styles.chip,
    {
      borderColor: selected ? theme.colors.primary : hairline,
      backgroundColor: selected ? `${theme.colors.primary}1f` : 'transparent',
    },
  ];
  const chipText = (selected: boolean) => ({
    color: selected ? theme.colors.primary : theme.colors.onSurfaceVariant,
    fontWeight: selected ? ('700' as const) : ('500' as const),
  });

  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay} pointerEvents="box-none">
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close Money in Chat settings" />
        <Animated.View onLayout={(e) => setSheetH(e.nativeEvent.layout.height)} style={{ transform: [{ translateY }] }}>
          <GlassCard
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
                  <TouchableOpacity
                    key={option.value}
                    onPress={() => {
                      lightHaptic();
                      setStaged((s) => ({ ...s, autoPost: option.value }));
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Auto-post: ${option.label}`}
                    style={chip(staged.autoPost === option.value)}
                  >
                    <Text variant="labelMedium" style={chipText(staged.autoPost === option.value)}>
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={[styles.switchRow, { borderTopColor: hairline }]}>
                <View style={styles.switchCopy}>
                  <Text variant="labelMedium" style={{ color: theme.colors.onSurface }}>
                    Stale-debt reminders
                  </Text>
                  <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    ManaSplit nudges the chat when a debt sits unsettled
                  </Text>
                </View>
                <Switch
                  value={staged.nudges.enabled}
                  onValueChange={(enabled) => {
                    lightHaptic();
                    setStaged((s) => ({ ...s, nudges: { ...s.nudges, enabled } }));
                  }}
                  trackColor={{ true: theme.colors.primary }}
                />
              </View>
              {staged.nudges.enabled && (
                <View style={styles.chipRow}>
                  {STALE_DAYS_OPTIONS.map((days) => (
                    <TouchableOpacity
                      key={days}
                      onPress={() => {
                        lightHaptic();
                        setStaged((s) => ({ ...s, nudges: { ...s.nudges, staleDays: days } }));
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`Remind after ${days} days`}
                      style={chip(staged.nudges.staleDays === days)}
                    >
                      <Text variant="labelMedium" style={chipText(staged.nudges.staleDays === days)}>
                        {days} days
                      </Text>
                    </TouchableOpacity>
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
                  <TouchableOpacity
                    key={option.value}
                    onPress={() => {
                      lightHaptic();
                      setStaged((s) => ({ ...s, createFromChat: option.value }));
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Create from chat: ${option.label}`}
                    style={chip(staged.createFromChat === option.value)}
                  >
                    <Text variant="labelMedium" style={chipText(staged.createFromChat === option.value)}>
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={[styles.switchRow, { borderTopColor: hairline }]}>
                <View style={styles.switchCopy}>
                  <Text variant="labelMedium" style={{ color: theme.colors.onSurface }}>
                    Invite links
                  </Text>
                  <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    Members can share the group invite from chat
                  </Text>
                </View>
                <Switch
                  value={staged.inviteLinks}
                  onValueChange={(inviteLinks) => {
                    lightHaptic();
                    setStaged((s) => ({ ...s, inviteLinks }));
                  }}
                  trackColor={{ true: theme.colors.primary }}
                />
              </View>

              <View style={[styles.switchRow, { borderTopColor: hairline }]}>
                <View style={styles.switchCopy}>
                  <Text variant="labelMedium" style={{ color: theme.colors.onSurface }}>
                    Share receipts outside the app
                  </Text>
                  <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    Expense/settlement cards can export as images
                  </Text>
                </View>
                <Switch
                  value={staged.outwardSharing}
                  onValueChange={(outwardSharing) => {
                    lightHaptic();
                    setStaged((s) => ({ ...s, outwardSharing }));
                  }}
                  trackColor={{ true: theme.colors.primary }}
                />
              </View>

              {/* ── Insights in chat (ai_layer/docs/22) ── */}
              <Text
                variant="labelMedium"
                style={[styles.rowLabel, styles.rowLabelSpaced, { color: theme.colors.onSurface }]}
              >
                Group "wrapped" digest posts
              </Text>
              <View style={styles.chipRow}>
                {CADENCE_OPTIONS.map((option) => (
                  <TouchableOpacity
                    key={option.value}
                    onPress={() => {
                      lightHaptic();
                      setStaged((s) => ({ ...s, insights: { ...s.insights, digestCadence: option.value } }));
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Digest cadence: ${option.label}`}
                    style={chip(staged.insights.digestCadence === option.value)}
                  >
                    <Text variant="labelMedium" style={chipText(staged.insights.digestCadence === option.value)}>
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={[styles.switchRow, { borderTopColor: hairline }]}>
                <View style={styles.switchCopy}>
                  <Text variant="labelMedium" style={{ color: theme.colors.onSurface }}>
                    Unusual-spend alerts
                  </Text>
                  <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    Post a quiet card when a spend far exceeds the usual
                  </Text>
                </View>
                <Switch
                  value={staged.insights.anomalyPosts}
                  onValueChange={(anomalyPosts) => {
                    lightHaptic();
                    setStaged((s) => ({ ...s, insights: { ...s.insights, anomalyPosts } }));
                  }}
                  trackColor={{ true: theme.colors.primary }}
                />
              </View>

              <View style={[styles.switchRow, { borderTopColor: hairline }]}>
                <View style={styles.switchCopy}>
                  <Text variant="labelMedium" style={{ color: theme.colors.onSurface }}>
                    Budget alerts
                  </Text>
                  <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    Post when a category crosses 80% / 100% of budget
                  </Text>
                </View>
                <Switch
                  value={staged.insights.budgetAlerts}
                  onValueChange={(budgetAlerts) => {
                    lightHaptic();
                    setStaged((s) => ({ ...s, insights: { ...s.insights, budgetAlerts } }));
                  }}
                  trackColor={{ true: theme.colors.primary }}
                />
              </View>

              <View style={[styles.switchRow, { borderTopColor: hairline }]}>
                <View style={styles.switchCopy}>
                  <Text variant="labelMedium" style={{ color: theme.colors.onSurface }}>
                    Fairness meter admins-only
                  </Text>
                  <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    Hide the who-pays share from non-admin members
                  </Text>
                </View>
                <Switch
                  value={staged.insights.fairnessAdminsOnly}
                  onValueChange={(fairnessAdminsOnly) => {
                    lightHaptic();
                    setStaged((s) => ({ ...s, insights: { ...s.insights, fairnessAdminsOnly } }));
                  }}
                  trackColor={{ true: theme.colors.primary }}
                />
              </View>

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

            <View style={[styles.footer, { borderTopColor: hairline }]}>
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
    backgroundColor: 'rgba(0,0,0,0.45)', // scrim — fades with the Modal
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
  chip: {
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
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
