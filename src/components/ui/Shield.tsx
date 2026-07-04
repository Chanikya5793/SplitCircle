// Privacy-guard render shields.
//
// <Shield target="expenses">…</Shield> wraps a block: renders children
// normally until the guard trips, then either redacts the block (scramble)
// or removes it entirely (vanish). <LockedOverlay/> is the whole-app
// lockdown mounted once in App.tsx — a neutral screen that gives nothing
// away; triple-tapping the wordmark prompts for the secret code.

import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { useTheme } from '@/context/ThemeContext';
import { APP_NAME } from '@/constants/appInfo';
import type { GuardTargets } from '@/services/privacyGuardService';
import { errorHaptic, successHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useRef } from 'react';
import { Alert, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Text } from 'react-native-paper';

interface ShieldProps {
  target: Exclude<keyof GuardTargets, 'everything'>;
  children: React.ReactNode;
  /** Rendered instead of the redaction card when scrambling (optional). */
  scrambleFallback?: React.ReactNode;
}

export const Shield = ({ target, children, scrambleFallback }: ShieldProps) => {
  const { isShielded, action } = usePrivacyGuard();
  const { isDark, theme } = useTheme();

  if (!isShielded(target)) return <>{children}</>;
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

/** Prompt for the secret code and unlock on success. */
export const promptGuardUnlock = (unlock: (code: string) => Promise<boolean>) => {
  Alert.prompt(
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
