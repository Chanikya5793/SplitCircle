// EditNameScreen — the name-edit screen doc 30 identified was missing entirely:
// RegisterScreen only collects a name once at email/password signup, and
// ProfilePhotoUploader only ever touches photoURL. This is the first screen
// that lets a signed-in user set/change their own displayName — the fix for
// the empty-name state Sign in with Apple's one-time name grant can leave
// behind (see ai_layer/docs/30_display_name_completeness.md).
//
// Submit sequence matches doc 30's locked contract exactly, and mirrors
// ProfilePhotoUploader.tsx's existing (correct) photoURL flow:
//   updateDoc(userRef, { displayName }) [Firestore, authoritative]
//   -> Firebase Auth updateProfile({ displayName })
//   -> propagateProfileToGroups(userId, { displayName }, groups) [denormalized copies]
// Firestore first means AuthContext's live `users/{uid}` onSnapshot listener
// self-heals `user.displayName` app-wide without this screen needing to poke
// AuthContext directly (which is deliberately out of scope here — see CLAUDE.md).

import { GlassCard } from '@/components/ui';
import { AppTextInput } from '@/components/ui/AppTextInput';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import { auth, db } from '@/firebase';
import { propagateProfileToGroups } from '@/services/profilePropagation';
import { appAlert } from '@/utils/appAlert';
import { formatDate } from '@/utils/format';
import { errorHaptic, successHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { updateProfile } from 'firebase/auth';
import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput as RNTextInput,
  View,
} from 'react-native';
import { Button, Text } from 'react-native-paper';

const errorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
};

// Cooldown between explicit name changes (product decision, 2026-07-24):
// deters disruptive back-and-forth renames in shared expense/chat history
// without gating the FIRST time a user ever sets/fixes their name (which is
// exactly the low-friction path doc 30 was built to protect — see
// `displayNameChangedAt`'s doc comment in models/user.ts, null until this
// screen's first successful save).
const COOLDOWN_DAYS = 30;
const COOLDOWN_MS = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

export const EditNameScreen = () => {
  const navigation = useNavigation();
  const { user } = useAuth();
  const { groups } = useGroups();
  const { theme } = useTheme();
  const [name, setName] = useState(user?.displayName ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<RNTextInput>(null);

  const changedAt = user?.displayNameChangedAt ?? null;
  const cooldownEndsAt = changedAt !== null ? changedAt + COOLDOWN_MS : null;
  const cooldownActive = cooldownEndsAt !== null && Date.now() < cooldownEndsAt;

  const trimmed = name.trim();
  const canSubmit =
    Boolean(trimmed) &&
    trimmed !== (user?.displayName ?? '').trim() &&
    !saving &&
    !cooldownActive &&
    Boolean(user);

  const handleSave = async () => {
    if (!canSubmit || !user) return;
    setError(null);
    setSaving(true);
    try {
      // 1. Firestore — authoritative copy every other screen reads from.
      const userRef = doc(db, 'users', user.userId);
      await updateDoc(userRef, {
        displayName: trimmed,
        displayNameChangedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      // 2. Firebase Auth — keeps the provider-facing profile in step (matches
      // buildUserProfile's existing-wins precedence: existing?.displayName
      // always wins over this on the next read, so ordering here is safe).
      if (auth.currentUser) {
        try {
          await updateProfile(auth.currentUser, { displayName: trimmed });
        } catch (authError) {
          // Non-fatal: Firestore already has the real name, which is what
          // every surface in the app actually reads. Still log it — a silent
          // catch here is exactly the failure mode doc 30 was written about.
          console.error('Failed to update Firebase Auth displayName:', authError);
        }
      }

      // 3. Denormalized copies in every group this user belongs to — its
      // second-ever caller (first is ProfilePhotoUploader.tsx, for photoURL).
      // Best-effort by design (see profilePropagation.ts); doesn't block the
      // save from completing.
      void propagateProfileToGroups(user.userId, { displayName: trimmed }, groups);

      successHaptic();
      if (navigation.canGoBack()) {
        navigation.goBack();
      }
    } catch (err) {
      errorHaptic();
      setError(errorMessage(err, 'Could not save your name. Please try again.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <LiquidBackground>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <GlassCard style={styles.card} contentStyle={styles.cardContent}>
            <View>
              <Text variant="headlineSmall" style={[styles.title, { color: theme.colors.onSurface }]}>
                Your name
              </Text>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                This is what friends and groups see on shared expenses, chats, and calls.
              </Text>
            </View>
            <AppTextInput
              ref={inputRef}
              label="Name"
              value={name}
              onChangeText={(next) => {
                setName(next);
                if (error) setError(null);
              }}
              editable={!cooldownActive}
              autoFocus={!cooldownActive}
              autoComplete="name"
              textContentType="name"
              returnKeyType="done"
              onSubmitEditing={handleSave}
              containerStyle={styles.field}
            />
            {cooldownActive && cooldownEndsAt ? (
              <Text style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
                You can change your name again on {formatDate(cooldownEndsAt)}.
              </Text>
            ) : null}
            {error ? (
              <Text style={{ color: theme.colors.danger, textAlign: 'center' }}>{error}</Text>
            ) : null}
            <Button mode="contained" onPress={handleSave} loading={saving} disabled={!canSubmit}>
              Save
            </Button>
          </GlassCard>
        </ScrollView>
      </KeyboardAvoidingView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    borderRadius: 20,
  },
  cardContent: {
    padding: 24,
    gap: 14,
  },
  title: {
    fontWeight: '700',
    marginBottom: 4,
  },
  field: {
    marginTop: 4,
  },
});

export default EditNameScreen;
