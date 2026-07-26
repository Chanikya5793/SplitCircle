// iCloud backup — the single screen for the whole feature (doc 31 §3.6).
//
// Replaces the bare passphrase form that shipped first. Everything a person
// needs to trust this feature lives here: what is backed up, when it last
// happened, what is stopping it, how often it runs, whether it may use
// cellular, and how to get it back.
//
// The copy is deliberately HONEST ABOUT UNCERTAINTY (§3.6): it shows the last
// SUCCESSFUL backup and never a predicted next-run time, because iOS decides
// when background work actually happens and inventing a schedule we cannot
// keep is worse than admitting we don't know.

import { GlassCard } from '@/components/ui';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { ROUTES } from '@/constants/routes';
import { isBackupHealthy } from '../../../modules/splitcircle-backup';
import { getEnrolledAt, getStoredPassphrase, isPassphraseEnrolled } from '@/services/backupPassphraseService';
import {
  BACKUP_FREQUENCY_LABELS,
  checkNetworkAllowance,
  getBackupAllowCellular,
  getBackupFrequency,
  isBackupStale,
  setBackupAllowCellular,
  setBackupFrequency,
  type BackupFrequency,
} from '@/services/backupSettingsService';
import { BackupBlockedError, getLastBackupInfo, runBackupNow, type LastBackupInfo } from '@/services/backupRunner';
import {
  importBackup,
  lastSummaryReadError,
  readBackupManifest,
  type BackupManifest,
} from '@/services/backupService';
import {
  BACKUP_CATEGORIES,
  DEFAULT_SELECTION,
  getBackupSelection,
  setBackupSelection,
  type BackupCategory,
  type BackupSelection,
} from '@/services/backupContentService';
import { isBackupScheduled, syncBackupSchedule } from '@/services/backupScheduler';
import { getBackupHistory, type BackupRunEntry } from '@/services/backupHistoryService';
import { assessBackupReadiness, type BackupReadiness } from '@/services/backupReadinessService';
import {
  BackupHistoryCard,
  BackupSizeCard,
  EncryptionCard,
  NextBackupCard,
  RestorePreviewCard,
  formatBytes,
} from '@/components/backup/BackupInsightCards';
import { appAlert } from '@/utils/appAlert';
import { errorHaptic, lightHaptic, successHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@react-navigation/elements';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Divider, List, ProgressBar, Switch, Text, TextInput } from 'react-native-paper';

const FREQUENCIES: BackupFrequency[] = ['daily', 'every3days', 'weekly', 'off'];

const relativeTime = (timestamp: number): string => {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

export const BackupSettingsScreen = () => {
  const navigation = useNavigation();
  const { user } = useAuth();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();

  const [loading, setLoading] = useState(true);
  const [enrolled, setEnrolled] = useState(false);
  const [enrolledAt, setEnrolledAt] = useState<number | null>(null);
  const [lastBackup, setLastBackup] = useState<LastBackupInfo | null>(null);
  const [frequency, setFrequency] = useState<BackupFrequency>('daily');
  const [allowCellular, setAllowCellular] = useState(false);
  const [icloud, setIcloud] = useState<{ available: boolean; reason?: string | null }>({ available: true });
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [remoteManifest, setRemoteManifest] = useState<BackupManifest | null>(null);
  // Typed on a device that has no passphrase of its own — the new-phone case.
  const [restorePass, setRestorePass] = useState('');
  const [revealRestorePass, setRevealRestorePass] = useState(false);
  /** Real OS-level registration state, not just the stored preference. */
  const [scheduled, setScheduled] = useState(false);
  const [selection, setSelection] = useState<BackupSelection>(DEFAULT_SELECTION);
  const [history, setHistory] = useState<BackupRunEntry[]>([]);
  const [readiness, setReadiness] = useState<BackupReadiness | null>(null);
  /** Manifest of the backup currently in iCloud, for size / restore preview. */
  const [localManifest, setLocalManifest] = useState<BackupManifest | null>(null);

  const refresh = useCallback(async () => {
    if (!user) return;
    const [isEnrolled, at, last, freq, cellular, health, contents] = await Promise.all([
      isPassphraseEnrolled(),
      getEnrolledAt(),
      getLastBackupInfo(),
      getBackupFrequency(user.userId),
      getBackupAllowCellular(user.userId),
      isBackupHealthy(),
      getBackupSelection(),
    ]);
    setSelection(contents);
    setHistory(await getBackupHistory());
    setReadiness(await assessBackupReadiness(user.userId));
    setEnrolled(isEnrolled);
    setEnrolledAt(at);
    setLastBackup(last);
    setFrequency(freq);
    setAllowCellular(cellular);
    setIcloud({ available: health.isAvailable, reason: health.reason });
    // Keep the OS schedule in step with the synced preference — another device
    // may have changed it since this one last ran.
    await syncBackupSchedule(freq);
    setScheduled(await isBackupScheduled());
    setLoading(false);

    // Read the manifest in the BACKGROUND, after first paint. It needs a
    // network round trip and a key derivation, so blocking the screen on it
    // would make opening Settings feel broken; the size and restore-preview
    // cards simply appear a moment later.
    if (isEnrolled) {
      void (async () => {
        try {
          const stored = await getStoredPassphrase();
          if (stored) setLocalManifest(await readBackupManifest(stored));
        } catch {
          // Offline or unreadable — the cards stay hidden rather than lying.
        }
      })();
    }
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const stale = isBackupStale(frequency, lastBackup?.completedAt ?? null);

  const handleBackupNow = async () => {
    if (!user) return;
    setBusy('Starting…');
    setProgress(0);
    try {
      const info = await runBackupNow(user.userId, (p) => {
        // Per-category, with a running byte total. A 300MB photo backup
        // reporting only "backing up messages" looks frozen for minutes;
        // naming the file count and bytes is what makes a long run feel
        // accountable, and shows exactly where it stalls if it does.
        const uploaded = p.bytesDone ? ` · ${formatBytes(p.bytesDone)}` : '';
        if (p.phase === 'messages' && p.chatsTotal > 0) {
          setProgress(Math.min((p.chatsDone / p.chatsTotal) * 0.6, 0.6));
          setBusy(`Messages: ${p.messagesDone.toLocaleString()}${uploaded}`);
        } else if (p.phase === 'media') {
          const done = p.filesDone ?? 0;
          const total = p.filesTotal ?? 0;
          setProgress(total > 0 ? 0.6 + (done / total) * 0.35 : 0.6);
          setBusy(`Photos & videos: ${done} of ${total}${uploaded}`);
        } else if (p.phase === 'extras') {
          setProgress(0.96);
          setBusy(`Saving ${p.category === 'wallpapers' ? 'wallpapers' : p.category === 'callHistory' ? 'call history' : 'settings'}${uploaded}`);
        } else if (p.phase === 'manifest') {
          setProgress(0.99);
          setBusy(`Finishing up${uploaded}`);
        }
      });
      setLastBackup(info);
      successHaptic();
      // Named explicitly rather than folded into a cheerful summary: a
      // backup that omitted the user's videos while saying "complete" is the
      // dishonest-success case the retirement gate exists to prevent.
      const skipped = info.mediaSkippedTooLarge ?? 0;
      appAlert(
        skipped > 0 ? 'Backed up, with some files skipped' : 'Backup complete',
        skipped > 0
          ? `${info.messageCount} messages across ${info.chatCount} chats. ${skipped} large file${skipped === 1 ? '' : 's'} couldn't be included — those stay on this device only.`
          : `${info.messageCount} messages across ${info.chatCount} chats.`,
      );
    } catch (error) {
      errorHaptic();
      appAlert(
        error instanceof BackupBlockedError ? 'Can’t back up right now' : 'Backup failed',
        error instanceof Error ? error.message : 'Please try again.',
      );
    } finally {
      setBusy(null);
      setProgress(null);
      void refresh();
    }
  };

  // Restore is deliberately two-step: look at what's in iCloud FIRST, then
  // decide. A one-tap restore gives no chance to notice the backup is from the
  // wrong account or far older than expected.
  /**
   * The passphrase to restore WITH.
   *
   * Falls back to whatever the user typed, because the stored one is the wrong
   * source on the only device that ever really needs to restore. `getStored...`
   * reads THIS device's keychain, which on a newly set-up phone is empty — so
   * restore used to fail with "Set your backup passphrase first" precisely
   * when it mattered, and the button was disabled on top of that. Restoring is
   * not the same act as enrolling: it proves you know an EXISTING backup's
   * passphrase, it doesn't establish one for future backups.
   */
  const restorePassphrase = async (): Promise<string> => {
    const typed = restorePass.trim();
    if (typed) return typed;
    const stored = await getStoredPassphrase();
    if (stored) return stored;
    throw new Error('Enter the backup passphrase from your old device.');
  };

  const handleCheckBackup = async () => {
    setBusy('Reading backup…');
    try {
      const passphrase = await restorePassphrase();
      const manifest = await readBackupManifest(passphrase);
      if (!manifest) {
        appAlert('No backup found', 'There’s no SplitCircle backup in this iCloud account yet.');
        return;
      }
      setRemoteManifest(manifest);
      lightHaptic();
    } catch (error) {
      errorHaptic();
      appAlert('Couldn’t read backup', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const handleRestore = () => {
    if (!remoteManifest) return;
    appAlert(
      'Restore this backup?',
      `${remoteManifest.totalMessages} messages across ${remoteManifest.chats.length} chats, backed up ${relativeTime(remoteManifest.createdAt)}. Messages already on this device are kept — this only adds what's missing.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restore',
          onPress: () =>
            void (async () => {
              setBusy('Restoring…');
              setProgress(0);
              try {
                const passphrase = await restorePassphrase();
                const result = await importBackup(passphrase, (p) => {
                  if (p.chatsTotal > 0) setProgress(Math.min(p.chatsDone / p.chatsTotal, 0.99));
                  setBusy(`Restored ${p.messagesRestored} messages…`);
                });
                successHaptic();
                // Partial restores are reported, never smoothed over — §3.2's
                // importBackup returns exactly which batches were unreadable.
                // App settings (theme, currency, budgets) are read once at
                // launch by their own contexts, so a restored value sits on
                // disk correct but unapplied. Saying so is the honest option —
                // silence reads as "the restore didn't work". Wallpapers are
                // NOT in this list: importWallpapers re-hydrates its service.
                const needsRestart = remoteManifest?.contents?.localSettings === true;
                const base =
                  result.missingBatches.length === 0
                    ? `${result.messagesRestored} messages restored.`
                    : `${result.messagesRestored} messages restored, but ${result.missingBatches.length} part(s) of the backup couldn’t be read.`;
                appAlert(
                  result.missingBatches.length === 0 ? 'Restore complete' : 'Restored with gaps',
                  needsRestart
                    ? `${base}\n\nRestart the app to apply your restored appearance and currency settings.`
                    : base,
                );
              } catch (error) {
                errorHaptic();
                appAlert('Restore failed', error instanceof Error ? error.message : 'Please try again.');
              } finally {
                setBusy(null);
                setProgress(null);
              }
            })(),
        },
      ],
    );
  };

  const handleFrequency = async (next: BackupFrequency) => {
    if (!user) return;
    setFrequency(next);
    lightHaptic();
    await setBackupFrequency(user.userId, next);
    // Push the change to the OS scheduler too — storing the preference without
    // this would leave the picker claiming automation that never happens.
    await syncBackupSchedule(next);
    setScheduled(await isBackupScheduled());
  };

  const handleCellular = async (next: boolean) => {
    if (!user) return;
    setAllowCellular(next);
    await setBackupAllowCellular(user.userId, next);
  };

  const handleCategory = async (key: BackupCategory, next: boolean) => {
    const updated = { ...selection, [key]: next };
    setSelection(updated);
    await setBackupSelection(updated);
  };

  if (loading) {
    return (
      <LiquidBackground>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </LiquidBackground>
    );
  }

  return (
    <LiquidBackground>
      <ScrollView contentContainerStyle={[styles.container, { paddingTop: headerHeight + 16, paddingBottom: insets.bottom + 32 }]}>
        {/* iCloud unavailable gets its own distinct message (§3.6 / #18): live
            sync is unaffected, and saying so prevents a scarier reading. */}
        {!icloud.available ? (
          <GlassCard style={styles.card} contentStyle={styles.cardContent}>
            <Text variant="titleSmall" style={{ color: theme.colors.danger }}>
              iCloud isn’t available
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Your chats aren’t being backed up right now. They’re still syncing live across your
              devices — just not saved to iCloud until this is resolved.
              {icloud.reason ? `\n\n(${icloud.reason})` : ''}
            </Text>
          </GlassCard>
        ) : null}

        {stale && enrolled ? (
          <GlassCard style={styles.card} contentStyle={styles.cardContent}>
            {/* Two genuinely different situations, so they don't share a
                heading: "out of date" is alarming and simply untrue for
                someone who enrolled a minute ago and has never run a backup
                — there is nothing stale, there is nothing yet. */}
            <Text
              variant="titleSmall"
              style={{ color: lastBackup ? theme.colors.danger : theme.colors.onSurface }}
            >
              {lastBackup ? 'Your backup is out of date' : 'No backup yet'}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {lastBackup
                ? `The last successful backup was ${relativeTime(lastBackup.completedAt)}.`
                : 'Your chat history is only on this device until the first backup runs.'}
            </Text>
            <Button mode="contained" disabled={busy !== null} onPress={handleBackupNow}>
              Back up now
            </Button>
          </GlassCard>
        ) : null}

        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            iCloud backup
          </Text>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
            {lastBackup
              ? `Last successful backup: ${relativeTime(lastBackup.completedAt)} — ${lastBackup.messageCount} messages across ${lastBackup.chatCount} chats.`
              : 'No backup has completed on this device yet.'}
          </Text>
          {/* Static explanation, never a predicted next run (§3.6). */}
          {frequency !== 'off' && scheduled ? (
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Automatic backups are on — they usually happen overnight while charging and connected
              to Wi-Fi, but iOS decides exactly when.
            </Text>
          ) : frequency !== 'off' ? (
            // Claiming automation we could not actually register would be the
            // same class of dishonesty as predicting a next-run time.
            <Text variant="bodySmall" style={{ color: theme.colors.danger }}>
              Automatic backups couldn’t be scheduled on this device. Use “Back up now” until this
              resolves.
            </Text>
          ) : null}

          {busy ? (
            <View style={styles.busyBlock}>
              <Text variant="bodySmall" style={{ color: theme.colors.primary }}>
                {busy}
              </Text>
              {progress !== null ? (
                <ProgressBar progress={progress} color={theme.colors.primary} />
              ) : (
                <ActivityIndicator size="small" color={theme.colors.primary} />
              )}
            </View>
          ) : null}

          <Button
            mode="contained"
            disabled={busy !== null || !enrolled || !icloud.available}
            onPress={handleBackupNow}
          >
            Back up now
          </Button>
          {!enrolled ? (
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Set a backup passphrase first — your backup is encrypted with it.
            </Text>
          ) : null}
        </GlassCard>

        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
            How often
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            This sets how often we ask iOS to consider backing up — iOS decides the exact timing.
          </Text>
          {FREQUENCIES.map((option) => (
            <List.Item
              key={option}
              title={BACKUP_FREQUENCY_LABELS[option]}
              onPress={() => void handleFrequency(option)}
              right={() =>
                frequency === option ? (
                  <List.Icon icon="check" color={theme.colors.primary} />
                ) : null
              }
            />
          ))}
          <Divider />
          <View style={styles.switchRow}>
            <View style={styles.switchLabel}>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                Back up over cellular
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Off by default — backups can be large.
              </Text>
            </View>
            <Switch value={allowCellular} onValueChange={(v) => void handleCellular(v)} />
          </View>
        </GlassCard>

        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
            What gets backed up
          </Text>
          {BACKUP_CATEGORIES.map((category) => (
            <View key={category.key} style={styles.switchRow}>
              <View style={styles.switchLabel}>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                  {category.label}
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  {category.description}
                </Text>
              </View>
              <Switch
                value={selection[category.key]}
                onValueChange={(v) => void handleCategory(category.key, v)}
              />
            </View>
          ))}
          {!selection.messages ? (
            // Stated here rather than only at the retirement gate: by the time
            // someone reaches that screen they are already planning to wipe
            // this phone.
            <Text variant="bodySmall" style={{ color: theme.colors.danger }}>
              With messages off, your conversations are not backed up — and this device can&apos;t be
              safely retired.
            </Text>
          ) : null}
          <Divider />
          {/* Named explicitly so the omissions don't read as gaps. Copying
              server-held data into iCloud would spend the user's personal
              quota duplicating something that isn't at risk, and a restore
              could put a stale copy over the authoritative one. */}
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Your expenses, groups, balances, profile and synced settings are stored on our servers
            and come back automatically when you sign in — they don&apos;t need a backup.
          </Text>
        </GlassCard>

        <NextBackupCard readiness={readiness} />
        <BackupSizeCard manifest={localManifest} />
        <RestorePreviewCard manifest={localManifest} />
        <EncryptionCard enrolled={enrolled} enrolledAt={enrolledAt} />
        <BackupHistoryCard history={history} />

        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
            Restore
          </Text>
          {remoteManifest ? (
            <>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                Found a backup from {relativeTime(remoteManifest.createdAt)}:{' '}
                {remoteManifest.totalMessages} messages across {remoteManifest.chats.length} chats.
              </Text>
              <Button mode="contained" disabled={busy !== null} onPress={handleRestore}>
                Restore this backup
              </Button>
            </>
          ) : (
            <>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Check what’s stored in iCloud before restoring. Restoring adds missing messages and
                keeps everything already on this device.
              </Text>
              {/* Shown whenever this device has no passphrase of its own —
                  i.e. exactly the new-phone case restore exists for. Gating
                  this on enrollment made restore reachable only on devices
                  that had already been backing up, which are the ones least
                  likely to need it. */}
              {!enrolled ? (
                <TextInput
                  mode="outlined"
                  label="Backup passphrase"
                  value={restorePass}
                  onChangeText={setRestorePass}
                  secureTextEntry={!revealRestorePass}
                  autoCapitalize="none"
                  autoCorrect={false}
                  disabled={busy !== null}
                  right={
                    <TextInput.Icon
                      icon={revealRestorePass ? 'eye-off' : 'eye'}
                      onPress={() => setRevealRestorePass((value) => !value)}
                    />
                  }
                />
              ) : null}
              <Button
                mode="outlined"
                disabled={busy !== null || (!enrolled && restorePass.trim().length === 0)}
                onPress={handleCheckBackup}
              >
                Check iCloud for a backup
              </Button>
            </>
          )}
        </GlassCard>

        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          <List.Item
            title="Backup passphrase"
            description={
              enrolled
                ? enrolledAt
                  ? `Set on ${new Date(enrolledAt).toLocaleDateString()}`
                  : 'Set'
                : 'Not set — required before backing up'
            }
            left={() => <List.Icon icon="lock-outline" color={theme.colors.primary} />}
            onPress={() => {
              lightHaptic();
              (navigation as any).navigate(ROUTES.APP.BACKUP_PASSPHRASE);
            }}
          />
          <Divider />
          <List.Item
            title="Wipe or sell this phone"
            description="Verify your backup is readable before you erase it"
            left={() => <List.Icon icon="cellphone-remove" color={theme.colors.primary} />}
            onPress={() => {
              lightHaptic();
              (navigation as any).navigate(ROUTES.APP.DEVICE_RETIREMENT);
            }}
          />
        </GlassCard>
      </ScrollView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: { padding: 16, gap: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: { borderRadius: 20 },
  cardContent: { padding: 20, gap: 12 },
  busyBlock: { gap: 8 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  switchLabel: { flex: 1 },
});
