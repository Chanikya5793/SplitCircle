/**
 * OfflineSyncScreen — a transparent look at connectivity and the on-device write
 * queue (Settings → Offline sync).
 *
 * SplitCircle keeps working offline: the Firebase JS SDK caches reads in memory,
 * outgoing chat messages are queued (messageQueueService), and every create
 * (add expense / settle up) is mirrored into a durable on-device outbox
 * (services/outbox) that replays on reconnect. This screen surfaces the live
 * connection state and how many writes are still waiting to sync, so the user
 * can trust that nothing is lost while offline. Everything shown is real —
 * connectivity comes from NetInfo (useOfflineSync) and the pending count is read
 * straight from the outbox; no placeholder stats.
 */

import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { SETTING_IDS } from '@/constants/settingsRegistry';
import { useTheme } from '@/context/ThemeContext';
import { useOfflineSync } from '@/hooks/useOfflineSync';
import { loadOutbox } from '@/services/outbox';
import type { OutboxOp } from '@/utils/outboxApply';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// How often to re-read the durable outbox while this screen is focused, so the
// pending count reflects writes that flush in the background.
const OUTBOX_POLL_MS = 4000;
// While online, restamp "last online" on this cadence so that — if the device
// drops offline — the timestamp reflects roughly when the connection was last
// confirmed rather than only the moment it first connected.
const ONLINE_STAMP_MS = 30000;

const describeOp = (op: OutboxOp): { title: string; icon: string } => {
  switch (op.kind) {
    case 'addExpense':
      return { title: op.expense?.title?.trim() || 'New expense', icon: 'receipt-text-outline' };
    case 'settleUp':
      return { title: 'Settle up payment', icon: 'handshake-outline' };
    default:
      return { title: 'Pending change', icon: 'cloud-upload-outline' };
  }
};

export const OfflineSyncScreen = () => {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { isOnline } = useOfflineSync();
  const navigation = useNavigation();
  const route = useRoute<any>();

  const [pending, setPending] = useState<OutboxOp[]>([]);
  const [lastOnlineAt, setLastOnlineAt] = useState<number | null>(null);

  // Deep-link highlight: search results land here with a `highlight` param.
  // This screen has a single registry entry (the screen itself), so the pulse
  // tints the connectivity card at the top to confirm where the user landed.
  const highlightOpacity = useRef(new Animated.Value(0)).current;
  const [highlightActive, setHighlightActive] = useState(false);

  useEffect(() => {
    const target = route.params?.highlight as string | undefined;
    if (target !== SETTING_IDS.offlineSync) return;
    const timer = setTimeout(() => {
      setHighlightActive(true);
      highlightOpacity.setValue(0.18);
      Animated.timing(highlightOpacity, {
        toValue: 0,
        duration: 1600,
        delay: 400,
        useNativeDriver: false,
      }).start(({ finished }) => {
        if (finished) setHighlightActive(false);
      });
      (navigation as any).setParams({ highlight: undefined });
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params?.highlight]);

  const refreshPending = useCallback(async () => {
    try {
      setPending(await loadOutbox());
    } catch {
      // Best-effort: keep the previous count if the read fails.
    }
  }, []);

  // Poll the outbox while focused so the pending list stays current as the
  // background flush drains it.
  useFocusEffect(
    useCallback(() => {
      void refreshPending();
      const timer = setInterval(() => void refreshPending(), OUTBOX_POLL_MS);
      return () => clearInterval(timer);
    }, [refreshPending]),
  );

  // Track when we were last confirmed online (honest, not fabricated): stamp on
  // connect and periodically while the connection holds. Only shown when offline.
  useEffect(() => {
    if (!isOnline) return;
    setLastOnlineAt(Date.now());
    const timer = setInterval(() => setLastOnlineAt(Date.now()), ONLINE_STAMP_MS);
    return () => clearInterval(timer);
  }, [isOnline]);

  const statusColor = isOnline ? theme.colors.success : theme.colors.warning;
  const pendingCount = pending.length;
  const allSynced = pendingCount === 0;

  return (
    <LiquidBackground>
      <ScrollView contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 24 }]}>
        {/* Connectivity ------------------------------------------------------ */}
        <View>
          <GlassView style={styles.card}>
            <View style={styles.row}>
              <View style={[styles.statusIcon, { backgroundColor: `${statusColor}22`, borderRadius: theme.radius.pill }]}>
                <Icon source={isOnline ? 'cloud-check-outline' : 'cloud-off-outline'} size={22} color={statusColor} />
              </View>
              <View style={styles.rowCopy}>
                <Text variant="titleMedium" style={{ fontWeight: '700', color: theme.colors.onSurface }}>
                  {isOnline ? 'Online' : 'Offline'}
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                  {isOnline
                    ? 'Connected — changes sync as you make them.'
                    : lastOnlineAt
                      ? `No connection. Last online at ${new Date(lastOnlineAt).toLocaleTimeString()}.`
                      : 'No connection. Changes are saved on this device.'}
                </Text>
              </View>
            </View>
          </GlassView>
          {highlightActive ? (
            <Animated.View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: theme.colors.primary, borderRadius: 18, opacity: highlightOpacity },
              ]}
            />
          ) : null}
        </View>

        {/* Pending changes --------------------------------------------------- */}
        <GlassView style={styles.card}>
          <View style={[styles.row, { justifyContent: 'space-between' }]}>
            <Text variant="titleSmall" style={{ fontWeight: '700', color: theme.colors.onSurface }}>
              Pending changes
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {allSynced ? 'All synced' : `${pendingCount} waiting`}
            </Text>
          </View>

          {allSynced ? (
            <View style={[styles.row, { marginTop: 10 }]}>
              <Icon source="check-circle-outline" size={18} color={theme.colors.success} />
              <Text variant="bodySmall" style={{ flex: 1, color: theme.colors.onSurfaceVariant }}>
                Everything on this device has been synced to the cloud.
              </Text>
            </View>
          ) : (
            <View style={{ marginTop: 10, gap: 10 }}>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                These changes are saved on this device and will sync automatically
                {isOnline ? ' shortly.' : ' once you reconnect.'}
              </Text>
              {pending.map((op) => {
                const { title, icon } = describeOp(op);
                return (
                  <View key={op.id} style={styles.pendingRow}>
                    <Icon source={icon} size={18} color={theme.colors.primary} />
                    <Text variant="bodyMedium" style={{ flex: 1, color: theme.colors.onSurface }} numberOfLines={1}>
                      {title}
                    </Text>
                    <Icon source="progress-upload" size={16} color={theme.colors.onSurfaceVariant} />
                  </View>
                );
              })}
            </View>
          )}
        </GlassView>

        {/* What works offline ------------------------------------------------ */}
        <GlassView style={styles.card}>
          <Text variant="titleSmall" style={{ fontWeight: '700', color: theme.colors.onSurface }}>
            What works offline
          </Text>
          <View style={{ marginTop: 12, gap: 12 }}>
            {[
              {
                icon: 'message-processing-outline',
                title: 'Messages are queued',
                body: 'Messages you send while offline are held on this device and delivered when you reconnect.',
              },
              {
                icon: 'receipt-text-outline',
                title: 'Expenses & settlements are saved',
                body: 'New expenses and settle-ups are written to a durable on-device queue and synced automatically.',
              },
              {
                icon: 'database-outline',
                title: 'Your data stays readable',
                body: 'Groups, expenses, and chats stay available from the local cache even with no connection.',
              },
            ].map((item) => (
              <View key={item.title} style={styles.infoRow}>
                <Icon source={item.icon} size={20} color={theme.colors.primary} />
                <View style={styles.rowCopy}>
                  <Text variant="bodyMedium" style={{ fontWeight: '600', color: theme.colors.onSurface }}>
                    {item.title}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2, lineHeight: 18 }}>
                    {item.body}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </GlassView>
      </ScrollView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  // Tightened 12 -> 8 (2026-08-07, compact density pass).
  container: { padding: 16, gap: 8 },
  card: { borderRadius: 18, padding: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowCopy: { flex: 1 },
  statusIcon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  pendingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
});

export default OfflineSyncScreen;
