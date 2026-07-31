// "Before you sell or wipe this phone" (doc 31 §3.7, reframed 2026-07-26).
//
// WHAT THIS USED TO BE, AND WHY IT DIDN'T WORK. This screen tried to be both a
// migration wizard and a disposal check, and the migration half required a
// two-device attestation handshake driven from here. That made it
// undiscoverable in the most literal way: to verify a backup so you could
// retire your OLD phone, you had to open a screen titled "Retire this device"
// on your NEW phone and tap "Verify backup here". Nobody finds that. It also
// called getStoredPassphrase() on the verifying device, which on a
// newly-paired phone is empty — so even a user who did find it hit "No backup
// passphrase is set on this device."
//
// Migration now happens where it belongs: on the new phone, at sign-in
// (DeviceSetupChoice). That leaves this screen one honest job — answering "is
// it safe to wipe this?" — which it can do without another device's help.
//
// The check is still REAL DECRYPTION, not a metadata comparison (§3.7 point
// 3): every batch is fetched back out of CloudKit and decrypted. The bytes
// genuinely round-trip through the server, which is the property that
// mattered — a structurally-intact-but-corrupt backup still fails.

import { GlassCard } from '@/components/ui';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { getStoredPassphrase } from '@/services/backupPassphraseService';
import { getLastBackupInfo, runBackupNow } from '@/services/backupRunner';
import { readBackupManifest, verifyBackup, type BackupManifest } from '@/services/backupService';
import { getCurrentDeviceId, revokeDevice, subscribeToPairedDevices } from '@/services/pairingService';
import { formatBytes } from '@/components/backup/BackupInsightCards';
import { appAlert } from '@/utils/appAlert';
import { errorHaptic, successHaptic } from '@/utils/haptics';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@react-navigation/elements';
import { Button, Divider, Text, TextInput } from 'react-native-paper';

/** Typed verbatim to sign out without a verified backup. */
const FORCE_PHRASE = 'DELETE MY CHAT HISTORY';

/** Older than this and we won't call it safe without a fresh run. */
const MAX_BACKUP_AGE_MS = 24 * 60 * 60 * 1000;

type CheckState =
  | { kind: 'idle' }
  | { kind: 'running'; message: string }
  | { kind: 'verified'; batches: number }
  | { kind: 'failed'; message: string };

export const DeviceRetirementScreen = () => {
  const { user } = useAuth();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();

  const [manifest, setManifest] = useState<BackupManifest | null>(null);
  const [lastBackupAt, setLastBackupAt] = useState<number | null>(null);
  const [otherDevices, setOtherDevices] = useState(0);
  const [enrolled, setEnrolled] = useState(false);
  const [check, setCheck] = useState<CheckState>({ kind: 'idle' });
  const [loading, setLoading] = useState(true);
  const [forcePhrase, setForcePhrase] = useState('');
  const [showEscapeHatch, setShowEscapeHatch] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;
    const passphrase = await getStoredPassphrase();
    setEnrolled(Boolean(passphrase));
    setLastBackupAt((await getLastBackupInfo())?.completedAt ?? null);
    if (passphrase) {
      try {
        setManifest(await readBackupManifest(passphrase));
      } catch {
        setManifest(null);
      }
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!user) return;
    return subscribeToPairedDevices(user.userId, (devices) => {
      void getCurrentDeviceId().then((own) => {
        setOtherDevices(
          devices.filter((d) => d.deviceId !== own && d.pairingStatus === 'confirmed').length,
        );
      });
    });
  }, [user]);

  const stale = lastBackupAt === null || Date.now() - lastBackupAt > MAX_BACKUP_AGE_MS;
  // Pre-selection backups are messages-only by definition, so an absent
  // `contents` map means messages ARE included.
  const messagesIncluded = manifest?.contents ? manifest.contents.messages === true : true;
  const safe = check.kind === 'verified' && !stale && messagesIncluded;

  /**
   * Back up, then read every batch back out of iCloud and decrypt it.
   *
   * The download-and-decrypt is the whole point. Comparing counts against a
   * manifest we wrote ourselves proves nothing — only fetching the ciphertext
   * back from the server and opening it shows the backup is genuinely
   * restorable, which is the single claim that justifies telling someone it is
   * safe to erase their phone.
   */
  const runSafetyCheck = async () => {
    if (!user) return;
    try {
      const passphrase = await getStoredPassphrase();
      if (!passphrase) throw new Error('Set a backup passphrase first.');

      setCheck({ kind: 'running', message: 'Backing up…' });
      await runBackupNow(user.userId, (p) => {
        setCheck({
          kind: 'running',
          message:
            p.phase === 'media'
              ? `Backing up photos: ${p.filesDone ?? 0} of ${p.filesTotal ?? 0}`
              : `Backing up ${p.messagesDone.toLocaleString()} messages…`,
        });
      });

      setCheck({ kind: 'running', message: 'Reading it back from iCloud…' });
      const fresh = await readBackupManifest(passphrase);
      if (!fresh) throw new Error('The backup could not be read back from iCloud.');
      setManifest(fresh);

      const result = await verifyBackup(passphrase, fresh);
      if (!result.ok) {
        throw new Error(
          `${result.missing.length} part(s) of the backup could not be read. It is NOT safe to wipe this phone yet.`,
        );
      }

      const batches = fresh.chats.reduce((sum, chat) => sum + chat.batchIds.length, 0);
      successHaptic();
      setCheck({ kind: 'verified', batches });
      setLastBackupAt(Date.now());
    } catch (error) {
      errorHaptic();
      setCheck({
        kind: 'failed',
        message: error instanceof Error ? error.message : 'The check could not finish.',
      });
    }
  };

  const signOutThisDevice = async () => {
    try {
      await revokeDevice(await getCurrentDeviceId());
    } catch (error) {
      errorHaptic();
      appAlert('Could not sign out', error instanceof Error ? error.message : 'Please try again.');
    }
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
      <ScrollView
        contentContainerStyle={[
          styles.container,
          { paddingTop: headerHeight + 16, paddingBottom: insets.bottom + 32 },
        ]}
      >
        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          <Text variant="headlineSmall" style={{ color: theme.colors.onSurface }}>
            {safe ? 'Safe to wipe this phone' : 'Check before you wipe this phone'}
          </Text>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
            {safe
              ? 'Your chat history is in iCloud and we read it back successfully. You can sign out and erase this phone.'
              : 'Your chats live only on this phone. Before you erase, sell or give it away, make sure they exist somewhere else.'}
          </Text>
          <Divider />
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Your groups, expenses, balances and settlements are stored on our servers and are not
            affected by wiping this phone — they come back the moment you sign in anywhere.
          </Text>
        </GlassCard>

        {/* Saying this out loud IS the fix for the old flow: people came here
            looking for migration and found an unsatisfiable checklist. */}
        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            Moving to a new phone?
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            You don&apos;t need this screen. Install ManaSplit on the new phone, sign in, and
            choose &ldquo;This is my new phone&rdquo; — it restores from this backup and asks what
            to do with this one.
          </Text>
          {otherDevices > 0 ? (
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              You have {otherDevices} other device{otherDevices === 1 ? '' : 's'} signed in to this
              account.
            </Text>
          ) : null}
        </GlassCard>

        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            Backup check
          </Text>

          {!enrolled ? (
            <Text variant="bodyMedium" style={{ color: theme.colors.danger }}>
              No backup passphrase is set, so nothing has ever been backed up. Set one in iCloud
              backup first.
            </Text>
          ) : (
            <>
              <Text
                variant="bodyMedium"
                style={{ color: stale ? theme.colors.danger : theme.colors.onSurface }}
              >
                {lastBackupAt
                  ? stale
                    ? 'Your last backup is more than a day old.'
                    : 'Backed up recently.'
                  : 'This phone has never completed a backup.'}
              </Text>
              {!messagesIncluded ? (
                <Text variant="bodyMedium" style={{ color: theme.colors.danger }}>
                  Chat messages are switched OFF in your backup settings, so your conversations are
                  not in the backup at all.
                </Text>
              ) : null}
              {manifest ? (
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  {manifest.totalMessages.toLocaleString()} messages across {manifest.chats.length}{' '}
                  chats
                  {manifest.sizes
                    ? ` · ${formatBytes(
                        Object.values(manifest.sizes).reduce((sum: number, n) => sum + (n ?? 0), 0),
                      )}`
                    : ''}
                </Text>
              ) : null}
            </>
          )}

          {check.kind === 'running' ? (
            <View style={styles.busyRow}>
              <ActivityIndicator size="small" color={theme.colors.primary} />
              <Text variant="bodySmall" style={{ color: theme.colors.primary }}>
                {check.message}
              </Text>
            </View>
          ) : null}

          {check.kind === 'verified' ? (
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
              ✓ Read back and decrypted {check.batches} batch{check.batches === 1 ? '' : 'es'} from
              iCloud.
            </Text>
          ) : null}

          {check.kind === 'failed' ? (
            <Text variant="bodyMedium" style={{ color: theme.colors.danger }}>
              {check.message}
            </Text>
          ) : null}

          <Button
            mode="contained"
            disabled={!enrolled || check.kind === 'running'}
            onPress={() => void runSafetyCheck()}
          >
            {check.kind === 'verified' ? 'Check again' : 'Back up and verify now'}
          </Button>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            This backs up, then downloads every part again and decrypts it — proving the backup is
            genuinely readable, not just that it exists.
          </Text>
        </GlassCard>

        <Button
          mode="contained"
          // Disabled rather than warn-and-allow (§3.7 point 5). The escape
          // hatch below keeps leaving from ever being literally impossible.
          disabled={!safe}
          onPress={() =>
            appAlert(
              'Sign out and unlink this phone?',
              'Your chat history stays in your verified iCloud backup. This phone will lose access to your account.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Sign out', style: 'destructive', onPress: () => void signOutThisDevice() },
              ],
            )
          }
        >
          Sign out and unlink this phone
        </Button>

        {!safe ? (
          <GlassCard style={styles.card} contentStyle={styles.cardContent}>
            {showEscapeHatch ? (
              <>
                <Text variant="titleSmall" style={{ color: theme.colors.danger }}>
                  Sign out without a verified backup
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  Your chat history on this phone will be permanently lost and cannot be recovered
                  by anyone, including us. Type{' '}
                  <Text style={{ color: theme.colors.danger }}>{FORCE_PHRASE}</Text> to confirm.
                </Text>
                <TextInput
                  mode="outlined"
                  label="Confirmation"
                  value={forcePhrase}
                  onChangeText={setForcePhrase}
                  autoCapitalize="characters"
                  autoCorrect={false}
                />
                <Button
                  mode="contained"
                  buttonColor={theme.colors.danger}
                  disabled={forcePhrase.trim().toUpperCase() !== FORCE_PHRASE}
                  onPress={() => void signOutThisDevice()}
                >
                  Sign out anyway
                </Button>
              </>
            ) : (
              <Button
                mode="text"
                textColor={theme.colors.danger}
                onPress={() => setShowEscapeHatch(true)}
              >
                Sign out anyway, without a backup
              </Button>
            )}
          </GlassCard>
        ) : null}
      </ScrollView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: { padding: 16, gap: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: { borderRadius: 20 },
  cardContent: { padding: 20, gap: 12 },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
