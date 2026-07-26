// Backup passphrase enrollment (doc 31 §3.5). Three deliberate gates, all
// required by the spec rather than chosen here:
//   1. A real ENFORCED minimum strength — not a suggestion. Decryption happens
//      offline against already-downloaded CKRecords, so no server rate-limits
//      guessing and passphrase entropy is the only thing protecting a stolen
//      blob.
//   2. The literal sentence "If you forget this passphrase, this backup cannot
//      be recovered by anyone, including us", shown at CREATION time — not
//      implied later in a banner.
//   3. An explicit "I've written it down" acknowledgement (WhatsApp's model,
//      which §3.5 says this design follows).

import { GlassCard } from '@/components/ui';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useTheme } from '@/context/ThemeContext';
import {
  assessPassphrase,
  clearPassphrase,
  enrollPassphrase,
  getEnrolledAt,
  isPassphraseEnrolled,
  type PassphraseAssessment,
} from '@/services/backupPassphraseService';
import {
  BackupBlockedError,
  getLastBackupInfo,
  runBackupNow,
  type LastBackupInfo,
} from '@/services/backupRunner';
import { useAuth } from '@/context/AuthContext';
import { appAlert } from '@/utils/appAlert';
import { errorHaptic, lightHaptic, successHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@react-navigation/elements';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button, Checkbox, Text, TextInput } from 'react-native-paper';

/** The exact sentence §3.5 requires. Do not soften or paraphrase this. */
const IRRECOVERABLE_WARNING =
  'If you forget this passphrase, this backup cannot be recovered by anyone, including us.';

const verdictLabel: Record<PassphraseAssessment['verdict'], string> = {
  'too-short': 'Too short',
  weak: 'Too weak',
  fair: 'Good',
  strong: 'Strong',
};

export const BackupPassphraseScreen = () => {
  const navigation = useNavigation();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const { user } = useAuth();

  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [enrolledAt, setEnrolledAt] = useState<number | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastBackup, setLastBackup] = useState<LastBackupInfo | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setEnrolled(await isPassphraseEnrolled());
      setEnrolledAt(await getEnrolledAt());
      setLastBackup(await getLastBackupInfo());
    })();
  }, []);

  const assessment = useMemo(() => assessPassphrase(passphrase), [passphrase]);
  const matches = passphrase.length > 0 && passphrase === confirmation;

  // Every gate must pass. Kept as one expression so there is exactly one
  // definition of "may enrol" rather than a button-disabled check that can
  // drift from the service's own validation.
  const canSubmit = assessment.meetsMinimum && matches && acknowledged && !saving;

  const strengthColor =
    assessment.verdict === 'strong'
      ? theme.colors.primary
      : assessment.verdict === 'fair'
        ? theme.colors.onSurface
        : theme.colors.danger;

  const handleEnroll = async () => {
    setSaving(true);
    try {
      await enrollPassphrase(passphrase);
      successHaptic();
      setEnrolled(true);
      setEnrolledAt(Date.now());
      setPassphrase('');
      setConfirmation('');
      setAcknowledged(false);
      appAlert(
        'Backup passphrase set',
        'Your iCloud backup will be encrypted with this passphrase. Keep your written copy somewhere safe.',
        [
          { text: 'Later', style: 'cancel' },
          { text: 'Back up now', onPress: () => void handleBackupNow() },
        ],
      );
    } catch (error) {
      errorHaptic();
      appAlert(
        'Could not set passphrase',
        error instanceof Error ? error.message : 'Please try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleBackupNow = async () => {
    if (!user) return;
    setBackingUp(true);
    setProgressLabel('Preparing…');
    try {
      const info = await runBackupNow(user.userId, (progress) => {
        setProgressLabel(
          progress.phase === 'messages'
            ? `Backing up ${progress.messagesDone} messages (${progress.chatsDone}/${progress.chatsTotal} chats)…`
            : progress.phase === 'manifest'
              ? 'Finishing up…'
              : 'Preparing…',
        );
      });
      setLastBackup(info);
      successHaptic();
      appAlert('Backup complete', `${info.messageCount} messages across ${info.chatCount} chats.`);
    } catch (error) {
      errorHaptic();
      // BackupBlockedError carries a specific reason so this can say WHY
      // rather than showing a generic failure.
      appAlert(
        error instanceof BackupBlockedError ? 'Can’t back up yet' : 'Backup failed',
        error instanceof Error ? error.message : 'Please try again.',
      );
    } finally {
      setBackingUp(false);
      setProgressLabel(null);
    }
  };

  const handleForget = () => {
    appAlert(
      'Forget passphrase on this device?',
      // Precise about what this does and does not do: it cannot re-encrypt or
      // delete a backup already in iCloud, and implying otherwise would be a
      // false sense of security.
      'Backups will stop running on this device until you set a passphrase again. Your existing iCloud backup is NOT deleted and still requires the old passphrase to restore.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Forget',
          style: 'destructive',
          onPress: async () => {
            await clearPassphrase();
            lightHaptic();
            setEnrolled(false);
            setEnrolledAt(null);
          },
        },
      ],
    );
  };

  if (enrolled === null) {
    // Enrollment state is read from the Keychain asynchronously; render an
    // empty backdrop rather than flashing the "choose a passphrase" form to
    // someone who already has one.
    return (
      <LiquidBackground>
        <View />
      </LiquidBackground>
    );
  }

  return (
    <LiquidBackground>
      <ScrollView contentContainerStyle={[styles.container, { paddingTop: headerHeight + 16, paddingBottom: insets.bottom + 32 }]} keyboardShouldPersistTaps="handled">
        {enrolled ? (
          <GlassCard style={styles.card} contentStyle={styles.cardContent}>
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
              Backup passphrase is set
            </Text>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              {enrolledAt
                ? `Set on ${new Date(enrolledAt).toLocaleDateString()}. `
                : ''}
              Your iCloud backup is encrypted with it. {IRRECOVERABLE_WARNING}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {lastBackup
                ? `Last backup: ${new Date(lastBackup.completedAt).toLocaleString()} — ${lastBackup.messageCount} messages across ${lastBackup.chatCount} chats.`
                : 'No backup has run on this device yet.'}
            </Text>
            {progressLabel ? (
              <Text variant="bodySmall" style={{ color: theme.colors.primary }}>
                {progressLabel}
              </Text>
            ) : null}
            <Button
              mode="contained"
              loading={backingUp}
              disabled={backingUp}
              onPress={handleBackupNow}
            >
              Back up now
            </Button>
            <Button mode="text" textColor={theme.colors.danger} onPress={handleForget}>
              Forget on this device
            </Button>
          </GlassCard>
        ) : (
          <>
            <GlassCard style={styles.card} contentStyle={styles.cardContent}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                Choose a backup passphrase
              </Text>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                Your chat history is encrypted with this passphrase before it leaves your device,
                so nobody else can read your iCloud backup.
              </Text>

              <TextInput
                mode="outlined"
                label="Passphrase"
                value={passphrase}
                onChangeText={setPassphrase}
                secureTextEntry={!reveal}
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="newPassword"
                right={
                  <TextInput.Icon
                    icon={reveal ? 'eye-off' : 'eye'}
                    onPress={() => setReveal((value) => !value)}
                  />
                }
              />

              {passphrase.length > 0 ? (
                <View style={styles.strengthRow}>
                  <Text variant="labelLarge" style={{ color: strengthColor }}>
                    {verdictLabel[assessment.verdict]}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    ~{assessment.entropyBits} bits
                  </Text>
                </View>
              ) : null}

              {passphrase.length > 0 && assessment.issues.length > 0 ? (
                <View>
                  {assessment.issues.map((issue) => (
                    <Text
                      key={issue}
                      variant="bodySmall"
                      style={{ color: theme.colors.onSurfaceVariant }}
                    >
                      • {issue}
                    </Text>
                  ))}
                </View>
              ) : null}

              <TextInput
                mode="outlined"
                label="Confirm passphrase"
                value={confirmation}
                onChangeText={setConfirmation}
                secureTextEntry={!reveal}
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="newPassword"
              />
              {confirmation.length > 0 && !matches ? (
                <Text variant="bodySmall" style={{ color: theme.colors.danger }}>
                  Passphrases don’t match.
                </Text>
              ) : null}
            </GlassCard>

            <GlassCard style={styles.card} contentStyle={styles.cardContent}>
              <Text variant="titleSmall" style={{ color: theme.colors.danger }}>
                {IRRECOVERABLE_WARNING}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                We never receive your passphrase, so we cannot reset it or recover your backup for
                you. Write it down and keep it somewhere safe before continuing.
              </Text>
              <View style={styles.checkboxRow}>
                <Checkbox
                  status={acknowledged ? 'checked' : 'unchecked'}
                  onPress={() => setAcknowledged((value) => !value)}
                />
                <Text
                  variant="bodyMedium"
                  style={[styles.checkboxLabel, { color: theme.colors.onSurface }]}
                  onPress={() => setAcknowledged((value) => !value)}
                >
                  I’ve written down my passphrase and understand it can’t be recovered.
                </Text>
              </View>
            </GlassCard>

            <Button
              mode="contained"
              disabled={!canSubmit}
              loading={saving}
              onPress={handleEnroll}
              style={styles.submit}
            >
              Set passphrase
            </Button>
          </>
        )}
      </ScrollView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 16,
    gap: 16,
  },
  card: {
    borderRadius: 20,
  },
  cardContent: {
    padding: 20,
    gap: 12,
  },
  strengthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  checkboxLabel: {
    flex: 1,
  },
  submit: {
    marginTop: 4,
  },
});
