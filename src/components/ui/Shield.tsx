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
import { APP_NAME } from '@/constants/appInfo';
import { updateGuard, type GuardTargets } from '@/services/privacyGuardService';
import { authenticate, isBiometricAvailable } from '@/services/biometrics';
import { successHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GuardCodePad } from './GuardCodePad';

type GuardTarget = Exclude<keyof GuardTargets, 'everything'>;

interface ShieldProps {
  target: GuardTarget;
  entityId?: string;
  children: React.ReactNode;
  /** Rendered instead of the redaction card when scrambling (optional). */
  scrambleFallback?: React.ReactNode;
  /**
   * Rendered in the DURESS decoy world instead of the redaction card — a
   * "Hidden" chip would betray the fake unlock. Pass something that reads as
   * a normal empty state; omitted = the block simply vanishes.
   */
  duressFallback?: React.ReactNode;
}

export const Shield = ({ target, entityId, children, scrambleFallback, duressFallback }: ShieldProps) => {
  const { isShielded, isLockedDown, action } = usePrivacyGuard();
  const { isDark, theme } = useTheme();

  if (!isShielded(target, entityId)) return <>{children}</>;
  if (!isLockedDown(target, entityId)) return <>{duressFallback ?? null}</>;
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
  /**
   * What to do in the DURESS decoy world (lock panels never show there):
   * - 'render' (default): render children — right for per-entity drill-downs
   *   whose fields all flow through the masking hooks (fake names, scaled
   *   ledger), so they read as a real but boring screen.
   * - 'blank': render a neutral empty state — REQUIRED for screens that show
   *   raw or aggregate data the hooks can't disguise (AI index/chat, personal
   *   stats, message info). Never let those render real content in duress.
   */
  duressBehavior?: 'render' | 'blank';
  /** Copy for the neutral duress empty state (with duressBehavior 'blank'). */
  duressLabel?: string;
}

/**
 * Whole-screen guard for drill-downs that are entirely sensitive. When the
 * target is locked down, the ENTIRE screen becomes a neutral lock panel — no
 * amount, name, message, or chart can slip through. Reveal via shake-again
 * or the Settings unlock; nothing here gives the feature away. In duress the
 * lock panel is suppressed (it would betray the fake unlock) — content either
 * renders masked or collapses to a plausible empty state per `duressBehavior`.
 */
export const GuardedScreen = ({
  target,
  entityId,
  children,
  label = 'Hidden',
  duressBehavior = 'render',
  duressLabel = 'Nothing here yet',
}: GuardedScreenProps) => {
  const { isShielded, isLockedDown } = usePrivacyGuard();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();

  if (!isShielded(target, entityId)) return <>{children}</>;

  if (!isLockedDown(target, entityId)) {
    if (duressBehavior === 'render') return <>{children}</>;
    // Plausible empty state — deliberately free of lock iconography.
    return (
      <View style={[styles.lockPanel, { backgroundColor: theme.colors.appBackground, paddingTop: insets.top }]}>
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
          {duressLabel}
        </Text>
      </View>
    );
  }

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

/**
 * Soft veil that pulses over the app whenever the shields flip (trip OR
 * reveal), so content doesn't visibly pop between real and disguised — the
 * change happens "behind" a quick fade. Mounted once next to LockedOverlay;
 * skipped for everything-mode (LockedOverlay owns that transition).
 */
export const GuardTransitionVeil = () => {
  const { active, fullLock } = usePrivacyGuard();
  const { theme } = useTheme();
  const veil = useRef(new Animated.Value(0)).current;
  const [covering, setCovering] = useState(false);
  const prevActive = useRef(active);

  useEffect(() => {
    if (prevActive.current === active) return;
    prevActive.current = active;
    if (fullLock) return; // blank overlay handles it
    setCovering(true);
    veil.setValue(0);
    Animated.sequence([
      Animated.timing(veil, { toValue: 1, duration: 140, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(veil, { toValue: 0, duration: 320, easing: Easing.in(Easing.quad), useNativeDriver: true }),
    ]).start(() => setCovering(false));
  }, [active, fullLock, veil]);

  if (!covering) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.veil, { opacity: veil, backgroundColor: theme.colors.appBackground }]}
    />
  );
};

/** Whole-app lockdown. Mount once, above the navigator. */
export const LockedOverlay = () => {
  const { fullLock, unlock, settings } = usePrivacyGuard();
  const tapsRef = useRef<number[]>([]);
  const [padVisible, setPadVisible] = useState(false);
  const fade = useRef(new Animated.Value(0)).current;

  // The blank screen settles in with a soft fade instead of snapping — the
  // trip reads as deliberate, and the wordmark drifts up into place.
  useEffect(() => {
    if (fullLock) {
      fade.setValue(0);
      Animated.timing(fade, {
        toValue: 1,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    } else {
      setPadVisible(false);
    }
  }, [fullLock, fade]);

  if (!fullLock) return null;

  const handleWordmarkTap = () => {
    const now = Date.now();
    tapsRef.current = [...tapsRef.current.filter((t) => now - t < 1200), now];
    if (tapsRef.current.length < 3) return;
    tapsRef.current = [];
    void (async () => {
      // Biometric shortcut first when the user opted in; code is the fallback.
      if (settings.biometricUnlock && (await isBiometricAvailable())) {
        const ok = await authenticate('Unlock');
        if (ok) {
          successHaptic();
          await updateGuard({ active: false, duressActive: false });
          return;
        }
      }
      setPadVisible(true);
    })();
  };

  const wordmarkRise = fade.interpolate({ inputRange: [0, 1], outputRange: [14, 0] });

  return (
    <Animated.View style={[styles.lockOverlay, { opacity: fade }]} pointerEvents="auto">
      <TouchableOpacity activeOpacity={1} onPress={handleWordmarkTap} hitSlop={40}>
        <Animated.Text style={[styles.lockWordmark, { transform: [{ translateY: wordmarkRise }] }]}>
          {APP_NAME}
        </Animated.Text>
      </TouchableOpacity>
      <GuardCodePad
        visible={padVisible}
        title="Enter code"
        mode="unlock"
        onClose={() => setPadVisible(false)}
        onSubmit={async (code) => {
          const { ok, lockedForMs } = await unlock(code);
          if (ok) return { status: 'ok' };
          if (lockedForMs > 0) return { status: 'locked', lockedForMs };
          return { status: 'wrong' };
        }}
      />
    </Animated.View>
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
  veil: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 4500,
    elevation: 4500,
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
