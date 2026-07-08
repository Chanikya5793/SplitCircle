// Privacy-guard render shields.
//
// <Shield target="expenses">…</Shield> wraps a block: renders children
// normally until the guard trips, then either redacts the block (scramble)
// or removes it entirely (vanish). <GuardedScreen> is the whole-SCREEN
// version for drill-downs that are entirely sensitive (expense details,
// on-device index, chat rooms) — it swaps the whole screen for a lock panel
// so no field can leak. <LockedOverlay/> is the whole-APP lockdown mounted
// once in App.tsx.

import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { useTheme } from '@/context/ThemeContext';
import { appPrompt } from '@/utils/appAlert';
import { APP_NAME } from '@/constants/appInfo';
import type { GuardTargets } from '@/services/privacyGuardService';
import { errorHaptic, successHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useRef } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type GuardTarget = Exclude<keyof GuardTargets, 'everything'>;

interface ShieldProps {
  target: GuardTarget;
  entityId?: string;
  children: React.ReactNode;
  /** Rendered instead of the redaction card when scrambling (optional). */
  scrambleFallback?: React.ReactNode;
}

export const Shield = ({ target, entityId, children, scrambleFallback }: ShieldProps) => {
  const { isShielded, action } = usePrivacyGuard();
  const { isDark, theme } = useTheme();

  if (!isShielded(target, entityId)) return <>{children}</>;
  if (action === 'vanish') return null;

  if (scrambleFallback) return <>{scrambleFallback}</>;
  return (
    <View
      style={[
        styles.redacted,
        { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' },
      ]}
      accessibilityLabel="Hidden content"
    >
      <Ionicons name="eye-off-outline" size={18} color={theme.colors.onSurfaceVariant} />
      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
        Hidden
      </Text>
    </View>
  );
};

interface GuardedScreenProps {
  target: GuardTarget;
  entityId?: string;
  children: React.ReactNode;
  /** Short label on the lock panel, e.g. "Expense hidden". */
  label?: string;
}

/**
 * Whole-screen guard for drill-downs that are entirely sensitive. When the
 * target is shielded, the ENTIRE screen becomes a neutral lock panel — no
 * amount, name, message, or chart can slip through. Reveal via shake-again
 * or the Settings unlock; nothing here gives the feature away.
 */
export const GuardedScreen = ({ target, entityId, children, label = 'Hidden' }: GuardedScreenProps) => {
  const { isShielded } = usePrivacyGuard();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();

  if (!isShielded(target, entityId)) return <>{children}</>;

  return (
    <View style={[styles.lockPanel, { backgroundColor: theme.colors.appBackground, paddingTop: insets.top }]}>
      <Ionicons name="lock-closed-outline" size={40} color={theme.colors.onSurfaceVariant} />
      <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 12, fontWeight: '600' }}>
        {label}
      </Text>
      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
        Shake again or enter your code to reveal.
      </Text>
    </View>
  );
};

/** Prompt for the secret code and unlock on success. */
export const promptGuardUnlock = (unlock: (code: string) => Promise<boolean>) => {
  appPrompt(
    'Enter code',
    undefined,
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unlock',
        onPress: (code?: string) => {
          void unlock(code ?? '').then((ok) => {
            if (ok) successHaptic();
            else errorHaptic();
          });
        },
      },
    ],
    'secure-text',
  );
};

/** Whole-app lockdown. Mount once, above the navigator. */
export const LockedOverlay = () => {
  const { fullLock, unlock } = usePrivacyGuard();
  const tapsRef = useRef<number[]>([]);

  if (!fullLock) return null;

  const handleWordmarkTap = () => {
    const now = Date.now();
    tapsRef.current = [...tapsRef.current.filter((t) => now - t < 1200), now];
    if (tapsRef.current.length >= 3) {
      tapsRef.current = [];
      promptGuardUnlock(unlock);
    }
  };

  return (
    <View style={styles.lockOverlay} pointerEvents="auto">
      <TouchableOpacity activeOpacity={1} onPress={handleWordmarkTap} hitSlop={40}>
        <Text style={styles.lockWordmark}>{APP_NAME}</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  lockPanel: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  redacted: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 14,
    paddingVertical: 22,
    marginVertical: 6,
  },
  lockOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 5000,
    elevation: 5000,
    backgroundColor: '#0d0f14',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockWordmark: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: 1,
  },
});
