// Usage & Limits — where a person can see what their plan includes, how much
// of it they've used this period, when it comes back, what they've done over
// the last 30 days and where their Mana Credits went. Everything metered comes
// from the server (getMonetizationUsage); the activity section is computed
// from groups already on this device.
import { LiquidBackground } from '@/components/LiquidBackground';
import { HBar } from '@/components/stats/StatsVisuals';
import {
  AppButton,
  DetailScreenScaffold,
  Divider,
  GlassCard,
  SCREEN_GUTTER,
  SectionLabel,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { useAuth } from '@/context/AuthContext';
import { useGroups } from '@/context/GroupContext';
import { useMonetizationPurchases } from '@/context/MonetizationPurchaseContext';
import { useTheme } from '@/context/ThemeContext';
import type { MonetizationUsageSummary } from '@/models/monetization';
import { getMonetizationUsage } from '@/services/monetizationService';
import { lightHaptic } from '@/utils/haptics';
import {
  computeLocalActivity,
  describeLedgerItem,
  formatUsageDay,
  meterView,
  summarizeDaily,
  type MeterTone,
} from '@/utils/usagePresentation';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

const FEATURE_ICONS: Record<string, string> = {
  'advanced_split.completion': 'call-split',
  'ai.expense_on_device_turn': 'chat-processing-outline',
  'insights.advanced_report': 'creation',
  'provider.security_check': 'link-variant',
  'provider.manual_monitor_run': 'shield-search',
};

const VARIANT_LABELS: Record<string, string> = {
  itemized: 'Receipt',
  income: 'Income',
  consumption: 'Consumed',
  timeBased: 'Time',
  itemType: 'Category',
};

export const UsageScreen = () => {
  const { theme } = useTheme();
  const navigation = useNavigation<any>();
  const { user } = useAuth();
  const { groups } = useGroups();
  const { snapshot } = useMonetizationPurchases();
  const [summary, setSummary] = useState<MonetizationUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const load = useCallback(async (pull = false) => {
    if (pull) setRefreshing(true);
    try {
      setSummary(await getMonetizationUsage());
      setError(null);
    } catch (loadError) {
      console.error('[Usage] could not load usage', loadError);
      setError('Your usage could not be loaded. Check your connection and pull to refresh.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const planLabel = summary
    ? snapshot?.catalog.plans[summary.planId]?.label ?? (summary.planId === 'free' ? 'Free' : summary.planId)
    : null;
  const daily = useMemo(() => (summary ? summarizeDaily(summary.daily) : null), [summary]);
  const featureLabels = useMemo(
    () => Object.fromEntries((summary?.features ?? []).map((feature) => [feature.featureId, feature.label])),
    [summary],
  );
  const activity = useMemo(
    () => (user ? computeLocalActivity(groups ?? [], user.userId) : null),
    [groups, user],
  );

  const toneColor = (tone: MeterTone) => (
    tone === 'usedUp' ? theme.colors.danger
      : tone === 'nearLimit' ? theme.colors.warning
        : theme.colors.primary
  );

  const openPlans = () => {
    lightHaptic();
    navigation.navigate(ROUTES.APP.PLANS_AND_CREDITS, { backTitle: 'Usage' });
  };

  const selected = daily?.totals.find((entry) => entry.day === selectedDay) ?? null;

  return (
    <LiquidBackground style={styles.root}>
      <DetailScreenScaffold
        horizontalInset={SCREEN_GUTTER}
        bottomSpacing={theme.spacing.xxl}
        contentContainerStyle={styles.content}
        refreshControl={(
          <RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={theme.colors.primary} />
        )}
        showsVerticalScrollIndicator={false}
      >
        {loading && !summary ? (
          <View style={styles.loading} accessibilityLiveRegion="polite">
            <ActivityIndicator color={theme.colors.primary} />
            <Text style={{ color: theme.colors.muted }}>Loading your usage…</Text>
          </View>
        ) : null}

        {error && !summary ? (
          <GlassCard contentStyle={styles.padded}>
            <View style={styles.inlineRow}>
              <Icon source="cloud-off-outline" size={20} color={theme.colors.muted} />
              <Text style={[styles.flex, { color: theme.colors.onSurface }]}>{error}</Text>
            </View>
            <AppButton variant="secondary" compact icon="refresh" onPress={() => load(true)} style={styles.startButton}>
              Try again
            </AppButton>
          </GlassCard>
        ) : null}

        {summary ? (
          <>
            {/* Plan + balance */}
            <GlassCard contentStyle={styles.padded}>
              <View style={styles.planRow}>
                <View style={styles.flex}>
                  <Text style={[theme.typography.caption, { color: theme.colors.muted }]}>Your plan</Text>
                  <Text style={[theme.typography.headline, { color: theme.colors.onSurface }]} numberOfLines={1}>
                    {planLabel}
                  </Text>
                  {summary.validUntil ? (
                    <Text style={[theme.typography.caption, { color: theme.colors.muted }]}>
                      Active through {new Date(summary.validUntil).toLocaleDateString()}
                    </Text>
                  ) : null}
                </View>
                <View
                  style={[styles.balance, { backgroundColor: theme.colors.primaryContainer, borderRadius: theme.radius.lg }]}
                  accessible
                  accessibilityLabel={`${summary.creditBalance} Mana Credits`}
                >
                  <Text style={[styles.balanceNumber, { color: theme.colors.onPrimaryContainer }]}>
                    {summary.creditBalance.toLocaleString()}
                  </Text>
                  <Text style={[theme.typography.label, { color: theme.colors.onPrimaryContainer }]}>CREDITS</Text>
                </View>
              </View>
              {summary.access.commercialQuotaBypass ? (
                <View style={[styles.notice, { backgroundColor: theme.colors.successContainer, borderRadius: theme.radius.md }]}>
                  <Icon source="shield-check" size={16} color={theme.colors.success} />
                  <Text style={[theme.typography.caption, styles.flex, { color: theme.colors.onSurface }]}>
                    Test access is on: limits below are shown but not applied.
                  </Text>
                </View>
              ) : null}
              {summary.creditDebt > 0 ? (
                <Text style={[theme.typography.caption, { color: theme.colors.warning }]}>
                  {summary.creditDebt} refunded {summary.creditDebt === 1 ? 'credit is' : 'credits are'} settled from your next purchase.
                </Text>
              ) : null}
              <AppButton variant="secondary" compact icon="arrow-up-circle-outline" onPress={async () => openPlans()}>
                {summary.planId === 'free' ? 'See plans & credits' : 'Manage plan & credits'}
              </AppButton>
            </GlassCard>

            {/* Meters */}
            <SectionLabel>This period</SectionLabel>
            <GlassCard contentStyle={styles.list}>
              {summary.features.map((feature, index) => {
                const meter = meterView(feature, summary.serverTime);
                const color = toneColor(meter.tone);
                return (
                  <View key={feature.featureId}>
                    {index > 0 ? <Divider style={styles.meterDivider} /> : null}
                    <View
                      style={styles.meterRow}
                      accessible
                      accessibilityLabel={`${feature.label}. ${meter.headline}. ${meter.detail}.`}
                    >
                      <View style={[styles.iconBubble, { backgroundColor: theme.colors.primaryContainer }]}>
                        <Icon source={FEATURE_ICONS[feature.featureId] ?? 'counter'} size={18} color={theme.colors.primary} />
                      </View>
                      <View style={styles.flex}>
                        <View style={styles.meterHeading}>
                          <Text style={[theme.typography.body, styles.flex, { color: theme.colors.onSurface, fontWeight: '600' }]} numberOfLines={1}>
                            {feature.label}
                          </Text>
                          <Text style={[theme.typography.caption, { color: meter.tone === 'usedUp' ? theme.colors.danger : theme.colors.onSurfaceVariant, fontWeight: '600' }]}>
                            {meter.headline}
                          </Text>
                        </View>
                        {meter.fraction !== null ? (
                          <View style={styles.bar}>
                            <HBar value={meter.fraction} max={1} color={color} height={6} />
                          </View>
                        ) : null}
                        <Text style={[theme.typography.caption, { color: theme.colors.muted }]}>
                          {meter.detail}
                          {meter.tone === 'usedUp' && meter.overage ? ` · ${meter.overage}` : ''}
                        </Text>
                        {feature.previews ? (
                          <View style={styles.previews}>
                            <Text style={[theme.typography.caption, { color: theme.colors.muted }]}>
                              First use of each mode is free:
                            </Text>
                            <View style={styles.chips}>
                              {feature.previews.map((preview) => (
                                <View
                                  key={preview.variant}
                                  style={[
                                    styles.chip,
                                    {
                                      borderRadius: theme.radius.pill,
                                      borderColor: theme.colors.outlineVariant,
                                      backgroundColor: preview.claimed ? 'transparent' : theme.colors.primaryContainer,
                                    },
                                  ]}
                                  accessible
                                  accessibilityLabel={`${VARIANT_LABELS[preview.variant] ?? preview.variant}: ${preview.claimed ? 'free preview used' : 'free preview available'}`}
                                >
                                  <Icon
                                    source={preview.claimed ? 'check' : 'gift-outline'}
                                    size={12}
                                    color={preview.claimed ? theme.colors.muted : theme.colors.primary}
                                  />
                                  <Text style={[theme.typography.label, { color: preview.claimed ? theme.colors.muted : theme.colors.onPrimaryContainer }]}>
                                    {VARIANT_LABELS[preview.variant] ?? preview.variant}
                                  </Text>
                                </View>
                              ))}
                            </View>
                          </View>
                        ) : null}
                      </View>
                    </View>
                  </View>
                );
              })}
            </GlassCard>

            {/* 30-day activity */}
            {daily ? (
              <>
                <SectionLabel>Last 30 days</SectionLabel>
                <GlassCard contentStyle={styles.padded}>
                  <View style={styles.stats}>
                    <Stat value={daily.totalUses} label={daily.totalUses === 1 ? 'use' : 'uses'} />
                    <Stat value={daily.activeDays} label={daily.activeDays === 1 ? 'active day' : 'active days'} />
                    <Stat value={daily.creditsSpent} label={daily.creditsSpent === 1 ? 'credit spent' : 'credits spent'} />
                  </View>
                  {daily.totalUses > 0 ? (
                    <>
                      <View
                        style={styles.chart}
                        accessible
                        accessibilityLabel={`Daily uses over the last 30 days. ${daily.totalUses} in total${daily.busiestDay ? `, busiest on ${formatUsageDay(daily.busiestDay.day)} with ${daily.busiestDay.total}` : ''}.`}
                      >
                        {daily.totals.map((entry) => {
                          const height = daily.max > 0 ? Math.max(entry.total > 0 ? 4 : 2, (entry.total / daily.max) * 72) : 2;
                          const isSelected = entry.day === selectedDay;
                          return (
                            <Pressable
                              key={entry.day}
                              style={styles.barSlot}
                              onPress={() => setSelectedDay(isSelected ? null : entry.day)}
                              hitSlop={{ top: 12, bottom: 12 }}
                              importantForAccessibility="no"
                            >
                              <View
                                style={[
                                  styles.dayBar,
                                  {
                                    height,
                                    backgroundColor: entry.total > 0
                                      ? theme.colors.primary
                                      : theme.colors.outlineVariant,
                                    opacity: selectedDay && !isSelected ? 0.45 : 1,
                                  },
                                ]}
                              />
                            </Pressable>
                          );
                        })}
                      </View>
                      <View style={styles.axis}>
                        <Text style={[theme.typography.label, { color: theme.colors.muted }]}>
                          {formatUsageDay(daily.totals[0].day)}
                        </Text>
                        <Text style={[theme.typography.caption, { color: theme.colors.onSurfaceVariant }]}>
                          {selected
                            ? `${formatUsageDay(selected.day)}: ${selected.total} ${selected.total === 1 ? 'use' : 'uses'}`
                            : 'Tap a day for details'}
                        </Text>
                        <Text style={[theme.typography.label, { color: theme.colors.muted }]}>Today</Text>
                      </View>
                      <Divider inset={0} />
                      {daily.byFeature.map((entry) => (
                        <View key={entry.featureId} style={styles.featureTotal}>
                          <Icon source={FEATURE_ICONS[entry.featureId] ?? 'counter'} size={16} color={theme.colors.onSurfaceVariant} />
                          <Text style={[theme.typography.body, styles.flex, { color: theme.colors.onSurface }]} numberOfLines={1}>
                            {featureLabels[entry.featureId] ?? entry.featureId}
                          </Text>
                          <Text style={[theme.typography.body, { color: theme.colors.onSurface, fontWeight: '600', fontVariant: ['tabular-nums'] }]}>
                            {entry.total.toLocaleString()}
                          </Text>
                        </View>
                      ))}
                    </>
                  ) : (
                    <Text style={[theme.typography.body, { color: theme.colors.muted }]}>
                      Nothing metered yet. Advanced splits, AI messages and reports you use will show up here.
                    </Text>
                  )}
                </GlassCard>
              </>
            ) : null}

            {/* Local activity */}
            {activity ? (
              <>
                <SectionLabel>Your activity this month</SectionLabel>
                <GlassCard contentStyle={styles.padded}>
                  <View style={styles.stats}>
                    <Stat
                      value={activity.expensesThisMonth}
                      label={activity.expensesThisMonth === 1 ? 'expense paid' : 'expenses paid'}
                    />
                    <Stat
                      value={activity.settlementsThisMonth}
                      label={activity.settlementsThisMonth === 1 ? 'settle-up' : 'settle-ups'}
                    />
                    <Stat value={activity.activeGroups} label={activity.activeGroups === 1 ? 'active group' : 'active groups'} />
                  </View>
                  <Text style={[theme.typography.caption, { color: theme.colors.muted }]}>
                    {activity.expensesLastMonth > 0
                      ? `${activity.expensesLastMonth} last month. Everyday expenses, groups and settle-ups are always free.`
                      : 'Everyday expenses, groups and settle-ups are always free.'}
                  </Text>
                </GlassCard>
              </>
            ) : null}

            {/* Credit history */}
            <SectionLabel>Credit history</SectionLabel>
            <GlassCard contentStyle={summary.ledger.length > 0 ? styles.list : styles.padded}>
              {summary.ledger.length === 0 ? (
                <Text style={[theme.typography.body, { color: theme.colors.muted }]}>
                  No credit activity yet. Credits never expire, and they are only spent when you approve it.
                </Text>
              ) : summary.ledger.map((item, index) => {
                const view = describeLedgerItem(item, featureLabels);
                return (
                  <View key={item.id}>
                    {index > 0 ? <Divider inset={SCREEN_GUTTER} /> : null}
                    <View style={styles.ledgerRow} accessible accessibilityLabel={`${view.title}, ${view.amount} credits${view.note ? `, ${view.note}` : ''}`}>
                      <View style={styles.flex}>
                        <Text style={[theme.typography.body, { color: theme.colors.onSurface }]} numberOfLines={1}>
                          {view.title}
                        </Text>
                        <Text style={[theme.typography.caption, { color: theme.colors.muted }]} numberOfLines={1}>
                          {[item.createdAt ? new Date(item.createdAt).toLocaleDateString() : null, view.note]
                            .filter(Boolean)
                            .join(' · ')}
                        </Text>
                      </View>
                      <Text
                        style={[
                          theme.typography.body,
                          {
                            fontWeight: '700',
                            fontVariant: ['tabular-nums'],
                            color: view.direction === 'credit'
                              ? theme.colors.moneyPositive
                              : view.direction === 'debit' ? theme.colors.onSurface : theme.colors.muted,
                          },
                        ]}
                      >
                        {view.amount}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </GlassCard>
          </>
        ) : null}
      </DetailScreenScaffold>
    </LiquidBackground>
  );
};

const Stat = ({ value, label }: { value: number; label: string }) => {
  const { theme } = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[theme.typography.title, { color: theme.colors.onSurface, fontVariant: ['tabular-nums'] }]}>
        {value.toLocaleString()}
      </Text>
      <Text style={[theme.typography.caption, { color: theme.colors.muted }]} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  content: { gap: 4 },
  loading: { minHeight: 160, alignItems: 'center', justifyContent: 'center', gap: 10 },
  padded: { padding: 16, gap: 12 },
  list: { paddingVertical: 4 },
  inlineRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  startButton: { alignSelf: 'flex-start' },
  planRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  balance: { minWidth: 84, alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10 },
  balanceNumber: { fontSize: 22, lineHeight: 27, fontWeight: '800', fontVariant: ['tabular-nums'] },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10 },
  meterDivider: { marginLeft: 60, marginRight: 16 },
  meterRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  iconBubble: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  meterHeading: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  bar: { marginVertical: 6 },
  previews: { marginTop: 8, gap: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  stats: { flexDirection: 'row', gap: 12 },
  stat: { flex: 1, gap: 2 },
  chart: { flexDirection: 'row', alignItems: 'flex-end', height: 76, gap: 2 },
  barSlot: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  dayBar: { borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  axis: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  featureTotal: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 28 },
  ledgerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
});
