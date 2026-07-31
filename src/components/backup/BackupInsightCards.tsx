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

import { GlassCard } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import { BACKUP_CATEGORIES, type BackupCategory } from '@/services/backupContentService';
import type { BackupRunEntry } from '@/services/backupHistoryService';
import type { BackupReadiness } from '@/services/backupReadinessService';
import type { BackupManifest } from '@/services/backupService';
import { Linking, StyleSheet, View } from 'react-native';
import { Button, Divider, Text } from 'react-native-paper';

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

const categoryLabel = (key: BackupCategory): string =>
  BACKUP_CATEGORIES.find((category) => category.key === key)?.label ?? key;

/**
 * What's in the backup, by category and size.
 *
 * Answers the question the user actually has when they see an iCloud storage
 * number: WHICH part is big. Without the breakdown, "340 MB" is just a fact
 * they can't act on; with it, "Photos & videos 331 MB" points straight at the
 * toggle that would change it.
 */
export const BackupSizeCard = ({ manifest }: { manifest: BackupManifest | null }) => {
  const { theme } = useTheme();
  const sizes = manifest?.sizes ?? {};
  const entries = (Object.keys(sizes) as BackupCategory[])
    .map((key) => ({ key, bytes: sizes[key] ?? 0 }))
    .filter((entry) => entry.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);

  return (
    <GlassCard style={styles.card} contentStyle={styles.cardContent}>
      <View style={styles.headerRow}>
        <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
          Storage used
        </Text>
        <Text variant="titleMedium" style={{ color: theme.colors.primary }}>
          {formatBytes(total)}
        </Text>
      </View>

      {entries.length === 0 ? (
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          Nothing backed up yet — run a backup to see what it uses.
        </Text>
      ) : (
        entries.map((entry) => (
          <View key={entry.key}>
            <View style={styles.headerRow}>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                {categoryLabel(entry.key)}
              </Text>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                {formatBytes(entry.bytes)}
              </Text>
            </View>
            {/* Proportional bar — a size list is much harder to read than a
                shape when one category dwarfs the rest, which it usually does
                the moment photos are on. */}
            <View style={[styles.barTrack, { backgroundColor: theme.colors.surfaceVariant }]}>
              <View
                style={[
                  styles.barFill,
                  {
                    backgroundColor: theme.colors.primary,
                    width: `${total > 0 ? Math.max(2, (entry.bytes / total) * 100) : 0}%`,
                  },
                ]}
              />
            </View>
          </View>
        ))
      )}

      <Divider />
      {/* This number is ours alone. CloudKit exposes no per-container usage
          API, so we cannot show the user's overall iCloud quota — Apple's own
          screen can, and pointing at it beats inventing a figure. */}
      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
        This is what ManaSplit stores. To see your whole iCloud account, open Apple&apos;s
        storage screen.
      </Text>
      <Button
        mode="outlined"
        icon="open-in-new"
        onPress={() => {
          void Linking.openURL('App-prefs:CASTLE&path=STORAGE_AND_BACKUP').catch(() => {
            void Linking.openSettings();
          });
        }}
      >
        Open iCloud storage settings
      </Button>
    </GlassCard>
  );
};

/**
 * What a restore would actually give back.
 *
 * The point of a backup is not that it exists, it's what it returns — and
 * until you try one, that is invisible. Stating it concretely is also the
 * cheapest way for the user to notice something is wrong ("210 photos? I have
 * thousands").
 */
export const RestorePreviewCard = ({ manifest }: { manifest: BackupManifest | null }) => {
  const { theme } = useTheme();
  if (!manifest) return null;

  const mediaCount = manifest.mediaIds?.length ?? 0;
  const lines = [
    `${manifest.totalMessages.toLocaleString()} messages across ${manifest.chats.length} chats`,
    mediaCount > 0 ? `${mediaCount.toLocaleString()} photos & videos` : null,
    manifest.callHistoryCount ? `${manifest.callHistoryCount} call history entries` : null,
    manifest.contents?.wallpapers ? 'Your wallpapers and backgrounds' : null,
    manifest.contents?.localSettings ? 'App appearance and preferences' : null,
  ].filter(Boolean) as string[];

  return (
    <GlassCard style={styles.card} contentStyle={styles.cardContent}>
      <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
        What you&apos;d get back
      </Text>
      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
        Restoring this backup on a new phone would bring back:
      </Text>
      {lines.map((line) => (
        <Text key={line} variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
          • {line}
        </Text>
      ))}
      {manifest.mediaSkippedTooLarge ? (
        <Text variant="bodySmall" style={{ color: theme.colors.danger }}>
          {manifest.mediaSkippedTooLarge} large file
          {manifest.mediaSkippedTooLarge === 1 ? '' : 's'} could not be included and would NOT come
          back.
        </Text>
      ) : null}
      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
        Your groups, expenses and balances live on our servers and come back automatically — they
        don&apos;t depend on this backup.
      </Text>
    </GlassCard>
  );
};

/**
 * The conditions a backup needs, instead of a predicted time.
 *
 * §3.6 forbids inventing a next-run timestamp because iOS genuinely decides.
 * This is the honest replacement: everything here is checked live, and every
 * unmet item is something the user can act on.
 */
export const NextBackupCard = ({ readiness }: { readiness: BackupReadiness | null }) => {
  const { theme } = useTheme();
  if (!readiness) return null;

  return (
    <GlassCard style={styles.card} contentStyle={styles.cardContent}>
      <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
        Next backup
      </Text>
      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
        {readiness.frequencyLabel}. iOS chooses the exact moment — usually while charging on
        Wi-Fi — so we don&apos;t show a countdown we can&apos;t keep.
      </Text>
      <Divider />
      {readiness.conditions.map((condition) => (
        <View key={condition.key}>
          <View style={styles.headerRow}>
            <Text
              variant="bodyMedium"
              style={{ color: condition.met ? theme.colors.onSurface : theme.colors.danger }}
            >
              {condition.met ? '✓' : '✕'} {condition.label}
            </Text>
          </View>
          {!condition.met && condition.detail ? (
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {condition.detail}
            </Text>
          ) : null}
        </View>
      ))}
    </GlassCard>
  );
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

  const color = (outcome: BackupRunEntry['outcome']) =>
    outcome === 'success' ? theme.colors.onSurface : theme.colors.danger;

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
              : (entry.message ?? 'No reason recorded.')}
          </Text>
          {index < Math.min(history.length, 10) - 1 ? <Divider /> : null}
        </View>
      ))}
    </GlassCard>
  );
};

/**
 * Encryption and passphrase status.
 *
 * States the permanent-loss consequence plainly, in the one place the user is
 * already thinking about their backup — §3.5 requires that sentence to exist
 * at creation time, and it is just as true afterwards.
 */
export const EncryptionCard = ({
  enrolled,
  enrolledAt,
}: {
  enrolled: boolean;
  enrolledAt: number | null;
}) => {
  const { theme } = useTheme();
  return (
    <GlassCard style={styles.card} contentStyle={styles.cardContent}>
      <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
        Encryption
      </Text>
      <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
        {enrolled
          ? 'Your backup is end-to-end encrypted with your passphrase before it leaves this device.'
          : 'No passphrase set yet — nothing can be backed up until there is one.'}
      </Text>
      {enrolled && enrolledAt ? (
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          Passphrase set {relative(enrolledAt)}.
        </Text>
      ) : null}
      {enrolled ? (
        <Text variant="bodySmall" style={{ color: theme.colors.danger }}>
          We cannot reset it. If you forget your passphrase, this backup can never be opened — by
          you or by us.
        </Text>
      ) : null}
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
