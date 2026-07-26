// What a new device sees after signing in (product-owner redesign,
// 2026-07-26). Replaces RecoverAccountPanel and the dead-end "waiting for
// confirmation" screen.
//
// THE PROBLEM WITH WHAT THIS REPLACES. Signing in on a new phone dropped the
// user into a waiting room: "Approve this device from Settings → Linked
// devices on a device you already use." That is the wrong question to lead
// with, and for someone replacing a lost phone it was unanswerable — the
// approver named is the device they no longer have. Recovery existed but was
// buried behind a secondary button, framed as an escape hatch rather than the
// thing most people arriving here actually want.
//
// So the screen now ASKS instead of assuming: is this your new phone, or an
// extra device? Both answers lead somewhere. Nobody is parked.
//
// The backup summary is shown BEFORE the choice, because "restore" is
// meaningless without knowing what would come back — and a stale or missing
// backup is exactly the thing you want to notice before you commit.

import { GlassCard } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import {
  BackupProofError,
  hasRecoverableBackup,
  recoverWithPassphrase,
  recoverWithoutBackup,
  type BackupSummary,
} from '@/services/accountRecoveryService';
import { formatBytes } from '@/components/backup/BackupInsightCards';
import { errorHaptic, successHaptic } from '@/utils/haptics';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Divider, Text, TextInput } from 'react-native-paper';

/** Typed verbatim to continue without a backup — deliberately effortful. */
const NO_BACKUP_PHRASE = 'DELETE MY CHAT HISTORY';

type Step = 'choose' | 'restore' | 'no_backup';

interface Props {
  /** Shown while this device waits for approval on the companion path. */
  confirmationCode?: string | null;
  waitingForApproval: boolean;
  onCancel: () => void;
  onBecameMain: () => void;
}

const relative = (timestamp: number): string => {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.floor(hours / 24)} day${Math.floor(hours / 24) === 1 ? '' : 's'} ago`;
};

export const DeviceSetupChoice = ({
  confirmationCode,
  waitingForApproval,
  onCancel,
  onBecameMain,
}: Props) => {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();

  const [step, setStep] = useState<Step>('choose');
  const [backup, setBackup] = useState<{ hasBackup: boolean; summary: BackupSummary | null } | null>(
    null,
  );
  const [passphrase, setPassphrase] = useState('');
  const [reveal, setReveal] = useState(false);
  const [phrase, setPhrase] = useState('');
  /** Null until asked — see the old-device question below. */
  const [keepOld, setKeepOld] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void hasRecoverableBackup().then(setBackup);
  }, []);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      successHaptic();
      onBecameMain();
    } catch (err) {
      errorHaptic();
      setError(
        err instanceof BackupProofError
          ? err.message
          : err instanceof Error && err.message.includes('BACKUP_PROOF_REQUIRED')
            ? 'This account has a backup, so the passphrase is required.'
            : "That didn't work. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const summary = backup?.summary ?? null;

  /**
   * Whether the old device is kept or cut off.
   *
   * Asked explicitly rather than inferred, because the two situations are
   * opposite and only the user knows which they're in: a phone still in their
   * hand should keep working as a companion, while one that was lost or sold
   * must lose access immediately — and this is the only flow that can cut it
   * off without needing that device's cooperation.
   */
  const oldDeviceQuestion = (
    <GlassCard style={styles.card} contentStyle={styles.cardContent}>
      <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
        Do you still have your old phone?
      </Text>
      <View style={styles.choiceRow}>
        <Button
          mode={keepOld === true ? 'contained' : 'outlined'}
          style={styles.choiceButton}
          disabled={busy}
          onPress={() => setKeepOld(true)}
        >
          Yes, I have it
        </Button>
        <Button
          mode={keepOld === false ? 'contained' : 'outlined'}
          style={styles.choiceButton}
          disabled={busy}
          onPress={() => setKeepOld(false)}
        >
          No — lost or sold
        </Button>
      </View>
      {keepOld === true ? (
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          It stays signed in as a companion — it keeps your chats and still receives messages, it
          just stops being the device that backs up.
        </Text>
      ) : keepOld === false ? (
        <Text variant="bodySmall" style={{ color: theme.colors.danger }}>
          It will be signed out immediately and lose access to your account. Do this if it was
          lost, stolen or sold.
        </Text>
      ) : null}
    </GlassCard>
  );

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
          Set up this device
        </Text>
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
          You&apos;re signed in. How do you want to use this phone?
        </Text>

        {/* What's in iCloud, shown BEFORE the choice — restoring is an
            abstraction until you can see what comes back, and a stale or
            missing backup is precisely what you want to notice first. */}
        <Divider />
        {backup === null ? (
          <ActivityIndicator size="small" color={theme.colors.primary} />
        ) : summary ? (
          <>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
              Your last backup was {relative(summary.createdAt)}
              {summary.deviceName ? ` from ${summary.deviceName}` : ''}.
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {summary.totalMessages.toLocaleString()} messages across {summary.chatCount} chats
              {summary.mediaCount > 0 ? `, ${summary.mediaCount.toLocaleString()} photos & videos` : ''}
              {summary.bytes > 0 ? ` · ${formatBytes(summary.bytes)}` : ''}
            </Text>
          </>
        ) : (
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            No backup found for this account. Your groups, expenses and balances are safe on our
            servers either way — only chat history depends on a backup.
          </Text>
        )}
      </GlassCard>

      {step === 'choose' ? (
        <>
          <GlassCard style={styles.card} contentStyle={styles.cardContent}>
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
              This is my new phone
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Restore your chats here and make this the device that backs up. You&apos;ll need your
              backup passphrase.
            </Text>
            <Button mode="contained" onPress={() => setStep(summary ? 'restore' : 'no_backup')}>
              Restore onto this phone
            </Button>
          </GlassCard>

          <GlassCard style={styles.card} contentStyle={styles.cardContent}>
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
              This is an extra device
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Use it alongside your main phone. Approve it from a device you already use, and
              recent chat history syncs over automatically.
            </Text>
            {waitingForApproval ? (
              <>
                <View style={styles.waitingRow}>
                  <ActivityIndicator size="small" color={theme.colors.primary} />
                  <Text variant="bodyMedium" style={{ color: theme.colors.primary }}>
                    Waiting for approval…
                  </Text>
                </View>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  {confirmationCode
                    ? 'On your other device, check the code below matches.'
                    : 'Open Settings → Linked devices on your main phone and approve this one.'}
                </Text>
                {confirmationCode ? (
                  <Text variant="displaySmall" style={[styles.code, { color: theme.colors.primary }]}>
                    {confirmationCode}
                  </Text>
                ) : null}
              </>
            ) : null}
          </GlassCard>
        </>
      ) : null}

      {step === 'restore' ? (
        <>
          <GlassCard style={styles.card} contentStyle={styles.cardContent}>
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
              Backup passphrase
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              The passphrase you set when you turned on backups. We can&apos;t reset it.
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
            <Button mode="text" disabled={busy} onPress={() => setStep('no_backup')}>
              I don&apos;t have my passphrase
            </Button>
          </GlassCard>

          {oldDeviceQuestion}

          <Button
            mode="contained"
            loading={busy}
            disabled={busy || passphrase.trim().length === 0 || keepOld === null}
            onPress={() => void run(() => recoverWithPassphrase(passphrase, keepOld === true))}
          >
            Restore and continue
          </Button>
        </>
      ) : null}

      {step === 'no_backup' ? (
        <>
          <GlassCard style={styles.card} contentStyle={styles.cardContent}>
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
              Continue without your chat history
            </Text>
            {/* Allowed on purpose. firestore.rules gates chats and expenses on
                the signed-in account rather than a paired device, so refusing
                would block nobody who already holds these credentials — it
                would only strand a real user out of their own account. */}
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {summary
                ? 'Without the passphrase your backup cannot be opened — not by you, not by us. You can still use this device, but those messages will not come back.'
                : 'There is no backup to restore. You can still use this device — your groups, expenses and balances are safe on our servers — but past chat messages will not come back.'}
            </Text>
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
          </GlassCard>

          {oldDeviceQuestion}

          <Button
            mode="contained"
            buttonColor={theme.colors.danger}
            loading={busy}
            disabled={busy || phrase.trim().toUpperCase() !== NO_BACKUP_PHRASE || keepOld === null}
            onPress={() => void run(() => recoverWithoutBackup(keepOld === true))}
          >
            Continue without my chat history
          </Button>
        </>
      ) : null}

      {error ? (
        <Text variant="bodySmall" style={[styles.error, { color: theme.colors.danger }]}>
          {error}
        </Text>
      ) : null}

      <Button
        mode="text"
        disabled={busy}
        onPress={() => (step === 'choose' ? onCancel() : setStep('choose'))}
      >
        {step === 'choose' ? 'Sign out' : 'Back'}
      </Button>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  scroll: { padding: 20, gap: 14 },
  card: { width: '100%', borderRadius: 20 },
  cardContent: { padding: 20, gap: 12 },
  title: { fontWeight: '700' },
  choiceRow: { flexDirection: 'row', gap: 10 },
  choiceButton: { flex: 1 },
  waitingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  code: { fontWeight: '800', letterSpacing: 4, textAlign: 'center' },
  error: { textAlign: 'center' },
});
