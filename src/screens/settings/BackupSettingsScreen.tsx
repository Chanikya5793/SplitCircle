// iCloud backup — the one screen for the whole feature (doc 31 §3.6), v2.
//
// Layout, top to bottom, and why:
//  1. Status — the answer to "is my stuff safe?" first: what iCloud holds
//     (read from iCloud itself, not a local note), the single "Back up now"
//     action, live progress, and whatever is stopping a backup.
//  2. Restore — only when iCloud holds a backup THIS device didn't write or
//     restore (the new-phone case). It sits above everything else then,
//     because restoring is the thing to do before anything else.
//  3. Automatic backups, 4. What's included, 5. Security, 6. Recent runs.
//
// Opening the screen costs one CloudKit metadata read and NO key derivation:
// v1 ran the 600k-iteration passphrase KDF and downloaded the manifest every
// time the screen opened, just to show two cards.
//
// Still honest about uncertainty (§3.6): it shows the last backup that is
// actually in iCloud and never predicts when iOS will run the next one.

import { DetailScreenScaffold } from '@/components/ui/DetailScreenScaffold';
import { Divider, GlassCard, ListRow, SCREEN_GUTTER, SectionLabel, SegmentedControl } from '@/components/ui';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { ROUTES } from '@/constants/routes';
import { isBackupHealthy } from '../../../modules/splitcircle-backup';
import {
  adoptRestoredPassphrase,
  getEnrolledAt,
  getStoredPassphrase,
  isPassphraseEnrolled,
} from '@/services/backupPassphraseService';
import {
  getBackupAllowCellular,
  getBackupFrequency,
  setBackupAllowCellular,
  setBackupFrequency,
  type BackupFrequency,
} from '@/services/backupSettingsService';
import { BackupBlockedError, runBackupNow } from '@/services/backupRunner';
import {
  assessTakeover,
  importBackup,
  lastSummaryReadError,
  readBackupManifest,
  type BackupSummary,
  type TakeoverAssessment,
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
import { BackupHistoryCard, formatBytes } from '@/components/backup/BackupInsightCards';
import { appAlert } from '@/utils/appAlert';
import { errorHaptic, lightHaptic, successHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Button, Icon, ProgressBar, Switch, Text, TextInput } from 'react-native-paper';

const FREQUENCIES: { value: BackupFrequency; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'every3days', label: '3 days' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'off', label: 'Off' },
];

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

/** The health check's machine codes, in words. Native reasons are already prose. */
const icloudReasonText = (reason?: string | null): string => {
  switch (reason) {
    case 'simulator_no_icloud':
      return 'iCloud backup only works on an iPhone, not the simulator.';
    case 'native_module_unavailable':
      return 'This version of the app can’t use iCloud backup.';
    case undefined:
    case null:
    case '':
      return 'Sign in to iCloud in the Settings app.';
    default:
      return reason;
  }
};

const CATEGORY_ICONS: Record<BackupCategory, string> = {
  messages: 'message-text-outline',
  media: 'image-multiple-outline',
  callHistory: 'phone-outline',
  wallpapers: 'palette-outline',
  localSettings: 'tune-variant',
};

type Status = 'loading' | 'unavailable' | 'needs_setup' | 'restore_first' | 'never' | 'stale' | 'ok';

export const BackupSettingsScreen = () => {
  const navigation = useNavigation();
  const { user } = useAuth();
  const { theme } = useTheme();

  const [loaded, setLoaded] = useState(false);
  const [enrolled, setEnrolled] = useState(false);
  const [enrolledAt, setEnrolledAt] = useState<number | null>(null);
  const [frequency, setFrequency] = useState<BackupFrequency>('daily');
  const [allowCellular, setAllowCellular] = useState(false);
  const [icloud, setIcloud] = useState<{ available: boolean; reason?: string | null }>({ available: true });
  const [takeover, setTakeover] = useState<TakeoverAssessment | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState(false);
  const [selection, setSelection] = useState<BackupSelection>(DEFAULT_SELECTION);
  const [history, setHistory] = useState<BackupRunEntry[]>([]);
  const [readiness, setReadiness] = useState<BackupReadiness | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [restorePass, setRestorePass] = useState('');
  const [revealRestorePass, setRevealRestorePass] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;
    const [isEnrolled, at, freq, cellular, health, contents, runs] = await Promise.all([
      isPassphraseEnrolled(),
      getEnrolledAt(),
      getBackupFrequency(user.userId),
      getBackupAllowCellular(user.userId),
      isBackupHealthy(),
      getBackupSelection(),
      getBackupHistory(),
    ]);
    setEnrolled(isEnrolled);
    setEnrolledAt(at);
    setFrequency(freq);
    setAllowCellular(cellular);
    setIcloud({ available: health.isAvailable, reason: health.reason });
    setSelection(contents);
    setHistory(runs);
    await syncBackupSchedule(freq);
    setScheduled(await isBackupScheduled());
    if (health.isAvailable) {
      try {
        setTakeover(await assessTakeover());
        setSummaryError(null);
      } catch {
        setTakeover(null);
        setSummaryError(lastSummaryReadError ?? 'unknown');
      }
    }
    setLoaded(true);
    setReadiness(await assessBackupReadiness(user.userId));
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remote: BackupSummary | null = takeover?.remote ?? null;
  const theirsNotOurs = Boolean(remote && takeover && !takeover.sameChain);
  const staleAfterMs =
    frequency === 'off' ? Infinity : (frequency === 'daily' ? 1 : frequency === 'every3days' ? 3 : 7) * 2 * 86_400_000;

  const status: Status = !loaded
    ? 'loading'
    : !icloud.available || summaryError
      ? 'unavailable'
      : !enrolled && !theirsNotOurs
        ? 'needs_setup'
        : takeover?.wouldShrink
          ? 'restore_first'
          : !remote
            ? 'never'
            : Date.now() - remote.createdAt > staleAfterMs
              ? 'stale'
              : 'ok';

  // ----- Actions ------------------------------------------------------------

  const runBackup = async (replaceExisting = false) => {
    if (!user) return;
    setBusy('Starting…');
    setProgress(0);
    try {
      const info = await runBackupNow(
        user.userId,
        (p) => {
          const sent = p.bytesDone ? ` · ${formatBytes(p.bytesDone)} sent` : '';
          if (p.phase === 'messages' && p.chatsTotal > 0) {
            setProgress((p.chatsDone / p.chatsTotal) * 0.6);
            setBusy(`Chats ${p.chatsDone} of ${p.chatsTotal}${sent}`);
          } else if (p.phase === 'media' && p.filesTotal) {
            setProgress(0.62 + ((p.filesDone ?? 0) / p.filesTotal) * 0.33);
            setBusy(`Photos & videos ${p.filesDone ?? 0} of ${p.filesTotal}${sent}`);
          } else if (p.phase === 'extras') {
            setProgress(0.61);
            setBusy(`Call history and settings${sent}`);
          } else if (p.phase === 'manifest' || p.phase === 'verifying') {
            setProgress(0.97);
            setBusy('Checking the backup in iCloud…');
          }
        },
        'manual',
        { replaceExisting },
      );
      successHaptic();
      const skipped = info.mediaSkippedTooLarge ?? 0;
      appAlert(
        skipped > 0 ? 'Backed up, with some files skipped' : 'Backup complete',
        skipped > 0
          ? `${info.messageCount.toLocaleString()} messages are in iCloud. ${skipped} very large file${skipped === 1 ? '' : 's'} couldn't be included and stay on this phone only.`
          : `${info.messageCount.toLocaleString()} messages across ${info.chatCount} chats are in iCloud.`,
      );
    } catch (error) {
      errorHaptic();
      if (error instanceof BackupBlockedError && error.reason === 'would_replace_backup') {
        confirmReplace(error.message);
      } else {
        appAlert(
          error instanceof BackupBlockedError ? 'Can’t back up right now' : 'Backup didn’t finish',
          error instanceof BackupBlockedError
            ? error.message
            : 'Nothing was lost. Anything already sent is kept, and the next backup continues from there.',
        );
      }
    } finally {
      setBusy(null);
      setProgress(null);
      void refresh();
    }
  };

  const confirmReplace = (message: string) =>
    appAlert('There’s a bigger backup in iCloud', message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Replace it',
        style: 'destructive',
        onPress: () =>
          appAlert(
            'Replace the iCloud backup?',
            'The messages in that backup that aren’t on this phone will be gone for good.',
            [
              { text: 'Keep it', style: 'cancel' },
              { text: 'Replace', style: 'destructive', onPress: () => void runBackup(true) },
            ],
          ),
      },
    ]);

  const passphraseForRestore = async (): Promise<string> => {
    const typed = restorePass.trim();
    if (typed) return typed;
    const stored = await getStoredPassphrase();
    if (stored) return stored;
    throw new Error('missing');
  };

  const runRestore = async () => {
    let pass: string;
    try {
      pass = await passphraseForRestore();
    } catch {
      appAlert('Enter the passphrase', 'Type the backup passphrase you set on your other phone.');
      return;
    }
    setBusy('Checking the passphrase…');
    setProgress(0);
    try {
      // Decrypting the manifest proves the passphrase before anything is
      // written, so a typo fails fast with a clear message.
      const manifest = await readBackupManifest(pass).catch(() => null);
      if (!manifest) {
        errorHaptic();
        appAlert('Wrong passphrase', 'That passphrase doesn’t open this backup. Check it and try again.');
        return;
      }
      if (!enrolled) await adoptRestoredPassphrase(pass);
      const result = await importBackup(pass, (p) => {
        if (p.phase === 'messages' && p.chatsTotal > 0) {
          setProgress((p.chatsDone / p.chatsTotal) * 0.7);
          setBusy(`Restoring chats · ${p.messagesRestored.toLocaleString()} messages`);
        } else if (p.phase === 'media' && p.filesTotal) {
          setProgress(0.72 + ((p.filesDone ?? 0) / p.filesTotal) * 0.27);
          setBusy(`Restoring photos & videos · ${p.filesDone ?? 0} of ${p.filesTotal}`);
        } else if (p.phase === 'extras') {
          setProgress(0.71);
          setBusy('Restoring call history and settings…');
        }
      });
      successHaptic();
      const gaps = result.missingBatches.length > 0 || result.mediaFailed > 0;
      const lines = [
        `${result.messagesRestored.toLocaleString()} messages${result.mediaRestored ? ` and ${result.mediaRestored} photos & videos` : ''} restored.`,
        gaps ? 'Some parts of the backup couldn’t be read.' : '',
        result.needsRestart ? 'Restart the app to apply your restored appearance and currency settings.' : '',
      ].filter(Boolean);
      appAlert(gaps ? 'Restored with gaps' : 'Restore complete', lines.join('\n\n'));
      setRestorePass('');
    } catch {
      errorHaptic();
      appAlert('Restore didn’t finish', 'Nothing on this phone was removed. Check your connection and try again.');
    } finally {
      setBusy(null);
      setProgress(null);
      void refresh();
    }
  };

  const handleFrequency = async (next: BackupFrequency) => {
    if (!user) return;
    lightHaptic();
    setFrequency(next);
    await setBackupFrequency(user.userId, next);
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

  // ----- Render -------------------------------------------------------------

  if (status === 'loading') {
    return (
      <LiquidBackground>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </LiquidBackground>
    );
  }

  const hero: Record<Exclude<Status, 'loading'>, { icon: string; color: string; title: string; body: string }> = {
    ok: {
      icon: 'cloud-check-outline',
      color: theme.colors.moneyPositive,
      title: `Backed up ${remote ? relativeTime(remote.createdAt) : ''}`,
      body: '',
    },
    stale: {
      icon: 'cloud-alert-outline',
      color: theme.colors.warning ?? theme.colors.danger,
      title: `Last backup ${remote ? relativeTime(remote.createdAt) : ''}`,
      body: 'Automatic backups haven’t run lately. iOS runs them overnight while charging on Wi-Fi. Back up now to be safe.',
    },
    never: {
      icon: 'cloud-upload-outline',
      color: theme.colors.primary,
      title: 'Not backed up yet',
      body: 'Your chats live only on this phone until the first backup.',
    },
    needs_setup: {
      icon: 'lock-plus-outline',
      color: theme.colors.primary,
      title: 'Turn on iCloud backup',
      body: 'Set a passphrase to encrypt your backup. Only you can open it, not Apple and not us.',
    },
    restore_first: {
      icon: 'cloud-download-outline',
      color: theme.colors.primary,
      title: 'Restore your backup first',
      body: 'iCloud has a backup with more messages than this phone. Restore it below, so this phone continues that backup instead of replacing it.',
    },
    unavailable: {
      icon: 'cloud-off-outline',
      color: theme.colors.danger,
      title: 'iCloud isn’t available',
      body: summaryError
        ? 'We couldn’t reach your backup in iCloud. Check your connection and that iCloud is on for ManaSplit.'
        : `${icloudReasonText(icloud.reason)} Your chats still sync live between your devices.`,
    },
  };
  const h = hero[status];
  const summaryLine = remote
    ? `${remote.totalMessages.toLocaleString()} messages · ${remote.chatCount} chats${remote.bytes ? ` · ${formatBytes(remote.bytes)}` : ''}${
        remote.deviceName ? ` · from ${remote.deviceName}` : ''
      }`
    : null;
  const blocking = readiness?.conditions.filter((c) => !c.met && c.key !== 'scheduled') ?? [];

  return (
    <LiquidBackground>
      <DetailScreenScaffold horizontalInset={SCREEN_GUTTER} contentContainerStyle={styles.container}>
        {/* 1. Status */}
        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          <View style={styles.heroRow}>
            <View style={[styles.heroIcon, { backgroundColor: `${h.color}22` }]}>
              <Icon source={h.icon} size={26} color={h.color} />
            </View>
            <View style={styles.flex}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                {h.title}
              </Text>
              {summaryLine && status !== 'restore_first' ? (
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  {summaryLine}
                </Text>
              ) : null}
            </View>
          </View>
          {h.body ? (
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              {h.body}
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

          {status === 'needs_setup' ? (
            <Button
              mode="contained"
              onPress={() => {
                lightHaptic();
                (navigation as any).navigate(ROUTES.APP.BACKUP_PASSPHRASE);
              }}
            >
              Set a passphrase
            </Button>
          ) : status !== 'restore_first' && status !== 'unavailable' ? (
            <Button mode="contained" disabled={busy !== null || blocking.length > 0} onPress={() => void runBackup()}>
              Back up now
            </Button>
          ) : null}

          {status !== 'needs_setup' && status !== 'unavailable' && blocking.length > 0 ? (
            <View style={styles.blockList}>
              {blocking.map((condition) => (
                <View key={condition.key} style={styles.blockRow}>
                  <Icon source="alert-circle-outline" size={16} color={theme.colors.danger} />
                  <Text variant="bodySmall" style={[styles.flex, { color: theme.colors.onSurfaceVariant }]}>
                    {condition.detail ?? condition.label}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </GlassCard>

        {/* 2. Restore — only for a backup this phone didn't write or restore */}
        {theirsNotOurs && remote ? (
          <GlassCard style={styles.card} contentStyle={styles.cardContent}>
            <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
              Backup found in iCloud
            </Text>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              {`${remote.totalMessages.toLocaleString()} messages across ${remote.chatCount} chats, backed up ${relativeTime(remote.createdAt)}${
                remote.deviceName ? ` from ${remote.deviceName}` : ''
              }. Restoring adds them to this phone and keeps everything already here.`}
            </Text>
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
                right={<TextInput.Icon icon={revealRestorePass ? 'eye-off' : 'eye'} onPress={() => setRevealRestorePass((v) => !v)} />}
              />
            ) : null}
            <Button
              mode="contained"
              disabled={busy !== null || (!enrolled && restorePass.trim().length === 0)}
              onPress={() => void runRestore()}
            >
              Restore to this phone
            </Button>
            {takeover?.wouldShrink ? (
              <Button
                mode="text"
                disabled={busy !== null || !enrolled}
                textColor={theme.colors.danger}
                onPress={() =>
                  confirmReplace(
                    `iCloud has ${remote.totalMessages.toLocaleString()} messages and this phone has ${takeover.localMessages.toLocaleString()}.`,
                  )
                }
              >
                Replace it with this phone’s chats
              </Button>
            ) : null}
          </GlassCard>
        ) : null}

        {/* 3. Automatic backups */}
        <SectionLabel>Automatic backups</SectionLabel>
        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          <SegmentedControl
            value={frequency}
            onChange={(v) => void handleFrequency(v)}
            options={FREQUENCIES}
            accessibilityLabel="How often to back up"
          />
          <Text
            variant="bodySmall"
            style={{
              color: frequency !== 'off' && !scheduled && icloud.available ? theme.colors.danger : theme.colors.onSurfaceVariant,
            }}
          >
            {frequency === 'off'
              ? 'Only when you tap Back up now.'
              : scheduled || !icloud.available
                ? 'Usually overnight while charging on Wi-Fi. iOS picks the exact time. Each run only sends what changed.'
                : 'iOS didn’t accept the schedule on this phone. Use Back up now until it does.'}
          </Text>
          <Divider />
          <Pressable
            style={styles.switchRow}
            onPress={() => void handleCellular(!allowCellular)}
            accessibilityRole="switch"
            accessibilityLabel="Back up over cellular"
            accessibilityState={{ checked: allowCellular }}
          >
            <View style={styles.flex}>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                Back up over cellular
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Photos and videos can be large.
              </Text>
            </View>
            <Switch
              value={allowCellular}
              onValueChange={(v) => void handleCellular(v)}
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            />
          </Pressable>
        </GlassCard>

        {/* 4. What's included */}
        <SectionLabel>What’s included</SectionLabel>
        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          {BACKUP_CATEGORIES.map((category, index) => {
            const size = remote?.sizes?.[category.key];
            return (
              <View key={category.key}>
                {index > 0 ? <Divider /> : null}
                <Pressable
                  style={styles.switchRow}
                  onPress={() => void handleCategory(category.key, !selection[category.key])}
                  accessibilityRole="switch"
                  accessibilityLabel={category.label}
                  accessibilityState={{ checked: selection[category.key] }}
                >
                  <Icon source={CATEGORY_ICONS[category.key]} size={20} color={theme.colors.primary} />
                  <View style={styles.flex}>
                    <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                      {category.label}
                    </Text>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      {selection[category.key] && size ? `${formatBytes(size)} in iCloud` : category.description}
                    </Text>
                  </View>
                  <Switch
                    value={selection[category.key]}
                    onValueChange={(v) => void handleCategory(category.key, v)}
                    pointerEvents="none"
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                  />
                </Pressable>
              </View>
            );
          })}
          {!selection.messages ? (
            <Text variant="bodySmall" style={{ color: theme.colors.danger }}>
              With chat messages off, your conversations aren’t backed up.
            </Text>
          ) : null}
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Expenses, groups, balances and your profile are kept on our servers and come back when you sign in.
          </Text>
        </GlassCard>

        {/* 5. Security */}
        <SectionLabel>Security</SectionLabel>
        <GlassCard style={styles.card} contentStyle={styles.listContent}>
          <ListRow
            title="Backup passphrase"
            subtitle={
              enrolled
                ? `End-to-end encrypted${enrolledAt ? ` · set ${new Date(enrolledAt).toLocaleDateString()}` : ''}. We can’t reset it.`
                : 'Not set'
            }
            icon="lock-outline"
            chevron
            onPress={() => {
              lightHaptic();
              (navigation as any).navigate(ROUTES.APP.BACKUP_PASSPHRASE);
            }}
          />
          <ListRow
            title="Wipe or sell this phone"
            subtitle="Check your backup opens before you erase it"
            icon="cellphone-remove"
            chevron
            onPress={() => {
              lightHaptic();
              (navigation as any).navigate(ROUTES.APP.DEVICE_RETIREMENT);
            }}
          />
          {history.length > 0 ? (
            <ListRow
              title="Recent backups"
              subtitle={showHistory ? 'Hide' : `${history.length} recorded on this phone`}
              icon="history"
              onPress={() => setShowHistory((v) => !v)}
            />
          ) : null}
        </GlassCard>

        {/* 6. Recent runs (on demand) */}
        {showHistory ? <BackupHistoryCard history={history} /> : null}
      </DetailScreenScaffold>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: { gap: 10, paddingBottom: 40 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: { borderRadius: 20 },
  cardContent: { padding: 18, gap: 12 },
  listContent: { paddingVertical: 4 },
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  heroIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  busyBlock: { gap: 8 },
  blockList: { gap: 6 },
  blockRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
});
