// The transparency half of the iCloud backup screen (product-owner request,
// 2026-07-26: "more interactive, transparent and clear... show them the size
// of the backup, upcoming backup, past backup, storage taken").
//
// Split out of BackupSettingsScreen because that screen already owns a lot of
// STATE (enrollment, frequency, cellular, selection, restore). These cards are
// pure presentation over data fetched once, so keeping them separate keeps
// both halves legible.
//
// The organising principle is that every number here is one we actually
// measured. Nothing is predicted, and nothing is inferred from CloudKit — see
// `sizes` in BackupManifest for why write-time measurement is the only
// accurate option available to us.

import { Divider, GlassCard } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import type { BackupRunEntry } from '@/services/backupHistoryService';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

/** Bytes → a short human string. Binary units, matching what iOS shows. */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return '<1s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const relative = (timestamp: number): string => {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};


/**
 * Recent runs, including the ones that didn't happen and why.
 *
 * Keeping only successes made the most important question unanswerable: a
 * three-day gap looks identical whether iOS simply hasn't scheduled us or
 * we've been refused on cellular nine times running. Those need opposite
 * responses, so the refusals are listed with their reason.
 */
export const BackupHistoryCard = ({ history }: { history: BackupRunEntry[] }) => {
  const { theme } = useTheme();
  if (history.length === 0) return null;

  const color = (outcome: BackupRunEntry['outcome']) => (outcome === 'success' ? theme.colors.onSurface : theme.colors.danger);

  return (
    <GlassCard style={styles.card} contentStyle={styles.cardContent}>
      <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
        Recent backups
      </Text>
      {history.slice(0, 10).map((entry, index) => (
        <View key={`${entry.at}-${index}`}>
          <View style={styles.headerRow}>
            <Text variant="bodyMedium" style={{ color: color(entry.outcome) }}>
              {entry.outcome === 'success'
                ? `${entry.messageCount?.toLocaleString() ?? 0} messages`
                : entry.outcome === 'blocked'
                  ? 'Skipped'
                  : 'Failed'}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {relative(entry.at)}
            </Text>
          </View>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {entry.outcome === 'success'
              ? `${formatBytes(entry.bytes ?? 0)} · ${formatDuration(entry.durationMs)} · ${entry.trigger === 'manual' ? 'you started it' : 'automatic'}`
              : entry.outcome === 'blocked'
                ? (entry.message ?? 'Backup is not ready yet.')
                : 'Backup could not finish. Try again.'}
          </Text>
          {index < Math.min(history.length, 10) - 1 ? <Divider /> : null}
        </View>
      ))}
    </GlassCard>
  );
};

const styles = StyleSheet.create({
  card: { borderRadius: 20 },
  cardContent: { padding: 20, gap: 10 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  barTrack: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    marginTop: 4,
  },
  barFill: { height: '100%', borderRadius: 3 },
});
