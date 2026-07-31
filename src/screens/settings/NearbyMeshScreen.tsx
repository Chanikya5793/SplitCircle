/**
 * NearbyMeshScreen — what the offline mesh is actually doing (ai_layer/docs/33
 * §4.1 diagnostics + §4.2 topology, Phase 7).
 *
 * Every hard mesh bug this project has hit was invisible from inside the app
 * while it was happening: doc 32 §5f's queue that never flushed, §10.1's dead
 * self-sync, §10.2's mesh that collapsed on every thread change. All three were
 * reconstructed afterwards from Cloud Function logs, because the only in-app
 * signal was a single `lastMessageEvent` slot that the next event overwrote.
 * This screen is the in-app version of that evidence.
 *
 * OBSERVED, NOT AUTHORITATIVE (doc 33 §1a). It shows the links this device can
 * see right now. It is not a routing table and must never be presented as one —
 * flood routing means a message can reach a device this screen never listed.
 *
 * Nothing here is fabricated: every number comes from `getMeshDiagnostics()`,
 * which reads the live transports, the on-disk mesh queue, and the router's own
 * pending count.
 */
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useTheme } from '@/context/ThemeContext';
import {
  getMeshDiagnostics,
  subscribeToNearbyMessaging,
} from '@/services/nearbyMessageService';
import { summariseMesh, type MeshDiagnostics } from '@/services/mesh/diagnostics';
import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Neighbour state changes far more often than a person can read, so this polls
 * rather than re-rendering on every radio event. Fast enough that plugging a
 * phone in feels live, slow enough not to fight the mesh for the JS thread.
 */
const REFRESH_MS = 2000;

const TRANSPORT_LABEL: Record<string, string> = {
  mpc: 'Apple direct',
  ble: 'Bluetooth',
  lan: 'Wi-Fi',
};

const TRANSPORT_ICON: Record<string, string> = {
  mpc: 'apple',
  ble: 'bluetooth',
  lan: 'wifi',
};

const relativeTime = (at: number): string => {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
};

export const NearbyMeshScreen = () => {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [diagnostics, setDiagnostics] = useState<MeshDiagnostics | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const read = () => {
        void getMeshDiagnostics().then((next) => {
          if (!cancelled) setDiagnostics(next);
        });
      };
      read();
      const timer = setInterval(read, REFRESH_MS);
      // Also refresh on snapshot changes so a trust or status change lands
      // immediately rather than up to REFRESH_MS later.
      const unsubscribe = subscribeToNearbyMessaging(read);
      return () => {
        cancelled = true;
        clearInterval(timer);
        unsubscribe();
      };
    }, []),
  );

  const liveTransports = diagnostics?.transports.filter((t) => t.available) ?? [];
  const hasQueue = (diagnostics?.queuedMessages ?? 0) > 0
    || (diagnostics?.routerPending ?? 0) > 0;

  return (
    <LiquidBackground>
      <ScrollView contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 24 }]}>
        {/* Summary ----------------------------------------------------------- */}
        <GlassView style={styles.card}>
          <View style={styles.row}>
            <View
              style={[
                styles.statusIcon,
                {
                  backgroundColor: `${liveTransports.length > 0 ? theme.colors.success : theme.colors.warning}22`,
                  borderRadius: theme.radius.pill,
                },
              ]}
            >
              <Icon
                source={liveTransports.length > 0 ? 'access-point' : 'access-point-off'}
                size={22}
                color={liveTransports.length > 0 ? theme.colors.success : theme.colors.warning}
              />
            </View>
            <View style={styles.rowCopy}>
              <Text variant="titleMedium" style={{ fontWeight: '700', color: theme.colors.onSurface }}>
                {diagnostics ? summariseMesh(diagnostics) : 'Checking…'}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                Shows what this phone can see right now — not a map of the whole mesh.
                A message can still reach a device that isn’t listed here.
              </Text>
            </View>
          </View>
        </GlassView>

        {/* Transports -------------------------------------------------------- */}
        <GlassView style={styles.card}>
          <Text variant="titleSmall" style={[styles.cardTitle, { color: theme.colors.onSurface }]}>
            Transports
          </Text>
          {(diagnostics?.transports ?? []).map((transport) => (
            <View key={transport.id} style={styles.listRow}>
              <Icon
                source={TRANSPORT_ICON[transport.id] ?? 'lan-connect'}
                size={18}
                color={transport.available ? theme.colors.success : theme.colors.onSurfaceVariant}
              />
              <Text variant="bodyMedium" style={{ flex: 1, color: theme.colors.onSurface }}>
                {TRANSPORT_LABEL[transport.id] ?? transport.id.toUpperCase()}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {transport.available
                  ? `${transport.neighbourCount} connected`
                  : 'Unavailable'}
              </Text>
            </View>
          ))}
          {diagnostics && !diagnostics.bleEnabled ? (
            <Text variant="bodySmall" style={[styles.note, { color: theme.colors.onSurfaceVariant }]}>
              Bluetooth mesh is off in this build. It’s the only transport that can
              reach Android.
            </Text>
          ) : null}
        </GlassView>

        {/* Nearby devices ---------------------------------------------------- */}
        <GlassView style={styles.card}>
          <View style={[styles.row, { justifyContent: 'space-between' }]}>
            <Text variant="titleSmall" style={{ fontWeight: '700', color: theme.colors.onSurface }}>
              Nearby devices
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {diagnostics?.neighbours.length ?? 0}
            </Text>
          </View>
          {(diagnostics?.neighbours.length ?? 0) === 0 ? (
            <Text variant="bodySmall" style={[styles.note, { color: theme.colors.onSurfaceVariant }]}>
              Nothing in range. Devices appear here once they connect and prove who
              they are.
            </Text>
          ) : (
            diagnostics?.neighbours.map((peer) => (
              <View key={peer.nodeId} style={styles.listRow}>
                <Icon
                  source={peer.trusted ? 'shield-check' : 'shield-alert-outline'}
                  size={18}
                  color={peer.trusted ? theme.colors.success : theme.colors.warning}
                />
                <View style={styles.rowCopy}>
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }} numberOfLines={1}>
                    {peer.label}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                    {peer.transports.map((t) => TRANSPORT_LABEL[t] ?? t).join(' · ')}
                    {peer.trusted ? '' : ' · not trusted'}
                  </Text>
                </View>
              </View>
            ))
          )}
        </GlassView>

        {/* Queue ------------------------------------------------------------- */}
        <GlassView style={styles.card}>
          <Text variant="titleSmall" style={[styles.cardTitle, { color: theme.colors.onSurface }]}>
            Waiting to send
          </Text>
          <View style={styles.listRow}>
            <Icon source="tray-full" size={18} color={theme.colors.onSurfaceVariant} />
            <Text variant="bodyMedium" style={{ flex: 1, color: theme.colors.onSurface }}>
              Queued messages
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {diagnostics?.queuedMessages ?? 0}
            </Text>
          </View>
          {diagnostics?.routerEnabled ? (
            <View style={styles.listRow}>
              <Icon source="routes" size={18} color={theme.colors.onSurfaceVariant} />
              <Text variant="bodyMedium" style={{ flex: 1, color: theme.colors.onSurface }}>
                Held for a route
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {diagnostics.routerPending}
              </Text>
            </View>
          ) : null}
          {!hasQueue ? (
            <Text variant="bodySmall" style={[styles.note, { color: theme.colors.onSurfaceVariant }]}>
              Nothing waiting.
            </Text>
          ) : null}
        </GlassView>

        {/* Activity ---------------------------------------------------------- */}
        <GlassView style={styles.card}>
          <Text variant="titleSmall" style={[styles.cardTitle, { color: theme.colors.onSurface }]}>
            Recent activity
          </Text>
          {(diagnostics?.events.length ?? 0) === 0 ? (
            <Text variant="bodySmall" style={[styles.note, { color: theme.colors.onSurfaceVariant }]}>
              No nearby activity yet in this session.
            </Text>
          ) : (
            diagnostics?.events.slice(0, 12).map((event) => (
              <View key={`${event.at}-${event.detail}`} style={styles.listRow}>
                <Icon
                  source={
                    event.kind === 'failed' ? 'alert-circle-outline'
                      : event.kind === 'received' ? 'tray-arrow-down'
                        : 'tray-arrow-up'
                  }
                  size={18}
                  color={event.kind === 'failed' ? theme.colors.warning : theme.colors.onSurfaceVariant}
                />
                <Text variant="bodySmall" style={{ flex: 1, color: theme.colors.onSurface }} numberOfLines={2}>
                  {event.detail}
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  {relativeTime(event.at)}
                </Text>
              </View>
            ))
          )}
        </GlassView>

        {/* What relaying exposes (doc 33 §2.3) -------------------------------- */}
        <GlassView style={styles.card}>
          <Text variant="titleSmall" style={[styles.cardTitle, { color: theme.colors.onSurface }]}>
            What nearby devices can see
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, lineHeight: 18 }}>
            Message contents stay encrypted end to end — a phone that passes your
            message along cannot read it. It can see that a message travelled, how
            big it was, and when. That’s true of any relay network, and it’s why
            only devices you already share a chat with are allowed to relay yours.
          </Text>
        </GlassView>
      </ScrollView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12 },
  card: { padding: 16, gap: 10 },
  cardTitle: { fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowCopy: { flex: 1 },
  statusIcon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  note: { lineHeight: 18 },
});

export default NearbyMeshScreen;
