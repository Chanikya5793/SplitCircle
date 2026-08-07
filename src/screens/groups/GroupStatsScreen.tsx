// Group stats — upgraded per ai_layer/docs/22: range selector, AI/heuristic
// insight cards, trends with deltas, member breakdown + fairness meter
// (admin-gated visibility), merchants & receipt savings, forecast card, and
// budget burn bars. All money renders go through the guard/lens funnels; the
// charts scale by the display-currency rate so they agree with the totals.

import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { AiNarrativeSkeleton } from '@/components/stats/AiNarrativeSkeleton';
import { InsightChatOverlay } from '@/components/stats/InsightChatOverlay';
import {
  CategoryShareBar,
  FairnessRing,
  HBar,
  MomentumBars,
  PaceBullet,
  SpendHeatmap,
} from '@/components/stats/StatsVisuals';
import { GuardedScreen } from '@/components/ui';
import { SpendingChart } from '@/components/SpendingChart';
import { useAuth } from '@/context/AuthContext';
import { useDisplayCurrency } from '@/context/DisplayCurrencyContext';
import { useTheme } from '@/context/ThemeContext';
import { Group } from '@/models';
import { resolveMoneyInChat } from '@/models/group';
import { useMoneyDisplay } from '@/hooks/useMoneyDisplay';
import { narrateInsights, type InsightNarrative } from '@/services/insightsAiService';
import { getRecurringBillsForGroup } from '@/services/recurringBillService';
import { upsertFactByPrefix } from '@/services/aiMemoryService';
import { detectRecurringCandidates } from '@/utils/recurringDetection';
import { formatCurrency } from '@/utils/currency';
import { getGroupAnalytics } from '@/utils/expenseAnalytics';
import {
  aggregateRange,
  budgetStatus,
  buildForecast,
  buildHeuristicCards,
  buildStatsFacts,
  categoryTrends,
  dailyHeatmap,
  detectAnomalies,
  memberBreakdown,
  merchantAggregate,
  monthlyCommitment,
  rangeWindow,
  settleVelocity,
  RANGE_LABELS,
  type InsightCard,
  type StatsRange,
} from '@/utils/statsInsights';
import { lightHaptic } from '@/utils/haptics';
import { useHeaderHeight } from '@react-navigation/elements';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { PieChart } from 'react-native-chart-kit';
import { Icon, Text } from 'react-native-paper';

interface GroupStatsScreenProps {
  group: Group;
  /** Deep link (digest/insight chat cards): open the insights chat on arrival. */
  openInsightsChat?: boolean;
}

const CARD_ICONS: Record<InsightCard['kind'], string> = {
  trend: 'trending-up',
  anomaly: 'alert-circle-outline',
  forecast: 'chart-timeline-variant',
  fairness: 'scale-balance',
  savings: 'tag-heart-outline',
  budget: 'wallet-outline',
  velocity: 'clock-outline',
  recurring: 'repeat',
};

export const GroupStatsScreen = ({ group, openInsightsChat }: GroupStatsScreenProps) => {
  const fmtMoney = useMoneyDisplay(group?.groupId);
  const { getConversion } = useDisplayCurrency();
  const { user } = useAuth();
  const { theme, isDark } = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  const headerHeight = useHeaderHeight();

  const [range, setRange] = useState<StatsRange>('month');
  const [narrative, setNarrative] = useState<InsightNarrative | null>(null);
  const [narrativeLoading, setNarrativeLoading] = useState(false);
  const [aiExpanded, setAiExpanded] = useState(false);
  const [aiLineCount, setAiLineCount] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [recurringMonthly, setRecurringMonthly] = useState(0);

  const now = Date.now();
  const displayRate = group ? getConversion(group.groupId, group.currency)?.rate ?? 1 : 1;

  const settings = resolveMoneyInChat(group?.moneyInChat);
  const myRole = group?.members.find((m) => m.userId === user?.userId)?.role;
  const isAdmin = myRole === 'owner' || myRole === 'admin';
  const fairnessVisible = !settings.insights.fairnessAdminsOnly || isAdmin;

  const [billTitles, setBillTitles] = useState<string[]>([]);

  useEffect(() => {
    if (!group) return;
    getRecurringBillsForGroup(group.groupId)
      .then((bills) => {
        const monthly = monthlyCommitment(bills);
        setRecurringMonthly(monthly);
        setBillTitles(bills.map((b) => b.title));
        // Doc 26: commitments fact into the memory ledger (idempotent) so the
        // assistant reasons with the group's fixed obligations.
        if (bills.length > 0) {
          void upsertFactByPrefix(
            `group:${group.groupId}`,
            'Recurring commitments:',
            `Recurring commitments: about ${formatCurrency(monthly, group.currency)}/month across ${bills.length} recurring bill${bills.length === 1 ? '' : 's'} (${bills.map((b) => b.title).slice(0, 5).join(', ')}).`,
          );
        }
      })
      .catch(() => setRecurringMonthly(0));
  }, [group?.groupId]);

  // Deterministic bundle — cheap, recomputed with data/range changes.
  const bundle = useMemo(() => {
    if (!group || !user) return null;
    const expenses = group.expenses ?? [];
    const tf = rangeWindow(range, now);
    const aggregate = aggregateRange(expenses, tf, user.userId);
    const trends = categoryTrends(expenses, now);
    const members = memberBreakdown(expenses, group.members ?? [], tf);
    const merchants = merchantAggregate(expenses, tf);
    const forecast = buildForecast(expenses, now, recurringMonthly);
    const anomalies = detectAnomalies(expenses, now);
    const analytics = getGroupAnalytics(group, user.userId);
    const velocity = settleVelocity(group.settlements ?? [], analytics.balances, now);
    const budgets = budgetStatus(group.budgets, expenses, now);
    const heatmap = dailyHeatmap(expenses, now);
    // Doc 26 detection surface (b): the strongest not-yet-set-up pattern.
    const recurringCandidate = detectRecurringCandidates(expenses, {
      now,
      excludeKeys: billTitles,
    })[0] ?? null;
    const cards = buildHeuristicCards({
      trends,
      anomalies,
      forecast,
      fairness: fairnessVisible ? members.fairness : null,
      totalSavings: merchants.totalSavings,
      budgets,
      velocity,
      staleDays: settings.nudges.staleDays,
      recurringSuggestion: recurringCandidate,
    });
    const facts = buildStatsFacts({
      groupName: group.name,
      currency: group.currency,
      range,
      aggregate,
      trends,
      // The heuristic cards double as the chat's insight inventory + give the
      // narrative model pre-written substance (doc 23).
      headlines: cards.map((c) => ({ t: c.title, b: c.body })),
      members: members.rows,
      // Admin-gated: non-admin facts blobs carry no fairness data, so neither
      // the narrative nor the chat can leak it (doc 23).
      fairness: fairnessVisible ? members.fairness : null,
      forecast,
      anomalies,
      budgets,
      totalSavings: merchants.totalSavings,
    });
    return { aggregate, trends, members, merchants, forecast, anomalies, budgets, heatmap, cards, facts };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, user?.userId, range, recurringMonthly, billTitles, fairnessVisible, settings.nudges.staleDays]);

  // Deep link from a digest/insight chat card: open the chat once the
  // narrative (the thread's seed) has arrived. One-shot per mount.
  const deepLinkConsumed = useRef(false);
  useEffect(() => {
    if (openInsightsChat && narrative && !deepLinkConsumed.current) {
      deepLinkConsumed.current = true;
      setChatOpen(true);
    }
  }, [openInsightsChat, narrative]);

  // AI narrative tier (on-device → PCC → nothing). Heuristic cards always show.
  useEffect(() => {
    let cancelled = false;
    setNarrative(null);
    setAiExpanded(false);
    setAiLineCount(0);
    if (!bundle) {
      setNarrativeLoading(false);
      return;
    }
    setNarrativeLoading(true);
    narrateInsights(bundle.facts)
      .then((n) => {
        if (!cancelled) setNarrative(n);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setNarrativeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bundle?.facts]);

  const chartConfig = useMemo(
    () => ({
      backgroundGradientFrom: theme.colors.surface,
      backgroundGradientFromOpacity: 0,
      backgroundGradientTo: theme.colors.surface,
      backgroundGradientToOpacity: 0,
      color: (opacity = 1) => theme.colors.primary + Math.round(opacity * 255).toString(16).padStart(2, '0'),
      strokeWidth: 2,
      barPercentage: 0.5,
      useShadowColorFromDataset: false,
    }),
    [theme],
  );

  const pieData = useMemo(() => {
    if (!bundle) return [];
    return bundle.aggregate.byCategory.slice(0, 8).map((c, index) => ({
      name: c.category,
      amount: c.total * displayRate,
      color: theme.colors.chart[index % theme.colors.chart.length],
      legendFontColor: theme.colors.muted,
      legendFontSize: 13,
    }));
  }, [bundle, theme, displayRate]);

  if (!group || !bundle) {
    return (
      <View style={styles.center}>
        <Text style={{ color: theme.colors.onSurface }}>Group not found</Text>
      </View>
    );
  }

  const hairline = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.08)';
  const severityColor = (s: InsightCard['severity']) =>
    s === 'warn' ? theme.colors.warning : s === 'good' ? theme.colors.success : theme.colors.primary;

  const momentumRows = bundle.trends
    .filter((t) => t.current > 0 || t.previous > 0)
    .slice(0, 5)
    .map((t) => ({
      label: t.category,
      current: t.current,
      previous: t.previous,
      deltaPct: t.deltaPct,
      amountLabel: fmtMoney(t.current, group.currency),
    }));
  const memberBarMax = bundle.members.rows.reduce((m, r) => Math.max(m, r.paid, r.share), 0);
  const merchantMax = bundle.merchants.merchants[0]?.total ?? 0;
  const aiCollapsible = aiLineCount > 3;

  // In-chat context picker (doc 23 rev): facts for ANY range on demand —
  // range-scoped pieces recompute, month-anchored pieces reuse the bundle.
  const factsForRange = (r: StatsRange): string => {
    if (!user || r === range) return bundle.facts;
    const expenses = group.expenses ?? [];
    const tf = rangeWindow(r, Date.now());
    const aggregate = aggregateRange(expenses, tf, user.userId);
    const members = memberBreakdown(expenses, group.members ?? [], tf);
    const merchants = merchantAggregate(expenses, tf);
    return buildStatsFacts({
      groupName: group.name,
      currency: group.currency,
      range: r,
      aggregate,
      trends: bundle.trends,
      headlines: bundle.cards.map((c) => ({ t: c.title, b: c.body })),
      members: members.rows,
      fairness: fairnessVisible ? members.fairness : null,
      forecast: bundle.forecast,
      anomalies: bundle.anomalies,
      budgets: bundle.budgets,
      totalSavings: merchants.totalSavings,
    });
  };

  // Starter questions derived from the REAL heuristic cards (no canned fakes).
  const starterPrompts = bundle.cards
    .map((c) => {
      switch (c.kind) {
        case 'trend':
        case 'anomaly':
        case 'forecast':
          return `Why ${c.title.charAt(0).toLowerCase()}${c.title.slice(1)}?`;
        case 'fairness':
          return 'How do we even things out?';
        case 'velocity':
          return 'Should we settle up now?';
        case 'budget':
          return "How's the budget looking?";
        default:
          return null;
      }
    })
    .filter((p): p is string => p != null)
    .slice(0, 3);

  return (
    <LiquidBackground>
      <GuardedScreen target="expenses" entityId={group.groupId} label="Stats hidden">
        <ScrollView contentContainerStyle={[styles.container, { paddingTop: headerHeight + 8 }]}>
          {/* Range selector */}
          <View style={styles.rangeRow}>
            {(Object.keys(RANGE_LABELS) as StatsRange[]).map((r) => (
              <TouchableOpacity
                key={r}
                onPress={() => {
                  lightHaptic();
                  setRange(r);
                }}
                accessibilityRole="button"
                accessibilityLabel={`Show ${RANGE_LABELS[r]}`}
                style={[
                  styles.rangeChip,
                  {
                    borderColor: range === r ? theme.colors.primary : hairline,
                    backgroundColor: range === r ? `${theme.colors.primary}1f` : 'transparent',
                  },
                ]}
              >
                <Text
                  variant="labelMedium"
                  style={{
                    color: range === r ? theme.colors.primary : theme.colors.onSurfaceVariant,
                    fontWeight: range === r ? '700' : '500',
                  }}
                >
                  {RANGE_LABELS[r]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Headline totals */}
          <GlassView style={styles.card}>
            <View style={styles.totalsRow}>
              <View style={styles.totalCol}>
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  Group spend
                </Text>
                <Text variant="titleLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                  {fmtMoney(bundle.aggregate.total, group.currency)}
                </Text>
              </View>
              <View style={styles.totalCol}>
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  Your share
                </Text>
                <Text variant="titleLarge" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                  {fmtMoney(bundle.aggregate.userShare, group.currency)}
                </Text>
              </View>
              <View style={styles.totalCol}>
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  Expenses
                </Text>
                <Text variant="titleLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                  {bundle.aggregate.count}
                </Text>
              </View>
            </View>
            {bundle.aggregate.byCategory.length > 0 && (
              <View style={styles.shareBarBlock}>
                <CategoryShareBar
                  slices={bundle.aggregate.byCategory.map((c) => ({ label: c.category, value: c.total }))}
                />
              </View>
            )}
          </GlassView>

          {/* AI narrative (labeled by engine) */}
          {narrative ? (
            <TouchableOpacity
              activeOpacity={0.88}
              onPress={() => {
                lightHaptic();
                setChatOpen(true);
              }}
              accessibilityRole="button"
              accessibilityLabel="Chat about these insights"
            >
            <GlassView style={styles.card}>
              <View style={styles.aiHeader}>
                <Icon
                  source={narrative.source === 'pcc' ? 'cloud-lock-outline' : 'chip'}
                  size={16}
                  color={theme.colors.primary}
                />
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}>
                  {narrative.source === 'pcc' ? 'Private Cloud Compute' : 'On-device intelligence'}
                </Text>
                <Icon source="chat-outline" size={16} color={theme.colors.primary} />
              </View>
              <Text
                variant="bodyMedium"
                style={{ color: theme.colors.onSurface }}
                // First render is unclamped so onTextLayout sees the true line
                // count; after that we clamp to 3 until the user expands.
                numberOfLines={aiCollapsible && !aiExpanded ? 3 : undefined}
                onTextLayout={(e) => {
                  if (aiLineCount === 0) setAiLineCount(e.nativeEvent.lines.length);
                }}
              >
                {narrative.text}
              </Text>
              {aiCollapsible && (
                <TouchableOpacity
                  onPress={() => {
                    lightHaptic();
                    setAiExpanded((v) => !v);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={aiExpanded ? 'Show less' : 'Show more'}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text variant="labelSmall" style={{ color: theme.colors.primary, fontWeight: '600', marginTop: 4 }}>
                    {aiExpanded ? 'Less' : 'More'}
                  </Text>
                </TouchableOpacity>
              )}
            </GlassView>
            </TouchableOpacity>
          ) : (
            narrativeLoading && <AiNarrativeSkeleton />
          )}

          {/* Insight cards (deterministic — always available) */}
          {bundle.cards.length > 0 && (
            <View style={styles.cardsStack}>
              {bundle.cards.map((c) => (
                <GlassView key={c.id} style={styles.insightCard}>
                  <View style={[styles.insightIcon, { backgroundColor: `${severityColor(c.severity)}22` }]}>
                    <Icon source={CARD_ICONS[c.kind]} size={18} color={severityColor(c.severity)} />
                  </View>
                  <View style={styles.insightBody}>
                    <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                      {c.title}
                    </Text>
                    <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      {c.body}
                    </Text>
                  </View>
                  {c.amount != null && (
                    <Text variant="bodyMedium" style={{ color: severityColor(c.severity), fontWeight: '700' }}>
                      {fmtMoney(c.amount, group.currency)}
                    </Text>
                  )}
                </GlassView>
              ))}
            </View>
          )}

          {/* Momentum: this month vs last, per category */}
          {momentumRows.length > 0 && (
            <GlassView style={styles.card}>
              <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                Momentum
              </Text>
              <MomentumBars rows={momentumRows} />
            </GlassView>
          )}

          {/* Spending trend */}
          <SpendingChart expenses={group.expenses} currency={group.currency} rate={displayRate} showPieChart={false} />

          {/* Rhythm: daily heatmap over the last 12 weeks */}
          {bundle.heatmap.max > 0 && (
            <GlassView style={styles.card}>
              <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                Rhythm
              </Text>
              <SpendHeatmap data={bundle.heatmap} />
            </GlassView>
          )}

          {/* Category pie + budgets */}
          <GlassView style={styles.card}>
            <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
              By category
            </Text>
            {pieData.length > 0 ? (
              <PieChart
                data={pieData}
                width={screenWidth - 64}
                height={200}
                chartConfig={chartConfig}
                accessor={'amount'}
                backgroundColor={'transparent'}
                paddingLeft={'15'}
                center={[10, 0]}
                absolute
              />
            ) : (
              <Text style={{ color: theme.colors.onSurfaceVariant }}>No expenses in this range.</Text>
            )}
            {bundle.budgets.length > 0 && (
              <View style={styles.budgetBlock}>
                {bundle.budgets.map((b) => (
                  <View key={b.category} style={styles.budgetRow}>
                    <View style={styles.budgetHeader}>
                      <Text variant="labelMedium" style={{ color: theme.colors.onSurface }}>
                        {b.category}
                      </Text>
                      <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                        {fmtMoney(b.spent, group.currency)} / {fmtMoney(b.budget, group.currency)}
                      </Text>
                    </View>
                    <View style={[styles.budgetTrack, { backgroundColor: hairline }]}>
                      <View
                        style={[
                          styles.budgetFill,
                          {
                            width: `${Math.min(100, b.pct)}%`,
                            backgroundColor:
                              b.pct >= 100
                                ? theme.colors.danger
                                : b.pct >= 80
                                  ? theme.colors.warning
                                  : theme.colors.success,
                          },
                        ]}
                      />
                    </View>
                  </View>
                ))}
              </View>
            )}
          </GlassView>

          {/* Members + fairness */}
          <GlassView style={styles.card}>
            <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
              Who pays, who spends
            </Text>
            {bundle.members.rows.map((m) => (
              <View key={m.userId} style={styles.memberBlock}>
                <View style={styles.memberRow}>
                  <Text style={[styles.memberName, { color: theme.colors.onSurface }]} numberOfLines={1}>
                    {m.name}
                  </Text>
                  <View style={styles.memberNumbers}>
                    <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      paid {fmtMoney(m.paid, group.currency)}
                    </Text>
                    <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      spent {fmtMoney(m.share, group.currency)}
                    </Text>
                  </View>
                </View>
                <HBar value={m.paid} max={memberBarMax} color={theme.colors.chart[0]} height={5} />
                <HBar value={m.share} max={memberBarMax} color={theme.colors.chart[1]} height={5} />
              </View>
            ))}
            <View style={styles.memberLegend}>
              <View style={styles.legendChip}>
                <View style={[styles.legendDot, { backgroundColor: theme.colors.chart[0] }]} />
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  Paid
                </Text>
              </View>
              <View style={styles.legendChip}>
                <View style={[styles.legendDot, { backgroundColor: theme.colors.chart[1] }]} />
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  Spent
                </Text>
              </View>
            </View>
            {fairnessVisible && bundle.members.fairness && (
              <View style={styles.fairnessRow}>
                <FairnessRing pct={bundle.members.fairness.topPayerPct} />
                <Text
                  variant="labelSmall"
                  style={{ color: theme.colors.onSurfaceVariant, flex: 1, minWidth: 0 }}
                >
                  {bundle.members.fairness.topPayerName} fronts {bundle.members.fairness.topPayerPct}% of all
                  spend.
                </Text>
              </View>
            )}
          </GlassView>

          {/* Merchants & savings */}
          {bundle.merchants.merchants.length > 0 && (
            <GlassView style={styles.card}>
              <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                Top merchants
              </Text>
              {bundle.merchants.merchants.slice(0, 5).map((m) => (
                <View key={m.name} style={styles.memberBlock}>
                  <View style={styles.memberRow}>
                    <Text style={[styles.memberName, { color: theme.colors.onSurface }]} numberOfLines={1}>
                      {m.name}
                      <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                        {'  '}×{m.count}
                      </Text>
                    </Text>
                    <Text variant="labelMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                      {fmtMoney(m.total, group.currency)}
                    </Text>
                  </View>
                  <HBar value={m.total} max={merchantMax} color={theme.colors.chart[0]} height={5} />
                </View>
              ))}
              {bundle.merchants.totalSavings > 0 && (
                <Text variant="labelSmall" style={{ color: theme.colors.success, marginTop: 6 }}>
                  {fmtMoney(bundle.merchants.totalSavings, group.currency)} saved via receipt discounts.
                </Text>
              )}
            </GlassView>
          )}

          {/* Forecast */}
          <GlassView style={styles.card}>
            <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
              This month's trajectory
            </Text>
            <View style={styles.totalsRow}>
              <View style={styles.totalCol}>
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  So far
                </Text>
                <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                  {fmtMoney(bundle.forecast.monthToDate, group.currency)}
                </Text>
              </View>
              <View style={styles.totalCol}>
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  Projected
                </Text>
                <Text variant="titleMedium" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                  {fmtMoney(bundle.forecast.projectedTotal, group.currency)}
                </Text>
              </View>
              <View style={styles.totalCol}>
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  Last month
                </Text>
                <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                  {fmtMoney(bundle.forecast.previousMonthTotal, group.currency)}
                </Text>
              </View>
            </View>
            <PaceBullet
              monthToDate={bundle.forecast.monthToDate}
              projectedTotal={bundle.forecast.projectedTotal}
              previousMonthTotal={bundle.forecast.previousMonthTotal}
            />
            {bundle.forecast.recurringCommitted > 0 && (
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 6 }}>
                {fmtMoney(bundle.forecast.recurringCommitted, group.currency)}/month already committed to recurring
                bills.
              </Text>
            )}
          </GlassView>
        </ScrollView>

        {/* Insights chat — the narrative card, picked up as a thread (doc 23). */}
        {narrative && (
          <InsightChatOverlay
            visible={chatOpen}
            onClose={() => setChatOpen(false)}
            scope={group.groupId}
            facts={bundle.facts}
            narrative={narrative.text}
            narrativeSource={narrative.source}
            seedTitle={bundle.cards[0]?.title ?? `${group.name} insights`}
            starterPrompts={starterPrompts}
            cards={bundle.cards}
            factsForRange={factsForRange}
            initialRange={range}
            group={group}
            currentUserId={user?.userId}
          />
        )}
      </GuardedScreen>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 16,
    paddingBottom: 180,
    // Tightened 12 -> 8 (2026-08-07, compact density pass).
    gap: 8,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  rangeRow: {
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    flexWrap: 'wrap',
  },
  rangeChip: {
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
  },
  card: {
    // Tightened 16 -> 12, matching PersonalStatsScreen.
    padding: 12,
    borderRadius: 20,
  },
  sectionTitle: {
    fontWeight: '700',
    marginBottom: 10,
  },
  totalsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  totalCol: {
    flex: 1,
    gap: 2,
  },
  aiHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  cardsStack: {
    gap: 8,
  },
  insightCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 16,
  },
  insightIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  insightBody: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  budgetBlock: {
    marginTop: 12,
    gap: 10,
  },
  budgetRow: {
    gap: 4,
  },
  budgetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  budgetTrack: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  budgetFill: {
    height: 6,
    borderRadius: 3,
  },
  shareBarBlock: {
    marginTop: 14,
  },
  memberBlock: {
    paddingVertical: 5,
    gap: 3,
  },
  memberLegend: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  legendChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  fairnessRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 12,
  },
  memberRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  memberName: {
    flex: 1,
    minWidth: 0,
    fontWeight: '500',
  },
  memberNumbers: {
    flexDirection: 'row',
    gap: 10,
  },
});
