// Personal cross-group spending dashboard (ai_layer/docs/22). Aggregates the
// user's OWN share across every visible group — amounts stay in each group's
// currency (no silent cross-currency summing). Hosts the PCC deep-analysis
// narrative (largest context tier) with the disclosed on-by-default toggle,
// and PERSONAL per-category budgets measured against your share this month.

import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { InsightChatOverlay } from '@/components/stats/InsightChatOverlay';
import { HBar } from '@/components/stats/StatsVisuals';
import { GuardedScreen } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import {
  getPccEnabled,
  narrateInsights,
  pccAvailability,
  setPccEnabled,
  type InsightNarrative,
} from '@/services/insightsAiService';
import { formatCurrency } from '@/utils/currency';
import { buildPersonalStats, RANGE_LABELS, type StatsRange } from '@/utils/statsInsights';
import { lightHaptic } from '@/utils/haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useHeaderHeight } from '@react-navigation/elements';
import { useEffect, useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Switch,
  TextInput as RNTextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Icon, Text } from 'react-native-paper';

const PERSONAL_BUDGETS_KEY = 'personal_budgets_v1';

/** `${currency}:${category}` → monthly cap on YOUR share. Private to this device. */
type PersonalBudgets = Record<string, number>;

export const PersonalStatsScreen = () => {
  const { groups } = useGroups();
  const { user } = useAuth();
  const { theme, isDark } = useTheme();
  const headerHeight = useHeaderHeight();

  const [range, setRange] = useState<StatsRange>('month');
  const [narrative, setNarrative] = useState<InsightNarrative | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [pccOn, setPccOn] = useState(true);
  const [pccStatus, setPccStatus] = useState<{ available: boolean; reason: string } | null>(null);
  const [budgets, setBudgets] = useState<PersonalBudgets>({});
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, string>>({});

  const visibleGroups = useMemo(() => (groups ?? []).filter((g) => !g.hidden), [groups]);

  const bundle = useMemo(() => {
    if (!user) return null;
    return buildPersonalStats(visibleGroups, user.userId, range, Date.now());
  }, [visibleGroups, user?.userId, range]);

  const monthBundle = useMemo(() => {
    if (!user) return null;
    return buildPersonalStats(visibleGroups, user.userId, 'month', Date.now());
  }, [visibleGroups, user?.userId]);

  useEffect(() => {
    void getPccEnabled().then(setPccOn);
    void pccAvailability().then((s) => setPccStatus({ available: s.available, reason: s.reason }));
    void AsyncStorage.getItem(PERSONAL_BUDGETS_KEY).then((raw) => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as PersonalBudgets;
        setBudgets(parsed);
        setBudgetDrafts(Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)])));
      } catch {
        // Corrupt prefs → start fresh.
      }
    });
  }, []);

  const personalFacts = useMemo(() => {
    if (!bundle || bundle.groups.length === 0) return null;
    return JSON.stringify({
      scope: 'personal',
      range,
      groups: bundle.groups.map((g) => ({ n: g.name, cur: g.currency, share: g.yourShare, count: g.count })),
      categories: bundle.categoriesByCurrency,
    });
  }, [bundle, range]);

  // Deep-analysis narrative: whole-history facts, PCC-preferred.
  useEffect(() => {
    let cancelled = false;
    setNarrative(null);
    if (!personalFacts) return;
    narrateInsights(personalFacts, { deep: true })
      .then((n) => {
        if (!cancelled) setNarrative(n);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [personalFacts]);

  const togglePcc = (next: boolean) => {
    lightHaptic();
    setPccOn(next);
    void setPccEnabled(next);
  };

  const saveBudget = (key: string, raw: string) => {
    const n = Number(raw.replace(',', '.'));
    const next = { ...budgets };
    if (Number.isFinite(n) && n > 0) next[key] = Math.round(n * 100) / 100;
    else delete next[key];
    setBudgets(next);
    void AsyncStorage.setItem(PERSONAL_BUDGETS_KEY, JSON.stringify(next)).catch(() => undefined);
  };

  const hairline = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.08)';

  // Budget rows: this month's categories per currency ∪ saved budget keys.
  const budgetRows = useMemo(() => {
    const keys = new Map<string, { currency: string; category: string; spent: number }>();
    for (const [currency, cats] of Object.entries(monthBundle?.categoriesByCurrency ?? {})) {
      for (const c of cats) {
        keys.set(`${currency}:${c.category}`, { currency, category: c.category, spent: c.yourShare });
      }
    }
    for (const key of Object.keys(budgets)) {
      if (!keys.has(key)) {
        const [currency, ...rest] = key.split(':');
        keys.set(key, { currency, category: rest.join(':'), spent: 0 });
      }
    }
    return [...keys.entries()].map(([key, v]) => ({ key, ...v, cap: budgets[key] }));
  }, [monthBundle, budgets]);

  return (
    <LiquidBackground>
      <GuardedScreen target="expenses" label="Stats hidden" duressBehavior="blank" duressLabel="Not enough activity to chart yet.">
        <ScrollView contentContainerStyle={[styles.container, { paddingTop: headerHeight + 8 }]}>
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

          {narrative && (
            <TouchableOpacity
              activeOpacity={0.88}
              onPress={() => {
                lightHaptic();
                setChatOpen(true);
              }}
              accessibilityRole="button"
              accessibilityLabel="Chat about your spending insights"
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
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                {narrative.text}
              </Text>
            </GlassView>
            </TouchableOpacity>
          )}

          <GlassView style={styles.card}>
            <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
              Your share by group
            </Text>
            {(bundle?.groups ?? []).length === 0 ? (
              <Text style={{ color: theme.colors.onSurfaceVariant }}>No spending in this range.</Text>
            ) : (
              (() => {
                const rows = bundle?.groups ?? [];
                // Bars only compare within ONE currency — mixed-currency lists
                // stay numeric-only (no silent cross-currency scaling).
                const singleCurrency = new Set(rows.map((g) => g.currency)).size === 1;
                const maxShare = rows.reduce((m, g) => Math.max(m, g.yourShare), 0);
                return rows.map((g) => (
                  <View key={g.groupId} style={styles.rowBlock}>
                    <View style={styles.row}>
                      <Text style={[styles.rowName, { color: theme.colors.onSurface }]} numberOfLines={1}>
                        {g.name}
                        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                          {'  '}×{g.count}
                        </Text>
                      </Text>
                      <Text variant="labelMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                        {formatCurrency(g.yourShare, g.currency)}
                      </Text>
                    </View>
                    {singleCurrency && (
                      <HBar value={g.yourShare} max={maxShare} color={theme.colors.chart[0]} height={5} />
                    )}
                  </View>
                ));
              })()
            )}
          </GlassView>

          {Object.entries(bundle?.categoriesByCurrency ?? {}).map(([currency, cats]) => (
            <GlassView key={currency} style={styles.card}>
              <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                Your categories · {currency}
              </Text>
              {cats.map((c) => (
                <View key={c.category} style={styles.rowBlock}>
                  <View style={styles.row}>
                    <Text style={[styles.rowName, { color: theme.colors.onSurface }]} numberOfLines={1}>
                      {c.category}
                    </Text>
                    <Text variant="labelMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                      {formatCurrency(c.yourShare, currency)}
                    </Text>
                  </View>
                  <HBar
                    value={c.yourShare}
                    max={cats[0]?.yourShare ?? 0}
                    color={theme.colors.chart[0]}
                    height={5}
                  />
                </View>
              ))}
            </GlassView>
          ))}

          {budgetRows.length > 0 && (
            <GlassView style={styles.card}>
              <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                Personal budgets (your share, this month)
              </Text>
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8 }}>
                Private to you — nobody in your groups sees these.
              </Text>
              {budgetRows.map((b) => {
                const pct = b.cap ? Math.round((b.spent / b.cap) * 100) : null;
                return (
                  <View key={b.key} style={styles.budgetRow}>
                    <View style={styles.budgetInfo}>
                      <Text variant="labelMedium" numberOfLines={1} style={{ color: theme.colors.onSurface }}>
                        {b.category} · {b.currency}
                      </Text>
                      <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                        {formatCurrency(b.spent, b.currency)}
                        {b.cap ? ` of ${formatCurrency(b.cap, b.currency)} (${pct}%)` : ' this month'}
                      </Text>
                      {b.cap != null && (
                        <View style={[styles.budgetTrack, { backgroundColor: hairline }]}>
                          <View
                            style={[
                              styles.budgetFill,
                              {
                                width: `${Math.min(100, pct ?? 0)}%`,
                                backgroundColor:
                                  (pct ?? 0) >= 100
                                    ? theme.colors.danger
                                    : (pct ?? 0) >= 80
                                      ? theme.colors.warning
                                      : theme.colors.success,
                              },
                            ]}
                          />
                        </View>
                      )}
                    </View>
                    <RNTextInput
                      value={budgetDrafts[b.key] ?? ''}
                      onChangeText={(v) => setBudgetDrafts((d) => ({ ...d, [b.key]: v }))}
                      onEndEditing={(e) => saveBudget(b.key, e.nativeEvent.text)}
                      keyboardType="decimal-pad"
                      placeholder="no cap"
                      placeholderTextColor={theme.colors.onSurfaceVariant}
                      accessibilityLabel={`Personal monthly budget for ${b.category} in ${b.currency}`}
                      style={[
                        styles.budgetInput,
                        {
                          borderColor: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.18)',
                          color: theme.colors.onSurface,
                        },
                      ]}
                    />
                  </View>
                );
              })}
            </GlassView>
          )}

          {/* PCC disclosure + kill switch */}
          <GlassView style={styles.card}>
            <View style={styles.pccRow}>
              <View style={styles.pccCopy}>
                <Text variant="labelMedium" style={{ color: theme.colors.onSurface }}>
                  Deep analysis via Private Cloud Compute
                </Text>
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  Whole-history insights run on Apple's private, stateless cloud when the on-device model
                  isn't enough.{' '}
                  {pccStatus
                    ? pccStatus.available
                      ? 'Available on this device.'
                      : `Currently unavailable (${pccStatus.reason}).`
                    : ''}
                </Text>
              </View>
              <Switch value={pccOn} onValueChange={togglePcc} trackColor={{ true: theme.colors.primary }} />
            </View>
          </GlassView>
        </ScrollView>

        {/* Personal insights chat — narrative-only (no per-group deterministic engine). */}
        {narrative && personalFacts && (
          <InsightChatOverlay
            visible={chatOpen}
            onClose={() => setChatOpen(false)}
            scope="personal"
            facts={personalFacts}
            factsForRange={(r) => {
              if (!user || r === range) return personalFacts;
              const b = buildPersonalStats(visibleGroups, user.userId, r, Date.now());
              return JSON.stringify({
                scope: 'personal',
                range: r,
                groups: b.groups.map((g) => ({ n: g.name, cur: g.currency, share: g.yourShare, count: g.count })),
                categories: b.categoriesByCurrency,
              });
            }}
            initialRange={range}
            narrative={narrative.text}
            narrativeSource={narrative.source}
            seedTitle="Your spending"
            starterPrompts={(() => {
              // Real-data openers: top category and top group by the user's share.
              const prompts: string[] = [];
              const topCat = Object.values(bundle?.categoriesByCurrency ?? {})[0]?.[0];
              if (topCat) prompts.push(`Why is ${topCat.category} my biggest category?`);
              const topGroup = bundle?.groups[0];
              if (topGroup) prompts.push(`What am I spending on in ${topGroup.name}?`);
              if (prompts.length) prompts.push('How can I spend less?');
              return prompts;
            })()}
          />
        )}
      </GuardedScreen>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 16,
    paddingBottom: 140,
    gap: 12,
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
    padding: 16,
    borderRadius: 20,
  },
  sectionTitle: {
    fontWeight: '700',
    marginBottom: 10,
  },
  aiHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  rowBlock: {
    paddingVertical: 5,
    gap: 3,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  rowName: {
    flex: 1,
    minWidth: 0,
    fontWeight: '500',
  },
  budgetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  budgetInfo: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  budgetTrack: {
    height: 5,
    borderRadius: 3,
    overflow: 'hidden',
    marginTop: 2,
  },
  budgetFill: {
    height: 5,
    borderRadius: 3,
  },
  budgetInput: {
    width: 100,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 14,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  pccRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  pccCopy: {
    flex: 1,
    gap: 2,
  },
});
