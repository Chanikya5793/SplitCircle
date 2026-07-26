// New-main-device recovery (doc 31 §3.12), presented INSIDE PendingPairingGate
// rather than as a navigator screen.
//
// That placement is the whole point. A user in this state is blocked behind the
// gate with no route into the app — there is no tab bar, no Settings, nothing
// to navigate from — and the device they are being told to approve from is the
// one they no longer have. The escape has to live exactly where they are stuck.
//
// See functions/src/accountRecovery.ts for why the passphrase proof is checked
// server-side and why recovery revokes every other device.

import { GlassCard } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import {
  BackupProofError,
  hasRecoverableBackup,
  recoverWithPassphrase,
  recoverWithoutBackup,
} from '@/services/accountRecoveryService';
import { errorHaptic, successHaptic } from '@/utils/haptics';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Text, TextInput } from 'react-native-paper';

/** Typed verbatim to proceed without a backup — deliberately effortful. */
const NO_BACKUP_PHRASE = 'DELETE MY CHAT HISTORY';

interface Props {
  onCancel: () => void;
  onRecovered: (revokedCount: number) => void;
}

export const RecoverAccountPanel = ({ onCancel, onRecovered }: Props) => {
  const { theme } = useTheme();
  // Real device insets, not a guessed constant: this renders as a full-screen
  // overlay with no navigator chrome, so nothing else clears the Dynamic
  // Island above or the home indicator below.
  const insets = useSafeAreaInsets();
  const [passphrase, setPassphrase] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasBackup, setHasBackup] = useState<boolean | null>(null);
  const [showNoBackup, setShowNoBackup] = useState(false);
  const [phrase, setPhrase] = useState('');

  useEffect(() => {
    void hasRecoverableBackup().then(setHasBackup);
  }, []);

  const run = async (action: () => Promise<{ revokedDeviceIds: string[] }>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      successHaptic();
      onRecovered(result.revokedDeviceIds.length);
    } catch (err) {
      errorHaptic();
      setError(
        err instanceof BackupProofError
          ? err.message
          : err instanceof Error && err.message.includes('BACKUP_PROOF_REQUIRED')
            ? 'Your account has a backup, so the passphrase is required to recover.'
            : "We couldn't complete recovery. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      contentContainerStyle={[
        styles.scroll,
        { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 32 },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <GlassCard style={styles.card} contentStyle={styles.cardContent}>
        <Text variant="headlineSmall" style={[styles.title, { color: theme.colors.onSurface }]}>
          Use this as your main device
        </Text>
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
          If your old device is lost, broken, or gone, you can set this one up from your iCloud
          backup instead of approving from the old one.
        </Text>
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          You&apos;ll need to be signed into the same iCloud account and know your backup
          passphrase.
        </Text>
        <Text variant="bodySmall" style={{ color: theme.colors.danger }}>
          Any other devices on your account will be signed out. If you still have your old device,
          approve from there instead — you&apos;ll keep both.
        </Text>
      </GlassCard>

      {hasBackup !== false ? (
        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            Backup passphrase
          </Text>
          <TextInput
            mode="outlined"
            label="Passphrase"
            value={passphrase}
            onChangeText={setPassphrase}
            secureTextEntry={!reveal}
            autoCapitalize="none"
            autoCorrect={false}
            disabled={busy}
            right={
              <TextInput.Icon
                icon={reveal ? 'eye-off' : 'eye'}
                onPress={() => setReveal((value) => !value)}
              />
            }
          />
          <Button
            mode="contained"
            loading={busy && !showNoBackup}
            disabled={busy || passphrase.trim().length === 0}
            onPress={() => void run(() => recoverWithPassphrase(passphrase))}
          >
            Restore and continue
          </Button>
        </GlassCard>
      ) : null}

      {/* The no-backup path. Offered because refusing it would strand a real
          user permanently while buying nothing: firestore.rules already gates
          chats and expenses on the signed-in account, not on a paired device,
          so these same credentials can reach that data regardless. Chat
          history, which lives only on-device, genuinely is gone. */}
      <GlassCard style={styles.card} contentStyle={styles.cardContent}>
        <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
          {hasBackup === false ? 'No backup found' : "Don't have your passphrase?"}
        </Text>
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          {hasBackup === false
            ? "We couldn't find a backup for your account. You can still use this device — your groups, expenses and balances are safe on the server — but your chat history won't come back."
            : 'Without the passphrase your backup cannot be opened, by us or by anyone. You can still continue, but your chat history will not be restored.'}
        </Text>

        {showNoBackup ? (
          <>
            <Text variant="bodySmall" style={{ color: theme.colors.danger }}>
              Type {NO_BACKUP_PHRASE} to confirm.
            </Text>
            <TextInput
              mode="outlined"
              label="Confirmation"
              value={phrase}
              onChangeText={setPhrase}
              autoCapitalize="characters"
              autoCorrect={false}
              disabled={busy}
            />
            <Button
              mode="contained"
              buttonColor={theme.colors.danger}
              loading={busy && showNoBackup}
              disabled={busy || phrase.trim().toUpperCase() !== NO_BACKUP_PHRASE}
              onPress={() => void run(recoverWithoutBackup)}
            >
              Continue without my chat history
            </Button>
          </>
        ) : (
          <Button mode="outlined" disabled={busy} onPress={() => setShowNoBackup(true)}>
            Continue without a backup
          </Button>
        )}
      </GlassCard>

      {error ? (
        <Text variant="bodySmall" style={[styles.error, { color: theme.colors.danger }]}>
          {error}
        </Text>
      ) : null}

      <Button mode="text" disabled={busy} onPress={onCancel}>
        Back
      </Button>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  scroll: {
    padding: 20,
    gap: 14,
  },
  card: {
    width: '100%',
    borderRadius: 20,
  },
  cardContent: {
    padding: 20,
    gap: 12,
  },
  title: {
    fontWeight: '700',
  },
  error: {
    textAlign: 'center',
  },
});
