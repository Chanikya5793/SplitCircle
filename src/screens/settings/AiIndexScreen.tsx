/**
 * AiIndexScreen — transparency for the on-device AI index (Settings → On-Device AI).
 *
 * Shows what's indexed on the device (per-group expense/settlement counts), how
 * exact calculations differ from optional Private Cloud narration, the Apple
 * Intelligence status for conversational chat, and a Rebuild action. The index
 * is the deterministic analytics persisted in SQLite (see `aiIndexStore`) — it
 * survives app restarts and is recomputed only when a group changes. Freshness,
 * the index version, and the on-disk footprint are surfaced so users can see it.
 */

import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { GuardedScreen } from '@/components/ui';
import { ROUTES } from '@/constants';
import { useNavigation } from '@react-navigation/native';
import { useAuth } from '@/context/AuthContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import { getOnDeviceAiAvailability, ON_DEVICE_UNAVAILABLE_COPY } from '@/services/onDeviceAiService';
import { clearFixtures } from '@/services/aiFeedbackService';
import { getIndexStoreEntries, getIndexStoreFootprint } from '@/services/aiIndexStore';
import { buildIndexStatus, type IndexStatus } from '@/utils/aiIndexStatus';
import {
  clearAnalyticsCache,
  computeIndexMeta,
  getGroupAnalytics,
  INDEX_VERSION,
  isIndexFresh,
} from '@/utils/expenseAnalytics';
import { mediumHaptic, successHaptic } from '@/utils/haptics';
import { AI_CONVERSATIONAL_ACTIVE_COPY, AI_INDEX_PRIVACY_COPY } from '@/utils/aiDisclosure';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button, Icon, Text } from 'react-native-paper';
import { appAlert } from '@/utils/appAlert';

/** Human-readable byte size for the storage footprint line. */
const formatBytes = (bytes: number): string =>
  bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;

export const AiIndexScreen = () => {
  const { theme } = useTheme();
  const navigation = useNavigation();
  const { user } = useAuth();
  const { groups } = useGroups();
  const userId = user?.userId ?? '';
  const availability = getOnDeviceAiAvailability();
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [footprint, setFootprint] = useState(0);
  const [showDetails, setShowDetails] = useState(false);

  // Index every group on-device (persisting to SQLite), then summarize from the
  // persistent store so freshness reflects what actually survives a restart.
  const reindex = useCallback(() => {
    for (const g of groups) {
      try { getGroupAnalytics(g, userId); } catch { /* never block the view */ }
    }
    const metaByGroup = new Map(groups.map((g) => [g.groupId, computeIndexMeta(g)]));
    const fresh = new Set(
      getIndexStoreEntries()
        .filter((e) => {
          if (e.userId !== userId) return false;
          const meta = metaByGroup.get(e.groupId);
          return meta ? isIndexFresh(e, meta) : false;
        })
        .map((e) => `${e.groupId}:${e.userId}`),
    );
    setStatus(buildIndexStatus(groups, userId, fresh));
    setFootprint(getIndexStoreFootprint());
  }, [groups, userId]);

  useEffect(() => { reindex(); }, [reindex]);

  const rebuild = () => {
    mediumHaptic();
    clearAnalyticsCache(); // clears session memory AND the persistent store
    reindex();
    successHaptic();
  };

  const clearSavedExamples = () => {
    appAlert('Clear saved feedback examples?', 'This removes the conversation examples saved when you rated an AI reply on this device. Your conversations and AI memory stay available.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear examples', style: 'destructive', onPress: () => {
        void (async () => {
          try {
            await clearFixtures();
            appAlert('Saved examples cleared', 'Your saved feedback examples have been removed from this device.');
          } catch {
            appAlert('Couldn’t clear examples', 'Your saved examples are unchanged. Please try again.');
          }
        })();
      } },
    ]);
  };

  const aiActive = availability === 'available';

  return (
    <LiquidBackground>
      <GuardedScreen target="expenses" label="On-device data hidden" duressBehavior="blank" duressLabel="No on-device data.">
      <ScrollView contentContainerStyle={styles.container}>
        <GlassView style={styles.card}>
          <View style={styles.row}>
            <Icon source="shield-lock-outline" size={22} color={theme.colors.primary} />
            <Text variant="titleMedium" style={{ fontWeight: '700', color: theme.colors.onSurface }}>Private by design</Text>
          </View>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 6, lineHeight: 19 }}>
            {AI_INDEX_PRIVACY_COPY}
          </Text>
        </GlassView>

        <GlassView style={styles.card}>
          <View style={styles.row}>
            <Icon source={aiActive ? 'robot-happy-outline' : 'robot-confused-outline'} size={22} color={aiActive ? theme.colors.primary : theme.colors.onSurfaceVariant} />
            <Text variant="titleSmall" style={{ fontWeight: '700', color: theme.colors.onSurface }}>Conversational AI</Text>
          </View>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 6, lineHeight: 19 }}>
            {aiActive
              ? AI_CONVERSATIONAL_ACTIVE_COPY
              : `${ON_DEVICE_UNAVAILABLE_COPY[availability]} Exact answers (spending, balances, settle-up) still work on this device without it.`}
          </Text>
        </GlassView>

        <GlassView style={styles.card}>
          <View style={[styles.row, { justifyContent: 'space-between' }]}>
            <Text variant="titleSmall" style={{ fontWeight: '700', color: theme.colors.onSurface }}>On-device data</Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {status ? `${status.totalExpenses} expenses · ${status.totalGroups} groups` : '…'}
            </Text>
          </View>



          <View style={{ marginTop: 10, gap: 8 }}>
            {(status?.groups ?? []).map((g) => (
              <View key={g.groupId} style={styles.groupRow}>
                <Icon source={g.cached ? 'check-circle' : 'progress-clock'} size={16} color={g.cached ? theme.colors.primary : theme.colors.onSurfaceVariant} />
                <Text variant="bodyMedium" style={{ flex: 1, color: theme.colors.onSurface }} numberOfLines={1}>{g.name}</Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  {g.expenseCount} expenses · {g.settlementCount} settlements
                </Text>
              </View>
            ))}
            {status && status.groups.length === 0 ? (
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>Your groups will appear here when you add them.</Text>
            ) : null}
          </View>

          <Button
            mode="outlined"
            icon="brain"
            onPress={() => navigation.navigate(ROUTES.APP.AI_MEMORY as never)}
            style={{ marginTop: 8, borderColor: theme.colors.outline }}
          >
            AI memory
          </Button>
          <Button mode="text" onPress={clearSavedExamples} style={{ marginTop: 8 }}>
            Clear saved feedback examples
          </Button>
          <Button mode="text" onPress={() => setShowDetails((value) => !value)} accessibilityState={{ expanded: showDetails }}>
            {showDetails ? 'Hide technical details' : 'Technical details'}
          </Button>
          {showDetails ? (
            <View style={{ gap: 8, marginTop: 8 }}>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Saved on device · v{INDEX_VERSION} · {formatBytes(footprint)}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Rebuild the local index if spending answers seem out of date. Your expenses are kept.
              </Text>
              <Button mode="outlined" icon="refresh" onPress={rebuild}>Rebuild index</Button>
              {__DEV__ ? (
                <Button mode="outlined" icon="clipboard-check-outline" onPress={() => navigation.navigate(ROUTES.APP.AI_EVALS as never)}>
                  AI evals
                </Button>
              ) : null}
            </View>
          ) : null}
        </GlassView>
      </ScrollView>
      </GuardedScreen>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  // Tightened 12 -> 8 (2026-08-07, compact density pass).
  container: { padding: 16, gap: 8 },
  card: { borderRadius: 18, padding: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  groupRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingVertical: 2 },
});

export default AiIndexScreen;
