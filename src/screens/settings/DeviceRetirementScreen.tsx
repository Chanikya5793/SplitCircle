// Device retirement / promotion safety gate (doc 31 §3.7, Phase 7).
//
// This screen's job is to tell someone whether it is safe to wipe or give away
// a phone. It therefore defaults to "not safe" and only ever unlocks on
// positive evidence — never on the absence of a detected problem.
//
// §3.7 point 5: the retire action is DISABLED until the two-device handshake
// completes, not warn-and-allow. The escape hatch exists (never make leaving
// literally impossible) but is deliberately effortful: a typed phrase, not a
// second "are you sure".

import { GlassCard } from '@/components/ui';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { getStoredPassphrase } from '@/services/backupPassphraseService';
import { runBackupNow } from '@/services/backupRunner';
import {
  FORCE_RETIRE_PHRASE,
  assessRetirementReadiness,
  publishRetirementAttestation,
  verifyBackupAsSecondDevice,
  type RetirementReadiness,
} from '@/services/deviceRetirementService';
import { getCurrentDeviceId, revokeDevice } from '@/services/pairingService';
import { appAlert } from '@/utils/appAlert';
import { errorHaptic, successHaptic } from '@/utils/haptics';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Text, TextInput } from 'react-native-paper';

export const DeviceRetirementScreen = () => {
  const { user } = useAuth();
  const { theme } = useTheme();

  const [readiness, setReadiness] = useState<RetirementReadiness | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [forcePhrase, setForcePhrase] = useState('');
  const [showEscapeHatch, setShowEscapeHatch] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;
    const passphrase = await getStoredPassphrase();
    if (!passphrase) {
      setReadiness({
        canRetire: false,
        blockers: [
          {
            code: 'no_backup',
            message: 'Set a backup passphrase first, then back up this device.',
          },
        ],
        manifest: null,
        otherDeviceCount: 0,
      });
      return;
    }
    setReadiness(await assessRetirementReadiness(user.userId, passphrase));
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const withBusy = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (error) {
      errorHaptic();
      appAlert('Something went wrong', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  // §3.7 point 3: force a fresh backup, then publish the signed snapshot the
  // other device will verify against.
  const handleStartCheck = () =>
    withBusy('Backing up…', async () => {
      if (!user) return;
      const passphrase = await getStoredPassphrase();
      if (!passphrase) throw new Error('No backup passphrase is set on this device.');
      await runBackupNow(user.userId);
      const current = await assessRetirementReadiness(user.userId, passphrase);
      if (!current.manifest) throw new Error('Backup could not be read after completing.');
      await publishRetirementAttestation(user.userId, passphrase, current.manifest);
      successHaptic();
    });

  // Run on the OTHER device. Actually decrypts every batch, per §3.7 point 3.
  const handleVerifyHere = () =>
    withBusy('Verifying backup…', async () => {
      const passphrase = await getStoredPassphrase();
      if (!passphrase) throw new Error('No backup passphrase is set on this device.');
      const result = await verifyBackupAsSecondDevice(passphrase);
      if (!result.ok) {
        throw new Error(
          `Could not read ${result.failures.length} part(s) of the backup. It is NOT safe to retire the other device yet.`,
        );
      }
      successHaptic();
      appAlert(
        'Backup verified',
        `Decrypted ${result.batchesDecrypted} batches successfully. Your other device can now be retired.`,
      );
    });

  const handleRetire = () =>
    appAlert(
      'Retire this device?',
      'This device will be signed out and unlinked. Your chat history stays in your verified iCloud backup.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Retire',
          style: 'destructive',
          onPress: () =>
            void withBusy('Retiring…', async () => {
              await revokeDevice(await getCurrentDeviceId());
            }),
        },
      ],
    );

  const handleForceRetire = () =>
    withBusy('Retiring…', async () => {
      await revokeDevice(await getCurrentDeviceId());
    });

  if (!readiness) {
    return (
      <LiquidBackground>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </LiquidBackground>
    );
  }

  const isVerifierRole = readiness.blockers.some((b) => b.code === 'awaiting_verification');

  return (
    <LiquidBackground>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            {readiness.canRetire ? 'Safe to retire this device' : 'Not yet safe to retire'}
          </Text>

          {readiness.canRetire ? (
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              Another device has confirmed it can read your backup. Your history is recoverable.
            </Text>
          ) : (
            readiness.blockers.map((blocker) => (
              <Text
                key={blocker.code}
                variant="bodyMedium"
                style={{ color: theme.colors.onSurfaceVariant }}
              >
                • {blocker.message}
              </Text>
            ))
          )}

          {busy ? (
            <View style={styles.busyRow}>
              <ActivityIndicator size="small" color={theme.colors.primary} />
              <Text variant="bodySmall" style={{ color: theme.colors.primary }}>
                {busy}
              </Text>
            </View>
          ) : null}
        </GlassCard>

        {!readiness.canRetire ? (
          <GlassCard style={styles.card} contentStyle={styles.cardContent}>
            <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
              {readiness.otherDeviceCount === 0 ? 'Pair your new device first' : 'Run the safety check'}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {readiness.otherDeviceCount === 0
                ? 'Set up SplitCircle on your new phone and link it to this account. Only another device can prove your backup is actually readable — this one cannot check its own work.'
                : 'This backs up now, then asks your other device to confirm it can genuinely read the result.'}
            </Text>
            {readiness.otherDeviceCount > 0 ? (
              <Button mode="contained" disabled={busy !== null} onPress={handleStartCheck}>
                Back up and start check
              </Button>
            ) : null}
            {isVerifierRole ? (
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                On your OTHER device, open this screen and tap “Verify backup here”.
              </Text>
            ) : null}
          </GlassCard>
        ) : null}

        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
            Verifying for another device?
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            If your other phone is waiting on confirmation, run this here. It downloads and actually
            decrypts every part of the backup.
          </Text>
          <Button mode="outlined" disabled={busy !== null} onPress={handleVerifyHere}>
            Verify backup here
          </Button>
        </GlassCard>

        <Button
          mode="contained"
          // Disabled, not warn-and-allow (§3.7 point 5).
          disabled={!readiness.canRetire || busy !== null}
          onPress={handleRetire}
        >
          Retire this device
        </Button>

        {!readiness.canRetire ? (
          <GlassCard style={styles.card} contentStyle={styles.cardContent}>
            {showEscapeHatch ? (
              <>
                <Text variant="titleSmall" style={{ color: theme.colors.danger }}>
                  Retire without a verified backup
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  Your chat history on this device will be permanently lost and cannot be recovered
                  by anyone, including us. To confirm you understand, type{' '}
                  <Text style={{ color: theme.colors.danger }}>{FORCE_RETIRE_PHRASE}</Text> below.
                </Text>
                <TextInput
                  mode="outlined"
                  label="Confirmation phrase"
                  value={forcePhrase}
                  onChangeText={setForcePhrase}
                  autoCapitalize="characters"
                  autoCorrect={false}
                />
                <Button
                  mode="contained"
                  buttonColor={theme.colors.danger}
                  disabled={forcePhrase.trim() !== FORCE_RETIRE_PHRASE || busy !== null}
                  onPress={handleForceRetire}
                >
                  Permanently retire and lose history
                </Button>
              </>
            ) : (
              <Button mode="text" textColor={theme.colors.danger} onPress={() => setShowEscapeHatch(true)}>
                Retire anyway and lose my history
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
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
